"""組み立てのスクリプト（skills/make-plugin/scripts/scaffold.py）の試験。

見本のヒアリングの記録（sample/state.json）と、見本の作業エージェントが書いた部分（sample/parts/）で組み立てる。
試験の名前に、確かめる要件の番号を入れる。

  - 差し込み口の働きは、小さなひな形（fixture-template/）で確かめる。本物のひな形の中身には依らない。
  - 本物のひな形（template/）では、組み立てたものが 1段目の構造の検査（kind=generated）に
    通ることを見る。本物のひな形にまだない部品（B2 が作る作業・検証のエージェントの定義）は、
    試験の中で仮のファイルで補う。補った部品は試験の出力（標準エラー）に出る。

動かし方（リポジトリの根で）:
    python3 -m unittest discover -s tests/creator/scaffold -p "test_*.py"
PyYAML と jsonschema があると、YAML と task.json の形も確かめる（なければ、その試験は飛ばす）。
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
import tempfile
import unittest
from unittest import mock

try:
    import yaml
except ImportError:   # PyYAML がない環境では、YAML を読む試験を飛ばす
    yaml = None

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
SCRIPT = os.path.join(REPO, "skills", "make-plugin", "scripts", "scaffold.py")
REAL_TEMPLATE = os.path.join(REPO, "template")
CHECK_STRUCTURE = os.path.join(REAL_TEMPLATE, "tests", "stage1", "check_structure.py")
SAMPLE = os.path.join(HERE, "sample")
FIXTURE = os.path.join(HERE, "fixture-template")
SCHEMA_REL = ("com.github.copilot", "extensions", "_plugin_", "core", "task.schema.json")
TODAY = "2026-10-23"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


scaffold = load_module("plugin_creator_scaffold", SCRIPT)


def have_checks():
    try:
        import jsonschema  # noqa: F401
        return yaml is not None
    except ImportError:
        return False


def frontmatter(text):
    """先頭の --- と --- の間を YAML として読む。"""
    parts = text.split("---\n", 2)
    return yaml.safe_load(parts[1])


class Base(unittest.TestCase):
    """作業フォルダ、ヒアリングの記録、parts を一時フォルダに用意する。"""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="c2-scaffold-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.folder = os.path.join(self.root, "folder")                     # 作業フォルダ
        self.work = os.path.join(self.folder, scaffold.WORK_NAME)           # 作業用の一時フォルダ
        shutil.copytree(os.path.join(SAMPLE, "parts"), os.path.join(self.work, "parts"))
        self.state = os.path.join(self.root, "hearing", "state.json")
        os.makedirs(os.path.dirname(self.state))
        shutil.copy(os.path.join(SAMPLE, "state.json"), self.state)
        self.out = os.path.join(self.folder, "weekly-report")
        self.template = self.make_template()

    def make_template(self):
        dest = os.path.join(self.root, "template")
        shutil.copytree(FIXTURE, dest)
        shutil.copy(os.path.join(REAL_TEMPLATE, *SCHEMA_REL), os.path.join(dest, *SCHEMA_REL))
        return dest

    # ---- 道具
    def part(self, rel):
        return os.path.join(self.work, "parts", *rel.split("/"))

    def tmpl(self, rel):
        return os.path.join(self.template, *rel.split("/"))

    def at(self, rel):
        return os.path.join(self.out, *rel.split("/"))

    def read(self, rel):
        with open(self.at(rel), encoding="utf-8") as f:
            return f.read()

    def read_bytes(self, rel):
        with open(self.at(rel), "rb") as f:
            return f.read()

    def json(self, rel):
        return json.loads(self.read(rel))

    def write(self, path, text):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(text)

    def edit_json(self, path, change):
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        change(data)
        self.write(path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")

    def edit_state(self, change):
        self.edit_json(self.state, change)

    def edit_manifest(self, change):
        self.edit_json(self.part("manifest.json"), change)

    def edit_task(self, change):
        self.edit_json(self.part("task.json"), change)

    def edit_eval(self, change):
        self.edit_json(self.part("files/tests/eval/T-01/eval.json"), change)

    def edit_confirmed(self, change, index=0):
        """ユーザーが生成前の確認で確かめた課題（ヒアリングの記録の confirmation.evalTasks）を直す。"""
        self.edit_state(lambda s: change(s["confirmation"]["evalTasks"][index]))

    def append(self, path, text):
        with open(path, "a", encoding="utf-8", newline="") as f:
            f.write(text)

    def build(self, **kw):
        kw.setdefault("template", self.template)
        kw.setdefault("today", TODAY)
        return scaffold.build(self.state, self.work, self.out, **kw)

    def refusal(self, keep_out=False, **kw):
        """断られることを確かめ、問題の文の一覧を返す。作ったフォルダが残らず、作業用の一時フォルダが残ることも確かめる。"""
        with self.assertRaises(scaffold.Refusal) as caught:
            self.build(**kw)
        if not keep_out:
            self.assertFalse(os.path.lexists(self.out), "断ったのに、出力先のフォルダが残っている")
        self.assertTrue(os.path.isdir(self.work), "作業用の一時フォルダが消えている（直して作り直せなくなる）")
        return caught.exception.problems

    def assertMentions(self, problems, *words):
        text = "\n".join(problems)
        for word in words:
            self.assertIn(word, text)

    def git(self, *args):
        done = subprocess.run(["git", "-C", self.out] + list(args), capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(done.returncode, 0, done.stderr)
        return done.stdout

    def two_workers(self):
        """作業エージェントを2体にする（worker と worker-summary）。"""
        self.edit_manifest(lambda m: m["workers"].append({"agent": "worker-summary", "label": "まとめる係"}))
        self.edit_task(lambda t: t["workers"].append({"agent": "worker-summary", "label": "まとめる係"}))
        self.write(self.part("slots/worker-task.worker-summary.md"), "### まとめ方\n\n- 3行にまとめる。\n")


class Gate(Base):
    """生成前の確認の関門（REQ-020）。"""

    def test_REQ_020_refuses_while_the_stage_is_not_generate(self):
        self.edit_state(lambda s: s.update(stage="confirm"))
        problems = self.refusal()
        self.assertMentions(problems, "段階が「生成」ではありません", "confirm")

    def test_REQ_020_refuses_without_the_approval_time(self):
        for value in (None, "", "  "):
            with self.subTest(value=value):
                self.edit_state(lambda s: s.update(approvedAt=value))
                self.assertMentions(self.refusal(), "承認の時刻")

    def test_REQ_020_refuses_a_missing_or_broken_record(self):
        os.remove(self.state)
        self.assertMentions(self.refusal(), "がありません")
        self.write(self.state, "{ 壊れている")
        self.assertMentions(self.refusal(), "JSON として読めません")
        self.write(self.state, "[]")
        self.assertMentions(self.refusal(), "形が違います")


    def test_REQ_020_refuses_without_what_the_user_was_shown(self):
        for value in (None, [], "x"):
            with self.subTest(value=value):
                self.edit_state(lambda s: s.update(confirmation=value))
                self.assertMentions(self.refusal(), "confirmation", "生成前の確認")

    def test_REQ_038_refuses_a_record_without_the_confirmed_eval_tasks(self):
        for value in (None, [], "x"):
            with self.subTest(value=value):
                self.setUp()
                self.edit_state(lambda s: s["confirmation"].update(evalTasks=value))
                self.assertMentions(self.refusal(), "confirmation.evalTasks")
        self.setUp()
        self.edit_state(lambda s: s["confirmation"]["evalTasks"].append({"inputs": []}))
        self.assertMentions(self.refusal(), "頼むときの言葉（prompt）がありません")


class Place(Base):
    """作る場所（REQ-021）と、作り直しでも新しいフォルダ（REQ-036）。"""

    def test_REQ_036_refuses_an_existing_folder_and_leaves_it_untouched(self):
        self.write(os.path.join(self.out, "元のファイル.txt"), "元の中身")
        problems = self.refusal(keep_out=True)
        self.assertMentions(problems, "すでにあります", "別のフォルダの名前")
        self.assertEqual(os.listdir(self.out), ["元のファイル.txt"])
        with open(os.path.join(self.out, "元のファイル.txt"), encoding="utf-8") as f:
            self.assertEqual(f.read(), "元の中身")

    def test_REQ_021_refuses_a_folder_outside_the_work_folder(self):
        outside = os.path.join(self.root, "outside")
        os.makedirs(outside)
        self.out = os.path.join(outside, "weekly-report")
        self.assertMentions(self.refusal(), "作業フォルダ", "の中にありません")
        self.assertEqual(os.listdir(outside), [])

    def test_REQ_021_refuses_a_folder_that_reaches_outside_through_a_symlink(self):
        elsewhere = os.path.join(self.root, "elsewhere")
        os.makedirs(elsewhere)
        try:
            os.symlink(elsewhere, os.path.join(self.folder, "link"))
        except (OSError, NotImplementedError):
            self.skipTest("シンボリックリンクを作れない環境")
        self.out = os.path.join(self.folder, "link", "weekly-report")
        self.assertMentions(self.refusal(), "の中にありません")
        self.assertEqual(os.listdir(elsewhere), [])

    def test_REQ_021_refuses_a_folder_inside_the_temporary_folder(self):
        self.out = os.path.join(self.work, "weekly-report")
        self.assertMentions(self.refusal(), "一時フォルダ")

    def test_REQ_021_refuses_when_the_parent_of_the_folder_is_missing(self):
        self.out = os.path.join(self.folder, "a", "weekly-report")
        self.assertMentions(self.refusal(), "親のフォルダがありません")

    def test_REQ_021_work_must_be_the_temporary_folder_of_the_work_folder(self):
        moved = os.path.join(self.folder, "work")
        os.rename(self.work, moved)
        with self.assertRaises(scaffold.Refusal) as caught:
            scaffold.build(self.state, moved, self.out, template=self.template, today=TODAY)
        self.assertMentions(caught.exception.problems, scaffold.WORK_NAME)
        self.assertFalse(os.path.lexists(self.out))

    def test_REQ_021_makes_a_git_repository_with_one_commit_and_nothing_else_outside(self):
        before = (sorted(os.listdir(self.root)), sorted(os.listdir(self.folder)))
        result = self.build()
        self.assertTrue(result["ok"])
        self.assertEqual(sorted(os.listdir(self.root)), before[0])                        # 作業フォルダの外は変わらない
        self.assertEqual(sorted(os.listdir(self.folder)), sorted(["weekly-report"]))      # 一時フォルダは消え、新しいフォルダだけが増えた
        self.assertEqual(os.path.realpath(self.git("rev-parse", "--show-toplevel").strip()), os.path.realpath(self.out))
        self.assertEqual(len(self.git("log", "--oneline").splitlines()), 1)
        self.assertEqual(self.git("rev-parse", "HEAD").strip(), result["commit"])
        self.assertEqual(self.git("status", "--porcelain"), "")                           # 全部が最初のコミットに入っている
        self.assertTrue(result["work_folder_removed"])

    def test_REQ_021_the_first_commit_works_without_a_git_identity(self):
        home = os.path.join(self.root, "home")
        os.makedirs(home)
        env = {"HOME": home, "XDG_CONFIG_HOME": home, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull}
        with mock.patch.dict(os.environ, env):
            for name in ("GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"):
                os.environ.pop(name, None)
            self.build()
        self.assertEqual(self.git("log", "-1", "--format=%an <%ae>").strip(), "plugin-creator <plugin-creator@localhost>")

    def test_REQ_021_the_files_of_the_template_that_are_caches_or_tools_are_not_copied(self):
        for rel in ("core/__pycache__/x.pyc", "tests/results/latest.json", "tests/.venv/bin/python"):
            self.write(self.tmpl("com.github.copilot/extensions/_plugin_/" + rel), "x")
        self.write(self.tmpl("tests/results/latest.json"), "{}")
        self.write(self.tmpl("tests/.venv/bin/python"), "x")
        self.write(self.tmpl("tests/node_modules/a/index.js"), "x")
        self.build()
        for rel in ("tests/results", "tests/.venv", "tests/node_modules",
                    "com.github.copilot/extensions/weekly-report/core/__pycache__"):
            self.assertFalse(os.path.exists(self.at(rel)), rel)


class Slots(Base):
    """差し込み口の置き換え（BLUEPRINT 8章、A4 のメモ）。"""

    def test_REQ_001_the_text_of_each_slot_is_put_in_place(self):
        self.build()
        self.assertIn("見出し「今週やったこと」と「来週やること」の2つで構成します", self.read("skills/weekly-report/SKILL.md"))
        self.assertIn("REQ-101 週報の見出し", self.read("docs/specs/requirements.md"))
        self.assertIn("### 8.1 週報の組み立て", self.read("docs/design/design.md"))
        self.assertIn("社外の人の名前は書かない（K-06）", self.read("com.github.copilot/agents/worker.agent.md"))
        self.assertIn("基準ごとに合否を確かめる", self.read("com.github.copilot/agents/verifier.agent.md"))

    def test_REQ_003_a_trace_row_is_put_into_the_table_without_a_blank_line(self):
        self.build()
        lines = self.read("docs/design/design.md").splitlines()
        row = next(i for i, line in enumerate(lines) if line.startswith("| REQ-101 "))
        self.assertTrue(lines[row - 1].startswith("| REQ-001 "))

    def test_REQ_001_an_unfilled_slot_is_refused_with_its_name_and_the_folder_is_removed(self):
        os.remove(self.part("slots/verifier-task.md"))
        problems = self.refusal()
        self.assertMentions(problems, "{{slot:verifier-task}}", "verifier.agent.md", "parts/slots/verifier-task.md")

    def test_REQ_001_every_unfilled_slot_is_listed(self):
        os.remove(self.part("slots/verifier-task.md"))
        os.remove(self.part("slots/task-design.md"))
        self.assertMentions(self.refusal(), "{{slot:verifier-task}}", "{{slot:task-design}}")

    def test_BLUEPRINT_8_a_slot_that_no_file_of_the_template_uses_is_only_a_warning(self):
        self.write(self.part("slots/readme-task.md"), "READMEに足す文")
        result = self.build()
        self.assertTrue(any("readme-task.md" in w for w in result["warnings"]))

    def test_BLUEPRINT_8_an_empty_slot_is_refused(self):
        self.write(self.part("slots/verifier-task.md"), "\n  \n")
        self.assertMentions(self.refusal(), "verifier-task.md", "空")

    def test_BLUEPRINT_8_a_file_in_slots_with_a_wrong_name_is_refused(self):
        self.write(self.part("slots/memo.txt"), "x")
        self.write(self.part("slots/Bad Name.md"), "x")
        self.assertMentions(self.refusal(), "memo.txt", "Bad Name.md", "<差し込み口の名前>.md")

    def test_creator_structure_2_the_text_of_a_slot_keeps_the_indent_of_its_line(self):
        self.append(self.tmpl("README.md"), "\n- 手順：\n  {{slot:rules}}\n")
        self.write(self.part("slots/rules.md"), "一つ目\n\n二つ目\n")
        self.build()
        self.assertTrue(self.read("README.md").endswith("- 手順：\n  一つ目\n\n  二つ目\n"))

    def test_creator_structure_2_a_slot_inside_a_line_is_replaced_in_place(self):
        self.append(self.tmpl("README.md"), "\nこれは{{slot:inline}}です。\n")
        self.write(self.part("slots/inline.md"), "差し込んだ言葉")
        self.build()
        self.assertTrue(self.read("README.md").endswith("これは差し込んだ言葉です。\n"))

    def test_BLUEPRINT_8_values_written_in_a_slot_are_replaced_too(self):
        self.write(self.part("slots/verifier-task.md"), "- {{plugin_name}} の週報を確かめる。\n")
        self.build()
        self.assertIn("- weekly-report の週報を確かめる。", self.read("com.github.copilot/agents/verifier.agent.md"))

    def test_BLUEPRINT_8_a_slot_written_inside_a_slot_is_refused(self):
        self.write(self.part("slots/verifier-task.md"), "{{slot:entry-task}}")
        self.assertMentions(self.refusal(), "{{slot:entry-task}}", "verifier.agent.md")

    def test_BLUEPRINT_2_a_value_that_nobody_knows_is_refused(self):
        self.append(self.tmpl("README.md"), "\n{{foo_bar}}\n")
        self.assertMentions(self.refusal(), "{{foo_bar}}", "README.md", "値が決まっていません")

    def test_generated_plugin_structure_7_a_placeholder_in_a_base_file_is_refused_and_not_replaced(self):
        self.append(self.tmpl("com.github.copilot/extensions/_plugin_/core/index.mjs"), "// {{plugin_name}}\n")
        self.assertMentions(self.refusal(), "土台のファイル", "core/index.mjs")

    def test_BLUEPRINT_2_text_that_only_looks_like_a_placeholder_is_left_alone(self):
        self.append(self.tmpl("README.md"), "\n型は {{ el: Element }} と ${{x}} と ${{secrets.TOKEN}} と {{1}} と { {a} }\n")
        self.build()
        self.assertTrue(self.read("README.md").endswith("型は {{ el: Element }} と ${{x}} と ${{secrets.TOKEN}} と {{1}} と { {a} }\n"))


class SlotHeadings(Base):
    """差し込み口の文の見出し（B2 の依頼）。4つの差し込み口は、ひな形の ## の節の中に入るので、見出しは ### 以下。"""

    SLOTS = ("entry-task", "orchestrator-task", "worker-task.worker", "verifier-task")

    def test_BLUEPRINT_8_a_heading_of_level_one_or_two_is_refused_with_the_slot_and_the_line(self):
        for name in self.SLOTS:
            for heading in ("# 大きな見出し", "## 週報の書き方", "##", "  ## 字下げあり"):
                with self.subTest(slot=name, heading=heading):
                    self.setUp()
                    self.write(self.part("slots/%s.md" % name), "\n本文の1行目\n\n%s\n本文\n" % heading)
                    problems = self.refusal()
                    self.assertMentions(problems, "parts/slots/%s.md" % name, "4 行目", "{{slot:%s}}" % name, "見出しは ### 以下にしてください")

    def test_BLUEPRINT_8_every_heading_is_listed(self):
        self.write(self.part("slots/verifier-task.md"), "# 一つ目\n本文\n## 二つ目\n")
        problems = [p for p in self.refusal() if "verifier-task" in p]
        self.assertEqual(len(problems), 2)
        self.assertMentions(problems, "1 行目", "3 行目")

    def test_BLUEPRINT_8_the_second_worker_slot_is_checked_too(self):
        self.two_workers()
        self.write(self.part("slots/worker-task.worker-summary.md"), "## まとめ方\n")
        self.assertMentions(self.refusal(), "worker-task.worker-summary.md", "1 行目", "見出しは ### 以下にしてください")

    def test_BLUEPRINT_8_level_three_and_below_are_accepted(self):
        for heading in ("### 三つ目", "#### 四つ目", "###### 六つ目"):
            with self.subTest(heading=heading):
                self.setUp()
                self.write(self.part("slots/verifier-task.md"), "%s\n\n本文\n" % heading)
                self.build()
                self.assertIn(heading, self.read("com.github.copilot/agents/verifier.agent.md"))

    def test_BLUEPRINT_8_text_that_only_looks_like_a_heading_is_accepted(self):
        text = "#タグ（空白なし）\n    ## 字下げが深いのでコード\n本文 # の途中\n```text\n# コードの囲みの中\n## ここも\n```\n~~~\n# 別の囲み\n~~~\n"
        self.write(self.part("slots/verifier-task.md"), text)
        self.build()
        self.assertIn("# コードの囲みの中", self.read("com.github.copilot/agents/verifier.agent.md"))

    def test_BLUEPRINT_8_a_heading_after_a_closed_code_fence_is_refused(self):
        self.write(self.part("slots/verifier-task.md"), "```\n# 中\n```\n## 外\n")
        problems = self.refusal()
        self.assertMentions(problems, "4 行目")
        self.assertEqual(len([p for p in problems if "verifier-task" in p]), 1)

    def test_BLUEPRINT_8_the_other_slots_are_not_limited(self):
        self.write(self.part("slots/task-design.md"), "## 8.1 二段の見出し\n\n本文\n")
        self.build()
        self.assertIn("## 8.1 二段の見出し", self.read("docs/design/design.md"))

    def test_BLUEPRINT_8_the_line_number_counts_from_the_first_line_of_the_file(self):
        self.write(self.part("slots/entry-task.md"), "\n\n\n## 先頭に空行がある\n")
        self.assertMentions(self.refusal(), "4 行目")


class Values(Base):
    """決まった値（plugin_name など）の差し込み。JSON と YAML で壊れないこと。"""

    HARD = 'A "quoted": value \\ with # hash, \'single\' と 日本語の説明'

    def test_REQ_004_the_manifest_and_the_marketplace_name_the_plugin(self):
        self.build()
        plugin = self.json("plugin.json")
        self.assertEqual(plugin["$schema"], "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json")
        self.assertEqual((plugin["name"], plugin["version"], plugin["description"]),
                         ("weekly-report", "0.1.0", "毎週の記録から、部長宛ての週報を作るプラグイン。"))
        self.assertNotIn("repository", plugin)   # 公開するまで書かない
        market = self.json(".github/plugin/marketplace.json")
        self.assertEqual(market["name"], "weekly-report")
        self.assertEqual(market["plugins"], [{"name": "weekly-report", "source": "./"}])
        self.assertTrue(market["owner"]["name"])
        self.assertIn("copilot plugin install weekly-report@weekly-report", self.read("README.md"))

    @unittest.skipIf(yaml is None, "PyYAML がない")
    def test_REQ_004_descriptions_with_quotes_colons_and_backslashes_keep_json_and_yaml_valid(self):
        def change(m):
            m["plugin_description"] = self.HARD
            m["entry_skill"]["description"] = self.HARD
        self.edit_manifest(change)
        self.build()
        self.assertEqual(self.json("plugin.json")["description"], self.HARD)
        self.assertEqual(frontmatter(self.read("skills/weekly-report/SKILL.md")), {"name": "weekly-report", "description": self.HARD})
        note = frontmatter(self.read("skills/weekly-report/references/note.md"))
        self.assertEqual(note["quoted"], self.HARD)                          # "…" の中では、中身だけが入る
        self.assertEqual(note["longer"], "前置き " + self.HARD + " 後ろ")      # 二重引用符で囲んだ長い文字の一部でも、壊れない
        self.assertEqual(note["bare"], self.HARD)                            # 値の位置に単独なら、二重引用符つきの文字列になる
        self.assertEqual(note["embedded"], "説明は weekly-report です")        # 名前は、長い文字の一部にそのまま入る
        self.assertIn(self.HARD, self.read("README.md"))                     # 本文はそのまま

    @unittest.skipIf(yaml is None, "PyYAML がない")
    def test_REQ_004_a_name_in_the_value_position_is_written_without_quotes(self):
        self.build()
        self.assertIn("\nbare_name: weekly-report\n", self.read("skills/weekly-report/references/note.md"))

    @unittest.skipIf(yaml is None, "PyYAML がない")
    def test_REQ_004_a_name_that_yaml_would_read_as_a_number_or_a_boolean_is_quoted(self):
        for name in ("2026", "true", "no"):
            with self.subTest(name=name):
                self.setUp()
                self.edit_manifest(lambda m: m.update(plugin_name=name))
                self.build()
                text = self.read("skills/weekly-report/references/note.md")
                self.assertIn('\nbare_name: "%s"\n' % name, text)
                self.assertEqual(frontmatter(text)["bare_name"], name)

    def test_REQ_004_the_entry_skill_folder_takes_the_name_of_the_entry_skill(self):
        self.edit_manifest(lambda m: m["entry_skill"].update(name="make-weekly"))
        self.build()
        self.assertTrue(os.path.isfile(self.at("skills/make-weekly/SKILL.md")))
        self.assertFalse(os.path.exists(self.at("skills/_entry_")))
        self.assertFalse(os.path.exists(self.at("skills/weekly-report")))

    def test_generated_plugin_structure_3_4_the_extension_folder_takes_the_name_of_the_plugin(self):
        self.edit_manifest(lambda m: m.update(plugin_name="monthly-report"))
        self.out = os.path.join(self.folder, "somewhere")
        self.build()
        self.assertTrue(os.path.isfile(self.at("com.github.copilot/extensions/monthly-report/extension.mjs")))
        self.assertFalse(os.path.exists(self.at("com.github.copilot/extensions/_plugin_")))
        self.assertEqual(self.json("plugin.json")["name"], "monthly-report")

    def test_REQ_001_the_generation_date_is_put_into_the_constitution(self):
        self.build()
        self.assertIn("| 1.0.0 | 2026-10-23 |", self.read("docs/constitution.md"))

    def test_REQ_004_a_plugin_named_plugin_creator_is_refused(self):
        self.edit_manifest(lambda m: m.update(plugin_name="plugin-creator"))
        self.assertMentions(self.refusal(), "plugin_name", "plugin-creator", "plugin-creator_open", "別の名前")

    def test_REQ_004_names_that_only_start_with_plugin_creator_are_accepted(self):
        for name in ("plugin-creator-lite", "my-plugin-creator", "plugin-creators"):
            with self.subTest(name=name):
                self.setUp()
                self.edit_manifest(lambda m: m.update(plugin_name=name))
                self.build()
                self.assertEqual(self.json("plugin.json")["name"], name)

    def test_REQ_004_the_manifest_must_follow_the_rules_of_names_and_descriptions(self):
        cases = [
            ("plugin_name", "Weekly_Report"), ("plugin_name", "a--b"), ("plugin_name", "-a"), ("plugin_name", "a" * 65),
            ("plugin_name", 5), ("plugin_description", ""), ("plugin_description", "一行目\n二行目"),
            ("plugin_description", "あ" * 1025),
        ]
        for key, value in cases:
            with self.subTest(key=key, value=str(value)[:20]):
                self.setUp()
                self.edit_manifest(lambda m: m.update({key: value}))
                self.assertMentions(self.refusal(), "parts/manifest.json", key)
        self.setUp()
        self.edit_manifest(lambda m: m["entry_skill"].update(name="Bad Name"))
        self.assertMentions(self.refusal(), "entry_skill.name")
        self.setUp()
        self.edit_manifest(lambda m: m["entry_skill"].update(description=" "))
        self.assertMentions(self.refusal(), "entry_skill.description")

    def test_REQ_004_an_entry_description_that_breaks_the_frontmatter_is_refused(self):
        bad = {
            "---": "手順 --- 手順", "行頭の ---": "---abc", "U+007F": "前\x7f後", "U+0085": "前\x85後", "U+009F": "前\x9f後",
            "U+2028": "前\u2028後", "U+2029": "前\u2029後", "U+FFFE": "前\ufffe後", "U+FFFF": "前\uffff後",
        }
        for name, text in bad.items():
            with self.subTest(char=name):
                self.setUp()
                self.edit_manifest(lambda m: m["entry_skill"].update(description=text))
                problems = self.refusal()
                self.assertMentions(problems, "entry_skill.description", "--- や見えない制御文字を入れないでください")

    @unittest.skipIf(yaml is None, "PyYAML がない")
    def test_REQ_004_an_entry_description_with_harmless_characters_is_accepted(self):
        text = "二つのハイフン -- と長音 ー と ダッシュ — と 絵文字 😀 と NBSP\u00a0 と タブ\t と 0x80未満の記号 \x1f と BOM\ufeff と ｛｛"
        self.edit_manifest(lambda m: m["entry_skill"].update(description=text))
        self.build()
        self.assertEqual(frontmatter(self.read("skills/weekly-report/SKILL.md"))["description"], text)

    def test_REQ_004_the_plugin_description_is_not_limited_like_the_entry_description(self):
        self.edit_manifest(lambda m: m.update(plugin_description="説明 --- 説明\x7f"))
        self.build()
        self.assertEqual(self.json("plugin.json")["description"], "説明 --- 説明\x7f")

    def test_BLUEPRINT_8_unknown_items_and_a_missing_manifest_are_refused(self):
        self.edit_manifest(lambda m: m.update(plugin_nane="x"))
        self.assertMentions(self.refusal(), "知らない項目", "plugin_nane")
        self.setUp()
        os.remove(self.part("manifest.json"))
        self.assertMentions(self.refusal(), "parts/manifest.json", "ありません")


class Workers(Base):
    """作業エージェントごとのファイルと、tools の作業ごとの分。"""

    @unittest.skipIf(yaml is None, "PyYAML がない")
    def test_REQ_010_one_agent_file_is_made_per_worker_with_its_own_name_and_text(self):
        self.two_workers()
        result = self.build()
        self.assertEqual(result["workers"], ["worker", "worker-summary"])
        agents = sorted(os.listdir(self.at("com.github.copilot/agents")))
        self.assertEqual(agents, ["orchestrator.agent.md", "verifier.agent.md", "worker-summary.agent.md", "worker.agent.md"])
        plain = self.read("com.github.copilot/agents/worker.agent.md")
        second = self.read("com.github.copilot/agents/worker-summary.agent.md")
        self.assertEqual(frontmatter(plain)["name"], "worker")
        self.assertEqual(frontmatter(second)["name"], "worker-summary")
        self.assertIn("社外の人の名前は書かない", plain)
        self.assertNotIn("3行にまとめる", plain)
        self.assertIn("3行にまとめる", second)
        self.assertNotIn("社外の人の名前は書かない", second)

    def test_REQ_010_the_plain_worker_file_is_not_kept_when_it_is_not_listed(self):
        self.edit_manifest(lambda m: m.update(workers=[{"agent": "worker-summary", "label": "まとめる係"}]))
        self.edit_task(lambda t: t.update(workers=[{"agent": "worker-summary", "label": "まとめる係"}]))
        self.write(self.part("slots/worker-task.worker-summary.md"), "まとめる。")
        self.build()
        self.assertEqual(sorted(os.listdir(self.at("com.github.copilot/agents"))),
                         ["orchestrator.agent.md", "verifier.agent.md", "worker-summary.agent.md"])

    def test_REQ_010_the_slot_of_a_second_worker_is_required(self):
        self.two_workers()
        os.remove(self.part("slots/worker-task.worker-summary.md"))
        self.assertMentions(self.refusal(), "{{slot:worker-task.worker-summary}}", "worker-summary.agent.md")

    def test_REQ_010_the_workers_of_the_manifest_and_the_task_must_agree(self):
        self.edit_manifest(lambda m: m["workers"].append({"agent": "worker-summary", "label": "まとめる係"}))
        self.assertMentions(self.refusal(), "parts/manifest.json の workers", "parts/task.json の workers")

    def test_BLUEPRINT_8_bad_worker_entries_are_refused(self):
        self.edit_manifest(lambda m: m["workers"].append({"agent": "helper", "label": "x"}))
        self.assertMentions(self.refusal(), "worker か worker-<名前>")
        self.setUp()
        self.edit_manifest(lambda m: m["workers"].append({"agent": "worker", "label": "x"}))
        self.assertMentions(self.refusal(), "重なっています")
        self.setUp()
        self.edit_manifest(lambda m: m.update(workers=[]))
        self.assertMentions(self.refusal(), "workers")

    @unittest.skipIf(yaml is None, "PyYAML がない")
    def test_BLUEPRINT_8_the_extra_tools_of_each_agent_are_added_to_its_tools(self):
        def change(m):
            m["workers"][0]["extra_tools"] = ["srv/b", "srv/c"]
            m["verifier"]["extra_tools"] = ["srv/d"]
        self.edit_manifest(change)
        self.build()
        agents = "com.github.copilot/agents/"
        self.assertEqual(frontmatter(self.read(agents + "worker.agent.md"))["tools"], ["read", "edit", "weekly-report_show", "srv/b", "srv/c"])
        verifier = self.read(agents + "verifier.agent.md")
        self.assertEqual(frontmatter(verifier)["tools"], ["read", "weekly-report_verdict", "srv/d"])
        self.assertIn('  - "srv/d"\n---\n', verifier)                                     # 字下げのある差し込み口は、その字下げを引き継ぐ

    @unittest.skipIf(yaml is None, "PyYAML がない")
    def test_BLUEPRINT_8_the_extra_tools_of_a_second_worker_go_to_its_own_file_only(self):
        self.two_workers()
        self.edit_manifest(lambda m: m["workers"][1].update(extra_tools=["srv/summary"]))
        self.build()
        agents = "com.github.copilot/agents/"
        self.assertEqual(frontmatter(self.read(agents + "worker-summary.agent.md"))["tools"], ["read", "edit", "weekly-report_show", "srv/summary"])
        self.assertEqual(frontmatter(self.read(agents + "worker.agent.md"))["tools"], ["read", "edit", "weekly-report_show"])

    @unittest.skipIf(yaml is None, "PyYAML がない")
    def test_BLUEPRINT_8_without_extra_tools_the_lists_are_clean(self):
        self.build()
        agents = "com.github.copilot/agents/"
        self.assertNotIn("tools", frontmatter(self.read(agents + "orchestrator.agent.md")))   # 統括の定義には tools を書かない（V1 の不具合 1）
        self.assertEqual(frontmatter(self.read(agents + "worker.agent.md"))["tools"], ["read", "edit", "weekly-report_show"])
        self.assertEqual(frontmatter(self.read(agents + "verifier.agent.md"))["tools"], ["read", "weekly-report_verdict"])
        self.assertNotIn("{{", self.read(agents + "verifier.agent.md"))

    def test_BLUEPRINT_8_extra_tools_with_no_place_in_the_template_are_refused(self):
        self.edit_manifest(lambda m: m["verifier"].update(extra_tools=["srv/a"]))
        path = self.tmpl("com.github.copilot/agents/verifier.agent.md")
        with open(path, encoding="utf-8") as f:
            text = f.read()
        self.write(path, text.replace("  {{verifier_extra_tools}}\n", ""))
        self.assertMentions(self.refusal(), "verifier.agent.md", "extra_tools", "srv/a")

    @unittest.skipIf(yaml is None, "PyYAML がない")
    def test_BLUEPRINT_8_the_orchestrator_has_no_tools_and_extra_tools_for_it_are_refused(self):
        # 統括の定義に tools を書くと、Copilot CLI は子の作業・検証のツールも統括の範囲に絞る（V1 の不具合 1）。統括が使えるツールは、エクステンションが決める
        self.build()
        self.assertNotIn("tools", frontmatter(self.read("com.github.copilot/agents/orchestrator.agent.md")))
        self.setUp()
        self.edit_manifest(lambda m: m["orchestrator"].update(extra_tools=["srv/a"]))
        problems = self.refusal()
        self.assertMentions(problems, "orchestrator.extra_tools", "空にしてください", "統括", "workers", "verifier")
        self.setUp()
        self.edit_manifest(lambda m: m.pop("orchestrator"))   # orchestrator の項目は、なくてよい
        self.build()
        self.assertNotIn("{{", self.read("com.github.copilot/agents/orchestrator.agent.md"))

    def test_REQ_010_the_orchestrator_gets_the_list_of_its_worker_agents(self):
        self.build()
        orchestrator = self.read("com.github.copilot/agents/orchestrator.agent.md")
        self.assertIn("## 作業エージェント\n\n- `weekly-report:worker`：週報を書く係\n\n## 作業ごとの指示", orchestrator)
        self.setUp()   # 組み立てに成功すると一時フォルダが消えるので、用意し直す
        self.two_workers()
        self.build()
        orchestrator = self.read("com.github.copilot/agents/orchestrator.agent.md")
        self.assertIn("- `weekly-report:worker`：週報を書く係\n- `weekly-report:worker-summary`：まとめる係\n", orchestrator)

    def test_REQ_031_the_labels_of_the_workers_must_agree_between_the_manifest_and_the_task(self):
        self.edit_task(lambda t: t["workers"][0].update(label="別の呼び名"))
        self.assertMentions(self.refusal(), "worker", "呼び名", "週報を書く係", "別の呼び名")

    def test_BLUEPRINT_8_a_label_must_be_one_line(self):
        self.edit_manifest(lambda m: m["workers"][0].update(label="一行目\n二行目"))
        self.assertMentions(self.refusal(), "label", "1行")

    def test_BLUEPRINT_8_bad_tool_names_are_refused(self):
        self.edit_manifest(lambda m: m["workers"][0].update(extra_tools=["srv a", 5, "x,y"]))
        problems = self.refusal()
        self.assertMentions(problems, "ツールの名前として使えません")
        self.assertEqual(len([p for p in problems if "ツールの名前として使えません" in p]), 3)


class Criteria(Base):
    """合否の基準（REQ-038）。ナレッジの文のまま、番号は C-01 から。"""

    def test_REQ_038_criteria_are_the_decided_criterion_knowledge_in_order_with_the_same_text(self):
        self.build()
        task = self.json("com.github.copilot/extensions/weekly-report/task.json")
        with open(self.state, encoding="utf-8") as f:
            knowledge = {k["id"]: k for k in json.load(f)["knowledge"]}
        self.assertEqual(task["criteria"], [
            {"id": "C-01", "text": knowledge["K-01"]["text"], "knowledge": "K-01"},
            {"id": "C-02", "text": knowledge["K-03"]["text"], "knowledge": "K-03"},
        ])
        self.assertEqual(list(task)[:3], ["name", "maxIterationsDefault", "criteria"])
        self.assertEqual(task["name"], "週報の作成")

    def test_REQ_038_the_text_is_not_changed_by_quotes_colons_spaces_and_newlines(self):
        text = '  引用 "符" と \\ と: コロン、\n改行 と末尾の空白  '

        def change(s):
            for k in s["knowledge"]:
                if k["id"] == "K-01":
                    k["text"] = text
        self.edit_state(change)
        self.build()
        self.assertEqual(self.json("com.github.copilot/extensions/weekly-report/task.json")["criteria"][0]["text"], text)
        self.assertEqual(self.json("tests/knowledge.json")[0]["text"], text)
        self.assertEqual(self.json("tests/eval/T-01/eval.json")["criteria"][0]["text"], text)

    def test_REQ_038_candidate_and_dropped_knowledge_are_not_criteria(self):
        self.build()
        task = self.json("com.github.copilot/extensions/weekly-report/task.json")
        self.assertEqual([c["knowledge"] for c in task["criteria"]], ["K-01", "K-03"])   # K-05（候補）は入らない
        self.assertNotIn("K-05", self.read("com.github.copilot/extensions/weekly-report/task.json"))
        self.assertNotIn("1ページに収める", self.read("com.github.copilot/extensions/weekly-report/task.json"))

    def test_REQ_038_a_new_decided_criterion_gets_the_next_number(self):
        def change(s):
            for k in s["knowledge"]:
                if k["id"] in ("K-05", "K-06"):
                    k.update(kind="criterion", status="decided")
        self.edit_state(change)
        self.edit_eval(lambda e: e["criteria"].extend([{"knowledge": "K-05", "grading": "model"}, {"knowledge": "K-06", "grading": "model"}]))
        self.edit_confirmed(lambda t: t["criteria"].extend(["K-05", "K-06"]))
        self.build()
        task = self.json("com.github.copilot/extensions/weekly-report/task.json")
        self.assertEqual([(c["id"], c["knowledge"]) for c in task["criteria"]],
                         [("C-01", "K-01"), ("C-02", "K-03"), ("C-03", "K-05"), ("C-04", "K-06")])

    def test_REQ_038_a_task_that_has_criteria_is_refused(self):
        self.edit_task(lambda t: t.update(criteria=[{"id": "C-01", "text": "勝手な基準", "knowledge": "K-01"}]))
        self.assertMentions(self.refusal(), "criteria", "作業エージェントは書きません")

    def test_REQ_038_an_empty_criteria_list_in_the_task_is_accepted(self):
        self.edit_task(lambda t: t.update(criteria=[]))
        self.build()

    def test_REQ_038_no_decided_criterion_knowledge_is_refused(self):
        def change(s):
            for k in s["knowledge"]:
                if k["kind"] == "criterion":
                    k["status"] = "dropped"
        self.edit_state(change)
        self.assertMentions(self.refusal(), "合否の決め方のナレッジが1件もありません")

    @unittest.skipUnless(have_checks(), "PyYAML と jsonschema がない")
    def test_REQ_038_shape_errors_of_the_task_are_refused_in_plain_japanese(self):
        self.edit_task(lambda t: t.pop("workers"))
        self.assertMentions(self.refusal(), "parts/task.json", "workers")
        self.setUp()
        self.edit_task(lambda t: t["settings"][0].update(type="slider"))
        self.assertMentions(self.refusal(), "settings", "slider")
        self.setUp()
        self.edit_task(lambda t: t.update(extra=1))
        self.assertMentions(self.refusal(), "決まりにない項目", "extra")

    def test_REQ_031_the_shape_check_is_left_to_stage_one_when_the_checker_is_missing(self):
        self.edit_task(lambda t: t.pop("displays"))
        with mock.patch.object(scaffold, "load_checks", return_value=None):
            result = self.build()
        self.assertTrue(any("1段目" in w for w in result["warnings"]))

    def test_REQ_031_a_missing_task_is_refused(self):
        os.remove(self.part("task.json"))
        self.assertMentions(self.refusal(), "parts/task.json", "ありません")


class EvalFiles(Base):
    """EVAL の課題の基準の写し（REQ-038、BLUEPRINT 4.3）。"""

    def test_REQ_038_the_eval_criteria_copy_id_and_text_of_the_task(self):
        self.build()
        task = self.json("com.github.copilot/extensions/weekly-report/task.json")
        copied = self.json("tests/eval/T-01/eval.json")
        self.assertEqual(copied["id"], "T-01")
        self.assertEqual(copied["inputs"], ["inputs/memo.txt"])
        self.assertEqual(copied["settings"], {"maxIterations": 3, "task": {"week": "2026-W42"}})
        self.assertEqual([(c["id"], c["text"]) for c in copied["criteria"]], [(c["id"], c["text"]) for c in task["criteria"]])
        self.assertEqual(copied["criteria"][0]["grading"], "program")
        self.assertEqual(copied["criteria"][0]["check"], {"type": "contains", "file": "out/*.md", "text": "今週やったこと"})
        self.assertEqual(copied["criteria"][1]["grading"], "model")
        self.assertTrue(all("knowledge" not in c for c in copied["criteria"]))
        self.assertEqual(list(copied["criteria"][0])[:3], ["id", "text", "grading"])

    def test_REQ_038_a_criterion_can_be_named_by_id_too_and_the_text_written_by_the_worker_is_replaced(self):
        self.edit_eval(lambda e: e["criteria"].__setitem__(0, {"id": "C-01", "text": "言い換えた文", "grading": "model"}))
        self.build()
        self.assertEqual(self.json("tests/eval/T-01/eval.json")["criteria"][0]["text"], self.json("tests/knowledge.json")[0]["text"])

    def test_REQ_038_a_criterion_that_does_not_exist_is_refused(self):
        self.edit_eval(lambda e: e["criteria"].append({"knowledge": "K-02", "grading": "model"}))   # K-02 は「それ以外」
        self.assertMentions(self.refusal(), "T-01", "K-02", "合否の決め方のナレッジの番号ではありません")
        self.setUp()
        self.edit_eval(lambda e: e["criteria"].append({"id": "C-09", "grading": "model"}))
        self.assertMentions(self.refusal(), "C-09", "基準の番号にありません")
        self.setUp()
        self.edit_eval(lambda e: e["criteria"].append({"id": "C-01", "knowledge": "K-03", "grading": "model"}))
        self.assertMentions(self.refusal(), "合っていません")
        self.setUp()
        self.edit_eval(lambda e: e["criteria"].append({"grading": "model"}))
        self.assertMentions(self.refusal(), "どの基準の採点か")

    def test_REQ_038_an_eval_task_without_criteria_or_with_a_broken_file_is_refused(self):
        self.edit_eval(lambda e: e.pop("criteria"))
        self.assertMentions(self.refusal(), "tests/eval/T-01/eval.json", "criteria")
        self.setUp()
        self.write(self.part("files/tests/eval/T-01/eval.json"), "{ 壊れている")
        self.assertMentions(self.refusal(), "eval.json", "JSON として読めません")

    def test_REQ_038_a_criterion_that_no_confirmed_task_uses_is_a_warning(self):
        self.edit_eval(lambda e: e["criteria"].pop())
        self.edit_confirmed(lambda t: t["criteria"].remove("K-03"))   # 確かめた課題にも入れない
        result = self.build()
        self.assertTrue(any("C-02" in w and "どの EVAL の課題にも入っていません" in w for w in result["warnings"]))

    def test_BLUEPRINT_8_other_json_files_are_copied_as_they_are(self):
        raw = '{"b":1,   "a":[1,2]}'
        self.write(self.part("files/data/raw.json"), raw)
        self.build()
        self.assertEqual(self.read("data/raw.json"), raw)


class EvalInputs(Base):
    """EVAL の課題の入力の実物のファイル（manifest.json の eval_inputs。統括の決定）。"""

    def real_file(self, name="前回の週報.txt", text="先週の実物\n"):
        path = os.path.join(self.root, "実物", name)
        self.write(path, text)
        return path

    def set_inputs(self, *items):
        self.edit_manifest(lambda m: m.update(eval_inputs=list(items)))

    def confirm_real(self, *items):
        """実物のファイルを、manifest.json の eval_inputs・eval.json の inputs・確かめた課題の入力の3か所にそろえて入れる。"""
        self.set_inputs(*items)
        self.edit_eval(lambda e: e["inputs"].extend("inputs/" + i["to"].split("/inputs/", 1)[1] for i in items))
        self.edit_confirmed(lambda t: t["inputs"].extend({"path": i["from"], "provisional": False} for i in items))

    def test_REQ_038_real_files_are_copied_to_the_places_named_in_to(self):
        a = self.real_file()
        b = self.real_file("memo/二つ目.csv", "a,b\n1,2\n")
        self.confirm_real({"from": a, "to": "tests/eval/T-01/inputs/前回の週報.txt"}, {"from": b, "to": "tests/eval/T-01/inputs/sub/二つ目.csv"})
        result = self.build()
        self.assertEqual(self.read("tests/eval/T-01/inputs/前回の週報.txt"), "先週の実物\n")
        self.assertEqual(self.read("tests/eval/T-01/inputs/sub/二つ目.csv"), "a,b\n1,2\n")
        self.assertEqual(result["eval_inputs"], ["tests/eval/T-01/inputs/前回の週報.txt", "tests/eval/T-01/inputs/sub/二つ目.csv"])
        self.assertTrue(os.path.isfile(a))   # 実物は動かさない

    def test_REQ_038_a_binary_file_is_copied_as_it_is(self):
        data = bytes(range(256)) * 3
        path = os.path.join(self.root, "実物", "x.bin")
        os.makedirs(os.path.dirname(path))
        with open(path, "wb") as f:
            f.write(data)
        self.confirm_real({"from": path, "to": "tests/eval/T-01/inputs/x.bin"})
        self.build()
        self.assertEqual(self.read_bytes("tests/eval/T-01/inputs/x.bin"), data)

    def test_REQ_038_files_that_do_not_exist_are_listed_and_nothing_is_made(self):
        a = self.real_file()
        gone1, gone2 = os.path.join(self.root, "ない1.docx"), os.path.join(self.root, "ない2.docx")
        self.set_inputs({"from": gone1, "to": "tests/eval/T-01/inputs/a.docx"}, {"from": a, "to": "tests/eval/T-01/inputs/b.txt"},
                        {"from": gone2, "to": "tests/eval/T-01/inputs/c.docx"})
        problems = self.refusal()
        self.assertMentions(problems, gone1, gone2, "がありません")
        self.assertNotIn(a, "\n".join(problems))

    def test_REQ_038_bad_items_are_refused(self):
        ok = "tests/eval/T-01/inputs/a.txt"
        cases = [
            (lambda a: {"from": "相対/パス.txt", "to": ok}, "絶対パス"),
            (lambda a: {"from": os.path.dirname(a), "to": ok}, "ファイルではありません"),
            (lambda a: {"from": a, "to": "tests/eval/T-01/other/a.txt"}, "tests/eval/<課題>/inputs/<名前>"),
            (lambda a: {"from": a, "to": "tests/eval/T-01/inputs/../../../x.txt"}, "tests/eval/<課題>/inputs/<名前>"),
            (lambda a: {"from": a, "to": "/tests/eval/T-01/inputs/a.txt"}, "tests/eval/<課題>/inputs/<名前>"),
            (lambda a: {"from": a, "to": "README.md"}, "tests/eval/<課題>/inputs/<名前>"),
            (lambda a: {"from": a}, "from（実物の絶対パス）と to"),
            (lambda a: {"from": a, "to": ok, "extra": 1}, "from（実物の絶対パス）と to"),
        ]
        for make, words in cases:
            with self.subTest(words=words):
                self.setUp()
                self.set_inputs(make(self.real_file()))
                self.assertMentions(self.refusal(), "eval_inputs", words)

    def test_REQ_038_the_same_place_twice_is_refused(self):
        a = self.real_file()
        self.set_inputs({"from": a, "to": "tests/eval/T-01/inputs/a.txt"}, {"from": a, "to": "tests/eval/T-01/inputs/a.txt"})
        self.assertMentions(self.refusal(), "重なっています")

    def test_REQ_038_a_place_that_parts_files_also_writes_is_refused(self):
        a = self.real_file()
        self.set_inputs({"from": a, "to": "tests/eval/T-01/inputs/memo.txt"})   # 見本の parts/files にも同じ場所がある
        self.assertMentions(self.refusal(), "tests/eval/T-01/inputs/memo.txt", "parts/files/", "eval_inputs")

    def test_REQ_038_a_real_file_cannot_overwrite_a_template_file(self):
        a = self.real_file()
        self.write(self.tmpl("tests/eval/T-01/inputs/from-template.txt"), "ひな形のファイル")
        self.confirm_real({"from": a, "to": "tests/eval/T-01/inputs/from-template.txt"})
        self.assertMentions(self.refusal(), "from-template.txt", "書き換えられません")

    def test_REQ_038_eval_inputs_must_be_a_list(self):
        self.edit_manifest(lambda m: m.update(eval_inputs="x"))
        self.assertMentions(self.refusal(), "eval_inputs", "一覧")

    def test_REQ_038_without_eval_inputs_nothing_is_copied(self):
        result = self.build()
        self.assertEqual(result["eval_inputs"], [])


class ConfirmedEvals(Base):
    """作業エージェントが書いた eval.json が、ユーザーが生成前の確認で確かめた課題（confirmation.evalTasks）と同じか（REQ-038、X2-03）。"""

    def add_task(self, prompt="別の課題の頼むときの言葉", directory="T-02", settings=None):
        """第2の課題を、eval.json（parts/files）と確かめた課題の両方に足す。"""
        shutil.copytree(self.part("files/tests/eval/T-01"), self.part("files/tests/eval/" + directory))

        def change(e):
            e.update(id=directory, prompt=prompt)
            e.pop("settings", None)
            if settings is not None:
                e["settings"] = settings
        self.edit_json(self.part("files/tests/eval/%s/eval.json" % directory), change)
        self.edit_state(lambda s: s["confirmation"]["evalTasks"].append({
            "prompt": prompt, "inputs": [{"path": "tests/eval/%s/inputs/memo.txt" % directory, "provisional": True}],
            "criteria": ["K-01", "K-03"], "settings": settings or {}}))

    def test_REQ_038_a_changed_prompt_is_refused_and_both_prompts_are_shown(self):
        self.edit_eval(lambda e: e.update(prompt="今週の週報を書いてください"))
        problems = self.refusal()
        self.assertMentions(problems, "先週の記録をもとに", "に当たる EVAL の課題", "今週の週報を書いてください", "確かめた課題にありません")

    def test_REQ_038_spaces_around_the_prompt_do_not_matter(self):
        self.edit_eval(lambda e: e.update(prompt="  先週の記録をもとに、今週の週報を書いてください。\n"))
        self.build()

    def test_REQ_038_a_criterion_dropped_from_a_task_is_refused(self):
        self.edit_eval(lambda e: e["criteria"].pop())   # K-03 を落とす（ほかの課題には入っていても、この課題の基準は確かめた組と同じにする）
        self.assertMentions(self.refusal(), "tests/eval/T-01/eval.json", "criteria", "K-01、K-03", "eval.json：K-01")

    def test_REQ_038_a_criterion_added_to_a_task_is_refused(self):
        self.edit_confirmed(lambda t: t["criteria"].remove("K-03"))
        self.assertMentions(self.refusal(), "criteria", "確かめた課題：K-01／eval.json：K-01、K-03")

    def test_REQ_038_settings_must_be_the_confirmed_ones(self):
        cases = {
            "繰り返しの上限": lambda e: e["settings"].update(maxIterations=5),
            "設定の値": lambda e: e["settings"]["task"].update(week="2026-W43"),
            "設定の名前": lambda e: e["settings"]["task"].update(month="10"),
            "settings がない": lambda e: e.pop("settings"),
        }
        for name, change in cases.items():
            with self.subTest(change=name):
                self.setUp()
                self.edit_eval(change)
                self.assertMentions(self.refusal(), "settings", "確かめた課題")

    def test_REQ_038_a_task_without_settings_matches_a_confirmed_task_without_settings(self):
        self.edit_eval(lambda e: e.pop("settings"))
        self.edit_confirmed(lambda t: t.pop("settings"))
        self.build()
        self.setUp()
        self.edit_eval(lambda e: e.update(settings={}))
        self.edit_confirmed(lambda t: t.pop("settings"))
        self.build()

    def test_REQ_038_inputs_must_be_the_confirmed_ones(self):
        self.edit_eval(lambda e: e["inputs"].append("inputs/other.txt"))
        self.assertMentions(self.refusal(), "inputs", "確かめていない", "tests/eval/T-01/inputs/other.txt")
        self.setUp()
        self.edit_eval(lambda e: e.update(inputs=[]))
        self.assertMentions(self.refusal(), "inputs", "確かめたのに入っていない", "tests/eval/T-01/inputs/memo.txt")

    def test_REQ_038_an_input_file_that_was_not_confirmed_is_not_put_in_the_repository(self):
        self.write(self.part("files/tests/eval/T-01/inputs/secret.txt"), "確かめていないファイル")
        self.assertMentions(self.refusal(), "tests/eval/T-01/inputs/secret.txt", "確かめた入力にありません")

    def test_REQ_038_a_task_with_no_input_matches_a_confirmed_task_with_no_input(self):
        self.edit_eval(lambda e: e.update(inputs=[]))
        self.edit_confirmed(lambda t: t.update(inputs=[]))
        os.remove(self.part("files/tests/eval/T-01/inputs/memo.txt"))
        self.build()

    def test_REQ_038_the_way_of_writing_a_path_does_not_matter(self):
        self.edit_eval(lambda e: e.update(inputs=["./inputs/memo.txt"]))
        self.edit_confirmed(lambda t: t["inputs"][0].update(path="tests/eval//T-01/./inputs/memo.txt"))
        self.build()

    def test_REQ_038_the_folder_name_of_a_task_is_free(self):
        shutil.move(self.part("files/tests/eval/T-01"), self.part("files/tests/eval/週報の課題"))
        self.edit_confirmed(lambda t: t["inputs"][0].update(path="tests/eval/週報の課題/inputs/memo.txt"))
        self.build()
        self.assertTrue(os.path.isfile(self.at("tests/eval/週報の課題/eval.json")))

    def test_REQ_038_two_confirmed_tasks_need_two_eval_files(self):
        self.add_task()
        self.build()
        self.assertEqual(self.json("tests/eval/T-02/eval.json")["prompt"], "別の課題の頼むときの言葉")

    def test_REQ_038_a_confirmed_task_without_an_eval_file_is_refused(self):
        self.add_task()
        shutil.rmtree(self.part("files/tests/eval/T-02"))
        self.assertMentions(self.refusal(), "別の課題の頼むときの言葉", "に当たる EVAL の課題")

    def test_REQ_038_no_eval_file_at_all_is_refused(self):
        shutil.rmtree(self.part("files/tests/eval"))
        self.assertMentions(self.refusal(), "先週の記録をもとに", "に当たる EVAL の課題")

    def test_REQ_038_an_eval_file_for_a_task_the_user_did_not_confirm_is_refused(self):
        self.add_task()
        self.edit_state(lambda s: s["confirmation"]["evalTasks"].pop())
        self.assertMentions(self.refusal(), "tests/eval/T-02/eval.json", "別の課題の頼むときの言葉", "確かめた課題にありません")

    def test_REQ_038_tasks_with_the_same_prompt_are_matched_by_what_they_contain(self):
        for swap in (False, True):
            with self.subTest(swap=swap):
                self.setUp()
                self.add_task(prompt="先週の記録をもとに、今週の週報を書いてください。", settings={"maxIterations": 1})
                if swap:   # 確かめた課題の並びを入れ替えても、中身で結びつく
                    self.edit_state(lambda s: s["confirmation"]["evalTasks"].reverse())
                self.build()

    def test_REQ_038_tasks_with_the_same_prompt_still_have_to_match_one_by_one(self):
        self.add_task(prompt="先週の記録をもとに、今週の週報を書いてください。", settings={"maxIterations": 1})
        self.edit_eval(lambda e: e["settings"].update(maxIterations=2))
        self.assertMentions(self.refusal(), "settings")

    def test_REQ_038_a_real_file_that_was_confirmed_must_be_in_eval_inputs(self):
        gone = os.path.join(self.root, "実物", "前回の週報.docx")
        self.write(gone, "x")
        self.edit_eval(lambda e: e["inputs"].append("inputs/前回の週報.docx"))
        self.edit_confirmed(lambda t: t["inputs"].append({"path": gone, "provisional": False}))
        self.assertMentions(self.refusal(), gone, "eval_inputs の from にありません")

    def test_REQ_038_one_real_file_can_be_used_by_two_tasks(self):
        real = os.path.join(self.root, "実物", "共通.txt")
        self.write(real, "共通の実物\n")
        self.add_task()
        for directory, index in (("T-01", 0), ("T-02", 1)):
            self.edit_json(self.part("files/tests/eval/%s/eval.json" % directory), lambda e: e["inputs"].append("inputs/共通.txt"))
            self.edit_confirmed(lambda t: t["inputs"].append({"path": real, "provisional": False}), index=index)
        self.edit_manifest(lambda m: m.update(eval_inputs=[{"from": real, "to": "tests/eval/T-01/inputs/共通.txt"},
                                                           {"from": real, "to": "tests/eval/T-02/inputs/共通.txt"}]))
        self.build()
        self.assertEqual(self.read("tests/eval/T-01/inputs/共通.txt"), "共通の実物\n")
        self.assertEqual(self.read("tests/eval/T-02/inputs/共通.txt"), "共通の実物\n")

    def test_REQ_038_a_real_file_in_eval_inputs_that_was_not_confirmed_is_refused(self):
        real = os.path.join(self.root, "実物", "秘密.txt")
        self.write(real, "x")
        self.edit_manifest(lambda m: m.update(eval_inputs=[{"from": real, "to": "tests/eval/T-01/inputs/秘密.txt"}]))
        self.assertMentions(self.refusal(), "tests/eval/T-01/inputs/秘密.txt", "確かめた入力にありません")

    def test_REQ_038_an_eval_file_that_cannot_be_read_gives_its_own_problem_only(self):
        self.edit_eval(lambda e: e.pop("criteria"))
        problems = self.refusal()
        self.assertMentions(problems, "tests/eval/T-01/eval.json", "criteria")
        self.assertNotIn("に当たる EVAL の課題", "\n".join(problems))

    def test_REQ_038_eval_inputs_that_the_manifest_gets_wrong_give_their_own_problem_only(self):
        self.edit_manifest(lambda m: m.update(eval_inputs="x"))
        problems = self.refusal()
        self.assertMentions(problems, "eval_inputs", "一覧")
        self.assertNotIn("に当たる EVAL の課題", "\n".join(problems))


class Knowledge(Base):
    """ナレッジの一覧（REQ-039、BLUEPRINT 4.2）。"""

    def test_REQ_039_the_list_has_every_decided_knowledge_with_kind_item_and_text(self):
        self.build()
        rows = self.json("tests/knowledge.json")
        self.assertEqual([r["id"] for r in rows], ["K-01", "K-02", "K-03", "K-06"])
        self.assertEqual([r["kind"] for r in rows], ["criterion", "other", "criterion", "other"])
        self.assertEqual([r["item"] for r in rows], ["合否の決め方", "決まった書き方やルール", "決まった書き方やルール", "守らないと困ること"])
        self.assertEqual(rows[1]["text"], "宛先は部長。です・ます調の敬語で書く。")
        self.assertTrue(all(sorted(r) == ["id", "item", "kind", "text"] for r in rows))   # 出どころやユーザーの言葉は入れない

    def test_REQ_039_dropped_and_candidate_knowledge_are_not_listed(self):
        result = self.build()
        text = self.read("tests/knowledge.json")
        self.assertNotIn("K-04", text)
        self.assertNotIn("K-05", text)
        self.assertEqual(result["knowledge"], {"criterion": 2, "other": 2})

    def test_REQ_039_the_item_falls_back_to_the_key_when_the_name_is_missing(self):
        def change(s):
            for k in s["knowledge"]:
                k.pop("itemName", None)
        self.edit_state(change)
        self.build()
        self.assertEqual(self.json("tests/knowledge.json")[0]["item"], "criteria")

    def test_REQ_039_bad_knowledge_rows_are_refused(self):
        def change(s):
            s["knowledge"][0]["id"] = "X-1"
            s["knowledge"][1]["kind"] = "foo"
            s["knowledge"][2]["text"] = " "
        self.edit_state(change)
        self.assertMentions(self.refusal(), "X-1", "foo", "文が空です")

    def test_REQ_039_a_duplicated_number_is_refused(self):
        self.edit_state(lambda s: s["knowledge"][5].update(id="K-01"))
        self.assertMentions(self.refusal(), "K-01", "番号が重なっています")

    def test_REQ_039_the_knowledge_list_may_be_missing_or_wrong(self):
        self.edit_state(lambda s: s.update(knowledge="x"))
        self.assertMentions(self.refusal(), "knowledge が一覧ではありません")


class PartsFiles(Base):
    """そのまま足すファイル（parts/files/）。"""

    def test_BLUEPRINT_8_the_files_are_copied_as_they_are(self):
        self.build()
        for rel in ("scripts/summarize.py", "tests/stage2/task/test_summarize.py", "tests/eval/T-01/inputs/memo.txt"):
            with open(os.path.join(SAMPLE, "parts", "files", *rel.split("/")), "rb") as a:
                self.assertEqual(a.read(), self.read_bytes(rel), rel)

    @unittest.skipIf(os.name == "nt", "実行の許可の印は Windows にない")
    def test_BLUEPRINT_8_the_executable_mark_of_a_file_is_kept(self):
        os.chmod(self.part("files/scripts/summarize.py"), 0o755)
        self.build()
        self.assertTrue(os.access(self.at("scripts/summarize.py"), os.X_OK))

    def test_creator_structure_4_1_files_may_not_overwrite_the_files_of_the_template_or_the_generated_files(self):
        for rel in ("README.md", "tests/knowledge.json", "com.github.copilot/extensions/weekly-report/task.json", "plugin.json",
                    "com.github.copilot/extensions/weekly-report/core/index.mjs"):
            with self.subTest(rel=rel):
                self.setUp()
                self.write(self.part("files/" + rel), "上書き")
                problems = self.refusal()
                self.assertMentions(problems, rel, "書き換えられません")

    def test_BLUEPRINT_8_a_new_file_may_be_added_even_in_a_folder_of_the_template(self):
        self.write(self.part("files/docs/extra.md"), "足した文書")
        self.write(self.part("files/mcp.json"), '{"mcpServers": {}}')
        self.build()
        self.assertEqual(self.read("docs/extra.md"), "足した文書")
        self.assertTrue(os.path.isfile(self.at("mcp.json")))

    def test_REQ_004_symlinks_and_git_folders_are_refused(self):
        try:
            os.symlink("/etc/hostname", self.part("files/link.txt"))
        except (OSError, NotImplementedError):
            self.skipTest("シンボリックリンクを作れない環境")
        os.makedirs(self.part("files/.git"))
        self.write(self.part("files/.git/HEAD"), "x")
        problems = self.refusal()
        self.assertMentions(problems, "link.txt", "シンボリックリンク", ".git")

    def test_REQ_004_a_symlinked_folder_is_refused(self):
        elsewhere = os.path.join(self.root, "elsewhere")
        os.makedirs(elsewhere)
        try:
            os.symlink(elsewhere, self.part("files/linkdir"))
        except (OSError, NotImplementedError):
            self.skipTest("シンボリックリンクを作れない環境")
        self.assertMentions(self.refusal(), "linkdir", "シンボリックリンク")

    def test_BLUEPRINT_8_caches_in_the_parts_are_ignored(self):
        self.write(self.part("files/scripts/__pycache__/a.pyc"), "x")
        self.write(self.part("files/.DS_Store"), "x")
        self.build()
        self.assertFalse(os.path.exists(self.at("scripts/__pycache__")))
        self.assertFalse(os.path.exists(self.at(".DS_Store")))

    def test_BLUEPRINT_8_text_in_the_files_is_not_touched_even_if_it_looks_like_a_placeholder(self):
        self.write(self.part("files/scripts/template.txt"), "{{plugin_name}} と {{slot:x}}\n")
        self.build()
        self.assertEqual(self.read("scripts/template.txt"), "{{plugin_name}} と {{slot:x}}\n")


class TemplateProblems(Base):
    """ひな形が足りないとき。"""

    def test_creator_structure_2_a_template_without_the_entry_skill_folder_is_refused(self):
        shutil.rmtree(self.tmpl("skills/_entry_"))
        self.assertMentions(self.refusal(), "skills/_entry_/", "ひな形")

    def test_creator_structure_2_a_template_without_the_extension_folder_is_refused(self):
        shutil.rmtree(self.tmpl("com.github.copilot/extensions/_plugin_"))
        self.assertMentions(self.refusal(), "extensions/_plugin_/", "ひな形")

    def test_creator_structure_2_a_template_without_the_worker_agent_is_refused(self):
        os.remove(self.tmpl("com.github.copilot/agents/worker.agent.md"))
        self.assertMentions(self.refusal(), "worker.agent.md", "ひな形")


class BaseCheck(Base):
    """土台がひな形と同じか（REQ-039、creator-structure.md 4.1）。"""

    EXT = "com.github.copilot/extensions/weekly-report/"

    def check(self, restore=False):
        return scaffold.check_base(self.out, restore, template=self.template)

    def test_REQ_039_the_base_matches_right_after_the_build(self):
        self.build()
        result = self.check()
        self.assertEqual((result["ok"], result["differences"], result["plugin"]), (True, [], "weekly-report"))

    def test_REQ_039_changed_missing_and_extra_files_are_found(self):
        self.build()
        self.append(self.at(self.EXT + "core/index.mjs"), "// 試験を通すために書き換えた\n")
        os.remove(self.at(self.EXT + "ui/app.mjs"))
        self.write(self.at(self.EXT + "core/extra.mjs"), "// 足したファイル\n")
        self.append(self.at(self.EXT + "extension.mjs"), "// 入口も書き換えた\n")
        self.write(self.at(self.EXT + "ui/static/more.js"), "x")
        result = self.check()
        self.assertFalse(result["ok"])
        self.assertEqual({(d["file"], d["kind"]) for d in result["differences"]}, {
            (self.EXT + "core/index.mjs", "changed"),
            (self.EXT + "ui/app.mjs", "missing"),
            (self.EXT + "core/extra.mjs", "extra"),
            (self.EXT + "extension.mjs", "changed"),
            (self.EXT + "ui/static/more.js", "extra"),
        })
        self.assertTrue(all(d["message"] for d in result["differences"]))

    def test_REQ_039_restore_puts_the_template_back_and_removes_the_extra_files(self):
        self.build()
        original = {rel: self.read_bytes(self.EXT + rel) for rel in ("core/index.mjs", "ui/app.mjs", "extension.mjs")}
        self.append(self.at(self.EXT + "core/index.mjs"), "// 書き換え\n")
        os.remove(self.at(self.EXT + "ui/app.mjs"))
        self.write(self.at(self.EXT + "ui/new/deep/extra.js"), "x")
        result = self.check(restore=True)
        self.assertTrue(result["ok"])
        self.assertEqual(len(result["differences"]), 3)             # 見つけた違いは残して知らせる
        self.assertEqual(sorted(result["restored"]), sorted(d["file"] for d in result["differences"]))
        self.assertEqual(result["remaining"], [])
        for rel, content in original.items():
            self.assertEqual(self.read_bytes(self.EXT + rel), content)
        self.assertFalse(os.path.exists(self.at(self.EXT + "ui/new")))   # 空になったフォルダも片付ける
        self.assertTrue(self.check()["ok"])

    def test_REQ_039_files_outside_the_base_folders_are_left_alone(self):
        self.build()
        self.write(self.at(self.EXT + "notes.md"), "作業ごとの部品")
        self.append(self.at(self.EXT + "task.json"), " ")
        self.write(self.at("scripts/other.py"), "x")
        result = self.check()
        self.assertTrue(result["ok"], result["differences"])

    def test_REQ_039_caches_are_not_a_difference(self):
        self.build()
        self.write(self.at(self.EXT + "core/__pycache__/x.pyc"), "x")
        self.assertTrue(self.check()["ok"])

    def test_REQ_039_the_base_needs_a_readable_plugin_json_and_the_extension_folder(self):
        self.build()
        os.remove(self.at("plugin.json"))
        with self.assertRaises(scaffold.Refusal) as caught:
            self.check()
        self.assertMentions(caught.exception.problems, "plugin.json")
        self.write(self.at("plugin.json"), '{"name": "other-name"}')
        with self.assertRaises(scaffold.Refusal) as caught:
            self.check()
        self.assertMentions(caught.exception.problems, "土台のフォルダ", "other-name")

    def test_REQ_039_a_missing_plugin_folder_is_refused(self):
        with self.assertRaises(scaffold.Refusal) as caught:
            scaffold.check_base(os.path.join(self.root, "nothing"), template=self.template)
        self.assertMentions(caught.exception.problems, "ありません")


class Cli(Base):
    """標準出力には JSON を1つだけ出す。終了コード。"""

    def run_main(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), mock.patch.object(scaffold, "DEFAULT_TEMPLATE", self.template):
            code = scaffold.main(list(argv))
        return code, json.loads(out.getvalue()), err.getvalue()

    def test_BLUEPRINT_9_build_prints_one_json_document_and_exits_with_zero(self):
        code, data, _err = self.run_main("build", "--hearing", self.state, "--work", self.work, "--out", self.out)
        self.assertEqual(code, 0)
        self.assertTrue(data["ok"])
        self.assertEqual((data["out"], data["plugin_name"], data["workers"]), (self.out, "weekly-report", ["worker"]))
        self.assertEqual(data["criteria"], [{"id": "C-01", "knowledge": "K-01"}, {"id": "C-02", "knowledge": "K-03"}])
        self.assertEqual(data["warnings"], [])
        self.assertEqual(len(data["commit"]), 40)

    def test_BLUEPRINT_9_a_refusal_prints_the_problems_in_japanese_and_exits_with_one(self):
        self.edit_state(lambda s: s.update(stage="item_check"))
        code, data, _err = self.run_main("build", "--hearing", self.state, "--work", self.work, "--out", self.out)
        self.assertEqual(code, 1)
        self.assertFalse(data["ok"])
        self.assertMentions(data["problems"], "「生成」ではありません")
        self.assertFalse(os.path.exists(self.out))

    def test_BLUEPRINT_9_check_base_prints_the_differences_and_exits_with_one(self):
        self.run_main("build", "--hearing", self.state, "--work", self.work, "--out", self.out)
        code, data, _err = self.run_main("check-base", "--out", self.out)
        self.assertEqual((code, data["ok"]), (0, True))
        self.append(self.at("com.github.copilot/extensions/weekly-report/core/index.mjs"), "x")
        code, data, _err = self.run_main("check-base", "--out", self.out)
        self.assertEqual((code, data["ok"]), (1, False))
        self.assertEqual(data["differences"][0]["kind"], "changed")
        code, data, _err = self.run_main("check-base", "--out", self.out, "--restore")
        self.assertEqual((code, data["ok"]), (0, True))
        self.assertEqual(len(data["restored"]), 1)

    def test_BLUEPRINT_9_check_base_of_a_missing_folder_exits_with_one(self):
        code, data, _err = self.run_main("check-base", "--out", os.path.join(self.root, "nothing"))
        self.assertEqual((code, data["ok"]), (1, False))

    def test_BLUEPRINT_9_a_wrong_usage_exits_with_two(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
            scaffold.main(["build", "--hearing", self.state])
        self.assertEqual(caught.exception.code, 2)

    def test_BLUEPRINT_9_an_unexpected_error_is_reported_as_json_too(self):
        with mock.patch.object(scaffold, "load_state", side_effect=RuntimeError("こわれた")):
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = scaffold.main(["build", "--hearing", self.state, "--work", self.work, "--out", self.out])
        self.assertEqual(code, 1)
        self.assertMentions(json.loads(out.getvalue())["problems"], "予期しない誤り", "こわれた")

    def test_BLUEPRINT_9_the_script_runs_alone_with_isolated_python(self):
        done = subprocess.run([sys.executable, "-I", SCRIPT, "check-base", "--out", os.path.join(self.root, "nothing")],
                              capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(done.returncode, 1)
        self.assertFalse(json.loads(done.stdout)["ok"])
        done = subprocess.run([sys.executable, "-I", SCRIPT, "--help"], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(done.returncode, 0)
        self.assertIn("build", done.stdout)


# ---------------------------------------------------------------- 本物のひな形

STUB_WORKER = """---
description: 作業エージェント（試験で補った仮のファイル）
tools:
  - read
  - edit
  - execute
  - search
  - "{{plugin_name}}_show"
{{worker_extra_tools}}
---

## 作業ごとの指示

{{slot:worker-task}}
"""

STUB_VERIFIER = """---
description: 検証エージェント（試験で補った仮のファイル）
tools:
  - read
  - search
  - "{{plugin_name}}_verdict"
{{verifier_extra_tools}}
---

## 作業ごとの指示

{{slot:verifier-task}}
"""

STUBS = {
    "com.github.copilot/agents/worker.agent.md": STUB_WORKER,
    "com.github.copilot/agents/verifier.agent.md": STUB_VERIFIER,
}


def missing_parts():
    return [rel for rel in STUBS if not os.path.exists(os.path.join(REAL_TEMPLATE, *rel.split("/")))]


class RealTemplate(Base):
    """本物のひな形で組み立て、1段目の構造の検査に通ることを見る。まだない部品（B2 が作る作業・検証のエージェント）は、仮のファイルで補う。"""

    @classmethod
    def setUpClass(cls):
        cls.stubbed = missing_parts()
        if cls.stubbed:
            sys.stderr.write("\n[C2 の試験] 本物のひな形にまだない部品を、仮のファイルで補います：%s\n" % "、".join(cls.stubbed))

    def make_template(self):
        dest = os.path.join(self.root, "template")
        shutil.copytree(REAL_TEMPLATE, dest, ignore=scaffold.make_ignore(REAL_TEMPLATE))
        for rel in self.stubbed:
            self.write(os.path.join(dest, *rel.split("/")), STUBS[rel])
        return dest

    def run_checks(self):
        checks = load_module("plugin_creator_template_check_structure", CHECK_STRUCTURE)
        return checks.run_checks(self.out, "generated")

    @unittest.skipUnless(have_checks(), "PyYAML と jsonschema がない")
    def test_REQ_001_the_built_plugin_passes_the_structure_check(self):
        self.build()
        report = self.run_checks()
        failures = ["[%s] %s" % (c.id, m) for c in report.checks for m in c.errors]
        self.assertEqual(failures, [], "\n".join(failures))

    @unittest.skipUnless(have_checks(), "PyYAML と jsonschema がない")
    def test_REQ_004_the_manifest_and_the_marketplace_are_valid(self):
        self.build()
        checks = {c.id: c for c in self.run_checks().checks}
        self.assertEqual(checks["manifest"].errors, [])
        market = self.json(".github/plugin/marketplace.json")
        plugin = self.json("plugin.json")
        self.assertEqual([p["name"] for p in market["plugins"]], [plugin["name"]])
        self.assertEqual(market["name"], "weekly-report")

    def test_REQ_001_the_built_plugin_has_no_placeholder_left(self):
        self.build()
        leftovers = []
        for directory, dirs, names in os.walk(self.out):
            dirs[:] = [d for d in dirs if d != ".git"]
            for name in names:
                path = os.path.join(directory, name)
                try:
                    with open(path, encoding="utf-8") as f:
                        text = f.read()
                except (OSError, UnicodeDecodeError):
                    continue
                for m in scaffold.PLACEHOLDER.finditer(text):
                    leftovers.append("%s: %s" % (os.path.relpath(path, self.out), m.group(0)))
        self.assertEqual(leftovers, [])

    def test_REQ_001_the_built_plugin_has_the_constitution_the_specs_the_design_and_the_tests(self):
        self.build()
        for rel in ("docs/constitution.md", "docs/specs/requirements.md", "docs/design/design.md", "plugin.json", "README.md",
                    "tests/run.py", "tests/knowledge.json", "tests/eval/T-01/eval.json", ".gitignore", ".github/plugin/marketplace.json"):
            self.assertTrue(os.path.isfile(self.at(rel)), rel)
        self.assertIn("weekly-report", self.read("docs/constitution.md"))

    def test_REQ_050_the_readme_starts_with_what_it_does_and_how_to_use_it(self):
        self.build()
        text = self.read("README.md")
        headings = [line for line in text.splitlines() if line.startswith("## ")]
        self.assertEqual(headings[:2], ["## できること", "## 使い方"])
        self.assertIn("部長宛ての週報ができあがります", text)
        self.assertIn("「先週の記録をもとに、今週の週報を書いてください。」", text)

    def test_REQ_050_a_readme_slot_with_a_level_2_heading_is_refused(self):
        self.write(self.part("slots/readme-how.md"), "## 頼み方\n\nチャットで頼みます。\n")
        self.assertMentions(self.refusal(), "readme-how.md", "### 以下")

    def test_REQ_039_the_base_check_script_finds_and_restores_a_changed_base_file(self):
        self.build()
        target = self.at("com.github.copilot/extensions/weekly-report/core/index.mjs")

        def run(*extra):
            done = subprocess.run([sys.executable, "-I", SCRIPT, "check-base", "--out", self.out] + list(extra),
                                  capture_output=True, text=True, encoding="utf-8")
            return done.returncode, json.loads(done.stdout)

        self.assertEqual(run()[0], 0)
        self.append(target, "// 書き換え\n")
        code, data = run()
        self.assertEqual(code, 1)
        self.assertEqual([(d["file"], d["kind"]) for d in data["differences"]],
                         [("com.github.copilot/extensions/weekly-report/core/index.mjs", "changed")])
        code, data = run("--restore")
        self.assertEqual((code, data["ok"], len(data["restored"])), (0, True, 1))
        self.assertEqual(run()[0], 0)

    @unittest.skipIf(missing_parts(), "本物のひな形に、作業・検証のエージェントの定義がまだない（B2 の後に動く）")
    def test_REQ_001_the_real_script_builds_with_the_real_template(self):
        done = subprocess.run([sys.executable, "-I", SCRIPT, "build", "--hearing", self.state, "--work", self.work, "--out", self.out],
                              capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(done.returncode, 0, done.stdout)
        self.assertTrue(json.loads(done.stdout)["ok"])
        self.assertTrue(os.path.isdir(self.at(".git")))



class Naming(unittest.TestCase):
    """試験の名前は、確かめる要件の番号（REQ-nnn）か、要件でない設計の決まりなら設計書の節の印を持つ（X2-10、憲章 第6条3項）。"""

    MARK = re.compile(r"^test_(REQ_(\d{3})|BLUEPRINT_\d+|creator_structure_\d+(?:_\d+)?|generated_plugin_structure_\d+(?:_\d+)?)_\w+$")

    def test_creator_structure_2_every_test_name_has_a_requirement_number_or_a_design_marker(self):
        with open(os.path.abspath(__file__), encoding="utf-8") as f:
            names = re.findall(r"^    def (test_\w+)\(self", f.read(), re.M)
        self.assertGreater(len(names), 100)
        self.assertEqual([n for n in names if not self.MARK.match(n)], [])

    def test_creator_structure_2_the_requirement_numbers_in_the_test_names_are_in_the_specs(self):
        known = set()
        for name in os.listdir(os.path.join(REPO, "docs", "specs")):
            with open(os.path.join(REPO, "docs", "specs", name), encoding="utf-8") as f:
                known.update(re.findall(r"^### REQ-(\d{3}) ", f.read(), re.M))
        with open(os.path.abspath(__file__), encoding="utf-8") as f:
            used = set(re.findall(r"^    def test_REQ_(\d{3})_", f.read(), re.M))
        self.assertGreater(len(used), 5)
        self.assertEqual(sorted(used - known), [])

    def test_creator_structure_2_the_naming_check_finds_a_name_without_a_marker(self):
        self.assertIsNone(self.MARK.match("test_a_slot_is_filled"))
        self.assertIsNone(self.MARK.match("test_REQ_21_short"))
        self.assertTrue(self.MARK.match("test_REQ_021_ok"))
        self.assertTrue(self.MARK.match("test_creator_structure_4_1_ok"))


if __name__ == "__main__":
    unittest.main()
