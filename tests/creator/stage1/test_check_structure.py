"""1段目の構造の検査（template/tests/stage1/check_structure.py）そのものの試験。

クリエイターの開発の試験であり、ひな形（生成プラグイン）には入れない（生成プラグインの中では動かないため）。
合格する見本（samples/good）を一時フォルダに写し、わざと壊して、正しく不合格になるかを見る。
動かし方（リポジトリの根で）:  python3 -m unittest discover -s tests/creator/stage1 -p "test_*.py"
試験の名前には、確かめる要件の番号を入れる。
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
TEMPLATE = os.path.join(REPO, "template")
STAGE1 = os.path.join(TEMPLATE, "tests", "stage1")
TASK_SCHEMA = os.path.join(TEMPLATE, "com.github.copilot", "extensions", "_plugin_", "core", "task.schema.json")
GOOD = os.path.join(HERE, "samples", "good")
EXT = "com.github.copilot/extensions/sample-plugin"

sys.path.insert(0, STAGE1)
import check_structure as cs  # noqa: E402


class Sandbox(unittest.TestCase):
    """見本を一時フォルダに写して、1か所ずつ壊す土台。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.root = os.path.join(self.tmp, "plugin")
        shutil.copytree(GOOD, self.root)
        # 土台の task.schema.json は見本に持たず、ひな形のものを写して使う（二重に持つとずれるため）
        os.makedirs(self.path(EXT + "/core"))
        shutil.copy(TASK_SCHEMA, self.path(EXT + "/core/task.schema.json"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def path(self, rel):
        return os.path.join(self.root, *rel.split("/"))

    def read(self, rel):
        with open(self.path(rel), encoding="utf-8") as f:
            return f.read()

    def write(self, rel, text):
        os.makedirs(os.path.dirname(self.path(rel)), exist_ok=True)
        with open(self.path(rel), "w", encoding="utf-8") as f:
            f.write(text)

    def replace(self, rel, old, new):
        text = self.read(rel)
        self.assertIn(old, text, "見本に %r がない" % old)
        self.write(rel, text.replace(old, new, 1))

    def remove(self, rel):
        target = self.path(rel)
        shutil.rmtree(target) if os.path.isdir(target) and not os.path.islink(target) else os.remove(target)

    def edit_json(self, rel, change):
        data = json.loads(self.read(rel))
        change(data)
        self.write(rel, json.dumps(data, ensure_ascii=False, indent=2))

    def report(self, kind="generated"):
        return cs.run_checks(self.root, kind)

    def problems(self, check_id, kind="generated"):
        return {c.id: c for c in self.report(kind).checks}[check_id].errors

    def assertFailsWith(self, check_id, *snippets, **kw):
        problems = self.problems(check_id, kw.get("kind", "generated"))
        self.assertTrue(problems, "%s が不合格にならなかった" % check_id)
        for snippet in snippets:
            self.assertTrue(any(snippet in p for p in problems), "%r が理由にない: %r" % (snippet, problems))

    def assertPasses(self, check_id, kind="generated"):
        self.assertEqual([], self.problems(check_id, kind))


class GoodSample(Sandbox):
    def test_REQ_039_good_sample_passes_every_check(self):
        report = self.report()
        self.assertTrue(report.ok, [c.errors for c in report.checks if c.errors])
        self.assertEqual(set(cs.CATALOG), {c.id for c in report.checks})

    def test_REQ_042_cli_exit_code_and_json_report(self):
        script = os.path.join(STAGE1, "check_structure.py")
        ok = subprocess.run([sys.executable, "-I", script, self.root, "--json"], capture_output=True)
        self.assertEqual(0, ok.returncode)
        self.assertTrue(json.loads(ok.stdout.decode("utf-8"))["ok"])
        self.remove("plugin.json")
        ng = subprocess.run([sys.executable, "-I", script, self.root, "--json"], capture_output=True)
        self.assertEqual(1, ng.returncode)
        report = json.loads(ng.stdout.decode("utf-8"))
        self.assertFalse(report["ok"])
        self.assertTrue(any("plugin.json がない" in f["reason"] for f in report["failures"]))

    def test_REQ_004_kind_plugin_runs_only_the_official_checks(self):
        ids = {c.id for c in self.report("plugin").checks}
        self.assertEqual({"manifest", "mcp", "skills", "references", "agents", "layout", "symlinks"}, ids)

    def test_REQ_039_every_check_title_names_its_requirement_where_it_has_one(self):
        for check_id, (reqs, _) in cs.CATALOG.items():
            for req in reqs:
                self.assertIn(req, cs.check_title(check_id))

    def test_REQ_039_no_check_title_carries_a_number_missing_from_the_generated_plugin_requirements(self):
        # 試験の名前の番号は、生成プラグインの仕様書（template/docs/specs/requirements.md）にある番号だけにする。
        # ナレッジの番号の突き合わせは、生成プラグインの要件ではなく設計書 7章の試験なので、番号の代わりに節を付ける
        with open(os.path.join(TEMPLATE, "docs", "specs", "requirements.md"), encoding="utf-8") as f:
            spec = f.read()
        for check_id in cs.CATALOG:
            for req in cs.CATALOG[check_id][0]:
                self.assertIn("### %s " % req, spec, "%s の試験の名前の %s が、生成プラグインの仕様書にない" % (check_id, req))
        self.assertIn("設計書 7章", cs.check_title("knowledge"))


class Manifest(Sandbox):
    def test_REQ_004_missing_plugin_json_fails(self):
        self.remove("plugin.json")
        self.assertFailsWith("manifest", "plugin.json がない")

    def test_REQ_004_wrong_schema_url_fails_and_explains_the_silent_fallback(self):
        self.edit_json("plugin.json", lambda d: d.update({"$schema": "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json"}))
        self.assertFailsWith("manifest", "$schema", "以前の形式")

    def test_REQ_004_missing_schema_key_fails(self):
        self.edit_json("plugin.json", lambda d: d.pop("$schema"))
        self.assertFailsWith("manifest", "必須の項目がない", "$schema")

    def test_REQ_004_path_keys_are_not_allowed_in_the_manifest(self):
        self.edit_json("plugin.json", lambda d: d.update({"skills": "./skills"}))
        self.assertFailsWith("manifest", "決まりにない項目", "skills")

    def test_REQ_004_name_must_be_lowercase_and_short(self):
        self.edit_json("plugin.json", lambda d: d.update({"name": "Sample_Plugin"}))
        self.assertFailsWith("manifest", "name", "形の決まり")

    def test_REQ_004_repository_must_be_a_string(self):
        self.edit_json("plugin.json", lambda d: d.update({"repository": {"url": "https://example.com"}}))
        self.assertFailsWith("manifest", "repository", "型")

    def test_REQ_004_broken_json_fails(self):
        self.write("plugin.json", "{ not json")
        self.assertFailsWith("manifest", "JSON として読めない")


class Mcp(Sandbox):
    SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"

    def put(self, servers, schema=None):
        self.write("mcp.json", json.dumps({"$schema": schema or self.SCHEMA, "mcpServers": servers}))

    def test_REQ_004_valid_servers_pass(self):
        self.write("scripts/server.mjs", "")
        self.put({
            "local": {"type": "stdio", "command": "node", "args": ["${PLUGIN_ROOT}/scripts/server.mjs"],
                      "cwd": "${PLUGIN_ROOT}", "env": {"DATA": "${PLUGIN_DATA}/x"}},
            "data": {"type": "stdio", "command": "./scripts/server.mjs", "cwd": "${PLUGIN_DATA}/work"},
            "remote": {"type": "streamable-http", "url": "https://example.com/mcp", "headers": {"Authorization": "x"}},
            "loop": {"type": "sse", "url": "http://127.0.0.1:8080/sse"},
            "loop6": {"type": "sse", "url": "http://localhost:8080/sse"},
        })
        self.assertPasses("mcp")

    def test_REQ_004_command_must_be_one_word(self):
        self.put({"s": {"type": "stdio", "command": "node server.js"}})
        self.assertFailsWith("mcp", "1語")

    def test_REQ_004_command_path_must_start_with_dot_slash_and_exist(self):
        self.put({"a": {"type": "stdio", "command": "bin/run"}, "b": {"type": "stdio", "command": "./missing"}})
        self.assertFailsWith("mcp", "素の名前か ./", "見つからない")

    def test_REQ_004_command_is_not_expanded(self):
        self.put({"s": {"type": "stdio", "command": "${PLUGIN_ROOT}/run"}})
        self.assertFailsWith("mcp", "展開されない")

    def test_REQ_004_args_must_point_to_existing_files_inside_the_root(self):
        self.put({"a": {"type": "stdio", "command": "node", "args": ["${PLUGIN_ROOT}/nothing.mjs"]},
                  "b": {"type": "stdio", "command": "node", "args": ["${PLUGIN_ROOT}/../outside.mjs"]}})
        self.assertFailsWith("mcp", "nothing.mjs", "根の外")

    def test_REQ_004_cwd_must_stay_inside_the_root_or_plugin_data(self):
        self.put({"a": {"type": "stdio", "command": "node", "cwd": "${PLUGIN_ROOT}/../x"},
                  "b": {"type": "stdio", "command": "node", "cwd": "${PLUGIN_DATA}/../x"},
                  "c": {"type": "stdio", "command": "node", "cwd": "./../x"}})
        problems = self.problems("mcp")
        self.assertEqual(3, len([p for p in problems if "cwd" in p and "外に出る" in p]), problems)

    def test_REQ_004_cwd_must_start_with_an_allowed_prefix(self):
        self.put({"a": {"type": "stdio", "command": "node", "cwd": "/tmp"}})
        self.assertFailsWith("mcp", "cwd")

    def test_REQ_004_http_is_only_for_loopback(self):
        self.put({"s": {"type": "streamable-http", "url": "http://example.com/mcp"}})
        self.assertFailsWith("mcp", "https")

    def test_REQ_004_url_must_be_absolute_without_user_info_or_fragment(self):
        self.put({"a": {"type": "sse", "url": "/relative"},
                  "b": {"type": "sse", "url": "https://user:pw@example.com/x"},
                  "c": {"type": "sse", "url": "https://example.com/x#frag"},
                  "d": {"type": "sse", "url": "ftp://example.com/x"}})
        problems = self.problems("mcp")
        self.assertEqual(4, len(problems), problems)

    def test_REQ_004_mcp_version_must_match_plugin_json(self):
        self.put({}, schema="https://agent-plugins.org/schemas/1.1.0/mcp.schema.json")
        self.assertFailsWith("mcp", "版 1.1.0", "plugin.json の版 1.0.0")

    def test_REQ_004_header_names_must_not_collide_ignoring_case(self):
        self.put({"s": {"type": "sse", "url": "https://example.com/x", "headers": {"Authorization": "a", "authorization": "b"}}})
        self.assertFailsWith("mcp", "重なっている")

    def test_REQ_004_legacy_mcp_fields_are_rejected_by_the_schema(self):
        self.put({"s": {"type": "stdio", "command": "node", "timeout": 5, "tools": ["*"]}})
        self.assertFailsWith("mcp", "決まりにない項目", "timeout")

    def test_REQ_004_legacy_http_type_is_rejected(self):
        self.put({"s": {"type": "http", "url": "https://example.com/x"}})
        self.assertTrue(self.problems("mcp"))


class Skills(Sandbox):
    SKILL = "skills/sample-entry/SKILL.md"

    def test_REQ_004_name_must_match_the_folder(self):
        self.replace(self.SKILL, "name: sample-entry", "name: other")
        self.assertFailsWith("skills", "フォルダの名前")

    def test_REQ_004_name_rules(self):
        self.replace(self.SKILL, "name: sample-entry", "name: Sample--Entry")
        self.assertFailsWith("skills", "小文字の英数字とハイフン")

    def test_REQ_004_description_is_required(self):
        self.replace(self.SKILL, "description: 見本の作業を頼まれたときに使う入口のスキル。\n", "")
        self.assertFailsWith("skills", "description がない")

    def test_REQ_039_description_missing_names_where_it_does_not_fit(self):
        # 試験の要件の受け入れ基準：スキルのフロントマターに必須の項目がないと、どこが合わないかが分かる
        self.replace(self.SKILL, "name: sample-entry\n", "")
        self.assertFailsWith("skills", "skills/sample-entry/SKILL.md", "name がない")

    def test_REQ_004_description_length_limit(self):
        self.replace(self.SKILL, "description: 見本の作業を頼まれたときに使う入口のスキル。", "description: " + "あ" * 1025)
        self.assertFailsWith("skills", "1025 文字")

    def test_REQ_004_frontmatter_is_required(self):
        self.write(self.SKILL, "# 見出しだけ\n")
        self.assertFailsWith("skills", "フロントマター")

    def test_REQ_004_yaml_error_is_reported(self):
        self.replace(self.SKILL, "description: 見本の作業を頼まれたときに使う入口のスキル。", "description: 使う: とき: に")
        self.assertFailsWith("skills", "YAML")

    def test_REQ_004_only_agent_skills_fields_are_allowed(self):
        for key in ("user-invocable: true", "disable-model-invocation: true", "argument-hint: x", "model: haiku"):
            text = self.read(self.SKILL)
            self.replace(self.SKILL, "name: sample-entry\n", "name: sample-entry\n%s\n" % key)
            self.assertFailsWith("skills", key.split(":")[0], "Agent Skills の項目にない")
            self.write(self.SKILL, text)

    def test_REQ_004_license_compatibility_and_metadata_are_allowed(self):
        self.replace(self.SKILL, "name: sample-entry\n",
                     "name: sample-entry\nlicense: MIT\ncompatibility: Copilot CLI\nmetadata:\n  version: \"1\"\n")
        self.assertPasses("skills")

    def test_REQ_004_allowed_tools_is_a_warning_because_it_grants_tools_without_asking(self):
        self.replace(self.SKILL, "name: sample-entry\n", "name: sample-entry\nallowed-tools: Bash\n")
        self.assertPasses("skills")
        warnings = {c.id: c.warnings for c in self.report().checks}["skills"]
        self.assertTrue(any("allowed-tools" in w and "確認なし" in w for w in warnings))

    def test_REQ_004_description_must_not_hold_xml_tags(self):
        self.replace(self.SKILL, "入口のスキル。", "<b>入口</b>のスキル。")
        self.assertFailsWith("skills", "< や >")

    def test_REQ_004_description_must_not_start_with_i_can(self):
        self.replace(self.SKILL, "description: 見本の作業", "description: I can run the sample. 見本の作業")
        self.assertFailsWith("skills", "I can")

    def test_REQ_004_long_body_is_only_a_warning(self):
        self.write(self.SKILL, self.read(self.SKILL) + "行\n" * 500)
        self.assertPasses("skills")
        self.assertTrue(any("500 行" in w for w in {c.id: c.warnings for c in self.report().checks}["skills"]))

    def test_REQ_004_folder_without_skill_md_is_only_a_warning(self):
        os.makedirs(self.path("skills/empty"))
        self.assertPasses("skills")

    def test_REQ_004_generated_plugin_needs_an_entry_skill(self):
        self.remove("skills")
        self.assertFailsWith("skills", "入口のスキル")
        self.assertEqual([], self.problems("skills", kind="plugin"))

    def test_REQ_004_metadata_must_map_strings_to_strings(self):
        self.replace(self.SKILL, "name: sample-entry\n", "name: sample-entry\nmetadata:\n  version: 1\n")
        self.assertFailsWith("skills", "metadata")


class Agents(Sandbox):
    WORKER = "com.github.copilot/agents/worker.agent.md"

    def test_REQ_004_description_is_required(self):
        self.replace(self.WORKER, "description: 見本の作業エージェント。成果物を書く。\n", "")
        self.assertFailsWith("agents", "worker.agent.md", "description がない")

    def test_REQ_004_model_may_be_one_name_or_a_preference_list(self):
        self.replace(self.WORKER, "tools:", "model: claude-haiku-5.5\ntools:")
        self.assertPasses("agents")
        self.replace(self.WORKER, "model: claude-haiku-5.5", "model: [gpt-6-luna, claude-haiku-5.5]")
        self.assertPasses("agents")

    def test_REQ_004_model_must_be_names(self):
        self.replace(self.WORKER, "tools:", "model: 5\ntools:")
        self.assertFailsWith("agents", "model")
        self.replace(self.WORKER, "model: 5", "model: []")
        self.assertFailsWith("agents", "model")

    def test_REQ_004_fields_not_yet_verified_are_accepted_with_a_warning(self):
        for line in ("models: [gpt-6-luna]", "model-policy: preferred", "modelPolicy: preferred", "reasoningEffort: low",
                     "include-custom-instructions: true", "infer: true", "user-invocable: true"):
            text = self.read(self.WORKER)
            self.replace(self.WORKER, "tools:", line + "\ntools:")
            self.assertPasses("agents")
            key = line.split(":")[0]
            self.assertTrue(any(key in w and "書かない決まり" in w for w in {c.id: c.warnings for c in self.report().checks}["agents"]), key)
            self.write(self.WORKER, text)

    def test_REQ_004_agent_started_by_task_may_not_disable_model_invocation(self):
        self.replace(self.WORKER, "tools:", "disable-model-invocation: true\ntools:")
        self.assertFailsWith("agents", "disable-model-invocation", "起動が断られる")

    def test_REQ_004_name_must_be_absent_or_equal_to_the_id(self):
        self.replace(self.WORKER, "tools:", "name: worker\ntools:")
        self.assertPasses("agents")
        self.replace(self.WORKER, "name: worker", "name: helper")
        self.assertFailsWith("agents", "name 'helper'", "ID worker")

    def test_REQ_004_id_is_lowercase_letters_digits_and_hyphens(self):
        os.rename(self.path(self.WORKER), self.path("com.github.copilot/agents/Worker_Two.agent.md"))
        self.assertFailsWith("agents", "ID", "小文字")

    def test_REQ_004_agent_without_tools_is_a_warning(self):
        self.replace(self.WORKER, "tools: [read, edit, execute, search, sample-plugin_show]\n", "")
        self.assertPasses("agents")
        self.assertTrue(any("tools がない" in w for w in {c.id: c.warnings for c in self.report().checks}["agents"]))

    def test_REQ_004_unknown_tool_names_are_reported_because_they_are_silently_ignored(self):
        self.replace(self.WORKER, "tools: [read,", "tools: [Read, reed, other-plugin_x, sample-plugin_anything, read,")
        problems = self.problems("agents")
        self.assertEqual(2, len(problems), problems)
        self.assertTrue(any("reed" in p and "黙って無視される" in p for p in problems))
        self.assertTrue(any("other-plugin_x" in p for p in problems))

    def test_REQ_004_mcp_tools_must_name_a_known_server(self):
        self.replace(self.WORKER, "tools: [read,", "tools: [nope/tool, read,")
        self.assertFailsWith("agents", "nope/tool")
        self.write("mcp.json", json.dumps({"$schema": Mcp.SCHEMA, "mcpServers": {"nope": {"type": "stdio", "command": "node"}}}))
        self.assertPasses("agents")
        self.write("mcp.json", json.dumps({"$schema": Mcp.SCHEMA, "mcpServers": {}}))
        self.replace(self.WORKER, "tools: [nope/tool,", "mcp-servers:\n  nope:\n    type: local\n    command: node\ntools: [nope/*,")
        self.assertPasses("agents")

    def test_REQ_010_wildcard_and_skill_fail_in_any_agent(self):
        self.replace(self.WORKER, "tools: [read,", 'tools: ["*", Skill, read,')
        self.assertFailsWith("agents", "* がある", "skill がある")

    def test_REQ_004_unknown_field_is_a_warning(self):
        self.replace(self.WORKER, "tools:", "colour: red\ntools:")
        self.assertPasses("agents")
        self.assertTrue(any("colour" in w for w in {c.id: c.warnings for c in self.report().checks}["agents"]))

    def test_REQ_004_tools_must_be_text_or_a_list_of_text(self):
        self.replace(self.WORKER, "tools: [read, edit, execute, search, sample-plugin_show]", "tools: 5")
        self.assertFailsWith("agents", "tools")

    def test_REQ_004_body_has_a_length_limit(self):
        self.write(self.WORKER, self.read(self.WORKER) + "あ" * 30001)
        self.assertFailsWith("agents", "30000")

    def test_REQ_004_file_name_must_end_with_agent_md(self):
        self.write("com.github.copilot/agents/helper.md", "---\ndescription: x\n---\n")
        self.assertPasses("agents")
        self.assertTrue(any("helper.md" in w for w in {c.id: c.warnings for c in self.report().checks}["agents"]))


class References(Sandbox):
    SKILL = "skills/sample-entry/SKILL.md"

    def add(self, name, size=100):
        self.write("skills/sample-entry/references/" + name, "あ" * (size // 3))

    def mention(self, name):
        self.write(self.SKILL, self.read(self.SKILL) + "\nこの段階の始めに `references/%s` を読む。\n" % name)

    def test_REQ_004_no_references_folder_is_skipped(self):
        check = {c.id: c for c in self.report().checks}["references"]
        self.assertEqual("skipped", check.status)

    def test_REQ_004_small_and_named_reference_passes(self):
        self.add("stage1.md")
        self.mention("stage1.md")
        self.assertPasses("references")

    def test_REQ_004_reference_of_20kb_or_more_fails(self):
        self.add("big.md", 20001)
        self.mention("big.md")
        self.assertFailsWith("references", "big.md", "20KB 未満")
        self.add("big.md", 19998)
        self.assertPasses("references")

    def test_REQ_004_reference_not_named_in_the_body_fails(self):
        self.add("orphan.md")
        self.assertFailsWith("references", "orphan.md", "名指ししていない")

    def test_REQ_004_nested_references_folder_is_a_warning(self):
        self.add("deep/inner.md")
        self.mention("inner.md")
        check = {c.id: c for c in self.report().checks}["references"]
        self.assertEqual([], check.errors)
        self.assertTrue(any("入れ子" in w for w in check.warnings))


class Layout(Sandbox):
    def test_REQ_004_legacy_locations_are_rejected(self):
        for rel in ("agents", "commands", "rules", "hooks", "extensions", ".claude-plugin"):
            os.makedirs(self.path(rel), exist_ok=True)
        for rel in ("hooks.json", "lsp.json", ".mcp.json"):
            self.write(rel, "{}")
        self.write(".github/plugin/plugin.json", "{}")
        problems = self.problems("layout")
        self.assertEqual(10, len(problems), problems)

    def test_REQ_004_marketplace_json_is_allowed(self):
        self.write(".github/plugin/marketplace.json", "{}")
        self.assertPasses("layout")

    def test_REQ_004_unknown_place_in_com_github_copilot_fails(self):
        os.makedirs(self.path("com.github.copilot/skills"))
        self.assertFailsWith("layout", "com.github.copilot/skills")

    def test_REQ_004_extension_needs_an_entry_file(self):
        self.write("com.github.copilot/extensions/other/readme.txt", "x")
        self.assertFailsWith("layout", "extensions/other/", "extension.mjs")

    def test_REQ_004_loose_file_in_extensions_fails(self):
        self.write("com.github.copilot/extensions/loose.mjs", "")
        self.assertFailsWith("layout", "extensions/loose.mjs")

    def test_REQ_004_other_entry_file_names_are_accepted(self):
        os.rename(self.path(EXT + "/extension.mjs"), self.path(EXT + "/extension.cjs"))
        self.assertPasses("layout")


class Symlinks(Sandbox):
    def make_link(self, link, target):
        try:
            os.symlink(target, self.path(link))
        except (OSError, NotImplementedError):
            self.skipTest("この環境ではシンボリックリンクを作れない")

    def test_REQ_004_link_pointing_outside_the_root_fails(self):
        outside = os.path.join(self.tmp, "outside.txt")
        open(outside, "w").close()
        self.make_link("docs/escape.txt", outside)
        self.assertFailsWith("symlinks", "docs/escape.txt")

    def test_REQ_004_link_to_a_folder_outside_the_root_fails(self):
        self.make_link("docs/escape", self.tmp)
        self.assertFailsWith("symlinks", "docs/escape")

    def test_REQ_004_link_inside_the_root_passes(self):
        self.make_link("docs/readme-link.md", self.path("README.md"))
        self.assertPasses("symlinks")

    def make_real_venv(self):
        """python3 -m venv tests/.venv と同じ仮想環境を作る。bin/python は外の Python へのリンクになる（Windows ではコピーなので飛ばす）"""
        import venv
        target = self.path("tests/.venv")
        venv.create(target, with_pip=False, symlinks=True)
        links = [os.path.join(d, f) for d, _, fs in os.walk(target) for f in fs if os.path.islink(os.path.join(d, f))]
        outside = [p for p in links if not os.path.realpath(p).startswith(os.path.realpath(self.root))]
        if not outside:
            self.skipTest("この環境の仮想環境は、外の Python へのリンクを持たない")
        return outside

    def test_REQ_004_a_real_virtual_environment_in_tests_venv_does_not_fail_the_check(self):
        outside = self.make_real_venv()
        self.assertTrue(outside)   # 外を指すリンクが本当にある（調べていたら必ず不合格になっていた）
        self.assertPasses("symlinks")
        self.assertTrue(self.report().ok, [c.errors for c in self.report().checks if c.errors])

    def test_REQ_004_links_inside_tests_node_modules_are_not_checked(self):
        os.makedirs(self.path("tests/node_modules/pkg"))
        self.make_link("tests/node_modules/pkg/escape", self.tmp)
        self.make_link("tests/node_modules/escape-file", os.path.join(self.tmp, "nothing.txt"))
        self.assertPasses("symlinks")

    def test_REQ_004_only_those_two_folders_are_left_out(self):
        self.make_real_venv()
        outside = self.tmp
        for link in ("tests/other-escape", "tests/stage2/escape", "docs/escape", "tests/venv-like/escape", ".venv-escape"):
            os.makedirs(os.path.dirname(self.path(link)), exist_ok=True)
            self.make_link(link, outside)
        os.makedirs(self.path("node_modules"))
        self.make_link("node_modules/escape", outside)   # 根の直下の node_modules は、除く2つではない
        os.makedirs(self.path("tests/stage2/.venv"))
        self.make_link("tests/stage2/.venv/escape", outside)   # 名前が同じでも、tests/ の直下でなければ除かない
        problems = self.problems("symlinks")
        self.assertEqual(7, len(problems), problems)
        for link in ("tests/other-escape", "tests/stage2/escape", "docs/escape", "tests/venv-like/escape", ".venv-escape",
                     "node_modules/escape", "tests/stage2/.venv/escape"):
            self.assertTrue(any(p.startswith(link + ":") for p in problems), (link, problems))
        self.assertFalse(any("tests/.venv" in p for p in problems), problems)


class Task(Sandbox):
    TASK = EXT + "/task.json"

    def test_REQ_011_task_json_is_required(self):
        self.remove(self.TASK)
        self.assertFailsWith("task", "task.json がない")

    def test_REQ_011_schema_file_is_required(self):
        self.remove(EXT + "/core/task.schema.json")
        self.assertFailsWith("task", "task.schema.json がない")

    def test_REQ_011_extension_folder_must_be_named_after_the_plugin(self):
        shutil.move(self.path(EXT), self.path("com.github.copilot/extensions/renamed"))
        self.assertFailsWith("task", "task.json がない")

    def test_REQ_011_unknown_part_type_fails(self):
        self.edit_json(self.TASK, lambda d: d["settings"][0].update({"type": "slider"}))
        self.assertFailsWith("task", "settings/0/type", "slider")

    def test_REQ_011_setting_key_may_not_be_maxIterations(self):
        # 画面の「繰り返しの上限」の欄が同じ id（setting-maxIterations）になり、EVAL の画面の操作が失敗するため
        self.edit_json(self.TASK, lambda d: d["settings"][0].update({"key": "maxIterations"}))
        self.assertFailsWith("task", "settings/0/key", "'maxIterations' は使えない", "繰り返しの上限")
        self.edit_json(self.TASK, lambda d: d["settings"][0].update({"key": "maxIteration"}))
        self.assertPasses("task")
        self.edit_json(self.TASK, lambda d: d["settings"][0].update({"key": "maxiterations"}))
        self.assertPasses("task")

    def test_REQ_011_unknown_display_type_and_when_fail(self):
        self.edit_json(self.TASK, lambda d: d["displays"][0].update({"type": "chart", "when": "later"}))
        self.assertFailsWith("task", "displays/0/type", "displays/0/when")

    def test_REQ_011_required_fields(self):
        self.edit_json(self.TASK, lambda d: (d.pop("name"), d["criteria"][0].pop("knowledge")))
        self.assertFailsWith("task", "必須の項目がない: name", "必須の項目がない: knowledge")

    def test_REQ_011_unknown_field_fails(self):
        self.edit_json(self.TASK, lambda d: d.update({"title": "x"}))
        self.assertFailsWith("task", "決まりにない項目", "title")

    def test_REQ_011_criteria_may_not_be_empty(self):
        self.edit_json(self.TASK, lambda d: d.update({"criteria": []}))
        self.assertFailsWith("task", "criteria", "1 個以上")

    def test_REQ_011_iteration_limit_must_be_a_positive_integer(self):
        self.edit_json(self.TASK, lambda d: d.update({"maxIterationsDefault": 0}))
        self.assertFailsWith("task", "maxIterationsDefault")

    def test_REQ_011_criterion_and_knowledge_numbers_have_a_shape(self):
        self.edit_json(self.TASK, lambda d: d["criteria"][0].update({"id": "x1", "knowledge": "3"}))
        self.assertFailsWith("task", "criteria/0/id", "criteria/0/knowledge")

    def test_REQ_011_default_value_follows_the_part_type(self):
        self.edit_json(self.TASK, lambda d: d["settings"].append({"key": "n", "label": "回数", "type": "number", "default": "3"}))
        self.assertFailsWith("task", "default")
        self.edit_json(self.TASK, lambda d: d["settings"][-1].update({"default": 3}))
        self.assertPasses("task")

    def test_REQ_011_select_needs_options_and_a_default_among_them(self):
        self.edit_json(self.TASK, lambda d: d["settings"].append({"key": "mode", "label": "形", "type": "select"}))
        self.assertFailsWith("task", "必須の項目がない: options")
        self.edit_json(self.TASK, lambda d: d["settings"][-1].update({"options": ["a", "b"], "default": "c"}))
        self.assertFailsWith("task", "選択肢にない")
        self.edit_json(self.TASK, lambda d: d["settings"][-1].update({"default": "a"}))
        self.assertPasses("task")

    def test_REQ_011_duplicate_numbers_fail(self):
        def duplicate(d):
            d["criteria"].append(dict(d["criteria"][0]))
            d["settings"].append(dict(d["settings"][0]))
        self.edit_json(self.TASK, duplicate)
        self.assertFailsWith("task", "criteria の id C-01 が重なっている", "settings の key topic が重なっている")

    def test_REQ_011_worker_agent_file_must_exist(self):
        self.edit_json(self.TASK, lambda d: d["workers"].append({"agent": "worker-extra", "label": "もう1人"}))
        self.assertFailsWith("task", "worker-extra.agent.md がない")

    def test_REQ_011_worker_name_shape(self):
        self.edit_json(self.TASK, lambda d: d["workers"][0].update({"agent": "helper"}))
        self.assertFailsWith("task", "workers/0/agent")

    def test_REQ_011_broken_schema_file_is_reported(self):
        self.write(EXT + "/core/task.schema.json", json.dumps({"type": "nonsense"}))
        self.assertFailsWith("task", "スキーマ自体が誤っている")


class Eval(Sandbox):
    EVAL = "tests/eval/T-01/eval.json"

    def test_REQ_011_matching_copy_passes(self):
        self.assertPasses("eval")

    def test_REQ_011_changed_sentence_fails(self):
        self.edit_json(self.EVAL, lambda d: d["criteria"][0].update({"text": "成果物に題がある。"}))
        self.assertFailsWith("eval", "基準 C-01 の文が作業の定義と違う")

    def test_REQ_011_unknown_criterion_fails(self):
        self.edit_json(self.EVAL, lambda d: d["criteria"].append({"id": "C-09", "text": "x", "grading": "model"}))
        self.assertFailsWith("eval", "基準 C-09 が作業の定義にない")

    def test_REQ_011_criterion_never_copied_fails(self):
        self.edit_json("%s/task.json" % EXT, lambda d: d["criteria"].append({"id": "C-02", "text": "別の基準", "knowledge": "K-01"}))
        self.assertFailsWith("eval", "C-02", "どの EVAL の課題にも写されていない")

    def test_REQ_011_criterion_copied_in_another_task_is_enough(self):
        self.edit_json("%s/task.json" % EXT, lambda d: d["criteria"].append({"id": "C-02", "text": "別の基準", "knowledge": "K-01"}))
        self.write("tests/eval/T-02/eval.json", json.dumps({
            "id": "T-02", "prompt": "別の頼み", "inputs": [],
            "settings": {"task": {"topic": "天気"}},   # 作業の定義の「題材」は、必須で初めの値がないので、省かずに値を入れる
            "criteria": [{"id": "C-02", "text": "別の基準", "grading": "model"}]}))
        self.assertPasses("eval")

    def test_REQ_038_no_eval_task_fails(self):
        self.remove("tests/eval")
        self.assertFailsWith("eval", "EVAL の課題が1つも入っていない")

    def test_REQ_038_missing_input_file_fails(self):
        self.remove("tests/eval/T-01/inputs/memo.txt")
        self.assertFailsWith("eval", "入力のファイル inputs/memo.txt がない")

    def test_REQ_011_program_grading_needs_a_check(self):
        self.edit_json(self.EVAL, lambda d: d["criteria"][0].pop("check"))
        self.assertFailsWith("eval", "check")

    def test_REQ_011_grading_must_be_program_or_model(self):
        self.edit_json(self.EVAL, lambda d: d["criteria"][0].update({"grading": "human"}))
        self.assertFailsWith("eval", "grading")

    def test_REQ_011_check_type_and_its_items_are_read_like_the_grader_reads_them(self):
        def check(value):
            self.edit_json(self.EVAL, lambda d: d["criteria"][0].update({"check": value}))
        check({"type": "includes", "file": "out/*.md", "text": "x"})
        self.assertFailsWith("eval", "check.type「includes」は使えない", "file_exists・contains・not_contains・regex・unchanged")
        check({"type": "contains", "file": "out/*.md"})
        self.assertFailsWith("eval", "text がない（contains には要る）")
        check({"type": "contains", "file": "../out/*.md", "text": "x", "pattern": "y"})
        self.assertFailsWith("eval", ".. は使えない", "使わない項目「pattern」")
        check({"type": "file_exists", "file": "/etc/passwd"})
        self.assertFailsWith("eval", "絶対の場所は使えない")
        check({"type": "regex", "file": "out/*.md", "pattern": "x", "flags": "g"})
        self.assertFailsWith("eval", "flags は、i・m・s・u")

    def set_check(self, check, inputs=None):
        def edit(d):
            d["criteria"][0]["check"] = check
            if inputs is not None:
                d["inputs"] = inputs
        self.edit_json(self.EVAL, edit)

    HEADER_LINE = "#define DBG_LOG(fmt, ...) printf(fmt, ##__VA_ARGS__)"

    def test_REQ_011_a_check_that_the_unchanged_input_already_satisfies_fails_and_points_to_unchanged(self):
        self.write("tests/eval/T-01/inputs/src/dbg_log.h", self.HEADER_LINE + "\n")
        self.set_check({"type": "contains", "file": "inputs/src/dbg_log.h", "text": self.HEADER_LINE}, ["inputs/memo.txt", "inputs/src"])
        self.assertFailsWith("eval", "criteria[0].check は、課題の入力のファイルがもとのままでも合格してしまう",
                             "「inputs/src/dbg_log.h」に", "unchanged（file）で確かめる")
        for check in ({"type": "file_exists", "file": "inputs/**/*.h"},
                      {"type": "not_contains", "file": "inputs/src/*.h", "text": "TODO"}):
            self.set_check(check)
            self.assertFailsWith("eval", "もとのままでも合格してしまう")
        # 入力のままでは当てはまらない採点は通す
        for check in ({"type": "contains", "file": "inputs/src/dbg_log.h", "text": "DBG_LEVEL"},
                      {"type": "not_contains", "file": "inputs/src/*.h", "text": "printf"},
                      {"type": "contains", "file": "out/*.md", "text": "#define"}):
            self.set_check(check)
            self.assertPasses("eval")

    def test_REQ_011_unchanged_must_match_an_input_file(self):
        self.write("tests/eval/T-01/inputs/src/dbg_log.h", self.HEADER_LINE + "\n")
        self.set_check({"type": "unchanged", "file": "inputs/src/dbg_log.h"}, ["inputs/memo.txt", "inputs/src"])
        self.assertPasses("eval")
        self.set_check({"type": "unchanged", "file": "src/dbg_log.h"})
        self.assertFailsWith("eval", "check.file「src/dbg_log.h」が、課題の入力のファイルのどれにも当てはまらない")
        self.set_check({"type": "unchanged", "file": "inputs/src/dbg_log.h", "text": "x"})
        self.assertFailsWith("eval", "unchanged では使わない項目「text」")

    def test_REQ_011_office_and_binary_inputs_are_not_read_for_text(self):
        self.write("tests/eval/T-01/inputs/report.docx", "PK 天気")
        with open(self.path("tests/eval/T-01/inputs/data.bin"), "wb") as f:
            f.write(b"A\0B")
        inputs = ["inputs/memo.txt", "inputs/report.docx", "inputs/data.bin"]
        for check in ({"type": "contains", "file": "inputs/report.docx", "text": "天気"},
                      {"type": "contains", "file": "inputs/data.bin", "text": "A"},
                      {"type": "not_contains", "file": "inputs/*", "text": "晴れ"}):
            self.set_check(check, inputs)
            self.assertPasses("eval")
        self.set_check({"type": "file_exists", "file": "inputs/*.docx"}, inputs)   # file_exists は大きさだけで決める
        self.assertFailsWith("eval", "もとのままでも合格してしまう")

    @unittest.skipUnless(shutil.which("node"), "node がない")
    def test_REQ_011_a_regex_that_the_unchanged_input_already_matches_fails(self):
        self.set_check({"type": "regex", "file": "inputs/*.txt", "pattern": "^天気", "flags": "m"})
        self.assertFailsWith("eval", "もとのままでも合格してしまう", "パターン「^天気」に合う箇所がある")
        self.set_check({"type": "regex", "file": "inputs/*.txt", "pattern": "晴れ"})
        self.assertPasses("eval")

    def test_REQ_011_without_node_a_regex_on_inputs_is_not_checked_and_only_a_note_is_left(self):
        self.set_check({"type": "regex", "file": "inputs/*.txt", "pattern": "^天気"})
        originals = cs.js_regex_errors, cs.js_regex_hits

        def no_node(items):
            raise RuntimeError("node を動かせなかった")
        cs.js_regex_errors = cs.js_regex_hits = no_node
        try:
            check = {c.id: c for c in self.report().checks}["eval"]
        finally:
            cs.js_regex_errors, cs.js_regex_hits = originals
        self.assertEqual([], check.errors)
        self.assertTrue(any("入力のままで当てはまってしまわないかは確かめていない" in w for w in check.warnings), check.warnings)

    @unittest.skipUnless(shutil.which("node"), "node がない")
    def test_REQ_011_regex_pattern_must_be_readable_as_a_javascript_regular_expression(self):
        self.edit_json(self.EVAL, lambda d: d["criteria"][0].update({"check": {"type": "regex", "file": "out/*.md", "pattern": "(", "flags": "u"}}))
        self.assertFailsWith("eval", "criteria[0].check.pattern が正規表現として読めない")
        # JavaScript では読めて Python では読めない書き方は、通す
        self.edit_json(self.EVAL, lambda d: d["criteria"][0].update({"check": {"type": "regex", "file": "out/*.md", "pattern": "(?<year>\\d{4})\\p{L}", "flags": "u"}}))
        self.assertPasses("eval")

    def test_REQ_011_without_node_the_regex_is_not_read_and_only_a_note_is_left(self):
        self.edit_json(self.EVAL, lambda d: d["criteria"][0].update({"check": {"type": "regex", "file": "out/*.md", "pattern": "("}}))
        original = cs.js_regex_errors

        def no_node(regexes):
            raise RuntimeError("node を動かせなかった")
        cs.js_regex_errors = no_node
        try:
            check = {c.id: c for c in self.report().checks}["eval"]
        finally:
            cs.js_regex_errors = original
        self.assertEqual([], check.errors)
        self.assertTrue(any("確かめていない" in w for w in check.warnings))

    def test_REQ_011_task_folder_without_eval_json_fails(self):
        os.makedirs(self.path("tests/eval/T-02"))
        self.assertFailsWith("eval", "tests/eval/T-02/eval.json がない")

    def test_REQ_011_two_tasks_may_not_share_an_id(self):
        self.write("tests/eval/T-02/eval.json", self.read(self.EVAL))
        self.os_makedirs_inputs("T-02")
        self.assertFailsWith("eval", "id「T-01」が、tests/eval/T-01/eval.json と重なっている")

    def os_makedirs_inputs(self, name):
        shutil.copytree(self.path("tests/eval/T-01/inputs"), self.path("tests/eval/%s/inputs" % name))

    def test_REQ_011_input_symlink_fails(self):
        target = os.path.join(self.tmp, "outside.txt")
        open(target, "w").close()
        try:
            os.symlink(target, self.path("tests/eval/T-01/inputs/link.txt"))
        except (OSError, NotImplementedError):
            self.skipTest("この環境ではシンボリックリンクを作れない")
        self.edit_json(self.EVAL, lambda d: d.update({"inputs": ["inputs/link.txt"]}))
        self.assertFailsWith("eval", "シンボリックリンクなので使えない")

    def test_REQ_011_settings_task_keys_must_exist_in_the_task_definition(self):
        self.edit_json(self.EVAL, lambda d: d["settings"]["task"].update({"week": "2026-W42"}))
        self.assertFailsWith("eval", "settings.task の「week」が、作業の定義の settings にない", "画面に欄がない")

    def test_REQ_011_settings_task_values_follow_the_setting_type(self):
        def add(setting):
            self.edit_json("%s/task.json" % EXT, lambda d: d["settings"].append(setting))
        add({"key": "n", "label": "回数", "type": "number", "default": 1})
        add({"key": "flag", "label": "印", "type": "checkbox", "default": False})
        add({"key": "mode", "label": "形", "type": "select", "default": "a", "options": ["a", "b"]})
        add({"key": "where", "label": "場所", "type": "path", "default": ""})
        self.edit_json(self.EVAL, lambda d: d["settings"]["task"].update({"n": "3", "flag": "yes", "mode": "c", "where": 5}))
        problems = self.problems("eval")
        self.assertEqual(4, len(problems), problems)
        self.assertTrue(any("n は、number の設定なので数で書く" in p for p in problems))
        self.assertTrue(any("flag は、checkbox の設定なので true か false" in p for p in problems))
        self.assertTrue(any("mode の値 'c' が、作業の定義の選択肢（a、b）にない" in p for p in problems))
        self.assertTrue(any("where は、path の設定なので文字で書く" in p for p in problems))
        self.edit_json(self.EVAL, lambda d: d["settings"]["task"].update({"n": 3.5, "flag": True, "mode": "b", "where": "out"}))
        self.assertPasses("eval")

    def test_REQ_011_required_setting_without_a_first_value_must_be_given(self):
        self.edit_json(self.EVAL, lambda d: d["settings"]["task"].pop("topic"))
        self.assertFailsWith("eval", "必須の設定「題材」（topic）の値がない", "画面で開始できない")
        self.edit_json("%s/task.json" % EXT, lambda d: d["settings"][0].update({"default": "天気"}))
        self.assertPasses("eval")
        self.edit_json("%s/task.json" % EXT, lambda d: d["settings"][0].update({"default": "", "required": False}))
        self.assertPasses("eval")

    def test_REQ_011_omitted_settings_task_is_compared_as_empty(self):
        # 課題が settings.task を省いても、必須で初めの値のない設定があれば、画面で開始できない
        def given(settings):
            def edit(d):
                d.pop("settings", None)
                if settings != "$absent":
                    d["settings"] = settings
            self.edit_json(self.EVAL, edit)
        for omitted in ("$absent", {}, {"maxIterations": 2}, {"task": {}}):
            given(omitted)
            self.assertFailsWith("eval", "必須の設定「題材」（topic）の値がない", "画面で開始できない")
        # 初めの値がある・必須でないなら、省いてよい
        for omitted in ("$absent", {}, {"maxIterations": 2}, {"task": {}}):
            given(omitted)
            self.edit_json("%s/task.json" % EXT, lambda d: d["settings"][0].update({"default": "天気", "required": True}))
            self.assertPasses("eval")
            self.edit_json("%s/task.json" % EXT, lambda d: d["settings"][0].update({"default": "", "required": False}))
            self.assertPasses("eval")
            self.edit_json("%s/task.json" % EXT, lambda d: d["settings"][0].update({"default": "", "required": True}))
        # settings や task が辞書でないのは、形の誤りとして示す。必須の値なしは重ねて示さない
        for broken in (None, [], "x", {"task": []}, {"task": None}):
            given(broken)
            problems = self.problems("eval")
            self.assertTrue(problems, broken)
            self.assertFalse(any("必須の設定" in p for p in problems), problems)

    def test_REQ_011_a_broken_task_definition_does_not_make_the_eval_check_crash(self):
        for broken in (None, 5, {"a": 1}, [None, 3, {"key": 7}]):
            self.edit_json("%s/task.json" % EXT, lambda d: d.update({"settings": broken}))
            self.assertIsInstance(self.problems("eval"), list)   # 例外にならず、検査の結果が返る
            self.assertTrue(self.problems("task"))   # 定義の誤りは task の試験が示す

    def test_REQ_011_eval_json_that_is_not_an_object_fails(self):
        self.write(self.EVAL, "[]")
        self.assertFailsWith("eval", "JSON のオブジェクトではない")


class EvalParity(Sandbox):
    """eval.json の形と採点のしかたの決まりが、採点（grade.mjs）と同じ判定になること。同じ例を eval-parity.test.mjs が grade.mjs に通す。"""

    with open(os.path.join(HERE, "eval-cases.json"), encoding="utf-8") as _f:
        CASES = json.load(_f)

    def setUp(self):
        super().setUp()
        # 必須の設定を課題が満たすかは Python 側だけの検査なので、この例には干渉させない
        self.edit_json("%s/task.json" % EXT, lambda d: d["settings"][0].update({"required": False}))

    @staticmethod
    def build_task(case):
        """例から課題を作る。値が "$remove" の項目は消す（eval-parity.test.mjs の buildTask と同じ決まり）"""
        task = json.loads(json.dumps(EvalParity.CASES["base"]))
        for key, value in case.get("top", {}).items():
            if value == "$remove":
                task.pop(key, None)
            else:
                task[key] = value
        if "criterion" in case:
            first = dict(task["criteria"][0])
            for key, value in case["criterion"].items():
                if value == "$remove":
                    first.pop(key, None)
                else:
                    first[key] = value
            task["criteria"][0] = first
        return task

    def write_case(self, case):
        """例の課題と、課題のフォルダのファイル（baseFiles と files）を置く（eval-parity.test.mjs の writePlugin と同じ決まり）"""
        folder = self.path("tests/eval/T-01")
        shutil.rmtree(folder)
        os.makedirs(folder)
        self.write("tests/eval/T-01/eval.json", json.dumps(self.build_task(case), ensure_ascii=False))
        for rel, content in dict(self.CASES["baseFiles"], **case.get("files", {})).items():
            if content is None:
                continue
            target = self.path("tests/eval/T-01/" + rel)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "wb") as f:
                f.write(content.encode("utf-8") if isinstance(content, str) else base64.b64decode(content["base64"]))

    def test_REQ_041_the_same_examples_get_the_same_verdict_as_the_grader(self):
        has_node = shutil.which("node") is not None
        ran = 0
        for case in self.CASES["cases"]:
            if case.get("needsNode") and not has_node:
                continue
            with self.subTest(case["name"]):
                self.write_case(case)
                errors = {c.id: c for c in self.report().checks}["eval"].errors
                if case["ok"]:
                    self.assertEqual([], errors, "通るはずの課題が断られた")
                else:
                    self.assertTrue(errors, "断られるはずの課題が通った")
                ran += 1
        self.assertGreaterEqual(ran, 60)


class Knowledge(Sandbox):
    LIST = "tests/knowledge.json"

    def test_REQ_039_missing_criterion_knowledge_is_reported_with_its_sentence(self):
        self.edit_json("%s/task.json" % EXT, lambda d: d["criteria"][0].update({"knowledge": "K-02"}))
        self.assertFailsWith("knowledge", "K-01（合否の決め方）", "成果物に題がある")

    def test_REQ_039_missing_other_knowledge_is_reported_with_its_sentence(self):
        self.edit_json(self.LIST, lambda d: d.append({"id": "K-03", "kind": "other", "item": "x", "text": "週報は金曜に出す"}))
        self.assertFailsWith("knowledge", "K-03", "週報は金曜に出す")

    def test_REQ_039_other_knowledge_found_in_an_agent_file_passes(self):
        self.edit_json(self.LIST, lambda d: d.append({"id": "K-03", "kind": "other", "item": "x", "text": "週報は金曜に出す"}))
        self.replace("com.github.copilot/agents/verifier.agent.md", "成果物は直さない。", "成果物は直さない。(K-03)")
        self.assertPasses("knowledge")

    def test_REQ_039_number_only_in_the_tests_folder_does_not_count(self):
        self.edit_json(self.LIST, lambda d: d.append({"id": "K-03", "kind": "other", "item": "x", "text": "週報は金曜に出す"}))
        self.write("tests/notes.txt", "K-03")
        self.assertFailsWith("knowledge", "K-03")

    def test_REQ_039_number_in_task_json_does_not_count_for_other_knowledge(self):
        self.edit_json(self.LIST, lambda d: d.append({"id": "K-03", "kind": "other", "item": "x", "text": "週報は金曜に出す"}))
        self.edit_json("%s/task.json" % EXT, lambda d: d.update({"name": "見本 K-03"}))
        self.assertFailsWith("knowledge", "K-03")

    def test_REQ_039_number_must_match_as_a_whole(self):
        self.edit_json(self.LIST, lambda d: d.append({"id": "K-1", "kind": "other", "item": "x", "text": "短い番号"}))
        self.replace("com.github.copilot/agents/verifier.agent.md", "成果物は直さない。", "成果物は直さない。K-10 K-11")
        self.assertFailsWith("knowledge", "K-1 ")

    def test_REQ_039_criteria_may_only_cite_criterion_knowledge(self):
        self.edit_json("%s/task.json" % EXT, lambda d: d["criteria"][0].update({"knowledge": "K-02"}))
        self.edit_json(self.LIST, lambda d: d[1].update({"kind": "other"}))
        self.assertFailsWith("knowledge", "基準 C-01 の knowledge K-02")

    def test_REQ_039_unknown_knowledge_number_in_a_criterion_fails(self):
        self.edit_json("%s/task.json" % EXT, lambda d: d["criteria"][0].update({"knowledge": "K-77"}))
        self.assertFailsWith("knowledge", "K-77")

    def test_REQ_039_list_is_required(self):
        self.remove(self.LIST)
        self.assertFailsWith("knowledge", "tests/knowledge.json がない")

    def test_REQ_039_list_shape(self):
        self.edit_json(self.LIST, lambda d: d.append({"id": "K-03", "kind": "maybe", "text": "x"}))
        self.assertFailsWith("knowledge", "kind")
        self.edit_json(self.LIST, lambda d: d.__setitem__(slice(None), [{"id": "03", "kind": "other", "text": "x"}]))
        self.assertFailsWith("knowledge", "id は K-数字")


class AgentTools(Sandbox):
    VERIFIER = "com.github.copilot/agents/verifier.agent.md"
    ORCH = "com.github.copilot/agents/orchestrator.agent.md"
    VERIFIER_TOOLS = "tools: [read, search, sample-plugin_verdict]"

    def test_REQ_010_verifier_may_not_write(self):
        for tool in ("edit", "Write", "MultiEdit", "NotebookEdit", "create"):
            self.replace(self.VERIFIER, self.VERIFIER_TOOLS, "tools: [read, search, %s]" % tool)
            self.assertFailsWith("agent-tools", "書き込みのツール %s" % tool)
            self.replace(self.VERIFIER, "tools: [read, search, %s]" % tool, self.VERIFIER_TOOLS)

    def test_REQ_010_verifier_may_not_run_commands(self):
        for tool in ("execute", "Bash", "shell", "powershell"):
            self.replace(self.VERIFIER, self.VERIFIER_TOOLS, "tools: [read, search, %s]" % tool)
            self.assertFailsWith("agent-tools", "コマンドのツール %s" % tool)
            self.replace(self.VERIFIER, "tools: [read, search, %s]" % tool, self.VERIFIER_TOOLS)

    def test_REQ_010_verifier_without_tools_fails(self):
        self.replace(self.VERIFIER, self.VERIFIER_TOOLS + "\n", "")
        self.assertFailsWith("agent-tools", "verifier.agent.md", "tools が書かれていない")

    def test_REQ_010_tools_as_a_comma_separated_text_is_read(self):
        self.replace(self.VERIFIER, self.VERIFIER_TOOLS, "tools: read, edit")
        self.assertFailsWith("agent-tools", "書き込みのツール edit")

    def test_REQ_010_skill_is_not_allowed_in_the_tools_of_workers_and_verifiers(self):
        for path, old in ((self.VERIFIER, "tools: [read,"), ("com.github.copilot/agents/worker.agent.md", "tools: [read,")):
            text = self.read(path)
            self.replace(path, old, old + " Skill,")
            self.assertFailsWith("agents", "skill がある")
            self.write(path, text)

    def test_REQ_010_the_orchestrator_has_no_tools_and_that_is_not_a_warning(self):
        self.assertNotIn("tools:", self.read(self.ORCH).split("---")[1])
        self.assertPasses("agent-tools")
        self.assertPasses("agents")
        warnings = {c.id: c.warnings for c in self.report().checks}["agents"]
        self.assertFalse(any("orchestrator.agent.md" in w and "tools" in w for w in warnings), warnings)

    def test_REQ_010_the_orchestrator_may_not_write_tools_because_the_children_would_lose_theirs(self):
        # 統括が tools を持つと、Copilot CLI は子（作業・検証）のツールも統括の範囲に絞る（V1 の不具合 1）
        for line in ("tools: [agent, read, search]", "tools: []", "tools: ['*']", "tools: agent, read", "tools:\n  - agent"):
            text = self.read(self.ORCH)
            self.replace(self.ORCH, "model: [gpt-6-luna, claude-haiku-5.5]\n", "model: [gpt-6-luna, claude-haiku-5.5]\n%s\n" % line)
            self.assertFailsWith("agent-tools", "orchestrator.agent.md", "tools がある", "統括")
            self.write(self.ORCH, text)

    def test_REQ_010_workers_and_verifiers_still_need_tools(self):
        self.replace("com.github.copilot/agents/worker.agent.md", "tools: [read, edit, execute, search, sample-plugin_show]\n", "")
        self.assertFailsWith("agent-tools", "worker.agent.md", "tools が書かれていない")

    def test_REQ_010_a_missing_role_fails(self):
        self.remove(self.VERIFIER)
        self.assertFailsWith("agent-tools", "検証エージェント", "verifier.agent.md がない")
        self.remove("com.github.copilot/agents/orchestrator.agent.md")
        self.assertFailsWith("agent-tools", "統括エージェント")

    def test_REQ_010_second_worker_is_checked_too(self):
        self.write("com.github.copilot/agents/worker-extra.agent.md", "---\ndescription: 2人目\ntools: [read, skill]\n---\n本文\n")
        self.assertFailsWith("agents", "worker-extra.agent.md", "skill がある")

    def test_REQ_010_record_tool_prefix_in_tools_must_be_the_plugin_name(self):
        self.replace(self.VERIFIER, "sample-plugin_verdict", "other-plugin_verdict")
        self.assertFailsWith("tool-names", "other-plugin_verdict", "sample-plugin")

    def test_REQ_010_record_tool_prefix_in_the_body_must_be_the_plugin_name(self):
        self.replace(self.ORCH, "`sample-plugin_finish`", "`finish_plugin_finish`")
        self.assertFailsWith("tool-names", "finish_plugin_finish", "本文")

    def test_REQ_010_other_backticked_words_are_not_mistaken_for_record_tools(self):
        self.replace(self.ORCH, "計画は", "`task_list` と `plan` と `sample-plugin_plan` を使う。計画は")
        self.assertPasses("tool-names")


class Marketplace(Sandbox):
    FILE = ".github/plugin/marketplace.json"

    def test_REQ_004_good_marketplace_passes(self):
        self.assertPasses("marketplace")

    def test_REQ_004_missing_marketplace_fails(self):
        self.remove(self.FILE)
        self.assertFailsWith("marketplace", "marketplace.json がない")

    def test_REQ_004_broken_json_fails(self):
        self.write(self.FILE, "{")
        self.assertFailsWith("marketplace", "JSON として読めない")

    def test_REQ_004_name_owner_and_plugins_are_required(self):
        self.edit_json(self.FILE, lambda d: d.pop("name"))
        self.assertFailsWith("marketplace", "マーケットプレイスの名前（name）がない")
        self.edit_json(self.FILE, lambda d: d.update({"name": "sample-plugin", "owner": {}}))
        self.assertFailsWith("marketplace", "持ち主の名前（owner.name）がない")
        self.edit_json(self.FILE, lambda d: d.update({"owner": {"name": "x"}, "plugins": []}))
        self.assertFailsWith("marketplace", "プラグインの一覧（plugins）がない")

    def test_REQ_004_every_listed_plugin_needs_a_name(self):
        self.edit_json(self.FILE, lambda d: d["plugins"].append({"source": "./other"}))
        self.assertFailsWith("marketplace", "プラグインの名前（name）がない")

    def test_REQ_004_listed_name_must_match_plugin_json(self):
        self.edit_json(self.FILE, lambda d: d["plugins"][0].update({"name": "old-name"}))
        self.assertFailsWith("marketplace", "plugin.json の名前「sample-plugin」がない", "「old-name」", "copilot plugin install が失敗する")

    def test_REQ_004_marketplace_is_checked_only_for_generated_plugins(self):
        self.remove(self.FILE)
        self.assertNotIn("marketplace", {c.id for c in self.report("plugin").checks})


class Trace(Sandbox):
    DESIGN = "docs/design/design.md"
    SPEC = "docs/specs/requirements.md"

    def test_REQ_003_requirement_missing_from_the_table_fails_with_its_title(self):
        self.write(self.SPEC, self.read(self.SPEC) + "\n### REQ-101 追加の要件\n\n- 要件：見本。\n")
        self.assertFailsWith("trace", "REQ-101（追加の要件）", "追跡の表にない")

    def test_REQ_003_listed_file_must_exist(self):
        self.replace(self.DESIGN, "`plugin.json`、`README.md`", "`plugin.json`、`nothing.md`")
        self.assertFailsWith("trace", "REQ-002", "nothing.md")

    def test_REQ_003_file_cell_may_not_be_empty(self):
        self.replace(self.DESIGN, "| REQ-004 | 4.1 | `plugin.json` |", "| REQ-004 | 4.1 | — |")
        self.assertFailsWith("trace", "REQ-004", "ファイルが書かれていない")

    def test_REQ_003_wildcards_in_the_file_cell_are_expanded(self):
        self.replace(self.DESIGN, "`tests/stage2/core/sample.test.mjs`", "`tests/stage2/core/*.test.mjs`")
        self.replace(self.DESIGN, "| REQ-001 | 3.1 | `README.md` |", "| REQ-001 | 3.1 | `docs/specs/*.md` |")
        self.assertPasses("trace")
        self.replace(self.DESIGN, "`docs/specs/*.md`", "`docs/nothing/*.md`")
        self.assertFailsWith("trace", "docs/nothing/*.md")

    def test_REQ_003_file_outside_the_root_fails(self):
        self.replace(self.DESIGN, "| REQ-004 | 4.1 | `plugin.json` |", "| REQ-004 | 4.1 | `../plugin.json` |")
        self.assertFailsWith("trace", "REQ-004", "../plugin.json")

    def test_REQ_003_method_must_be_written(self):
        self.replace(self.DESIGN, "| REQ-004 | 4.1 | `plugin.json` | 人が確かめる |", "| REQ-004 | 4.1 | `plugin.json` |  |")
        self.assertFailsWith("trace", "REQ-004", "確かめ方")

    def test_REQ_003_section_must_be_written(self):
        self.replace(self.DESIGN, "| REQ-004 | 4.1 |", "| REQ-004 |  |")
        self.assertFailsWith("trace", "REQ-004", "設計書の節")

    def test_REQ_003_automatic_row_without_a_named_test_fails(self):
        self.replace(self.DESIGN, "| REQ-004 | 4.1 | `plugin.json` | 人が確かめる |", "| REQ-005 | 4.1 | `plugin.json` | 自動のテスト |")
        self.write(self.SPEC, self.read(self.SPEC) + "\n### REQ-005 画面\n")
        self.replace(self.DESIGN, "| REQ-005 |", "| REQ-004 | 4.1 | `plugin.json` | 人が確かめる | — |\n| REQ-005 |")
        self.assertFailsWith("trace", "REQ-005", "名前に REQ-005 を持つテストがない")

    def test_REQ_003_node_test_name_satisfies_the_automatic_row(self):
        self.write("tests/stage2/core/screen.test.mjs", "import test from 'node:test';\ntest.skip(\"REQ-007 開始前の設定\", () => {});\n")
        self.write(self.SPEC, self.read(self.SPEC) + "\n### REQ-007 設定\n")
        self.write(self.DESIGN, self.read(self.DESIGN) + "| REQ-007 | 4.3 | `plugin.json` | 自動のテスト | x |\n")
        self.assertPasses("trace")

    def test_REQ_003_number_in_a_node_comment_or_body_does_not_count(self):
        self.write("tests/stage2/core/screen.test.mjs", "import test from 'node:test';\n// REQ-007\ntest('設定', () => { const x = 'REQ-007'; });\n")
        self.write(self.SPEC, self.read(self.SPEC) + "\n### REQ-007 設定\n")
        self.write(self.DESIGN, self.read(self.DESIGN) + "| REQ-007 | 4.3 | `plugin.json` | 自動のテスト | x |\n")
        self.assertFailsWith("trace", "REQ-007")

    def test_REQ_003_python_docstring_and_function_name_satisfy_the_automatic_row(self):
        self.write("tests/stage2/task/test_more.py",
                   "import unittest\n\n\nclass T(unittest.TestCase):\n"
                   "    def test_a(self):\n        \"\"\"REQ-007 の確かめ\"\"\"\n"
                   "    def test_REQ_008_b(self):\n        pass\n")
        self.write(self.SPEC, self.read(self.SPEC) + "\n### REQ-007 設定\n\n### REQ-008 別\n")
        self.write(self.DESIGN, self.read(self.DESIGN) + "| REQ-007 | 4.3 | `plugin.json` | 自動のテスト | x |\n| REQ-008 | 4.3 | `plugin.json` | 自動のテスト | y |\n")
        self.assertPasses("trace")

    def test_REQ_003_eval_and_human_rows_need_no_named_test(self):
        self.write(self.SPEC, self.read(self.SPEC) + "\n### REQ-007 a\n\n### REQ-008 b\n")
        self.write(self.DESIGN, self.read(self.DESIGN) + "| REQ-007 | 4.3 | `plugin.json` | EVAL | x |\n| REQ-008 | 4.3 | `plugin.json` | 人が確かめる | x |\n")
        self.assertPasses("trace")

    def test_REQ_003_several_rows_for_one_requirement_are_all_checked(self):
        self.write(self.DESIGN, self.read(self.DESIGN) + "| REQ-001 | 3.9 | `nothing.md` | EVAL | x |\n")
        self.assertFailsWith("trace", "nothing.md")

    def test_REQ_003_table_is_found_by_its_headings_even_with_other_tables_around(self):
        self.write(self.DESIGN, "| 部品 | 場所 |\n| --- | --- |\n| a | b |\n\n```\n| 要件の番号 | 設計書の節 | ファイル | 確かめ方 | テスト |\n```\n\n" + self.read(self.DESIGN))
        self.assertPasses("trace")

    def test_REQ_003_missing_table_fails(self):
        self.write(self.DESIGN, "# 設計\n\n| 部品 | 場所 |\n| --- | --- |\n| a | b |\n")
        self.assertFailsWith("trace", "追跡の表がない")

    def test_REQ_003_missing_documents_fail(self):
        self.remove(self.SPEC)
        self.assertFailsWith("trace", "docs/specs/requirements.md がない")

    def test_REQ_003_requirements_file_without_requirements_fails(self):
        self.write(self.SPEC, "# 要件\n\n要件はまだない。\n")
        self.assertFailsWith("trace", "要件（見出し")

    def test_REQ_003_stage1_checks_count_as_named_tests(self):
        # REQ-003、REQ-004、REQ-010、REQ-011 は1段目の試験の名前に入っているので、自動のテストの行に書ける
        self.replace(self.DESIGN, "| REQ-004 | 4.1 | `plugin.json` | 人が確かめる |", "| REQ-004 | 4.1 | `plugin.json` | 自動のテスト |")
        self.assertPasses("trace")


if __name__ == "__main__":
    unittest.main()
