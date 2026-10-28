"""変換スクリプト（tests/dev-eval/convert.py）の試験。testing.md 4章の置き換えの各規則を確かめる。

- 小さな Copilot CLI 向けのプラグイン（試験の中で作る）で、規則を1つずつ確かめる。
- クリエイター自身と、C2 の組み立ての見本（tests/creator/scaffold/sample）で作った生成プラグインを置き換え、
  `claude plugin validate` に通ることと、エクステンションのツール名が本物のツールの名前に合うことを確かめる。

試験の名前の REQ-037 は、会話例を外す決まり（testing.md 6.6）。ほかの置き換えの規則は、開発の試験の仕組みの決まりで、
仕様書の要件の番号はない（testing.md 4章の項を名前に入れた）。

動かし方（リポジトリの根で）:
    python3 -m unittest discover -s tests/dev-eval -p "test_convert.py"
claude コマンドがない環境では、`claude plugin validate` を使う試験を飛ばす。node がない環境では、ツール名を突き合わせる試験を飛ばす。
"""
import contextlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

import yaml

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
SCAFFOLD = os.path.join(REPO, "skills", "make-plugin", "scripts", "scaffold.py")
SAMPLE = os.path.join(REPO, "tests", "creator", "scaffold", "sample")

spec = importlib.util.spec_from_file_location("dev_eval_convert", os.path.join(HERE, "convert.py"))
convert = importlib.util.module_from_spec(spec)
spec.loader.exec_module(convert)

HAVE_CLAUDE = shutil.which("claude") is not None
HAVE_NODE = shutil.which("node") is not None


def write(root, rel, text):
    path = os.path.join(root, *rel.split("/"))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    return path


def front(meta_lines, body):
    return "---\n" + "\n".join(meta_lines) + "\n---\n" + body


MANIFEST = {
    "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    "name": "demo-plugin", "version": "0.2.0", "description": "試験用のプラグイン",
    "author": {"name": "Example"}, "repository": "https://github.com/example/demo-plugin", "license": "MIT",
    "keywords": ["demo"], "extensions": {"com.github.copilot": {}},
}

ORCHESTRATOR_BODY = (
    "統括。\n\n"
    "- どちらも `task` で呼ぶ。エージェントの種類（`agent_type`）に名前を、実行のしかた（`mode`）に `\"sync\"` を指定する。"
    "`\"background\"` で呼ばない。\n"
    "- `demo-plugin_plan` で記録する。demo-plugin_show も使う。`ask_user` は使えない。ask_user と書いても同じ。\n"
    "- 設定の例：`${PLUGIN_ROOT}/scripts/x.py`\n"
    "- `edit` という言葉ではなく edit tool と書いた文は、そのまま。\n"
)


def make_fixture(root):
    """Copilot CLI 向けの小さなプラグインを root に作る。"""
    write(root, "plugin.json", json.dumps(MANIFEST, ensure_ascii=False, indent=2))
    write(root, "README.md", "# demo\n")
    write(root, "CLAUDE.md", "開発用の指示\n")
    write(root, "mcp.json", json.dumps({
        "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        "mcpServers": {
            "calc": {"type": "stdio", "command": "python3", "args": ["${PLUGIN_ROOT}/mcp/calc.py"],
                     "env": {"DATA": "${PLUGIN_DATA}/calc"}, "cwd": "${PLUGIN_ROOT}"},
            "remote": {"type": "streamable-http", "url": "https://example.com/mcp"},
            "feed": {"type": "sse", "url": "https://example.com/sse"},
        }}))
    write(root, "mcp/calc.py", "print('calc')\n")
    write(root, "scripts/helper.py", "print('helper')\n")
    # スキル
    write(root, "skills/demo/SKILL.md", front(
        ["name: demo", "description: 試験用のスキル", "allowed-tools: bash, view, Bash(git add:*), demo-plugin_open"],
        "手順。`skill` で読み直す。`task` で呼ぶ。`ask_user` で聞く。\n`demo-plugin_open` を呼ぶ。\n"
        "`mode` は、ここではただの言葉。\n`${PLUGIN_ROOT}` はそのまま。\n"))
    write(root, "skills/demo/references/a.md", "`demo-plugin_state` を呼ぶ。`view` で読む。\n")
    write(root, "skills/demo/assets/template/com.github.copilot/agents/t.agent.md", front(
        ["description: ひな形", "model: [gpt-6-luna]", "tools:", "  - read"], "`task` と `ask_user` と `demo-plugin_plan`\n"))
    write(root, "template/com.github.copilot/agents/t.agent.md", front(
        ["description: ひな形", "model: [gpt-6-luna]", "tools:", "  - read"], "`task` と `ask_user` と `demo-plugin_plan`\n"))
    write(root, "skills/demo/scripts/run.py", "# `task` はスクリプトの中\n")
    # エージェント
    write(root, "com.github.copilot/agents/orchestrator.agent.md", front([
        'description: "統括"', "model: [claude-sonnet-5.5, gpt-6.1-sol]", "reasoningEffort: high", "tools:",
        "  - agent", "  - read", "  - search", '  - "demo-plugin_plan"', "  - calc/add", "  - calc/*", "  - web",
        "  - edit", "  - execute", "disable-model-invocation: true"], ORCHESTRATOR_BODY))
    write(root, "com.github.copilot/agents/worker.agent.md", front([
        "description: 作業", "model: [gpt-6-luna, claude-haiku-5.5]", "tools: [read, edit, execute]",
        "model-policy: allow"], "作業。\n"))
    write(root, "com.github.copilot/agents/verifier.agent.md", front([
        "description: 検証", "model: gpt-6.1-sol", "tools: read, search"], "検証。\n"))
    write(root, "com.github.copilot/agents/free.agent.md", front(["description: モデルなし"], "どれでも。\n"))
    write(root, "com.github.copilot/agents/team/deep.agent.md", front(
        ["description: 深い", "model: claude-opus-5.5"], "深い。\n"))
    # フック、規則、コマンド、LSP、エクステンション
    write(root, "com.github.copilot/hooks/hooks.json", json.dumps({"version": 1, "hooks": {
        "preToolUse": [
            {"type": "command", "bash": "${PLUGIN_ROOT}/scripts/guard.sh", "matcher": "bash|edit", "timeoutSec": 10},
            {"type": "command", "exec": "python3", "args": ["${PLUGIN_ROOT}/scripts/g.py"], "timeout": 5},
            {"type": "command", "powershell": "guard.ps1"},
            {"type": "http", "url": "https://example.com/hook"},
        ],
        "sessionStart": [{"type": "command", "bash": "echo start"}],
        "somethingNew": [{"type": "command", "bash": "echo x"}],
    }}))
    write(root, "com.github.copilot/rules/style.md", "規則その1\n")
    write(root, "com.github.copilot/rules/more.md", "規則その2\n")
    write(root, "com.github.copilot/commands/hello.md", "挨拶\n")
    write(root, "com.github.copilot/lsp.json", json.dumps({"x": {"command": "${PLUGIN_ROOT}/lsp"}}))
    write(root, "com.github.copilot/extensions/demo-plugin/extension.mjs", "// エクステンション\n")
    # 写してはいけないもの
    write(root, "examples/talk.md", "会話例\n")
    write(root, "tests/run.py", "print('tests')\n")
    write(root, "tests/dev-eval/heldout/secret.md", "見ない模擬ユーザー\n")
    write(root, "skills/demo/heldout/deep.md", "深い場所の heldout\n")
    write(root, "docs/design/x.md", "設計書\n")
    write(root, "wip/memo.md", "作業のメモ\n")
    write(root, ".git/config", "[core]\n")
    write(root, ".github/plugin/marketplace.json", "{}")
    write(root, ".claude/memory/m.md", "ナレッジ\n")
    write(root, ".gitignore", "x\n")
    write(root, "scripts/__pycache__/helper.cpython-313.pyc", "pyc")
    return root


def frontmatter_of(path):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    parts = text.split("---\n", 2)
    return yaml.safe_load(parts[1]), parts[2]


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="d1a-convert-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.src = make_fixture(os.path.join(self.tmp, "src"))
        self.out = os.path.join(self.tmp, "out")

    def run_convert(self, validate=False, **kw):
        self.report = convert.convert(self.src, self.out, validate=validate, **kw)
        return self.report

    def at(self, rel):
        return os.path.join(self.out, *rel.split("/"))

    def text(self, rel):
        with open(self.at(rel), encoding="utf-8") as f:
            return f.read()

    def json(self, rel):
        return json.loads(self.text(rel))

    def agent(self, name):
        return frontmatter_of(self.at(f"agents/{name}.md"))


class Manifest(Base):
    def test_4_the_manifest_moves_to_the_claude_directory_with_the_fields_claude_code_reads(self):
        self.run_convert()
        manifest = self.json(".claude-plugin/plugin.json")
        self.assertEqual(manifest, {"name": "demo-plugin", "version": "0.2.0", "description": "試験用のプラグイン",
                                    "author": {"name": "Example"}, "repository": "https://github.com/example/demo-plugin",
                                    "license": "MIT", "keywords": ["demo"]})
        self.assertFalse(os.path.exists(self.at("plugin.json")))
        self.assertTrue(any("extensions" in w for w in self.report["warnings"]))

    def test_4_no_settings_json_with_an_agent_is_written(self):
        """メインのエージェントは試験の仕組みが決める。プラグインの settings.json の agent は使わない。"""
        self.run_convert()
        self.assertFalse(os.path.exists(self.at("settings.json")))


class Models(Base):
    def models(self):
        self.run_convert()
        return {name: self.agent(name)[0]["model"] for name in ("orchestrator", "worker", "verifier", "free", "team--deep")}

    def test_4_a_list_takes_the_first_claude_model_as_an_id(self):
        models = self.models()
        self.assertEqual(models["orchestrator"], "claude-sonnet-5-5")   # [claude-sonnet-5.5, gpt-6.1-sol]
        self.assertEqual(models["worker"], "claude-haiku-5-5")           # [gpt-6-luna, claude-haiku-5.5]

    def test_4_a_model_without_claude_takes_the_claude_of_the_same_price(self):
        self.assertEqual(self.models()["verifier"], "claude-sonnet-5-5")  # gpt-6.1-sol

    def test_4_the_table_has_the_five_models_of_the_design(self):
        self.assertEqual(convert.MODEL_MAP, {
            "claude-haiku-5.5": "claude-haiku-5-5", "gpt-6-luna": "claude-haiku-5-5",
            "claude-sonnet-5.5": "claude-sonnet-5-5", "gpt-6.1-sol": "claude-sonnet-5-5",
            "claude-opus-5.5": "claude-opus-5-5"})
        self.run_convert()
        self.assertEqual(self.report["model_map"], convert.MODEL_MAP)

    def test_4_opus_is_an_id_and_an_agent_without_model_inherits(self):
        models = self.models()
        self.assertEqual(models["team--deep"], "claude-opus-5-5")
        self.assertEqual(models["free"], "inherit")

    def test_4_models_are_ids_never_aliases(self):
        for model in self.models().values():
            self.assertNotIn(model, ("sonnet", "haiku", "opus", "fable"))

    def test_4_the_first_claude_wins_even_when_a_cheaper_non_claude_comes_first(self):
        ctx = convert.Context("s", "o", "p", [])
        self.assertEqual(convert.convert_model(["gpt-6.1-sol", "claude-haiku-5.5"], "w", ctx), "claude-haiku-5-5")
        self.assertEqual(convert.convert_model(["claude-opus-5.5", "gpt-6-luna"], "w", ctx), "claude-opus-5-5")
        self.assertEqual(convert.convert_model("claude-haiku-5-5", "w", ctx), "claude-haiku-5-5")  # すでに ID

    def test_4_an_unknown_model_inherits_with_a_warning(self):
        ctx = convert.Context("s", "o", "p", [])
        self.assertEqual(convert.convert_model(["gpt-9", "claude-sonnet-4.5"], "agents/x", ctx), "inherit")
        self.assertEqual(len(ctx.warnings), 1)
        self.assertIn("agents/x", ctx.warnings[0])

    def test_4_model_policy_and_other_copilot_only_items_are_dropped_with_a_warning(self):
        self.run_convert()
        meta, _ = self.agent("worker")
        self.assertEqual(set(meta), {"name", "description", "tools", "model"})
        self.assertTrue(any("model-policy" in w for w in self.report["warnings"]))
        meta, _ = self.agent("orchestrator")
        self.assertNotIn("disable-model-invocation", meta)
        self.assertTrue(any("disable-model-invocation" in w for w in self.report["warnings"]))

    def test_4_reasoning_effort_becomes_effort(self):
        self.run_convert()
        self.assertEqual(self.agent("orchestrator")[0]["effort"], "high")


class AgentTools(Base):
    def tools(self, name):
        self.run_convert()
        return [t.strip() for t in self.agent(name)[0]["tools"].split(",")]

    def test_4_aliases_become_the_claude_code_names(self):
        self.assertEqual(self.tools("worker"), ["Read", "Edit", "Write", "Bash"])
        self.assertEqual(self.tools("verifier"), ["Read", "Grep", "Glob"])

    def test_4_web_becomes_webfetch_and_websearch_and_agent_stays_agent(self):
        tools = self.tools("orchestrator")
        self.assertEqual(tools[:2], ["Agent", "Read"])
        self.assertIn("WebFetch", tools)
        self.assertIn("WebSearch", tools)

    def test_4_extension_tools_in_tools_become_mcp_tool_names(self):
        self.assertIn("mcp__demo-plugin__plan", self.tools("orchestrator"))

    def test_4_a_server_tool_of_the_plugin_mcp_json_gets_the_plugin_scoped_name(self):
        tools = self.tools("orchestrator")
        self.assertIn("mcp__plugin_demo-plugin_calc__add", tools)
        self.assertIn("mcp__plugin_demo-plugin_calc__*", tools)

    def test_4_a_plugin_name_that_cannot_be_part_of_an_mcp_name_is_warned(self):
        ctx = convert.Context("s", "o", "my.plugin", [])
        convert.convert_tools(["calc/add"], ctx, "agents/x")
        self.assertTrue(any("agents/x" in w and "MCP" in w for w in ctx.warnings))
        ctx = convert.Context("s", "o", "my-plugin", [])
        convert.convert_tools(["calc/add"], ctx, "agents/x")
        self.assertEqual(ctx.warnings, [])

    def test_4_no_duplicates(self):
        tools = self.tools("orchestrator")
        self.assertEqual(len(tools), len(set(tools)))

    def test_4_all_tools_and_a_missing_tools_item_write_no_tools_item(self):
        self.run_convert()
        self.assertNotIn("tools", self.agent("free")[0])
        ctx = convert.Context("s", "o", "p", [])
        self.assertIsNone(convert.convert_tools(["*"], ctx, "w"))
        self.assertIsNone(convert.convert_tools(None, ctx, "w"))

    def test_4_a_tools_string_is_split_by_commas_not_by_characters(self):
        ctx = convert.Context("s", "o", "p", [])
        self.assertEqual(convert.convert_tools("read, search", ctx, "w"), ["Read", "Grep", "Glob"])

    def test_4_an_empty_tools_list_warns_instead_of_guessing(self):
        ctx = convert.Context("s", "o", "p", [])
        self.assertIsNone(convert.convert_tools([], ctx, "agents/x"))
        self.assertTrue(any("agents/x" in w for w in ctx.warnings))

    def test_4_a_tool_without_a_claude_name_is_kept_and_warned(self):
        ctx = convert.Context("s", "o", "p", [])
        self.assertEqual(convert.convert_tools(["task_complete"], ctx, "agents/x"), ["task_complete"])
        self.assertTrue(any("task_complete" in w for w in ctx.warnings))

    def test_4_claude_code_names_are_accepted_as_they_are(self):
        ctx = convert.Context("s", "o", "p", [])
        self.assertEqual(convert.convert_tools(["Read", "Bash", "WebFetch"], ctx, "w"), ["Read", "Bash", "WebFetch"])
        self.assertEqual(ctx.warnings, [])


class Bodies(Base):
    def orchestrator_body(self):
        self.run_convert()
        return self.agent("orchestrator")[1]

    def test_4_backticked_tool_names_and_underscore_names_are_replaced(self):
        body = self.orchestrator_body()
        self.assertIn("`Agent` で呼ぶ", body)
        self.assertNotIn("`ask_user`", body)
        self.assertIn("`AskUserQuestion` は使えない", body)
        self.assertIn("AskUserQuestion と書いても同じ", body)   # バッククォートの外の ask_user も、紛れない名前なので置き換える

    def test_4_task_arguments_become_the_agent_arguments(self):
        """task の agent_type と mode は、Claude Code の Agent の subagent_type と run_in_background。mode: sync は run_in_background: false。"""
        body = self.orchestrator_body()
        self.assertIn("（`subagent_type`）に名前を", body)
        self.assertIn("（`run_in_background`）に `false` を指定する", body)
        self.assertIn("`true` で呼ばない", body)
        for old in ("`agent_type`", "`mode`", '"sync"', '"background"'):
            self.assertNotIn(old, body)

    def test_4_mode_is_left_alone_in_a_body_that_does_not_talk_about_task_arguments(self):
        self.run_convert()
        self.assertIn("`mode` は、ここではただの言葉", self.text("skills/demo/SKILL.md"))

    def test_4_extension_tool_names_become_mcp_tool_names_with_and_without_backticks(self):
        body = self.orchestrator_body()
        self.assertIn("`mcp__demo-plugin__plan` で記録する", body)
        self.assertIn("mcp__demo-plugin__show も使う", body)
        self.assertNotIn("demo-plugin_plan", body)

    def test_4_the_name_prefix_of_the_extension_tools_is_replaced_too(self):
        write(self.src, "skills/demo/references/a.md", "名前が `demo-plugin_` で始まるもの。`demo-plugin_` ではない `demo-plugin_x-y` は別。\n")
        self.run_convert()
        text = self.text("skills/demo/references/a.md")
        self.assertIn("名前が `mcp__demo-plugin__` で始まるもの", text)
        self.assertIn("`demo-plugin_x-y`", text)   # ツール名の形（英字と下線だけ）ではないものは、そのまま

    def test_4_plain_words_like_edit_are_not_replaced_outside_backticks(self):
        body = self.orchestrator_body()
        self.assertIn("edit tool と書いた文", body)

    def test_4_variables_in_a_body_are_left_alone(self):
        """本文の ${PLUGIN_ROOT} を置き換えると、Claude Code が読み込みのときに実際のパスにしてしまい、例の文が変わる。"""
        self.assertIn("`${PLUGIN_ROOT}/scripts/x.py`", self.orchestrator_body())
        self.assertNotIn("CLAUDE_PLUGIN_ROOT", self.orchestrator_body())

    def test_4_the_skill_body_and_its_references_are_replaced(self):
        self.run_convert()
        skill = self.text("skills/demo/SKILL.md")
        self.assertIn("`Skill` で読み直す", skill)
        self.assertIn("`Agent` で呼ぶ", skill)
        self.assertIn("`AskUserQuestion` で聞く", skill)
        self.assertIn("`mcp__demo-plugin__open` を呼ぶ", skill)
        reference = self.text("skills/demo/references/a.md")
        self.assertIn("`mcp__demo-plugin__state`", reference)
        self.assertIn("`Read` で読む", reference)

    def test_4_the_template_assets_and_scripts_of_a_skill_are_not_replaced(self):
        """assets/ のひな形は、Copilot CLI 向けの生成プラグインの元。クリエイターが写して使うので、置き換えない。"""
        self.run_convert()
        template = self.text("skills/demo/assets/template/com.github.copilot/agents/t.agent.md")
        self.assertIn("`task` と `ask_user` と `demo-plugin_plan`", template)
        self.assertIn("model: [gpt-6-luna]", template)
        self.assertEqual(self.text("skills/demo/scripts/run.py"), "# `task` はスクリプトの中\n")

    def test_4_the_template_at_the_root_is_copied_and_not_replaced(self):
        """直下の template/ は、クリエイターが写して生成プラグインにするひな形。Copilot CLI 向けのまま、そのまま写す。"""
        self.run_convert()
        template = self.text("template/com.github.copilot/agents/t.agent.md")
        self.assertIn("`task` と `ask_user` と `demo-plugin_plan`", template)
        self.assertIn("model: [gpt-6-luna]", template)
        with open(os.path.join(self.src, "template", "com.github.copilot", "agents", "t.agent.md"), encoding="utf-8") as f:
            self.assertEqual(template, f.read())

    def test_4_a_skill_without_changes_keeps_its_frontmatter_text(self):
        write(self.src, "skills/plain/SKILL.md", "---\nname: plain\ndescription: \"引用符つき: コロン\"\n---\n普通の本文。\n")
        self.run_convert()
        self.assertEqual(self.text("skills/plain/SKILL.md"), "---\nname: plain\ndescription: \"引用符つき: コロン\"\n---\n普通の本文。\n")

    def test_4_allowed_tools_of_a_skill_become_a_list_of_claude_code_names(self):
        self.run_convert()
        meta, _ = frontmatter_of(self.at("skills/demo/SKILL.md"))
        self.assertEqual(meta["allowed-tools"], ["Bash", "Read", "Bash(git add:*)", "mcp__demo-plugin__open"])
        self.assertEqual(meta["name"], "demo")


class Mcp(Base):
    def test_4_mcp_json_becomes_dot_mcp_json_with_claude_code_variables_and_types(self):
        self.run_convert()
        servers = self.json(".mcp.json")["mcpServers"]
        self.assertEqual(servers["calc"]["args"], ["${CLAUDE_PLUGIN_ROOT}/mcp/calc.py"])
        self.assertEqual(servers["calc"]["env"], {"DATA": "${CLAUDE_PLUGIN_DATA}/calc"})
        self.assertEqual(servers["calc"]["type"], "stdio")
        self.assertEqual(servers["remote"]["type"], "http")
        self.assertEqual(servers["feed"]["type"], "sse")
        self.assertFalse(os.path.exists(self.at("mcp.json")))
        self.assertTrue(os.path.isfile(self.at("mcp/calc.py")))

    def test_4_cwd_is_kept_with_a_warning_because_claude_code_support_is_unconfirmed(self):
        self.run_convert()
        self.assertTrue(any("cwd" in w for w in self.report["warnings"]))


class Hooks(Base):
    def hooks(self):
        self.run_convert()
        return self.json("hooks/hooks.json")["hooks"]

    def test_4_event_names_and_command_items_are_replaced(self):
        hooks = self.hooks()
        self.assertIn("SessionStart", hooks)
        self.assertEqual(hooks["SessionStart"][0]["hooks"][0], {"type": "command", "command": "echo start"})
        first = hooks["PreToolUse"][0]
        self.assertEqual(first["matcher"], "Bash|Edit")
        self.assertEqual(first["hooks"][0], {"type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/guard.sh", "timeout": 10})

    def test_4_exec_form_args_and_the_timeout_alias_are_handled(self):
        second = self.hooks()["PreToolUse"][1]["hooks"][0]
        self.assertEqual(second, {"type": "command", "command": "python3", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/g.py"], "timeout": 5})

    def test_4_a_powershell_only_entry_is_kept_as_a_powershell_command(self):
        third = self.hooks()["PreToolUse"][2]["hooks"][0]
        self.assertEqual(third, {"type": "command", "command": "guard.ps1", "shell": "powershell"})

    def test_4_unsupported_hook_types_and_events_are_dropped_with_a_warning(self):
        hooks = self.hooks()
        self.assertEqual(len(hooks["PreToolUse"]), 3)  # http 型は置き換えない
        self.assertNotIn("somethingNew", hooks)
        self.assertTrue(any("http" in w for w in self.report["warnings"]))
        self.assertTrue(any("somethingNew" in w for w in self.report["warnings"]))


class Others(Base):
    def test_4_rules_are_collected_into_the_eval_folder(self):
        self.run_convert()
        self.assertEqual(self.report["rules_file"], ".eval/rules.md")
        text = self.text(".eval/rules.md")
        self.assertIn("規則その1", text)
        self.assertIn("規則その2", text)

    def test_4_no_rules_file_without_rules(self):
        shutil.rmtree(os.path.join(self.src, "com.github.copilot", "rules"))
        self.run_convert()
        self.assertIsNone(self.report["rules_file"])
        self.assertFalse(os.path.exists(self.at(".eval/rules.md")))

    def test_4_commands_and_lsp_are_moved(self):
        self.run_convert()
        self.assertTrue(os.path.isfile(self.at("commands/hello.md")))
        self.assertEqual(self.json(".lsp.json"), {"x": {"command": "${CLAUDE_PLUGIN_ROOT}/lsp"}})

    def test_4_extensions_are_removed_and_recorded(self):
        self.run_convert()
        self.assertFalse(os.path.exists(self.at("com.github.copilot")))
        self.assertEqual(self.report["extensions"], [{"name": "demo-plugin", "server": "demo-plugin"}])
        self.assertTrue(any("com.github.copilot/extensions/demo-plugin/" in c for c in self.report["changes"]))

    def test_4_the_extension_tools_are_listed_for_the_harness(self):
        self.run_convert()
        rows = {row["from"]: row for row in self.report["extension_tools"]}
        self.assertEqual(set(rows), {"demo-plugin_plan", "demo-plugin_show", "demo-plugin_open", "demo-plugin_state"})
        plan = rows["demo-plugin_plan"]
        self.assertEqual((plan["to"], plan["server"], plan["tool"]), ("mcp__demo-plugin__plan", "demo-plugin", "plan"))
        self.assertIn("agents/orchestrator.agent.md", plan["where"])
        self.assertEqual(self.json(".eval/conversion-report.json")["extension_tools"], self.report["extension_tools"])

    def test_4_the_agents_are_listed_with_the_models_for_the_harness(self):
        self.run_convert()
        agents = {row["name"]: row for row in self.report["agents"]}
        self.assertEqual(set(agents), {"orchestrator", "worker", "verifier", "free", "team--deep"})
        self.assertEqual(agents["worker"]["file"], "agents/worker.md")
        self.assertEqual(agents["worker"]["copilot_model"], ["gpt-6-luna", "claude-haiku-5.5"])
        self.assertEqual(agents["worker"]["model"], "claude-haiku-5-5")

    def test_4_an_extension_name_with_a_dot_gets_a_safe_server_name_in_every_place(self):
        shutil.move(os.path.join(self.src, "com.github.copilot", "extensions", "demo-plugin"),
                    os.path.join(self.src, "com.github.copilot", "extensions", "demo.plugin"))
        write(self.src, "skills/demo/references/a.md", "`demo.plugin_state`\n")
        self.run_convert()
        self.assertIn("`mcp__demo_plugin__state`", self.text("skills/demo/references/a.md"))
        row = [r for r in self.report["extension_tools"] if r["from"] == "demo.plugin_state"][0]
        self.assertEqual((row["extension"], row["server"]), ("demo.plugin", "demo_plugin"))

    def test_4_the_conversion_is_the_same_every_time(self):
        self.run_convert()
        first = {}
        for dirpath, _, files in os.walk(self.out):
            for name in files:
                path = os.path.join(dirpath, name)
                with open(path, "rb") as f:
                    first[os.path.relpath(path, self.out)] = f.read()
        self.run_convert()
        second = {}
        for dirpath, _, files in os.walk(self.out):
            for name in files:
                path = os.path.join(dirpath, name)
                with open(path, "rb") as f:
                    second[os.path.relpath(path, self.out)] = f.read()
        self.assertEqual(first, second)


class WhatIsCopied(Base):
    def test_REQ_037_the_conversation_examples_are_removed(self):
        """変換スクリプトは、置き換えた版から会話例（examples/）を外す。クリエイターが読むと、別の分野に例の決まりを持ち込むため。"""
        self.run_convert()
        self.assertFalse(os.path.exists(self.at("examples")))
        for dirpath, dirnames, files in os.walk(self.out):
            self.assertNotIn("talk.md", files)

    def test_the_folder_of_the_unseen_simulated_users_is_never_copied(self):
        self.run_convert()
        for dirpath, dirnames, files in os.walk(self.out):
            self.assertNotIn("heldout", dirnames, dirpath)
            self.assertNotIn("secret.md", files)
            self.assertNotIn("deep.md", files)

    def test_the_folder_of_the_unseen_simulated_users_is_never_opened_or_listed(self):
        """tests/ は入り口で外れるので、中を一覧しない。heldout を一覧したり開いたりしたら不合格。"""
        seen = []
        real_scandir, real_open = os.scandir, open

        def scandir(path="."):
            seen.append(os.fspath(path))
            return real_scandir(path)

        def opening(file, *args, **kwargs):
            seen.append(os.fspath(file) if isinstance(file, (str, bytes, os.PathLike)) else "")
            return real_open(file, *args, **kwargs)

        with mock.patch("os.scandir", scandir), mock.patch("builtins.open", opening):
            self.run_convert()
        source_side = [p for p in seen if isinstance(p, str) and p.startswith(self.src)]
        self.assertTrue(source_side)
        self.assertEqual([p for p in source_side if "heldout" in p], [])
        self.assertEqual([p for p in source_side if os.path.join(self.src, "tests") in p], [])
        self.assertEqual([p for p in source_side if os.path.join(self.src, "wip") in p], [])

    def test_development_files_and_caches_are_not_copied(self):
        self.run_convert()
        for rel in ("tests", "docs", "wip", ".git", ".github", ".claude", "CLAUDE.md", ".gitignore", "plugin.json",
                    "scripts/__pycache__", "com.github.copilot"):
            self.assertFalse(os.path.exists(self.at(rel)), rel)

    def test_files_a_plugin_needs_are_copied(self):
        self.run_convert()
        for rel in ("README.md", "scripts/helper.py", "mcp/calc.py", "skills/demo/SKILL.md",
                    "skills/demo/assets/template/com.github.copilot/agents/t.agent.md", "skills/demo/scripts/run.py",
                    "template/com.github.copilot/agents/t.agent.md"):
            self.assertTrue(os.path.isfile(self.at(rel)), rel)

    def test_a_symbolic_link_is_not_followed_or_copied(self):
        outside = os.path.join(self.tmp, "outside")
        write(outside, "x.md", "外\n")
        os.symlink(outside, os.path.join(self.src, "linked"))
        os.symlink(os.path.join(outside, "x.md"), os.path.join(self.src, "x-link.md"))
        self.run_convert()
        self.assertFalse(os.path.lexists(self.at("linked")))
        self.assertFalse(os.path.lexists(self.at("x-link.md")))
        self.assertTrue(any("linked" in w for w in self.report["warnings"]))

    def test_the_source_is_not_changed(self):
        def snapshot():
            data = {}
            for dirpath, _, files in os.walk(self.src):
                for name in files:
                    path = os.path.join(dirpath, name)
                    with open(path, "rb") as f:
                        data[path] = f.read()
            return data
        before = snapshot()
        self.run_convert()
        self.assertEqual(snapshot(), before)


class Refusals(Base):
    def test_a_folder_without_plugin_json_is_refused(self):
        os.remove(os.path.join(self.src, "plugin.json"))
        with self.assertRaises(convert.Refusal):
            self.run_convert()

    def test_a_plugin_json_without_a_name_or_with_broken_json_is_refused(self):
        write(self.src, "plugin.json", json.dumps({"version": "1.0.0"}))
        with self.assertRaises(convert.Refusal):
            self.run_convert()
        write(self.src, "plugin.json", "{ broken")
        with self.assertRaises(convert.Refusal):
            self.run_convert()
        self.assertFalse(os.path.exists(self.out))

    def test_the_final_check_runs_in_every_conversion(self):
        with mock.patch.object(convert, "check_clean") as check:
            self.run_convert()
        check.assert_called_once_with(self.out)

    def test_an_existing_folder_that_is_not_an_old_output_is_refused_and_left_alone(self):
        write(self.out, "mine.txt", "消さない\n")
        with self.assertRaises(convert.Refusal):
            self.run_convert()
        self.assertTrue(os.path.isfile(self.at("mine.txt")))

    def test_an_old_output_is_replaced(self):
        self.run_convert()
        write(self.out, "stale.txt", "古い\n")
        self.run_convert()
        self.assertFalse(os.path.exists(self.at("stale.txt")))
        self.assertTrue(os.path.isfile(self.at(".claude-plugin/plugin.json")))

    def test_the_output_inside_the_source_or_the_source_inside_the_output_is_refused(self):
        for out in (os.path.join(self.src, "out"), self.src, self.tmp):
            with self.assertRaises(convert.Refusal):
                convert.convert(self.src, out, validate=False)
        self.assertTrue(os.path.isfile(os.path.join(self.src, "plugin.json")))

    def test_an_old_output_that_contains_the_source_is_refused_and_the_source_survives(self):
        """OUT が前の出力に見えても、SRC を含むなら消さない（消すと元のプラグインがなくなる）。"""
        write(self.tmp, ".eval/conversion-report.json", "{}")
        with self.assertRaises(convert.Refusal):
            convert.convert(self.src, self.tmp, validate=False)
        self.assertTrue(os.path.isfile(os.path.join(self.src, "plugin.json")))

    def test_the_final_check_refuses_an_output_that_holds_examples_or_unseen_simulated_users(self):
        """写さない決まりが破れたときの最後の砦。"""
        for rel in ("examples/a.md", "x/heldout/b.md"):
            folder = os.path.join(self.tmp, "check-" + rel.replace("/", "-"))
            write(folder, rel, "x\n")
            with self.assertRaises(convert.Refusal):
                convert.check_clean(folder)
        clean = os.path.join(self.tmp, "check-clean")
        write(clean, "skills/a/SKILL.md", "x\n")
        convert.check_clean(clean)

    def test_the_command_line_returns_2_for_a_refusal_and_prints_the_reason(self):
        os.remove(os.path.join(self.src, "plugin.json"))
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = convert.main([self.src, self.out])
        self.assertEqual(code, 2)
        self.assertFalse(json.loads(buffer.getvalue())["ok"])


@unittest.skipUnless(HAVE_CLAUDE, "claude コマンドがない")
class Validate(Base):
    def test_4_the_converted_fixture_passes_claude_plugin_validate(self):
        report = self.run_convert(validate=True)
        self.assertTrue(report["validate"]["ran"])
        self.assertTrue(report["validate"]["ok"], report["validate"].get("output"))
        self.assertEqual(self.json(".eval/conversion-report.json")["validate"]["ok"], True)

    def test_4_the_command_line_returns_0_and_prints_a_summary(self):
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = convert.main([self.src, self.out])
        self.assertEqual(code, 0, buffer.getvalue())
        summary = json.loads(buffer.getvalue())
        self.assertTrue(summary["ok"])
        self.assertEqual(summary["plugin"], "demo-plugin")
        self.assertTrue(summary["validate"]["ok"])

    def test_4_a_conversion_that_fails_validation_returns_1_and_shows_the_output(self):
        write(self.src, "plugin.json", json.dumps(dict(MANIFEST, homepage="not a url")))
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = convert.main([self.src, self.out])
        self.assertEqual(code, 1)
        summary = json.loads(buffer.getvalue())
        self.assertFalse(summary["ok"])
        self.assertIn("homepage", summary["validate_output"])
        self.assertTrue(os.path.isdir(self.out), "不合格でも置き換えた版は残す（直す手がかりにする）")

    def test_4_claude_code_loads_the_converted_agents_and_skill_under_the_plugin_name(self):
        self.run_convert()
        init = claude_init_message(self.out)
        self.assertIsNotNone(init, "claude が起動しなかった")
        self.assertIn("demo-plugin", [p["name"] for p in init["plugins"]])
        for name in ("orchestrator", "worker", "verifier", "free", "team--deep"):
            self.assertIn(f"demo-plugin:{name}", init["agents"])
        self.assertIn("demo-plugin:demo", init["skills"])

    def test_4_warnings_of_the_validator_do_not_fail(self):
        """作者の情報がない、README がない、などは警告で、不合格にしない。"""
        write(self.src, "plugin.json", json.dumps({"name": "demo-plugin"}))
        os.remove(os.path.join(self.src, "README.md"))
        report = self.run_convert(validate=True)
        self.assertTrue(report["validate"]["ok"], report["validate"].get("output"))
        self.assertIn("warning", report["validate"]["output"].lower())


def claude_init_message(plugin_dir, timeout_sec=90):
    """claude -p を、つながらない接続先で起動し、最初の system/init のメッセージを返す。モデルは呼ばない。

    init には、読み込まれたプラグイン、エージェント（<プラグイン>:<名前>）、スキルが入っている。
    """
    home, work = tempfile.mkdtemp(prefix="d1a-home-"), tempfile.mkdtemp(prefix="d1a-work-")
    env = {"PATH": os.environ.get("PATH", ""), "HOME": home,
           "ANTHROPIC_BASE_URL": "http://127.0.0.1:9", "ANTHROPIC_API_KEY": "dummy-key-never-used"}
    proc = subprocess.Popen(
        ["claude", "-p", "--output-format", "stream-json", "--verbose", "--plugin-dir", plugin_dir,
         "--setting-sources", "", "--max-turns", "1", "hi"],
        cwd=work, env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding="utf-8")
    timer = threading.Timer(timeout_sec, proc.kill)
    timer.start()
    try:
        for line in proc.stdout:
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if message.get("type") == "system" and message.get("subtype") == "init":
                return message
        return None
    finally:
        timer.cancel()
        proc.kill()
        proc.wait()
        proc.stdout.close()
        shutil.rmtree(home, ignore_errors=True)
        shutil.rmtree(work, ignore_errors=True)


def node_json(code):
    done = subprocess.run(["node", "-e", code], capture_output=True, text=True, encoding="utf-8", timeout=60)
    if done.returncode != 0:
        raise AssertionError(done.stderr)
    return json.loads(done.stdout)


def import_names(module_path, expression):
    return node_json(
        f"import({json.dumps('file://' + module_path)}).then(m => console.log(JSON.stringify({expression})))")


class RealPlugins(unittest.TestCase):
    """クリエイター自身と、組み立ての見本で作った生成プラグインを置き換える。"""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="d1a-real-")
        cls.generated = cls.build_generated()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    @classmethod
    def build_generated(cls):
        folder = os.path.join(cls.tmp, "folder")
        work = os.path.join(folder, ".plugin-creator-work")
        os.makedirs(work)
        shutil.copytree(os.path.join(SAMPLE, "parts"), os.path.join(work, "parts"))
        state = os.path.join(cls.tmp, "hearing", "state.json")
        os.makedirs(os.path.dirname(state))
        shutil.copy(os.path.join(SAMPLE, "state.json"), state)
        out = os.path.join(folder, "weekly-report")
        done = subprocess.run([sys.executable, "-I", SCAFFOLD, "build", "--hearing", state, "--work", work, "--out", out],
                              capture_output=True, text=True, encoding="utf-8", timeout=300)
        if done.returncode != 0:
            raise AssertionError("組み立ての見本を組み立てられない:\n" + done.stdout + done.stderr)
        return out

    def convert_real(self, src, name, validate=True):
        out = os.path.join(self.tmp, name)
        return out, convert.convert(src, out, validate=validate)

    def assert_valid(self, report):
        if HAVE_CLAUDE:
            self.assertTrue(report["validate"]["ok"], report["validate"].get("output"))

    def assert_no_copilot_names_left(self, out, extension):
        """置き換えた版の本文に、Copilot CLI のエクステンションのツール名が残っていない。"""
        pattern = extension + "_"
        for dirpath, dirnames, files in os.walk(out):
            rel = os.path.relpath(dirpath, out)
            if not (rel == "agents" or rel == "skills" or rel.startswith("skills" + os.sep)):
                continue   # README などは置き換えない
            for name in files:
                if name.endswith(".md"):
                    path = os.path.join(dirpath, name)
                    with open(path, encoding="utf-8") as f:
                        text = f.read()
                    for line in text.splitlines():
                        bad = [w for w in line.replace("`", " ").split() if w.startswith(pattern)]
                        self.assertEqual(bad, [], f"{path}: {line}")

    def test_4_the_creator_itself_converts_and_passes_validate(self):
        out, report = self.convert_real(REPO, "creator")
        self.assert_valid(report)
        self.assertEqual(self.read_json(out, ".claude-plugin/plugin.json")["name"], "plugin-creator")
        self.assertEqual(sorted(a["name"] for a in report["agents"]), ["idea-reader", "idea-researcher", "idea-thinker", "reader", "worker"])
        for agent in report["agents"]:
            self.assertRegex(agent["model"], r"^(inherit|claude-[a-z]+-[0-9]+-[0-9]+)$")
        self.assertEqual(report["extensions"], [{"name": "plugin-creator", "server": "plugin-creator"}])
        self.assert_no_copilot_names_left(out, "plugin-creator")

    def test_REQ_037_the_converted_creator_has_no_examples_and_no_unseen_simulated_users(self):
        out, report = self.convert_real(REPO, "creator-clean", validate=False)
        for top in ("examples", "tests", "docs", "wip", ".git", "CLAUDE.md"):
            self.assertFalse(os.path.exists(os.path.join(out, top)), top)
        for dirpath, dirnames, _ in os.walk(out):
            self.assertNotIn("heldout", dirnames)
        self.assertTrue(os.path.isfile(os.path.join(out, "skills", "make-plugin", "SKILL.md")))
        self.assertTrue(os.path.isdir(os.path.join(out, "template")))
        self.assertFalse(os.path.exists(os.path.join(out, "skills", "make-plugin", "assets")))

    def test_4_the_creator_template_stays_in_the_copilot_format(self):
        """クリエイターが写して生成プラグインにするひな形は、置き換えない（生成プラグインは Copilot CLI 向けに作る）。"""
        out, _ = self.convert_real(REPO, "creator-template", validate=False)
        base = os.path.join(out, "template")
        for rel in ("com.github.copilot/agents/orchestrator.agent.md", "skills/_entry_/SKILL.md"):
            with open(os.path.join(base, *rel.split("/")), encoding="utf-8") as f, \
                    open(os.path.join(REPO, "template", *rel.split("/")), encoding="utf-8") as g:
                self.assertEqual(f.read(), g.read(), rel)

    def read_json(self, out, rel):
        with open(os.path.join(out, *rel.split("/")), encoding="utf-8") as f:
            return json.load(f)

    @unittest.skipUnless(HAVE_NODE, "node がない")
    def test_4_the_creator_extension_tools_match_the_tools_the_extension_registers(self):
        _, report = self.convert_real(REPO, "creator-tools", validate=False)
        registered = import_names(os.path.join(REPO, "com.github.copilot", "extensions", "plugin-creator", "tool-defs.mjs"),
                                  "m.TOOL_SHORT_NAMES")
        used = {row["tool"] for row in report["extension_tools"]}
        self.assertTrue(used)
        self.assertLessEqual(used, set(registered), "変換したツール名に、エクステンションが登録しないものがある")
        for row in report["extension_tools"]:
            self.assertEqual(row["server"], "plugin-creator")
            self.assertEqual(row["to"], f"mcp__plugin-creator__{row['tool']}")

    def test_4_the_generated_plugin_converts_and_passes_validate(self):
        out, report = self.convert_real(self.generated, "generated")
        self.assert_valid(report)
        self.assertEqual(self.read_json(out, ".claude-plugin/plugin.json")["name"], "weekly-report")
        self.assertEqual(sorted(a["name"] for a in report["agents"]), ["orchestrator", "verifier", "worker"])
        models = {a["name"]: a["model"] for a in report["agents"]}
        self.assertEqual(models, {"orchestrator": "claude-sonnet-5-5", "verifier": "claude-sonnet-5-5", "worker": "claude-haiku-5-5"})
        for top in ("tests", "docs", "com.github.copilot"):
            self.assertFalse(os.path.exists(os.path.join(out, top)), top)
        self.assertTrue(os.path.isdir(os.path.join(out, "scripts")))
        self.assert_no_copilot_names_left(out, "weekly-report")

    @unittest.skipUnless(HAVE_CLAUDE, "claude コマンドがない")
    def test_4_claude_code_loads_the_converted_creator_and_generated_plugin(self):
        out, _ = self.convert_real(REPO, "creator-load", validate=False)
        init = claude_init_message(out)
        self.assertIsNotNone(init, "claude が起動しなかった")
        self.assertIn("plugin-creator:reader", init["agents"])
        self.assertIn("plugin-creator:worker", init["agents"])
        self.assertIn("plugin-creator:make-plugin", init["skills"])
        self.assertIn("plugin-creator:test-plugin", init["skills"])
        out, _ = self.convert_real(self.generated, "generated-load", validate=False)
        init = claude_init_message(out)
        self.assertIsNotNone(init, "claude が起動しなかった")
        for name in ("orchestrator", "worker", "verifier"):
            self.assertIn(f"weekly-report:{name}", init["agents"])
        self.assertIn("weekly-report:weekly-report", init["skills"])

    def test_4_the_generated_orchestrator_calls_agent_in_the_foreground_with_claude_code_arguments(self):
        out, _ = self.convert_real(self.generated, "generated-agent", validate=False)
        meta, body = frontmatter_of(os.path.join(out, "agents", "orchestrator.md"))
        self.assertIn("`subagent_type`", body)
        self.assertIn("`run_in_background`", body)
        self.assertIn("`false`", body)
        for old in ("`task`", "`agent_type`", '"sync"', '"background"', "`mode`"):
            self.assertNotIn(old, body)

    @unittest.skipUnless(HAVE_NODE, "node がない")
    def test_4_the_generated_extension_tools_match_the_tools_the_extension_registers(self):
        _, report = self.convert_real(self.generated, "generated-tools", validate=False)
        registered = import_names(os.path.join(self.generated, "com.github.copilot", "extensions", "weekly-report", "core", "tools.mjs"),
                                  "m.TOOL_DEFS.map(d => d.name)")
        used = {row["tool"] for row in report["extension_tools"]}
        self.assertTrue({"plan", "verdict", "open"} <= used)
        self.assertLessEqual(used, set(registered))
        # 作業・検証の定義の tools は、すべて MCP のツール名か Claude Code の名前になっている
        # （統括の定義には tools がない。下の別の試験）
        for name in ("worker", "verifier"):
            meta, _ = frontmatter_of(os.path.join(self.tmp, "generated-tools", "agents", name + ".md"))
            self.assertTrue(meta.get("tools"), name)
            for tool in meta["tools"].split(", "):
                self.assertTrue(tool.startswith("mcp__weekly-report__") or tool in
                                {"Agent", "Read", "Edit", "Write", "Grep", "Glob", "Bash", "WebFetch", "WebSearch"}, tool)

    def test_4_the_generated_orchestrator_has_no_tools_and_the_converter_adds_none(self):
        """生成プラグインの統括の定義には tools がない（Copilot CLI では全ツールを持ち、使ってよいツールの絞りは adapter.mjs のフックがする）。
        変換は、tools のないエージェントに tools を足さない（Claude Code では全ツールを継ぐ）。内側の EVAL で統括を絞るのは、内側のつなぎ口
        （tests/dev-eval/runner/inner-adapter.mjs。実行用のコピーの統括の定義に tools を書く）で、変換ではない。"""
        src_meta, _ = frontmatter_of(os.path.join(self.generated, "com.github.copilot", "agents", "orchestrator.agent.md"))
        self.assertNotIn("tools", src_meta)
        out, report = self.convert_real(self.generated, "generated-no-tools", validate=False)
        meta, _ = frontmatter_of(os.path.join(out, "agents", "orchestrator.md"))
        self.assertNotIn("tools", meta)
        self.assertFalse([w for w in report["warnings"] if "orchestrator" in w and "tools" in w], report["warnings"])


if __name__ == "__main__":
    unittest.main()
