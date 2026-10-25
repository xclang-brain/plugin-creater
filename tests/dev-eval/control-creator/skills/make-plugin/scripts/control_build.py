#!/usr/bin/env python3
"""対照のクリエイターの組み立て（開発の試験のためだけに使う）。

大まかな質問の答え（knowledge.md の箇条書き）を、生成プラグインに組み込む。本物の組み立てのスクリプト
（skills/make-plugin/scripts/scaffold.py の build）を使うので、できる生成プラグインの形は本物と同じ。
ヒアリングの記録（state.json）と、作業エージェントが書く部分（parts/）は、このスクリプトが決まった形で作る。

使い方（作業フォルダの中で）:
    python3 control_build.py --name weekly-report --title "週報の作成" --description "…" --knowledge-file knowledge.md

  1 行目の答え（成果物）が「合否の決め方」、2 行目以降が「それ以外」のナレッジになる。
  scaffold.py の場所は、環境変数 CONTROL_SCAFFOLD か、このリポジトリの skills/make-plugin/scripts/scaffold.py。
  標準出力に、scaffold.py の結果の JSON を出す。終了コードは scaffold.py と同じ。
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = ".plugin-creator-work"
STATE_FILE = ".control-hearing.json"
EVAL_PROMPT = "%sを作ってください。"
EVAL_SETTINGS = {"maxIterations": 3, "task": {}}


def default_scaffold() -> str:
    env = os.environ.get("CONTROL_SCAFFOLD")
    if env:
        return env
    return os.path.normpath(os.path.join(HERE, "..", "..", "..", "..", "..", "..", "skills", "make-plugin", "scripts", "scaffold.py"))


def read_bullets(path: str) -> list:
    bullets = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            text = re.sub(r"^\s*(?:[-*・]|\d+[.)．])\s*", "", line.strip())
            if text:
                bullets.append(text)
    return bullets


def write(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def one_line(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def build_parts(work: str, name: str, title: str, description: str, bullets: list) -> None:
    parts = os.path.join(work, "parts")
    others = bullets[1:]
    ids = ["K-%02d" % (i + 2) for i in range(len(others))]
    write(os.path.join(parts, "manifest.json"), json.dumps({
        "plugin_name": name,
        "plugin_description": one_line(description)[:1000],
        "entry_skill": {"name": name, "description": one_line(description)[:1000]},
        "workers": [{"agent": "worker", "label": "%sを作る係" % title, "extra_tools": []}],
        "verifier": {"extra_tools": []},
        "orchestrator": {"extra_tools": []},
    }, ensure_ascii=False, indent=2) + "\n")
    task = {
        "name": title,
        "maxIterationsDefault": 3,
        "workers": [{"agent": "worker", "label": "%sを作る係" % title}],
        "settings": [{"key": "note", "label": "メモ", "type": "text", "default": "", "help": "作業に添えるメモです。省いてもかまいません。"}],
        "displays": [{"key": "result", "label": "結果", "type": "text", "when": "finished"}],
    }
    write(os.path.join(parts, "task.json"), json.dumps(task, ensure_ascii=False, indent=2) + "\n")
    slots = os.path.join(parts, "slots")
    write(os.path.join(slots, "entry-task.md"), "%sの作業です。\n\n%s\n" % (title, bullets[0]))
    write(os.path.join(slots, "orchestrator-task.md"), "- 成果物は作業エージェントが書き、検証エージェントが基準ごとに確かめます。統括エージェントは書きません。\n")
    write(os.path.join(slots, "verifier-task.md"), "- 成果物を読み、基準ごとに合否を確かめる。\n")
    worker = ["### %sの書き方" % title, "", "- %s" % bullets[0]]
    worker += ["- %s（%s）" % (text, kid) for text, kid in zip(others, ids)]
    write(os.path.join(slots, "worker-task.worker.md"), "\n".join(worker) + "\n")
    write(os.path.join(slots, "readme-what.md"), "%sをします。\n" % title)
    write(os.path.join(slots, "readme-how.md"), "チャットで、%sを頼みます。\n" % title)
    write(os.path.join(slots, "task-requirements.md"),
          "### REQ-101 成果物\n\n- 要件：%sの成果物が作られる。\n- 根拠：憲章 第22条\n- 受け入れ基準：\n  - 成果物が作られる。\n" % title)
    write(os.path.join(slots, "task-design.md"), "### 8.1 成果物の確かめ\n\n- `scripts/control_task.py` が、成果物の名前の形を確かめる。\n")
    write(os.path.join(slots, "task-trace.md"), "| REQ-101 | 8.1 | `scripts/control_task.py` | 自動のテスト | `tests/stage2/task/test_control_task.py` |\n")
    files = os.path.join(parts, "files")
    write(os.path.join(files, "scripts", "control_task.py"),
          '#!/usr/bin/env python3\n"""成果物の名前の形を確かめる（対照のクリエイターが作った見本）。"""\n\n\ndef is_valid_name(name):\n    return bool(name) and "/" not in name\n')
    write(os.path.join(files, "tests", "stage2", "task", "test_control_task.py"),
          "import os\nimport sys\nimport unittest\n\n"
          "sys.path.insert(0, os.path.join(os.path.dirname(__file__), \"..\", \"..\", \"..\", \"scripts\"))\n"
          "import control_task  # noqa: E402\n\n\n"
          "class ControlTask(unittest.TestCase):\n"
          "    def test_REQ_101_name_is_valid(self):\n"
          "        self.assertTrue(control_task.is_valid_name(\"output.md\"))\n\n\n"
          "if __name__ == \"__main__\":\n    unittest.main()\n")
    write(os.path.join(files, "tests", "eval", "T-01", "inputs", "memo.txt"), "対照のクリエイターが作った見本の入力です。\n")
    write(os.path.join(files, "tests", "eval", "T-01", "eval.json"), json.dumps({
        "id": "T-01",
        "prompt": EVAL_PROMPT % title,
        "inputs": ["inputs/memo.txt"],
        "settings": EVAL_SETTINGS,
        "criteria": [{"knowledge": "K-01", "grading": "model"}],
    }, ensure_ascii=False, indent=2) + "\n")


def build_state(path: str, bullets: list, title: str) -> None:
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")

    def row(i: int, text: str) -> dict:
        kind = "criterion" if i == 0 else "other"
        item = "criteria" if i == 0 else "rules"
        return {
            "id": "K-%02d" % (i + 1), "kind": kind, "item": item,
            "itemName": "合否の決め方" if i == 0 else "決まった書き方やルール",
            "text": text, "source": "answer", "quote": text, "example": None, "exception": None,
            "status": "decided", "recordedAt": now, "updatedAt": now, "itemTouchedAtRecord": False,
        }

    knowledge = [row(i, t) for i, t in enumerate(bullets)]
    state = {
        "schemaVersion": 1, "sessionId": "control", "createdAt": now, "updatedAt": now, "stage": "generate", "rebuild": False,
        "items": {"purpose": {"status": "asked", "quote": title, "holder": None, "updatedAt": now}},
        "knowledgeCounter": len(knowledge), "knowledge": knowledge, "assets": [], "ossChoices": [],
        "confirmation": {"at": now, "knowledgeIds": [k["id"] for k in knowledge], "behavior": "%sを作る" % title,
                         "taskPath": ".plugin-creator-work/draft/task.json",
                         # scaffold.py は、eval.json をこの課題（生成前の確認でよいと答えた課題）と突き合わせる（prompt・inputs・criteria・settings）。
                         # eval.json は build_parts が同じ値で書く。仮の入力のファイルの path は、生成プラグインの中の置き場所
                         "evalTasks": [{"prompt": EVAL_PROMPT % title,
                                        "inputs": [{"path": "tests/eval/T-01/inputs/memo.txt", "provisional": True}],
                                        "criteria": [k["id"] for k in knowledge if k["kind"] == "criterion"],
                                        "settings": dict(EVAL_SETTINGS)}],
                         "rebuild": None},
        "approvedAt": now, "approvalQuote": "（対照のクリエイターは、確認を取らない）", "url": None,
    }
    write(path, json.dumps(state, ensure_ascii=False, indent=2) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="対照のクリエイターの組み立て")
    parser.add_argument("--name", required=True, help="生成プラグインの名前（英小文字・数字・ハイフン）")
    parser.add_argument("--title", required=True, help="作業の名前")
    parser.add_argument("--description", required=True, help="いつ使うか（ユーザーが頼むときの言い方で）")
    parser.add_argument("--knowledge-file", required=True, help="答えの箇条書き")
    parser.add_argument("--scaffold", default=None, help="scaffold.py の場所")
    args = parser.parse_args()
    bullets = read_bullets(args.knowledge_file)
    if not bullets:
        print(json.dumps({"ok": False, "problems": ["knowledge.md に答えがありません。"]}, ensure_ascii=False))
        return 1
    cwd = os.getcwd()
    work = os.path.join(cwd, WORK)
    out = os.path.join(cwd, args.name)
    state = os.path.join(cwd, STATE_FILE)
    shutil.rmtree(work, ignore_errors=True)
    build_parts(work, args.name, args.title, args.description, bullets)
    build_state(state, bullets, args.title)
    scaffold = args.scaffold or default_scaffold()
    try:
        proc = subprocess.run([sys.executable, "-I", scaffold, "build", "--hearing", state, "--work", work, "--out", out],
                              capture_output=True, text=True)
    finally:
        if os.path.exists(state):
            os.remove(state)
    sys.stdout.write(proc.stdout)
    sys.stderr.write(proc.stderr)
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
