"""今あるプラグインを直すとき（change-plugin）の、組み立てのスクリプト（skills/make-plugin/scripts/scaffold.py）の試験。

子コマンド change-check・extract・change・change-guard・commit と、check-base の試験の土台（BLUEPRINT D20）を確かめる。
試験の名前に、確かめる要件の番号を入れる。

  - 直すプラグインは、見本（sample/）を小さなひな形（fixture-template/）で組み立てて作る（git のリポジトリになる）。
  - 本物のひな形（template/）では、見本を組み立てて直したものが、1段目の構造の検査に通ることを見る。
  - 本物の題材（tests/dev-eval/fixtures/market.tar.gz。embedded-debug-loop）での試験は、題材があるときだけ動かす。

動かし方（リポジトリの根で）:
    python3 -m unittest discover -s tests/creator/scaffold -p "test_*.py"
"""
import contextlib
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
SCRIPT = os.path.join(REPO, "skills", "make-plugin", "scripts", "scaffold.py")
REAL_TEMPLATE = os.path.join(REPO, "template")
SAMPLE = os.path.join(HERE, "sample")
FIXTURE = os.path.join(HERE, "fixture-template")
SCHEMA_REL = ("com.github.copilot", "extensions", "_plugin_", "core", "task.schema.json")
MARKET = os.path.join(REPO, "tests", "dev-eval", "fixtures", "market.tar.gz")
TODAY = "2026-10-26"
GIT_ID = ["-c", "user.name=tester", "-c", "user.email=tester@example.com", "-c", "commit.gpgsign=false"]
T01_PROMPT = "先週の記録をもとに、今週の週報を書いてください。"
NEW_PROMPT = "数字の書き方に気をつけて、今週の週報を書いてください。"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


scaffold = load_module("plugin_creator_scaffold_change", SCRIPT)


def have_checks():
    try:
        import jsonschema  # noqa: F401
        import yaml  # noqa: F401
        return True
    except ImportError:
        return False


def git(cwd, *args, check=True):
    done = subprocess.run(["git"] + GIT_ID + list(args), cwd=cwd, capture_output=True, text=True, encoding="utf-8")
    if check and done.returncode != 0:
        raise AssertionError("git %s: %s" % (" ".join(args), done.stderr))
    return done.stdout


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def dump(path, data):
    write(path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def row(ident, kind, item_name, text, **extra):
    """ヒアリングの記録のナレッジの行（BLUEPRINT 4.1）。"""
    data = {"id": ident, "kind": kind, "item": "rules", "itemName": item_name, "text": text, "source": "answer",
            "quote": text, "example": None, "exception": None, "status": "decided", "itemTouchedAtRecord": False}
    data.update(extra)
    return data


def criteria_rows(rows, criteria_ids):
    """エクステンションの criteriaRows（BLUEPRINT 4.4）と同じ付け方：引き継いだ基準は元の番号、新しい基準は元の最大の続き。"""
    last = max([int(v.split("-")[1]) for v in criteria_ids.values()], default=0)
    out = []
    for r in sorted((r for r in rows if r["kind"] == "criterion" and r["status"] == "decided"), key=lambda r: int(r["id"][2:])):
        if r["id"] in criteria_ids:
            out.append({"id": criteria_ids[r["id"]], "knowledge": r["id"]})
        else:
            last += 1
            out.append({"id": "C-%02d" % last, "knowledge": r["id"]})
    return out


class Base(unittest.TestCase):
    """作業フォルダ（Copilot CLI を起動したフォルダ）の中に、見本で組み立てた生成プラグイン（git のリポジトリ）を用意する。"""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="c2-change-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        env = mock.patch.dict(os.environ, {"COPILOT_HOME": os.path.join(self.root, "copilot-home"),
                                           "COPILOT_CACHE_HOME": os.path.join(self.root, "cache")})
        env.start()
        self.addCleanup(env.stop)
        self.template = self.make_template()
        self.folder = os.path.join(self.root, "folder")
        os.makedirs(self.folder)
        self.work = os.path.join(self.folder, scaffold.WORK_NAME)
        self.hearing = os.path.join(self.root, "copilot-home", "plugin-data", "plugin-creator", "hearings", "s1", "state.json")
        self.plugin = self.make_plugin()

    def make_template(self):
        dest = os.path.join(self.root, "template")
        shutil.copytree(FIXTURE, dest)
        shutil.copy(os.path.join(REAL_TEMPLATE, *SCHEMA_REL), os.path.join(dest, *SCHEMA_REL))
        return dest

    def build_plugin(self, out, template=None, edit=None):
        """見本で生成プラグインを組み立てる（git のリポジトリになる）。edit(parts のフォルダ, 記録) で見本を直せる。"""
        work = os.path.join(os.path.dirname(out), scaffold.WORK_NAME)
        shutil.copytree(os.path.join(SAMPLE, "parts"), os.path.join(work, "parts"))
        state = os.path.join(self.root, "build-state.json")
        shutil.copy(os.path.join(SAMPLE, "state.json"), state)
        if edit:
            edit(os.path.join(work, "parts"), state)
        scaffold.build(state, work, out, template=template or self.template, today=TODAY)
        return out

    def make_plugin(self):
        return self.build_plugin(os.path.join(self.folder, "weekly-report"))

    # ---- 道具
    def at(self, rel):
        return os.path.join(self.plugin, *rel.split("/"))

    def part(self, rel):
        return os.path.join(self.work, "parts", *rel.split("/"))

    def repo(self):
        return git(self.plugin, "rev-parse", "--show-toplevel").strip()

    def commit_all(self, message="手で直した"):
        git(self.plugin, "add", "-A", "--", ".")
        if git(self.plugin, "status", "--porcelain", "--", "."):
            git(self.plugin, "commit", "-q", "-m", message, "--", ".")

    def add_submodule(self):
        """プラグインのフォルダに、git のサブモジュール vendor/lib を足してコミットする。"""
        lib = os.path.join(self.root, "lib-repo")
        os.makedirs(lib)
        git(lib, "init", "-q")
        write(os.path.join(lib, "f.txt"), "x")
        git(lib, "add", "-A")
        git(lib, "commit", "-q", "-m", "lib")
        git(self.plugin, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "vendor/lib")
        git(self.plugin, "commit", "-q", "-m", "サブモジュールを足した")

    def snapshot(self):
        """フォルダの中身（.git を除くファイルの中身と実行の印）と、git の状態。"""
        files = {}
        for directory, dirs, names in os.walk(self.plugin):
            dirs[:] = [d for d in dirs if d != ".git"]
            for n in names:
                path = os.path.join(directory, n)
                with open(path, "rb") as f:
                    files[os.path.relpath(path, self.plugin)] = (f.read(), os.stat(path).st_mode)
        return files, git(self.plugin, "rev-parse", "HEAD"), git(self.repo(), "status", "--porcelain", "--untracked-files=all")

    def assertMentions(self, problems, *words):
        text = "\n".join(problems)
        for word in words:
            self.assertIn(word, text)

    # ---- 子コマンド
    def check(self, cwd=None, hearing=None):
        return scaffold.change_check(self.plugin, cwd or self.folder, hearing, template=self.template)

    def refused_check(self, *words, **kw):
        before = self.snapshot()
        with self.assertRaises(scaffold.Refusal) as caught:
            self.check(**kw)
        self.assertEqual(self.snapshot(), before, "断ったのに、フォルダの中身が変わった")
        self.assertMentions(caught.exception.problems, *words)
        return caught.exception.problems

    def extract(self, **kw):
        return scaffold.extract(self.plugin, self.work, template=self.template, today=TODAY, **kw)

    def change(self):
        return scaffold.change(self.hearing, self.work, self.plugin, template=self.template, today=TODAY)

    def refused_change(self, *words):
        before = self.snapshot()
        with self.assertRaises(scaffold.Refusal) as caught:
            self.change()
        self.assertEqual(self.snapshot(), before, "断ったのに、プラグインのフォルダが変わった")
        self.assertMentions(caught.exception.problems, *words)
        return caught.exception.problems

    # ---- ヒアリングの記録（エクステンションが書くものと同じ形。BLUEPRINT 4.1）
    def carried_rows(self):
        return [row(r["id"], r["kind"], r["item"], r["text"], source="existing_plugin", carried=True,
                    quote="tests/knowledge.json の %s" % r["id"])
                for r in load(self.at("tests/knowledge.json"))]

    def plugin_task(self):
        name = load(self.at("plugin.json"))["name"]
        return load(self.at("com.github.copilot/extensions/%s/task.json" % name))

    def carried_tasks(self):
        """元の EVAL の課題を、確認で示す形にする（入力はプラグインの中の場所。provisional）。"""
        by_id = {c["id"]: c["knowledge"] for c in self.plugin_task()["criteria"]}
        tasks = []
        base = self.at("tests/eval")
        for folder in sorted(os.listdir(base)):
            data = load(os.path.join(base, folder, "eval.json"))
            tasks.append({"prompt": data["prompt"],
                          "inputs": [{"path": "tests/eval/%s/%s" % (folder, i), "provisional": True} for i in data.get("inputs", [])],
                          "criteria": [by_id[c["id"]] for c in data["criteria"]],
                          "settings": data.get("settings", {})})
        return tasks

    def make_state(self, rows=None, tasks=None, version="0.2.0", criteria=None, assets=None):
        manifest = load(self.at("plugin.json"))
        removed = load(self.at("tests/knowledge-removed.json")) if os.path.isfile(self.at("tests/knowledge-removed.json")) else []
        original = load(self.at("tests/knowledge.json"))
        criteria_ids = {c["knowledge"]: c["id"] for c in self.plugin_task()["criteria"]}
        rows = self.carried_rows() if rows is None else rows
        ids = [int(r["id"][2:]) for r in original + removed]
        return {
            "schemaVersion": 1, "sessionId": "s1", "stage": "generate", "rebuild": False, "items": {},
            "knowledge": rows, "knowledgeCounter": max(ids + [int(r["id"][2:]) for r in rows]),
            "assets": assets or [], "ossChoices": [],
            "change": {"folder": os.path.realpath(self.plugin), "manifest": "plugin.json", "name": manifest["name"],
                       "version": manifest.get("version"), "generated": True, "carried": [r["id"] for r in original],
                       "removed": [r["id"] for r in removed], "maxId": max(ids), "criteriaIds": criteria_ids,
                       "evalPrompts": [t["prompt"] for t in self.carried_tasks()], "wants": ["数字の書き方を直したい"],
                       "startedAt": "2026-10-26T01:00:00.000Z"},
            "confirmation": {"at": "2026-10-26T02:00:00.000Z", "knowledgeIds": [r["id"] for r in rows if r["status"] == "decided"],
                             "behavior": "週報を書く", "taskPath": ".plugin-creator-work/draft/task.json",
                             "evalTasks": self.carried_tasks() if tasks is None else tasks,
                             "criteria": criteria_rows(rows, criteria_ids) if criteria is None else criteria,
                             "version": version, "rebuild": {"keep": "今の週報の書き方", "change": ["版を上げる"]}},
            "approvedAt": "2026-10-26T02:05:00.000Z",
        }

    def save(self, state):
        dump(self.hearing, state)

    def edit_eval(self, rel, change):
        path = self.part("files/" + rel)
        data = load(path)
        change(data)
        dump(path, data)

    def full_change(self):
        """K-07 を足し、K-03 を K-08 に直し（中身を直した決まりは新しい番号）、課題を1つ足す。"""
        rows = [r for r in self.carried_rows() if r["id"] != "K-03"]
        rows.append(row("K-07", "other", "決まった書き方やルール", "見出しの後に1行あける。"))
        rows.append(row("K-08", "criterion", "決まった書き方やルール", "数字は半角で書き、単位を付ける（例：3件）。", replaces="K-03"))
        self.extract()
        # 作業エージェントの代わり：外した基準 C-02 を指す引き継いだ課題を、新しい決まりで書き直し、課題を1つ足す
        self.edit_eval("tests/eval/T-01/eval.json", lambda d: d["criteria"].__setitem__(1, {"knowledge": "K-08", "grading": "model"}))
        dump(self.part("files/tests/eval/T-02/eval.json"),
             {"id": "T-02", "prompt": NEW_PROMPT, "inputs": [], "settings": {"maxIterations": 2, "task": {"week": "2026-W43"}},
              "criteria": [{"knowledge": "K-08", "grading": "model"}]})
        with open(self.part("slots/worker-task.worker.md"), "a", encoding="utf-8") as f:
            f.write("- 見出しの後に1行あける（K-07）。\n")
        tasks = self.carried_tasks()
        tasks[0]["criteria"] = ["K-01", "K-08"]
        tasks.append({"prompt": NEW_PROMPT, "inputs": [], "criteria": ["K-08"], "settings": {"maxIterations": 2, "task": {"week": "2026-W43"}}})
        self.save(self.make_state(rows=rows, tasks=tasks))
        return rows


class SubBase(Base):
    """プラグインが、大きなリポジトリ（マーケットプレイス）のサブフォルダにある。"""

    def make_plugin(self):
        out = self.build_plugin(os.path.join(self.folder, "weekly-report"))
        self.market = os.path.join(self.folder, "market")
        os.makedirs(os.path.join(self.market, "plugins"))
        shutil.rmtree(os.path.join(out, ".git"))
        target = os.path.join(self.market, "plugins", "weekly-report")
        shutil.move(out, target)
        write(os.path.join(self.market, "README.md"), "# マーケットプレイス\n")
        write(os.path.join(self.market, "plugins", "other", "plugin.json"), '{"name": "other"}\n')
        git(self.market, "init", "-q")
        git(self.market, "add", "-A")
        git(self.market, "commit", "-q", "-m", "init")
        return target


# ---------------------------------------------------------------- change-check（REQ-053）

class ChangeCheck(Base):
    """始める前の確かめ。止まるときは直し方を示し、フォルダの中身を変えない。"""

    def test_REQ_053_a_clean_generated_plugin_in_the_work_folder_passes(self):
        result = self.check()
        self.assertEqual((result["ok"], result["name"], result["version"], result["generated"], result["manifest"]),
                         (True, "weekly-report", "0.1.0", True, "plugin.json"))
        self.assertEqual((result["prefix"], result["tag"]), ("", "plugin-creator-generated"))
        self.assertEqual(result["plugin"], os.path.realpath(self.plugin))
        self.assertEqual(result["repo_root"], os.path.realpath(self.plugin))

    def test_REQ_053_the_work_folder_may_be_the_plugin_folder_itself(self):
        self.assertTrue(self.check(cwd=self.plugin)["ok"])

    def test_REQ_053_a_plugin_outside_the_work_folder_is_refused_with_how_to_restart(self):
        elsewhere = os.path.join(self.root, "elsewhere")
        os.makedirs(elsewhere)
        problems = self.refused_check("外にあります", "cd %s" % self.plugin, "copilot", cwd=elsewhere)
        self.assertEqual(len(problems), 1)

    def test_REQ_053_installed_copies_are_refused(self):
        home = os.environ["COPILOT_HOME"]
        for place in ("installed-plugins/market/weekly-report", "installed-plugins/_direct/abc123"):
            with self.subTest(place=place):
                copy = os.path.join(home, *place.split("/"))
                shutil.copytree(self.plugin, copy)
                with self.assertRaises(scaffold.Refusal) as caught:
                    scaffold.change_check(copy, self.root, template=self.template)
                self.assertMentions(caught.exception.problems, "インストール", "写し", "元のリポジトリ")

    def test_REQ_053_the_copilot_home_is_also_found_from_the_place_of_the_hearing_record(self):
        other_home = os.path.join(self.root, "other-home")
        copy = os.path.join(other_home, "installed-plugins", "m", "weekly-report")
        shutil.copytree(self.plugin, copy)
        self.assertTrue(scaffold.change_check(copy, self.root, template=self.template)["ok"])   # 環境変数の場所の外
        hearing = os.path.join(other_home, "plugin-data", "plugin-creator", "hearings", "s9", "state.json")
        with self.assertRaises(scaffold.Refusal) as caught:
            scaffold.change_check(copy, self.root, hearing, template=self.template)
        self.assertMentions(caught.exception.problems, "インストール")

    def test_REQ_053_marketplace_caches_are_refused(self):
        cache = os.environ["COPILOT_CACHE_HOME"]
        for place in ("marketplaces/m/plugins/weekly-report", "copilot/marketplaces/m/weekly-report"):
            with self.subTest(place=place):
                copy = os.path.join(cache, *place.split("/"))
                shutil.copytree(self.plugin, copy)
                with self.assertRaises(scaffold.Refusal) as caught:
                    scaffold.change_check(copy, self.root, template=self.template)
                self.assertMentions(caught.exception.problems, "マーケットプレイス", "写し")

    @unittest.skipIf(sys.platform == "darwin" or os.name == "nt", "Linux の既定のキャッシュの場所の試験")
    def test_REQ_053_the_default_cache_folder_is_refused_when_no_cache_home_is_set(self):
        xdg = os.path.join(self.root, "xdg")
        copy = os.path.join(xdg, "copilot", "marketplaces", "m", "weekly-report")
        shutil.copytree(self.plugin, copy)
        with mock.patch.dict(os.environ, {"XDG_CACHE_HOME": xdg}):
            os.environ.pop("COPILOT_CACHE_HOME")
            with self.assertRaises(scaffold.Refusal) as caught:
                scaffold.change_check(copy, self.root, template=self.template)
        self.assertMentions(caught.exception.problems, "マーケットプレイス")

    def test_REQ_053_a_folder_outside_git_is_refused(self):
        shutil.rmtree(self.at(".git"))
        problems = self.refused_check_without_git()
        self.assertMentions(problems, "git のリポジトリの中にありません", "git -C")

    def refused_check_without_git(self):
        with self.assertRaises(scaffold.Refusal) as caught:
            self.check()
        return caught.exception.problems

    def test_REQ_053_files_that_are_not_committed_are_refused_with_their_names(self):
        cases = {
            "変えたファイル": lambda: write(self.at("README.md"), "書き換えた\n"),
            "git add しただけのファイル": lambda: (write(self.at("new.md"), "x"), git(self.plugin, "add", "new.md")),
            "git に入れていないファイル": lambda: write(self.at("scripts/untracked.py"), "x"),
        }
        for label, make in cases.items():
            with self.subTest(label=label):
                self.setUp()
                make()
                problems = self.refused_check("まだコミットしていない変更", "git -C", "commit")
                self.assertTrue(any(name in "\n".join(problems) for name in ("README.md", "new.md", "scripts/untracked.py")))

    def test_REQ_053_the_temporary_work_folder_is_not_counted(self):
        write(os.path.join(self.plugin, scaffold.WORK_NAME, "parts", "x.md"), "x")
        self.assertTrue(self.check(cwd=self.plugin)["ok"])

    def test_REQ_053_ignored_files_that_the_template_also_ignores_pass_and_others_are_refused(self):
        with open(self.at(".gitignore"), "a", encoding="utf-8") as f:
            f.write("node_modules/\n")
        self.commit_all()
        write(self.at("tests/results/x.json"), "{}")
        write(self.at("a/__pycache__/y.pyc"), "x")
        self.assertTrue(self.check()["ok"])
        write(self.at("node_modules/x/index.js"), "x")
        problems = self.refused_check("外されたファイル", "node_modules")
        self.assertNotIn("tests/results", "\n".join(problems))

    def test_REQ_053_a_merge_in_the_middle_is_refused(self):
        head = git(self.plugin, "rev-parse", "HEAD").strip()
        write(os.path.join(self.plugin, ".git", "MERGE_HEAD"), head + "\n")
        self.refused_check("マージ", "途中")

    def test_REQ_053_a_rebase_in_the_middle_is_refused(self):
        os.makedirs(os.path.join(self.plugin, ".git", "rebase-merge"))
        self.refused_check("リベース", "途中")

    def test_REQ_053_a_cherry_pick_or_a_revert_in_the_middle_is_refused(self):
        head = git(self.plugin, "rev-parse", "HEAD").strip()
        for name, word in (("CHERRY_PICK_HEAD", "チェリーピック"), ("REVERT_HEAD", "リバート")):
            with self.subTest(name=name):
                self.setUp()
                write(os.path.join(self.plugin, ".git", name), head + "\n")
                self.refused_check(word, "途中")

    @unittest.skipIf(os.name == "nt", "示したコマンドを sh で動かす")
    def test_REQ_053_the_commit_command_shown_works_with_a_leftover_temporary_folder_ignored_or_not(self):
        for ignored in (True, False):
            with self.subTest(ignored=ignored):
                self.setUp()
                for key, value in (("user.name", "tester"), ("user.email", "tester@example.com"), ("commit.gpgsign", "false")):
                    git(self.plugin, "config", key, value)
                if not ignored:
                    write(self.at(".gitignore"), read(self.at(".gitignore")).replace(scaffold.WORK_NAME + "/\n", ""))
                    self.commit_all()
                write(os.path.join(self.plugin, scaffold.WORK_NAME, "extract.json"), "{}")   # 前の実行の残り
                write(self.at("README.md"), "書き換えた\n")
                problems = self.refused_check("まだコミットしていない変更", cwd=self.plugin)
                command = re.search(r"`(git -C [^`]*)`", "\n".join(problems)).group(1)
                self.assertEqual(scaffold.WORK_NAME in command, not ignored, command)
                done = subprocess.run(command, shell=True, cwd=self.root, capture_output=True, text=True, encoding="utf-8")
                self.assertEqual(done.returncode, 0, done.stderr)
                self.assertTrue(self.check(cwd=self.plugin)["ok"])
                self.assertIn("README.md", git(self.plugin, "show", "--name-only", "--format=", "HEAD"))
                self.assertNotIn(scaffold.WORK_NAME, git(self.plugin, "ls-files"))

    def test_REQ_053_a_folder_without_a_manifest_is_refused(self):
        empty = os.path.join(self.folder, "empty")
        os.makedirs(empty)
        with self.assertRaises(scaffold.Refusal) as caught:
            scaffold.change_check(empty, self.folder, template=self.template)
        self.assertMentions(caught.exception.problems, "マニフェスト", "plugin.json")

    def test_REQ_053_a_missing_folder_is_refused(self):
        with self.assertRaises(scaffold.Refusal) as caught:
            scaffold.change_check(os.path.join(self.folder, "nothing"), self.folder, template=self.template)
        self.assertMentions(caught.exception.problems, "ありません")


class ChangeCheckInARepository(SubBase):
    """大きなリポジトリのサブフォルダのプラグイン。"""

    def test_REQ_053_changes_only_in_other_folders_of_the_repository_do_not_stop(self):
        write(os.path.join(self.market, "README.md"), "変えた\n")
        write(os.path.join(self.market, "plugins", "other", "new.txt"), "x")
        git(self.market, "add", "plugins/other/new.txt")
        result = self.check()
        self.assertEqual((result["ok"], result["prefix"], result["tag"]),
                         (True, "plugins/weekly-report/", "plugin-creator-generated-weekly-report"))
        self.assertEqual(result["repo_root"], os.path.realpath(self.market))

    def test_REQ_053_a_change_inside_the_plugin_folder_stops_and_names_the_file_from_the_plugin_folder(self):
        write(self.at("scripts/summarize.py"), "# 書き換えた\n")
        problems = self.refused_check("scripts/summarize.py")
        self.assertNotIn("plugins/weekly-report/scripts", "\n".join(problems))

    def test_REQ_053_a_plugin_folder_ignored_by_gitignore_is_refused(self):
        write(os.path.join(self.market, ".gitignore"), "plugins/weekly-report/\n")
        git(self.market, "rm", "-r", "-q", "--cached", "plugins/weekly-report")
        git(self.market, "add", ".gitignore")
        git(self.market, "commit", "-q", "-m", "外す")
        self.refused_check(".gitignore", "git の管理から外されて")

    def test_REQ_053_a_plugin_folder_that_was_never_committed_is_refused(self):
        git(self.market, "rm", "-r", "-q", "--cached", "plugins/weekly-report")
        git(self.market, "commit", "-q", "-m", "外す")
        problems = self.refused_check("git で管理されていません")
        self.assertMentions(problems, "plugin.json")


class Kind(Base):
    """クリエイターが作った生成プラグインかの見分け方（BLUEPRINT D29）。change-check と extract で同じ結果になる。"""

    def both(self):
        self.commit_all()
        checked = self.check()["generated"]
        extracted = self.extract()["generated"]
        self.assertEqual(checked, extracted)
        return checked

    def test_REQ_052_both_lists_make_a_generated_plugin(self):
        self.assertTrue(self.both())

    def test_REQ_052_only_the_knowledge_list_is_not_a_generated_plugin(self):
        os.remove(self.at("com.github.copilot/extensions/weekly-report/task.json"))
        self.assertFalse(self.both())

    def test_REQ_052_only_the_task_definition_is_not_a_generated_plugin(self):
        os.remove(self.at("tests/knowledge.json"))
        self.assertFalse(self.both())

    def test_REQ_052_a_list_that_cannot_be_read_is_refused_with_the_reason(self):
        write(self.at("tests/knowledge.json"), "{ 壊れている")
        self.commit_all()
        with self.assertRaises(scaffold.Refusal) as caught:
            self.check()
        self.assertMentions(caught.exception.problems, "tests/knowledge.json", "JSON として読めません")
        with self.assertRaises(scaffold.Refusal) as caught:
            self.extract()
        self.assertMentions(caught.exception.problems, "tests/knowledge.json")


# ---------------------------------------------------------------- extract（REQ-057）

class Extract(Base):
    """直すプラグインから parts を取り出し、今のひな形で描いた下見と比べる。--work の中だけに書く。"""

    def test_REQ_057_a_built_plugin_is_taken_apart_into_the_same_parts(self):
        before = self.snapshot()
        result = self.extract()
        self.assertEqual(self.snapshot(), before, "取り出しで、プラグインのフォルダが変わった")
        self.assertTrue(result["ok"] and result["generated"])
        self.assertEqual(set(result["slots"].values()), {"found"})
        self.assertEqual(sorted(result["slots"]), sorted(n[:-3] for n in os.listdir(os.path.join(SAMPLE, "parts", "slots"))))
        for name in os.listdir(os.path.join(SAMPLE, "parts", "slots")):
            self.assertEqual(read(self.part("slots/" + name)).strip("\n"), read(os.path.join(SAMPLE, "parts", "slots", name)).strip("\n"), name)
        sample_manifest = load(os.path.join(SAMPLE, "parts", "manifest.json"))
        self.assertEqual(load(self.part("manifest.json")), sample_manifest)
        task = load(self.part("task.json"))
        self.assertNotIn("criteria", task)
        self.assertEqual(task, load(os.path.join(SAMPLE, "parts", "task.json")))
        self.assertEqual(load(os.path.join(self.work, "draft", "task.json")), task)
        self.assertEqual(result["files"], 4)
        self.assertTrue(os.path.isfile(self.part("files/scripts/summarize.py")))
        self.assertTrue(os.path.isfile(self.part("files/tests/eval/T-01/eval.json")))
        self.assertFalse(os.path.exists(self.part("files/README.md")))          # ひな形の場所のファイルは入れない
        self.assertFalse(os.path.exists(self.part("files/tests/knowledge.json")))

    def test_REQ_057_redrawing_without_changes_gives_the_same_plugin(self):
        result = self.extract()
        self.assertEqual(result["base"], {"added": [], "removed": [], "changed": []})
        self.assertEqual(result["delete"], [])
        self.assertTrue(os.path.isdir(os.path.join(self.work, "preview", "weekly-report")))

    def test_REQ_057_the_result_is_also_written_to_extract_json(self):
        result = self.extract()
        self.assertEqual(load(os.path.join(self.work, "extract.json")), json.loads(json.dumps(result)))
        for key in ("ok", "generated", "slots", "files", "delete", "base", "stage1", "name_conflicts", "warnings", "plugin", "head"):
            self.assertIn(key, result)
        self.assertEqual((result["plugin"], result["head"]), (os.path.realpath(self.plugin), git(self.plugin, "rev-parse", "HEAD").strip()))

    def test_REQ_057_changes_that_are_not_committed_are_not_taken(self):
        write(self.at("scripts/summarize.py"), "# まだコミットしていない\n")
        with self.assertRaises(scaffold.Refusal) as caught:
            self.extract()
        self.assertMentions(caught.exception.problems, "まだコミットしていない変更", "scripts/summarize.py")
        self.assertFalse(os.path.exists(self.work), "断ったのに、作業用の一時フォルダに書いた")

    def test_REQ_054_a_submodule_is_not_taken_and_not_listed_to_delete(self):
        self.add_submodule()
        result = self.extract()
        self.assertNotIn("vendor/lib", result["delete"])
        self.assertMentions(result["warnings"], "vendor/lib", "サブモジュール")
        self.assertTrue(os.path.isfile(self.part("files/.gitmodules")))
        self.assertFalse(os.path.exists(self.part("files/vendor")))

    def test_REQ_057_a_plugin_from_an_older_template_keeps_its_slots_and_shows_only_the_base_changes(self):
        old = os.path.join(self.root, "old-template")
        shutil.copytree(self.template, old)
        for rel, before, after in (("com.github.copilot/agents/orchestrator.agent.md", "## 作業エージェント", "## 作業エージェント（古い言い方）"),
                                   ("README.md", "# {{plugin_name}}\n", "# {{plugin_name}}（古い題）\n")):
            path = os.path.join(old, *rel.split("/"))
            write(path, read(path).replace(before, after))
        write(os.path.join(old, "com.github.copilot/extensions/_plugin_/core/index.mjs"), "// 古い土台\n")
        os.remove(os.path.join(old, "com.github.copilot/extensions/_plugin_/core/util.mjs"))
        write(os.path.join(old, "com.github.copilot/extensions/_plugin_/core/old.mjs"), "// 今のひな形にない土台\n")
        shutil.rmtree(self.plugin)
        self.plugin = self.build_plugin(os.path.join(self.folder, "weekly-report"), template=old)
        result = self.extract()
        self.assertEqual(set(result["slots"].values()), {"found"})
        for name in os.listdir(os.path.join(SAMPLE, "parts", "slots")):
            self.assertEqual(read(self.part("slots/" + name)).strip("\n"), read(os.path.join(SAMPLE, "parts", "slots", name)).strip("\n"), name)
        ext = "com.github.copilot/extensions/weekly-report/"
        self.assertEqual(result["base"]["added"], [ext + "core/util.mjs"])
        self.assertEqual(result["base"]["removed"], [ext + "core/old.mjs"])
        self.assertEqual(sorted(c["file"] for c in result["base"]["changed"]),
                         ["README.md", "com.github.copilot/agents/orchestrator.agent.md", ext + "core/index.mjs"])
        self.assertTrue(all(c["plus"] >= 1 and c["minus"] >= 1 for c in result["base"]["changed"]))
        self.assertFalse(os.path.exists(self.part("files/" + ext + "core/old.mjs")))   # 土台のフォルダの古いファイルは写さない

    def test_REQ_057_two_workers_extra_tools_and_an_entry_skill_named_differently_are_taken_back(self):
        def edit(parts, state):
            manifest = load(os.path.join(parts, "manifest.json"))
            manifest["entry_skill"]["name"] = "make-weekly"
            manifest["workers"][0]["extra_tools"] = ["github/get_issue"]
            manifest["workers"].append({"agent": "worker-summary", "label": "まとめる係", "extra_tools": ["files/read"]})
            manifest["verifier"]["extra_tools"] = ["github/list_issues"]
            dump(os.path.join(parts, "manifest.json"), manifest)
            task = load(os.path.join(parts, "task.json"))
            task["workers"].append({"agent": "worker-summary", "label": "まとめる係"})
            dump(os.path.join(parts, "task.json"), task)
            write(os.path.join(parts, "slots", "worker-task.worker-summary.md"), "### まとめ方\n\n- 3行にまとめる。\n")
        shutil.rmtree(self.plugin)
        self.plugin = self.build_plugin(os.path.join(self.folder, "weekly-report"), edit=edit)
        result = self.extract()
        manifest = load(self.part("manifest.json"))
        self.assertEqual(manifest["entry_skill"]["name"], "make-weekly")
        self.assertEqual([(w["agent"], w["extra_tools"]) for w in manifest["workers"]],
                         [("worker", ["github/get_issue"]), ("worker-summary", ["files/read"])])
        self.assertEqual(manifest["verifier"], {"extra_tools": ["github/list_issues"]})
        self.assertEqual(result["slots"]["worker-task.worker-summary"], "found")
        self.assertEqual(read(self.part("slots/worker-task.worker-summary.md")), "### まとめ方\n\n- 3行にまとめる。\n")
        self.assertEqual(result["base"], {"added": [], "removed": [], "changed": []})

    def change_template(self, rel, before, after):
        path = os.path.join(self.template, *rel.split("/"))
        text = read(path)
        self.assertIn(before, text)
        write(path, text.replace(before, after))

    def test_REQ_057_a_slot_whose_marker_before_it_is_gone_is_reported_missing(self):
        self.change_template("com.github.copilot/agents/orchestrator.agent.md", "## 作業ごとの指示", "## 作業ごとの指示（新しい言い方）")
        result = self.extract()
        self.assertEqual(result["slots"]["orchestrator-task"], "missing")
        self.assertFalse(os.path.exists(self.part("slots/orchestrator-task.md")))
        self.assertMentions(result["warnings"], "orchestrator-task", "parts/slots/orchestrator-task.md")

    def test_REQ_057_a_slot_whose_line_after_it_changed_is_not_guessed(self):
        self.change_template("README.md", "インストール：", "入れ方：")
        result = self.extract()
        self.assertEqual((result["slots"]["readme-how"], result["slots"]["readme-what"]), ("missing", "found"))
        self.assertMentions(result["warnings"], "readme-how")

    def test_REQ_057_a_slot_whose_heading_after_it_was_renamed_ends_at_the_next_heading(self):
        self.change_template("skills/_entry_/SKILL.md", "## 頼まれたとき", "## 作業を頼まれたとき")
        result = self.extract()
        self.assertEqual(result["slots"]["entry-task"], "found")
        self.assertEqual(read(self.part("slots/entry-task.md")).strip("\n"),
                         read(os.path.join(SAMPLE, "parts", "slots", "entry-task.md")).strip("\n"))

    def test_REQ_057_a_marker_that_appears_twice_is_counted_in_order(self):
        # 小さなひな形の検証エージェントは、差し込み口のすぐ前がフロントマターの終わりの ---（先頭の --- と同じ行）
        result = self.extract()
        self.assertEqual(read(self.part("slots/verifier-task.md")).strip("\n"),
                         read(os.path.join(SAMPLE, "parts", "slots", "verifier-task.md")).strip("\n"))
        self.assertEqual(result["slots"]["verifier-task"], "found")

    def test_REQ_057_without_the_checker_in_the_template_stage_one_is_skipped_with_a_warning(self):
        result = self.extract()
        self.assertEqual(result["stage1"], [])
        self.assertTrue(any("1段目" in w for w in result["warnings"]))

    def test_REQ_057_a_new_extract_replaces_what_the_last_one_left(self):
        self.extract()
        write(self.part("files/leftover.txt"), "前の残り")
        write(os.path.join(self.work, "changed.json"), "{}")
        self.extract()
        self.assertFalse(os.path.exists(self.part("files/leftover.txt")))
        self.assertFalse(os.path.exists(os.path.join(self.work, "changed.json")))

    def test_REQ_057_the_work_option_must_be_the_temporary_folder(self):
        with self.assertRaises(scaffold.Refusal) as caught:
            scaffold.extract(self.plugin, os.path.join(self.folder, "work"), template=self.template)
        self.assertMentions(caught.exception.problems, scaffold.WORK_NAME)

    def test_REQ_059_extracting_into_the_plugin_folder_itself_leaves_the_tracked_files_alone(self):
        self.work = os.path.join(self.plugin, scaffold.WORK_NAME)
        before = git(self.plugin, "ls-files")
        self.extract()
        self.assertEqual(git(self.plugin, "ls-files"), before)
        self.assertEqual(git(self.plugin, "status", "--porcelain", "--", ".", ":(exclude)%s" % scaffold.WORK_NAME), "")


class ExtractUserSkills(Base):
    """--hearing のとき：示されたスキルとの名前の重なり（REQ-055、D35）、記録の漏れ（D28）、プラグインの中のスキル。"""

    def user_skill(self, name, folder_name=None):
        folder = os.path.join(self.folder, "fw", ".github", "skills", folder_name or name)
        write(os.path.join(folder, "SKILL.md"), "---\nname: %s\ndescription: テスト用のスキル\n---\n\n本文\n" % name)
        write(os.path.join(folder, "scripts", "build.sh"), "#!/bin/sh\n")
        return folder

    def save_assets(self, assets):
        self.save(self.make_state(assets=[{"name": "a%d" % i, "location": a, "note": None, "status": "reuse"} for i, a in enumerate(assets)]))

    def test_REQ_055_a_shown_skill_with_the_same_name_as_a_plugin_skill_is_reported(self):
        folder = self.user_skill("weekly-report", "wr")
        self.save_assets([folder])
        result = self.extract(hearing=self.hearing)
        self.assertEqual(result["name_conflicts"], [{"name": "weekly-report", "user_skill": folder, "plugin_skill": "skills/weekly-report"}])

    def test_REQ_055_a_shown_skill_with_another_name_is_not_a_conflict_and_its_skill_md_may_be_recorded(self):
        folder = self.user_skill("deploy")
        self.save_assets([os.path.join(folder, "SKILL.md"), os.path.join(folder, "scripts", "build.sh")])
        self.assertEqual(self.extract(hearing=self.hearing)["name_conflicts"], [])

    def test_REQ_055_a_file_of_a_skill_without_its_folder_in_the_record_is_refused(self):
        folder = self.user_skill("deploy")
        self.save_assets([os.path.join(folder, "scripts", "build.sh")])
        with self.assertRaises(scaffold.Refusal) as caught:
            self.extract(hearing=self.hearing)
        self.assertMentions(caught.exception.problems, "build.sh", folder, "資産に記録されていません")
        self.assertFalse(os.path.exists(self.work), "断ったのに、作業用の一時フォルダに書いた")

    def test_REQ_055_a_shown_skill_inside_the_plugin_folder_is_refused(self):
        self.save_assets([self.at("skills/weekly-report")])
        with self.assertRaises(scaffold.Refusal) as caught:
            self.extract(hearing=self.hearing)
        self.assertMentions(caught.exception.problems, "直すプラグインのフォルダ", "中にあります")

    def test_REQ_055_files_of_the_plugin_itself_may_be_assets(self):
        self.save_assets([self.at("scripts/summarize.py")])
        self.assertEqual(self.extract(hearing=self.hearing)["name_conflicts"], [])


class OtherBase(Base):
    """クリエイターが作っていないプラグイン（D29、D31）。"""

    def make_plugin(self):
        plugin = os.path.join(self.folder, "my-tools")
        dump(os.path.join(plugin, "plugin.json"), {"name": "my-tools", "version": "1.2.0", "description": "手元の道具", "skills": "./skills/",
                                                   "repository": "https://github.com/me/my-tools", "author": {"name": "me"}})
        write(os.path.join(plugin, ".claude-plugin", "plugin.json"), '{"name": "my-tools"}\n')
        write(os.path.join(plugin, "README.md"), "# my-tools\n")
        write(os.path.join(plugin, "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: 送る\n---\n\n送る手順\n")
        write(os.path.join(plugin, "skills", "deploy", "scripts", "send.sh"), "#!/bin/sh\necho send\n")
        os.chmod(os.path.join(plugin, "skills", "deploy", "scripts", "send.sh"), 0o755)
        write(os.path.join(plugin, "tests", "test_send.py"), "import unittest\n")
        write(os.path.join(plugin, "com.github.copilot", "agents", "worker.agent.md"), "---\nname: worker\n---\n古い\n")
        git(plugin, "init", "-q")
        git(plugin, "add", "-A")
        git(plugin, "commit", "-q", "-m", "init")
        return plugin

    def write_parts(self, entry="my-tools"):
        """メインと作業エージェントの代わりに、manifest.json・作業の定義・すべての差し込み口・課題を書き、記録を作る。"""
        os.makedirs(self.part("slots"), exist_ok=True)
        for name in os.listdir(os.path.join(SAMPLE, "parts", "slots")):
            shutil.copy(os.path.join(SAMPLE, "parts", "slots", name), self.part("slots/" + name))
        manifest = load(os.path.join(SAMPLE, "parts", "manifest.json"))
        manifest.update(plugin_name="my-tools", plugin_description="手元の道具")
        manifest["entry_skill"]["name"] = entry
        dump(self.part("manifest.json"), manifest)
        shutil.copy(os.path.join(SAMPLE, "parts", "task.json"), self.part("task.json"))
        dump(self.part("files/tests/eval/T-01/eval.json"),
             {"id": "T-01", "prompt": T01_PROMPT, "inputs": [], "settings": {"maxIterations": 3, "task": {"week": "2026-W42"}},
              "criteria": [{"knowledge": "K-01", "grading": "model"}]})
        dump(self.part("files/tests/eval/T-02/eval.json"),
             {"id": "T-02", "prompt": NEW_PROMPT, "inputs": [], "settings": {"maxIterations": 3, "task": {"week": "2026-W43"}},
              "criteria": [{"knowledge": "K-01", "grading": "model"}]})
        rows = [row("K-01", "criterion", "合否の決め方", "見出しが2つある。"), row("K-02", "other", "決まった書き方やルール", "送る前に確かめる。")]
        tasks = [{"prompt": p, "inputs": [], "criteria": ["K-01"], "settings": {"maxIterations": 3, "task": {"week": w}}}
                 for p, w in ((T01_PROMPT, "2026-W42"), (NEW_PROMPT, "2026-W43"))]
        state = {"stage": "generate", "approvedAt": "2026-10-26T02:00:00Z", "knowledge": rows, "assets": [],
                 "change": {"folder": os.path.realpath(self.plugin), "name": "my-tools", "version": "1.2.0", "generated": False,
                            "carried": [], "removed": []},
                 "confirmation": {"evalTasks": tasks, "criteria": [{"id": "C-01", "knowledge": "K-01"}], "version": "1.3.0"}}
        self.save(state)


class ExtractOtherPlugin(OtherBase):
    def test_REQ_057_files_that_overlap_the_template_and_old_manifests_are_listed_to_delete(self):
        check = self.check()
        self.assertEqual((check["generated"], check["manifest"], check["version"]), (False, "plugin.json", "1.2.0"))
        result = self.extract()
        self.assertFalse(result["generated"])
        self.assertEqual(result["slots"], {})
        self.assertEqual(result["delete"], [".claude-plugin/plugin.json", "README.md", "plugin.json"])
        self.assertEqual(result["files"], 4)
        # 作業エージェントの名前はまだ決まっていないので、worker.agent.md は消す一覧に入れずに残す（選んだ名前と重なれば change が断る）
        self.assertTrue(os.path.isfile(self.part("files/com.github.copilot/agents/worker.agent.md")))
        self.assertTrue(os.path.isfile(self.part("files/skills/deploy/SKILL.md")))
        self.assertTrue(os.path.isfile(self.part("files/tests/test_send.py")))   # 元からあった試験は残す（REQ-060）
        self.assertTrue(os.access(self.part("files/skills/deploy/scripts/send.sh"), os.X_OK))
        self.assertFalse(os.path.exists(self.part("manifest.json")))
        self.assertFalse(os.path.exists(os.path.join(self.work, "draft")))
        self.assertEqual(result["base"], {"added": [], "removed": [], "changed": []})

    def test_REQ_053_a_plugin_with_only_an_old_manifest_is_accepted(self):
        os.remove(os.path.join(self.plugin, "plugin.json"))
        self.commit_all()
        self.assertEqual(self.check()["manifest"], ".claude-plugin/plugin.json")


# ---------------------------------------------------------------- change（REQ-058、REQ-059、REQ-061）

class Change(Base):
    """直す内容で描き、プラグインのフォルダのファイルを入れ替える。コミットはしない。"""

    def test_REQ_057_without_changes_only_the_version_changes(self):
        self.extract()
        self.save(self.make_state())
        head = git(self.plugin, "rev-parse", "HEAD")
        result = self.change()
        self.assertEqual((result["ok"], result["version"]), (True, {"from": "0.1.0", "to": "0.2.0"}))
        self.assertEqual((result["added"], result["removed"], result["changed"]), ([], [], ["plugin.json"]))
        self.assertEqual(load(self.at("plugin.json"))["version"], "0.2.0")
        self.assertEqual(git(self.plugin, "rev-parse", "HEAD"), head, "change はコミットしない")
        self.assertEqual(git(self.plugin, "status", "--porcelain"), " M plugin.json\n")
        changed = load(os.path.join(self.work, "changed.json"))
        self.assertEqual(changed, {"plugin": os.path.realpath(self.plugin), "head": head.strip(), "files": ["plugin.json"]})
        self.assertFalse(os.path.exists(os.path.join(self.work, "stage")))
        self.assertEqual(result["knowledge"], {"kept": ["K-01", "K-02", "K-03", "K-06"], "added": [], "replaced": [], "removed": []})
        self.assertEqual(result["criteria"], [{"id": "C-01", "knowledge": "K-01"}, {"id": "C-02", "knowledge": "K-03"}])
        self.assertFalse(os.path.exists(self.at("tests/knowledge-removed.json")))

    def test_REQ_058_carried_numbers_stay_new_ones_follow_and_replaced_ones_are_kept_as_removed(self):
        self.full_change()
        result = self.change()
        knowledge = load(self.at("tests/knowledge.json"))
        self.assertEqual([r["id"] for r in knowledge], ["K-01", "K-02", "K-06", "K-07", "K-08"])
        self.assertEqual(knowledge[0], {"id": "K-01", "kind": "criterion", "item": "合否の決め方",
                                        "text": "週報は、見出し「今週やったこと」と「来週やること」の2つがあれば合格とする。"})
        self.assertEqual(load(self.at("tests/knowledge-removed.json")),
                         [{"id": "K-03", "kind": "criterion", "item": "決まった書き方やルール", "text": "数字は半角で書く（例：3件）。", "replacedBy": "K-08"}])
        self.assertEqual(result["knowledge"], {"kept": ["K-01", "K-02", "K-06"], "added": ["K-07"],
                                               "replaced": [{"from": "K-03", "to": "K-08"}], "removed": []})

    def test_REQ_061_carried_criteria_keep_their_numbers_and_new_ones_follow(self):
        self.full_change()
        result = self.change()
        self.assertEqual(result["criteria"], [{"id": "C-01", "knowledge": "K-01"}, {"id": "C-03", "knowledge": "K-08"}])
        task = load(self.at("com.github.copilot/extensions/weekly-report/task.json"))
        self.assertEqual([(c["id"], c["knowledge"]) for c in task["criteria"]], [("C-01", "K-01"), ("C-03", "K-08")])
        t01 = load(self.at("tests/eval/T-01/eval.json"))
        self.assertEqual([c["id"] for c in t01["criteria"]], ["C-01", "C-03"])
        self.assertTrue(os.path.isfile(self.at("tests/eval/T-01/inputs/memo.txt")))   # 引き継いだ課題の入力は残る
        t02 = load(self.at("tests/eval/T-02/eval.json"))
        self.assertEqual(t02["criteria"][0]["id"], "C-03")
        self.assertEqual(sorted(result["added"]), ["tests/eval/T-02/eval.json", "tests/knowledge-removed.json"])

    def test_REQ_061_an_eval_task_that_still_points_at_a_removed_criterion_is_refused(self):
        self.full_change()
        self.edit_eval("tests/eval/T-01/eval.json", lambda d: d["criteria"].__setitem__(1, {"id": "C-02", "grading": "model"}))
        self.refused_change("C-02", "作業の定義の基準の番号にありません")

    def test_REQ_058_a_carried_number_with_other_content_is_refused(self):
        self.extract()
        rows = self.carried_rows()
        rows[2]["text"] = "数字は全角で書く。"
        self.save(self.make_state(rows=rows))
        self.refused_change("K-03", "新しい番号")

    def test_REQ_058_a_new_number_not_after_every_used_number_is_refused(self):
        self.extract()
        rows = self.carried_rows() + [row("K-05", "other", "決まった書き方やルール", "敬体で書く。")]
        self.save(self.make_state(rows=rows))
        self.refused_change("K-05", "後になっていません")

    def test_REQ_058_a_replacement_of_a_number_that_stays_is_refused(self):
        self.extract()
        rows = self.carried_rows() + [row("K-07", "other", "決まった書き方やルール", "敬体で書く。", replaces="K-02")]
        self.save(self.make_state(rows=rows))
        self.refused_change("K-07", "K-02")

    def test_REQ_058_a_second_change_never_reuses_a_removed_number(self):
        self.full_change()
        self.change()
        scaffold.commit_change(self.plugin, "1回目", self.work)
        self.extract()
        rows = self.carried_rows() + [row("K-03", "other", "決まった書き方やルール", "前に外した番号を使う。")]
        self.save(self.make_state(rows=rows, tasks=self.carried_tasks(), version="0.3.0"))
        self.refused_change("K-03", "前に外した番号")
        rows[-1]["id"] = "K-09"
        self.save(self.make_state(rows=[r for r in rows if r["id"] != "K-06"], tasks=self.carried_tasks(), version="0.3.0"))
        self.change()
        removed = load(self.at("tests/knowledge-removed.json"))
        self.assertEqual([(r["id"], r.get("replacedBy")) for r in removed], [("K-03", "K-08"), ("K-06", None)])
        self.assertEqual([r["id"] for r in load(self.at("tests/knowledge.json"))], ["K-01", "K-02", "K-07", "K-08", "K-09"])

    def test_REQ_061_criterion_numbers_that_do_not_match_the_original_are_refused(self):
        cases = {
            "引き継いだ基準の番号が違う": ([{"id": "C-05", "knowledge": "K-01"}, {"id": "C-02", "knowledge": "K-03"}], "元の番号のまま"),
            "新しい基準が元の番号を使う": None,
            "基準が足りない": ([{"id": "C-01", "knowledge": "K-01"}], "K-03"),
            "番号の形が違う": ([{"id": "C1", "knowledge": "K-01"}, {"id": "C-02", "knowledge": "K-03"}], "C-数字"),
            "番号が重なる": ([{"id": "C-01", "knowledge": "K-01"}, {"id": "C-01", "knowledge": "K-03"}], "重なって"),
        }
        for label, case in cases.items():
            with self.subTest(label=label):
                self.setUp()
                if case is None:
                    rows = self.full_change()
                    state = load(self.hearing)
                    state["confirmation"]["criteria"] = [{"id": "C-01", "knowledge": "K-01"}, {"id": "C-02", "knowledge": "K-08"}]
                    self.save(state)
                    self.refused_change("K-08", "C-02", "重なっています")
                    continue
                self.extract()
                self.save(self.make_state(criteria=case[0]))
                self.refused_change(case[1])

    def test_REQ_057_the_version_must_be_greater_than_the_current_one(self):
        self.extract()
        for version, word in (("0.1.0", "大きくありません"), ("0.0.9", "大きくありません"), ("1.0", "confirmation.version"), (None, "confirmation.version")):
            with self.subTest(version=version):
                self.save(self.make_state(version=version))
                self.refused_change(word)

    def test_REQ_052_the_record_and_the_extract_result_must_agree_on_the_kind_of_plugin(self):
        self.extract()
        state = self.make_state()
        state["change"]["generated"] = False
        self.save(state)
        self.refused_change("見分け", "extract")

    def test_REQ_052_change_needs_the_extract_result_and_the_change_record(self):
        self.save(self.make_state())
        self.refused_change("extract")
        self.extract()
        state = self.make_state()
        state.pop("change")
        self.save(state)
        self.refused_change("change")

    def test_REQ_020_change_needs_the_approval_and_the_same_folder(self):
        self.extract()
        state = self.make_state()
        state["stage"] = "confirm"
        self.save(state)
        self.refused_change("「生成」ではありません")
        state = self.make_state()
        state["change"]["folder"] = self.folder
        self.save(state)
        self.refused_change("--plugin")

    def test_REQ_053_the_checks_are_done_again_right_before_changing(self):
        self.extract()
        self.save(self.make_state())
        write(self.at("scripts/summarize.py"), "# 承認の後に書き換えた\n")
        with self.assertRaises(scaffold.Refusal) as caught:
            self.change()
        self.assertMentions(caught.exception.problems, "まだコミットしていない変更", "scripts/summarize.py")
        self.assertEqual(read(self.at("scripts/summarize.py")), "# 承認の後に書き換えた\n")
        self.assertEqual(load(self.at("plugin.json"))["version"], "0.1.0")

    def test_REQ_057_a_commit_in_the_plugin_folder_after_extract_is_refused(self):
        self.extract()
        self.save(self.make_state())
        write(self.at("scripts/summarize.py"), "# 取り出した後にコミットした直し\n")
        self.commit_all("取り出した後の直し")
        self.refused_change("取り出した後", "extract")
        self.extract()   # 取り出し直すと、その直しも引き継ぐ
        result = self.change()
        self.assertNotIn("scripts/summarize.py", result["changed"])
        self.assertEqual(read(self.at("scripts/summarize.py")), "# 取り出した後にコミットした直し\n")

    def test_REQ_057_an_extract_result_of_another_folder_or_without_its_commit_is_refused(self):
        self.extract()
        self.save(self.make_state())
        data = load(os.path.join(self.work, "extract.json"))
        for key, value in (("plugin", os.path.join(self.folder, "other")), ("head", None), ("head", "--output=x")):
            with self.subTest(key=key, value=value):
                dump(os.path.join(self.work, "extract.json"), dict(data, **{key: value}))
                self.refused_change("取り出したものではありません", "extract")

    def test_REQ_058_a_knowledge_list_changed_since_it_was_carried_is_refused(self):
        state = self.make_state()   # 直す流れを始めたときに取り込んだ番号
        knowledge = load(self.at("tests/knowledge.json"))
        dump(self.at("tests/knowledge.json"), knowledge + [{"id": "K-07", "kind": "other", "item": "決まった書き方やルール", "text": "手で足した決まり。"}])
        self.commit_all("決まりを手で足した")
        self.extract()
        self.save(state)
        self.refused_change("取り込んだときから変わっています", "K-07", "始めからやり直して")

    def test_REQ_057_fields_of_the_manifest_the_template_does_not_write_are_kept(self):
        manifest = load(self.at("plugin.json"))
        manifest.update(repository="https://github.com/me/weekly-report", license="MIT", keywords=["週報"])
        dump(self.at("plugin.json"), manifest)
        self.commit_all()
        result = self.extract()
        self.assertEqual(result["base"], {"added": [], "removed": [], "changed": []}, "土台の変更として示さない")
        self.save(self.make_state())
        self.assertEqual(self.change()["changed"], ["plugin.json"])
        self.assertEqual(load(self.at("plugin.json")), dict(manifest, version="0.2.0"))

    def test_REQ_054_a_submodule_is_left_as_it_is(self):
        self.add_submodule()
        self.extract()
        self.save(self.make_state())
        result = self.change()
        self.assertNotIn("vendor/lib", result["removed"])
        self.assertTrue(os.path.isfile(self.at("vendor/lib/f.txt")))
        self.assertTrue(git(self.plugin, "ls-files", "-s", "--", "vendor/lib").startswith("160000 "))
        self.assertEqual(git(self.plugin, "status", "--porcelain"), " M plugin.json\n")

    def test_REQ_054_a_file_removed_from_the_parts_is_removed_from_the_plugin(self):
        self.extract()
        os.remove(self.part("files/scripts/summarize.py"))
        self.save(self.make_state())
        result = self.change()
        self.assertIn("scripts/summarize.py", result["removed"])
        self.assertFalse(os.path.exists(self.at("scripts")), "空になったフォルダも片付ける")
        self.assertIn("scripts/summarize.py", load(os.path.join(self.work, "changed.json"))["files"])

    def test_REQ_052_a_worker_agent_can_be_added(self):
        self.extract()
        manifest = load(self.part("manifest.json"))
        manifest["workers"].append({"agent": "worker-check", "label": "確かめる係", "extra_tools": []})
        dump(self.part("manifest.json"), manifest)
        task = load(self.part("task.json"))
        task["workers"].append({"agent": "worker-check", "label": "確かめる係"})
        dump(self.part("task.json"), task)
        write(self.part("slots/worker-task.worker-check.md"), "### 確かめ方\n\n- 数字の書き方を確かめる。\n")
        self.save(self.make_state())
        result = self.change()
        self.assertIn("com.github.copilot/agents/worker-check.agent.md", result["added"])
        self.assertIn("数字の書き方を確かめる", read(self.at("com.github.copilot/agents/worker-check.agent.md")))
        self.assertIn("`weekly-report:worker-check`：確かめる係", read(self.at("com.github.copilot/agents/orchestrator.agent.md")))

    def test_REQ_059_ignored_files_marks_and_files_outside_stay_as_they_are(self):
        os.chmod(self.at("scripts/summarize.py"), 0o755)
        self.commit_all()
        write(self.at("tests/results/latest.json"), "{}")
        outside = os.path.join(self.folder, "outside.txt")
        write(outside, "外")
        self.extract()
        self.save(self.make_state())
        self.change()
        self.assertEqual(read(self.at("tests/results/latest.json")), "{}")
        self.assertTrue(os.access(self.at("scripts/summarize.py"), os.X_OK))
        self.assertEqual(read(outside), "外")

    def test_REQ_053_a_failure_while_swapping_puts_everything_back(self):
        self.full_change()
        before = self.snapshot()
        real_copy = shutil.copy2
        calls = []

        def broken(src, dst, *a, **kw):
            if os.path.realpath(dst).startswith(os.path.realpath(self.plugin) + os.sep):
                calls.append(dst)
                if len(calls) == 2:
                    raise OSError("書けない")
            return real_copy(src, dst, *a, **kw)

        with mock.patch.object(scaffold.shutil, "copy2", side_effect=broken):
            with self.assertRaises(scaffold.Refusal) as caught:
                self.change()
        self.assertMentions(caught.exception.problems, "直す前の状態に戻しました", "書けない")
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(os.path.exists(os.path.join(self.work, "changed.json")))

    def test_REQ_059_the_plugin_name_cannot_be_changed(self):
        self.extract()
        manifest = load(self.part("manifest.json"))
        manifest["plugin_name"] = "monthly-report"
        dump(self.part("manifest.json"), manifest)
        self.save(self.make_state())
        self.refused_change("名前は変えられません")

    def test_REQ_059_the_base_matches_the_template_after_the_change_and_task_tests_stay(self):
        self.extract()
        self.save(self.make_state())
        self.change()
        self.assertTrue(scaffold.check_base(self.plugin, template=self.template)["ok"])
        self.assertTrue(os.path.isfile(self.at("tests/stage2/task/test_summarize.py")))


class ChangeUserSkills(Base):
    """示されたスキル（REQ-055）：名前の重なりは最後にも確かめ、示されたスキルのフォルダは変えない。"""

    def setUp(self):
        super().setUp()
        self.skill = os.path.join(self.folder, "fw", ".github", "skills", "deploy")
        write(os.path.join(self.skill, "SKILL.md"), "---\nname: deploy\ndescription: 送る\n---\n\n送る手順\n")
        write(os.path.join(self.skill, "scripts", "send.sh"), "#!/bin/sh\n")

    def skill_files(self):
        out = {}
        for directory, _dirs, names in os.walk(self.skill):
            for n in names:
                out[os.path.relpath(os.path.join(directory, n), self.skill)] = read(os.path.join(directory, n))
        return out

    def test_REQ_055_a_plugin_skill_with_the_name_of_a_shown_skill_is_refused(self):
        self.extract()
        write(self.part("files/skills/deploy/SKILL.md"), "---\nname: deploy\ndescription: ルール\n---\n\n本文\n")
        self.save(self.make_state(assets=[{"name": "deploy", "location": self.skill, "note": None, "status": "reuse"}]))
        before = self.skill_files()
        self.refused_change("deploy", "名前", "別の名前")
        self.assertEqual(self.skill_files(), before)

    def test_REQ_055_a_rule_skill_with_another_name_is_accepted_and_the_shown_skill_is_unchanged(self):
        self.extract()
        write(self.part("files/skills/deploy-rules/SKILL.md"), "---\nname: deploy-rules\ndescription: ルール\n---\n\n本文\n")
        shutil.copy(os.path.join(self.skill, "scripts", "send.sh"), os.path.join(os.path.dirname(self.part("files/skills/deploy-rules/SKILL.md")), "send.sh"))
        self.save(self.make_state(assets=[{"name": "deploy", "location": self.skill, "note": None, "status": "reuse"}]))
        before = self.skill_files()
        result = self.change()
        self.assertIn("skills/deploy-rules/SKILL.md", result["added"])
        self.assertEqual(self.skill_files(), before)

    def test_REQ_055_the_record_must_have_the_folder_of_a_shown_skill(self):
        self.extract()
        self.save(self.make_state(assets=[{"name": "send", "location": os.path.join(self.skill, "scripts", "send.sh"), "note": None, "status": "reuse"}]))
        self.refused_change("資産に記録されていません")

    def test_REQ_055_a_shown_skill_inside_the_plugin_is_refused(self):
        self.extract()
        self.save(self.make_state(assets=[{"name": "entry", "location": self.at("skills/weekly-report"), "note": None, "status": "reuse"}]))
        self.refused_change("中にあります")


class ChangeOtherPlugin(OtherBase):
    """作っていないプラグインを、メインと作業エージェントの代わりに試験が parts を書いて、最後まで直す（D31）。"""

    def test_REQ_052_a_plugin_the_creator_did_not_make_is_changed_into_a_generated_plugin(self):
        self.extract()
        self.write_parts()
        # 元の com.github.copilot/agents/worker.agent.md は、選んだ作業エージェントの名前（worker）と重なるので断る
        problems = self.refused_change("com.github.copilot/agents/worker.agent.md", "作業エージェントに別の名前")
        self.assertEqual(len(problems), 1)
        os.remove(self.part("files/com.github.copilot/agents/worker.agent.md"))   # 確認で示して、置き換えると決めた
        result = self.change()
        self.assertEqual(sorted(result["removed"]), [".claude-plugin/plugin.json"])
        self.assertIn("README.md", result["changed"])
        self.assertIn("com.github.copilot/agents/worker.agent.md", result["changed"])
        manifest = load(self.at("plugin.json"))
        self.assertEqual(manifest["version"], "1.3.0")
        # 元のマニフェストの、ひな形が書かない項目を引き継ぐ。Agent Plugins のマニフェストにない項目（以前の形式の skills）は引き継がない
        self.assertEqual((manifest["repository"], manifest["author"]), ("https://github.com/me/my-tools", {"name": "me"}))
        self.assertNotIn("skills", manifest)
        self.assertTrue(os.path.isfile(self.at("skills/deploy/scripts/send.sh")))
        self.assertTrue(os.access(self.at("skills/deploy/scripts/send.sh"), os.X_OK))
        self.assertTrue(os.path.isfile(self.at("tests/test_send.py")))
        self.assertTrue(os.path.isfile(self.at("com.github.copilot/extensions/my-tools/task.json")))
        self.assertEqual([r["id"] for r in load(self.at("tests/knowledge.json"))], ["K-01", "K-02"])
        self.assertTrue(scaffold.check_base(self.plugin, template=self.template)["ok"])

    def test_REQ_052_the_kind_from_the_record_must_be_the_same_for_a_plugin_the_creator_did_not_make(self):
        self.extract()
        self.save({"stage": "generate", "approvedAt": "x", "knowledge": [], "confirmation": {"version": "1.3.0"},
                   "change": {"folder": os.path.realpath(self.plugin), "generated": True}})
        with self.assertRaises(scaffold.Refusal) as caught:
            self.change()
        self.assertMentions(caught.exception.problems, "見分け")


class OtherPluginWithASkillOfItsName(OtherBase):
    """作っていないプラグインに、プラグインと同じ名前のスキルがある。入口のスキルの名前は extract のときには決まっていないので、
    そのスキルを消す一覧に入れない（REQ-054：頼まれていない機能を消さない）。"""

    def make_plugin(self):
        plugin = os.path.join(self.folder, "my-tools")
        write(os.path.join(plugin, "plugin.json"), '{"name": "my-tools", "version": "1.2.0", "description": "手元の道具"}\n')
        write(os.path.join(plugin, "skills", "my-tools", "SKILL.md"), "---\nname: my-tools\ndescription: 道具を使う\n---\n\nユーザーのスキルの本文\n")
        write(os.path.join(plugin, "skills", "my-tools", "scripts", "run.sh"), "#!/bin/sh\necho run\n")
        git(plugin, "init", "-q")
        git(plugin, "add", "-A")
        git(plugin, "commit", "-q", "-m", "init")
        return plugin

    def test_REQ_054_a_skill_named_like_the_plugin_is_kept_in_the_parts(self):
        result = self.extract()
        self.assertEqual(result["delete"], ["plugin.json"])
        self.assertTrue(os.path.isfile(self.part("files/skills/my-tools/SKILL.md")))
        self.assertTrue(os.path.isfile(self.part("files/skills/my-tools/scripts/run.sh")))

    def test_REQ_054_an_entry_skill_with_another_name_leaves_the_skill_as_it_is(self):
        before = read(self.at("skills/my-tools/SKILL.md"))
        self.extract()
        self.write_parts(entry="my-tools-start")
        result = self.change()
        self.assertNotIn("skills/my-tools/SKILL.md", result["removed"] + result["changed"])
        self.assertEqual(read(self.at("skills/my-tools/SKILL.md")), before)
        self.assertTrue(os.path.isfile(self.at("skills/my-tools/scripts/run.sh")))
        self.assertTrue(os.path.isfile(self.at("skills/my-tools-start/SKILL.md")))

    def test_REQ_054_an_entry_skill_with_the_same_name_is_refused(self):
        self.extract()
        self.write_parts(entry="my-tools")
        self.refused_change("skills/my-tools/", "skills/my-tools/SKILL.md", "skills/my-tools/scripts/run.sh", "入口のスキルに別の名前")


class ChangeInTheSameFolder(Base):
    """作業フォルダがプラグインのフォルダと同じ（作業用の一時フォルダがプラグインの中にできる）。"""

    def setUp(self):
        super().setUp()
        self.work = os.path.join(self.plugin, scaffold.WORK_NAME)

    def test_REQ_059_the_temporary_folder_inside_the_plugin_is_never_committed(self):
        self.extract()
        self.save(self.make_state())
        result = self.change()
        self.assertEqual(result["changed"], ["plugin.json"])
        done = scaffold.commit_change(self.plugin, "plugin-creator: weekly-report を直した（0.1.0 → 0.2.0）", self.work)
        self.assertNotIn(scaffold.WORK_NAME, git(self.plugin, "show", "--name-only", "--format=", "HEAD"))
        self.assertTrue(done["work_folder_removed"])
        self.assertFalse(os.path.exists(self.work))
        self.assertEqual(git(self.plugin, "status", "--porcelain", "--untracked-files=all"), "")


class ChangeInARepository(SubBase):
    def test_REQ_057_a_commit_only_in_other_folders_after_extract_does_not_stop_the_change(self):
        self.extract()
        self.save(self.make_state())
        write(os.path.join(self.market, "plugins", "other", "new.txt"), "x")
        git(self.market, "add", "-A", "--", "plugins/other")
        git(self.market, "commit", "-q", "-m", "ほかのプラグインを直した")
        self.assertEqual(self.change()["changed"], ["plugin.json"])


# ---------------------------------------------------------------- change-guard（BLUEPRINT D19）

class Guard(Base):
    """試験の直しの後、描き直しで変えたファイルのほかが変わっていれば示し、戻す。"""

    def setUp(self):
        super().setUp()
        self.full_change()
        self.change()

    def test_REQ_057_files_changed_by_the_redraw_may_be_fixed(self):
        with open(self.at("tests/eval/T-02/eval.json"), "a", encoding="utf-8") as f:
            f.write(" ")
        result = scaffold.change_guard(self.plugin, self.work)
        self.assertEqual(result, {"ok": True, "unexpected": [], "restored": []})

    def test_REQ_057_other_changes_are_shown_and_put_back(self):
        original = read(self.at("scripts/summarize.py"))
        write(self.at("scripts/summarize.py"), "# 試験を通すために書き換えた\n")
        write(self.at("scripts/new_helper.py"), "x")
        os.remove(self.at("tests/stage2/task/test_summarize.py"))
        result = scaffold.change_guard(self.plugin, self.work)
        self.assertFalse(result["ok"])
        self.assertEqual(result["unexpected"], ["scripts/new_helper.py", "scripts/summarize.py", "tests/stage2/task/test_summarize.py"])
        result = scaffold.change_guard(self.plugin, self.work, restore=True)
        self.assertTrue(result["ok"])
        self.assertEqual(result["restored"], result["unexpected"])
        self.assertEqual(read(self.at("scripts/summarize.py")), original)
        self.assertFalse(os.path.exists(self.at("scripts/new_helper.py")))
        self.assertTrue(os.path.isfile(self.at("tests/stage2/task/test_summarize.py")))
        self.assertEqual(load(self.at("plugin.json"))["version"], "0.2.0", "描き直したものは戻さない")

    def test_REQ_057_a_staged_new_file_is_removed_too(self):
        write(self.at("notes.md"), "x")
        git(self.plugin, "add", "notes.md")
        result = scaffold.change_guard(self.plugin, self.work, restore=True)
        self.assertEqual((result["ok"], result["restored"]), (True, ["notes.md"]))
        self.assertNotIn("notes.md", git(self.plugin, "ls-files"))
        self.assertFalse(os.path.exists(self.at("notes.md")))

    def test_REQ_057_the_guard_needs_the_list_of_the_change(self):
        os.remove(os.path.join(self.work, "changed.json"))
        with self.assertRaises(scaffold.Refusal) as caught:
            scaffold.change_guard(self.plugin, self.work)
        self.assertMentions(caught.exception.problems, "changed.json")


class GuardInARepository(SubBase):
    def test_REQ_057_redrawn_files_of_a_plugin_in_a_subfolder_are_not_unexpected(self):
        self.full_change()
        self.change()
        write(os.path.join(self.market, "README.md"), "ほかのフォルダ\n")
        result = scaffold.change_guard(self.plugin, self.work)
        self.assertEqual(result, {"ok": True, "unexpected": [], "restored": []})
        write(self.at("scripts/summarize.py"), "x")
        self.assertEqual(scaffold.change_guard(self.plugin, self.work)["unexpected"], ["scripts/summarize.py"])


# ---------------------------------------------------------------- commit（REQ-059）

class Commit(SubBase):
    """プラグインのフォルダの中だけをコミットし、印のタグを付ける。push はしない。"""

    MESSAGE = "plugin-creator: weekly-report を直した（0.1.0 → 0.2.0）"

    def setUp(self):
        super().setUp()
        self.base_commit = git(self.market, "rev-parse", "HEAD").strip()
        self.full_change()
        self.change()

    def test_REQ_059_only_the_plugin_folder_is_committed_and_staged_changes_elsewhere_stay_staged(self):
        write(os.path.join(self.market, "plugins", "other", "x.txt"), "x")
        git(self.market, "add", "plugins/other/x.txt")
        write(os.path.join(self.market, "README.md"), "書き換えただけ\n")
        result = scaffold.commit_change(self.plugin, self.MESSAGE, self.work)
        self.assertTrue(result["ok"])
        files = git(self.market, "show", "--name-only", "--format=", result["commit"]).split()
        self.assertTrue(files and all(f.startswith("plugins/weekly-report/") for f in files), files)
        self.assertIn("A  plugins/other/x.txt", git(self.market, "status", "--porcelain"))
        self.assertIn(" M README.md", git(self.market, "status", "--porcelain"))
        self.assertEqual(git(self.market, "status", "--porcelain", "--", "plugins/weekly-report"), "")
        self.assertEqual(git(self.market, "log", "-1", "--format=%s"), self.MESSAGE + "\n")

    def test_REQ_059_the_tag_of_a_plugin_in_a_subfolder_has_its_name_even_if_the_plain_tag_exists(self):
        git(self.market, "tag", "plugin-creator-generated")
        result = scaffold.commit_change(self.plugin, self.MESSAGE, self.work)
        self.assertEqual(result["tag"], "plugin-creator-generated-weekly-report")
        self.assertEqual(git(self.market, "rev-parse", "plugin-creator-generated-weekly-report^{commit}"), git(self.market, "rev-parse", "HEAD"))
        self.assertEqual(git(self.market, "rev-parse", "plugin-creator-generated^{commit}").strip(), self.base_commit)

    def test_REQ_059_reverting_the_commit_gives_back_the_plugin_before_the_change(self):
        result = scaffold.commit_change(self.plugin, self.MESSAGE, self.work)
        self.assertEqual(result["revert"], "git -C %s revert --no-edit %s" % (self.plugin, result["commit"]))
        git(self.plugin, "revert", "--no-edit", result["commit"])
        self.assertEqual(git(self.market, "diff", self.base_commit, "HEAD", "--", "plugins/weekly-report"), "")

    def test_REQ_059_the_temporary_folder_is_removed_and_nothing_is_pushed(self):
        origin = os.path.join(self.root, "origin.git")
        git(self.root, "init", "-q", "--bare", origin)
        git(self.market, "remote", "add", "origin", origin)
        git(self.market, "push", "-q", "origin", "HEAD:refs/heads/main")
        refs = git(origin, "for-each-ref")
        result = scaffold.commit_change(self.plugin, self.MESSAGE, self.work)
        self.assertTrue(result["work_folder_removed"])
        self.assertFalse(os.path.exists(self.work))
        self.assertEqual(git(origin, "for-each-ref"), refs)

    def test_REQ_059_the_commit_works_without_a_git_identity(self):
        empty = os.path.join(self.root, "empty-config")
        write(empty, "")
        with mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": empty, "GIT_CONFIG_NOSYSTEM": "1", "HOME": self.root}):
            for key in ("GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"):
                os.environ.pop(key, None)
            result = scaffold.commit_change(self.plugin, self.MESSAGE, self.work)
        self.assertEqual(git(self.market, "log", "-1", "--format=%an <%ae>", result["commit"]).strip(), "plugin-creator <plugin-creator@localhost>")

    def test_REQ_059_nothing_to_commit_makes_no_commit_but_still_tags(self):
        scaffold.commit_change(self.plugin, self.MESSAGE, self.work)
        head = git(self.market, "rev-parse", "HEAD")
        result = scaffold.commit_change(self.plugin, "もう一度")
        self.assertEqual((result["commit"], result["revert"], result["tag"]), (None, None, "plugin-creator-generated-weekly-report"))
        self.assertEqual(git(self.market, "rev-parse", "HEAD"), head)
        self.assertTrue(result["warnings"])

    def test_REQ_059_a_tag_that_cannot_be_made_leaves_the_commit_and_a_warning(self):
        git(self.market, "tag", "plugin-creator-generated-weekly-report/old")
        result = scaffold.commit_change(self.plugin, self.MESSAGE, self.work)
        self.assertTrue(result["ok"])
        self.assertIsNone(result["tag"])
        self.assertTrue(any("タグ" in w for w in result["warnings"]))
        self.assertEqual(git(self.market, "rev-parse", "HEAD").strip(), result["commit"])
        self.assertFalse(os.path.exists(self.work))

    def test_REQ_059_the_tag_is_made_without_waiting_even_when_tags_are_set_to_be_signed(self):
        git(self.market, "config", "tag.gpgSign", "true")
        with mock.patch.dict(os.environ, {"GIT_EDITOR": "false"}):   # 説明の入力を待つと、ここで失敗する
            result = scaffold.commit_change(self.plugin, self.MESSAGE, self.work)
        self.assertEqual((result["tag"], result["warnings"]), ("plugin-creator-generated-weekly-report", []))
        self.assertEqual(git(self.market, "cat-file", "-t", result["tag"]).strip(), "commit", "署名つきでない軽いタグ")

    def test_REQ_059_a_tag_step_that_does_not_end_leaves_the_commit_and_removes_the_temporary_folder(self):
        real_git = scaffold.git

        def stuck(args, cwd):
            if scaffold.git_verb(args) == "tag":
                raise scaffold.Refusal("git の処理（git tag）が120秒で終わりませんでした。")
            return real_git(args, cwd)

        with mock.patch.object(scaffold, "git", side_effect=stuck):
            result = scaffold.commit_change(self.plugin, self.MESSAGE, self.work)
        self.assertEqual((result["ok"], result["tag"]), (True, None))
        self.assertMentions(result["warnings"], "タグ", "120秒", "コミットは残っています")
        self.assertEqual(git(self.market, "rev-parse", "HEAD").strip(), result["commit"])
        self.assertTrue(result["work_folder_removed"])
        self.assertFalse(os.path.exists(self.work))

    def test_REQ_059_the_work_option_must_be_the_temporary_folder(self):
        with self.assertRaises(scaffold.Refusal):
            scaffold.commit_change(self.plugin, self.MESSAGE, self.folder)
        self.assertTrue(os.path.isdir(self.folder))


class CommitAtTheRoot(Base):
    def test_REQ_059_a_plugin_at_the_root_of_its_repository_moves_the_plain_tag(self):
        git(self.plugin, "tag", "plugin-creator-generated")
        self.extract()
        self.save(self.make_state())
        self.change()
        result = scaffold.commit_change(self.plugin, "plugin-creator: weekly-report を直した（0.1.0 → 0.2.0）", self.work)
        self.assertEqual(result["tag"], "plugin-creator-generated")
        self.assertEqual(git(self.plugin, "rev-parse", "plugin-creator-generated^{commit}"), git(self.plugin, "rev-parse", "HEAD"))

    def test_REQ_059_tag_names_follow_the_place_of_the_plugin(self):
        self.assertEqual(scaffold.tag_name("", "a"), "plugin-creator-generated")
        self.assertEqual(scaffold.tag_name("plugins/a/", "a"), "plugin-creator-generated-a")


# ---------------------------------------------------------------- check-base の試験の土台（BLUEPRINT D20）

class TestsBase(Base):
    """試験の土台（tests/run.py、tests/stage1/、tests/stage2/adapter・core・ui、tests/stage2/fake-*.mjs）も比べる。"""

    TESTS = {"tests/run.py": "# 入口\n", "tests/stage1/check.py": "# 1段目\n", "tests/stage2/core/a.test.mjs": "// core\n",
             "tests/stage2/ui/b.test.mjs": "// ui\n", "tests/stage2/adapter/c.test.mjs": "// adapter\n", "tests/stage2/fake-clock.mjs": "// 時計\n"}

    def make_template(self):
        dest = super().make_template()
        for rel, text in self.TESTS.items():
            write(os.path.join(dest, *rel.split("/")), text)
        return dest

    def test_REQ_059_test_base_files_that_differ_or_are_missing_are_found_and_restored(self):
        self.assertTrue(scaffold.check_base(self.plugin, template=self.template)["ok"])
        write(self.at("tests/stage1/check.py"), "# 書き換えて通した\n")
        os.remove(self.at("tests/run.py"))
        write(self.at("tests/stage2/core/task-own.test.mjs"), "// 作業ごとに足した試験\n")
        write(self.at("tests/stage2/task/test_x.py"), "x")
        result = scaffold.check_base(self.plugin, template=self.template)
        self.assertEqual({(d["file"], d["kind"]) for d in result["differences"]},
                         {("tests/stage1/check.py", "changed"), ("tests/run.py", "missing")})
        result = scaffold.check_base(self.plugin, restore=True, template=self.template)
        self.assertTrue(result["ok"])
        self.assertEqual(read(self.at("tests/stage1/check.py")), self.TESTS["tests/stage1/check.py"])
        self.assertTrue(os.path.isfile(self.at("tests/stage2/core/task-own.test.mjs")))

    def test_REQ_057_an_extra_file_in_a_test_base_folder_is_kept_and_shown(self):
        write(self.at("tests/stage2/core/own.test.mjs"), "// 作業ごとの試験\n")
        self.commit_all()
        result = self.extract()
        self.assertTrue(os.path.isfile(self.part("files/tests/stage2/core/own.test.mjs")))
        self.assertMentions(result["warnings"], "tests/stage2/core/own.test.mjs", "作業ごとの試験として残します")
        self.assertEqual(result["base"], {"added": [], "removed": [], "changed": []})

    def test_REQ_059_the_change_brings_the_test_base_up_to_the_template(self):
        write(self.at("tests/stage2/fake-clock.mjs"), "// 古い時計\n")
        self.commit_all()
        result = self.extract()
        self.assertIn("tests/stage2/fake-clock.mjs", [c["file"] for c in result["base"]["changed"]])
        self.save(self.make_state())
        self.change()
        self.assertEqual(read(self.at("tests/stage2/fake-clock.mjs")), "// 時計\n")
        self.assertTrue(scaffold.check_base(self.plugin, template=self.template)["ok"])


# ---------------------------------------------------------------- 入口

class Cli(Base):
    """新しい子コマンドも、標準出力に JSON を1つだけ出し、終了コードは 0 成功・1 断った・2 使い方の誤り。"""

    def run_main(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
                mock.patch.object(scaffold, "DEFAULT_TEMPLATE", self.template):
            code = scaffold.main(list(argv))
        return code, json.loads(out.getvalue())

    def test_creator_structure_3_4_each_new_command_prints_one_json_document(self):
        code, data = self.run_main("change-check", "--plugin", self.plugin, "--cwd", self.folder)
        self.assertEqual((code, data["ok"], data["generated"]), (0, True, True))
        code, data = self.run_main("extract", "--plugin", self.plugin, "--work", self.work)
        self.assertEqual((code, data["ok"]), (0, True))
        self.save(self.make_state())
        code, data = self.run_main("change", "--hearing", self.hearing, "--work", self.work, "--plugin", self.plugin)
        self.assertEqual((code, data["ok"], data["changed"]), (0, True, ["plugin.json"]))
        write(self.at("x.txt"), "x")
        code, data = self.run_main("change-guard", "--plugin", self.plugin, "--work", self.work)
        self.assertEqual((code, data["ok"], data["unexpected"]), (1, False, ["x.txt"]))
        code, data = self.run_main("change-guard", "--plugin", self.plugin, "--work", self.work, "--restore")
        self.assertEqual((code, data["ok"]), (0, True))
        code, data = self.run_main("commit", "--plugin", self.plugin, "--message", "直した", "--work", self.work)
        self.assertEqual((code, data["ok"], data["tag"]), (0, True, "plugin-creator-generated"))

    def test_creator_structure_3_4_a_refusal_exits_with_one(self):
        elsewhere = os.path.join(self.root, "elsewhere")
        os.makedirs(elsewhere)
        code, data = self.run_main("change-check", "--plugin", self.plugin, "--cwd", elsewhere)
        self.assertEqual((code, data["ok"]), (1, False))
        self.assertMentions(data["problems"], "外にあります")

    def test_creator_structure_3_4_a_wrong_usage_exits_with_two(self):
        for argv in (["change-check", "--plugin", self.plugin], ["commit", "--plugin", self.plugin], ["extract"]):
            with self.subTest(argv=argv), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
                scaffold.main(argv)
            self.assertEqual(caught.exception.code, 2)

    def test_creator_structure_3_4_the_script_runs_alone_with_isolated_python(self):
        done = subprocess.run([sys.executable, "-I", SCRIPT, "change-check", "--plugin", os.path.join(self.root, "nothing"), "--cwd", self.root],
                              capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(done.returncode, 1)
        self.assertFalse(json.loads(done.stdout)["ok"])
        done = subprocess.run([sys.executable, "-I", SCRIPT, "--help"], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(done.returncode, 0)
        for command in ("change-check", "extract", "change", "change-guard", "commit"):
            self.assertIn(command, done.stdout)


# ---------------------------------------------------------------- 本物のひな形

class RealTemplate(Base):
    """本物のひな形：見本を組み立て、決まりを1つ足し、1つ直し、課題を1つ足して直すと、1段目の構造の検査に通る。"""

    def make_template(self):
        dest = os.path.join(self.root, "template")
        shutil.copytree(REAL_TEMPLATE, dest, ignore=scaffold.make_ignore(REAL_TEMPLATE))
        return dest

    def run_checks(self):
        checks = load_module("plugin_creator_template_check_structure_change", os.path.join(self.template, "tests", "stage1", "check_structure.py"))
        report = checks.run_checks(self.plugin, "generated")
        return ["[%s] %s" % (c.id, m) for c in report.checks for m in c.errors]

    @unittest.skipUnless(have_checks(), "PyYAML と jsonschema がない")
    def test_REQ_057_the_redrawn_preview_passes_stage_one_and_a_broken_one_is_reported(self):
        result = self.extract()
        self.assertEqual(result["stage1"], [])
        self.assertEqual(result["base"], {"added": [], "removed": [], "changed": []})
        write(self.at("tests/knowledge.json"), json.dumps(load(self.at("tests/knowledge.json")) + [
            {"id": "K-09", "kind": "other", "item": "決まった書き方やルール", "text": "どこにも書かれていない決まり。"}], ensure_ascii=False, indent=2) + "\n")
        self.commit_all()
        result = self.extract()
        self.assertTrue(any("K-09" in s for s in result["stage1"]), result["stage1"])

    @unittest.skipUnless(have_checks(), "PyYAML と jsonschema がない")
    def test_REQ_058_a_changed_plugin_passes_stage_one(self):
        self.full_change()
        self.change()
        self.assertEqual(self.run_checks(), [])
        self.assertTrue(scaffold.check_base(self.plugin, template=self.template)["ok"])


# ---------------------------------------------------------------- 本物の題材（embedded-debug-loop）

@unittest.skipUnless(os.path.isfile(MARKET), "本物の題材（tests/dev-eval/fixtures/market.tar.gz）がない")
class RealMaterial(unittest.TestCase):
    """plugin-market-place の embedded-debug-loop を、今のひな形で直す（統合の試験）。"""

    NAME = "embedded-debug-loop"

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="c2-market-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        env = mock.patch.dict(os.environ, {"COPILOT_HOME": os.path.join(self.root, "copilot-home"),
                                           "COPILOT_CACHE_HOME": os.path.join(self.root, "cache")})
        env.start()
        self.addCleanup(env.stop)
        self.cwd = os.path.join(self.root, "work")
        self.market = os.path.join(self.cwd, "market")
        os.makedirs(self.market)
        with tarfile.open(MARKET) as archive:
            try:
                archive.extractall(self.market, filter="data")
            except TypeError:   # filter のない古い Python
                archive.extractall(self.market)
        git(self.market, "init", "-q")
        git(self.market, "add", "-A")
        git(self.market, "commit", "-q", "-m", "init")
        self.plugin = os.path.join(self.market, "plugins", self.NAME)
        self.hearing = os.path.join(self.root, "copilot-home", "plugin-data", "plugin-creator", "hearings", "s1", "state.json")

    def at(self, rel):
        return os.path.join(self.plugin, *rel.split("/"))

    def prepare(self, work):
        """記録と parts を手で作る：K-15 を K-18 に直し、決まり K-19 を足し、課題を1つ足す。
        作業エージェントの代わりに、extract の1段目の結果の直しもする（エージェントの本文のプラグインのファイルの場所を、
        ${PLUGIN_ROOT} や相対パスでなく <プラグインのフォルダ>/… で書く。D38）。"""
        parts = os.path.join(work, "parts")
        for directory, _dirs, names in os.walk(parts):
            for n in names:
                path = os.path.join(directory, n)
                if not n.endswith((".md", ".json")) or "/inputs/" in path.replace(os.sep, "/"):
                    continue
                text = read(path)
                new = text.replace("K-15", "K-18").replace("${PLUGIN_ROOT}", "<プラグインのフォルダ>")
                if os.path.basename(directory) == "slots" and n.startswith(("orchestrator-", "verifier-", "worker-")):
                    new = re.sub(r"(?<![A-Za-z0-9_./<>-])(skills/[A-Za-z0-9][A-Za-z0-9_.-]*/|scripts/)", r"<プラグインのフォルダ>/\1", new)
                if new != text:
                    write(path, new)
        rule = os.path.join(parts, "files", "skills", "deploy-rules", "SKILL.md")
        write(rule, read(rule) + "\n- 送る前に、機器の版を確かめる（K-19）。\n")
        t01 = load(self.at("tests/eval/T-01/eval.json"))
        dump(os.path.join(parts, "files", "tests", "eval", "T-02", "eval.json"),
             {"id": "T-02", "prompt": "取り込んだルールのとおりに、ビルドして機器に送ってください。", "inputs": [],
              "settings": t01["settings"], "criteria": [{"knowledge": "K-07", "grading": "model"}]})
        original = load(self.at("tests/knowledge.json"))
        rows = []
        for r in original:
            if r["id"] == "K-15":
                continue
            rows.append(row(r["id"], r["kind"], r["item"], r["text"], source="existing_plugin", carried=True))
        rows.append(row("K-18", "other", "いつもと違うとき", "デプロイできない・ログが取れないときは、機器を1回再起動してやり直し、それでもだめなら人に伝える。",
                        replaces="K-15"))
        rows.append(row("K-19", "other", "決まった書き方やルール", "送る前に、機器の版を確かめる。"))
        task = load(self.at("com.github.copilot/extensions/%s/task.json" % self.NAME))
        by_id = {c["id"]: c["knowledge"] for c in task["criteria"]}
        tasks = [{"prompt": t01["prompt"], "inputs": [{"path": "tests/eval/T-01/" + i, "provisional": True} for i in t01["inputs"]],
                  "criteria": [by_id[c["id"]] for c in t01["criteria"]], "settings": t01["settings"]},
                 {"prompt": "取り込んだルールのとおりに、ビルドして機器に送ってください。", "inputs": [], "criteria": ["K-07"], "settings": t01["settings"]}]
        state = {"schemaVersion": 1, "stage": "generate", "approvedAt": "2026-10-26T02:00:00Z", "knowledge": rows, "assets": [],
                 "change": {"folder": os.path.realpath(self.plugin), "name": self.NAME, "version": "0.1.0", "generated": True,
                            "carried": [r["id"] for r in original], "removed": []},
                 "confirmation": {"version": "0.2.0", "evalTasks": tasks,
                                  "criteria": criteria_rows(rows, {c["knowledge"]: c["id"] for c in task["criteria"]})}}
        dump(self.hearing, state)

    def stage_one(self):
        empty = os.path.join(self.root, "no-stage2")
        os.makedirs(empty, exist_ok=True)
        done = subprocess.run([sys.executable, self.at("tests/run.py"), "--json", "--stage2-dir", empty,
                               "--results", os.path.join(self.root, "results.json")], capture_output=True, text=True, encoding="utf-8")
        return done

    def test_REQ_061_embedded_debug_loop_is_changed_with_the_current_template(self):
        checked = scaffold.change_check(self.plugin, self.cwd)
        self.assertEqual((checked["generated"], checked["tag"]), (True, "plugin-creator-generated-%s" % self.NAME))
        work = os.path.join(self.cwd, scaffold.WORK_NAME)
        result = scaffold.extract(self.plugin, work)
        self.assertEqual(len(result["slots"]), 10)
        self.assertEqual(set(result["slots"].values()), {"found"})
        if have_checks():   # 今のひな形の1段目は、エージェントの本文の ${PLUGIN_ROOT} を落とす（D38）
            self.assertTrue(any("${PLUGIN_ROOT}" in s and "worker.agent.md" in s for s in result["stage1"]), result["stage1"])
        self.prepare(work)
        changed = scaffold.change(self.hearing, work, self.plugin)
        self.assertEqual(changed["knowledge"]["replaced"], [{"from": "K-15", "to": "K-18"}])
        done = subprocess.run([sys.executable, self.at("tests/stage1/check_structure.py"), self.plugin],
                              capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        committed = scaffold.commit_change(self.plugin, "plugin-creator: %s を直した（0.1.0 → 0.2.0）" % self.NAME, work)
        self.assertEqual(committed["tag"], "plugin-creator-generated-%s" % self.NAME)
        self.assertEqual(git(self.market, "rev-parse", committed["tag"] + "^{commit}"), git(self.market, "rev-parse", "HEAD"))

    def test_REQ_059_embedded_debug_loop_is_changed_from_inside_its_own_folder(self):
        work = os.path.join(self.plugin, scaffold.WORK_NAME)
        self.assertTrue(scaffold.change_check(self.plugin, self.plugin)["ok"])
        scaffold.extract(self.plugin, work)
        self.prepare(work)
        scaffold.change(self.hearing, work, self.plugin)
        done = self.stage_one()
        report = json.loads(done.stdout)
        stage1 = [s for s in report.get("stages", []) if s.get("id") == "stage1"]
        self.assertTrue(stage1, done.stdout)
        self.assertEqual(stage1[0]["status"], "passed", done.stdout)
        committed = scaffold.commit_change(self.plugin, "plugin-creator: %s を直した（0.1.0 → 0.2.0）" % self.NAME, work)
        self.assertNotIn(scaffold.WORK_NAME, git(self.market, "show", "--name-only", "--format=", committed["commit"]))
        self.assertFalse(os.path.exists(work))


if __name__ == "__main__":
    unittest.main()
