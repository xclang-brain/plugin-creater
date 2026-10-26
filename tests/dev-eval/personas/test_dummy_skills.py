"""改善の模擬ユーザー edl-change が示す、ダミーのスキル（ユーザーの既存のスキル。cross-compile と deploy）の試験。

ダミーのスキルは、架空のボード KX-200 のチームのスキルで、クリエイターとは無関係に書かれたものとして作る。
クリエイターがそれを読み、確かめてから取り込めるか（REQ-055）を試すためである。ここでは、スキルそのものが
Agent Skills の決まりに合い、スキルのフォルダだけで仕事を終えられる（REQ-062 と同じ形）ことを確かめる。

動かし方：python3 -m pytest -q tests/dev-eval/personas/test_dummy_skills.py（unittest でも動く）
ARM のビルドの試験は arm-linux-gnueabihf-gcc が要る（なければ飛ばす）。
"""

import ast
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
SKILLS = os.path.join(HERE, "edl-change", "files", "kx200-firmware", ".github", "skills")
CHECK_STRUCTURE = os.path.join(REPO, "template", "tests", "stage1", "check_structure.py")
KXEMU = os.path.join(REPO, "tests", "dev-eval", "device", "kxemu.py")
SENSOR_C = os.path.join(REPO, "tests", "dev-eval", "device", "sample", "sensor.c")
KX_BUILD = os.path.join(SKILLS, "cross-compile", "scripts", "kx-build.sh")
MKKXIMG = os.path.join(SKILLS, "deploy", "scripts", "mkkximg.py")
SKILL_NAMES = ("cross-compile", "deploy")
HAS_ARM_GCC = shutil.which("arm-linux-gnueabihf-gcc") is not None

# クリエイターや題材のプラグインを知っていると分かる言葉（ダミーのスキルには書かない）
UNRELATED = re.compile(r"plugin|プラグイン|agent|エージェント|embedded-debug-loop|K-\d{2}|統括|orchestrator|worker", re.I)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


cs = load("dummy_skills_check_structure", CHECK_STRUCTURE)
kxemu = load("dummy_skills_kxemu", KXEMU)


def skill_files(name):
    base = os.path.join(SKILLS, name)
    out = []
    for directory, _dirs, files in os.walk(base):
        out += [os.path.join(directory, f) for f in sorted(files)]
    return sorted(out)


def run(args, env=None, cwd=None):
    return subprocess.run(args, capture_output=True, text=True, env=env, cwd=cwd, timeout=120)


class SkillShapeTest(unittest.TestCase):
    """スキルの形（Agent Skills の決まりと、スキルのフォルダの中で完結すること）。"""

    def test_REQ_055_two_dummy_skills_exist_with_short_common_names(self):
        self.assertEqual(sorted(os.listdir(SKILLS)), sorted(SKILL_NAMES))

    def test_REQ_055_skill_files_pass_the_template_skill_check(self):
        for name in SKILL_NAMES:
            c = cs.Check("skills", "スキル")
            cs.check_skill_file(os.path.join(SKILLS, name, "SKILL.md"), name, c)
            self.assertEqual(c.errors, [], name)
            self.assertEqual(c.warnings, [], name)

    def test_REQ_062_files_referenced_by_skill_are_inside_the_skill_folder(self):
        ctx = types.SimpleNamespace(root=SKILLS, plugin_name=None)
        for name in SKILL_NAMES:
            skill_dir = os.path.join(SKILLS, name)
            for path in cs.skill_markdown(skill_dir):
                with open(path, encoding="utf-8") as f:
                    text = f.read()
                prose, code = cs.split_code(text)
                self.assertEqual(cs.link_problems(ctx, skill_dir, path, prose, code), [], path)
                self.assertEqual(cs.forbidden_problems(ctx, name, path, text), [], path)
            with open(os.path.join(skill_dir, "SKILL.md"), encoding="utf-8") as f:
                body = f.read()
            for rel in re.findall(r"scripts/[A-Za-z0-9._-]+", body):
                self.assertTrue(os.path.isfile(os.path.join(skill_dir, rel)), "%s: %s がない" % (name, rel))

    def test_REQ_062_commands_run_scripts_with_the_skill_folder_path(self):
        # スクリプトを動かすコマンドは、どれもスキルのフォルダの絶対パス（<このフォルダ>）を前に付ける（今いるフォルダからの相対にしない）
        for name in SKILL_NAMES:
            with open(os.path.join(SKILLS, name, "SKILL.md"), encoding="utf-8") as f:
                body = f.read()
            commands = re.findall(r"(?:bash|python3)\s+\S*scripts/[A-Za-z0-9._-]+", body)
            self.assertTrue(commands, name)
            for command in commands:
                self.assertRegex(command, r"^(?:bash|python3)\s+<このフォルダ>/scripts/", "%s: %s" % (name, command))

    def test_REQ_055_dummy_skills_know_nothing_about_the_creator(self):
        for name in SKILL_NAMES:
            for path in skill_files(name):
                with open(path, encoding="utf-8") as f:
                    text = f.read()
                found = UNRELATED.findall(text)
                self.assertEqual(found, [], "%s に %s がある" % (os.path.relpath(path, SKILLS), found))

    def test_REQ_062_python_script_uses_only_the_standard_library(self):
        with open(MKKXIMG, encoding="utf-8") as f:
            tree = ast.parse(f.read())
        names = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names |= {a.name.split(".")[0] for a in node.names}
            elif isinstance(node, ast.ImportFrom):
                names.add((node.module or "").split(".")[0])
        self.assertEqual(sorted(n for n in names if n not in sys.stdlib_module_names), [])


class MkkximgTest(unittest.TestCase):
    """deploy の scripts/mkkximg.py（引数・標準出力の JSON・終了コード）。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="mkkximg-")
        self.elf = os.path.join(self.tmp, "app.elf")
        with open(self.elf, "wb") as f:
            f.write(b"\x7fELF" + bytes(range(256)) * 4)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_REQ_062_help_shows_usage_and_exit_codes(self):
        r = run([sys.executable, MKKXIMG, "--help"])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("ELF NAME OUT", r.stdout)
        self.assertIn("終了コード", r.stdout)

    def test_REQ_062_wrong_arguments_exit_2(self):
        out = os.path.join(self.tmp, "x.kximg")
        for args in ([], [self.elf, "sensor"], [self.elf, "Sensor", out], [self.elf, "a" * 16, out]):
            r = run([sys.executable, MKKXIMG] + args)
            self.assertEqual(r.returncode, 2, args)
            self.assertEqual(r.stdout, "", args)
        self.assertFalse(os.path.exists(out))

    def test_REQ_062_not_an_elf_exits_3(self):
        text = os.path.join(self.tmp, "note.txt")
        with open(text, "w") as f:
            f.write("not an elf")
        out = os.path.join(self.tmp, "x.kximg")
        for src in (text, os.path.join(self.tmp, "missing.elf")):
            r = run([sys.executable, MKKXIMG, src, "sensor", out])
            self.assertEqual(r.returncode, 3, r.stderr)
            self.assertTrue(r.stderr.startswith("mkkximg: "))
        self.assertFalse(os.path.exists(out))

    def test_REQ_062_cannot_write_exits_4(self):
        r = run([sys.executable, MKKXIMG, self.elf, "sensor", os.path.join(self.tmp, "no", "such", "x.kximg")])
        self.assertEqual(r.returncode, 4, r.stderr)

    def test_REQ_055_image_header_is_accepted_by_the_device(self):
        out = os.path.join(self.tmp, "sensor.kximg")
        r = run([sys.executable, MKKXIMG, self.elf, "sensor", out])
        self.assertEqual(r.returncode, 0, r.stderr)
        result = json.loads(r.stdout)
        with open(self.elf, "rb") as f:
            payload = f.read()
        self.assertEqual(result, {"image": out, "name": "sensor", "size": len(payload),
                                  "crc32": "0x%08x" % (zlib.crc32(payload) & 0xFFFFFFFF)})
        with open(out, "rb") as f:
            image = f.read()
        parsed, reason = kxemu.parse_image(image)
        self.assertIsNone(reason)
        self.assertEqual(parsed, ("sensor", payload))
        # 見出しを付けない ELF は、機器が断る（デプロイのスキルの「気をつけること」）
        self.assertEqual(kxemu.parse_image(payload), (None, "bad magic (not a KX2I image)"))


class KxBuildTest(unittest.TestCase):
    """cross-compile の scripts/kx-build.sh（引数・標準出力の JSON・終了コード）。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="kx-build-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_REQ_062_help_shows_usage_and_exit_codes(self):
        r = run(["bash", KX_BUILD, "--help"])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("--src DIR --name NAME --out DIR [--debug]", r.stdout)
        self.assertIn("終了コード", r.stdout)

    def test_REQ_062_wrong_arguments_exit_2(self):
        src = os.path.dirname(SENSOR_C)
        out = os.path.join(self.tmp, "out")
        for args in ([], ["--src", src, "--name", "sensor"], ["--src", src, "--name", "Bad_Name", "--out", out],
                     ["--src", src, "--name", "sensor", "--out", out, "--fast"], ["--src", os.path.join(self.tmp, "none"), "--name", "sensor", "--out", out]):
            r = run(["bash", KX_BUILD] + args)
            self.assertEqual(r.returncode, 2, (args, r.stderr))
            self.assertEqual(r.stdout, "", args)

    def test_REQ_062_missing_toolchain_exits_3(self):
        empty = os.path.join(self.tmp, "empty-path")
        os.mkdir(empty)
        env = dict(os.environ, PATH=empty)
        r = run([shutil.which("bash"), KX_BUILD, "--src", os.path.dirname(SENSOR_C), "--name", "sensor", "--out", self.tmp], env=env)
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertIn("arm-linux-gnueabihf-gcc", r.stderr)

    @unittest.skipUnless(HAS_ARM_GCC, "arm-linux-gnueabihf-gcc がない（apt-get install -y gcc-arm-linux-gnueabihf libc6-dev-armhf-cross）")
    def test_REQ_055_builds_a_static_arm_elf_and_prints_json(self):
        out = os.path.join(self.tmp, "build")
        r = run(["bash", KX_BUILD, "--src", os.path.dirname(SENSOR_C), "--name", "sensor", "--out", out])
        self.assertEqual(r.returncode, 0, r.stderr)
        result = json.loads(r.stdout)
        self.assertEqual(result, {"elf": os.path.join(out, "sensor.elf"), "debug": False, "log": os.path.join(out, "sensor.build.log")})
        with open(result["elf"], "rb") as f:
            self.assertEqual(kxemu.elf_kind(f.read()), "arm-static")
        r = run(["bash", KX_BUILD, "--src", os.path.dirname(SENSOR_C), "--name", "sensor", "--out", out, "--debug"])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIs(json.loads(r.stdout)["debug"], True)

    @unittest.skipUnless(HAS_ARM_GCC, "arm-linux-gnueabihf-gcc がない")
    def test_REQ_062_compile_error_exits_4_and_shows_the_first_error(self):
        src = os.path.join(self.tmp, "src")
        os.mkdir(src)
        with open(os.path.join(src, "broken.c"), "w") as f:
            f.write("int main(void) { return undefined_name; }\n")
        r = run(["bash", KX_BUILD, "--src", src, "--name", "broken", "--out", os.path.join(self.tmp, "out")])
        self.assertEqual(r.returncode, 4, r.stderr)
        self.assertEqual(r.stdout, "")
        self.assertIn("error:", r.stderr)
        self.assertTrue(os.path.isfile(os.path.join(self.tmp, "out", "broken.build.log")))


if __name__ == "__main__":
    unittest.main()
