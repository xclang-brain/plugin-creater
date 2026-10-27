"""クリエイター自身の1段目（check_creator.py）の試験。

小さなクリエイターの見本を一時フォルダに作り、わざと壊して、正しく不合格になるかを見る。
動かし方（リポジトリの根で）:  python3 -m unittest discover -s tests/creator -p "test_*.py"
トークンの数え方 tiktoken は、初めて使うときにエンコーディングのファイルをネットワークから取る。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import check_creator as cc  # noqa: E402

SKILL_HEAD = "---\nname: make-plugin\ndescription: 作業の自動化を頼まれたときに使う。\n---\n"


def tiktoken_ready():
    try:
        cc.count_tokens("確かめ")
        return True
    except RuntimeError:
        return False


HAS_TIKTOKEN = tiktoken_ready()


class Creator(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.write("plugin.json", json.dumps({
            "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
            "name": "plugin-creator", "version": "0.3.0", "description": "見本"}))
        self.write("skills/make-plugin/SKILL.md", SKILL_HEAD + "# 手順\n\nこの段階の始めに `references/stage1.md` を読む。\n")
        self.write("skills/make-plugin/references/stage1.md", "問いの型\n")
        self.write("examples/weekly-report.md", "# 会話例\n\nAI が演じたユーザーとの会話です。\nplugin-creator の版：0.3.0（2026-10-22）\n")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def path(self, rel):
        return os.path.join(self.root, *rel.split("/"))

    def read(self, rel):
        with open(self.path(rel), encoding="utf-8") as f:
            return f.read()

    def write(self, rel, text):
        os.makedirs(os.path.dirname(self.path(rel)), exist_ok=True)
        with open(self.path(rel), "w", encoding="utf-8") as f:
            f.write(text)

    def checks(self):
        return {c.id: c for c in cc.run_creator_checks(self.root).checks}

    def problems(self, check_id):
        return self.checks()[check_id].errors

    def assertFailsWith(self, check_id, *snippets):
        problems = self.problems(check_id)
        self.assertTrue(problems, "%s が不合格にならなかった" % check_id)
        for snippet in snippets:
            self.assertTrue(any(snippet in p for p in problems), "%r が理由にない: %r" % (snippet, problems))


class Overall(Creator):
    @unittest.skipUnless(HAS_TIKTOKEN, "tiktoken のエンコーディングを使えない")
    def test_REQ_039_good_creator_passes_and_includes_the_template_checks(self):
        report = cc.run_creator_checks(self.root)
        self.assertTrue(report.ok, [c.errors for c in report.checks if c.errors])
        ids = [c.id for c in report.checks]
        self.assertEqual(["manifest", "mcp", "skills", "references", "agents", "layout", "symlinks", "skill-size", "examples-version"], ids)
        self.assertEqual("creator", report.kind)

    def test_REQ_004_official_checks_of_the_template_apply_to_the_creator(self):
        self.write("skills/make-plugin/SKILL.md", SKILL_HEAD.replace("name: make-plugin", "name: other") + "本文\n")
        self.assertFailsWith("skills", "フォルダの名前")

    def test_REQ_004_creator_is_not_asked_for_generated_plugin_parts(self):
        self.assertNotIn("task", self.checks())
        self.assertNotIn("trace", self.checks())

    @unittest.skipUnless(HAS_TIKTOKEN, "tiktoken のエンコーディングを使えない")
    def test_REQ_042_cli_exit_code_and_json(self):
        script = os.path.join(HERE, "check_creator.py")
        ok = subprocess.run([sys.executable, "-I", script, self.root, "--json"], capture_output=True)
        self.assertEqual(0, ok.returncode, ok.stdout.decode("utf-8"))
        self.assertEqual("creator", json.loads(ok.stdout.decode("utf-8"))["kind"])
        os.remove(self.path("examples/weekly-report.md"))
        ng = subprocess.run([sys.executable, "-I", script, self.root], capture_output=True)
        self.assertEqual(1, ng.returncode)
        self.assertIn("会話例がない", ng.stdout.decode("utf-8"))

    def test_REQ_042_unknown_folder_is_a_usage_error(self):
        proc = subprocess.run([sys.executable, "-I", os.path.join(HERE, "check_creator.py"), os.path.join(self.root, "nothing")], capture_output=True)
        self.assertEqual(2, proc.returncode)


class SkillSize(Creator):
    def skill(self, body):
        self.write("skills/make-plugin/SKILL.md", SKILL_HEAD + body)

    def test_missing_skill_fails(self):
        os.remove(self.path("skills/make-plugin/SKILL.md"))
        self.assertFailsWith("skill-size", "SKILL.md がない")

    @unittest.skipUnless(HAS_TIKTOKEN, "tiktoken のエンコーディングを使えない")
    def test_500_lines_pass_and_501_lines_fail(self):
        self.skill("行\n" * 500)
        self.assertEqual([], self.problems("skill-size"))
        self.skill("行\n" * 501)
        self.assertFailsWith("skill-size", "501 行")

    @unittest.skipUnless(HAS_TIKTOKEN, "tiktoken のエンコーディングを使えない")
    def test_frontmatter_lines_are_not_counted(self):
        self.write("skills/make-plugin/SKILL.md", SKILL_HEAD + "行\n" * 500)
        self.assertEqual([], self.problems("skill-size"))

    @unittest.skipUnless(HAS_TIKTOKEN, "tiktoken のエンコーディングを使えない")
    def test_5000_tokens_pass_and_more_fail(self):
        one_line_of = lambda n: "hello" + " hello" * (n - 1)   # o200k_base では1語が1トークン
        self.assertEqual(5000, cc.count_tokens(one_line_of(5000)))
        self.skill(one_line_of(5000))
        self.assertEqual([], self.problems("skill-size"))
        self.skill(one_line_of(5001))
        self.assertFailsWith("skill-size", "5001 トークン", "o200k_base")

    @unittest.skipUnless(HAS_TIKTOKEN, "tiktoken のエンコーディングを使えない")
    def test_every_skill_is_measured_and_named_in_the_reason(self):
        self.write("skills/change-plugin/SKILL.md", SKILL_HEAD.replace("make-plugin", "change-plugin") + "行\n" * 501)
        problems = self.problems("skill-size")
        self.assertEqual(1, len(problems), problems)
        self.assertIn("change-plugin の SKILL.md", problems[0])
        self.assertIn("501 行", problems[0])
        one_line_of = lambda n: "hello" + " hello" * (n - 1)
        self.write("skills/test-plugin/SKILL.md", SKILL_HEAD.replace("make-plugin", "test-plugin") + one_line_of(5001))
        self.assertFailsWith("skill-size", "test-plugin の SKILL.md", "5001 トークン")

    @unittest.skipUnless(HAS_TIKTOKEN, "tiktoken のエンコーディングを使えない")
    def test_other_skills_within_the_limits_pass(self):
        self.write("skills/change-plugin/SKILL.md", SKILL_HEAD.replace("make-plugin", "change-plugin") + "行\n" * 500)
        self.assertEqual([], self.problems("skill-size"))

    @unittest.skipUnless(HAS_TIKTOKEN, "tiktoken のエンコーディングを使えない")
    def test_make_plugin_is_still_required_when_other_skills_exist(self):
        self.write("skills/change-plugin/SKILL.md", SKILL_HEAD.replace("make-plugin", "change-plugin") + "本文\n")
        os.remove(self.path("skills/make-plugin/SKILL.md"))
        self.assertFailsWith("skill-size", "skills/make-plugin/SKILL.md がない")

    @unittest.skipUnless(HAS_TIKTOKEN, "tiktoken のエンコーディングを使えない")
    def test_the_skills_of_this_repository_fit(self):
        report = cc.run_creator_checks(cc.REPO)
        size = {c.id: c for c in report.checks}["skill-size"]
        self.assertEqual([], size.errors)

    @unittest.skipUnless(HAS_TIKTOKEN, "tiktoken のエンコーディングを使えない")
    def test_text_that_looks_like_a_special_token_can_be_counted(self):
        self.skill("<|endoftext|> を書いても数えられる\n")
        self.assertEqual([], self.problems("skill-size"))

    def test_when_the_encoding_cannot_be_fetched_it_fails_with_a_clear_reason(self):
        import tiktoken
        original = tiktoken.get_encoding

        def broken(name):
            raise ConnectionError("ネットワークに出られない")
        tiktoken.get_encoding = broken
        try:
            self.assertFailsWith("skill-size", "o200k_base", "取れなかった", "ConnectionError", "TIKTOKEN_CACHE_DIR")
        finally:
            tiktoken.get_encoding = original

    def test_when_tiktoken_is_missing_it_fails_and_says_how_to_install(self):
        saved = sys.modules.get("tiktoken")
        sys.modules["tiktoken"] = None   # import tiktoken が ImportError になる
        try:
            self.assertFailsWith("skill-size", "tiktoken が入っていない", "pip install tiktoken")
        finally:
            if saved is None:
                del sys.modules["tiktoken"]
            else:
                sys.modules["tiktoken"] = saved


class References(Creator):
    def test_reference_of_20kb_or_more_fails_through_the_template_check(self):
        self.write("skills/make-plugin/references/stage1.md", "あ" * 7000)   # 21000 バイト
        self.assertFailsWith("references", "skills/make-plugin/references/stage1.md", "20KB 未満")

    def test_reference_must_be_named_in_the_skill_body(self):
        self.write("skills/make-plugin/references/stage2.md", "x")
        self.assertFailsWith("references", "stage2.md", "名指ししていない")


class ExamplesVersion(Creator):
    def test_REQ_037_missing_examples_fail_and_say_the_current_version(self):
        shutil.rmtree(self.path("examples"))
        self.assertFailsWith("examples-version", "会話例がない", "0.3.0")

    def test_REQ_037_folder_without_markdown_fails(self):
        os.remove(self.path("examples/weekly-report.md"))
        self.write("examples/note.txt", "x")
        self.assertFailsWith("examples-version", "会話例がない")

    def test_REQ_037_same_version_passes(self):
        self.assertEqual([], self.problems("examples-version"))

    def test_REQ_037_old_version_fails_and_names_the_file(self):
        self.write("examples/weekly-report.md", "plugin-creator の版：0.2.0\n")
        self.assertFailsWith("examples-version", "examples/weekly-report.md", "0.2.0", "0.3.0", "作り直す")

    def test_REQ_037_every_example_is_checked(self):
        self.write("examples/second.md", "plugin-creator の版：0.1.0\n")
        problems = self.problems("examples-version")
        self.assertEqual(1, len(problems), problems)
        self.assertIn("second.md", problems[0])

    def test_REQ_037_version_label_is_required(self):
        self.write("examples/weekly-report.md", "# 会話例\n\n0.3.0 のときの会話\n")
        self.assertFailsWith("examples-version", "plugin-creator の版：x.y.z")

    def test_REQ_037_the_old_label_is_not_accepted(self):
        # 会話例はエンドユーザーが読むので、画面と同じ「plugin-creator」の呼び方にそろえた。「クリエイターの版」の書き方は受けない
        self.write("examples/weekly-report.md", "# 会話例\n\nクリエイターの版：0.3.0\n")
        self.assertFailsWith("examples-version", "plugin-creator の版：x.y.z")

    def test_REQ_037_label_variants(self):
        for line in ("plugin-creator の版: 0.3.0", "plugin-creator の版：`0.3.0`", "plugin-creator の版：v0.3.0 / 2026-10-22"):
            self.write("examples/weekly-report.md", "# 会話例\n\n%s\n" % line)
            self.assertEqual([], self.problems("examples-version"), line)

    def test_REQ_037_a_longer_version_is_not_mistaken_for_the_same(self):
        self.write("examples/weekly-report.md", "plugin-creator の版：0.3.0-beta.1\n")
        self.assertFailsWith("examples-version", "0.3.0-beta.1")

    def test_REQ_037_version_must_be_in_the_first_lines(self):
        self.write("examples/weekly-report.md", "行\n" * 40 + "plugin-creator の版：0.3.0\n")
        self.assertFailsWith("examples-version", "冒頭 30 行")

    def test_REQ_037_nested_examples_are_checked_too(self):
        self.write("examples/sub/deep.md", "plugin-creator の版：0.0.1\n")
        self.assertFailsWith("examples-version", "examples/sub/deep.md")

    def test_REQ_037_plugin_json_without_version_fails(self):
        manifest = json.loads(self.read("plugin.json"))
        del manifest["version"]
        self.write("plugin.json", json.dumps(manifest))
        self.assertFailsWith("examples-version", "version が読めない")


if __name__ == "__main__":
    unittest.main()
