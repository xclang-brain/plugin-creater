"""アイデア創出スキル（make-idea）の形の試験（アイデア創出の設計 7章）。モデルは使わない。

- 既定のパラメーター（skills/make-idea/assets/params.json）が、仕様書 REQ-073 の表と同じ名前・同じ既定の値で、値の扱いの決まりに合う。
- 6つの柱の名前と順番が、憲章 第26条、仕様書 1章、SKILL.md で同じ（憲章 第26条3項。承認なしに変えない）。
- SKILL.md の6つの柱の中身が、仕様書 1章の表の文と一字一句同じ（縮めて写さない）。
- 制限の決定で決める項目が、目的と範囲だけ（REQ-065）。
- 3つのエージェントの tools が設計どおり（読み手はファイルを読めない、検討役は Web を持たない、どれも skill を持たない）。
  調査役と検討役は model を書かず、ユーザーが選んだモデルを継ぐ。
- make-idea が、make-plugin・change-plugin・test-plugin の仕組み（plugin-creator_ のツール、読み取り役、作業エージェント）を使うよう書いていない（REQ-076）。
- README に、データの置き場所と消し方がある（REQ-074）。
- 手順のファイルが名指しするエージェントと知識・経験のファイルが、そろっている。
- 手順のファイル（references）が、すべて SKILL.md に名指しされ、20,000 バイト未満である。
- 手順のファイルに書いた記録のファイルの名前が、ANALYSIS・REPORT・SUMMARY・FINDINGS で始まらない（Claude Code が書くのを断る）。
- Claude Code 向けの置き換え（convert.py）で、エージェントのツールと本文の task の引数が置き換わる。

動かし方（リポジトリの根で）:  python3 -m unittest discover -s tests/creator/make-idea -p "test_*.py"
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
SKILL_DIR = os.path.join(REPO, "skills", "make-idea")
AGENTS_DIR = os.path.join(REPO, "com.github.copilot", "agents")
SPEC = os.path.join(REPO, "docs", "specs", "idea-requirements.md")
CONSTITUTION = os.path.join(REPO, "docs", "constitution", "constitution.md")
CONVERT = os.path.join(REPO, "tests", "dev-eval", "convert.py")

PILLARS = [
    "制限の決定",
    "徹底的な事前調査",
    "本質の見極め（なぜなぜ分析）",
    "本質の掛け合わせによるアイデア創出（壁打ち）",
    "アイデアの説明（第三者目線）",
    "知識・経験の蓄積",
]
AGENT_COUNTS = [
    ("本質の見極め", "なぜなぜ分析をするエージェントの数"),
    ("本質の掛け合わせ", "壁打ちの相手のエージェントの数"),
    ("アイデアの説明", "説明を読む第三者のエージェントの数"),
    ("知識・経験の蓄積", "振り返りのエージェントの数"),
]
UPPER_LIMITS = (   # 値の扱いで、大きすぎると止める項目と、比べる相手
    ("徹底的な事前調査", "1体が掘り下げる作品の数"),
    ("知識・経験の蓄積", "まとめ始める大きさの割合（%）"),
    ("アイデアの説明", "選ぶ一覧で詳しく示す案の数"),
)
IDEA_AGENTS = ("idea-researcher", "idea-thinker", "idea-reader")
REFUSED_NAME = re.compile(r"(analysis|report|summary|findings)", re.I)   # Claude Code がサブエージェントに書かせない名前の頭
READ_LIMIT = 20000   # Copilot CLI のファイルを読むツールが読む大きさ（アイデア創出の設計 2章）


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def skill_files():
    """make-idea のスキルのフォルダの Markdown（SKILL.md と references）"""
    found = [os.path.join(SKILL_DIR, "SKILL.md")]
    refs = os.path.join(SKILL_DIR, "references")
    found += [os.path.join(refs, f) for f in sorted(os.listdir(refs)) if f.endswith(".md")]
    return found


def agent_meta(agent_id):
    text = read(os.path.join(AGENTS_DIR, agent_id + ".agent.md"))
    _, head, body = text.split("---", 2)
    return yaml.safe_load(head), body


def params():
    with open(os.path.join(SKILL_DIR, "assets", "params.json"), encoding="utf-8") as f:
        return json.load(f)


def spec_param_rows():
    """仕様書 REQ-073 の表の行：[(柱, パラメーター, 既定)]"""
    text = read(SPEC)
    start = text.index("### REQ-073")
    end = text.index("\n### ", start + 1)
    rows = []
    for line in text[start:end].splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) == 4 and line.strip().startswith("|") and cells[0] not in ("柱", "---"):
            rows.append((cells[0], cells[1], cells[2]))
    return rows


def spec_pillar_rows():
    """仕様書 1章の6つの柱の表の行：[(番号, 名前, 中身)]"""
    return re.findall(r"^\| (\d)\. ([^|]+?) \| ([^|]+?) \|$", read(SPEC), re.M)


def numbers(text):
    return [int(n) for n in re.findall(r"\d+", text)]


class Params(unittest.TestCase):
    def test_REQ_073_names_and_defaults_match_the_spec_table(self):
        p = params()
        rows = spec_param_rows()
        self.assertEqual(26, len(rows), rows)
        listed = {(pillar, name) for pillar, name, _ in rows}
        in_file = {(pillar, name) for pillar, group in p.items() if isinstance(group, dict) for name in group}
        self.assertEqual(listed, in_file)
        for pillar, name, default in rows:
            value = p[pillar][name]
            if isinstance(value, dict):
                self.assertEqual(numbers(default), [value["最小"], value["最大"]], name)
            elif isinstance(value, list):
                self.assertEqual(numbers(default), value, name)
            else:
                self.assertEqual(numbers(default), [value], name)

    def test_REQ_073_defaults_follow_the_value_rules(self):
        p = params()
        for pillar, group in p.items():
            if not isinstance(group, dict):
                continue
            for name, value in group.items():
                for n in (value.values() if isinstance(value, dict) else value if isinstance(value, list) else [value]):
                    self.assertIsInstance(n, int, name)
                    self.assertGreaterEqual(n, 1, name)
        size = p["本質の掛け合わせ"]["一度に掛け合わせる本質の数"]
        self.assertGreaterEqual(size["最小"], 2)
        self.assertLessEqual(size["最小"], size["最大"])
        for n in p["本質の掛け合わせ"]["掛け合わせる数を変える順"]:
            self.assertTrue(size["最小"] <= n <= size["最大"], n)
        for pillar, name in AGENT_COUNTS:
            self.assertGreaterEqual(p[pillar][name], 2, name)
        self.assertGreaterEqual(p["本質の見極め"]["本質の数"], size["最大"])
        self.assertLessEqual(p["徹底的な事前調査"]["1体が掘り下げる作品の数"], 20)
        self.assertLessEqual(p["知識・経験の蓄積"]["まとめ始める大きさの割合（%）"], 100)
        self.assertGreaterEqual(p["アイデアの説明"]["選ぶ一覧で詳しく示す案の数"], p["アイデアの説明"]["説明するアイデアの数の上限"])

    def test_REQ_073_developer_values(self):
        """開発者が決めた初期値（ナレッジ「アイデア創出（6つの柱）」）"""
        p = params()
        self.assertGreaterEqual(p["徹底的な事前調査"]["集める作品の数"], 100)
        self.assertGreaterEqual(p["本質の見極め"]["本質の数"], 30)
        self.assertEqual({"最小": 2, "最大": 4}, p["本質の掛け合わせ"]["一度に掛け合わせる本質の数"])
        for pillar, name in AGENT_COUNTS[:3]:
            self.assertGreaterEqual(p[pillar][name], 2)
        self.assertGreaterEqual(p["徹底的な事前調査"]["同時に調べるエージェントの数"], 2)

    def test_start_reference_lists_every_agent_count_as_a_stop_rule(self):
        start = read(os.path.join(SKILL_DIR, "references", "start.md"))
        for _, name in AGENT_COUNTS:
            self.assertIn(name, start)

    def test_start_reference_and_params_description_list_every_upper_limit(self):
        """大きすぎると止める値が、確かめの手順と、パラメーターのファイルの頭の説明にある（アイデア創出の設計 4章）"""
        start = read(os.path.join(SKILL_DIR, "references", "start.md"))
        start = start[start.index("## パラメーターの確かめ"):]
        description = params()["説明"]
        for _, name in UPPER_LIMITS:
            self.assertIn("「%s」" % name, start)
            self.assertIn(name, description)


class Pillars(unittest.TestCase):
    def test_constitution_article_26_has_the_six_pillars_in_order(self):
        text = read(CONSTITUTION)
        part = text[text.index("### 第26条"):text.index("### 第27条")]
        found = re.findall(r"^ {3,}\d\. (.+)$", part, re.M)   # 1項の下の入れ子の番号つきの行
        self.assertEqual(PILLARS, found)

    def test_spec_table_has_the_six_pillars_in_order(self):
        text = read(SPEC)
        found = re.findall(r"^\| \d\. ([^|]+?) \|", text, re.M)
        self.assertEqual(PILLARS, found)

    def test_skill_lists_the_six_pillars_in_order(self):
        text = read(os.path.join(SKILL_DIR, "SKILL.md"))
        part = text[text.index("## 6つの柱"):text.index("## 先頭の決まり")]
        found = re.findall(r"^\d\. ([^：]+)：", part, re.M)
        self.assertEqual(PILLARS, found)
        self.assertIn("名前・順番・中身は変えない", part)

    def test_skill_copies_the_spec_table_text_of_each_pillar_verbatim(self):
        """縮めて写すと言葉が抜け、手順に届かない（仕様書 1章。「時間をかけて」が抜けた）"""
        text = read(os.path.join(SKILL_DIR, "SKILL.md"))
        lines = text[text.index("## 6つの柱"):text.index("## 先頭の決まり")].splitlines()
        rows = spec_pillar_rows()
        self.assertEqual(PILLARS, [name for _, name, _ in rows])
        for number, name, content in rows:
            self.assertIn("%s. %s：%s。" % (number, name, content), lines, name)


class Agents(unittest.TestCase):
    def tools(self, agent_id):
        meta, _ = agent_meta(agent_id)
        return [t.lower() for t in meta.get("tools", [])]

    def test_REQ_070_reader_cannot_find_or_change_files(self):
        """読み手は read だけ（場所を渡されず、探すツールを持たない）。ツールなしは Claude Code が起動を断る（アイデア創出の設計 1章）"""
        tools = self.tools("idea-reader")
        self.assertEqual(["read"], tools)

    def test_thinker_has_no_web_and_researcher_has_web(self):
        self.assertNotIn("web", self.tools("idea-thinker"))
        self.assertIn("web", self.tools("idea-researcher"))

    def test_no_idea_agent_can_call_skills(self):
        for agent_id in IDEA_AGENTS:
            tools = self.tools(agent_id)
            self.assertNotIn("skill", tools, agent_id)
            self.assertNotIn("*", tools, agent_id)

    def test_descriptions_say_they_are_called_inside_make_idea(self):
        for agent_id in IDEA_AGENTS:
            meta, _ = agent_meta(agent_id)
            self.assertIn("make-idea の手順の中で", meta["description"], agent_id)

    def test_researcher_and_thinker_inherit_the_users_model(self):
        """調査役も、費用の低いモデルにしない。前の版は掘り下げが浅くなった（アイデア創出の設計 3.4）"""
        for agent_id in ("idea-researcher", "idea-thinker"):
            meta, _ = agent_meta(agent_id)
            self.assertNotIn("model", meta, agent_id)


class References(unittest.TestCase):
    def test_every_reference_is_named_by_the_skill_and_readable(self):
        skill = read(os.path.join(SKILL_DIR, "SKILL.md"))
        refs = os.path.join(SKILL_DIR, "references")
        for name in sorted(os.listdir(refs)):
            if not name.endswith(".md"):
                continue
            self.assertIn("`references/%s`" % name, skill, name)
            self.assertLess(os.path.getsize(os.path.join(refs, name)), READ_LIMIT, name)

    def test_REQ_065_restriction_decides_only_purpose_and_scope(self):
        text = read(os.path.join(SKILL_DIR, "references", "restriction.md"))
        part = text[text.index("## 決める項目"):]
        part = part[:part.index("\n## ", 1)]
        items = [line.split("|")[1].strip() for line in part.splitlines() if line.startswith("|")]
        self.assertEqual(["目的", "範囲"], [i for i in items if i not in ("項目", "---")])
        template = re.search(r"```markdown\n(.*?)```", text, re.S).group(1)
        self.assertEqual(["目的", "範囲"], re.findall(r"^\s*## (.+)$", template, re.M))

    def test_record_file_names_do_not_start_with_names_claude_code_refuses(self):
        """Claude Code は、サブエージェントが名前の頭が ANALYSIS・REPORT・SUMMARY・FINDINGS の .md を書くのを断る（アイデア創出の設計 3.5）"""
        names = set()
        for path in skill_files():
            text = read(path)
            names.update(p.rsplit("/", 1)[-1] for p in re.findall(r"<回のフォルダ>/([^`\s）)、。]+)", text))
            names.update(p.rsplit("/", 1)[-1] for p in re.findall(r"`([^`\s]+\.md)`", text))
        self.assertIn("whys-c01-a1.md", names)   # 探し方が名前を拾えている
        self.assertIn("overview.md", names)
        for name in sorted(names):
            self.assertIsNone(REFUSED_NAME.match(name), name)


class Separation(unittest.TestCase):
    def test_REQ_076_no_creator_extension_tool_is_named(self):
        for path in skill_files() + [os.path.join(AGENTS_DIR, a + ".agent.md") for a in IDEA_AGENTS]:
            self.assertIsNone(re.search(r"plugin-creator_[a-z]", read(path)), path)

    def test_REQ_076_make_plugin_agents_are_named_only_to_forbid_them(self):
        for path in skill_files():
            for line in read(path).splitlines():
                if "plugin-creator:reader" in line or "plugin-creator:worker" in line:
                    self.assertIn("使わない", line, path)

    def test_REQ_076_the_end_tells_to_clear_before_make_or_change_plugin(self):
        end = read(os.path.join(SKILL_DIR, "references", "accumulate.md"))
        end = end[end.index("### 5. 終わり"):]
        for word in ("/clear", "make-plugin", "change-plugin"):
            self.assertIn(word, end)

    def test_only_idea_agents_are_called(self):
        for path in skill_files():
            for name in re.findall(r"plugin-creator:([a-z-]+)", read(path)):
                if name in ("reader", "worker"):
                    continue
                self.assertIn(name, IDEA_AGENTS, path)

    def test_knowledge_files_agree_between_skill_and_accumulate(self):
        skill = set(re.findall(r"`(\d-[a-z]+\.md)`", read(os.path.join(SKILL_DIR, "SKILL.md"))))
        accumulate = set(re.findall(r"`(\d-[a-z]+\.md)`", read(os.path.join(SKILL_DIR, "references", "accumulate.md"))))
        self.assertEqual(6, len(skill))
        self.assertEqual(skill, accumulate)


class Readme(unittest.TestCase):
    def test_REQ_074_readme_tells_where_the_data_is_and_how_to_delete_it(self):
        text = read(os.path.join(REPO, "README.md"))
        part = text[text.index("## アイデアを作る"):]
        part = part[:part.index("\n## ", 1)]
        self.assertIn("~/.plugin-creator/make-idea/", part)
        self.assertIn("フォルダを削除", part)
        self.assertIn("/plugin-creator:make-idea", part)
        self.assertIn("/clear", part)


@unittest.skipUnless(shutil.which(sys.executable), "Python がない")
class Conversion(unittest.TestCase):
    """Claude Code 向けの置き換え（testing.md 4章）で、make-idea が Claude Code の名前になる"""

    @classmethod
    def setUpClass(cls):
        cls.out = tempfile.mkdtemp()
        cls.root = os.path.join(cls.out, "plugin-creator")
        subprocess.run([sys.executable, "-I", CONVERT, REPO, cls.root, "--skip-validate"], check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.out, ignore_errors=True)

    def converted_agent(self, agent_id):
        text = read(os.path.join(self.root, "agents", agent_id + ".md"))
        _, head, _ = text.split("---", 2)
        return yaml.safe_load(head)

    def test_agent_tools_become_claude_code_names(self):
        self.assertEqual("Read", self.converted_agent("idea-reader")["tools"])
        thinker = self.converted_agent("idea-thinker")
        self.assertEqual("inherit", thinker["model"])
        self.assertNotIn("Web", thinker["tools"])
        researcher = self.converted_agent("idea-researcher")
        self.assertIn("WebSearch", researcher["tools"])
        self.assertIn("WebFetch", researcher["tools"])
        self.assertEqual("inherit", researcher["model"])

    def test_skill_body_uses_claude_code_tool_names(self):
        body = read(os.path.join(self.root, "skills", "make-idea", "SKILL.md"))
        self.assertIn("`AskUserQuestion`", body)
        self.assertIn("`Agent`", body)
        self.assertIn("`subagent_type`", body)
        self.assertIn("`run_in_background`", body)
        self.assertNotIn("`ask_user`", body)
        self.assertNotIn('`"sync"`', body)

    def test_default_params_are_copied(self):
        self.assertTrue(os.path.isfile(os.path.join(self.root, "skills", "make-idea", "assets", "params.json")))


if __name__ == "__main__":
    unittest.main()
