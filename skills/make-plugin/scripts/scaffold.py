#!/usr/bin/env python3
"""生成プラグインの組み立て（build）と、土台がひな形と同じかの確かめ（check-base）。
今あるプラグインを直すとき（change-plugin）の、始める前の確かめ・取り出し・直す・試験の直しの見張り・コミットもする。

使い方（標準出力には JSON を1つだけ出す）:

  python3 scaffold.py build --hearing <state.json> --work <作業フォルダ>/.plugin-creator-work --out <作業フォルダ>/<名前>
  python3 scaffold.py check-base --out <生成プラグインのフォルダ> [--restore]
  python3 scaffold.py change-check --plugin <直すプラグインのフォルダ> --cwd <Copilot CLI を起動したフォルダ> [--hearing <state.json>]
  python3 scaffold.py extract --plugin <直すプラグインのフォルダ> --work <作業フォルダ>/.plugin-creator-work [--hearing <state.json>]
  python3 scaffold.py change --hearing <state.json> --work <作業フォルダ>/.plugin-creator-work --plugin <直すプラグインのフォルダ>
  python3 scaffold.py change-guard --plugin <直すプラグインのフォルダ> --work <作業フォルダ>/.plugin-creator-work [--restore]
  python3 scaffold.py commit --plugin <直すプラグインのフォルダ> --message <コミットの説明> [--work <作業フォルダ>/.plugin-creator-work]

build がすること（creator-structure.md 2章・4.1、BLUEPRINT 8章・9章）
  1. 入力を確かめる。ヒアリングの記録の段階が「生成」で、承認の時刻があること（生成前の確認の関門。hearing.md 6.3）。
     parts/ の形。--out がまだないフォルダで、作業フォルダの中にあること（REQ-021、REQ-036）。足りないときは断る。
  2. ひな形（このスクリプトから見て ../../../template/。クリエイターの直下）を --out に写し、_plugin_ と _entry_ の名前を変える。
     作業エージェントが2体以上なら、worker.agent.md から worker-<名前>.agent.md を作る。
  3. 差し込み口 {{slot:名前}} を parts/slots/名前.md の文で置き換え、そのあとで決まった値 {{plugin_name}} などを入れる。
     埋まらない差し込み口が残ったら断り、どの差し込み口かを示す。
  4. 作業の定義（task.json）に、合否の決め方のナレッジから合否の基準を書き込む（番号は C-01 から。文はナレッジのまま）。
  5. ナレッジの一覧（tests/knowledge.json）を書く。
  6. parts/files/ をそのまま写し、manifest.json の eval_inputs（EVAL の課題の入力の実物のファイル）を指定の場所に写す。
     EVAL の課題（tests/eval/*/eval.json）の基準の番号と文を、作業の定義の写しで埋める。
     eval.json が、ユーザーが生成前の確認で確かめた課題（ヒアリングの記録の confirmation.evalTasks）と同じかを確かめる
     （課題の数、頼むときの言葉、基準にするナレッジの番号の組、入力のファイル、設定の値）。違えば断る。
  7. 土台がひな形と同じかを確かめる（check-base と同じ）。
  8. git のリポジトリにして、最初のコミットをする。
  9. 作業用の一時フォルダ（.plugin-creator-work/）を消す。
 10. 作ったフォルダと結果を JSON で出す。
     断ったとき・失敗したときは {"ok": false, "problems": [平易な日本語の文, ...]} を出し、終了コードを 1 にし、
     途中まで作ったフォルダは消す（作業用の一時フォルダは、直して作り直せるよう残す）。

check-base
  土台のファイル（ひな形の extensions/_plugin_/ にあるもの。extension.mjs、adapter.mjs、core/、ui/）と、
  試験の土台（tests/run.py、tests/stage1/、tests/stage2/adapter/・core/・ui/、tests/stage2/fake-*.mjs）が、
  ひな形と中身が同じかを比べ、違うファイルを示す。--restore で、ひな形から入れ直す（creator-structure.md 4.1）。
  試験の土台は、違うファイルとないファイルだけを見る（作業ごとの試験のファイルが増えていても違いにしない）。

change-check（読むだけ。REQ-053）
  直すプラグインのフォルダが、マニフェストを持ち、起動したフォルダの中にあり、インストールやキャッシュの写しでなく、
  git で管理され、コミットしていない変更がなく、マージなどの途中でないことを確かめる。

extract（--work の中だけに書く。REQ-057）
  直すプラグインの、git が管理するファイルから、build と同じ形の parts/ と draft/task.json を作る。
  今のひな形で描き直した下見（preview/<名前>/）を元と比べ、下見に1段目の検査を当てて、結果を extract.json にも書く。
  コミットしていない変更があれば断る。取り出したコミット（head）も結果に書く。

change（REQ-058、REQ-059）
  直す直前の確かめをやり直し、取り出した後にプラグインのフォルダが変わっていないこと、
  決まりの番号と合否の基準の番号を確かめてから、--work の中に描き、
  プラグインのフォルダのファイルを描いたものに入れ替える。変わったファイルの一覧を changed.json に残す。コミットはしない。

change-guard
  試験の直しの後、changed.json の一覧の外で変わったファイルを示す。--restore で、直す前（HEAD）に戻す。

commit
  プラグインのフォルダの中だけをコミットし、印のタグを付け直し、作業用の一時フォルダを消す。push はしない。
  直す前に戻すコマンド（revert）も返す。直したコミットを打ち消して、プラグインのフォルダの中だけをコミットする形で、
  ほかのフォルダで git add してある変更があっても動く。

終了コード: 0 成功、1 断った・失敗した（違いが残っている）、2 使い方の誤り。
Python 3.9 以上で動く。PyYAML と jsonschema がなくても動く（jsonschema があれば task.json の形も確かめる）。
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True   # スキルのフォルダやひな形に __pycache__ を作らない

if sys.version_info < (3, 9):
    sys.stderr.write("Python 3.9 以上が要ります（今は %s）。\n" % sys.version.split()[0])
    raise SystemExit(2)

import argparse  # noqa: E402
import datetime  # noqa: E402
import importlib.util  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
import posixpath  # noqa: E402
import re  # noqa: E402
import shutil  # noqa: E402
import subprocess  # noqa: E402
from typing import Any, Callable, Dict, List, Optional, Set, Tuple  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TEMPLATE = os.path.normpath(os.path.join(HERE, "..", "..", "..", "template"))   # skills/make-plugin/scripts/ から見て、クリエイターの直下の template/
CHECKS_PATH = os.path.join(DEFAULT_TEMPLATE, "tests", "stage1", "check_structure.py")   # task.json の形の誤りを日本語で示すのに使う

CREATOR_NAME = "plugin-creator"                       # クリエイター自身の名前。生成プラグインの名前にはできない（記録のツールの名前が重なる）
WORK_NAME = ".plugin-creator-work"                    # 作業用の一時フォルダの名前（ユーザーの答え7）
EXT_PARENT = ("com.github.copilot", "extensions")
EXT_PLACEHOLDER = "_plugin_"                          # ひな形のエクステンションのフォルダ。生成プラグインの名前にする
ENTRY_PLACEHOLDER = "_entry_"                         # ひな形の入口のスキルのフォルダ。入口のスキルの名前にする
AGENTS_REL = "com.github.copilot/agents"
WORKER_FILE = "worker.agent.md"
SKIP_NAMES = {"__pycache__", ".git", "node_modules", ".venv", ".DS_Store"}   # ひな形から写さない・比べないもの

NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")          # プラグインとスキルの名前（R3 の勧め：a-z0-9 とハイフン）
WORKER_RE = re.compile(r"^worker(?:-[a-z0-9]+)*$")           # worker か worker-<名前>（task.schema.json と同じ）
KNOWLEDGE_ID = re.compile(r"^K-[0-9]+$")
TOOL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]*$")      # extra_tools の各要素（サーバー名/ツール名 など）
PLACEHOLDER = re.compile(r"(?<!\$)\{\{(slot:)?([A-Za-z][A-Za-z0-9_.-]*)\}\}")   # ${{…}}（シェルなどの書き方）は差し込み口にしない
SLOT_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]*$")
WORKER_SLOT = re.compile(r"\{\{slot:worker-task(?:\.[A-Za-z0-9._-]*)?\}\}")
EVAL_REL = re.compile(r"^tests/eval/[^/]+/eval\.json$")
EVAL_INPUT_REL = re.compile(r"^tests/eval/[^/]+/inputs/.+$")   # eval_inputs の to（EVAL の課題の入力のファイルの置き場所）
HEADING_SLOTS = re.compile(r"^(?:entry-task|orchestrator-task|verifier-task|worker-task(?:\..+)?|readme-what|readme-how)$")   # ひな形の ## の節の中に入る文
HIGH_HEADING = re.compile(r"^ {0,3}#{1,2}(?:[ \t]|$)")                                                  # # か ## で始まる見出し
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")                                                              # コードの囲み
# YAML の読み手が読めない字（json.dumps は escape しない）：U+007F〜U+009F、U+FFFE、U+FFFF。
# U+2028・U+2029 は読めるが、前後の空白ごと改行として畳まれて内容が変わる（PyYAML で確かめた）
INVISIBLE = re.compile("[\u007f-\u009f\u2028\u2029\ufffe\uffff]")
YAML_PLAIN = re.compile(r"^[A-Za-z][A-Za-z0-9._-]*$")        # 引用符なしで YAML に置いてよい値
YAML_RESERVED = {"y", "n", "yes", "no", "true", "false", "on", "off", "null"}   # YAML が真偽や null に読む言葉

# ヒアリングの記録（state.json）の記号。C1 のエクステンションの names.mjs と同じ（記録には内部の記号を書く決まり）
STAGE_GENERATE = "generate"             # 段階「生成」
STATUS_DECIDED = "decided"              # ナレッジの状態「決まった」
KINDS = ("criterion", "other")          # ナレッジの種類「合否の決め方」「それ以外」（tests/knowledge.json の kind と同じ）

MANIFEST_KEYS = ("plugin_name", "plugin_description", "entry_skill", "workers", "verifier", "orchestrator", "eval_inputs")
DESCRIPTION_MAX = 1024

# tools の作業ごとの分を入れる差し込み口（B2 のひな形の名前に合わせる。BLUEPRINT 8章に名前の決まりはない）。
# 統括の定義には tools を書かない（書くと、Copilot CLI は子の作業・検証のツールも統括の範囲に絞る。V1 の不具合 1）ので、統括の分はない
TOOL_TOKENS = {"worker": "worker_extra_tools", "verifier": "verifier_extra_tools"}

FALLBACK_GIT_NAME = "plugin-creator"
FALLBACK_GIT_EMAIL = "plugin-creator@localhost"

# ---- 今あるプラグインを直すとき（change-plugin）
# マニフェストを探す場所と順（直下 → 以前の形式。BLUEPRINT 4.1）
MANIFEST_PLACES = ("plugin.json", ".plugin/plugin.json", ".github/plugin/plugin.json", ".claude-plugin/plugin.json")
LEGACY_MANIFESTS = MANIFEST_PLACES[1:]   # 以前の形式のマニフェスト。直すと読まれなくなるので消す
# Agent Plugins 1.0.0 のマニフェストの項目（仕様 5.2）のうち、ひな形が書かないもの。直すときは元のマニフェストの値を引き継ぐ
CARRIED_MANIFEST_KEYS = ("author", "homepage", "repository", "license", "keywords", "extensions")
KNOWLEDGE_REL = "tests/knowledge.json"
REMOVED_REL = "tests/knowledge-removed.json"   # 外した決まりの番号（REQ-058、BLUEPRINT 4.3）
EXTRACT_JSON = "extract.json"
CHANGED_JSON = "changed.json"
TAG_BASE = "plugin-creator-generated"          # 印のタグ。直下でないプラグインは -<名前> を付ける（BLUEPRINT D9）
VERSION_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
CRITERION_ID = re.compile(r"^C-[0-9]{2,}$")
SLOT_LINE = re.compile(r"^\s*\{\{slot:([A-Za-z][A-Za-z0-9_.-]*)\}\}\s*$")
TRACE_ROW = re.compile(r"^\|\s*REQ-([0-9]+)\s*\|")
TASK_REQ_START = 101                            # 作業ごとの要件の番号の始まり（ひな形の仕様書 8章）
LIST_LIMIT = 10                                 # 断る文に並べるファイルの数の上限
# 試験の土台（BLUEPRINT D20）。違う・ないだけを見る
TESTS_BASE_FILES = ("tests/run.py",)
TESTS_BASE_DIRS = ("tests/stage1/", "tests/stage2/adapter/", "tests/stage2/core/", "tests/stage2/ui/")
TESTS_BASE_PATTERN = re.compile(r"^tests/stage2/fake-[^/]*\.mjs$")


class Refusal(Exception):
    """組み立てを断る。problems は、何が足りないかを書いた平易な日本語の文の一覧。"""

    def __init__(self, problems: Any) -> None:
        if isinstance(problems, str):
            problems = [problems]
        super().__init__("\n".join(problems))
        self.problems: List[str] = list(problems)


# ---------------------------------------------------------------- 小さな部品

def show(value: Any, limit: int = 60) -> str:
    text = json.dumps(value, ensure_ascii=False)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def real(path: str) -> str:
    return os.path.normcase(os.path.realpath(os.path.abspath(path)))


def is_inside(path: str, base: str) -> bool:
    """path が base の中にある（base 自身は含まない）。シンボリックリンクをたどった本当の場所で比べる。"""
    p, b = real(path), real(base)
    try:
        return p != b and os.path.commonpath([p, b]) == b
    except ValueError:   # ドライブが違う
        return False


def is_within(path: str, base: str) -> bool:
    """path が base の中か、base そのもの。"""
    return real(path) == real(base) or is_inside(path, base)


def posix_rel(path: str, base: str) -> str:
    return os.path.relpath(path, base).replace(os.sep, "/")


def shown_path(path: str) -> str:
    """コマンドの例に入れるパス。空白などがあれば二重引用符で囲む。"""
    return '"%s"' % path if re.search(r"[\s'\"$`;&|()<>*?]", path) else path


def listed(items: List[str], limit: int = LIST_LIMIT) -> str:
    """ファイルの一覧を、断る文に入れる形にする（多いときは先頭だけ）。"""
    head = "、".join(items[:limit])
    return head + ("ほか %d 件" % (len(items) - limit) if len(items) > limit else "")


def json_text(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


def json_escape(value: str) -> str:
    """JSON の文字列の中に置ける形（前後の二重引用符なし）。YAML の二重引用符の中にも置ける。"""
    return json.dumps(value, ensure_ascii=False)[1:-1]


def write_text(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def read_json(path: str, label: str, problems: List[str]) -> Any:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        problems.append("%s がありません。" % label)
    except (OSError, UnicodeDecodeError) as e:
        problems.append("%s を読めません（%s）。" % (label, e))
    except ValueError as e:
        problems.append("%s が JSON として読めません（%s）。" % (label, e))
    return None


def make_ignore(template: str) -> Callable[[str, List[str]], Set[str]]:
    """ひな形を写すとき・比べるときに飛ばすもの（キャッシュ、道具、試験の結果）。"""
    tests_dir = os.path.normpath(os.path.join(template, "tests"))

    def ignore(directory: str, names: List[str]) -> Set[str]:
        skipped = {n for n in names if n in SKIP_NAMES or n.endswith(".pyc")}
        if os.path.normpath(directory) == tests_dir and "results" in names:
            skipped.add("results")
        return skipped

    return ignore


# ---------------------------------------------------------------- 入力：ヒアリングの記録

def load_state(path: str) -> Dict[str, Any]:
    """ヒアリングの記録を読み、生成前の確認の関門（段階が「生成」で、承認の時刻がある）を確かめる。"""
    problems: List[str] = []
    state = read_json(path, "ヒアリングの記録（%s）" % path, problems)
    if problems:
        raise Refusal(problems)
    if not isinstance(state, dict):
        raise Refusal("ヒアリングの記録（%s）の形が違います（項目の集まりではありません）。" % path)
    if state.get("stage") != STAGE_GENERATE:
        raise Refusal(
            "ヒアリングの記録の段階が「生成」ではありません（今は %s）。生成前の確認でユーザーがよいと答え、"
            "記録のツールで段階を「生成」に進めてから、組み立ててください。" % show(state.get("stage")))
    approved = state.get("approvedAt")
    if not isinstance(approved, str) or not approved.strip():
        raise Refusal("ヒアリングの記録に承認の時刻（approvedAt）がありません。ユーザーが生成前の確認でよいと答える前には、組み立てられません。")
    if not isinstance(state.get("confirmation"), dict):
        raise Refusal("ヒアリングの記録に、生成前の確認で示したもの（confirmation）がありません。生成前の確認を受け付けてから、組み立ててください。")
    return state


def decided_knowledge(state: Dict[str, Any], problems: List[str]) -> List[Dict[str, str]]:
    """状態が「決まった」のナレッジを、記録の順に返す。候補と外したものは入れない。"""
    rows = state.get("knowledge")
    if rows is None:
        rows = []
    if not isinstance(rows, list):
        problems.append("ヒアリングの記録の knowledge が一覧ではありません。")
        return []
    found: List[Dict[str, str]] = []
    seen: Set[str] = set()
    for index, row in enumerate(rows, 1):
        if not isinstance(row, dict) or row.get("status") != STATUS_DECIDED:
            continue
        where = "ヒアリングの記録のナレッジ（%d 件目）" % index
        ident = row.get("id")
        if not isinstance(ident, str) or not KNOWLEDGE_ID.match(ident):
            problems.append("%sの番号 %s が K-数字 の形ではありません。" % (where, show(ident)))
            continue
        where = "ナレッジ %s" % ident
        kind = row.get("kind")
        if kind not in KINDS:
            problems.append("%sの種類 %s は、合否の決め方（criterion）かそれ以外（other）のどちらかにしてください。" % (where, show(kind)))
            continue
        text = row.get("text")
        if not isinstance(text, str) or not text.strip():
            problems.append("%sの文が空です。" % where)
            continue
        if ident in seen:
            problems.append("%sの番号が重なっています。" % where)
            continue
        seen.add(ident)
        item = row.get("itemName")
        if not isinstance(item, str) or not item.strip():
            item = row.get("item") if isinstance(row.get("item"), str) else ""
        found.append({"id": ident, "kind": kind, "item": item, "text": text})
        if row.get("replaces") is not None:   # 直すとき：中身を直して付け直した元の番号（BLUEPRINT 4.1）
            found[-1]["replaces"] = row.get("replaces")
    return found


def make_criteria(knowledge: List[Dict[str, str]], problems: List[str]) -> List[Dict[str, str]]:
    """合否の決め方のナレッジから、合否の基準を作る。番号は C-01 から。文はナレッジの文のまま（ユーザーの答え4）。"""
    criteria = [
        {"id": "C-%02d" % number, "text": row["text"], "knowledge": row["id"]}
        for number, row in enumerate((r for r in knowledge if r["kind"] == "criterion"), 1)
    ]
    if not criteria:
        problems.append("ヒアリングの記録に、状態が「決まった」の合否の決め方のナレッジが1件もありません。"
                        "作業の定義の合否の基準は、これをもとに作るので、1件以上が要ります。")
    return criteria


# ---------------------------------------------------------------- 入力：parts/

def check_description(value: Any, label: str, problems: List[str]) -> None:
    if not isinstance(value, str) or not value.strip():
        problems.append("%s が空か、文字ではありません。" % label)
    elif "\n" in value or "\r" in value:
        problems.append("%s は1行で書いてください。" % label)
    elif len(value) > DESCRIPTION_MAX:
        problems.append("%s は %d 文字以内にしてください（今は %d 文字）。" % (label, DESCRIPTION_MAX, len(value)))


def check_frontmatter_text(value: Any, label: str, problems: List[str]) -> None:
    """SKILL.md のフロントマターに入る文（入口のスキルの description）に、フロントマターを壊す字を入れさせない。
    `---` は、フロントマターの終わりと読まれて引用符が閉じない（Agent Skills の検証の参照実装が --- で分ける）。"""
    if isinstance(value, str) and ("---" in value or INVISIBLE.search(value)):
        problems.append("%s に --- や見えない制御文字を入れないでください（SKILL.md のフロントマターが壊れます）。" % label)


def check_tools(value: Any, label: str, problems: List[str]) -> List[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        problems.append("%s は、ツールの名前の一覧にしてください。" % label)
        return []
    tools: List[str] = []
    for tool in value:
        if isinstance(tool, str) and TOOL_RE.match(tool):
            tools.append(tool)
        else:
            problems.append("%s の %s は、ツールの名前として使えません（英数字と . _ : / - だけ。例：サーバー名/ツール名）。" % (label, show(tool)))
    return tools


def load_eval_inputs(value: Any, label: str, problems: List[str]) -> List[Dict[str, str]]:
    """manifest.json の eval_inputs：EVAL の課題の入力に使う実物のファイル [{from: 実物の絶対パス, to: 生成プラグインの中の置き場所}]。
    実物がなければ断り、どれがないかを示す。"""
    if value is None:
        return []
    if not isinstance(value, list):
        problems.append("%s の eval_inputs は、from と to を持つ項目の一覧にしてください。" % label)
        return []
    found: List[Dict[str, str]] = []
    seen: Set[str] = set()
    for number, item in enumerate(value, 1):
        where = "%s の eval_inputs の %d 番目" % (label, number)
        if not isinstance(item, dict) or sorted(item) != ["from", "to"]:
            problems.append("%sは、from（実物の絶対パス）と to（生成プラグインの中の置き場所）だけを持つ項目にしてください。" % where)
            continue
        source, target = item["from"], item["to"]
        if not isinstance(source, str) or not os.path.isabs(source):
            problems.append("%sの from %s は、実物のファイルの絶対パスにしてください。" % (where, show(source)))
        elif not os.path.exists(source):
            problems.append("%sの from のファイル %s がありません。" % (where, source))
        elif not os.path.isfile(source):
            problems.append("%sの from %s はファイルではありません（フォルダは写せません）。" % (where, source))
        if not isinstance(target, str) or not EVAL_INPUT_REL.match(target) or "\\" in target \
                or any(part in ("", ".", "..") for part in target.split("/")):
            problems.append("%sの to %s は、tests/eval/<課題>/inputs/<名前> の形のパスにしてください。" % (where, show(target)))
        elif target in seen:
            problems.append("%sの to %s が重なっています。" % (where, target))
        else:
            seen.add(target)
            if isinstance(source, str):
                found.append({"from": source, "to": target})
    return found


def load_manifest(work: str, problems: List[str]) -> Optional[Dict[str, Any]]:
    """parts/manifest.json（組み立ての設定。BLUEPRINT 8章）を確かめて、使いやすい形にする。"""
    label = "組み立ての設定（parts/manifest.json）"
    data = read_json(os.path.join(work, "parts", "manifest.json"), label, problems)
    if data is None:
        return None
    if not isinstance(data, dict):
        problems.append("%s の形が違います（項目の集まりではありません）。" % label)
        return None
    before = len(problems)
    unknown = [k for k in data if k not in MANIFEST_KEYS]
    if unknown:
        problems.append("%s に知らない項目があります：%s。使える項目：%s。" % (label, "、".join(unknown), "、".join(MANIFEST_KEYS)))

    name = data.get("plugin_name")
    if not isinstance(name, str) or not NAME_RE.match(name) or len(name) > 64:
        problems.append("%s の plugin_name は、小文字の英数字とハイフンだけの64文字以内の名前にしてください（今は %s）。" % (label, show(name)))
        name = None
    elif name == CREATOR_NAME:
        problems.append("%s の plugin_name を %s にはできません。クリエイター自身の名前で、記録のツールの名前（%s_open など）と"
                        "マーケットプレイスの名前が重なります。別の名前にしてください。" % (label, CREATOR_NAME, CREATOR_NAME))
        name = None
    check_description(data.get("plugin_description"), "%s の plugin_description" % label, problems)

    entry = data.get("entry_skill")
    entry_name = entry_description = None
    if not isinstance(entry, dict):
        problems.append("%s の entry_skill は、name と description を持つ項目の集まりにしてください。" % label)
    else:
        extra = [k for k in entry if k not in ("name", "description")]
        if extra:
            problems.append("%s の entry_skill に知らない項目があります：%s。" % (label, "、".join(extra)))
        entry_name = entry.get("name")
        if not isinstance(entry_name, str) or not NAME_RE.match(entry_name) or len(entry_name) > 64:
            problems.append("%s の entry_skill.name は、小文字の英数字とハイフンだけの64文字以内の名前にしてください（今は %s）。" % (label, show(entry_name)))
            entry_name = None
        entry_description = entry.get("description")
        check_description(entry_description, "%s の entry_skill.description" % label, problems)
        check_frontmatter_text(entry_description, "%s の entry_skill.description" % label, problems)

    workers: List[Dict[str, Any]] = []
    raw_workers = data.get("workers")
    if not isinstance(raw_workers, list) or not raw_workers:
        problems.append("%s の workers は、作業エージェントを1体以上、一覧にしてください。" % label)
    else:
        seen: Set[str] = set()
        for number, worker in enumerate(raw_workers, 1):
            where = "%s の workers の %d 番目" % (label, number)
            if not isinstance(worker, dict):
                problems.append("%sは、agent と label を持つ項目の集まりにしてください。" % where)
                continue
            extra = [k for k in worker if k not in ("agent", "label", "extra_tools")]
            if extra:
                problems.append("%sに知らない項目があります：%s。" % (where, "、".join(extra)))
            agent, tag = worker.get("agent"), worker.get("label")
            if not isinstance(agent, str) or not WORKER_RE.match(agent):
                problems.append("%sの agent は、worker か worker-<名前>（小文字の英数字とハイフン）にしてください（今は %s）。" % (where, show(agent)))
                continue
            if agent in seen:
                problems.append("%sの agent %s が重なっています。" % (where, agent))
                continue
            seen.add(agent)
            if not isinstance(tag, str) or not tag.strip() or "\n" in tag or "\r" in tag:
                problems.append("%sの label（画面での呼び名）は、1行の文字にしてください。" % where)
            workers.append({"agent": agent, "label": tag, "extra_tools": check_tools(worker.get("extra_tools"), "%sの extra_tools" % where, problems)})

    roles: Dict[str, List[str]] = {}
    for role in ("verifier", "orchestrator"):
        part = data.get(role)
        if part is None:
            roles[role] = []
        elif not isinstance(part, dict) or any(k != "extra_tools" for k in part):
            problems.append("%s の %s は、extra_tools だけを持つ項目の集まりにしてください。" % (label, role))
            roles[role] = []
        else:
            roles[role] = check_tools(part.get("extra_tools"), "%s の %s.extra_tools" % (label, role), problems)
            if role == "orchestrator" and roles[role]:
                problems.append("%s の orchestrator.extra_tools は空にしてください。統括エージェントの定義には tools を書きません"
                                "（書くと、作業・検証のエージェントが受け取れるツールも絞られます）。統括が使えるツールは、エクステンションが決めています。"
                                "作業や検証に MCP のツールが要るときは、その作業エージェント（workers の extra_tools）か検証エージェント（verifier.extra_tools）に書いてください。" % label)

    eval_inputs = load_eval_inputs(data.get("eval_inputs"), label, problems)

    if len(problems) > before or None in (name, entry_name):
        return None
    return {
        "plugin_name": name,
        "plugin_description": data["plugin_description"],
        "entry_name": entry_name,
        "entry_description": entry_description,
        "workers": workers,
        "verifier_tools": roles["verifier"],
        "eval_inputs": eval_inputs,
    }


_checks_modules: Dict[str, Any] = {}   # 場所 -> 読み込んだ検査（None：使えない）


def load_checks(path: Optional[str] = None) -> Any:
    """1段目の検査（ひな形の check_structure.py）を読み込む。task.json の形の誤りを、日本語の文で示すために使う。
    PyYAML か jsonschema がなければ None（組み立ての時点では、まだ試験の道具を入れていないことがある）。"""
    path = path or CHECKS_PATH
    if path in _checks_modules:
        return _checks_modules[path]
    _checks_modules[path] = None
    try:
        import jsonschema  # noqa: F401
        import yaml  # noqa: F401
        if not os.path.isfile(path):
            return None
        spec = importlib.util.spec_from_file_location("plugin_creator_check_structure_%d" % len(_checks_modules), path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)   # 道具が古いときは SystemExit で止まる
        _checks_modules[path] = module
    except (ImportError, Exception, SystemExit):
        _checks_modules[path] = None
    return _checks_modules[path]


def load_task(work: str, template: str, manifest: Optional[Dict[str, Any]], criteria: List[Dict[str, str]],
              problems: List[str], warnings: List[str]) -> Optional[Dict[str, Any]]:
    """parts/task.json に合否の基準を足して、作業の定義の形（core/task.schema.json）で確かめる。"""
    label = "作業の定義（parts/task.json）"
    data = read_json(os.path.join(work, "parts", "task.json"), label, problems)
    if data is None:
        return None
    if not isinstance(data, dict):
        problems.append("%s の形が違います（項目の集まりではありません）。" % label)
        return None
    if data.get("criteria") not in (None, []):
        problems.append("%s に criteria があります。合否の基準は、ユーザーと確かめたナレッジから組み立てのスクリプトが書くので、"
                        "作業エージェントは書きません。criteria を取り除いてください。" % label)
        return None
    task: Dict[str, Any] = {}
    for key in ("name", "maxIterationsDefault"):
        if key in data:
            task[key] = data[key]
    task["criteria"] = [dict(c) for c in criteria]
    for key, value in data.items():
        if key not in task and key != "criteria":
            task[key] = value

    schema_path = os.path.join(template, *EXT_PARENT, EXT_PLACEHOLDER, "core", "task.schema.json")
    checks = load_checks()
    if checks is None:
        warnings.append("jsonschema か PyYAML が入っていないので、task.json の形の確かめは、1段目（構造の検査）に任せました。")
    else:
        try:
            with open(schema_path, encoding="utf-8") as f:
                schema = json.load(f)
        except (OSError, ValueError) as e:
            problems.append("ひな形の core/task.schema.json を読めません（%s）。" % e)
            return None
        for message in checks.schema_problems(task, schema, "作業の定義 task.json:"):
            problems.append("%s（直す場所：parts/task.json）" % message)

    listed = task.get("workers")
    if manifest is not None and isinstance(listed, list) and all(isinstance(w, dict) for w in listed):
        in_task = {str(w.get("agent")): w.get("label") for w in listed}
        in_manifest = {w["agent"]: w["label"] for w in manifest["workers"]}
        if sorted(in_task) != sorted(in_manifest):
            problems.append("作業エージェントの名前が、parts/manifest.json の workers（%s）と parts/task.json の workers（%s）で合っていません。"
                            % ("、".join(sorted(in_manifest)), "、".join(sorted(in_task))))
        else:
            for agent in sorted(in_manifest):
                if in_task[agent] != in_manifest[agent]:
                    problems.append("作業エージェント %s の呼び名が、parts/manifest.json（%s）と parts/task.json（%s）で違います。同じにしてください。"
                                    % (agent, show(in_manifest[agent]), show(in_task[agent])))
    return task


def high_headings(text: str) -> List[Tuple[int, str]]:
    """# か ## で始まる見出しの行（行の番号, 行）。コードの囲みの中は数えない。"""
    found: List[Tuple[int, str]] = []
    fence = ""
    for number, line in enumerate(text.split("\n"), 1):
        mark = FENCE.match(line)
        if mark:
            fence = "" if fence == mark.group(1)[0] else (fence or mark.group(1)[0])
        elif not fence and HIGH_HEADING.match(line):
            found.append((number, line.strip()))
    return found


def load_slots(work: str, problems: List[str]) -> Dict[str, str]:
    """parts/slots/<差し込み口の名前>.md を読む。空のものと、名前の形が違うものは断る。"""
    base = os.path.join(work, "parts", "slots")
    slots: Dict[str, str] = {}
    if not os.path.isdir(base):
        return slots
    for entry in sorted(os.listdir(base)):
        path = os.path.join(base, entry)
        if entry in SKIP_NAMES:
            continue
        name = entry[:-3] if entry.endswith(".md") else ""
        if os.path.isdir(path) or not SLOT_NAME.match(name):
            problems.append("parts/slots/%s は差し込み口の文ではありません。ファイル名は <差し込み口の名前>.md にしてください。" % entry)
            continue
        try:
            with open(path, encoding="utf-8") as f:
                text = f.read()
        except (OSError, UnicodeDecodeError) as e:
            problems.append("parts/slots/%s を読めません（%s）。" % (entry, e))
            continue
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        if HEADING_SLOTS.match(name):   # ひな形の ## の節の中に入るので、見出しは ### 以下
            for number, line in high_headings(text):
                problems.append("parts/slots/%s の %d 行目「%s」：差し込み口 {{slot:%s}} の文の見出しは ### 以下にしてください"
                                "（ひな形の ## の節の中に入るため）。" % (entry, number, line, name))
        text = text.strip("\n")
        if not text.strip():
            problems.append("parts/slots/%s の中身が空です。差し込み口 %s に入れる文を書いてください。" % (entry, "{{slot:%s}}" % name))
            continue
        slots[name] = text
    return slots


def list_parts_files(work: str, problems: List[str]) -> List[str]:
    """parts/files/ の下のファイルを、生成プラグインの中のパス（/ 区切り）で返す。"""
    base = os.path.join(work, "parts", "files")
    found: List[str] = []
    if not os.path.isdir(base):
        return found
    for directory, dirs, names in os.walk(base):
        keep = []
        for d in sorted(dirs):
            path = os.path.join(directory, d)
            if d in SKIP_NAMES and d != ".git":
                continue
            if d in (".git", WORK_NAME):
                problems.append("parts/files/%s は置けません（%s）。" % (posix_rel(path, base), d))
            elif os.path.islink(path):
                problems.append("parts/files/%s はシンボリックリンクです。そのまま足すファイルに、リンクは使えません。" % posix_rel(path, base))
            else:
                keep.append(d)
        dirs[:] = keep
        for n in sorted(names):
            path = os.path.join(directory, n)
            if n in SKIP_NAMES or n.endswith(".pyc"):
                continue
            if os.path.islink(path):
                problems.append("parts/files/%s はシンボリックリンクです。そのまま足すファイルに、リンクは使えません。" % posix_rel(path, base))
            else:
                found.append(posix_rel(path, base))
    return sorted(found)


def resolve_criterion(item: Dict[str, Any], by_id: Dict[str, Dict[str, str]], by_knowledge: Dict[str, Dict[str, str]],
                      where: str, problems: List[str]) -> Optional[Dict[str, str]]:
    cid, kid = item.get("id"), item.get("knowledge")
    if cid is not None:
        found = by_id.get(cid) if isinstance(cid, str) else None
        if found is None:
            problems.append("%sの id %s は、作業の定義の基準の番号にありません（今ある番号：%s）。" % (where, show(cid), "、".join(by_id)))
            return None
        if kid is not None and kid != found["knowledge"]:
            problems.append("%sの id %s と knowledge %s が合っていません（%s のもとのナレッジは %s）。" % (where, cid, show(kid), cid, found["knowledge"]))
            return None
        return found
    if kid is not None:
        found = by_knowledge.get(kid) if isinstance(kid, str) else None
        if found is None:
            problems.append("%sの knowledge %s は、合否の決め方のナレッジの番号ではありません（使える番号：%s）。" % (where, show(kid), "、".join(by_knowledge)))
        return found
    problems.append("%sに、どの基準の採点かを示す knowledge（もとのナレッジの番号）がありません。" % where)
    return None


def prepare_eval(base: str, rels: List[str], criteria: List[Dict[str, str]], problems: List[str], warnings: List[str]) \
        -> Tuple[Dict[str, str], Dict[str, Dict[str, Any]]]:
    """EVAL の課題（tests/eval/*/eval.json）の criteria に、作業の定義の基準の番号と文の写しを入れる（BLUEPRINT 4.3）。
    作業エージェントは、基準ごとの採点のしかた（grading と check）と、どの基準かを示す knowledge（か id）だけを書く。
    返すのは、(書き直した eval.json の中身〔生成プラグインの中のパス -> 文〕,
              確かめた課題と突き合わせるための、eval.json から読んだもの〔パス -> {prompt, knowledge, inputs, settings}〕)。"""
    by_id = {c["id"]: c for c in criteria}
    by_knowledge = {c["knowledge"]: c for c in criteria}
    filled: Dict[str, str] = {}
    read: Dict[str, Dict[str, Any]] = {}
    covered: Set[str] = set()
    for rel in [r for r in rels if EVAL_REL.match(r)]:
        label = "parts/files/" + rel
        before = len(problems)
        data = read_json(os.path.join(base, *rel.split("/")), label, problems)
        if data is None:
            continue
        if not isinstance(data, dict):
            problems.append("%s の形が違います（項目の集まりではありません）。" % label)
            continue
        items = data.get("criteria")
        if not isinstance(items, list) or not items:
            problems.append("%s に criteria（基準ごとの採点のしかた）がありません。" % label)
            continue
        inputs, settings = data.get("inputs", []), data.get("settings", {})
        if not isinstance(inputs, list) or not all(isinstance(i, str) and i.strip() for i in inputs):
            problems.append("%s の inputs は、課題のフォルダからの入力のファイルの場所（例：inputs/前回の週報.docx）の一覧にしてください。" % label)
        if not isinstance(settings, dict):
            problems.append("%s の settings は、maxIterations と task を持つ項目の集まりにしてください。" % label)
        new_items = []
        knowledge_ids = []
        for number, item in enumerate(items, 1):
            where = "%s の criteria の %d 番目" % (label, number)
            if not isinstance(item, dict):
                problems.append("%sは、項目の集まりにしてください。" % where)
                continue
            found = resolve_criterion(item, by_id, by_knowledge, where, problems)
            if found is None:
                continue
            covered.add(found["id"])
            knowledge_ids.append(found["knowledge"])
            rest = {k: v for k, v in item.items() if k not in ("id", "text", "knowledge")}
            new_items.append(dict([("id", found["id"]), ("text", found["text"])] + list(rest.items())))
        data["criteria"] = new_items
        filled[rel] = json_text(data)
        if len(problems) == before:   # 読み取れた課題だけを、確かめた課題と突き合わせる
            prompt = data.get("prompt")
            read[rel] = {"prompt": prompt.strip() if isinstance(prompt, str) else None, "knowledge": knowledge_ids,
                         "inputs": list(inputs), "settings": dict(settings)}
    if filled:
        for c in criteria:
            if c["id"] not in covered:
                warnings.append("基準 %s（ナレッジ %s）が、どの EVAL の課題にも入っていません。構造の検査で不合格になります。" % (c["id"], c["knowledge"]))
    return filled, read


def confirmed_eval_tasks(confirmation: Dict[str, Any], problems: List[str]) -> List[Dict[str, Any]]:
    """ヒアリングの記録の confirmation.evalTasks（ユーザーが生成前の確認で見て、よいと答えた課題）を読む。"""
    tasks = confirmation.get("evalTasks")
    if not isinstance(tasks, list) or not tasks:
        problems.append("ヒアリングの記録に、生成前の確認で示した EVAL の課題（confirmation.evalTasks）がありません。")
        return []
    found: List[Dict[str, Any]] = []
    for number, task in enumerate(tasks, 1):
        where = "ヒアリングの記録の EVAL の課題（%d 件目）" % number
        if not isinstance(task, dict) or not isinstance(task.get("prompt"), str) or not task["prompt"].strip():
            problems.append("%sに、頼むときの言葉（prompt）がありません。" % where)
            continue
        inputs = []
        for item in task.get("inputs") or []:
            path = item.get("path") if isinstance(item, dict) else item
            if not isinstance(path, str) or not path.strip():
                problems.append("%sの入力のファイルに、場所（path）がありません。" % where)
                continue
            inputs.append({"path": path.strip(), "provisional": isinstance(item, dict) and item.get("provisional") is True})
        settings = task.get("settings")
        found.append({"prompt": task["prompt"].strip(), "inputs": inputs, "criteria": [str(k) for k in task.get("criteria") or []],
                      "settings": settings if isinstance(settings, dict) else {}})
    return found


def eval_differences(task: Dict[str, Any], info: Dict[str, Any], rel: str) -> List[str]:
    """確かめた課題 task と、作業エージェントが書いた eval.json（rel）の違い（criteria、inputs、settings）。"""
    label = "parts/files/%s" % rel
    out: List[str] = []
    want, have = sorted(task["criteria"]), sorted(info["knowledge"])
    if want != have:
        out.append("%s の criteria（基準にするナレッジ）が、確かめた課題と違います（確かめた課題：%s／eval.json：%s）。"
                   % (label, "、".join(want) or "なし", "、".join(have) or "なし"))
    folder = rel.rsplit("/", 1)[0]
    have_inputs = sorted({posixpath.normpath(folder + "/" + i.replace("\\", "/")) for i in info["inputs"]})
    want_inputs = sorted(set(task["places"]))
    if want_inputs != have_inputs:
        lost, extra = [p for p in want_inputs if p not in have_inputs], [p for p in have_inputs if p not in want_inputs]
        out.append("%s の inputs（入力のファイル）が、確かめた課題と違います：%s%s。"
                   % (label, ("確かめたのに入っていない：" + "、".join(lost)) if lost else "",
                      ("%s入っているのに確かめていない：%s" % ("／" if lost else "", "、".join(extra))) if extra else ""))
    if task["settings"] != info["settings"]:
        out.append("%s の settings（作業の画面に入れる設定の値）が、確かめた課題と違います（確かめた課題：%s／eval.json：%s）。"
                   % (label, json.dumps(task["settings"], ensure_ascii=False), json.dumps(info["settings"], ensure_ascii=False)))
    return out


def check_confirmed_evals(confirmation: Dict[str, Any], evals: Dict[str, Dict[str, Any]], eval_inputs: List[Dict[str, str]],
                          parts_files: List[str], problems: List[str]) -> None:
    """作業エージェントが書いた eval.json が、ユーザーが生成前の確認でよいと答えた課題と同じかを確かめる（REQ-038、X2-03）。
    課題の数、頼むときの言葉（prompt）、基準にするナレッジの番号の組、入力のファイル、設定の値。
    課題は prompt で結びつける（記録の課題に番号はない）。確かめていない入力のファイルは、リポジトリに入れない。"""
    tasks = confirmed_eval_tasks(confirmation, problems)
    if not tasks:
        return
    # 実物のファイル -> 生成プラグインの中の場所。同じ実物を2つ以上の課題で使うときは、課題ごとに1つずつ場所がある
    places: Dict[str, List[str]] = {}
    for i in eval_inputs:
        places.setdefault(os.path.normpath(i["from"]), []).append(i["to"])
    for task in tasks:
        for item in task["inputs"]:
            if not item["provisional"] and os.path.normpath(item["path"]) not in places:
                problems.append("確かめた課題「%s」の入力の実物 %s が、parts/manifest.json の eval_inputs の from にありません。"
                                "実物のファイルは eval_inputs で指定してください。" % (clip(task["prompt"]), item["path"]))

    def places_of(task: Dict[str, Any], folder: Optional[str]) -> List[str]:
        """課題の入力の、生成プラグインの中の場所。実物は、eval_inputs の to のうち、課題のフォルダ folder の中のものにする。"""
        out: List[str] = []
        for item in task["inputs"]:
            if item["provisional"]:   # 仮のファイルの path は、生成プラグインの中の場所
                out.append(posixpath.normpath(item["path"].replace("\\", "/")))
                continue
            targets = places.get(os.path.normpath(item["path"]))   # 実物のファイルの path は、ユーザーの手元の絶対パス。eval_inputs で写す
            if targets:
                inside = [t for t in targets if folder is not None and t.startswith(folder + "/")]
                out.append(inside[0] if inside else targets[0])
        return out

    def differences(task: Dict[str, Any], rel: str) -> List[str]:
        task["places"] = places_of(task, rel.rsplit("/", 1)[0])
        return eval_differences(task, unused[rel], rel)

    expected: Set[str] = set()
    unused = dict(evals)
    for task in tasks:
        candidates = [rel for rel, info in unused.items() if info["prompt"] == task["prompt"]]
        if not candidates:
            problems.append("確かめた課題「%s」（頼むときの言葉）に当たる EVAL の課題が、parts/files/tests/eval/<課題>/eval.json にありません。"
                            "頼むときの言葉（prompt）は、確かめた課題と同じにしてください。" % clip(task["prompt"]))
            expected.update(places_of(task, None))
            continue
        chosen = next((rel for rel in candidates if not differences(task, rel)), candidates[0])
        problems.extend(differences(task, chosen))
        expected.update(task["places"])
        unused.pop(chosen)
    for rel, info in sorted(unused.items()):
        problems.append("parts/files/%s の課題（頼むときの言葉「%s」）は、ユーザーが生成前の確認で確かめた課題にありません。"
                        "確かめていない課題は入れられません。" % (rel, clip(info["prompt"] or "")))

    inputs_dir = re.compile(r"^tests/eval/[^/]+/inputs/")
    for place in sorted({r for r in parts_files if inputs_dir.match(r)} | {i["to"] for i in eval_inputs}):
        if place not in expected:
            problems.append("EVAL の課題の入力のファイル %s は、ユーザーが生成前の確認で確かめた入力にありません。確かめていないファイルは入れられません。" % place)


def clip(text: str, limit: int = 40) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


def check_output_path(work: str, out: str, problems: List[str]) -> None:
    """--out は、まだないフォルダで、作業フォルダ（--work の親）の中にあること（REQ-021、REQ-036）。"""
    if os.path.basename(os.path.normpath(work)) != WORK_NAME:
        problems.append("--work は、作業フォルダの中の %s にしてください（今は %s）。" % (WORK_NAME, work))
        return
    if not os.path.isdir(work):
        problems.append("作業用の一時フォルダ（%s）がありません。" % work)
        return
    work_folder = os.path.dirname(work)
    if os.path.lexists(out):
        problems.append("出力先 %s がすでにあります。作り直しのときも、まだないフォルダに作ります。別のフォルダの名前を指定してください"
                        "（今あるフォルダは変えません）。" % out)
    elif not is_inside(out, work_folder):
        problems.append("出力先 %s が作業フォルダ %s の中にありません。生成プラグインは、作業フォルダの中の新しいフォルダに作ります。" % (out, work_folder))
    elif is_inside(out, work):
        problems.append("出力先 %s が作業用の一時フォルダ %s の中です。組み立ての最後にそのフォルダを消すので、別の場所にしてください。" % (out, work))
    elif not os.path.isdir(os.path.dirname(out)):
        problems.append("出力先 %s の親のフォルダがありません。" % out)


# ---------------------------------------------------------------- ひな形の加工

def frontmatter_span(text: str) -> Optional[Tuple[int, int]]:
    """先頭の --- と --- の間（フロントマター）の範囲 [始まり, 終わり)。なければ None。"""
    first = text.find("\n")
    if first < 0 or text[:first].strip() != "---":
        return None
    pos = first + 1
    while pos <= len(text):
        end = text.find("\n", pos)
        line_end = len(text) if end < 0 else end
        if text[pos:line_end].strip() == "---":
            return first + 1, pos
        if end < 0:
            return None
        pos = end + 1
    return None


def worker_copy(text: str, agent: str) -> str:
    """worker.agent.md を元に、作業エージェント agent のファイルの中身を作る。"""
    text = WORKER_SLOT.sub("{{slot:worker-task.%s}}" % agent, text)
    span = frontmatter_span(text)
    if span:
        head = re.sub(r"(?m)^name:[ \t]*.*$", lambda _m: "name: %s" % agent, text[span[0]:span[1]])
        text = text[:span[0]] + head + text[span[1]:]
    return text


def apply_slots(text: str, slots: Dict[str, str], used: Set[str]) -> str:
    """{{slot:名前}} を文で置き換える。単独の行なら行ごと（字下げを引き継ぐ）、行の途中ならその場で。"""
    def inline(m: "re.Match[str]") -> str:
        name = m.group(2)
        if not m.group(1) or name not in slots:
            return m.group(0)
        used.add(name)
        return slots[name]

    out: List[str] = []
    for line in text.splitlines(keepends=True):
        body = line.rstrip("\r\n")
        newline = line[len(body):] or "\n"
        m = PLACEHOLDER.fullmatch(body.strip())
        if m and m.group(1) and m.group(2) in slots:
            used.add(m.group(2))
            indent = body[: len(body) - len(body.lstrip())]
            for piece in slots[m.group(2)].split("\n"):
                out.append((indent + piece if piece else piece) + newline)
        elif "{{slot:" in line:
            out.append(PLACEHOLDER.sub(inline, line))
        else:
            out.append(line)
    return "".join(out)


def apply_line_tokens(text: str, tokens: Dict[str, Tuple[str, List[str], str]], consumed: Set[str]) -> str:
    """行ごと置き換える差し込み口（tools の作業ごとの分、統括の定義に入れる作業エージェントの一覧。B2 の取り決め）。
    その字だけの行を、行の一覧に置き換える。その行に字下げがあればそれを、なければ既定の字下げを付ける。
    行の一覧が空なら、行ごと消える。"""
    if not tokens:
        return text
    out: List[str] = []
    for line in text.splitlines(keepends=True):
        body = line.rstrip("\r\n")
        newline = line[len(body):] or "\n"
        m = PLACEHOLDER.fullmatch(body.strip())
        if m and not m.group(1) and m.group(2) in tokens:
            default_indent, items, _required = tokens[m.group(2)]
            consumed.add(m.group(2))
            indent = body[: len(body) - len(body.lstrip())] or default_indent
            out.extend(indent + item + newline for item in items)
        else:
            out.append(line)
    return "".join(out)


def yaml_value(text: str, m: "re.Match[str]", value: str) -> str:
    """YAML のフロントマターの中の値。二重引用符の中なら中身だけ（JSON の文字列の書き方）、`キー: {{名前}}` の形なら
    名前などは引用符なし・それ以外は二重引用符つきの文字列、行の途中のそれ以外はそのまま入れる。"""
    line_start = text.rfind("\n", 0, m.start()) + 1
    line_end = text.find("\n", m.end())
    line = text[line_start:(len(text) if line_end < 0 else line_end)]
    if len(re.findall(r'(?<!\\)"', text[line_start:m.start()])) % 2 == 1:
        return json_escape(value)
    if re.fullmatch(r"[ \t]*[A-Za-z_][\w-]*:[ \t]+" + re.escape(m.group(0)) + r"[ \t]*\r?", line):
        if YAML_PLAIN.match(value) and value.lower() not in YAML_RESERVED:
            return value   # 名前など。引用符なしでも、数や真偽に読まれない
        return json.dumps(value, ensure_ascii=False)
    return value


def apply_values(text: str, rel: str, values: Dict[str, str]) -> str:
    """{{名前}} を決まった値で置き換える。JSON のファイルでは JSON の文字列の中身として、
    SKILL.md やエージェントの定義のフロントマターでは YAML の値として、そのほかはそのまま入れる。"""
    span = frontmatter_span(text) if rel.endswith(".md") else None

    def repl(m: "re.Match[str]") -> str:
        if m.group(1) or m.group(2) not in values:
            return m.group(0)
        value = values[m.group(2)]
        if rel.endswith(".json"):
            return json_escape(value)
        if span and span[0] <= m.start() < span[1]:
            return yaml_value(text, m, value)
        return value

    return PLACEHOLDER.sub(repl, text)


def fill_template(out: str, plugin_name: str, slots: Dict[str, str], values: Dict[str, str],
                  line_tokens: Dict[str, Dict[str, Tuple[str, List[str], str]]], problems: List[str], warnings: List[str]) -> None:
    """ひな形から写したファイルの差し込み口を埋める。土台のファイル（エクステンションのフォルダ）は書き換えない。"""
    base_prefix = "%s/%s/" % ("/".join(EXT_PARENT), plugin_name)
    used: Set[str] = set()
    consumed: Set[Tuple[str, str]] = set()
    leftovers: List[Tuple[str, int, str]] = []
    for directory, dirs, names in os.walk(out):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_NAMES)
        for name in sorted(names):
            path = os.path.join(directory, name)
            rel = posix_rel(path, out)
            try:
                with open(path, "rb") as f:
                    data = f.read()
                if b"\0" in data:
                    continue   # 文字のファイルではない（フォントや画像。中のバイトが、たまたま差し込み口に見えることがある）
                text = data.decode("utf-8")
            except (OSError, UnicodeDecodeError):
                continue   # 文字のファイルではない
            if "{{" not in text:
                continue
            if not rel.startswith(base_prefix):
                done: Set[str] = set()
                new = apply_slots(text, slots, used)
                new = apply_line_tokens(new, line_tokens.get(rel, {}), done)
                new = apply_values(new, rel, values)
                consumed.update((rel, token) for token in done)
                if new != text:
                    write_text(path, new)
                    text = new
            for m in PLACEHOLDER.finditer(text):
                leftovers.append((rel, text.count("\n", 0, m.start()) + 1, m.group(0)))

    reported: Set[Tuple[str, str]] = set()
    for rel, line, token in leftovers:
        if (rel, token) in reported:
            continue
        reported.add((rel, token))
        if token.startswith("{{slot:"):
            name = token[len("{{slot:"):-2]
            if name in slots:
                problems.append("差し込み口 %s が、%s の %d 行目に残っています。差し込み口の文（parts/slots/）の中に、別の差し込み口は書けません。"
                                % (token, rel, line))
            else:
                problems.append("差し込み口 %s（%s の %d 行目）が埋まっていません。parts/slots/%s.md に入れる文を書いてください。" % (token, rel, line, name))
        elif rel.startswith(base_prefix):
            problems.append("土台のファイル %s の %d 行目に差し込み口 %s があります。土台は書き換えないので、ひな形の誤りです。" % (rel, line, token))
        else:
            problems.append("差し込み口 %s（%s の %d 行目）に入れる値が決まっていません。ひな形が使う名前と、組み立てのスクリプトが入れる名前が合っていません。"
                            % (token, rel, line))
    for rel, tokens in sorted(line_tokens.items()):
        for token, (_indent, _items, required) in tokens.items():
            if required and (rel, token) not in consumed:
                problems.append("%s に、parts/manifest.json の %s を入れる場所 {{%s}} がありません。ひな形のエージェントの定義を直してください。"
                                % (rel, required, token))
    for name in sorted(set(slots) - used):
        warnings.append("parts/slots/%s.md は、ひな形のどの差し込み口にも使われていません（文は入っていません）。" % name)


def line_token_map(manifest: Dict[str, Any]) -> Dict[str, Dict[str, Tuple[str, List[str], str]]]:
    """エージェントの定義のファイル -> {行ごと置き換える差し込み口の名前: (字下げの既定, 行の一覧, 必須のときの言い方)}。
    tools の作業ごとの分は `- "名前"` の行。ツールがあるのにひな形に置き場所がなければ断る（必須）。
    統括の定義には、作業エージェントの一覧（1行ごとに、プラグインの名前:agent をバッククォートで囲み、：と呼び名を続ける）を入れる。"""
    def tools(items: List[str]) -> Tuple[str, List[str], str]:
        required = "extra_tools（%s）" % "、".join(items) if items else ""
        return "  ", ["- " + json.dumps(tool, ensure_ascii=False) for tool in items], required

    plugin = manifest["plugin_name"]
    tokens = {
        "%s/orchestrator.agent.md" % AGENTS_REL: {
            "worker_agents": ("", ["- `%s:%s`：%s" % (plugin, w["agent"], w["label"]) for w in manifest["workers"]], ""),
        },
        "%s/verifier.agent.md" % AGENTS_REL: {TOOL_TOKENS["verifier"]: tools(manifest["verifier_tools"])},
    }
    for worker in manifest["workers"]:
        tokens["%s/%s.agent.md" % (AGENTS_REL, worker["agent"])] = {TOOL_TOKENS["worker"]: tools(worker["extra_tools"])}
    return tokens


# ---------------------------------------------------------------- 土台の確かめ

def read_bytes(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


def template_base(template: str) -> Tuple[str, Dict[str, str]]:
    """ひな形の土台（extensions/_plugin_/ の下のファイル）。(フォルダ, {その中のパス: 本当のパス})。"""
    root = os.path.join(template, *EXT_PARENT, EXT_PLACEHOLDER)
    files: Dict[str, str] = {}
    if not os.path.isdir(root):
        return root, files
    ignore = make_ignore(template)
    for directory, dirs, names in os.walk(root):
        skipped = ignore(directory, dirs + names)
        dirs[:] = sorted(d for d in dirs if d not in skipped)
        for n in sorted(names):
            if n not in skipped:
                path = os.path.join(directory, n)
                files[posix_rel(path, root)] = path
    return root, files


def is_tests_base(rel: str) -> bool:
    """rel（プラグインの根からの / 区切りの場所）が、試験の土台か（BLUEPRINT D20）。"""
    return rel in TESTS_BASE_FILES or rel.startswith(TESTS_BASE_DIRS) or bool(TESTS_BASE_PATTERN.match(rel))


def template_tests_base(template: str) -> Dict[str, str]:
    """ひな形の試験の土台。{プラグインの根からの場所: 本当のパス}。"""
    files: Dict[str, str] = {}
    tests = os.path.join(template, "tests")
    if not os.path.isdir(tests):
        return files
    ignore = make_ignore(template)
    for directory, dirs, names in os.walk(tests):
        skipped = ignore(directory, dirs + names)
        dirs[:] = sorted(d for d in dirs if d not in skipped)
        for n in sorted(names):
            if n in skipped:
                continue
            path = os.path.join(directory, n)
            rel = posix_rel(path, template)
            if is_tests_base(rel):
                files[rel] = path
    return files


def base_name(out: str) -> str:
    """生成プラグインの plugin.json の name（土台のフォルダの名前）。読めなければ断る。"""
    problems: List[str] = []
    manifest = read_json(os.path.join(out, "plugin.json"), "plugin.json", problems)
    name = manifest.get("name") if isinstance(manifest, dict) else None
    if problems or not isinstance(name, str) or not name or "/" in name or "\\" in name or name in (".", ".."):
        raise Refusal(problems or ["plugin.json の name が読めないので、土台のフォルダ（com.github.copilot/extensions/<名前>/）を探せません。"])
    return name


def compare_base(out: str, template: str) -> Tuple[str, str, List[Dict[str, str]]]:
    """生成プラグイン out の土台を、ひな形と比べる。(プラグインの名前, エクステンションのフォルダ, 違いの一覧)。
    違い：{"file", "kind", "message"}。kind は changed（中身が違う）・missing（ない）・extra（ひな形にない）。
    試験の土台（BLUEPRINT D20）は changed と missing だけを見る。"""
    name = base_name(out)
    ext = os.path.join(out, *EXT_PARENT, name)
    if not os.path.isdir(ext):
        raise Refusal("土台のフォルダ %s がありません。plugin.json の name（%s）とフォルダの名前を合わせてください。" % (posix_rel(ext, out), name))
    root, expected = template_base(template)
    if not expected:
        raise Refusal("ひな形の土台（%s）が見つかりません。" % root)
    differences: List[Dict[str, str]] = []

    def add(rel: str, kind: str, message: str) -> None:
        differences.append({"file": posix_rel(os.path.join(ext, *rel.split("/")), out), "kind": kind, "message": message})

    for rel, source in expected.items():
        target = os.path.join(ext, *rel.split("/"))
        if not os.path.isfile(target):
            add(rel, "missing", "ひな形にあるファイルがありません")
        elif read_bytes(source) != read_bytes(target):
            add(rel, "changed", "中身がひな形と違います")
    # 土台のフォルダ（core/、ui/ など、ひな形のフォルダ）の中は、すべて土台。ひな形にないファイルも違いにする
    for sub in sorted(d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d)) and d not in SKIP_NAMES):
        for directory, dirs, names in os.walk(os.path.join(ext, sub)):
            dirs[:] = sorted(d for d in dirs if d not in SKIP_NAMES)
            for n in sorted(names):
                if n.endswith(".pyc"):
                    continue
                rel = posix_rel(os.path.join(directory, n), ext)
                if rel not in expected:
                    add(rel, "extra", "ひな形にないファイルがあります")
    # 試験の土台：違う・ないだけを見る（作業ごとの試験のファイルが足されていても違いにしない）
    for rel, source in template_tests_base(template).items():
        target = os.path.join(out, *rel.split("/"))
        if not os.path.isfile(target):
            differences.append({"file": rel, "kind": "missing", "message": "ひな形にある試験の土台のファイルがありません"})
        elif read_bytes(source) != read_bytes(target):
            differences.append({"file": rel, "kind": "changed", "message": "試験の土台の中身がひな形と違います"})
    differences.sort(key=lambda d: d["file"])
    return name, ext, differences


def restore_base(ext: str, template: str, differences: List[Dict[str, str]], out: str) -> List[str]:
    """違うファイルをひな形から入れ直す。ひな形にないファイルは消す。入れ直したファイルの一覧を返す。"""
    _root, expected = template_base(template)
    tests_base = template_tests_base(template)
    restored: List[str] = []
    for d in differences:
        if d["file"] in tests_base:   # 試験の土台
            target = os.path.join(out, *d["file"].split("/"))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            shutil.copy2(tests_base[d["file"]], target)
            restored.append(d["file"])
            continue
        rel = posix_rel(os.path.join(out, *d["file"].split("/")), ext)
        target = os.path.join(ext, *rel.split("/"))
        if d["kind"] == "extra":
            os.remove(target)
            parent = os.path.dirname(target)
            while parent != ext and is_inside(parent, ext):   # 空になったフォルダも片付ける
                try:
                    os.rmdir(parent)
                except OSError:
                    break
                parent = os.path.dirname(parent)
        else:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            shutil.copy2(expected[rel], target)
        restored.append(d["file"])
    return restored


def check_base(out: str, restore: bool = False, template: Optional[str] = None) -> Dict[str, Any]:
    template = template or DEFAULT_TEMPLATE
    out = os.path.abspath(out)
    if not os.path.isdir(out):
        raise Refusal("生成プラグインのフォルダ %s がありません。" % out)
    name, ext, differences = compare_base(out, template)
    restored: List[str] = []
    remaining = differences
    if restore and differences:
        restored = restore_base(ext, template, differences, out)
        _name, _ext, remaining = compare_base(out, template)
    return {"ok": not remaining, "plugin": name, "differences": differences, "restored": restored, "remaining": remaining}


# ---------------------------------------------------------------- git

def git_verb(args: List[str]) -> str:
    """git の引数から、サブコマンドの名前（init、add、commit など）を取り出す。-c の設定は飛ばす。"""
    skip = False
    for arg in args:
        if skip:
            skip = False
        elif arg == "-c":
            skip = True
        elif not arg.startswith("-"):
            return arg
    return ""


def git(args: List[str], cwd: str) -> "subprocess.CompletedProcess[str]":
    env = {k: v for k, v in os.environ.items() if k not in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE")}
    env["GIT_TERMINAL_PROMPT"] = "0"
    try:
        return subprocess.run(["git"] + args, cwd=cwd, env=env, capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=120)
    except FileNotFoundError:
        raise Refusal("git が見つかりません。生成プラグインは git のリポジトリとして作るので、git を入れてください。")
    except subprocess.TimeoutExpired:
        raise Refusal("git の処理（git %s）が120秒で終わりませんでした。" % git_verb(args))


def git_ok(args: List[str], cwd: str) -> str:
    done = git(args, cwd)
    if done.returncode != 0:
        raise Refusal("git %s に失敗しました：%s" % (git_verb(args), (done.stderr or done.stdout).strip()))
    return done.stdout


def first_commit(out: str, plugin_name: str) -> str:
    """git のリポジトリにして、全部を add して最初のコミットをする。コミットの番号を返す。"""
    git_ok(["init", "-q"], out)
    git_ok(["add", "-A"], out)
    # 署名も、コミット前のフック（--no-verify）も、ユーザーの設定にかかわらず使わない（人の操作を待たないため）
    command = ["-c", "commit.gpgsign=false"]
    if not git(["config", "user.name"], out).stdout.strip() or not git(["config", "user.email"], out).stdout.strip():
        command += ["-c", "user.name=%s" % FALLBACK_GIT_NAME, "-c", "user.email=%s" % FALLBACK_GIT_EMAIL]
    git_ok(command + ["commit", "-q", "--no-verify", "-m", "生成プラグイン %s を plugin-creator で組み立てた" % plugin_name], out)
    return git_ok(["rev-parse", "HEAD"], out).strip()


# ---------------------------------------------------------------- build

def prepare_parts(work: str, template: str, knowledge: List[Dict[str, str]], criteria: List[Dict[str, str]],
                  confirmation: Optional[Dict[str, Any]], problems: List[str], warnings: List[str]) -> Dict[str, Any]:
    """parts/（manifest.json、task.json、slots/、files/）を読んで確かめ、描くのに要るものをまとめる。
    confirmation（生成前の確認・直す前の確認で示したもの）があれば、EVAL の課題をユーザーが確かめた課題と突き合わせる。
    問題は problems に足す（ここでは断らない）。build と change と extract の下見で使う。"""
    manifest = load_manifest(work, problems)
    task = load_task(work, template, manifest, criteria, problems, warnings)
    slots = load_slots(work, problems)
    parts_files = list_parts_files(work, problems)
    before = len(problems)
    filled_eval, read_evals = prepare_eval(os.path.join(work, "parts", "files"), parts_files, criteria, problems, warnings)
    if manifest is not None:
        for item in manifest["eval_inputs"]:
            if item["to"] in parts_files:
                problems.append("EVAL の課題の入力 %s が、parts/files/ と manifest.json の eval_inputs の両方にあります。どちらか一方にしてください。" % item["to"])
        if len(problems) == before and confirmation is not None:   # 読み取りの誤りがなければ、確かめた課題と突き合わせる
            check_confirmed_evals(confirmation, read_evals, manifest["eval_inputs"], parts_files, problems)
    return {"work": work, "manifest": manifest, "task": task, "slots": slots, "files": parts_files, "filled_eval": filled_eval,
            "knowledge": knowledge, "knowledge_removed": None}


def fixed_values(manifest: Dict[str, Any], marketplace_name: str, generated_date: str) -> Dict[str, str]:
    """ひな形に入れる決まった値。"""
    return {
        "plugin_name": manifest["plugin_name"],
        "plugin_description": manifest["plugin_description"],
        "marketplace_name": marketplace_name,
        "generated_date": generated_date,
        "entry_skill_name": manifest["entry_name"],
        "entry_skill_description": manifest["entry_description"],
    }


def render_parts(parts: Dict[str, Any], out: str, template: str, values: Dict[str, str], warnings: List[str]) -> None:
    """ひな形を out（あるフォルダ）に写し、parts で埋める。土台がひな形と同じかも確かめる。git はしない。
    断るときは Refusal を投げる（out の片付けは呼ぶ側がする）。"""
    manifest, slots = parts["manifest"], parts["slots"]
    plugin_name = manifest["plugin_name"]
    problems: List[str] = []
    shutil.copytree(template, out, ignore=make_ignore(template), dirs_exist_ok=True)

    # _plugin_ と _entry_ の名前を変える
    ext_parent = os.path.join(out, *EXT_PARENT)
    for parent, old, new, label in ((ext_parent, EXT_PLACEHOLDER, plugin_name, "com.github.copilot/extensions/_plugin_/"),
                                    (os.path.join(out, "skills"), ENTRY_PLACEHOLDER, manifest["entry_name"], "skills/_entry_/")):
        if not os.path.isdir(os.path.join(parent, old)):
            raise Refusal("ひな形に %s がありません（ひな形が足りません）。" % label)
        os.rename(os.path.join(parent, old), os.path.join(parent, new))

    # 作業エージェントごとに、worker.agent.md を元にしたファイルを作る
    agents_dir = os.path.join(out, *AGENTS_REL.split("/"))
    source = os.path.join(agents_dir, WORKER_FILE)
    if not os.path.isfile(source):
        raise Refusal("ひな形に %s/%s がありません（ひな形が足りません）。" % (AGENTS_REL, WORKER_FILE))
    worker_text = read_bytes(source).decode("utf-8")
    agents = [w["agent"] for w in manifest["workers"]]
    for agent in agents:
        write_text(os.path.join(agents_dir, agent + ".agent.md"), worker_copy(worker_text, agent))
    if "worker" not in agents:
        os.remove(source)

    # 差し込み口を埋める：文、tools の作業ごとの分、決まった値の順
    fill_template(out, plugin_name, slots, values, line_token_map(manifest), problems, warnings)
    if problems:
        raise Refusal(problems)

    # 作業の定義とナレッジの一覧（直すときは、外した決まりの一覧も）
    ext = os.path.join(ext_parent, plugin_name)
    write_text(os.path.join(ext, "task.json"), json_text(parts["task"]))
    write_text(os.path.join(out, "tests", "knowledge.json"),
               json_text([{"id": r["id"], "kind": r["kind"], "item": r["item"], "text": r["text"]} for r in parts["knowledge"]]))
    if parts.get("knowledge_removed"):
        write_text(os.path.join(out, *REMOVED_REL.split("/")), json_text(parts["knowledge_removed"]))

    # 作業エージェントが書いたファイルをそのまま足す。ひな形や組み立てのファイルは書き換えさせない
    base = os.path.join(parts["work"], "parts", "files")
    parts_files, filled_eval = parts["files"], parts["filled_eval"]
    inputs = manifest["eval_inputs"]
    collisions = [r for r in parts_files + [i["to"] for i in inputs] if os.path.lexists(os.path.join(out, *r.split("/")))]
    if collisions:
        raise Refusal(["作業エージェントが書いたファイル %s は、ひな形か組み立てが作るファイルと同じ場所です。"
                       "ひな形のファイル（土台と文書、task.json、tests/knowledge.json など）は書き換えられません。置き場所を変えてください。" % r
                       for r in collisions])
    for rel in parts_files:
        target = os.path.join(out, *rel.split("/"))
        if rel in filled_eval:
            write_text(target, filled_eval[rel])
        else:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            shutil.copy2(os.path.join(base, *rel.split("/")), target)
    for item in inputs:   # EVAL の課題の入力の実物
        target = os.path.join(out, *item["to"].split("/"))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copyfile(item["from"], target)

    # 土台がひな形と同じか
    _name, _ext, differences = compare_base(out, template)
    if differences:
        raise Refusal(["組み立てた土台がひな形と違います（%s）。ひな形か組み立てのスクリプトの誤りです。" % "、".join(d["file"] for d in differences)])


def build(hearing: str, work: str, out: str, template: Optional[str] = None, today: Optional[str] = None) -> Dict[str, Any]:
    """生成プラグインを組み立てる。断るときは Refusal を投げる。template と today は試験のために替えられる。"""
    hearing, work, out = os.path.abspath(hearing), os.path.abspath(work), os.path.abspath(out)
    template = template or DEFAULT_TEMPLATE
    today = today or datetime.date.today().isoformat()

    state = load_state(hearing)   # 関門。通らなければ、ここで断る（hearing.md 6.3）
    problems: List[str] = []
    warnings: List[str] = []
    knowledge = decided_knowledge(state, problems)
    criteria = make_criteria(knowledge, problems)
    parts = prepare_parts(work, template, knowledge, criteria, state["confirmation"], problems, warnings)
    manifest = parts["manifest"]
    check_output_path(work, out, problems)
    if problems or manifest is None or parts["task"] is None:
        raise Refusal(problems or ["組み立ての設定を読めませんでした。"])

    plugin_name = manifest["plugin_name"]
    # 手元のフォルダのマーケットプレイスの名前は、プラグインの名前と同じにする
    values = fixed_values(manifest, plugin_name, today)

    try:
        os.mkdir(out)   # すでにあれば失敗する（今あるフォルダを、失敗のときに消さないため）
    except FileExistsError:
        raise Refusal("出力先 %s がすでにあります。別のフォルダの名前を指定してください。" % out)
    try:
        render_parts(parts, out, template, values, warnings)
        commit = first_commit(out, plugin_name)
    except BaseException:
        shutil.rmtree(out, ignore_errors=True)   # 途中まで作ったフォルダは消す（作業用の一時フォルダは残す）
        raise
    agents = [w["agent"] for w in manifest["workers"]]
    inputs = manifest["eval_inputs"]

    removed = True
    try:
        shutil.rmtree(work)
    except OSError as e:
        removed = False
        warnings.append("作業用の一時フォルダ（%s）を消せませんでした（%s）。手で消してください。" % (work, e))

    counts = {kind: sum(1 for r in knowledge if r["kind"] == kind) for kind in ("criterion", "other")}
    return {
        "ok": True,
        "out": out,
        "plugin_name": plugin_name,
        "marketplace_name": plugin_name,
        "entry_skill": manifest["entry_name"],
        "workers": agents,
        "criteria": [{"id": c["id"], "knowledge": c["knowledge"]} for c in criteria],
        "knowledge": counts,
        "eval_inputs": [i["to"] for i in inputs],
        "commit": commit,
        "work_folder_removed": removed,
        "warnings": warnings,
    }


# ---------------------------------------------------------------- 今あるプラグインを直す：共通の部品
# 設計：wip の BLUEPRINT 5章 C2（creator-structure.md 3.4 に移す）。ファイルの場所は、すべてプラグインのフォルダからの / 区切りの場所。

def git_z(args: List[str], cwd: str) -> List[str]:
    """-z で区切った git の出力を、空でない要素の一覧にする。"""
    return [p for p in git_ok(args, cwd).split("\0") if p]


def tracked_entries(plugin: str) -> Tuple[List[str], List[str]]:
    """プラグインのフォルダの中で、git が管理するもの（作業用の一時フォルダを除く）。(ファイル, サブモジュール)。
    サブモジュールはファイルでないので、取り出しも入れ替えもせず、そのまま残す。"""
    files: Set[str] = set()
    modules: Set[str] = set()
    for entry in git_z(["ls-files", "-z", "--stage", "--", ".", ":(exclude)%s" % WORK_NAME], plugin):
        meta, _tab, path = entry.partition("\t")   # <mode> <object> <stage>\t<場所>
        (modules if meta.startswith("160000 ") else files).add(path)
    return sorted(files), sorted(modules)


def tracked_files(plugin: str) -> List[str]:
    """プラグインのフォルダの中で、git が管理するファイル（作業用の一時フォルダとサブモジュールを除く）。"""
    return tracked_entries(plugin)[0]


def add_paths(plugin: str) -> List[str]:
    """プラグインのフォルダの変更を git add -A するときの場所（作業用の一時フォルダを除く）。
    作業用の一時フォルダが .gitignore で外されているのに、それを除く指定を渡すと、git add はステージしたうえで
    失敗の終了コードを返す（git 2.43 で確かめた）。外されたものは add -A でも入らないので、そのときは除く指定を渡さない。"""
    if git(["check-ignore", "-q", "--", WORK_NAME], plugin).returncode == 0:
        return ["."]
    return [".", ":(exclude)%s" % WORK_NAME]


def read_manifest(plugin: str, problems: List[str]) -> Optional[Dict[str, Any]]:
    """マニフェストを、決まった順に探して読む。{"rel", "name", "version", "description", "carried"}。
    carried は、ひな形が書かない項目（repository など）の元の値（元の順）。"""
    for rel in MANIFEST_PLACES:
        path = os.path.join(plugin, *rel.split("/"))
        if not os.path.isfile(path):
            continue
        data = read_json(path, "マニフェスト（%s）" % rel, problems)
        if data is None:
            return None
        name = data.get("name") if isinstance(data, dict) else None
        if not isinstance(name, str) or not name.strip() or "/" in name or "\\" in name or name in (".", ".."):
            problems.append("マニフェスト（%s）の name が読めません（今は %s）。プラグインの名前を書いてください。" % (rel, show(name)))
            return None
        version = data.get("version")
        description = data.get("description")
        return {"rel": rel, "name": name, "version": version if isinstance(version, str) else None,
                "description": description if isinstance(description, str) else "",
                "carried": {k: v for k, v in data.items() if k in CARRIED_MANIFEST_KEYS}}
    problems.append("%s に、プラグインのマニフェスト（%s のどれか）がありません。プラグインのフォルダを示してください。"
                    % (plugin, "、".join(MANIFEST_PLACES)))
    return None


def plugin_kind(plugin: str, name: str, problems: List[str]) -> Optional[bool]:
    """クリエイターが作った生成プラグインか（BLUEPRINT D29）。tests/knowledge.json と
    com.github.copilot/extensions/<name>/task.json の両方があれば生成プラグイン。あるのに読めなければ problems に足す。"""
    before = len(problems)
    knowledge = os.path.join(plugin, *KNOWLEDGE_REL.split("/"))
    task = os.path.join(plugin, *EXT_PARENT, name, "task.json")
    has_knowledge, has_task = os.path.isfile(knowledge), os.path.isfile(task)
    if has_knowledge:
        data = read_json(knowledge, "決まりの一覧（%s）" % KNOWLEDGE_REL, problems)
        if data is not None and not isinstance(data, list):
            problems.append("決まりの一覧（%s）の形が違います（一覧ではありません）。" % KNOWLEDGE_REL)
    if has_task:
        data = read_json(task, "作業の定義（%s）" % posix_rel(task, plugin), problems)
        if data is not None and not isinstance(data, dict):
            problems.append("作業の定義（%s）の形が違います（項目の集まりではありません）。" % posix_rel(task, plugin))
    removed = os.path.join(plugin, *REMOVED_REL.split("/"))
    if has_knowledge and has_task and os.path.isfile(removed):
        data = read_json(removed, "外した決まりの一覧（%s）" % REMOVED_REL, problems)
        if data is not None and not isinstance(data, list):
            problems.append("外した決まりの一覧（%s）の形が違います（一覧ではありません）。" % REMOVED_REL)
    if len(problems) > before:
        problems.append("壊れたファイルを直してコミットしてから、もう一度頼んでください。")
        return None
    return has_knowledge and has_task


def tag_name(prefix: str, name: str) -> str:
    """印のタグの名前（BLUEPRINT D9）。リポジトリの直下のプラグインは plugin-creator-generated、
    サブフォルダのプラグインは plugin-creator-generated-<plugin.json の name>。"""
    return TAG_BASE if not prefix.strip("/") else "%s-%s" % (TAG_BASE, name)


def copy_places(hearing: Optional[str]) -> List[Tuple[str, str]]:
    """Copilot CLI がインストールやマーケットプレイスのために持つ写しの場所（BLUEPRINT D39）。[(場所, 種類)]。"""
    homes = [os.environ.get("COPILOT_HOME") or os.path.join(os.path.expanduser("~"), ".copilot")]
    if hearing:   # <COPILOT_HOME>/plugin-data/plugin-creator/hearings/<セッション>/state.json の5つ上
        home = os.path.abspath(hearing)
        for _ in range(5):
            home = os.path.dirname(home)
        homes.append(home)
    places = [(os.path.join(home, "installed-plugins"), "installed") for home in homes]
    cache = os.environ.get("COPILOT_CACHE_HOME")
    if not cache:
        if sys.platform == "darwin":
            cache = os.path.join(os.path.expanduser("~"), "Library", "Caches", "copilot")
        elif os.name == "nt":
            cache = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local"), "copilot")
        else:
            cache = os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache"), "copilot")
    places.append((cache, "cache"))   # COPILOT_CACHE_HOME のときは、その下の copilot も中に入る
    return places


def ignore_rules(template: str) -> List[str]:
    """ひな形の .gitignore の行（末尾の / を除く）と、作業用の一時フォルダ。"""
    rules = [WORK_NAME]
    try:
        with open(os.path.join(template, ".gitignore"), encoding="utf-8") as f:
            lines = f.read().splitlines()
    except OSError:
        lines = []
    for line in lines:
        line = line.strip()
        if line and not line.startswith(("#", "!")):
            rules.append(line.strip("/"))
    return rules


def ignored_by_template(rel: str, rules: List[str]) -> bool:
    """rel（.gitignore で外されたファイルかフォルダ）が、ひな形の .gitignore の行に当たるか。
    / を含む行はプラグインのフォルダからの前方一致、含まない行はどの深さのフォルダの名前とも一致。"""
    path = rel.strip("/")
    parts = path.split("/")
    for rule in rules:
        if "/" in rule:
            if path == rule or path.startswith(rule + "/"):
                return True
        elif rule in parts:
            return True
    return False


def status_paths(plugin: str, prefix: str) -> List[str]:
    """プラグインのフォルダの中の、コミットしていない変更（作業用の一時フォルダを除く）。プラグインのフォルダからの場所。"""
    raw = git_ok(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".", ":(exclude)%s" % WORK_NAME], plugin)
    fields = raw.split("\0")
    paths: List[str] = []
    index = 0
    while index < len(fields):
        entry = fields[index]
        index += 1
        if len(entry) < 4:
            continue
        code, path = entry[:2], entry[3:]
        paths.append(path)
        if "R" in code or "C" in code:   # 名前を変えた・写したもの：次の欄が元の場所
            if index < len(fields) and fields[index]:
                paths.append(fields[index])
            index += 1
    out: List[str] = []
    for path in paths:   # git status はリポジトリの根からの場所を出すので、プラグインのフォルダからの場所にする
        rel = path[len(prefix):] if prefix and path.startswith(prefix) else path
        if rel not in out:
            out.append(rel)
    return sorted(out)


def commit_command(plugin: str) -> str:
    """断る文で示す、プラグインのフォルダの中だけをコミットするコマンド（作業用の一時フォルダを除く）。"""
    shown = shown_path(plugin)
    paths = " ".join(p if p == "." else "'%s'" % p for p in add_paths(plugin))
    return "`git -C %s add -A -- %s && git -C %s commit -m \"直す前の状態\"`" % (shown, paths, shown)


def uncommitted(plugin: str, prefix: str) -> Optional[str]:
    """プラグインのフォルダの中に、コミットしていない変更があれば、断る文。"""
    changed = status_paths(plugin, prefix)
    if not changed:
        return None
    return ("%s に、まだコミットしていない変更があります（%s）。%s でコミットするか、要らない変更を消してから、もう一度頼んでください。"
            % (plugin, listed(changed), commit_command(plugin)))


def in_the_middle(plugin: str) -> List[str]:
    """マージ・リベース・チェリーピック・リバートの途中なら、その名前の一覧（BLUEPRINT D21）。"""
    names = [("MERGE_HEAD", "マージ"), ("rebase-merge", "リベース"), ("rebase-apply", "リベース"),
             ("CHERRY_PICK_HEAD", "チェリーピック"), ("REVERT_HEAD", "リバート")]
    args = ["rev-parse"]
    for name, _label in names:
        args += ["--git-path", name]
    places = git_ok(args, plugin).splitlines()
    found: List[str] = []
    for (name, label), place in zip(names, places):
        if os.path.exists(os.path.join(plugin, place)) and label not in found:
            found.append(label)
    return found


def git_place(plugin: str) -> Tuple[str, str]:
    """(リポジトリの根, プラグインのフォルダのリポジトリの中の場所〔末尾に /。直下なら空〕)。git のリポジトリの外なら断る。"""
    done = git(["rev-parse", "--show-toplevel", "--show-prefix"], plugin)
    if done.returncode != 0:
        raise Refusal("%s は git のリポジトリの中にありません。直す前の状態に git で戻せるよう、"
                      "`git -C %s init && git -C %s add -A && git -C %s commit -m \"直す前の状態\"` で git のリポジトリにしてコミットしてから、"
                      "もう一度頼んでください。" % ((plugin,) + (shown_path(plugin),) * 3))
    lines = done.stdout.split("\n")
    return lines[0].strip(), (lines[1].strip() if len(lines) > 1 else "")


# ---------------------------------------------------------------- change-check（始める前の確かめ。REQ-053）

def change_check(plugin: str, cwd: str, hearing: Optional[str] = None, template: Optional[str] = None) -> Dict[str, Any]:
    """直すプラグインのフォルダを確かめる。読むだけで、何も書かない。満たさなければ、直し方を書いた文で断る。"""
    template = template or DEFAULT_TEMPLATE
    plugin, cwd = os.path.abspath(plugin), os.path.abspath(cwd)
    if not os.path.isdir(plugin):
        raise Refusal("直すプラグインのフォルダ %s がありません。プラグインのフォルダの場所を確かめて、もう一度頼んでください。" % plugin)
    if not os.path.isdir(cwd):
        raise Refusal("Copilot CLI を起動したフォルダ %s がありません（--cwd）。" % cwd)
    shown = shown_path(plugin)
    problems: List[str] = []
    # ① マニフェスト ② 起動したフォルダの中 ③ 写しでない
    manifest = read_manifest(plugin, problems)
    if not is_within(plugin, cwd):
        problems.append("このプラグインのフォルダ（%s）は、Copilot CLI を起動したフォルダ（%s）の外にあります。"
                        "`cd %s` で移ってから `copilot` で起動し直し（プラグインのフォルダを含むフォルダで起動してもかまいません）、"
                        "もう一度頼んでください。" % (plugin, cwd, shown))
    for place, kind in copy_places(hearing):
        if is_within(plugin, place):
            what = "インストール" if kind == "installed" else "マーケットプレイス"
            problems.append("このフォルダ（%s）は、Copilot CLI が%sのために持っているプラグインの写しです（%s の中）。"
                            "写しを直しても、Copilot CLI がプラグインを更新すると消えます。元のリポジトリを手元に取ってきて"
                            "（例：`git clone <リポジトリの URL>`）、そのフォルダを示してください。" % (plugin, what, place))
            break
    if problems or manifest is None:
        raise Refusal(problems)
    generated = plugin_kind(plugin, manifest["name"], problems)
    if generated is None:
        raise Refusal(problems)
    # ④ git のリポジトリの中
    repo_root, prefix = git_place(plugin)
    # ⑤ git で管理されている
    commit_hint = commit_command(plugin)
    if git(["check-ignore", "-q", "--", "."], plugin).returncode == 0:
        problems.append("このフォルダ（%s）は、.gitignore で git の管理から外されています。.gitignore から外し、%s でコミットしてから、"
                        "もう一度頼んでください。" % (plugin, commit_hint))
    elif git(["ls-files", "--error-unmatch", "--", manifest["rel"]], plugin).returncode != 0:
        problems.append("このフォルダ（%s）のマニフェスト（%s）が git で管理されていません。%s でコミットしてから、もう一度頼んでください。"
                        % (plugin, manifest["rel"], commit_hint))
    else:
        rules = ignore_rules(template)
        ignored = git_z(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", "."], plugin)
        outside = [p for p in ignored if not ignored_by_template(p, rules)]
        if outside:
            problems.append("このフォルダ（%s）に、.gitignore で git の管理から外されたファイルがあります（%s）。直すときは .gitignore が"
                            "ひな形のものに替わるので、これらがコミットに入ったり消えたりします。要らないものは消し、要るものは .gitignore から外して"
                            "%s でコミットしてから、もう一度頼んでください。" % (plugin, listed(outside), commit_hint))
    # ⑥ コミットしていない変更がない（フォルダの中だけ）
    message = uncommitted(plugin, prefix)
    if message:
        problems.append(message)
    # ⑦ マージなどの途中でない
    middle = in_the_middle(plugin)
    if middle:
        problems.append("%s のリポジトリは、%sの途中です。`git -C %s status` で確かめ、終えるか取りやめて（例：`git -C %s merge --abort`）から、"
                        "もう一度頼んでください。" % (plugin, "・".join(middle), shown, shown))
    if problems:
        raise Refusal(problems)
    name = manifest["name"]
    return {"ok": True, "plugin": real(plugin), "repo_root": repo_root, "prefix": prefix, "manifest": manifest["rel"],
            "name": name, "version": manifest["version"], "generated": generated, "tag": tag_name(prefix, name)}


# ---------------------------------------------------------------- 取り出し（extract）

def frontmatter_values(text: str) -> Dict[str, Any]:
    """先頭のフロントマターを読む。PyYAML がなければ、`キー: 値` と、`キー:` の下の `- 値` だけを読む。"""
    span = frontmatter_span(text.replace("\r\n", "\n"))
    if not span:
        return {}
    head = text.replace("\r\n", "\n")[span[0]:span[1]]
    try:
        import yaml
    except ImportError:
        yaml = None
    if yaml is not None:
        try:
            data = yaml.safe_load(head)
        except Exception:   # 読めないフロントマターは、何もないものとして扱う
            return {}
        return data if isinstance(data, dict) else {}

    def scalar(value: str) -> str:
        if value.startswith('"'):
            try:
                return json.loads(value)
            except ValueError:
                return value.strip('"')
        if len(value) >= 2 and value[0] == value[-1] == "'":
            return value[1:-1].replace("''", "'")
        return value

    data: Dict[str, Any] = {}
    key = None
    for line in head.split("\n"):
        m = re.match(r"^([A-Za-z_][\w-]*):[ \t]*(.*?)[ \t]*$", line)
        if m:
            key = m.group(1)
            data[key] = scalar(m.group(2)) if m.group(2) else []
            continue
        m = re.match(r"^[ \t]+-[ \t]+(.*?)[ \t]*$", line)
        if m and key is not None and isinstance(data.get(key), list):
            data[key].append(scalar(m.group(1)))
    return data


def read_text(path: str) -> Optional[str]:
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().replace("\r\n", "\n")
    except (OSError, UnicodeDecodeError):
        return None


def skill_name(folder: str) -> str:
    """スキルの名前：SKILL.md の name、なければフォルダの名前。"""
    text = read_text(os.path.join(folder, "SKILL.md")) or ""
    name = frontmatter_values(text).get("name")
    return name.strip() if isinstance(name, str) and name.strip() else os.path.basename(os.path.normpath(folder))


def plugin_skills(root: str, rels: List[str]) -> Dict[str, str]:
    """プラグインの skills/<フォルダ>/SKILL.md から、{スキルの名前: skills/<フォルダ>}。"""
    found: Dict[str, str] = {}
    for rel in rels:
        parts = rel.split("/")
        if len(parts) == 3 and parts[0] == "skills" and parts[2] == "SKILL.md":
            folder = "skills/" + parts[1]
            found[skill_name(os.path.join(root, "skills", parts[1]))] = folder
            found.setdefault(parts[1], folder)
    return found


def imported_skills(state: Dict[str, Any], work_folder: str, plugin: str, problems: List[str]) -> List[Dict[str, str]]:
    """示されたスキル（BLUEPRINT D28）：記録の資産のうち、場所が SKILL.md のあるフォルダか SKILL.md そのもの。
    資産のファイルが SKILL.md のあるフォルダの下にあるのに、そのフォルダが資産にないとき、
    示されたスキルのフォルダが直すプラグインのフォルダの中にあるとき（D35）は、problems に足す。"""
    locations: List[str] = []
    for asset in state.get("assets") or []:
        place = asset.get("location") if isinstance(asset, dict) else None
        if not isinstance(place, str) or not place.strip():
            continue
        place = os.path.expanduser(place.strip())
        path = os.path.normpath(place if os.path.isabs(place) else os.path.join(work_folder, place))
        if os.path.exists(path):
            locations.append(path)
    folders: Dict[str, str] = {}
    for path in locations:
        if os.path.isdir(path) and os.path.isfile(os.path.join(path, "SKILL.md")):
            folders.setdefault(real(path), path)
        elif os.path.basename(path) == "SKILL.md" and os.path.isfile(path):
            folders.setdefault(real(os.path.dirname(path)), os.path.dirname(path))
    for path in locations:
        if is_within(path, plugin):   # プラグインのファイル（引き継ぐもの）は、示されたスキルの漏れを見ない
            continue
        folder = path if os.path.isdir(path) else os.path.dirname(path)
        while True:
            if os.path.isfile(os.path.join(folder, "SKILL.md")):
                if real(folder) not in folders:
                    problems.append("資産 %s は、スキルのフォルダ %s の中のファイルですが、そのスキルのフォルダが資産に記録されていません。"
                                    "示されたスキルは、SKILL.md のあるフォルダの絶対パスを資産に記録してください"
                                    "（名前の重なりを確かめるのに使います）。" % (path, folder))
                    folders.setdefault(real(folder), folder)   # 同じフォルダを2回言わない
                break
            parent = os.path.dirname(folder)
            if parent == folder:
                break
            folder = parent
    skills: List[Dict[str, str]] = []
    for key in sorted(folders):
        folder = folders[key]
        if is_within(folder, plugin):
            problems.append("示されたスキルのフォルダ %s は、直すプラグインのフォルダ（%s）の中にあります。直すとプラグインのファイルを入れ替えるので、"
                            "示されたスキルの中身を変えないことを守れません。プラグインのフォルダの外にあるスキルを示してもらうか、"
                            "プラグインのスキルなら資産から外してください（プラグインの一部として引き継ぎます）。" % (folder, plugin))
            continue
        skills.append({"folder": folder, "name": skill_name(folder)})
    return skills


def name_conflicts(skills: List[Dict[str, str]], plugin_names: Dict[str, str]) -> List[Dict[str, str]]:
    """示されたスキルの名前と、プラグインのスキルの名前の重なり（REQ-055、BLUEPRINT D35）。"""
    return [{"name": s["name"], "user_skill": s["folder"], "plugin_skill": plugin_names[s["name"]]}
            for s in skills if s["name"] in plugin_names]


def template_places(template: str, name: str, entry: Optional[str], agents: List[str]) -> Set[str]:
    """ひな形と組み立てが作るファイルの場所（描き直すと書き換わる場所）。
    entry が None なら入口のスキルの場所を、agents が空なら作業エージェントの場所を入れない（名前がまだ決まっていないとき）。"""
    places: Set[str] = set()
    ignore = make_ignore(template)
    ext_from = "%s/%s/" % ("/".join(EXT_PARENT), EXT_PLACEHOLDER)
    ext_to = "%s/%s/" % ("/".join(EXT_PARENT), name)
    for directory, dirs, names in os.walk(template):
        skipped = ignore(directory, dirs + names)
        dirs[:] = [d for d in dirs if d not in skipped]
        for n in names:
            if n in skipped:
                continue
            rel = posix_rel(os.path.join(directory, n), template)
            if rel.startswith(ext_from):
                rel = ext_to + rel[len(ext_from):]
            elif rel.startswith("skills/%s/" % ENTRY_PLACEHOLDER):
                if entry is None:
                    continue
                rel = "skills/%s/" % entry + rel[len("skills/%s/" % ENTRY_PLACEHOLDER):]
            places.add(rel)
    if "worker" not in agents:
        places.discard("%s/%s" % (AGENTS_REL, WORKER_FILE))
    places.update("%s/%s.agent.md" % (AGENTS_REL, agent) for agent in agents)
    places.update({ext_to + "task.json", KNOWLEDGE_REL, REMOVED_REL})
    return places


def base_folders(template: str, name: str) -> Tuple[str, ...]:
    """土台のフォルダ（エクステンションの core/、ui/ など）の、プラグインの中の場所。中のファイルは、ひな形にないものも土台。"""
    root = os.path.join(template, *EXT_PARENT, EXT_PLACEHOLDER)
    if not os.path.isdir(root):
        return ()
    return tuple("%s/%s/%s/" % ("/".join(EXT_PARENT), name, d) for d in sorted(os.listdir(root))
                 if os.path.isdir(os.path.join(root, d)) and d not in SKIP_NAMES)


def template_tools(template_text: str, rel: str, values: Dict[str, str]) -> List[str]:
    """ひな形のエージェントの定義の tools（作業ごとの分を除く）。"""
    text = apply_values(template_text, rel, values)
    text = re.sub(r"(?m)^[ \t]*\{\{(?:%s)\}\}[ \t]*\n" % "|".join(TOOL_TOKENS.values()), "", text)
    tools = frontmatter_values(text).get("tools")
    return [t for t in tools if isinstance(t, str)] if isinstance(tools, list) else []


def extra_tools_of(plugin: str, rel: str, template_text: str, values: Dict[str, str]) -> List[str]:
    """元のエージェントの定義の tools から、ひな形の tools を引いたもの。"""
    tools = frontmatter_values(read_text(os.path.join(plugin, *rel.split("/"))) or "").get("tools")
    have = [t for t in tools if isinstance(t, str)] if isinstance(tools, list) else []
    base = template_tools(template_text, rel, values)
    return [t for t in have if t not in base]


def find_line(lines: List[str], text: Optional[str], start: int, nth: int = 1) -> Optional[int]:
    """start から数えて nth 番目に text と同じ行（行末の空白は見ない）の場所。"""
    if text is None:
        return None
    want = text.rstrip()
    for index in range(max(start, 0), len(lines)):
        if lines[index].rstrip() == want:
            nth -= 1
            if nth <= 0:
                return index
    return None


def trimmed(lines: List[str]) -> str:
    """前後の空の行を除いて、つなぐ。"""
    while lines and not lines[0].strip():
        lines = lines[1:]
    while lines and not lines[-1].strip():
        lines = lines[:-1]
    return "\n".join(lines)


def extract_slots(plugin: str, template: str, values: Dict[str, str], layout: Dict[str, Any],
                  warnings: List[str]) -> Tuple[Dict[str, str], Dict[str, str]]:
    """元の生成プラグインから、差し込み口の文を取り出す（目印による取り出し。BLUEPRINT 5章 C2）。
    目印は、ひな形に決まった値を入れた文で、差し込み口の行のすぐ前とすぐ後の空でない行。
    すぐ後の目印が元のプラグインにないときは、その目印が ## の見出しなら次の ## の見出しまでを取り、
    見出しでなければ取り出さない（古いひな形の文を差し込み口の文と見分けられないため）。
    task-trace は、追跡の表の行のうち要件の番号が REQ-101 以上の行。(文, {差し込み口: "found" か "missing"})。"""
    texts: Dict[str, str] = {}
    status: Dict[str, str] = {}
    tokens = line_token_map(layout)
    ignore = make_ignore(template)
    pairs: List[Tuple[str, str]] = []   # (元のプラグインの場所, ひな形の文)
    for directory, dirs, names in os.walk(template):
        skipped = ignore(directory, dirs + names)
        dirs[:] = sorted(d for d in dirs if d not in skipped)
        for n in sorted(names):
            if n in skipped:
                continue
            rel = posix_rel(os.path.join(directory, n), template)
            text = read_text(os.path.join(directory, n))
            if text is None or "{{slot:" not in text:
                continue
            if rel == "%s/%s" % (AGENTS_REL, WORKER_FILE):
                pairs += [("%s/%s.agent.md" % (AGENTS_REL, w["agent"]), worker_copy(text, w["agent"])) for w in layout["workers"]]
            else:
                pairs.append((rel.replace("skills/%s/" % ENTRY_PLACEHOLDER, "skills/%s/" % layout["entry_name"])
                              .replace("/%s/" % EXT_PLACEHOLDER, "/%s/" % layout["plugin_name"]), text))
    for rel, text in pairs:
        text = apply_values(apply_line_tokens(text, tokens.get(rel, {}), set()), rel, values)
        lines = text.split("\n")
        have = read_text(os.path.join(plugin, *rel.split("/")))
        mine = have.split("\n") if have is not None else None
        pos = 0      # 元のプラグインで、前の差し込み口の後の目印の場所
        t_from = 0   # ひな形で、同じ目印の場所
        for index, line in enumerate(lines):
            m = SLOT_LINE.match(line)
            if not m:
                continue
            slot = m.group(1)
            status[slot] = "missing"
            if mine is None:
                continue
            if slot == "task-trace":   # 表の続き：作業ごとの要件（REQ-101 以上）の行
                heading = next((lines[j] for j in range(index - 1, -1, -1) if lines[j].startswith("## ")), None)
                start = find_line(mine, heading, 0) or 0
                rows = [r for r in mine[start:] if TRACE_ROW.match(r) and int(TRACE_ROW.match(r).group(1)) >= TASK_REQ_START]
                body = "\n".join(rows)
            else:
                before_at = next((j for j in range(index - 1, -1, -1) if lines[j].strip() and not SLOT_LINE.match(lines[j])), None)
                after_at = next((j for j in range(index + 1, len(lines)) if lines[j].strip() and not SLOT_LINE.match(lines[j])), None)
                before = lines[before_at] if before_at is not None else None
                after = lines[after_at] if after_at is not None else None
                if before is None:
                    first: Optional[int] = -1
                else:   # 同じ行が前にもある（例：フロントマターの ---）ときは、同じ何番目のものを目印にする
                    nth = sum(1 for j in range(t_from, index) if lines[j].rstrip() == before.rstrip())
                    first = find_line(mine, before, pos, nth)
                if first is None:
                    warnings.append("差し込み口 %s の前の目印（%s の「%s」）が元のプラグインに見つからないので、取り出せませんでした。"
                                    "parts/slots/%s.md を書いてください。" % (slot, rel, clip(before or ""), slot))
                    continue
                last = len(mine) if after is None else find_line(mine, after, first + 1)
                if last is None and after is not None and after.startswith("## "):   # 後の見出しの名前が変わった：次の ## の見出しまで
                    last = next((k for k in range(first + 1, len(mine)) if mine[k].startswith("## ")), len(mine))
                if last is None:
                    warnings.append("差し込み口 %s の後の目印（%s の「%s」）が元のプラグインに見つからないので、取り出せませんでした。"
                                    "parts/slots/%s.md を書いてください。" % (slot, rel, clip(after or ""), slot))
                    continue
                body = trimmed(mine[first + 1:last])
                pos = last
                t_from = after_at if after_at is not None else len(lines)
            if body.strip():
                texts[slot] = body
                status[slot] = "found"
    return texts, status


def constitution_date(plugin: str) -> Optional[str]:
    """憲章の変更履歴の 1.0.0 の行の日付。"""
    text = read_text(os.path.join(plugin, "docs", "constitution.md")) or ""
    m = re.search(r"(?m)^\|\s*1\.0\.0\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|", text)
    return m.group(1) if m else None


def marketplace_of(plugin: str, name: str) -> str:
    data = None
    try:
        with open(os.path.join(plugin, ".github", "plugin", "marketplace.json"), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError, UnicodeDecodeError):
        pass
    value = data.get("name") if isinstance(data, dict) else None
    return value if isinstance(value, str) and value.strip() else name


def finish_manifest(root: str, version: Optional[str], carried: Dict[str, Any]) -> None:
    """描いた plugin.json の version を置き換え（ひな形は 0.1.0 の決め打ち）、元のマニフェストの、
    ひな形が書かない項目（repository など。CARRIED_MANIFEST_KEYS）を引き継ぐ。"""
    if not version and not carried:
        return
    path = os.path.join(root, "plugin.json")
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if version:
        data["version"] = version
    data.update(carried)
    write_text(path, json_text(data))


def walk_files(root: str) -> List[str]:
    found: List[str] = []
    for directory, dirs, names in os.walk(root):
        dirs[:] = sorted(dirs)
        found += [posix_rel(os.path.join(directory, n), root) for n in sorted(names)]
    return sorted(found)


def line_changes(old: bytes, new: bytes) -> Tuple[int, int]:
    """足した行と消した行の数。文字でないファイルは (0, 0)。"""
    import difflib
    try:
        if b"\0" in old or b"\0" in new:
            return 0, 0
        a, b = old.decode("utf-8").splitlines(), new.decode("utf-8").splitlines()
    except UnicodeDecodeError:
        return 0, 0
    plus = minus = 0
    for line in difflib.unified_diff(a, b, lineterm="", n=0):
        if line.startswith("+") and not line.startswith("+++"):
            plus += 1
        elif line.startswith("-") and not line.startswith("---"):
            minus += 1
    return plus, minus


def compare_trees(plugin: str, tracked: List[str], preview: str) -> Dict[str, Any]:
    """元のプラグイン（git が管理するファイル）と下見の違い。"""
    drawn = set(walk_files(preview))
    have = set(tracked)
    changed = []
    for rel in sorted(drawn & have):
        old_path = os.path.join(plugin, *rel.split("/"))
        if not os.path.isfile(old_path):
            changed.append({"file": rel, "plus": 0, "minus": 0})
            continue
        old, new = read_bytes(old_path), read_bytes(os.path.join(preview, *rel.split("/")))
        if old != new:
            plus, minus = line_changes(old, new)
            changed.append({"file": rel, "plus": plus, "minus": minus})
    return {"added": sorted(drawn - have), "removed": sorted(have - drawn), "changed": changed}


def preview_stage1(preview: str, template: str, warnings: List[str]) -> List[str]:
    """下見に1段目の検査（ひな形の check_structure.py）を当て、落ちるところの文を返す。"""
    checks = load_checks(os.path.join(template, "tests", "stage1", "check_structure.py"))
    if checks is None:
        warnings.append("PyYAML か jsonschema が入っていない（または、ひな形に1段目の検査がない）ので、下見に1段目の検査を当てませんでした。")
        return []
    try:
        report = checks.run_checks(preview, "generated")
    except Exception as e:   # 検査が止まっても、取り出しは続ける
        warnings.append("下見の1段目の検査が途中で止まりました（%s: %s）。" % (type(e).__name__, e))
        return []
    return ["%s：%s" % (c.title, m) for c in report.checks for m in c.errors]


def copy_into_parts(plugin: str, work: str, rels: List[str]) -> None:
    base = os.path.join(work, "parts", "files")
    for rel in rels:
        target = os.path.join(base, *rel.split("/"))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy2(os.path.join(plugin, *rel.split("/")), target)


def split_files(plugin: str, tracked: List[str], places: Set[str], bases: Tuple[str, ...],
                warnings: List[str]) -> Tuple[List[str], List[str], List[str]]:
    """git が管理するファイルを (parts/files に入れるもの, ひな形と重なるもの, 消すもの) に分ける。
    消すもの：以前の形式のマニフェストと、ふつうのファイルでないもの（シンボリックリンクなど）。"""
    keep: List[str] = []
    overlap: List[str] = []
    gone: List[str] = []
    for rel in tracked:
        path = os.path.join(plugin, *rel.split("/"))
        if rel in LEGACY_MANIFESTS:
            gone.append(rel)
        elif os.path.islink(path) or not os.path.isfile(path):
            gone.append(rel)
            warnings.append("%s はふつうのファイルではない（シンボリックリンクなど）ので、直したプラグインには入りません。" % rel)
        elif rel in places or rel.startswith(bases):
            overlap.append(rel)
        else:
            keep.append(rel)
    return keep, overlap, gone


def original_records(plugin: str, name: str) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], Dict[str, Any]]:
    """元の生成プラグインの (決まりの一覧, 外した決まりの一覧, 作業の定義)。plugin_kind で読めることは確かめてある。"""
    def load(rel: str, empty: Any) -> Any:
        path = os.path.join(plugin, *rel.split("/"))
        if not os.path.isfile(path):
            return empty
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    knowledge = [r for r in load(KNOWLEDGE_REL, []) if isinstance(r, dict)]
    removed = [r for r in load(REMOVED_REL, []) if isinstance(r, dict)]
    task = load("%s/%s/task.json" % ("/".join(EXT_PARENT), name), {})
    return knowledge, removed, task


def original_criteria(task: Dict[str, Any]) -> List[Dict[str, str]]:
    return [{"id": c["id"], "text": c.get("text", ""), "knowledge": c["knowledge"]} for c in task.get("criteria") or []
            if isinstance(c, dict) and isinstance(c.get("id"), str) and isinstance(c.get("knowledge"), str)]


def entry_skill_of(plugin: str, name: str, tracked: List[str]) -> Optional[str]:
    """入口のスキル：本文に <name>_open を書いているスキル（ひな形の入口のスキルの最後の節）。フォルダの名前を返す。"""
    found = [rel.split("/")[1] for rel in tracked
             if re.match(r"^skills/[^/]+/SKILL\.md$", rel) and "%s_open" % name in (read_text(os.path.join(plugin, *rel.split("/"))) or "")]
    if not found:
        return None
    return name if name in found else found[0]


def extract(plugin: str, work: str, hearing: Optional[str] = None, template: Optional[str] = None,
            today: Optional[str] = None) -> Dict[str, Any]:
    """直すプラグインから parts/・draft/task.json・preview/・extract.json を作る。--work の中だけに書く。"""
    template = template or DEFAULT_TEMPLATE
    today = today or datetime.date.today().isoformat()
    plugin, work = os.path.abspath(plugin), os.path.abspath(work)
    if os.path.basename(os.path.normpath(work)) != WORK_NAME:
        raise Refusal("--work は、作業フォルダの中の %s にしてください（今は %s）。" % (WORK_NAME, work))
    if not os.path.isdir(plugin):
        raise Refusal("直すプラグインのフォルダ %s がありません。" % plugin)
    problems: List[str] = []
    warnings: List[str] = []
    manifest = read_manifest(plugin, problems)
    if manifest is None:
        raise Refusal(problems)
    name = manifest["name"]
    generated = plugin_kind(plugin, name, problems)
    if generated is None:
        raise Refusal(problems)
    _root, prefix = git_place(plugin)
    # コミットした中身だけを取り出す（コミットしていない変更を取り出すと、後で消した変更を change が書き戻すため）
    message = uncommitted(plugin, prefix)
    if message:
        raise Refusal(message)
    head = git_ok(["rev-parse", "HEAD"], plugin).strip()   # change が、取り出した後の変更を見つけるのに使う
    tracked, modules = tracked_entries(plugin)
    for rel in modules:
        warnings.append("%s は git のサブモジュールなので、取り出さず、直すときもそのまま残します。" % rel)

    conflicts: List[Dict[str, str]] = []
    if hearing:
        state = read_json(os.path.abspath(hearing), "ヒアリングの記録（%s）" % hearing, problems)
        if isinstance(state, dict):
            skills = imported_skills(state, os.path.dirname(work), plugin, problems)
            conflicts = name_conflicts(skills, plugin_skills(plugin, tracked))
        elif state is not None:
            problems.append("ヒアリングの記録（%s）の形が違います（項目の集まりではありません）。" % hearing)
        if problems:
            raise Refusal(problems)

    # 前の取り出しの残りを片付けてから書く
    os.makedirs(work, exist_ok=True)
    for sub in ("parts", "draft", "preview", "stage"):
        shutil.rmtree(os.path.join(work, sub), ignore_errors=True)
    for leftover in (EXTRACT_JSON, CHANGED_JSON):
        if os.path.isfile(os.path.join(work, leftover)):
            os.remove(os.path.join(work, leftover))
    os.makedirs(os.path.join(work, "parts", "files"))

    if generated:
        result = extract_generated(plugin, work, template, manifest, tracked, today, warnings)
    else:
        # 入口のスキルと作業エージェントの名前は、まだ決まっていない（メインが parts/manifest.json に書く）。
        # その場所のファイルは消す一覧に入れずに parts/files に残し、選んだ名前と重なれば change が断る（render_parts の重なりの確かめ）
        places = template_places(template, name, None, [])
        keep, overlap, gone = split_files(plugin, tracked, places, base_folders(template, name), warnings)
        copy_into_parts(plugin, work, keep)
        result = {"ok": True, "generated": False, "slots": {}, "files": len(keep), "delete": sorted(overlap + gone),
                  "base": {"added": [], "removed": [], "changed": []}, "stage1": []}
    result.update({"plugin": real(plugin), "head": head, "name_conflicts": conflicts, "warnings": warnings})
    write_text(os.path.join(work, EXTRACT_JSON), json_text(result))
    return result


def extract_generated(plugin: str, work: str, template: str, manifest: Dict[str, Any], tracked: List[str], today: str,
                      warnings: List[str]) -> Dict[str, Any]:
    """生成プラグインから、差し込み口の文・作業ごとのファイル・組み立ての設定・作業の定義を取り出し、下見を描いて比べる。"""
    name = manifest["name"]
    knowledge, removed, task = original_records(plugin, name)
    workers = [{"agent": w["agent"], "label": w.get("label")} for w in task.get("workers") or []
               if isinstance(w, dict) and isinstance(w.get("agent"), str)]
    entry = entry_skill_of(plugin, name, tracked)
    entry_meta: Dict[str, Any] = {}
    if entry is None:
        warnings.append("入口のスキル（本文に %s_open を書いているスキル）が見つかりません。parts/manifest.json の entry_skill を書いてください。" % name)
    else:
        entry_meta = frontmatter_values(read_text(os.path.join(plugin, "skills", entry, "SKILL.md")) or "")
    date = constitution_date(plugin)
    if date is None:
        date = today
        warnings.append("憲章（docs/constitution.md）の変更履歴に 1.0.0 の行が見つからないので、作った日を今日（%s）にしました。" % today)
    values = {
        "plugin_name": name,
        "plugin_description": manifest["description"],
        "marketplace_name": marketplace_of(plugin, name),
        "generated_date": date,
        "entry_skill_name": entry_meta.get("name") if isinstance(entry_meta.get("name"), str) else (entry or name),
        "entry_skill_description": entry_meta.get("description") if isinstance(entry_meta.get("description"), str) else "",
    }

    # 組み立ての設定：作業エージェントの一覧は task.json、ツールの作業ごとの分は、元の tools からひな形の tools を引いたもの
    agents_dir = os.path.join(template, *AGENTS_REL.split("/"))
    worker_text = read_text(os.path.join(agents_dir, WORKER_FILE)) or ""
    for w in workers:
        rel = "%s/%s.agent.md" % (AGENTS_REL, w["agent"])
        w["extra_tools"] = extra_tools_of(plugin, rel, worker_copy(worker_text, w["agent"]), values)
    verifier_rel = "%s/verifier.agent.md" % AGENTS_REL
    verifier_tools = extra_tools_of(plugin, verifier_rel, read_text(os.path.join(agents_dir, "verifier.agent.md")) or "", values)
    parts_manifest: Dict[str, Any] = {"plugin_name": name, "plugin_description": manifest["description"]}
    if entry is not None:
        parts_manifest["entry_skill"] = {"name": values["entry_skill_name"], "description": values["entry_skill_description"]}
    parts_manifest.update({"workers": workers, "verifier": {"extra_tools": verifier_tools}, "orchestrator": {"extra_tools": []}})
    write_text(os.path.join(work, "parts", "manifest.json"), json_text(parts_manifest))

    # 作業の定義（基準は、確かめた決まりから組み立てが書くので除く）
    draft = {k: v for k, v in task.items() if k != "criteria"}
    write_text(os.path.join(work, "parts", "task.json"), json_text(draft))
    write_text(os.path.join(work, "draft", "task.json"), json_text(draft))

    # 差し込み口の文
    layout = {"plugin_name": name, "entry_name": entry or name, "workers": workers, "verifier_tools": verifier_tools}
    slots, status = extract_slots(plugin, template, values, layout, warnings)
    for slot, text in slots.items():
        write_text(os.path.join(work, "parts", "slots", slot + ".md"), text + "\n")

    # 作業ごとのファイル：git が管理するファイルのうち、ひな形と組み立てが作る場所でないもの
    places = template_places(template, name, entry or name, [w["agent"] for w in workers])
    keep, _overlap, gone = split_files(plugin, tracked, places, base_folders(template, name), warnings)
    copy_into_parts(plugin, work, keep)
    for rel in keep:   # 試験の土台のフォルダにある、ひな形にないファイルは、作業ごとの試験として残す（確認で示す）
        if is_tests_base(rel):
            warnings.append("%s は、ひな形にない試験の土台のフォルダのファイルなので、作業ごとの試験として残します。" % rel)

    # 下見：今のひな形で、変えずに描き直す（版は元のまま）
    preview_problems: List[str] = []
    preview_warnings: List[str] = []
    rows = [{"id": r.get("id"), "kind": r.get("kind"), "item": r.get("item"), "text": r.get("text")} for r in knowledge]
    parts = prepare_parts(work, template, rows, original_criteria(task), None, preview_problems, preview_warnings)
    parts["knowledge_removed"] = removed
    preview = os.path.join(work, "preview", name)
    base = {"added": [], "removed": [], "changed": []}
    stage1 = ["組み立て：%s" % p for p in preview_problems]
    if parts["manifest"] is not None and parts["task"] is not None:
        os.makedirs(preview)
        try:
            render_parts(parts, preview, template, fixed_values(parts["manifest"], values["marketplace_name"], date), preview_warnings)
            finish_manifest(preview, manifest["version"], manifest["carried"])
        except Refusal as e:
            stage1 += ["組み立て：%s" % p for p in e.problems]
            warnings.append("下見を描けませんでした。1段目の結果（stage1）の「組み立て」の問題を直してください。")
            shutil.rmtree(preview, ignore_errors=True)
        else:
            base = compare_trees(plugin, tracked, preview)
            stage1 += preview_stage1(preview, template, warnings)
    else:
        warnings.append("下見を描けませんでした。1段目の結果（stage1）の「組み立て」の問題を直してください。")
    return {"ok": True, "generated": True, "slots": status, "files": len(keep), "delete": sorted(gone),
            "base": base, "stage1": stage1}


# ---------------------------------------------------------------- 直す（change）

def knowledge_number(ident: str) -> int:
    return int(ident.split("-", 1)[1])


def reconcile_knowledge(original: List[Dict[str, Any]], removed: List[Dict[str, Any]], decided: List[Dict[str, Any]],
                        problems: List[str]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], Dict[str, Any]]:
    """決まりの番号を合わせる（REQ-058、BLUEPRINT 4.2）。O＝元の一覧、R＝元の外した一覧、S＝記録の決まった行。
    (書く決まりの一覧, 書く外した決まりの一覧, 要約 {kept, added, replaced, removed})。"""
    o_rows = {r["id"]: r for r in original if isinstance(r.get("id"), str) and KNOWLEDGE_ID.match(r["id"])}
    r_ids = {r["id"] for r in removed if isinstance(r.get("id"), str) and KNOWLEDGE_ID.match(r["id"])}
    used = max([knowledge_number(i) for i in list(o_rows) + list(r_ids)], default=0)
    s_rows = {r["id"]: r for r in decided}
    kept: List[str] = []
    for oid, o in o_rows.items():   # ① 元の番号は、同じ中身で残るか、外れるか
        s = s_rows.get(oid)
        if s is None:
            continue
        if (s["kind"], s["item"], s["text"]) != (o.get("kind"), o.get("item"), o.get("text")):
            problems.append("決まり %s の中身（種類・項目・文）が、元の決まりの一覧（%s）と違うのに、同じ番号のままです。"
                            "中身を直した決まりは、元の番号を外して新しい番号にしてください（REQ-058）。" % (oid, KNOWLEDGE_REL))
        else:
            kept.append(oid)
    for sid in s_rows:   # ② 新しい番号は、これまでに使ったどの番号よりも後
        if sid in o_rows:
            continue
        if sid in r_ids:
            problems.append("決まり %s の番号は、前に外した番号です。外した番号は、ほかの決まりに使えません（REQ-058）。" % sid)
        elif knowledge_number(sid) <= used:
            problems.append("新しい決まり %s の番号が、これまでに使った番号（外した番号を含めて K-%02d まで）より後になっていません（REQ-058）。" % (sid, used))
    replaced_by: Dict[str, str] = {}
    for sid, s in s_rows.items():   # ③ 付け直した元の番号は、元の一覧にあって、今回外すもの
        source = s.get("replaces")
        if source is None:
            continue
        if not isinstance(source, str) or source not in o_rows or source in s_rows or sid in o_rows:
            problems.append("決まり %s が付け直した元の番号 %s が、元の決まりの一覧にないか、今回も残っています。" % (sid, show(source)))
        elif source in replaced_by:
            problems.append("元の決まり %s を、2つの決まり（%s と %s）が付け直しています。" % (source, replaced_by[source], sid))
        else:
            replaced_by[source] = sid
    rows = sorted(s_rows.values(), key=lambda r: knowledge_number(r["id"]))
    gone = [oid for oid in o_rows if oid not in s_rows]
    removed_rows = [dict(r) for r in removed]
    for oid in gone:   # ④ 外した一覧は、前のものに今回外したものを足す
        row = {"id": oid, "kind": o_rows[oid].get("kind"), "item": o_rows[oid].get("item"), "text": o_rows[oid].get("text")}
        if oid in replaced_by:
            row["replacedBy"] = replaced_by[oid]
        removed_rows.append(row)
    summary = {
        "kept": kept,
        "added": [r["id"] for r in rows if r["id"] not in o_rows and r["id"] not in replaced_by.values()],
        "replaced": [{"from": source, "to": sid} for source, sid in sorted(replaced_by.items(), key=lambda p: knowledge_number(p[0]))],
        "removed": [oid for oid in gone if oid not in replaced_by],
    }
    return rows, removed_rows, summary


def confirmed_criteria(confirmation: Dict[str, Any], decided: List[Dict[str, Any]], original: List[Dict[str, str]],
                       problems: List[str]) -> List[Dict[str, str]]:
    """直す前の確認の合否の基準の番号（confirmation.criteria。BLUEPRINT 4.4）を確かめて、作業の定義の基準にする。"""
    entries = confirmation.get("criteria")
    by_knowledge = {r["id"]: r for r in decided if r["kind"] == "criterion"}
    if not by_knowledge:
        problems.append("ヒアリングの記録に、状態が「決まった」の合否の決め方のナレッジが1件もありません。"
                        "作業の定義の合否の基準は、これをもとに作るので、1件以上が要ります。")
        return []
    if not isinstance(entries, list) or not entries:
        problems.append("ヒアリングの記録に、直す前の確認で示した合否の基準の番号（confirmation.criteria）がありません。")
        return []
    old_ids = {c["knowledge"]: c["id"] for c in original}
    taken = {c["id"] for c in original}
    seen_ids: Set[str] = set()
    seen_knowledge: Set[str] = set()
    criteria: List[Dict[str, str]] = []
    for number, entry in enumerate(entries, 1):
        where = "直す前の確認の合否の基準（%d 番目）" % number
        cid = entry.get("id") if isinstance(entry, dict) else None
        kid = entry.get("knowledge") if isinstance(entry, dict) else None
        if not isinstance(cid, str) or not CRITERION_ID.match(cid):
            problems.append("%sの番号 %s が C-数字（2桁以上）の形ではありません。" % (where, show(cid)))
            continue
        if cid in seen_ids:
            problems.append("%sの番号 %s が重なっています。" % (where, cid))
            continue
        if not isinstance(kid, str) or kid not in by_knowledge:
            problems.append("%s（%s）の決まり %s は、決まった合否の決め方の決まりではありません。" % (where, cid, show(kid)))
            continue
        if kid in seen_knowledge:
            problems.append("%s（%s）の決まり %s が、ほかの基準と重なっています。" % (where, cid, kid))
            continue
        if kid in old_ids and cid != old_ids[kid]:
            problems.append("引き継いだ基準（決まり %s）の番号が、元の作業の定義（%s）と違います（確認：%s）。引き継いだ基準は元の番号のままにしてください。"
                            % (kid, old_ids[kid], cid))
            continue
        if kid not in old_ids and cid in taken:
            problems.append("新しい基準（決まり %s）の番号 %s が、元の作業の定義の基準の番号と重なっています。元の番号の続きにしてください。" % (kid, cid))
            continue
        seen_ids.add(cid)
        seen_knowledge.add(kid)
        criteria.append({"id": cid, "text": by_knowledge[kid]["text"], "knowledge": kid})
    lost = [k for k in by_knowledge if k not in seen_knowledge and all(
        not (isinstance(e, dict) and e.get("knowledge") == k) for e in entries)]
    if lost:
        problems.append("決まった合否の決め方の決まり %s が、直す前の確認の合否の基準（confirmation.criteria）にありません。" % "、".join(lost))
    return criteria


def version_problem(current: Optional[str], new: Any) -> Optional[str]:
    """新しい版の確かめ（BLUEPRINT D16）。"""
    if not isinstance(new, str) or not VERSION_RE.match(new):
        return "ヒアリングの記録に、直す前の確認でよいと答えた版（confirmation.version。例：0.2.0）がありません。"
    if isinstance(current, str) and VERSION_RE.match(current):
        if tuple(int(n) for n in VERSION_RE.match(new).groups()) <= tuple(int(n) for n in VERSION_RE.match(current).groups()):
            return "新しい版 %s が、今の版 %s より大きくありません。" % (new, current)
    return None


def remove_empty_parents(path: str, stop: str) -> None:
    parent = os.path.dirname(path)
    while is_inside(parent, stop):
        try:
            os.rmdir(parent)
        except OSError:
            break
        parent = os.path.dirname(parent)


def roll_back(plugin: str) -> None:
    """入れ替えの途中で失敗したとき、プラグインのフォルダを HEAD の中身に戻す（外されたファイルと作業用の一時フォルダには触れない）。"""
    git(["checkout", "HEAD", "--", "."], plugin)
    git(["clean", "-fdq", "--", ".", ":(exclude)%s" % WORK_NAME], plugin)


def exec_bits(path: str) -> int:
    return os.stat(path).st_mode & 0o111 if os.name != "nt" else 0


def name_overlaps(manifest: Dict[str, Any], parts_files: List[str]) -> List[str]:
    """入口のスキルのフォルダと作業エージェントの定義の場所に、parts/files のファイルがあれば、断る文。
    作っていないプラグインでは、extract がその場所のファイルを消さずに残す（名前は後で決まるため）。"""
    problems: List[str] = []
    entry = manifest["entry_name"]
    inside = [r for r in parts_files if r.startswith("skills/%s/" % entry)]
    if inside:
        problems.append("入口のスキル %s のフォルダ（skills/%s/）に、parts/files のファイル（%s）が重なります。元のプラグインのスキルなら、"
                        "入口のスキルに別の名前を付けてください（parts/manifest.json の entry_skill の name）。" % (entry, entry, listed(inside)))
    for worker in manifest["workers"]:
        rel = "%s/%s.agent.md" % (AGENTS_REL, worker["agent"])
        if rel in parts_files:
            problems.append("作業エージェント %s の定義の場所（%s）に、parts/files の同じ場所のファイルが重なります。元のプラグインのエージェントなら、"
                            "作業エージェントに別の名前を付けてください（parts/manifest.json と作業の定義の workers）。" % (worker["agent"], rel))
    return problems


def change(hearing: str, work: str, plugin: str, template: Optional[str] = None, today: Optional[str] = None) -> Dict[str, Any]:
    """直す内容で描き、プラグインのフォルダのファイルを入れ替える。コミットはしない。断るときは Refusal を投げる。"""
    template = template or DEFAULT_TEMPLATE
    today = today or datetime.date.today().isoformat()
    hearing, work, plugin = os.path.abspath(hearing), os.path.abspath(work), os.path.abspath(plugin)

    # ① 関門
    state = load_state(hearing)
    info = state.get("change")
    if not isinstance(info, dict):
        raise Refusal("ヒアリングの記録に、直すプラグインの記録（change）がありません。今のプラグインを直す流れで始めてから、直してください。")
    if os.path.basename(os.path.normpath(work)) != WORK_NAME:
        raise Refusal("--work は、作業フォルダの中の %s にしてください（今は %s）。" % (WORK_NAME, work))
    folder = info.get("folder")
    if not isinstance(folder, str) or real(folder) != real(plugin):
        raise Refusal("ヒアリングの記録の直すフォルダ（%s）と、--plugin（%s）が違います。" % (show(folder), plugin))
    confirmation = state["confirmation"]
    problems: List[str] = []
    warnings: List[str] = []
    extracted = read_json(os.path.join(work, EXTRACT_JSON), "取り出しの結果（%s/%s）" % (WORK_NAME, EXTRACT_JSON), problems)
    if problems:
        raise Refusal(problems + ["先に extract で取り出してください。"])
    if not isinstance(extracted, dict) or extracted.get("generated") != info.get("generated"):
        raise Refusal("ヒアリングの記録と取り出しの結果で、クリエイターが作ったプラグインかの見分けが違います（記録：%s／取り出し：%s）。"
                      "もう一度 extract で取り出してから、確かめ直してください。"
                      % (show(info.get("generated")), show(extracted.get("generated") if isinstance(extracted, dict) else None)))
    if extracted.get("plugin") != real(plugin) or not re.match(r"^[0-9a-f]{7,64}$", str(extracted.get("head"))):
        raise Refusal("取り出しの結果（%s/%s）は、このプラグインのフォルダ（%s）から取り出したものではありません。"
                      "もう一度 extract で取り出してから、確かめ直してください。" % (WORK_NAME, EXTRACT_JSON, plugin))

    # ② 直す直前の確かめ（起動したフォルダは、作業用の一時フォルダの親）
    checked = change_check(plugin, os.path.dirname(work), hearing, template)
    name, generated = checked["name"], checked["generated"]
    if generated != info.get("generated"):
        raise Refusal("プラグインのフォルダの中身が、取り出したときと変わっています（クリエイターが作ったプラグインかの見分けが違います）。"
                      "もう一度 extract で取り出してから、確かめ直してください。")
    # 取り出した後のコミットで、プラグインのフォルダが変わっていない（変わっていれば、取り出した部品が古く、その変更を消してしまう）
    same = git(["diff", "--quiet", "--no-ext-diff", extracted["head"], "HEAD", "--", ".", ":(exclude)%s" % WORK_NAME], plugin)
    if same.returncode != 0:
        raise Refusal("取り出した後に、プラグインのフォルダ（%s）の中身が変わるコミットがありました（取り出したとき：%s／今：%s）。"
                      "取り出した部品は古いので、このまま直すと、その変更を消してしまいます。もう一度 extract で取り出してから、確かめ直してください。"
                      % (plugin, extracted["head"][:12], git_ok(["rev-parse", "--short=12", "HEAD"], plugin).strip()))
    version = confirmation.get("version")
    message = version_problem(checked["version"], version)
    if message:
        problems.append(message)

    # ③ 決まりの番号と合否の基準の番号
    original, removed, task = original_records(plugin, name) if generated else ([], [], {})
    if generated:   # 決まりの一覧が、取り込んだとき（記録の change.carried）から変わっていない
        now_ids = sorted(str(r.get("id")) for r in original)
        carried = info.get("carried")
        then_ids = sorted(str(i) for i in carried) if isinstance(carried, list) else None
        if now_ids != then_ids:
            raise Refusal("決まりの一覧（%s）が、直す流れを始めて取り込んだときから変わっています（取り込んだとき：%s／今：%s）。"
                          "取り込んだときの一覧で確かめた内容で直すと、その後の変更を消してしまうので、直せません。"
                          "今のプラグインを直す流れを、始めからやり直してください。"
                          % (KNOWLEDGE_REL, "、".join(then_ids) if then_ids else "なし", "、".join(now_ids) or "なし"))
    decided = decided_knowledge(state, problems)
    rows, removed_rows, summary = reconcile_knowledge(original, removed, decided, problems)
    criteria = confirmed_criteria(confirmation, decided, original_criteria(task), problems)

    # ④ parts の確かめ
    parts = prepare_parts(work, template, rows, criteria, confirmation, problems, warnings)
    parts["knowledge_removed"] = removed_rows
    manifest = parts["manifest"]
    if manifest is not None and manifest["plugin_name"] != name:
        problems.append("parts/manifest.json の plugin_name（%s）が、直すプラグインの名前（%s）と違います。名前は変えられません。"
                        % (manifest["plugin_name"], name))
    if manifest is not None:   # 選んだ入口のスキルと作業エージェントの名前が、引き継ぐファイル（元のスキルやエージェント）と重ならない
        problems += name_overlaps(manifest, parts["files"])
    # ⑤ 示されたスキル（記録の漏れ、プラグインの中のスキル）
    skills = imported_skills(state, os.path.dirname(work), checked["plugin"], problems)
    if problems or manifest is None or parts["task"] is None:
        raise Refusal(problems or ["組み立ての設定を読めませんでした。"])

    # ⑥ 作業用の一時フォルダの中に描く
    stage_root = os.path.join(work, "stage")
    stage = os.path.join(stage_root, name)
    shutil.rmtree(stage_root, ignore_errors=True)
    os.makedirs(stage)
    date = constitution_date(plugin) if generated else None
    values = fixed_values(manifest, marketplace_of(plugin, name) if generated else name, date or today)
    try:
        render_parts(parts, stage, template, values, warnings)
        finish_manifest(stage, version, (read_manifest(plugin, []) or {}).get("carried", {}))   # 読めることは change_check で確かめてある
        drawn = walk_files(stage)
        conflicts = name_conflicts(skills, plugin_skills(stage, drawn))   # ⑤ 名前の重なり（最後の守り）
        if conflicts:
            raise Refusal(["足すスキル %s（%s）の名前が、示されたスキル（%s）の名前と同じです。同じ名前だと、示されたスキルが読み込まれている"
                           "作業フォルダで、プラグインのスキルが使われません。parts の %s のフォルダの名前と SKILL.md の name を、別の名前にしてください。"
                           % (c["name"], c["plugin_skill"], c["user_skill"], c["plugin_skill"]) for c in conflicts])
    except BaseException:
        shutil.rmtree(stage_root, ignore_errors=True)
        raise

    # ⑦ 入れ替え：管理されているファイルのうち描いたものにないものを消し、描いたものを写す
    head = git_ok(["rev-parse", "HEAD"], plugin).strip()
    tracked = tracked_files(plugin)
    have, want = set(tracked), set(drawn)
    added = sorted(want - have)
    gone = sorted(have - want)
    changed = []
    for rel in sorted(want & have):
        old, new = os.path.join(plugin, *rel.split("/")), os.path.join(stage, *rel.split("/"))
        if os.path.islink(old) or not os.path.isfile(old) or read_bytes(old) != read_bytes(new) or exec_bits(old) != exec_bits(new):
            changed.append(rel)
    try:
        for rel in gone:
            path = os.path.join(plugin, *rel.split("/"))
            os.remove(path)
            remove_empty_parents(path, plugin)
        for rel in added + changed:
            target = os.path.join(plugin, *rel.split("/"))
            if os.path.islink(target):
                os.remove(target)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            shutil.copy2(os.path.join(stage, *rel.split("/")), target)
    except BaseException as e:
        roll_back(plugin)
        shutil.rmtree(stage_root, ignore_errors=True)
        if isinstance(e, Exception):
            raise Refusal("プラグインのフォルダのファイルを入れ替える途中で失敗したので、直す前の状態に戻しました（%s: %s）。"
                          "原因を取り除いてから、もう一度 change を動かしてください。" % (type(e).__name__, e))
        raise

    # ⑧ 変わったファイルの一覧を残す
    files = sorted(set(added) | set(changed) | set(gone))
    write_text(os.path.join(work, CHANGED_JSON), json_text({"plugin": checked["plugin"], "head": head, "files": files}))
    shutil.rmtree(stage_root, ignore_errors=True)
    return {
        "ok": True,
        "plugin": checked["plugin"],
        "version": {"from": checked["version"], "to": version},
        "added": added,
        "removed": gone,
        "changed": changed,
        "knowledge": summary,
        "criteria": [{"id": c["id"], "knowledge": c["knowledge"]} for c in criteria],
        "warnings": warnings,
    }


# ---------------------------------------------------------------- 試験の直しの見張り（change-guard）

def change_guard(plugin: str, work: str, restore: bool = False) -> Dict[str, Any]:
    """changed.json の一覧の外で変わったファイルを示す（BLUEPRINT D19）。restore なら HEAD に戻す。"""
    plugin, work = os.path.abspath(plugin), os.path.abspath(work)
    problems: List[str] = []
    data = read_json(os.path.join(work, CHANGED_JSON), "描き直しで変わったファイルの一覧（%s/%s）" % (WORK_NAME, CHANGED_JSON), problems)
    if problems:
        raise Refusal(problems + ["change で直した後に使ってください。"])
    files = data.get("files") if isinstance(data, dict) else None
    if not isinstance(files, list) or not all(isinstance(f, str) for f in files):
        raise Refusal("描き直しで変わったファイルの一覧（%s/%s）の形が違います。" % (WORK_NAME, CHANGED_JSON))
    if not os.path.isdir(plugin):
        raise Refusal("直すプラグインのフォルダ %s がありません。" % plugin)
    _root, prefix = git_place(plugin)
    allowed = set(files)
    unexpected = [p for p in status_paths(plugin, prefix) if p not in allowed]
    restored: List[str] = []
    remaining = unexpected
    if restore and unexpected:
        for rel in unexpected:
            if git(["cat-file", "-e", "HEAD:./%s" % rel], plugin).returncode == 0:   # 管理されている：HEAD に戻す
                git_ok(["--literal-pathspecs", "checkout", "HEAD", "--", rel], plugin)
            else:   # 管理されていない：消す
                git(["--literal-pathspecs", "rm", "-q", "--cached", "--ignore-unmatch", "--", rel], plugin)
                path = os.path.join(plugin, *rel.split("/"))
                if os.path.islink(path) or os.path.isfile(path):
                    os.remove(path)
                    remove_empty_parents(path, plugin)
            restored.append(rel)
        remaining = [p for p in status_paths(plugin, prefix) if p not in allowed]
    return {"ok": not remaining, "unexpected": unexpected, "restored": restored}


# ---------------------------------------------------------------- コミット（commit）

def undo_command(plugin: str, name: str, commit: str) -> str:
    """直す前に戻すコマンド（REQ-059、REQ-060）。直したコミットを打ち消し、プラグインのフォルダの中だけをコミットする。
    --no-commit を付けるのは、付けないと、ほかのフォルダで git add してある変更があると断るためである（git 2.43 で確かめた）。
    打ち消すのは直したコミットだけなので、後からのコミットは残る。コミットしていない変更が直したファイルにあれば断る。
    && は、Windows PowerShell 5.1 では使えない（何も動かずに誤りになる）。PowerShell 7、cmd.exe、sh では使える。"""
    shown = shown_path(plugin)
    what = "%s の変更を戻した" % name if NAME_RE.fullmatch(name) else "直した変更を戻した"
    return ('git -C %s revert --no-commit %s && git -C %s commit -m "plugin-creator: %s" -- .'
            % (shown, commit, shown, what))


def commit_change(plugin: str, message: str, work: Optional[str] = None) -> Dict[str, Any]:
    """プラグインのフォルダの中だけをコミットし、印のタグを付け直し、作業用の一時フォルダを消す。push はしない。"""
    plugin = os.path.abspath(plugin)
    if not os.path.isdir(plugin):
        raise Refusal("直すプラグインのフォルダ %s がありません。" % plugin)
    if not message.strip():
        raise Refusal("コミットの説明（--message）が空です。")
    if work is not None:
        work = os.path.abspath(work)
        if os.path.basename(os.path.normpath(work)) != WORK_NAME or is_within(plugin, work):
            raise Refusal("--work は、作業フォルダの中の %s にしてください（今は %s）。" % (WORK_NAME, work))
    problems: List[str] = []
    manifest = read_manifest(plugin, problems)
    if manifest is None:
        raise Refusal(problems)
    _root, prefix = git_place(plugin)
    warnings: List[str] = []
    exclude = ":(exclude)%s" % WORK_NAME
    git_ok(["add", "-A", "--"] + add_paths(plugin), plugin)
    staged = git(["diff", "--cached", "--quiet", "--", "."], plugin)
    if staged.returncode not in (0, 1):
        raise Refusal("git diff に失敗しました：%s" % (staged.stderr or staged.stdout).strip())
    commit_id = undo = None
    if staged.returncode == 1:
        # 署名も、コミット前のフック（--no-verify）も使わない。ほかのフォルダで git add 済みの変更は入れない（パスを付けたコミット）
        command = ["-c", "commit.gpgsign=false"]
        if not git(["config", "user.name"], plugin).stdout.strip() or not git(["config", "user.email"], plugin).stdout.strip():
            command += ["-c", "user.name=%s" % FALLBACK_GIT_NAME, "-c", "user.email=%s" % FALLBACK_GIT_EMAIL]
        git_ok(command + ["commit", "-q", "--no-verify", "-m", message, "--", ".", exclude], plugin)
        commit_id = git_ok(["rev-parse", "HEAD"], plugin).strip()
        parent = git(["rev-parse", "-q", "--verify", commit_id + "^"], plugin)
        if parent.returncode == 0:   # 最初のコミットを打ち消すと、プラグインのフォルダがなくなる
            undo = undo_command(plugin, manifest["name"], commit_id)
    else:
        warnings.append("コミットする変更がありませんでした。")
    tag: Optional[str] = tag_name(prefix, manifest["name"])
    try:   # 署名を求める設定でも、署名しない軽いタグにする（署名つきのタグは説明の入力を待つため）
        tagged = git(["-c", "tag.gpgSign=false", "tag", "-f", tag], plugin)
        reason = (tagged.stderr or tagged.stdout).strip() if tagged.returncode != 0 else None
    except Refusal as e:   # 時間切れなど
        reason = "、".join(p.rstrip("。") for p in e.problems)
    if reason is not None:   # BLUEPRINT D40：コミットは残し、タグなしで進める
        warnings.append("印のタグ %s を付けられませんでした（%s）。コミットは残っています。" % (tag, reason))
        tag = None
    removed = False
    if work is not None and os.path.lexists(work):
        try:
            shutil.rmtree(work)
            removed = True
        except OSError as e:
            warnings.append("作業用の一時フォルダ（%s）を消せませんでした（%s）。手で消してください。" % (work, e))
    return {
        "ok": True,
        "commit": commit_id,
        "tag": tag,
        "revert": undo,
        "work_folder_removed": removed,
        "warnings": warnings,
    }


# ---------------------------------------------------------------- 入口

def emit(result: Dict[str, Any]) -> None:
    print(json.dumps(result, ensure_ascii=False, indent=2))


def main(argv: Optional[List[str]] = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="生成プラグインの組み立てと、土台の確かめ。今あるプラグインを直すときの確かめ・取り出し・直す・コミットもする。"
                                                 "結果は標準出力に JSON で出す。")
    sub = parser.add_subparsers(dest="command", required=True)
    b = sub.add_parser("build", help="生成プラグインを組み立てる")
    b.add_argument("--hearing", required=True, help="ヒアリングの記録 state.json のパス")
    b.add_argument("--work", required=True, help="作業用の一時フォルダ <作業フォルダ>/.plugin-creator-work")
    b.add_argument("--out", required=True, help="作る生成プラグインのフォルダ（作業フォルダの中の、まだないフォルダ）")
    c = sub.add_parser("check-base", help="土台のファイルがひな形と同じかを確かめる")
    c.add_argument("--out", required=True, help="生成プラグインのフォルダ")
    c.add_argument("--restore", action="store_true", help="違うファイルをひな形から入れ直す")
    k = sub.add_parser("change-check", help="直すプラグインのフォルダを、直す前に確かめる（読むだけ）")
    k.add_argument("--plugin", required=True, help="直すプラグインのフォルダ")
    k.add_argument("--cwd", required=True, help="Copilot CLI を起動したフォルダ")
    k.add_argument("--hearing", help="ヒアリングの記録 state.json のパス（Copilot CLI の設定フォルダを知るのに使う）")
    e = sub.add_parser("extract", help="直すプラグインから parts/ を取り出し、今のひな形で描いた下見と比べる")
    e.add_argument("--plugin", required=True, help="直すプラグインのフォルダ")
    e.add_argument("--work", required=True, help="作業用の一時フォルダ <作業フォルダ>/.plugin-creator-work")
    e.add_argument("--hearing", help="ヒアリングの記録 state.json のパス（示されたスキルとの名前の重なりを確かめる）")
    g = sub.add_parser("change", help="直す内容で描き、プラグインのフォルダのファイルを入れ替える（コミットしない）")
    g.add_argument("--hearing", required=True, help="ヒアリングの記録 state.json のパス")
    g.add_argument("--work", required=True, help="作業用の一時フォルダ <作業フォルダ>/.plugin-creator-work")
    g.add_argument("--plugin", required=True, help="直すプラグインのフォルダ")
    d = sub.add_parser("change-guard", help="描き直しで変えたファイルのほかに、変わったファイルがないかを見る")
    d.add_argument("--plugin", required=True, help="直すプラグインのフォルダ")
    d.add_argument("--work", required=True, help="作業用の一時フォルダ <作業フォルダ>/.plugin-creator-work")
    d.add_argument("--restore", action="store_true", help="一覧の外で変わったファイルを、直す前（HEAD）に戻す")
    m = sub.add_parser("commit", help="プラグインのフォルダの中だけをコミットし、印のタグを付ける（push しない）")
    m.add_argument("--plugin", required=True, help="直すプラグインのフォルダ")
    m.add_argument("--message", required=True, help="コミットの説明")
    m.add_argument("--work", help="消す作業用の一時フォルダ <作業フォルダ>/.plugin-creator-work")
    args = parser.parse_args(argv)
    try:
        if args.command == "build":
            result = build(args.hearing, args.work, args.out)
        elif args.command == "check-base":
            result = check_base(args.out, args.restore)
        elif args.command == "change-check":
            result = change_check(args.plugin, args.cwd, args.hearing)
        elif args.command == "extract":
            result = extract(args.plugin, args.work, args.hearing)
        elif args.command == "change":
            result = change(args.hearing, args.work, args.plugin)
        elif args.command == "change-guard":
            result = change_guard(args.plugin, args.work, args.restore)
        else:
            result = commit_change(args.plugin, args.message, args.work)
    except Refusal as e:
        emit({"ok": False, "problems": e.problems})
        return 1
    except Exception as e:   # 想定していない誤り。理由を示して止まる
        import traceback
        traceback.print_exc(file=sys.stderr)
        emit({"ok": False, "problems": ["予期しない誤りで止まりました（%s: %s）。" % (type(e).__name__, e)]})
        return 1
    emit(result)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
