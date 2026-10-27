#!/usr/bin/env python3
"""クリエイター自身の1段目。

ひな形の構造の検査（template/tests/stage1/check_structure.py）を読み込んで使い、
公式仕様の検査（plugin.json、mcp.json、スキル、エージェント、置き場所、シンボリックリンク、references）に、
クリエイターだけの確かめを足す。

  - スキル（skills/*/SKILL.md）の本文が、どれも500行以内で、5,000トークン以内（トークンは tiktoken の o200k_base で数える）。
    make-plugin の SKILL.md がなければ不合格にする
  - 会話例（examples/ の Markdown）に書いた版と plugin.json の版が同じ。会話例がなければ不合格にする

使い方:
    python3 -I tests/creator/check_creator.py [クリエイターのフォルダ] [--json]

終了コード: 0 全部合格、1 不合格あり、2 道具が足りない・使い方の誤り。
tiktoken は、初めて使うときにエンコーディングのファイルをネットワークから取る。
取れないときは、その理由を示して不合格にする（TIKTOKEN_CACHE_DIR に置いておけば取らない）。
"""
from __future__ import annotations

import argparse
import glob
import importlib.util
import json
import os
import re
import sys
from typing import Any, List, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
TEMPLATE_CHECK = os.path.join(REPO, "template", "tests", "stage1", "check_structure.py")

SKILL_MAX_LINES = 500
SKILL_MAX_TOKENS = 5000
TOKEN_ENCODING = "o200k_base"   # ユーザーが決めた数え方（OpenAI の tiktoken）。エンコーディングは作業者が決めた
EXAMPLE_HEAD_LINES = 30         # 版は会話例の冒頭にある、と見る範囲
EXAMPLE_VERSION = re.compile(r"plugin-creator の版[：:]\s*`?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)")


def load_template_checks() -> Any:
    spec = importlib.util.spec_from_file_location("check_structure", TEMPLATE_CHECK)
    module = importlib.util.module_from_spec(spec)
    sys.modules["check_structure"] = module
    spec.loader.exec_module(module)   # PyYAML と jsonschema がなければ、ここで分かる言葉で止まる
    return module


def count_tokens(text: str) -> int:
    """SKILL.md の本文のトークン数。数えられないときは RuntimeError（理由つき）。"""
    try:
        import tiktoken
    except ImportError:
        raise RuntimeError("tiktoken が入っていない（Python の仮想環境の中で `python3 -m pip install tiktoken` を実行する）")
    try:
        encoding = tiktoken.get_encoding(TOKEN_ENCODING)
    except Exception as e:   # ネットワークの誤り、書き込めないキャッシュなど、取れない理由はさまざま
        raise RuntimeError(
            "トークンを数えるエンコーディング %s のファイルを取れなかった（初めて使うときはネットワークから取る。"
            "取れる環境で一度動かすか、TIKTOKEN_CACHE_DIR に置く）: %s: %s" % (TOKEN_ENCODING, type(e).__name__, e))
    return len(encoding.encode(text, disallowed_special=()))


def skill_files(root: str) -> List[str]:
    """skills/ の直下のフォルダの SKILL.md（名前の順）。"""
    return sorted(glob.glob(os.path.join(root, "skills", "*", "SKILL.md")))


def check_skill_size(cs: Any, root: str, c: Any) -> None:
    if not os.path.isfile(os.path.join(root, "skills", "make-plugin", "SKILL.md")):
        c.error("skills/make-plugin/SKILL.md がない")
    for path in skill_files(root):
        name = os.path.basename(os.path.dirname(path))
        shown = "skills/%s/SKILL.md" % name
        _, body = cs.parse_frontmatter(path, shown, cs.Check("_", "_"))   # 書式の誤りは skills の試験が示す
        lines = len(body.splitlines())
        if lines > SKILL_MAX_LINES:
            c.error("%s の SKILL.md の本文が %d 行ある（%d 行以内）" % (name, lines, SKILL_MAX_LINES))
        try:
            tokens = count_tokens(body)
        except RuntimeError as e:
            c.error(str(e))
            return
        if tokens > SKILL_MAX_TOKENS:
            c.error("%s の SKILL.md の本文が %d トークンある（%s で数えて %d トークン以内）" % (name, tokens, TOKEN_ENCODING, SKILL_MAX_TOKENS))


def example_files(root: str) -> List[str]:
    return sorted(glob.glob(os.path.join(root, "examples", "**", "*.md"), recursive=True))


def check_examples_version(cs: Any, root: str, c: Any) -> None:
    version: Optional[str] = None
    try:
        with open(os.path.join(root, "plugin.json"), encoding="utf-8") as f:
            version = json.load(f).get("version")
    except (OSError, ValueError, AttributeError):
        pass
    if not isinstance(version, str) or not version:
        c.error("plugin.json の version が読めないので、会話例の版と比べられない")
        return
    files = example_files(root)
    if not files:
        c.error("会話例がない（examples/ に Markdown のファイルがない）。plugin.json の版は %s。"
                "版を上げたら、その版の外側の EVAL の会話から会話例を作り直す" % version)
        return
    for path in files:
        shown = os.path.relpath(path, root).replace(os.sep, "/")
        with open(path, encoding="utf-8", errors="replace") as f:
            head = "\n".join(f.read().splitlines()[:EXAMPLE_HEAD_LINES])
        found = EXAMPLE_VERSION.search(head)
        if not found:
            c.error("%s の冒頭 %d 行に「plugin-creator の版：x.y.z」の形で版が書かれていない" % (shown, EXAMPLE_HEAD_LINES))
        elif found.group(1) != version:
            c.error("%s に書かれた版 %s が plugin.json の版 %s と違う（会話例を作り直す）" % (shown, found.group(1), version))


def run_creator_checks(root: str) -> Any:
    cs = load_template_checks()
    report = cs.run_checks(root, "plugin")
    report.kind = "creator"
    check_skill_size(cs, report.root, report.new("skill-size", "スキルの SKILL.md の本文が500行以内で、5,000トークン以内"))
    check_examples_version(cs, report.root, report.new("examples-version", "REQ-037 会話例に書いた版が plugin.json の版と同じ"))
    return report


def main(argv: Optional[List[str]] = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="クリエイター自身の1段目")
    parser.add_argument("root", nargs="?", default=REPO, help="クリエイターのフォルダ（既定はこのリポジトリ）")
    parser.add_argument("--json", action="store_true", help="結果を JSON で出す")
    args = parser.parse_args(argv)
    if not os.path.isdir(args.root):
        sys.stderr.write("フォルダがない: %s\n" % args.root)
        return 2
    report = run_creator_checks(args.root)
    cs = sys.modules["check_structure"]
    print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2) if args.json else cs.format_report(report))
    return 0 if report.ok else 1


if __name__ == "__main__":
    sys.exit(main())
