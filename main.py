import os
import base64
import hmac
import json
import shutil
import re
import threading
import time
import zlib
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

from urllib.parse import parse_qs, urlparse

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from pydantic import BaseModel
import anthropic
import requests

import stage_bridge
import zoom_bridge

# .env ファイルからAPIキーを読み込む
env_path = Path(__file__).parent / ".env"
if env_path.exists():
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))

app = FastAPI()


class LocalOnly:
    """このPCからのアクセスだけを通す（Zoomの署名つきWebhookを除く）。
    ngrok等で公開しても、設定・発言の配信・判定には外から届かないようにする"""
    ALLOWED = {"127.0.0.1", "localhost", "::1"}
    # GitHub Codespaces など、転送用のホスト名を使う環境でだけ、環境変数で追加を許可する（既定は空）。
    # 例：ALLOWED_HOST_SUFFIXES=".app.github.dev"（先頭のドットが必要）
    # 公開サーバー用の合言葉（HTTP Basic認証。ユーザー名は何でもよい）。設定すると、すべてのアクセスに求める。
    # PUBLIC_MODE=1 のときは、合言葉が未設定なら全アクセスを拒否する（うっかり無防備で公開しないため）
    PASSWORD = os.environ.get("ACCESS_PASSWORD", "")
    PUBLIC_MODE = os.environ.get("PUBLIC_MODE") == "1"
    SUFFIXES = tuple(x.strip() for x in os.environ.get("ALLOWED_HOST_SUFFIXES", "").split(",") if x.strip().startswith("."))

    COOKIE = "minato_auth"

    @classmethod
    def token(cls):
        return hmac.new(cls.PASSWORD.encode(), b"minato-session-v1", "sha256").hexdigest()

    @classmethod
    def cookie_ok(cls, header):
        for part in (header or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == cls.COOKIE and hmac.compare_digest(v, cls.token()):
                return True
        return False

    @classmethod
    def password_ok(cls, header):
        if not header or not header.lower().startswith("basic "):
            return False
        try:
            raw = base64.b64decode(header[6:].strip()).decode("utf-8")
        except Exception:
            return False
        return hmac.compare_digest(raw.partition(":")[2].encode(), cls.PASSWORD.encode())

    @classmethod
    def host_ok(cls, name):
        return name in cls.ALLOWED or bool(name and cls.SUFFIXES and name.endswith(cls.SUFFIXES))

    # view view用PC（同じWi-Fiの別のパソコン）から開いてよいもの。STAGE_LAN=1 で起動したときだけ
    STAGE_PATHS = {"/stage", "/stage/events", "/stage/report",
                   "/static/stage.js", "/static/mofu.js", "/static/audio.js", "/static/style.css", "/tts", "/tts/status"}
    LOOPBACK = {"127.0.0.1", "::1"}
    _stage_fails: dict = {}

    @classmethod
    def stage_ok(cls, scope, headers, peer):
        """ほかのPCからの接続：合言葉（またはその後のCookie）があり、ステージ画面の部品だけなら通す"""
        if scope["path"] not in cls.STAGE_PATHS:
            return 403
        now = time.monotonic()
        count, first = cls._stage_fails.get(peer, (0, now))
        if now - first > 600:
            count, first = 0, now
        if count >= 10:
            return 429
        given = parse_qs(scope.get("query_string", b"").decode("latin-1")).get("key", [None])[0]
        if not (stage_bridge.key_ok(given) or stage_bridge.cookie_ok(headers.get("cookie"))):
            cls._stage_fails[peer] = (count + 1, first)
            return 403
        origin = headers.get("origin")
        if scope["method"] != "GET" and origin is not None and urlparse(origin).netloc != headers.get("host", ""):
            return 403
        return 0

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["path"] != "/zoom/webhook":
            headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
            # STAGE_LAN=1 のとき、このPC以外から届いた接続は、名乗り（Host）ではなく送り元で見分ける
            peer = (scope.get("client") or ("", 0))[0]
            if stage_bridge.lan_enabled() and peer not in self.LOOPBACK:
                code = self.stage_ok(scope, headers, peer)
                if code:
                    await JSONResponse({"error": "forbidden" if code == 403 else "too many attempts"}, status_code=code)(scope, receive, send)
                    return
                await self.inner(scope, receive, send)
                return
            host = urlparse("//" + headers.get("host", "")).hostname
            origin = headers.get("origin")
            origin_ok = origin is None or self.host_ok(urlparse(origin).hostname)
            if not self.host_ok(host) or not origin_ok:
                await JSONResponse({"error": "forbidden"}, status_code=403)(scope, receive, send)
                return
            if self.PUBLIC_MODE and not self.PASSWORD:
                await JSONResponse({"error": "ACCESS_PASSWORD が未設定のため、公開モードでは使えません"}, status_code=503)(scope, receive, send)
                return
            if self.PASSWORD and not (self.password_ok(headers.get("authorization")) or self.cookie_ok(headers.get("cookie"))):
                if scope["path"] != "/login":
                    if scope["method"] == "GET" and "text/html" in headers.get("accept", ""):
                        await RedirectResponse("/login", status_code=303)(scope, receive, send)  # 画面で開いた人はログイン画面へ
                    else:
                        await JSONResponse({"error": "合言葉が必要です"}, status_code=401,
                                           headers={"WWW-Authenticate": 'Basic realm="minato", charset="UTF-8"'})(scope, receive, send)
                    return
        await self.inner(scope, receive, send)


app.add_middleware(LocalOnly)

BASE_DIR = Path(__file__).parent
CONFIG_PATH = BASE_DIR / "config.json"
if not CONFIG_PATH.exists() and (BASE_DIR / "config.example.json").exists():
    shutil.copy(BASE_DIR / "config.example.json", CONFIG_PATH)  # 初回起動・公開サーバー用
LOGS_DIR = BASE_DIR / "logs"
LOGS_DIR.mkdir(exist_ok=True)

client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))
# 面談中の判定は応答の速さが最優先。実測（音声対話_設計.md）でOpus・Sonnetは2.5秒に収まらなかった
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-haiku-5-5")
CLAUDE_TIMEOUT_SEC = float(os.environ.get("CLAUDE_TIMEOUT_SEC", "2.5"))
judge_pool = ThreadPoolExecutor(max_workers=4)
judge_cache: dict = {}   # 途中文の先行判定を、確定した発言で再利用する（30秒だけ保持。ログには残さない）
judge_cache_lock = threading.Lock()

# その面談の間だけ置く情報（状況・上司が事前に伝えたいこと）。設定ファイルには保存しない
session_meta: dict = {"situation": "progress", "intent": {}}

session_log = {
    "started_at": None,
    "config_snapshot": None,
    "conversations": [],
    "interventions": [],
    "subordinate_signals": [],
    "speaker_corrections": [],
    "turn_log": [],
    "metrics": [],
}

# 音声計測として保存してよい項目。時間・件数・真偽値だけで、発言の本文は受け付けない
METRIC_KEYS = {
    "chars", "firstInterimMs", "finalMs", "judgeMs", "raiseMs", "speakMs", "speakAfterFinalMs", "cutWhileSpeaking",
    "expectedChars", "speechMs", "finals", "longestPauseMs", "pauseExpected", "pauseDone", "matchPct", "noFinal", "noSpeech",
}


def clean_metrics(rows, limit: int = 500) -> list[dict]:
    out = []
    for r in (rows or [])[:limit]:
        if not isinstance(r, dict):
            continue
        row = {}
        for k, v in r.items():
            if k in METRIC_KEYS and (v is None or isinstance(v, bool) or (isinstance(v, (int, float)) and abs(v) < 1e9)):
                row[k] = v
            elif k == "kind" and isinstance(v, str) and re.fullmatch(r"[a-z_]{1,16}", v):
                row[k] = v
            elif k == "id" and isinstance(v, str) and re.fullmatch(r"p\d{2}", v):
                row[k] = v
        out.append(row)
    return out

SPEAKER_LABELS = {"boss": "上司", "subordinate": "部下", "any": "会話"}   # any＝話者を分けない（誰の言葉でも、部下のフォローに使う）


class AnalyzeRequest(BaseModel):
    transcript: str
    context: list[str] = []
    speaker: str = "boss"                     # boss / subordinate
    speaker_source: str = "manual"            # auto（声で判定）/ manual / demo / text
    speaker_confidence: float | None = None
    speaker_unsure: bool = False              # 話者に自信がない発言は外部へ送らず、声にもしない
    reanalysis: bool = False                  # 話者を直した発言の再判定（会話記録は増やさない）
    speculative: bool = False                 # 話し終わりの気配で途中文を先に判定する（記録しない）


DEFAULT_PRESETS = {
    "perfectionist": {
        "label": "完璧主義・自責タイプ",
        "traits": "完璧主義で自責しやすい。失敗を自分の能力不足と捉える傾向がある",
        "landmines": "「なぜできなかったのか」「もっと早く相談すべきだった」→ 無能感・存在否定と受け取る",
        "meta_triggers": "具体的な行動ステップを提示すると冷静になれる。「次はどの時点で相談するか」という基準の話に持ち込む",
    },
    "logical": {
        "label": "論理重視タイプ",
        "traits": "理由や根拠に納得してから動きたい。事実やデータで話すと受け取りやすい",
        "landmines": "「普通はこうする」「いいからやって」など根拠のない指示・感情的な言い方 → 反発するか、黙って壁を作る",
        "meta_triggers": "目的と理由を先に伝え、「どこが曖昧だったか」を一緒に確認する",
    },
    "sensitive": {
        "label": "感情繊細タイプ",
        "traits": "繊細でプレッシャーに弱い。周囲の空気や声のトーンに敏感",
        "landmines": "強い口調、ため息、沈黙 → 「怒られている」「見放された」と感じてフリーズする",
        "meta_triggers": "まず気持ちを受け止めてから「一番困ったのはどの場面でしたか」と具体化する",
    },
    "independent": {
        "label": "自立・主導タイプ",
        "traits": "自分で考えて決めたい。任されると力を発揮するが、細かい指示や口出しを嫌う",
        "landmines": "「普通はこうする」「言われた通りにやって」→ 信頼されていない・やり方を否定されたと受け取る",
        "meta_triggers": "目的と期限だけを共有し、やり方は本人に選んでもらう。「どう進めるのがいいと思う？」と聞く",
    },
}


def load_config() -> dict:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        config = json.load(f)
    # 4つ目のタイプの追加や、空欄のままのプロファイルを既定の文で補う（保存は画面から保存した時）
    presets = config.setdefault("personality_presets", {})
    for key, default in DEFAULT_PRESETS.items():
        cur = presets.setdefault(key, {})
        for field, text in default.items():
            if not (cur.get(field) or "").strip():
                cur[field] = text
    return config


def save_config(data: dict):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def tendency_text(config: dict) -> str:
    scores = (config.get("profile_analysis") or {}).get("scores") or {}
    parts = [f"{DIM_LABELS[k]} {scores[k]}" for k in TYPE_KEYS if isinstance(scores.get(k), (int, float))]
    return " / ".join(parts) if parts else "（未分析）"


def meeting_text(meta: dict | None, config: dict) -> str:
    meta = meta or {}
    sit = SITUATIONS.get(meta.get("situation") or "", SITUATIONS["progress"])
    lines = [f"【面談の状況】{sit['label']}：{sit['prompt']}"]
    intent = meta.get("intent") or {}
    goals = [mask_names(g, config) for g in intent.get("goals") or []]
    if goals or intent.get("takeaway") or intent.get("outcome"):
        lines.append("【上司が事前に伝えたいこと（上司の意図の推測にだけ使い、断定しない）】")
        for g in goals:
            lines.append(f"- 伝えたいこと: {g}")
        if intent.get("takeaway"):
            lines.append(f"- 部下に持ち帰ってほしいこと: {mask_names(intent['takeaway'], config)}")
        if intent.get("outcome"):
            lines.append(f"- 面談の後どうなってほしいか: {mask_names(intent['outcome'], config)}")
    return "\n".join(lines)


def build_system_prompt(config: dict, meta: dict | None = None) -> str:
    persona = config["character_persona"]
    active_key = config.get("active_preset", "perfectionist")
    personality = config["personality_presets"].get(active_key, {})
    sensitivity = config.get("sensitivity", "medium")

    sensitivity_desc = {
        "low": "明確な人格否定・詰問の場合のみ介入する",
        "medium": "人格否定に加え、抽象論やプレッシャーを感じる発言にも介入する",
        "high": "軽い指摘でも、対象者が傷つく可能性があれば介入する",
    }

    return f"""あなたは1on1面談に同席するAIキャラクターです。上司の言葉を言い直すのではなく、部下が自分を否定せずに指摘を受け取れるよう、その場で「受け取り方」を短く促すコーチです。

【あなたの人格】
- 名前: {persona['name']}
- 立ち位置: {persona['position']}
- 口調: {persona['tone']}
- 一人称: {persona['first_person']}
- 禁則: {persona['forbidden']}

【対象者（部下）の特性。判断にだけ使い、発言には絶対に出さない】
- 特性: {personality.get('traits', '')}
- 受け取りやすい誤解: {personality.get('landmines', '')}
- 落ち着いて考えやすい問い: {personality.get('meta_triggers', '')}
- 受け止め方の傾向（0〜100）: {tendency_text(config)}

{meeting_text(meta, config)}

【介入感度】
{sensitivity_desc.get(sensitivity, sensitivity_desc['medium'])}

【判断】
直近の会話には「上司:」「部下:」の話者ラベルが付いています。判定するのは最新の上司の発言だけで、部下の発言は文脈です。
- 上司自身の謝罪、感謝、気遣いには介入しない
- この部下なら問題なく受け取れる発言には介入しない

【受け取り方の4つの型】（受け手の訓練の考え方。指摘は人ではなく仕事に向けたもの、として受け取る）
- 分ける：人ではなく、行動・仕事の話として受け取る
- 取り出す：言い方が強くても、直してほしい中身を拾う
- 確かめる：分からない所は、どの部分か具体的に聞く
- 伝える：自分の事情や考えを、落ち着いて伝える

【reframed_speech の書き方】
- 部下に向けて話す。上司の言葉の言い直しや、上司の意図の代弁はしない
- 上司の指摘の中身は消さない。部下が自分を否定せず、中身だけを受け取れるようにする
- 上の4つの型から、この場面に合う1つを「〜しましょう」「〜場面です」と促し、部下が次に言えることにつながる短い問いを添える（2文）
- 人格・能力を否定する言葉に対しては、受け取るよう促さない。「あなたの価値の話ではない」と伝え、行動の話に分ける
- 「受け取り方が悪い」「前向きに」など、部下に責任を移す言葉は使わない
- 38文字以内。呼びかけの言葉は付けない
- 性格、タイプ、特性、傾向に関する言葉は使わない

reply_example には、部下がそのまま口に出せる返しを40文字以内で書きます（「〜教えてもらえますか？」など）。
boss_tip には、上司だけが画面で読む言い換えの提案を60文字以内で書きます。人ではなく行動について、理由を添えて伝える言い方を提案します。介入しない場合、reframed_speech・reply_example・boss_tip は空文字にします。"""


VERDICT_SCHEMA = {
    "type": "object",
    "properties": {
        "should_intervene": {"type": "boolean"},
        "risk_level": {"type": "string", "enum": ["none", "low", "medium", "high"]},
        "reason": {"type": "string"},
        "reframed_speech": {"type": "string"},
        "reply_example": {"type": "string"},
        "boss_tip": {"type": "string"},
    },
    "required": ["should_intervene", "risk_level", "reason", "reframed_speech", "reply_example", "boss_tip"],
    "additionalProperties": False,
}


def mask_names(text: str, config: dict) -> str:
    mask_list = config.get("name_masks", {})
    masked = text
    for real_name, alias in mask_list.items():
        masked = masked.replace(real_name, alias)
    return masked


ATTACK_PATTERNS = [
    {
        "id": "personal_attack",
        "label": "人格・能力の否定",
        "patterns": [
            r"使え(?:ない|ねー|ねえ)",
            r"やる気(?:ある|あんの|あるの|ないの|ない(?:んだ|よね|でしょ|な)|が(?:見えない|感じられない|ない))",
            r"向いて(?:い)?ない",
            r"(?:考え|見通し|詰め|認識|読み)が甘い|甘すぎ|甘いよ|甘いね|甘いな",
            r"言い訳(?:は|を)?(?:いい|するな|しないで|ばかり|ばっかり|は聞きたくない|しない)",
            r"(?:社会人|大人|プロ)として(?:どう|ありえない|失格|おかしい|当たり前|当然|常識)",
            r"(?:この程度|こんなこと|こんな簡単なこと)(?:も|すら)?(?:できない|わからない|分からない)",
            r"(?:全然|まったく|何も|なにも)(?:わかって|分かって|理解して)(?:ない|いない)",
            r"(?:センス|才能|能力)(?:が)?(?:ない|低い|足りない)",
            r"(?:君|きみ|お前|おまえ|あなた)の(?:せい|責任)",
            r"(?:子供|子ども|新人|学生|素人|小学生)(?:じゃ|では)(?:ない|あるまい)(?:んだ|し|から|でしょ)",
            r"何年(?:目|も)?(?:この仕事|仕事|やって|働いて|いる)",
            r"(?:バカ|馬鹿|ばか|アホ|あほ)(?:か|じゃない|だな|だろ|だね|なの|なんじゃ)|(?:無能|役立たず|役たたず|ポンコツ|ぽんこつ|お荷物|給料泥棒|能無し)",
            r"足を引っ張(?:らないで|るな|るなよ|って(?:る|いる)(?:よ|ね|の|んだ))",
            r"(?:理解力|覚え|飲み込み|察し|要領|頭)(?:が)?(?:悪い|ない|遅い|低い|足りない)(?:ね|な|よ|んじゃ|だろ|でしょ)?",
            r"レベル(?:が|は)?(?:低い|低すぎ|違いすぎ)",
            r"常識(?:が|も)?(?:ない|なさすぎ|欠けて|ないの)",
            r"(?:成長|進歩)(?:が|は)?(?:しない|ない|してない|してない)(?:ね|な|よ|だろ|でしょ)?",
            r"(?:辞め|やめ)(?:たら|れば|ちゃえ|てしまえ|ていい)(?:\?|？|どう|いい|$)",
            r"(?:能力|実力|スキル)(?:が|は)?(?:低い|足りない)(?:んじゃ|でしょ|だろ|ね|な)",
            r"(?:社会人|大人|プロ)(?:として)?(?:失格|終わって)",
            r"(?:仕事|私|人|俺|僕)を(?:舐め|なめ|ばかに|バカに|馬鹿に)(?:て|てる|てるの|てんの|るのか)",
            r"(?:小学生|子供|子ども|誰|新人|素人)でも(?:分かる|わかる|できる)",
            r"(?:君|きみ|お前|おまえ|あなた)(?:には|は|に)[^。]{0,8}(?:がっかり|失望|呆れ|あきれ|期待できない|頼めない|任せられない|要らない|いらない)",
            r"(?:要らない|いらない|不要)(?:よ|な|ね|だ|んだ)?$",
            r"(?:もう|二度と)(?:あなた|君|お前)(?:には|に)?(?:頼まない|頼めない|任せない|任せられない)",
            r"(?:任せた|頼んだ)(?:僕|私|俺)が(?:悪|馬鹿|バカ|間違)",
            r"(?:先|将来)が思いやられ",
            r"(?:あなた|君|お前)のやり方は(?:間違|おかしい|ダメ|だめ|違う)",
            r"(?:結果|成果)を(?:出せない|出さない)(?:人|やつ|奴)",
            r"(?:あなた|君|お前)(?:に|を)(?:頼んだ|任せた|採用した|選んだ)(?:のが|の)(?:間違い|失敗|ミス)",
            r"(?:君|あなた|お前)みたいな(?:人|やつ|奴)が(?:いる|いて)と",
            r"(?:もう|また)?(?:忘れた|覚えてない|覚えていない)の(?:？|\?|か|$)",
            r"迷惑(?:を)?(?:かけ|掛け)ないで(?:くれ|よ|ください)?",
            r"頭(?:を)?使(?:え|ってよ|いなよ|えよ)",
            r"ありえない(?:でしょ|よ|ね|な|わ)?$",
        ],
        "safe_patterns": [
            r"(?:ツール|システム|パソコン|PC|アプリ|機能|プリンター|会議室|回線|ネット|サーバー|ソフト)(?:が|は)?使え(?:ない|ねー)",
            r"ありえない(?:くらい|ほど)",
            r"向いて(?:い)?ない(?:と|って)(?:思って|感じて|悩)",
            r"(?:僕|私|俺|わたし|ぼく|自分)の(?:せい|責任)",
        ],
        "score": 9,
    },
    {
        "id": "accusatory_why",
        "label": "追及型の「なぜ」",
        "patterns": [
            r"(?:なぜ|なんで|何で|何故).*(?:なかった|しなかった|できなかった|やらなかった|言わなかった|しない)",
            r"(?:なぜ|なんで|何で|何故).*(?:の\s*$|んだ|のか)",
            r"(?:どうして).*(?:なかった|しなかった|できなかった|くれない|しない)",
            r"(?:なんで|なぜ|何で|どうして)(?:こんな|そんな)(?:ミス|こと|失敗|間違い|簡単なこと|初歩的)",
            r"どういう(?:つもり|神経|了見|こと)(?:で|なの|だ|だよ)",
            r"(?:本当に|ほんとに)(?:分かって|わかって|理解して|考えて|反省して)(?:る|いる)(?:の|のか|？|\?)",
            r"(?:やる前|言う前|始める前|最初)から(?:分かって|わかって)(?:た|いた)(?:でしょ|よね|はず|じゃん)",
            r"(?:こっち|私|僕|俺)の(?:身|立場)にも(?:なって|なれ)",
            r"よく(?:それ|こんな)(?:で|を)[^。]{0,8}(?:と思った|と思えるね|平気で|言えた|出せた|できたね)",
            r"[^。]{0,10}つもり(?:なの|だ|か|なんだ|なんですか|？|\?|$)",
            r"(?:聞いて|見て|読んで)(?:なかった|いなかった|ないの|ないのか)(?:の|か|？|\?)",
            r"(?:なんで|なぜ|どうして)そんな[^。]{0,10}(?:躓く|つまずく|間違える|ミスする|できない|わからない|分からない)",
            r"どうして(?:くれる|くれるの|くれるんだ|くれるんですか)",
            r"(?:なんで|なぜ|何で|どうして).*勝手に",
            r"(?:なんで|なぜ|何で|どうして).*(?:報告|連絡|相談|確認|共有|質問|聞)(?:しない|しなかった|くれない|くれなかった|してくれない)",
            r"(?:どうして|なんで|なぜ|何で).*(?:こうなった|そうなった|こんなこと)",
        ],
        "safe_patterns": [
            r"(?:なぜ|なんで|何で)(?!.*(?:なかった|しない|できなかった|くれなかった)).*(?:だと思|と思い|と考え|にした|になった|を選|ですか)",
            r"(?:なぜ|なんで|何で).*(?:だと思|と思い|と考え|にした|になった|を選)",
            r"(?:どうして|なぜ|なんで|何で).*(?:と思う|と思います|と考える|と思った)(?:の|か)?$",
            r"(?:なぜ|なんで|何で).*のか(?:が|を|は|も)(?:わから|知りたい|聞きたい|教えて)",
            r"(?:なぜ|なんで|何で).*(?:取り組|選ん|始め|やろう|考え).*(?:のか|んだろう)",
        ],
        "score": 8,
    },
    {
        "id": "common_sense_push",
        "label": "常識の押しつけ",
        "patterns": [
            r"(?:常識|普通|当たり前|当然).*(?:でしょ|だろ|じゃない|だよね|わかる)",
            r"(?:誰が|だれが)(?:読む|見る|使う|買う|喜ぶ)と思(?:って|う)",
            r"(?:もっと|もう少し)(?:周り|状況|全体)を(?:見|考え)(?:て|たら|なよ|ろ)",
            r"(?:常識的|普通)(?:に)?考えて",
            r"(?:言わなくても|言われなくても|それくらい|そのくらい|見れば|考えれば|少し考えれば|ちょっと考えれば)[^。]{0,8}(?:分かる|わかる|気づく|気付く|できる)(?:でしょ|だろ|はず|よね|じゃん)",
            r"社会人なら(?:当然|当たり前)",
            r"(?:当たり前|当然)のこと(?:だよ|でしょ|じゃない|だろ)",
            r"普通(?:は|なら|に)(?:こう|そう|ああ)(?:する|やる|考える)",
        ],
        "safe_patterns": [],
        "score": 7,
    },
    {
        "id": "pressure",
        "label": "プレッシャー・急かし",
        "patterns": [
            r"(?:いつまで|まだ).*(?:かか(?:る|って)|できない|できてない|終わらない|終わって|やって|やるの)",
            r"(?:遅い|遅すぎ|早く|急いで|いい加減).*(?:して|しろ|やれ|しなさい|にして)",
            r"いい加減にし",
            r"(?:さっさと|とっとと|ぐずぐず|のんびり|たらたら|もたもた)",
            r"遅い(?:んだよ|でしょ|だろ|じゃん|よ$)",
            r"いつになったら",
            r"(?:期限|締め切り|〆切|納期)(?:を|は)?(?:とっくに|もう)?(?:過ぎて|守れて|破って|切れて)",
            r"(?:今日中|今すぐ|すぐに|今週中)(?:に)?(?:終わらせ|やれ|出せ|仕上げろ|片付け)(?:ろ|なさい|よ)",
            r"(?:また|今日も)(?:遅刻|遅れ|遅い)(?:？|\?|か|ね|よ|だ|$)",
            r"(?:危機感|緊張感|スピード感)を(?:持って|持て|持ってくれ)",
            r"(?:危機感|緊張感|スピード感)が(?:ない|足りない|足りてない)",
            r"早く(?:して|やって|してくれ|しろ|終わらせ)",
            r"遅すぎ(?:る|だ|でしょ|ない|よ|ね|$)",
        ],
        "safe_patterns": [],
        "score": 6,
    },
    {
        "id": "denial",
        "label": "否定・ダメ出し",
        "patterns": [
            r"(?:ダメ|だめ|駄目)(?:でしょ|だよ|だろ|じゃん|だね)",
            r"(?:できてない|出来てない|できない|出来ない)(?:よ|ね|じゃん|でしょ|だろ)",
            r"(?:違う|間違|ミス).*(?:でしょ|だよ|だろ|じゃん|ってる)",
            r"全然(?:できて|なって|ダメ|だめ)",
            r"(?:結果|成果|数字)(?:が|は)?(?:出て|上がって|ついてきて)(?:ない|いない)",
            r"(?:これ|それ|この)[^。]{0,6}(?:意味が分からない|わけが分からない|何が言いたい|話が見えない)",
            r"(?:まともな|ちゃんとした)(?:説明|資料|報告|仕事|やり方|答え)(?:を|が)?",
            r"これで(?:本当に|ほんとに)?(?:終わり|完成|できた|いい|OK)のつもり",
            r"(?:これ|それ|この)じゃ[^。]{0,10}(?:出せない|通らない|渡せない|見せられない)",
            r"(?:もう少し|もっと)[^。]{0,8}(?:できないの|できないかな|できないのか|できないわけ)",
            r"手を抜い(?:て|てる|ている)(?:と|だけ|んじゃ)|としか思えない",
            r"(?:もう一回|もう一度|もう1回)(?:最初|一から|はじめ)から(?:やって|やり直|作り直)",
            r"(?:全然|ぜんぜん|まったく)(?:響|伝わ|刺さ)(?:って|らない|ってこない)",
            r"(?:やる|する|続ける)?意味(?:が)?(?:ない|なくない)(?:よね|よな|じゃん|でしょ|だろ|の|よ|か)?[。？\?]?$",
            r"(?:時間|手間)を(?:無駄|ムダ)にしないで|時間の無駄",
            r"(?:ミス|穴|間違い)だらけ",
            r"(?:雑|お粗末|ずさん|杜撰|いい加減)(?:すぎ|過ぎ|だ|だね|だな|だよ|過ぎる)",
            r"(?:全部|最初から|一から)?(?:やり直し|作り直し|出し直し|書き直し)(?:だ|だね|だな|して|で|な)(?:よ|ね)?$",
            r"(?:ひどい|酷い)(?:出来|できばえ|ミス|すぎる)",
            r"(?:なって|できて)(?:ない|ねえ|ねー)(?:よ|ね|な|じゃん)?$",
            r"(?:これ|それ)じゃ(?:ダメ|だめ|駄目|話にならない|使えない)",
            r"出来(?:が)?(?:悪い|わるい|ひどい)",
            r"意味(?:ある|あるの|ない|なくない)(?:の|よ|でしょ|かな)?$",
        ],
        "safe_patterns": [
            r"(?:違う|間違).*(?:ですか|かな|かも)",
        ],
        "score": 7,
    },
    {
        "id": "repetition_blame",
        "label": "繰り返し指摘",
        "patterns": [
            r"(?:何回|何度).*(?:言った|言えば|言わせる)",
            r"(?:また同じ|また|前も).*(?:ミス|失敗|間違|できて)",
            r"(?:また|毎回|いつも|毎度|何回目)(?:か|だ|ね|よ|なの|じゃん|同じ|そ)",
            r"(?:いつも|毎回|毎度)[^。]{0,6}(?:言って|言わせ|注意して|同じ)(?:る|いる|ます|よね|だ)?",
            r"(?:何回目|何度目)(?:だ|だと|です|なの)",
            r"学習(?:して|能力)?(?:ない|いない|しない)",
            r"(?:同じ|また)(?:ミス|こと|失敗)は(?:やめて|するな|しないで|繰り返さないで|繰り返すな)",
            r"さっき(?:も)?(?:言った|伝えた|説明した)(?:でしょ|よね|じゃん|だろ)",
            r"(?:前|この前|先週)(?:にも|も)(?:言った|注意した|伝えた|教えた)",
            r"(?:同じ|また)(?:こと|ミス|失敗|間違い)を(?:繰り返|やって|して)",
            r"(?:言ったよね|言ったでしょ|伝えたよね|教えたよね)",
        ],
        "safe_patterns": [],
        "score": 9,
    },
    {
        "id": "vague_demand",
        "label": "曖昧な要求・叱責",
        "patterns": [
            r"(?:ちゃんと|しっかり|きちんと).*(?:して|しろ|やれ|やって|考えて|しなさい)",
            r"(?:ちゃんと|しっかり|きちんと)(?:やれ|しろ|して)(?:よ|$)",
            r"もっと(?:ちゃんと|しっかり|きちんと)",
            r"自分で考えて(?:よ|ね|くれ|ください)?$",
            r"(?:しっかり|ちゃんと|きちんと)(?:してよ|しろよ|しなよ|してくれ|しなさい|してくれないと)",
            r"(?:努力|頑張り|気合い|気合|やる気|本気)(?:が)?(?:足りない|足りてない|たりない)",
            r"もっと(?:頑張|真剣|本気|必死)",
            r"(?:真剣|本気|必死)(?:に|で)(?:やって|考えて|取り組んで|やれ)",
            r"(?:やる気|気合い|気合)を?(?:出して|入れて)",
            r"(?:言われた|指示した)(?:通り|とおり)(?:に)?(?:やって|して|やれ|すれば)",
            r"(?:黙って|いいから)(?:やって|言われた|従って)",
            r"(?:もう少し|もっと)(?:真剣|本気)に",
            r"(?:少し|ちょっと)は(?:考えて|頭を使って)",
        ],
        "safe_patterns": [
            r"(?:ちゃんと|しっかり).*(?:できて|やれて|考えて)(?:いる|る|た)",
        ],
        "score": 6,
    },
    {
        "id": "disappointment",
        "label": "失望・責任追及",
        "patterns": [
            r"(?:期待).*(?:してた|していた|はずれ|外れ)",
            r"(?:がっかり|残念)(?:だ|です|した|だよ|だね)",
            r"(?:もう)?任せられない",
            r"失望",
            r"裏切(?:られ|った)",
            r"(?:信用|信頼)(?:が|を)?(?:できない|できなく|失|落と|なくな|ならない)",
            r"見損(?:な|ね)",
            r"(?:あてに|当てに)(?:ならない|できない)",
            r"期待(?:して|は)(?:ない|いない|しない|してなかった)",
            r"(?:君|あなた|お前)に(?:は)?(?:がっかり|失望|呆れ)",
            r"この程度(?:か|だった|なんだ)",
            r"(?:責任|自覚|意識).*(?:ない|ある|足りない|持って|して)",
        ],
        "safe_patterns": [
            r"期待(?:してる|しています|してるよ|できる|できそう|したい)",
        ],
        "score": 7,
    },
    {
        "id": "sigh_tone",
        "label": "ため息・呆れ",
        "patterns": [
            r"(?:はぁ|はあ|ふぅ|あのさ|ねえ).*(?:何回|なんで|どうして|いつ)",
            r"(?:呆れ|あきれ|うんざり|ため息|ため息しか)",
            r"(?:好き|勝手)に(?:したら|すれば|しろ|して)",
            r"どうでもいい(?:よ|や|けど|わ)?",
            r"(?:もういいや|もう知らない|もう知らん|知らないよ)",
            r"(?:もういい|もういいよ|話にならない|無理だ)",
        ],
        "safe_patterns": [],
        "score": 8,
    },
]


# 上司自身の謝罪・感謝・気遣いの言葉。この部分は介入の根拠にしない
SAFE_CLAUSE_PATTERNS = [
    r"(?:ごめん|すまん|すまない|申し訳|悪かった|(?<!出来が)(?<!できが)(?<!頭が)(?<!覚えが)(?<!要領が)(?<!察しが)(?<!手際が)悪いね)",
    r"(?:責任|原因)は(?:僕|私|俺|わたし|ぼく|こっち|自分)",
    r"(?:僕|私|俺|わたし|ぼく)(?:の|に)(?:責任|せい)",
    r"(?:ありがとう|助かった|助かる|感謝)",
    r"無理(?:だったら|なら|しないで|せず|しなくて|はしないで)",
    r"(?:気にしないで|遠慮しないで|いつでも(?:相談|言って|声))",
]

# 「でも」は「なんでも」等に含まれるので、謝罪・感謝の直後か句読点の直後だけ区切りにする
CLAUSE_SPLIT = (r"[、。，．,.!！?？\s]+|だけど|けれど|けど"
                r"|(?<=ありがとう)でも|(?<=ごめん)でも|(?<=ごめんね)でも|(?<=ます)でも|(?<=です)でも|(?<=^)でも")

CUSHION_PHRASES = ["あの、", "えっと、"]

# 受け取り方の4つの型（Google のコードレビューの手引き「レビューコメントへの対処の仕方」の受け手の原則を元にした）
# 部下を採点しない。できたことだけ数える（発注書 v12・critic）
RECEIVE_SKILLS = {
    "separate": {"label": "分ける", "desc": "人ではなく、行動・仕事の話として受け取る",
                 "praise": "行動と次の一手で話せています"},
    "extract": {"label": "取り出す", "desc": "言い方が強くても、直してほしい中身を拾う",
                "praise": "指摘の中身を取り出せています"},
    "clarify": {"label": "確かめる", "desc": "分からない所は、どの部分か具体的に聞く",
                "praise": "具体的に確かめられています"},
    "explain": {"label": "伝える", "desc": "自分の事情や考えを、落ち着いて伝える",
                "praise": "自分の事情を伝えられています"},
}
SKILL_KEYS = list(RECEIVE_SKILLS)

# 上司の言い方の種類ごとに、部下が使うとよい受け取り方の型
# 人格・能力の否定（personal_attack）は受け取る練習の対象にしないので、型を割り当てない（発注書 v12・critic、レビュー指摘6）
CATEGORY_SKILL = {
    "accusatory_why": "explain",
    "common_sense_push": "clarify",
    "pressure": "explain",
    "denial": "extract",
    "repetition_blame": "separate",
    "vague_demand": "clarify",
    "disappointment": "extract",
    "sigh_tone": "separate",
}

# view viewが声で話すセリフ。上司の言葉を言い直すのではなく、部下に「受け取り方の型」をその場で促す。
# 人格・能力の否定は受け取る練習の対象にしない（「あなたの価値の話ではない」と言い切る）。
# 性格の話は一切しない（CEO方針）。呼びかけ込みで40字以内
MINATO_LINES = {
    "personal_attack": {
        "perfectionist": "あなたの価値の話ではないです。そのまま受け止めなくて大丈夫です",
        "logical": "人への評価は受け止めなくて大丈夫です。行動の話かだけ見ましょう",
        "sensitive": "あなたの価値の話ではないです。そのまま受け止めなくて大丈夫です",
        "independent": "力の否定は受け止めなくて大丈夫です。行動の話かだけ見ましょう",
    },
    "accusatory_why": {
        "perfectionist": "経緯を伝える場面です。迷った時点から話してみませんか？",
        "logical": "事情を伝える場面です。判断の理由を順に話してみませんか？",
        "sensitive": "経緯を伝える場面です。困った場面からゆっくり話せそうですか？",
        "independent": "判断の理由を伝える場面です。どう考えて決めたか話せそうですか？",
    },
    "common_sense_push": {
        "perfectionist": "基準を確かめる場面です。揃えたい所を聞いてみませんか？",
        "logical": "基準を確かめましょう。何を揃えたいのか聞いてみませんか？",
        "sensitive": "確かめれば大丈夫です。揃えたい所を一つ聞いてみませんか？",
        "independent": "基準を確かめる場面です。狙いを伝えて、揃える所を聞きませんか？",
    },
    "pressure": {
        "perfectionist": "今の状況を伝える場面です。終わった所から話せそうですか？",
        "logical": "見通しを伝える場面です。残りの作業と期限を話せそうですか？",
        "sensitive": "状況を伝えれば大丈夫です。止まっている所を話せそうですか？",
        "independent": "見通しを伝える場面です。いつ見せられるか話してみませんか？",
    },
    "denial": {
        "perfectionist": "直す中身を取り出しましょう。一番の所はどこか聞きませんか？",
        "logical": "中身を取り出しましょう。どの部分のことか確かめませんか？",
        "sensitive": "全部ではなく中身を取り出しましょう。一番の所を聞きませんか？",
        "independent": "直す中身を取り出しましょう。どの部分か聞いてみませんか？",
    },
    "repetition_blame": {
        "perfectionist": "人ではなく手順の話に分けましょう。止まる所を一緒に見ませんか？",
        "logical": "手順の話に分けましょう。前回と違った条件を話せそうですか？",
        "sensitive": "手順の話に分けましょう。つまずく所を一緒に見てもらいませんか？",
        "independent": "手順の話に分けましょう。自分の防ぎ方を伝えてみませんか？",
    },
    "vague_demand": {
        "perfectionist": "具体的に確かめましょう。何をすれば十分か聞いてみませんか？",
        "logical": "基準を確かめましょう。どこまでやれば十分か聞いてみませんか？",
        "sensitive": "確かめれば大丈夫です。まず一つだけ何をするか聞きませんか？",
        "independent": "基準を確かめましょう。十分な所を聞いて、進め方を伝えませんか？",
    },
    "disappointment": {
        "perfectionist": "期待の中身を取り出しましょう。次に何を求めているか聞きませんか？",
        "logical": "期待の中身を取り出しましょう。どこがずれたか確かめませんか？",
        "sensitive": "期待の中身を取り出しましょう。次に何をすればいいか聞きませんか？",
        "independent": "期待の中身を取り出しましょう。次の進め方を伝えてみませんか？",
    },
    "sigh_tone": {
        "perfectionist": "空気より言葉の中身を見ましょう。今の要点を聞いてみませんか？",
        "logical": "空気より言葉の中身を見ましょう。要点を確かめてみませんか？",
        "sensitive": "空気より言葉の中身を見ましょう。今の要点を聞いてみませんか？",
        "independent": "空気より言葉の中身を見ましょう。今の考えを伝えてみませんか？",
    },
}

# 部下がそのまま言える返し（画面に出す「言えるひとこと」）
REPLY_EXAMPLES = {
    "personal_attack": "今の言い方はつらいです。直す点があれば具体的に教えてください。",
    "accusatory_why": "経緯をお話しします。〇〇の時点で、△△と判断していました。",
    "common_sense_push": "揃えたいのはどの部分か、例を教えてもらえますか？",
    "pressure": "今ここまで終わっていて、残りは〇〇です。△日までに見せられます。",
    "denial": "一番直すべきところはどこか、教えてもらえますか？",
    "repetition_blame": "同じことが起きないように、確認の手順を一緒に決めてもらえますか？",
    "vague_demand": "どこまでできていれば十分か、具体的に教えてもらえますか？",
    "disappointment": "次はどうなっていれば期待に近づけるか、教えてもらえますか？",
    "sigh_tone": "今いちばん気になっている点を教えてもらえますか？",
}

# 声に出してはいけない言葉（生成されたセリフの最終確認に使う）
UNSPEAKABLE_WORDS = ["完璧主義", "自責", "論理重視", "論理的", "感情繊細", "繊細", "性格", "タイプ", "特性", "傾向", "地雷"]
MAX_SPEECH_CHARS = 38


def pick(seq: list, text: str):
    """同じ発言なら同じ結果になるように選ぶ（デモと検証の再現性のため）"""
    return seq[zlib.crc32(text.encode("utf-8")) % len(seq)]


def speech_is_safe(speech: str, config: dict) -> bool:
    if not speech or len(speech) > MAX_SPEECH_CHARS:
        return False
    labels = [p.get("label", "") for p in config.get("personality_presets", {}).values()]
    return not any(w and w in speech for w in UNSPEAKABLE_WORDS + labels)


# 上司だけが画面で読む、言い換えの提案
BOSS_TIPS = {
    "personal_attack": [
        "人や能力を指す言葉は、強く残ってしまうかもです〜。「この資料のこの部分を直そう」って、行動や場面を指して伝えるのはどうですかね？",
        "「使えない」「向いてない」みたいな言葉は、相手の方が自分を否定しちゃうきっかけになりやすいです。何が起きていて、次にどうしてほしいかを伝えると届きやすいと思いますよ！",
    ],
    "accusatory_why": [
        "今の聞き方だと、ちょっと身構えちゃうかもです〜。「どういう経緯だったか教えてもらえますか？」って感じだと、話しやすくなると思いますよ！",
        "「なんで」って言われると、ちょっと責められてる感じになっちゃうかもです。「きっかけを教えてもらっていい？」だと答えやすいかもですね！",
        "「なんで」より「どういう判断だったか聞かせて？」の方が、相手の方も落ち着いて話せると思いますよ〜！",
    ],
    "common_sense_push": [
        "「普通は」って言うと、ちょっとプレッシャーになっちゃうかもです〜。「こういうやり方もあるんだけど、どう思う？」って聞いてみるのはどうですかね？",
        "「普通」って言葉、ちょっと窮屈に感じちゃうかもです。「こんな方法もあるよ〜」って提案する形だと受け入れやすいと思います！",
    ],
    "pressure": [
        "急かす感じだと、焦っちゃうかもです〜。「いつまでにどこまで」を一緒に決めてあげると、安心して動けると思いますよ！",
        "スピード感も大事ですけど、「困ってることがあれば一緒に解決しよう」って言ってあげると、逆に早く動けるようになるかもですね！",
    ],
    "denial": [
        "否定から入ると、ちょっとへこんじゃうかもです〜。「ここは良かったよ、あとここだけ直そう」って分けて伝えるのはどうですかね？",
        "ダメ出しだけだと辛いかもです〜。良いところも一緒に伝えてあげると、改善に前向きになれると思いますよ！",
    ],
    "repetition_blame": [
        "「何回も」って言われると、すごく落ち込んじゃうかもです〜。「どの手順で引っかかってるか」を一緒に確認するのはどうですかね？きっと根本から解決できますよ！",
        "繰り返しの指摘って、相手の方はかなり辛いかもです。「再発防止の仕組みを一緒に考えよう」に切り替えると建設的に進められると思います！",
    ],
    "vague_demand": [
        "「ちゃんとして」だと、何をすればいいか分からなくて不安になっちゃうかもです〜。「ここだけ気をつけて」って具体的に伝えてあげると動きやすいと思いますよ！",
        "曖昧な指示だと戸惑っちゃうかもです〜。「具体的にはこの3つを押さえてほしい」って言ってあげると安心できると思います！",
    ],
    "disappointment": [
        "「がっかり」って言われると、すごく辛いかもです〜。「期待してるからこそ、次はこうしてほしいな」って未来に向けて伝えてみるのはどうですかね？",
        "失望の気持ちを伝えるより、「次にどうしてほしいか」を具体的に言ってあげた方が、前向きに動けると思いますよ〜！",
    ],
    "sigh_tone": [
        "ため息っぽい感じだと、「怒ってるのかな」って不安になっちゃうかもです〜。穏やかな声で「一緒に考えよう」って言ってあげるだけで、すごく安心できると思いますよ！",
        "呆れた感じが伝わっちゃうと、相手の方が委縮しちゃうかもです。冷静なトーンで具体的に伝えてみてくださいね〜！",
    ],
}

META_NOTES = {
    "personal_attack": {
        "perfectionist": "このタイプは能力の否定を、存在そのものの否定と受け取りやすい傾向があります",
        "logical": "このタイプは根拠のない人格評価に反発し、話を聞かなくなる傾向があります",
        "sensitive": "このタイプは人格への言葉で強く傷つき、その後の話が入らなくなる傾向があります",
        "independent": "このタイプは能力を疑う言葉に、信頼を失ったと感じて距離を取る傾向があります",
    },
    "accusatory_why": {
        "perfectionist": "このタイプは「なぜ」と問われると「自分が無能だから」と自責に向かう傾向があります",
        "logical": "このタイプは感情的な追及と受け取り、論理的な対話ができなくなる傾向があります",
        "sensitive": "このタイプは「なぜ」を「怒られている」と感じフリーズする傾向があります",
        "independent": "このタイプは「なぜ」を自分の判断への不信と受け取り、説明に終始する傾向があります",
    },
    "common_sense_push": {
        "perfectionist": "このタイプは「普通もできない自分」と全否定に向かう傾向があります",
        "logical": "このタイプは論理的根拠のない主張に反発し、対話が止まる傾向があります",
        "sensitive": "このタイプは「自分だけがおかしい」と孤立感を覚える傾向があります",
        "independent": "このタイプは「普通は」を、やり方の否定と受け取り反発する傾向があります",
    },
    "pressure": {
        "perfectionist": "このタイプは急かされると「完璧にしなきゃ」と焦り、ミスが増える傾向があります",
        "logical": "このタイプは急かす根拠が不明確だと期限設定自体に疑問を持つ傾向があります",
        "sensitive": "このタイプはパニックになって思考停止してしまう傾向があります",
        "independent": "このタイプは急かしを「信頼されていない」と受け取り、意欲が下がる傾向があります",
    },
    "denial": {
        "perfectionist": "このタイプは部分的な否定を人格全体の否定として受け取る傾向があります",
        "logical": "このタイプは主観的な評価に不信感を持つ傾向があります",
        "sensitive": "このタイプは否定が続くと「見放された」と感じる傾向があります",
        "independent": "このタイプは否定を、任されていたことの取り上げと受け取る傾向があります",
    },
    "repetition_blame": {
        "perfectionist": "このタイプは「自分は学べない人間だ」と自責に直結する傾向があります",
        "logical": "このタイプは感情的な繰り返し指摘を「非論理的」と受け取り壁を作る傾向があります",
        "sensitive": "このタイプは「自分はダメな人間だ」と思い込む傾向があります",
        "independent": "このタイプは繰り返しの指摘を、管理されていると感じて壁を作る傾向があります",
    },
    "vague_demand": {
        "perfectionist": "このタイプは基準が不明確だと「何をしても足りない」と不安が膨らむ傾向があります",
        "logical": "このタイプは曖昧な指示から目的を読み取れずストレスを感じる傾向があります",
        "sensitive": "このタイプは「今の自分じゃダメ」と自己否定につながる傾向があります",
        "independent": "このタイプは曖昧な要求に、自分の基準で進めてずれが大きくなる傾向があります",
    },
    "disappointment": {
        "perfectionist": "このタイプは「期待に応えられない自分は無価値」と存在否定に至る傾向があります",
        "logical": "このタイプは感情的な表現から改善点を読み取れず困惑する傾向があります",
        "sensitive": "このタイプは「自分のせいで悲しませた」と罪悪感に押しつぶされる傾向があります",
        "independent": "このタイプは失望の言葉を「もう任せてもらえない」と受け取る傾向があります",
    },
    "sigh_tone": {
        "perfectionist": "このタイプは「呆れられている、見捨てられる」と感じて萎縮する傾向があります",
        "logical": "このタイプは感情的な態度に壁を作り、コミュニケーションが断絶する傾向があります",
        "sensitive": "このタイプはため息や呆れた態度で「怒っている」と感じフリーズする傾向があります",
        "independent": "このタイプは呆れた態度に、自分のやり方を否定されたと感じる傾向があります",
    },
}


# 同じ言い方でも性格タイプによって響き方が違うため、カテゴリごとに基本スコアを補正する
TYPE_WEIGHTS = {
    "perfectionist": {"personal_attack": 1, "accusatory_why": 2, "repetition_blame": 1, "disappointment": 2, "denial": 1,
                      "vague_demand": 1, "common_sense_push": 0, "pressure": 0, "sigh_tone": 0},
    "logical": {"personal_attack": 0, "accusatory_why": -1, "repetition_blame": 0, "disappointment": -1, "denial": 0,
                "vague_demand": 2, "common_sense_push": 2, "pressure": -1, "sigh_tone": 0},
    "sensitive": {"personal_attack": 1, "accusatory_why": 1, "repetition_blame": 1, "disappointment": 1, "denial": 2,
                  "vague_demand": 0, "common_sense_push": 0, "pressure": 2, "sigh_tone": 2},
    "independent": {"personal_attack": 1, "accusatory_why": 0, "repetition_blame": 1, "disappointment": 0, "denial": 1,
                    "vague_demand": 1, "common_sense_push": 2, "pressure": 1, "sigh_tone": 1},
}

# 面談の状況。介入のしきい値の増減と、特に気をつける言い方の重み
SITUATIONS = {
    "progress": {"label": "進捗の確認", "threshold": 0, "weights": {"pressure": 1, "vague_demand": 1},
                 "prompt": "仕事の進み具合を確認する面談。事実の確認を優先し、急かしや曖昧な要求に注意する"},
    "feedback": {"label": "指摘とフォロー", "threshold": -1,
                 "weights": {"denial": 1, "repetition_blame": 1, "disappointment": 1, "accusatory_why": 1, "personal_attack": 1},
                 "prompt": "上司が改善点を伝える面談。指摘の中身は消さず、部下が自己否定せず受け取れるように整える"},
    "goal": {"label": "目標の設定", "threshold": 0, "weights": {"vague_demand": 1, "common_sense_push": 1},
             "prompt": "これからの目標を決める面談。期待の基準が曖昧なままにならないよう注意する"},
    "casual": {"label": "雑談・相談", "threshold": 1, "weights": {},
               "prompt": "部下の話を聞く面談。会話の流れを止めないよう、はっきりした場合だけ介入する"},
}

CATEGORY_EXAMPLES = {
    "personal_attack": "「使えないな」「向いてないよ」",
    "accusatory_why": "「なんで〜しなかったの？」",
    "common_sense_push": "「普通はこうするでしょ」",
    "pressure": "「いつまでかかってるの」",
    "denial": "「全然できてないじゃん」",
    "repetition_blame": "「何回言ったらわかるの」",
    "vague_demand": "「もっとちゃんとやって」",
    "disappointment": "「期待してたのに残念だよ」",
    "sigh_tone": "「はぁ…もういいよ」",
}

# 4つの傾向を6問ずつ（うち1問は逆の聞き方）。上司が答える文（boss）と、部下本人が答える文（self）
PROFILE_QUESTIONS = [
    {"id": "q1", "dim": "perfectionist", "boss": "ミスをすると、必要以上に自分を責めているように見える", "self": "ミスをすると、必要以上に自分を責めてしまう", "reverse": False},
    {"id": "q2", "dim": "logical", "boss": "指示を受けると「なぜそうするのか」理由や根拠を確認したがる", "self": "指示を受けると、理由や根拠を確認したくなる", "reverse": False},
    {"id": "q3", "dim": "sensitive", "boss": "こちらの声のトーンや表情の変化に敏感に反応する", "self": "相手の声のトーンや表情の変化が気になる", "reverse": False},
    {"id": "q4", "dim": "independent", "boss": "細かく指示されると、やる気が下がっているように見える", "self": "細かく指示されると、やる気が下がる", "reverse": False},
    {"id": "q5", "dim": "perfectionist", "boss": "仕事の完成度にこだわり、なかなか「できました」と言わない", "self": "完成度が気になって、なかなか「できました」と言えない", "reverse": False},
    {"id": "q6", "dim": "logical", "boss": "気持ちに訴えるより、事実やデータで話すと納得しやすい", "self": "気持ちより、事実やデータで話してもらうほうが納得できる", "reverse": False},
    {"id": "q7", "dim": "sensitive", "boss": "強めに指摘されると、黙り込んだり固まったりする", "self": "強めに指摘されると、頭が真っ白になったり固まったりする", "reverse": False},
    {"id": "q8", "dim": "independent", "boss": "やり方を任されると、生き生きと動く", "self": "やり方を任されると、力を発揮しやすい", "reverse": False},
    {"id": "q9", "dim": "perfectionist", "boss": "指摘を受けると「自分はダメだ」と受け止めているように見える", "self": "指摘を受けると「自分はダメだ」と感じやすい", "reverse": False},
    {"id": "q10", "dim": "logical", "boss": "曖昧な指示だと、動き出しが遅くなったり質問が増えたりする", "self": "曖昧な指示だと、動き出す前に確認したくなる", "reverse": False},
    {"id": "q11", "dim": "sensitive", "boss": "ため息や沈黙を「怒っている」と受け取りやすい", "self": "相手のため息や沈黙を「怒っている」と感じやすい", "reverse": False},
    {"id": "q12", "dim": "independent", "boss": "進め方に口を出されると、「信頼されていない」と受け取っているように見える", "self": "進め方に口を出されると、「信頼されていない」と感じる", "reverse": False},
    {"id": "q13", "dim": "perfectionist", "boss": "困っていても、自分で何とかしようとして相談が遅れがち", "self": "困っても、自分で何とかしようとして相談が遅れがち", "reverse": False},
    {"id": "q14", "dim": "logical", "boss": "納得できない指摘には、言い返したり黙り込んだりする", "self": "納得できない指摘には、反論したくなったり黙ってしまったりする", "reverse": False},
    {"id": "q15", "dim": "sensitive", "boss": "謝罪の言葉が多い", "self": "つい謝ってしまうことが多い", "reverse": False},
    {"id": "q16", "dim": "independent", "boss": "自分の考えたやり方を、なかなか変えようとしない", "self": "自分の考えたやり方を、なかなか変えたくない", "reverse": False},
    {"id": "q17", "dim": "perfectionist", "boss": "褒められても「まだまだです」と素直に受け取らないことが多い", "self": "褒められても素直に受け取れないことが多い", "reverse": False},
    {"id": "q18", "dim": "logical", "boss": "「普通は」「常識的に」と言われると、引っかかっているように見える", "self": "「普通は」「常識的に」と言われると引っかかる", "reverse": False},
    {"id": "q19", "dim": "sensitive", "boss": "面談の後も、言われたことを長く引きずっているように見える", "self": "言われたことを、あとまで長く引きずってしまう", "reverse": False},
    {"id": "q20", "dim": "independent", "boss": "自分で決めたことは、最後までやり切ろうとする", "self": "自分で決めたことは、最後までやり切りたい", "reverse": False},
    {"id": "q21", "dim": "perfectionist", "boss": "失敗しても、すぐに気持ちを切り替えて次に進めている", "self": "失敗しても、すぐに気持ちを切り替えられる", "reverse": True},
    {"id": "q22", "dim": "logical", "boss": "理由を聞かずに、言われたとおりに進めることが多い", "self": "理由を聞かずに、言われたとおりに進めることが多い", "reverse": True},
    {"id": "q23", "dim": "sensitive", "boss": "厳しい言い方をされても、落ち着いて話を続けられる", "self": "厳しい言い方をされても、落ち着いて話を続けられる", "reverse": True},
    {"id": "q24", "dim": "independent", "boss": "細かく確認してもらえるほうが、安心して進められるように見える", "self": "細かく確認してもらえるほうが、安心して進められる", "reverse": True},
]

TYPE_KEYS = ["perfectionist", "logical", "sensitive", "independent"]
DIM_LABELS = {"perfectionist": "自分を責める傾向", "logical": "根拠・納得を求める傾向", "sensitive": "口調や空気への敏感さ", "independent": "自分で決めたい傾向"}


# 部下の発言に出る「萎縮のサイン」。介入はせず、上司向けに画面だけでヒントを出す
SUBORDINATE_SIGNALS = [
    {
        "id": "self_blame",
        "label": "自分を責める言葉",
        "title": "自分を責めなくて大丈夫",
        "patterns": [
            r"(?:私|僕|自分|わたし|ぼく|俺)(?:が|の)(?:せい|責任|ダメ|だめ|悪い|悪かった|悪く|力不足)",
            r"(?:私|僕|自分|わたし|ぼく|俺)の.{0,8}(?:が悪くて|が悪かった|が甘かった|が足りなくて|が足りなかった)",
            r"(?:向いて(?:い)?ない|力不足|能力が(?:足りない|ない))",
            r"ダメ(?:な|だ)(?:人間|やつ|奴)",
            # 「どうせなら」「何をやっても楽しい」は自己否定ではない。後ろに否定的な言葉が続くときだけ拾う
            r"どうせ(?!なら|だったら|ついで|だから).{0,12}?(?:無理|ダメ|だめ|できない|変わらない|無駄|むだ|ムダ|私|僕|自分|わたし|ぼく|俺|怒られ)",
            r"(?:何をやっても|なにをやっても).{0,10}?(?:うまくいかない|ダメ|だめ|無駄|変わらない|怒られ|足りない|できない|同じ)",
            r"(?:私|僕|自分|わたし|ぼく|俺)(?:は|って|なんて|なんか)(?:ダメ|だめ|無能|使えない|できない|役に立たない|向いて|バカ|馬鹿|情けない)",
            r"(?:仕事が|何も|なにも|全然|ぜんぜん)(?:できない|出来ない)(?:人間|やつ|奴|です|だ)",
            r"(?:情けない|ふがいない)", r"自分(?:が|に|を)(?:嫌|いや)に(?:なる|なり|なって|なっ)", r"(?:お)?役に立てて(?:い)?ない|(?:お)?役に立てなく|(?:お)?役に立てず",
            r"(?:自分でも|私も|僕も)[^。、]{0,8}(?:ダメ|だめ|できてない|出来てない|足りてない|不甲斐ない)",
            r"(?:私|僕|自分|わたし|ぼく|俺)(?:が|の)(?:全部|ぜんぶ|すべて|みんな)(?:悪|せい|責任|力不足|ダメ)",
            r"(?:私|僕|自分|わたし|ぼく|俺)(?:は|って|には|なんて|なんか|が)?[^。]{0,14}(?:能力|実力|才能|センス|経験|スキル|適性)(?:が|も)?(?:足りな|ない|なくて|不足|欠け)",
            r"(?:私|僕|自分|わたし|ぼく|俺)が足を引っ張",
            r"(?:迷惑|ご迷惑)を?(?:ばかり|ばっかり|かけてばかり|かけてばっかり)",
            r"自分(?:に|には)?(?:は)?(?:自信|価値|存在意義|居場所)(?:が|も)?(?:ない|なくて|ありません|持てない|持てません)",
            r"(?:私|僕|自分)(?:なんか|なんて)が[^。]{0,10}(?:いいのでしょうか|いいんでしょうか|いていい|資格|任せ)",
            r"自分(?:が|を)(?:許せ|責め|恥ずかし|嫌い|憎)|自分(?:に|が)(?:腹が立|腹立|嫌気|イライラ)",
            r"(?:どうして|なんで)(?:私|僕|自分)は(?:こう|こんな|いつも|いつまでも)",
            r"(?:私|僕|自分)が(?:もっと)?(?:しっかり|ちゃんと|早く|気をつけて|頑張って)(?:して|し)?(?:いれば|いたら|いたなら|おけば|いなければ)",
            r"(?:私|僕|自分)(?:なんて|なんか|が)?[^。]{0,6}(?:いてもいなくても|いなくても|いる意味|いる価値)",
            r"(?:私|僕|自分)(?:には|は)?荷が重(?:すぎ|い|かっ)",
            r"(?:この仕事|仕事|自分)(?:は|に|には)?[^。]{0,8}向(?:か|い)(?:ない|なかった|てない|ないのかな)",
            r"(?:私|僕|自分)(?:って|は)?[^。]{0,6}学習(?:しない|できない|能力がない)",
            r"(?:私|僕|自分)の(?:理解|準備|確認|考え|詰め|見通し|段取り)(?:が|も)?(?:足りなく|足りない|甘く|甘かった|不足)",
            r"(?:私|僕|自分)[^。]{0,16}(?:迷惑|邪魔|足手まとい)(?:です|でしょう|ですよね|だと思|になって|でしかない|なだけ)",
            r"自分の(?:不甲斐な|情けな|ふがいな|至らな|未熟|能力のな|力のな|無力)(?:さ|い)",
            r"(?:こんな|こういう)(?:私|僕|自分)(?:が|で)[^。]{0,10}(?:恥ずかし|情けな|申し訳|資格)",
            r"(?:私|僕|自分)が(?:至らない|未熟|不甲斐ない|力不足)(?:ばかりに|せいで|ために)",
            r"(?:もっと)?(?:自分|私|僕)に(?:力|能力|実力|経験)が(?:あれば|あったら|あったなら)",
            r"(?:ダメ|だめ|駄目)な(?:自分|私|僕)",
            r"(?:私|僕|自分)(?:なんか|なんて)(?:に|には|が)?[^。]{0,6}(?:務まら|できません|無理|向いて|荷が重)",
            r"(?:情けなく|不甲斐なく|恥ずかしく|惨めに)(?:なり|なって|なる)|(?:惨め|みじめ)(?:です|だ)",
            r"自分(?:の)?(?:ダメ|だめ)さ",
            r"(?:私|僕|自分|わたし|ぼく)(?:は|って|なんて|なんか)?(?:いつも|ずっと|本当に|ほんとに)?(?:足手まとい|落ちこぼれ|お荷物|ポンコツ|出来損ない|ダメ人間|だめ人間)",
            r"(?:何を|なにを)やっても(?:空回り|うまくいかな|ダメ|だめ|失敗|中途半端|続かな)",
            r"(?:ダメ|だめ|できてない|出来てない|足りてない)(?:だ)?(?:と|って)自分(?:でも|で)(?:も)?(?:思|感じ|分かって)",
        ],
        "hint": "部下さんが自分を責める言葉を使っています。まず「話してくれてありがとう」と受け止めてから、事実の話に戻すと安心しやすいです。",
        "forecast": {"perfectionist": "自分を責めているかも", "logical": "結論を急いでいるかも", "sensitive": "気持ちが沈んでいるかも", "independent": "結論を急いでいるかも"},
        "reframe": "起きたことと、自分の評価は分けて見てみませんか？",
    },
    {
        "id": "give_up",
        "label": "あきらめの言葉",
        "title": "全部じゃなくて大丈夫",
        "patterns": [
            r"(?:もう)?(?:無理|むり)(?:です|かも|だと|っす)",
            r"(?:わかりません|分かりません|できません|わからないです|分からないです)(?:\s*$|[。…])",
            r"(?:お手上げ|手詰まり|手が止まっ|頭が真っ白|いっぱいいっぱい|限界(?:です|かも|で|だ))",
            r"(?:何|どこ)から(?:手を)?(?:つけ|始め|やれ|やったら|やれば)[^。]{0,8}(?:分から|わから)",
            r"(?:行き詰ま|詰んで|手の打ちよう|打つ手|八方塞が)",
            r"(?:続け|やり)(?:られ|きれ)(?:そうに|そう)?(?:ない|ありません|ません)",
            r"(?:さっぱり|まったく|全く|もう)(?:分から|わから)(?:なく|ない|ません)",
            r"(?:何も|なにも)考えられ(?:ない|ません|なく)",
            r"(?:どうして|どうすれば|どうしたら)(?:いい|良い)(?:か|の)?(?:も)?(?:分から|わから)",
            r"どうにも(?:ならな|なりませ|できな)",
            r"(?:何を|どう)[^。]{0,8}(?:いい|良い)のか(?:全く|まったく|さっぱり)?(?:見え|分から|わから)",
            r"(?:もう|これ以上|自分では)[^。]{0,6}(?:対応|処理|消化|こなし)(?:しきれ|できな|きれな)",
            r"(?:詰み|詰んだ|詰んで)(?:ました|だ|です)?|手も足も出(?:ません|ない)",
            r"できる気(?:が)?(?:しません|しない)",
            r"(?:無理|むり)(?:そう|っぽい)(?:です|だ)",
        ],
        "hint": "「わからない」「無理」は、手が止まっているサインかもしれません。どこまでは分かっているかを一緒に区切ると動きやすくなります。",
        "forecast": {"perfectionist": "手が止まっているかも", "logical": "情報が足りないのかも", "sensitive": "固まっているかも", "independent": "納得できていないのかも"},
        "reframe": "分かっているところまで、一緒に区切ってみませんか？",
    },
    {
        "id": "over_apology",
        "label": "謝罪が続いている",
        "title": "何度も謝らなくて大丈夫",
        "patterns": [r"(?:すみません|すいません|申し訳(?:ない|ありません|ございません)|ごめんなさい)"],
        "repeat": 2,   # 直近3回の部下の発言のうち2回以上で出たときだけ
        "hint": "謝罪が続いています。責めていないことを一言伝えると、次の言葉が出やすくなります。",
        "forecast": {"perfectionist": "身構えているかも", "logical": "身構えているかも", "sensitive": "身構えているかも", "independent": "身構えているかも"},
        "reframe": "責められているわけではないと思います。続きを聞かせてください。",
    },
    {
        "id": "comparison",
        "label": "人と比べている言葉",
        "title": "比べなくて大丈夫",
        "patterns": [
            r"(?:同期|周り|まわり|みんな|皆|他の人|ほかの人|後輩|先輩|[^\s、。]{1,3}さん)(?:は|が|の方が|のほうが)[^。]{0,14}(?:できる|できている|できて|優秀|早い|進んで|すごい)(?:のに|けど|けれど)[^。]{0,12}(?:私|僕|自分|わたし|ぼく)",
            r"(?:私|僕|自分|わたし|ぼく)だけ(?:が)?[^。、]{0,6}(?:できない|できてない|できていません|出来ていない|遅れて|取り残され|ついていけ|分からない|わからない|ダメ)",
            r"(?:他の人|ほかの人|周り|同期|みんな|皆|[^\s、。]{1,3}さん)(?:に|と)比べ(?:て|ると)[^。]{0,8}(?:私|僕|自分|わたし|ぼく)(?:は|って|なんて)[^。]{0,10}(?:ダメ|だめ|劣|足りな|できな|情けな|遅|全然)",
            r"(?:みんな|皆)は[^。]{0,10}(?:のに|けど)[^。]{0,8}(?:私|僕|自分)(?:は|だけ)",
            r"(?:他の|ほかの|周りの|まわりの|隣の|同期の|チームの)[^。、]{0,8}(?:メンバー|人|方|席の人|同期|皆さん|みなさん)(?:は|が|の方が|のほうが)[^。]{0,16}(?:のに|けど|けれど)[、,]?[^。]{0,6}(?:私|僕|自分)(?:は|だけ|が)",
            r"(?:同期|チーム|周り|みんな|皆)(?:の中)?で(?:私|僕|自分)だけ",
            r"(?:後輩|同期|同僚|先輩|周り)(?:の方|のほう)が[^。]{0,10}(?:優秀|できる|上|すごい)[^。]{0,8}(?:自分|私|僕)(?:が|は)",
            r"(?:比べると|比べて)[、,]?(?:自分|私|僕)(?:は|なんて)",
            r"(?:のに|けど)[、,]?(?:私|僕|自分)(?:は|だけ)[^。]{0,8}(?:遅|劣|ダメ|だめ|何も|できて|できない|全然)",
        ],
        "hint": "部下さんが周りと比べて自分を低く見ています。できていることを一つ挙げて、その人のペースを認めると安心しやすいです。",
        "forecast": {"perfectionist": "焦っているかも", "logical": "基準を知りたいのかも", "sensitive": "孤立を感じているかも", "independent": "自分のやり方を見失っているかも"},
        "reframe": "人と比べなくて大丈夫です。進んだところを見てみませんか？",
    },
    {
        "id": "distress",
        "label": "つらさの言葉",
        "title": "無理しなくて大丈夫",
        "patterns": [
            r"(?:つらい|辛い|しんどい)(?:です|んです|よ|ね|な|なあ|気持ち|と感じ|$|。|…|、)",
            r"(?:落ち込ん|凹ん|へこん|沈ん)(?:で|でい|でしま)(?:る|い|ます|います|いて|しま)",
            r"(?:眠れ|寝れ)(?:ない|なく|ません)",
            r"(?:朝|会社|職場|仕事)(?:に|へ)?[^。、]{0,6}(?:来る|行く)の(?:が|も)?(?:怖い|嫌|つらい|辛い|憂うつ|憂鬱)",
            r"(?:泣きそう|涙が出|涙が止まら|泣いてしまっ)",
            r"(?:心|気持ち)が(?:重い|苦しい|折れ|もたない)",
            r"(?:胸|心|気持ち)が(?:苦しく|苦しい|重たい|重たく|重く|締め付け|ざわざわ)",
            r"(?:憂鬱|憂うつ|ゆううつ)",
            r"つらく(?:感じ|なって|て|なる)",
            r"(?:もう|ほんとに|本当に|すっかり)?疲れ(?:て)?(?:しまいました|きって|果て|きっている)",
            r"(?:苦しい|しんどく)(?:です|んです|よ|…|$|。|て)",
            r"頭から離れ(?:なくて|ない|ません)[^。]{0,6}(?:苦し|つら|辛|しんど)",
            r"食欲が(?:ない|なく|出ない|わかない)|何も(?:楽しめ|楽しく|感じられ|面白く)(?:ない|ません|なく)",
            r"(?:夜中|夜|明け方)に(?:何度も)?(?:目が覚め|起き)(?:て|る|ます)|仕事のことばかり(?:考え|頭に)",
            r"(?:出勤|出社|会社|仕事)(?:前|のこと)[^。]{0,8}(?:お腹|胃|頭|胸)が(?:痛|重|苦し|締め付け)",
            r"(?:気分|気持ち)が(?:落ち|沈|晴れ)(?:て|ない|ません)",
            r"限界を感じ|涙もろく",
            r"(?:やる気|気力)が(?:出なく|出ない|出ません|わかなく|わかない)",
        ],
        "hint": "部下さんがつらさを話しています。励ましや解決策を急がず、「話してくれてありがとう」と受け止めると、次の言葉が出やすくなります。",
        "forecast": {"perfectionist": "一人で抱えているかも", "logical": "整理がつかないのかも", "sensitive": "気持ちが沈んでいるかも", "independent": "一人で抱えているかも"},
        "reframe": "無理に前向きにならなくて大丈夫です。話してくれてありがとう。",
    },
]


# 褒めない・出来事として拾わない側は広いまま（迷ったら慎重に）。拾う側（上の patterns）だけを絞った
SELF_NEG_ALL = [p for sig in SUBORDINATE_SIGNALS for p in sig["patterns"]] + [r"(?:どうせ|何をやっても|なにをやっても)"]

# ---- 自己否定かどうかの見分け（発注書 v14）。言葉が当たっても、次の場合は慰めない ----
FIRST_PERSON = r"(?:私|僕|自分|わたし|ぼく|俺)"
CLAUSE_SEP = re.compile(r"[、。，．,.!！?？…\s]+")
# 自分の価値・能力を決めつける言葉。責任の引き受け（「私のせい」）より重い
STRONG_SELF_WORDS = re.compile(r"迷惑|邪魔|不甲斐|情けな|惨め|みじめ|中途半端|至らな|未熟|無力|務まら|いてもいなくても|いる意味|いる価値|荷が重|向か(?:ない|なかった)|向(?:い)?てない|学習|足を引っ張|迷惑|自信|価値|才能|能力|実力|足手まとい|落ちこぼれ|お荷物|ポンコツ|許せ|恥ずかし|腹が立|嫌気|空回り|ダメ|だめ|無能|使えない|役に立た|役に立て|バカ|馬鹿|情けない|ふがいない|向いて|力不足|能力が|嫌|人間|どうせ.{0,12}?" + FIRST_PERSON)
# 他の人の話（「彼は向いてない」「お客様が情けない」）
THIRD_PERSON = re.compile(r"(?:彼|彼女|あの人|その人|お客様|お客さん|先方|相手|上司|部長|課長|先輩|同僚|後輩|みんな|皆|[^\s、。]{1,6}さん)(?:が|は|も|の)")
# 打ち消し（「私のせいではありません」「悪くない」）と、人から言われた話（「使えないと言われました」）
NEG_TAIL = re.compile(r"^(?:ん|の)?(?:じゃ|では)ない(?:の|か|かな|かい|？|\?)|^(?:では|じゃ|でも)(?:ない|ありません)|^(?:わけ|訳)(?:では|じゃ)|^(?:とは|とも)(?:思わ|言え|限ら)")
NEG_AFTER_KU = re.compile(r"^(?:ない|ありません|なかった)")
REPORTED_TAIL = re.compile(r"(?:と|って)(?:言われ|怒られ|指摘され|思われ|叱られ|注意され)")
# 責任を引き受けて次の行動まで言えている発言は、慰めずにそのまま聞く
FORWARD_PLAN = re.compile(r"(?:次(?:は|から|回は|回から)|今後は|これからは|再発防止|気をつけ|見直し|確認(?:し|を)|直し|改善|やり直)[^、。]{0,12}?(?:ます|ていく|たいです|つもり)|(?:対応|担当|修正|対処|処理|進め|引き受け|責任を持って)(?:し|いたし|させて)(?:ます|ていただ|てもらい)")
APOLOGY = re.compile(r"すみません|すいません|申し訳|ごめんなさい")
# 「明日までは無理です」は断り・調整であって、あきらめではない
LIMIT_BEFORE = re.compile(r"まで|今日|明日|今週|来週|今月|その日|日程|期限|予算|人手|時間的に|物理的に")


def _clause_bounds(text: str, pos: int) -> tuple[int, int]:
    start, end = 0, len(text)
    for m in CLAUSE_SEP.finditer(text):
        if m.end() <= pos:
            start = m.end()
        elif m.start() > pos:
            end = m.start()
            break
    return start, end


def self_blame_hits(text: str) -> list[str]:
    """自分を責める言葉のうち、慰める対象として数えるもの（当たった言葉のリスト）"""
    out = []
    for pat in SUBORDINATE_SIGNALS[0]["patterns"]:
        for m in re.finditer(pat, text):
            cs, ce = _clause_bounds(text, m.start())
            ev, tail, clause = m.group(0), text[m.end():ce], text[cs:ce]
            if NEG_TAIL.search(tail) or (ev.endswith("く") and NEG_AFTER_KU.search(tail)):
                continue
            if REPORTED_TAIL.search(tail):
                continue
            if not re.search(FIRST_PERSON, ev) and THIRD_PERSON.search(clause) and not re.search(FIRST_PERSON, clause):
                continue
            out.append(ev)
            break
    return out


POLITE = re.compile(r"です|ます|まし[たて]|でした|でしょう|ません|ございま|ください")


def judge_self_blame(text: str, recent_texts: list[str], any_mode: bool = False) -> dict | None:
    """自己否定として慰めるか。strength: strong（声でも話しかけてよい）/ normal（画面だけ）
    any_mode＝話者を分けない設定。上司の「責任は僕にあるよ」を部下の自己否定と取り違えないよう、
    責任の引き受けだけの発言は、丁寧な言い方か謝罪があるときだけ拾う"""
    evidence = self_blame_hits(text)
    if not evidence:
        return None
    strong = any(STRONG_SELF_WORDS.search(e) for e in evidence)
    if not strong and FORWARD_PLAN.search(text):
        return None
    if any_mode and not strong and not (POLITE.search(text) or APOLOGY.search(text)):
        return None
    # 責任の引き受けだけでは画面止まり。謝罪が重なる・直前にも出ていたときは、つらさが続いているとみて声も許す
    if not strong and (APOLOGY.search(text) or any(self_blame_hits(t) for t in recent_texts[-2:])):
        strong = True
    return {"strength": "strong" if strong else "normal", "evidence": evidence}


def give_up_hit(text: str) -> bool:
    for pat in next(s for s in SUBORDINATE_SIGNALS if s["id"] == "give_up")["patterns"]:
        for m in re.finditer(pat, text):
            cs, _ = _clause_bounds(text, m.start())
            if not LIMIT_BEFORE.search(text[cs:m.start()]):
                return True
    return False
FILLER_CLAUSE = re.compile(r"^(?:はい|ええ|あの|えっと|その|いえ|でも|ただ|なので|それで|本当に|ほんとに|もう)$")
SUB_CLAUSE_SPLIT = r"[、。，．,.!！?？…\s]+|けど|けれど|ので"


def find_event_clause(text: str) -> str | None:
    """自己否定の発言から「起きたこと」の節を取り出す（例：「資料の提出が遅れました」）。取れなければ None"""
    clauses = [c.strip() for c in re.split(SUB_CLAUSE_SPLIT, text) if c and c.strip()]
    events = []
    for c in clauses:
        # 「私がダメで遅れてしまいました」のように同じ節にある時は、自己否定の部分を外して出来事だけ残す
        c = re.sub(r"^.*?(?:せいで|ダメで|だめで|悪くて|力不足で|が足りなくて|が甘くて)", "", c)
        if not c or FILLER_CLAUSE.match(c) or any(re.search(p, c) for p in SELF_NEG_ALL):
            continue
        # 上司の行為（怒られた・言われた）は部下の出来事として言い直させない（レビュー指摘7）
        if re.search(r"(?:られ|われ|され)ました$|上司|部長|課長|先輩", c):
            continue
        # 活用は変えずに、元の言い方のまま引用する（「怒ってしまいました」を壊さない。レビュー指摘4）
        if 4 <= len(c) <= 18 and c.endswith(("ました", "でした", "ませんでした")):
            events.append(c)
    return events[0] if events else None


OBJECTIVE_QUESTIONS = [
    "それは起きた事実ですか？それとも、自分への評価ですか？",
    "同じことを同僚がしたら、何と声をかけますか？",
    "この出来事から、次に変えられることは何ですか？",
]


# 部下の傾向に合わせたフォロー（発注書 v15）。傾向の言葉は口にも画面にも出さない。効果は未検証（これから検証）
# self_blame：event=出来事が取れた時の文（{e}に出来事）／plain=取れない時の文／questions=問い／voice=声（40字以内・固定）
SELF_BLAME_STYLE = {
    "perfectionist": {  # 自責が全否定に向かいやすい → できていることも一緒に見る
        "event": "「{e}」は起きたことで、あなたの価値とは別です。できているところも一緒に見てみましょう。",
        "plain": "起きたことと、自分への評価は分けて大丈夫です。できているところも一緒に見てみましょう。",
        "questions": ["それは起きた事実ですか？それとも、自分への評価ですか？",
                      "同じことを同僚がしたら、何と声をかけますか？",
                      "今回、できていたことは何ですか？"],
        "voice": "十分やれているところもあります。起きたことと評価を分けて見ましょう。",
    },
    "logical": {  # 根拠・納得を求める → 評価の根拠を事実で確かめる
        "event": "「{e}」は起きたことです。そこから「自分がだめ」と言える根拠があるか、事実で確かめてみましょう。",
        "plain": "「自分がだめ」と言える根拠があるか、起きたことだけを並べて確かめてみましょう。",
        "questions": ["その評価の根拠になる事実は、何ですか？",
                      "事実だけを並べると、何が起きていましたか？",
                      "この出来事で、変えられることはどこですか？"],
        "voice": "その評価の根拠を、事実で確かめましょう。起きたことは何でしたか？",
    },
    "sensitive": {  # 空気に敏感で「見放された」と感じやすい → まず責めていないことを伝える
        "event": "ここで責めてはいません。「{e}」は起きたことで、あなたの価値とは別です。",
        "plain": "ここで責めてはいません。起きたことと、自分への評価は分けて大丈夫です。",
        "questions": ["今、いちばん気になっているのは何ですか？",
                      "それは起きた事実ですか？それとも、そう感じている気持ちですか？",
                      "同じことを同僚がしたら、何と声をかけますか？"],
        "voice": "私は責めていません。起きたことだけ、いっしょに整理しましょう。",
    },
    "independent": {  # 自分で決めたい → 次の一手を本人に選んでもらう
        "event": "「{e}」は起きたことで、あなたの価値とは別です。次にどうするかは、あなたが決められます。",
        "plain": "起きたことと、自分への評価は分けて大丈夫です。次にどうするかは、あなたが決められます。",
        "questions": ["次に変えるなら、自分ならどうしますか？",
                      "起きたことと評価、どちらから整理しますか？",
                      "次の一手を自分で決めるとしたら、何ですか？"],
        "voice": "次にどうするかは、あなたが決められます。まず起きたことを整理しましょう。",
    },
}
DEFAULT_SELF_BLAME_STYLE = {
    "event": "「{e}」は起きたことで、あなたの価値とは別です。事実と評価を分けて見てみましょう。",
    "plain": "起きたことと、自分への評価は分けて大丈夫です。事実と評価を分けて見てみましょう。",
    "questions": OBJECTIVE_QUESTIONS,
    "voice": "自分を責めなくて大丈夫です。起きたことと、自分への評価を分けて見てみましょう。",
}
GIVE_UP_STYLE = {
    "perfectionist": ("全部できていなくて大丈夫です。できている所まで、先に伝えてみませんか？", "「〇〇まではできています。△△で止まっています」"),
    "logical": ("分からない所を、足りない情報や条件として切り分けてみませんか？", "「〇〇は分かっています。△△の情報があれば進められます」"),
    "sensitive": ("聞いても大丈夫です。分からない所を一つだけ伝えてみませんか？", "「〇〇までは分かりました。△△だけ教えてもらえますか？」"),
    "independent": ("どこから自分で進めたいか、決めて伝えてみませんか？", "「〇〇は自分で進めます。△△だけ相談させてください」"),
}
OVER_APOLOGY_STYLE = {
    "perfectionist": ("何度も謝らなくて大丈夫です。できていることを一つ伝えてみませんか？", "「〇〇はできています。次は△△します」"),
    "logical": ("謝るより、原因と次の対策を一つ伝えるほうが伝わります。", "「原因は〇〇です。次は△△します」"),
    "sensitive": ("何度も謝らなくて大丈夫です。気になっていることを一つ聞いてみませんか？", "「〇〇が気になっています。教えてもらえますか？」"),
    "independent": ("謝らなくて大丈夫です。次に自分で決めることを一つ伝えてみませんか？", "「次は〇〇を自分で進めます」"),
}


COMPARISON_STYLE = {
    "perfectionist": ("人と比べなくて大丈夫です。自分が進めたところを、一つ見てみましょう。", "「〇〇までは進めました。次の課題は△△です」"),
    "logical": ("人と自分では、経験や条件が違います。比べる基準を、事実で確かめてみませんか？", "「〇〇さんとは経験年数が違うので、今の目標は△△にします」"),
    "sensitive": ("ここでは誰とも比べていません。あなたのペースで大丈夫です。", "「私のペースだと、〇〇まで進められています」"),
    "independent": ("人と同じ進め方でなくて大丈夫です。自分のやり方で進める所を決めてみませんか？", "「〇〇は自分のやり方で進めます。△△だけ相談します」"),
}
DISTRESS_STYLE = {
    "perfectionist": ("無理に頑張らなくて大丈夫です。つらい気持ちは、そのまま話して大丈夫です。", "「今、〇〇でつらいです。少し話を聞いてもらえますか」"),
    "logical": ("つらさの中で、いちばん重いものを、一つだけ言葉にしてみませんか？", "「いちばん重いのは〇〇です」"),
    "sensitive": ("ここでは責めていません。つらい気持ちを、話せる分だけで大丈夫です。", "「今は〇〇でつらいです。少し休みたいです」"),
    "independent": ("つらいときは、どうしたいかを自分で決めて大丈夫です。話す・休む、どちらでもいいです。", "「今は〇〇したいです」"),
}


def self_blame_style(type_key: str | None) -> dict:
    return SELF_BLAME_STYLE.get(type_key or "", DEFAULT_SELF_BLAME_STYLE)


def self_rewrite(sig_id: str, text: str, evidence: list[str] | None = None, type_key: str | None = None) -> dict:
    """自己否定の発言を、自分を客観視する手がかりに変える（画面だけに出す）。傾向があれば言い回しを合わせる。
    objective: 起きたこと / いま浮かんでいる評価の言葉 / 問い / 言い直しの例"""
    event = find_event_clause(text)
    judgement = ""
    if sig_id == "self_blame":
        style = self_blame_style(type_key)
        judgement = (evidence or self_blame_hits(text) or [""])[0]
        question = pick(style["questions"], text)
        if event:
            return {"rewrite": style["event"].format(e=event),
                    "rewrite_example": f"「{event}。次は〇〇します」",
                    "voice": style["voice"],
                    "objective": {"fact": event, "judgement": judgement, "question": question}}
        return {"rewrite": style["plain"],
                "rewrite_example": "「〇〇が起きました。次は△△します」",
                "voice": style["voice"],
                "objective": {"fact": "", "judgement": judgement, "question": question}}
    if sig_id == "give_up":
        rw, ex = GIVE_UP_STYLE.get(type_key or "", ("全部じゃなくて大丈夫です。分かっている所と、分からない所を分けて伝えてみませんか？",
                                                   "「〇〇までは分かっています。△△の所を教えてもらえますか？」"))
        return {"rewrite": rw, "rewrite_example": ex}
    if sig_id == "comparison":
        rw, ex = COMPARISON_STYLE.get(type_key or "", ("人と比べなくて大丈夫です。自分が進めたところを、一つ見てみましょう。", "「〇〇までは進めました。次の課題は△△です」"))
        return {"rewrite": rw, "rewrite_example": ex}
    if sig_id == "distress":
        rw, ex = DISTRESS_STYLE.get(type_key or "", ("無理に頑張らなくて大丈夫です。つらい気持ちは、そのまま話して大丈夫です。", "「今、〇〇でつらいです。少し話を聞いてもらえますか」"))
        return {"rewrite": rw, "rewrite_example": ex}
    if sig_id == "over_apology":
        rw, ex = OVER_APOLOGY_STYLE.get(type_key or "", ("何度も謝らなくて大丈夫です。これからすることを一つ伝えてみませんか？",
                                                        "「ご指摘ありがとうございます。次は〇〇します」"))
        return {"rewrite": rw, "rewrite_example": ex}
    return {"rewrite": "", "rewrite_example": ""}


def signal_matches(sig: dict, text: str) -> bool:
    """つらさ・人と比べる言葉は、他の人の話（「彼は憂鬱そうだった」）なら拾わない"""
    for pat in sig["patterns"]:
        for m in re.finditer(pat, text):
            if sig["id"] not in ("distress", "comparison"):
                return True
            cs, ce = _clause_bounds(text, m.start())
            clause = text[cs:ce]
            if THIRD_PERSON.search(clause) and not re.search(FIRST_PERSON, clause) and not re.search(r"私|僕|自分", text):
                continue
            return True
    return False


def detect_subordinate_signal(text: str, recent_sub_texts: list[str], type_key: str, any_mode: bool = False):
    for sig in SUBORDINATE_SIGNALS:
        extra = {}
        if sig["id"] == "self_blame":
            extra = judge_self_blame(text, recent_sub_texts, any_mode)
            if not extra:
                continue
        elif not signal_matches(sig, text):
            continue
        elif sig["id"] == "give_up" and not give_up_hit(text):
            continue
        need = sig.get("repeat", 1)
        if need > 1:
            window = (recent_sub_texts + [text])[-3:]
            hits = sum(1 for t in window if any(re.search(p, t) for p in sig["patterns"]))
            if hits < need:
                continue
        return {
            "id": sig["id"],
            "label": sig["label"],
            "title": sig.get("title", ""),
            "hint": sig["hint"],
            "forecast": sig["forecast"].get(type_key, "様子を見たい場面です"),
            "reframe": sig.get("reframe", ""),
            **({"strength": extra["strength"]} if extra else {}),
            **self_rewrite(sig["id"], text, extra.get("evidence") if extra else None, type_key),
        }
    return None


# 部下の良い受け取り方（その場で小さく褒める。数えるだけで減点しない）
RECEIVE_GOOD_PATTERNS = {
    "separate": [
        r"次(?:は|から|回は|回から)", r"今後は", r"これからは", r"(?:て|で)みます",
        r"までに(?:出し|やり|仕上げ|終わらせ|直し|見せ|送り)", r"(?:手順|仕組み|確認)を(?:変え|決め|見直し|入れ|増や)",
    ],
    "extract": [
        r"(?:つまり|要するに)", r"ポイントは", r"(?:直すべき|直す|変える)(?:ところ|点|の)は",
        r"(?:ご指摘|指摘)(?:ありがとう|いただいた|の点|いただき)", r"なるほど", r"ということは",
    ],
    "clarify": [
        r"具体的に", r"どの(?:部分|あたり|点|ところ|辺|場面)", r"例えば", r"ということ(?:です|でしょう)か",
        r"(?:確認|質問)(?:させて|してもいい|しても|します)", r"教えて(?:もらえ|いただけ|ください)",
        r"どう(?:すれば|したら)(?:いい|良い|よい)", r"どこまで(?:やれば|できていれば)",
    ],
    "explain": [
        r"(?:理由|経緯|背景|事情)(?:は|としては|をお話|を説明|を話)", r"(?:お話し|説明)(?:します|させて)",
        r"と(?:判断|考え)(?:し|て)", r"つもりで", r"(?:優先|先に)(?:し|やっ)ていました",
    ],
}


# 褒めてはいけない発言（自己否定・皮肉・強いつらさのサイン）。これらを含む発言は型として数えない（レビュー指摘1）
NO_PRAISE_PATTERNS = [
    r"無能", r"辞め", r"やめ(?:たい|ます|よう)", r"いなくな", r"消え", r"(?:全部|すべて|ぜんぶ)(?:私|僕|自分|俺)?(?:が|の)?(?:悪い|せい)",
    r"価値(?:が|は)?(?:ない|無い)", r"いない方が", r"生きて", r"ってことですよね", r"ってことですね",
]
# 1発言で数える型は1つだけ（レビュー指摘5）。具体的な行動に近い順
SKILL_PRIORITY = ["clarify", "explain", "extract", "separate"]


def detect_receive_skills(text: str) -> list[dict]:
    if any(re.search(p, text) for p in NO_PRAISE_PATTERNS + SELF_NEG_ALL):
        return []
    for key in SKILL_PRIORITY:
        if any(re.search(p, text) for p in RECEIVE_GOOD_PATTERNS[key]):
            s = RECEIVE_SKILLS[key]
            return [{"id": key, "label": s["label"], "praise": s["praise"]}]
    return []


def skill_info(key: str) -> dict:
    s = RECEIVE_SKILLS.get(key) or RECEIVE_SKILLS["separate"]
    return {"id": key if key in RECEIVE_SKILLS else "separate", "label": s["label"], "desc": s["desc"]}


def category_weights(config: dict, situation: str | None = None) -> dict:
    """主タイプの補正に、副タイプの補正を半分だけ加え、面談の状況の重みを足す"""
    primary = config.get("active_preset", "perfectionist")
    secondary = (config.get("profile_analysis") or {}).get("secondary")
    weights = dict(TYPE_WEIGHTS.get(primary, {}))
    if secondary and secondary != primary:
        for cat, w in TYPE_WEIGHTS.get(secondary, {}).items():
            weights[cat] = weights.get(cat, 0) + w * 0.5
    for cat, w in SITUATIONS.get(situation or "", {}).get("weights", {}).items():
        weights[cat] = weights.get(cat, 0) + w
    return weights


def build_profile_result(config: dict, primary: str, secondary, scores) -> dict:
    preset = config.get("personality_presets", {}).get(primary, {})
    weights = dict(TYPE_WEIGHTS.get(primary, {}))
    if secondary:
        for cat, w in TYPE_WEIGHTS.get(secondary, {}).items():
            weights[cat] = weights.get(cat, 0) + w * 0.5
    labels = {p["id"]: p["label"] for p in ATTACK_PATTERNS}
    watch = sorted(
        [{"id": cat, "label": labels[cat], "example": CATEGORY_EXAMPLES[cat], "weight": w}
         for cat, w in weights.items() if w >= 1],
        key=lambda x: -x["weight"],
    )
    top = max(scores.values()) if scores else None
    if top is None:
        recommended = "medium"
    elif top >= 75:
        recommended = "high"
    elif top >= 40:
        recommended = "medium"
    else:
        recommended = "low"
    return {
        "primary": primary,
        "secondary": secondary,
        "scores": scores,
        "label": preset.get("label", primary),
        "secondary_label": config.get("personality_presets", {}).get(secondary, {}).get("label") if secondary else None,
        "watch_points": watch,
        "recommended_sensitivity": recommended,
        "low_signal": top is not None and top < 35,
        "analyzed_at": datetime.now().isoformat(),
    }


def _answer(answers: dict, qid: str):
    v = answers.get(qid)
    try:
        return max(0, min(3, int(v)))
    except (TypeError, ValueError):
        return None


def score_profile(answers: dict) -> dict:
    """傾向ごとに 0〜100 点。逆の聞き方の質問は、答えを反転して足す"""
    totals = {k: 0 for k in TYPE_KEYS}
    counts = {k: 0 for k in TYPE_KEYS}
    for q in PROFILE_QUESTIONS:
        a = _answer(answers, q["id"])
        if a is None:
            continue
        totals[q["dim"]] += (3 - a) if q["reverse"] else a
        counts[q["dim"]] += 1
    return {k: round(totals[k] / (counts[k] * 3) * 100) if counts[k] else 0 for k in TYPE_KEYS}


def profile_confidence(answers: dict, scores: dict) -> dict:
    """答えの確かさ。全部同じ答え・逆の聞き方との矛盾・未回答を見る"""
    given = [(q, _answer(answers, q["id"])) for q in PROFILE_QUESTIONS]
    given = [(q, a) for q, a in given if a is not None]
    reasons = []
    if len(given) < len(PROFILE_QUESTIONS):
        reasons.append(f"未回答が{len(PROFILE_QUESTIONS) - len(given)}問あります")
    if given and len({a for _, a in given}) == 1:
        reasons.append("すべて同じ答えになっています")
    conflicts = 0
    for dim in TYPE_KEYS:
        fwd = [a for q, a in given if q["dim"] == dim and not q["reverse"]]
        rev = [a for q, a in given if q["dim"] == dim and q["reverse"]]
        if fwd and rev and sum(fwd) / len(fwd) >= 2.4 and rev[0] >= 2:
            conflicts += 1
    if conflicts:
        reasons.append(f"逆の聞き方の質問と食い違う答えが{conflicts}か所あります")
    level = "high"
    if len({a for _, a in given}) <= 1 or conflicts >= 2 or len(given) < len(PROFILE_QUESTIONS) * 0.75:
        level = "low"
    elif conflicts == 1 or len(given) < len(PROFILE_QUESTIONS):
        level = "medium"
    ranked = sorted(scores.values(), reverse=True)
    mixed = len(ranked) > 1 and ranked[0] - ranked[1] < 8
    return {"level": level, "reasons": reasons, "mixed": mixed}


def strip_safe_clauses(transcript: str) -> str:
    """謝罪・感謝・気遣いの節を除く。「ありがとう、でも何回言ったら…」の後半は残る"""
    clauses = [c for c in re.split(CLAUSE_SPLIT, transcript) if c]
    return "、".join(c for c in clauses if not any(re.search(p, c) for p in SAFE_CLAUSE_PATTERNS))


def find_attack_matches(transcript: str) -> list:
    """マッチした攻撃パターンを (パターン, 基本スコア) のリストで返す"""
    target = strip_safe_clauses(transcript)
    matches = []
    if not target:
        return matches
    for pattern_group in ATTACK_PATTERNS:
        if any(re.search(sp, target) for sp in pattern_group.get("safe_patterns", [])):
            continue
        if any(re.search(p, target) for p in pattern_group["patterns"]):
            matches.append((pattern_group, pattern_group["score"]))
    return matches


def get_dummy_response(transcript: str, config: dict, context: list[str] = None, meta: dict | None = None) -> dict:
    """攻撃パターン検出 × 部下の性格補正 × 面談の状況で介入を判定する（ローカル判定エンジン）"""
    active_key = config.get("active_preset", "perfectionist")
    sensitivity = config.get("sensitivity", "medium")
    situation = (meta or {}).get("situation")
    threshold = {"low": 8, "medium": 6, "high": 4}.get(sensitivity, 6)
    threshold = max(3, min(9, threshold + SITUATIONS.get(situation or "", {}).get("threshold", 0)))
    weights = category_weights(config, situation)

    best = None
    for pattern_group, base in find_attack_matches(transcript):
        adj = weights.get(pattern_group["id"], 0)
        final = max(0, min(10, round(base + adj)))
        if best is None or final > best[3]:
            best = (pattern_group, base, adj, final)

    if not best:
        return {
            "should_intervene": False,
            "risk_level": "none",
            "reason": "責め・評価のニュアンスは検出されず",
            "character_emotion": "thinking",
            "demo_mode": True,
            "attack_score": 0,
        }

    pattern_group, base, adj, final = best
    pattern_id = pattern_group["id"]
    adj_text = f"{'+' if adj >= 0 else ''}{adj:g}"
    result = {
        "demo_mode": True,
        "detected_category": pattern_group["label"],
        "category_id": pattern_id,
        "attack_score": final,
        "cushion_phrase": pick(CUSHION_PHRASES, transcript),
        "reframed_speech": MINATO_LINES[pattern_id].get(active_key) or MINATO_LINES[pattern_id]["perfectionist"],
        "receive_skill": skill_info(CATEGORY_SKILL[pattern_id]) if pattern_id in CATEGORY_SKILL else None,
        "receive_note": "" if pattern_id in CATEGORY_SKILL else "これは受け取る練習の対象ではありません（言い方の問題です）",
        "reply_example": REPLY_EXAMPLES.get(pattern_id, ""),
        "boss_tip": pick(BOSS_TIPS[pattern_id], transcript),
        "meta_note": META_NOTES.get(pattern_id, {}).get(active_key, "配慮が必要な場面です"),
        "character_emotion": "gentle_smile",
    }
    if final >= threshold:
        result.update({
            "should_intervene": True,
            "risk_level": "high" if final >= 8 else "medium",
            "reason": f"「{pattern_group['label']}」を検出｜基本{base} 補正{adj_text} → {final}/10（閾値{threshold}）",
        })
    else:
        result.update({
            "should_intervene": False,
            "risk_level": "none",
            "reason": f"「{pattern_group['label']}」の傾向あり（{final}/10）だが、この部下の特性では閾値{threshold}未満のため見守り",
            "character_emotion": "thinking",
        })
    return result


@app.get("/")
async def root():
    return FileResponse(BASE_DIR / "static" / "index.html")


@app.get("/config")
async def get_config():
    return JSONResponse(load_config())


@app.post("/config")
async def update_config(request: Request):
    data = await request.json()
    save_config(data)
    return JSONResponse({"status": "saved"})


class ProfileRequest(BaseModel):
    answers: dict[str, int] | None = None
    preset: str | None = None
    respondent: str = "self"   # 診断は部下本人が答える


@app.get("/profile/questions")
async def profile_questions():
    return JSONResponse([{"id": q["id"], "dim": q["dim"], "boss": q["boss"], "self": q["self"]} for q in PROFILE_QUESTIONS])


@app.get("/profile")
async def get_profile():
    return JSONResponse(load_config().get("profile_analysis"))


@app.post("/profile/analyze")
async def analyze_profile(req: ProfileRequest):
    config = load_config()
    if req.preset:
        if req.preset not in config.get("personality_presets", {}):
            return JSONResponse({"error": "unknown preset"}, status_code=400)
        result = build_profile_result(config, req.preset, None, None)
        result["answers"] = None
    else:
        answers = req.answers or {}
        scores = score_profile(answers)
        ranked = sorted(TYPE_KEYS, key=lambda t: -scores[t])
        primary, runner_up = ranked[0], ranked[1]
        secondary = runner_up if scores[runner_up] >= 40 and scores[primary] - scores[runner_up] <= 15 else None
        result = build_profile_result(config, primary, secondary, scores)
        result["answers"] = answers
        result["respondent"] = "self" if req.respondent == "self" else "boss"
        result["confidence"] = profile_confidence(answers, scores)

    config["active_preset"] = result["primary"]
    config["profile_analysis"] = result
    save_config(config)
    return JSONResponse(result)


api_state = {"disabled": not os.environ.get("ANTHROPIC_API_KEY"), "last_error": None}


def claude_allowed(config: dict) -> bool:
    """Claudeへの送信は、設定で明示的にオンにしたときだけ行う（既定はオフ）"""
    return bool((config.get("judge") or {}).get("use_claude")) and not api_state["disabled"]


def ask_claude(config: dict, transcript: str, context: list[str], meta: dict | None = None) -> dict | None:
    context_text = "\n".join(f"- {c}" for c in context)
    user_message = f"""【直近の会話】
{context_text}

【最新の上司の発言】
{transcript}"""
    is_haiku = "haiku" in CLAUDE_MODEL
    # Haikuは思考をオフにして応答を速くする。他のモデルは、断られた場合の自動切替を使う
    params = {"thinking": {"type": "disabled"}} if is_haiku else {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}
    try:
        api = client.with_options(timeout=CLAUDE_TIMEOUT_SEC, max_retries=0)
        response = (api.messages if is_haiku else api.beta.messages).create(
            model=CLAUDE_MODEL,
            max_tokens=1024,
            system=build_system_prompt(config, meta),
            messages=[{"role": "user", "content": user_message}],
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": VERDICT_SCHEMA}},
            **params,
        )
        if response.stop_reason in ("refusal", "max_tokens"):
            return None
        return json.loads(next(b.text for b in response.content if b.type == "text"))
    except (anthropic.NotFoundError, anthropic.AuthenticationError, anthropic.PermissionDeniedError, anthropic.BadRequestError) as e:
        # 設定の問題はリトライしても直らないので、以後はローカル判定に固定し、理由を記録する
        api_state["disabled"] = True
        api_state["last_error"] = f"{type(e).__name__}: model={CLAUDE_MODEL}"
        print(f"[判定] Claudeを停止しました（{api_state['last_error']}）")
    except (json.JSONDecodeError, anthropic.APIError, StopIteration, KeyError, IndexError) as e:
        api_state["last_error"] = type(e).__name__
    return None


def merge_claude(ai: dict, local: dict, config: dict) -> dict:
    """Claudeの判断を採用しつつ、声に出す文は安全確認を通ったものだけにする"""
    merged = dict(local)
    merged["demo_mode"] = False
    merged["reason"] = ai.get("reason", "")
    if not ai.get("should_intervene") or ai.get("risk_level") == "none":
        merged.update({"should_intervene": False, "risk_level": "none", "character_emotion": "thinking"})
        return merged
    speech = (ai.get("reframed_speech") or "").strip()
    reply = (ai.get("reply_example") or "").strip()
    reply_ok = reply and len(reply) <= 40 and speech_is_safe(reply[:MAX_SPEECH_CHARS], config)
    merged.update({
        "should_intervene": True,
        "risk_level": ai.get("risk_level", "medium"),
        "reframed_speech": speech if speech_is_safe(speech, config) else local["reframed_speech"],
        "reply_example": reply if reply_ok else local.get("reply_example", ""),
        "boss_tip": (ai.get("boss_tip") or "").strip() or local["boss_tip"],
    })
    return merged


def judge_boss(transcript: str, context: list[str], config: dict, allow_external: bool, meta: dict | None = None) -> dict:
    """まず端末内で判定し、気になる言い方が見つかった発言だけClaudeに確認する"""
    local = get_dummy_response(transcript, config, context, meta)
    result, sent = local, False
    if allow_external and local.get("attack_score", 0) > 0 and claude_allowed(config):
        sent = True
        ai = ask_claude(config, transcript, context, meta)
        if ai:
            result = merge_claude(ai, local, config)
    return {**result, "external_sent": sent}


def cached_judge(transcript: str, context: list[str], config: dict, allow_external: bool) -> dict:
    meta = dict(session_meta)
    key = (re.sub(r"[\s、。，．,.…・!！?？]", "", transcript), tuple(context), allow_external,
           meta.get("situation"), json.dumps(meta.get("intent") or {}, ensure_ascii=False, sort_keys=True))
    now = time.monotonic()
    with judge_cache_lock:
        for k in [k for k, (exp, _) in judge_cache.items() if exp < now]:
            del judge_cache[k]
        entry = judge_cache.get(key)
        if entry is None:
            entry = (now + 30, judge_pool.submit(judge_boss, transcript, context, config, allow_external, meta))
            judge_cache[key] = entry
    return dict(entry[1].result())


def describe_sent(result: dict, transcript: str, context: list[str], config: dict) -> dict:
    """画面の「送信データ」欄に出す内容。実際に外へ出たものだけを示す"""
    if not result.get("external_sent"):
        return {"external_sent": False, "note": "この発言は外部に送っていません（このPC内で判定）"}
    return {
        "external_sent": True,
        "to": "Anthropic",
        "masked_transcript": transcript,
        "masked_context": context,
        "also_sent": ["部下の特性プロファイル", "介入感度", "キャラクター設定", "面談の状況"]
                     + (["上司が事前に伝えたいこと（名前は置き換え済み）"] if any((session_meta.get("intent") or {}).values()) else []),
    }


# 自分に向けた言葉（「全然できてないと自分でも思います」「なんで気づけなかったんだろう」）は、
# 上司の厳しい言葉ではない。話者を分けない設定で、上司向けの判定に回さないための目印
SELF_DIRECTED = re.compile(
    r"自分でも|自分(?:には|なんて|なんか|って)|(?:私|僕|わたし|ぼく|俺)(?:も|が|は|には|って|ばっかり|ばかり|なんて)|んだろう|んでしょうか|べきでした|ればよかった|ばよかった|つもりでした"
)


def is_self_directed(text: str) -> bool:
    return bool(SELF_DIRECTED.search(text))


def analyze_any(req: AnalyzeRequest, config: dict, masked_transcript: str, masked_context: list[str]) -> dict:
    """話者を分けない設定：誰の言葉でも、部下のフォローに使う。
    ・自己否定のサイン（部下が自分を責める言葉）→ 事実と評価を分ける手がかり
    ・厳しい言葉（上司の言い方）→ 受け取る側への声かけ
    部下の発言かもしれないので、外部（Claude）には送らず、端末内のルールだけで判定する"""
    recent = [c["masked"] for c in session_log["conversations"] if c.get("speaker") in ("subordinate", "any")][-2:]
    is_demo = req.speaker_source == "demo"
    if not req.reanalysis:
        session_log["conversations"].append({
            "timestamp": datetime.now().isoformat(),
            "speaker": "any",
            "speaker_source": req.speaker_source,
            "speaker_confidence": None,
            "original": req.transcript,
            "masked": masked_transcript,
        })
    signal = detect_subordinate_signal(masked_transcript, recent, config.get("active_preset", "perfectionist"), any_mode=True)
    if signal:
        session_log["subordinate_signals"].append({
            "timestamp": datetime.now().isoformat(),
            "transcript": req.transcript,
            "signal": signal,
            "demo": is_demo,
        })
    if signal or is_self_directed(masked_transcript):
        why = f"自己否定のサイン（{signal['label']}）" if signal else "自分に向けた言葉のため、言い方の判定はしません"
        result = {"should_intervene": False, "risk_level": "none", "attack_score": 0, "reason": why, "demo_mode": True}
    else:
        result = dict(cached_judge(masked_transcript, masked_context, config, False))
        session_log["interventions"].append({
            "timestamp": datetime.now().isoformat(),
            "transcript": req.transcript,
            "speaker_source": req.speaker_source,
            "late": req.reanalysis,
            "result": dict(result),
        })
    result["speaker"] = "any"
    result["subordinate_signal"] = signal
    result["sent_data"] = {"external_sent": False, "note": "話者を分けない設定では、発言を外部に送っていません"}
    return result


@app.post("/analyze")
def analyze(req: AnalyzeRequest):
    config = load_config()
    masked_transcript = mask_names(req.transcript, config)
    masked_context = [mask_names(c, config) for c in req.context][-6:]

    if req.speaker == "any" and not req.speculative:
        return JSONResponse(analyze_any(req, config, masked_transcript, masked_context))
    if req.speaker == "any":   # 先行判定は、話者が分かるときだけ
        return JSONResponse({"should_intervene": False, "risk_level": "none", "speculative": True})

    # 先行判定：記録しない。話者が上司と分かっているときだけ外部確認の対象にする
    if req.speculative:
        if req.speaker == "subordinate":
            return JSONResponse({"should_intervene": False, "risk_level": "none", "speculative": True})
        allow = req.speaker == "boss" and not req.speaker_unsure and req.speaker_source != "demo"
        result = cached_judge(masked_transcript, masked_context, config, allow)
        result.update({"speculative": True, "speaker": "boss", "sent_data": describe_sent(result, masked_transcript, masked_context, config)})
        return JSONResponse(result)

    speaker = req.speaker if req.speaker in SPEAKER_LABELS else "boss"
    recent_sub = [c["masked"] for c in session_log["conversations"] if c.get("speaker") == "subordinate"][-2:]
    if not req.reanalysis:
        session_log["conversations"].append({
            "timestamp": datetime.now().isoformat(),
            "speaker": speaker,
            "speaker_source": req.speaker_source,
            "speaker_confidence": req.speaker_confidence,
            "original": req.transcript,
            "masked": masked_transcript,
        })

    # 部下の発言は介入判定にかけない（view viewが割り込む理由にならない）
    if speaker == "subordinate":
        signal = detect_subordinate_signal(masked_transcript, recent_sub, config.get("active_preset", "perfectionist"))
        skills = detect_receive_skills(masked_transcript)
        is_demo = req.speaker_source == "demo"
        if signal:
            session_log["subordinate_signals"].append({
                "timestamp": datetime.now().isoformat(),
                "transcript": req.transcript,
                "signal": signal,
                "demo": is_demo,
            })
        if skills:
            # 話者を直したときに取り消せるよう、どの発言の分かを（メモリ上だけで）持つ。ディスクには回数だけ残す
            session_log.setdefault("receive_skills", []).append({
                "timestamp": datetime.now().isoformat(),
                "skills": [s["id"] for s in skills],
                "transcript": req.transcript,
                "demo": is_demo,
            })
        return JSONResponse({
            "should_intervene": False,
            "speaker": "subordinate",
            "risk_level": "none",
            "reason": f"部下の発言（{signal['label']}）" if signal else "部下の発言のため介入判定の対象外",
            "subordinate_signal": signal,
            "receive_skills": skills,
            "sent_data": {"external_sent": False, "note": "部下の発言はこの時点では外部に送っていません"},
        })

    allow = not req.speaker_unsure and req.speaker_source != "demo"
    result = cached_judge(masked_transcript, masked_context, config, allow)

    session_log["interventions"].append({
        "timestamp": datetime.now().isoformat(),
        "transcript": req.transcript,
        "speaker_source": req.speaker_source,
        "late": req.reanalysis,
        "result": dict(result),
    })

    result["speaker"] = "boss"
    result["sent_data"] = describe_sent(result, masked_transcript, masked_context, config)
    return JSONResponse(result)


class SpeakerCorrection(BaseModel):
    transcript: str
    from_speaker: str
    to_speaker: str
    confidence: float | None = None


@app.post("/speaker-correction")
async def speaker_correction(req: SpeakerCorrection):
    """自動判定を人が直した記録。話者判定の実際の精度を測る検証データになる"""
    session_log["speaker_corrections"].append({
        "timestamp": datetime.now().isoformat(),
        "transcript": req.transcript,
        "from": req.from_speaker,
        "to": req.to_speaker,
        "confidence": req.confidence,
    })
    for c in reversed(session_log["conversations"]):
        if c.get("original") == req.transcript:
            c["speaker"] = req.to_speaker
            c["corrected_from"] = req.from_speaker
            break
    # 部下の発言ではなかった → その発言で数えた型とサインを取り消す（レビュー指摘2）
    if req.from_speaker == "subordinate" and req.to_speaker != "subordinate":
        for key in ("receive_skills", "subordinate_signals"):
            rows = session_log.get(key, [])
            for i in range(len(rows) - 1, -1, -1):
                if rows[i].get("transcript") == req.transcript:
                    del rows[i]
                    break
    return JSONResponse({"status": "recorded"})


# ---------- 音声合成（VOICEVOX 互換エンジン。AivisSpeech も同じAPI） ----------
DEFAULT_ENGINE_URL = "http://127.0.0.1:50021"


def engine_url(config: dict) -> str | None:
    """外部への送信を防ぐため、このPC上のエンジンだけを許可する"""
    url = ((config.get("voice") or {}).get("engine_url") or DEFAULT_ENGINE_URL).rstrip("/")
    parsed = urlparse(url)
    if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost"):
        return None
    return url


@app.get("/tts/status")
def tts_status():
    config = load_config()
    url = engine_url(config)
    if not url:
        return JSONResponse({"available": False, "error": "音声エンジンのURLは http://127.0.0.1 か http://localhost のみ使えます"})
    try:
        version = requests.get(f"{url}/version", timeout=1.5).json()
        speakers = requests.get(f"{url}/speakers", timeout=3).json()
    except (requests.RequestException, ValueError):
        return JSONResponse({"available": False, "engine_url": url})
    return JSONResponse({
        "available": True,
        "engine_url": url,
        "version": version,
        "speakers": [
            {"name": s.get("name"), "styles": [{"id": st.get("id"), "name": st.get("name")} for st in s.get("styles", [])]}
            for s in speakers
        ],
    })


class TTSRequest(BaseModel):
    text: str
    speaker: int
    speed: float = 1.0
    pitch: float = 0.0
    intonation: float = 1.0


@app.post("/tts")
def tts(req: TTSRequest):
    url = engine_url(load_config())
    text = req.text.strip().replace("〜", "ー")[:400]
    if not url or not text:
        return JSONResponse({"error": "unavailable"}, status_code=400)
    try:
        q = requests.post(f"{url}/audio_query", params={"text": text, "speaker": req.speaker}, timeout=3)
        q.raise_for_status()
        query = q.json()
        query["speedScale"] = max(0.5, min(2.0, req.speed))
        query["pitchScale"] = max(-0.15, min(0.15, req.pitch))
        query["intonationScale"] = max(0.0, min(2.0, req.intonation))
        # 文ごとに合成してつなぐので、前後の無音は短くし、文間の間は再生側で付ける
        query["prePhonemeLength"] = 0.03
        query["postPhonemeLength"] = 0.08
        if "pauseLengthScale" in query:
            query["pauseLengthScale"] = 0.85
        wav = requests.post(f"{url}/synthesis", params={"speaker": req.speaker}, json=query, timeout=8)
        wav.raise_for_status()
    except (requests.RequestException, ValueError):
        return JSONResponse({"error": "engine_failed"}, status_code=502)
    return Response(content=wav.content, media_type="audio/wav")


def clean_intent(raw) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    goals = [g.strip()[:60] for g in (raw.get("goals") or []) if isinstance(g, str) and g.strip()][:3]
    take = raw.get("takeaway") if isinstance(raw.get("takeaway"), str) else ""
    out = raw.get("outcome") if isinstance(raw.get("outcome"), str) else ""
    return {"goals": goals, "takeaway": take.strip()[:40], "outcome": out.strip()[:60]}


class StartSessionRequest(BaseModel):
    situation: str = "progress"
    intent: dict | None = None


class SituationRequest(BaseModel):
    situation: str


@app.post("/session/situation")
async def set_situation(req: SituationRequest):
    if req.situation not in SITUATIONS:
        return JSONResponse({"error": "unknown situation"}, status_code=400)
    session_meta["situation"] = req.situation
    session_log.setdefault("situation_changes", []).append({"timestamp": datetime.now().isoformat(), "situation": req.situation})
    return JSONResponse({"status": "ok", "situation": req.situation})


@app.post("/start-session")
async def start_session(req: StartSessionRequest | None = None):
    config = load_config()
    session_meta["situation"] = req.situation if req and req.situation in SITUATIONS else "progress"
    session_meta["intent"] = clean_intent(req.intent if req else None)
    session_log["situation_changes"] = []
    session_log["started_at"] = datetime.now().isoformat()
    session_log["config_snapshot"] = config
    session_log["conversations"] = []
    session_log["interventions"] = []
    session_log["subordinate_signals"] = []
    session_log["receive_skills"] = []
    session_log["receive_summary"] = None
    session_log["speaker_corrections"] = []
    session_log["turn_log"] = []
    session_log["metrics"] = []
    with judge_cache_lock:
        judge_cache.clear()
    return JSONResponse({"status": "session_started", "started_at": session_log["started_at"]})


class EndSessionRequest(BaseModel):
    turn_log: list[dict] = []   # 話す／見送るの判断の記録（発言の本文は含まない）
    metrics: list[dict] = []    # 音声認識の速さと区切りの計測（時間と件数だけ）
    intent_covered: int | None = None  # 伝えたいことのうち、話題に出た件数（目安）


def log_for_disk(log: dict, config: dict) -> dict:
    """保存するログ。既定では発言の原文・実名表・回答を残さず、件数と判断だけを残す"""
    if (config.get("privacy") or {}).get("log_raw"):
        return log
    snapshot = log.get("config_snapshot") or {}
    return {
        "started_at": log.get("started_at"),
        "raw_text_saved": False,
        "config_snapshot": {"sensitivity": snapshot.get("sensitivity"), "pace": (snapshot.get("turn") or {}).get("pace", "normal")},
        "conversations": [
            {"timestamp": c.get("timestamp"), "speaker": c.get("speaker"), "speaker_source": c.get("speaker_source"),
             "speaker_confidence": c.get("speaker_confidence"), "chars": len(c.get("original") or ""),
             "corrected_from": c.get("corrected_from")}
            for c in log.get("conversations", [])
        ],
        "interventions": [
            {"timestamp": i.get("timestamp"), "late": i.get("late"), "should_intervene": i["result"].get("should_intervene"),
             "risk_level": i["result"].get("risk_level"), "category_id": i["result"].get("category_id"),
             "attack_score": i["result"].get("attack_score"), "external_sent": i["result"].get("external_sent")}
            for i in log.get("interventions", [])
        ],
        "subordinate_signals": [
            {"timestamp": s.get("timestamp"), "signal_id": s["signal"].get("id")} for s in log.get("subordinate_signals", [])
        ],
        "speaker_corrections": [
            {"timestamp": s.get("timestamp"), "from": s.get("from"), "to": s.get("to"), "confidence": s.get("confidence")}
            for s in log.get("speaker_corrections", [])
        ],
        "turn_log": log.get("turn_log", []),
        "metrics": clean_metrics(log.get("metrics", [])),
        "meeting": log.get("meeting"),  # 状況と件数だけ。伝えたいことの本文は残さない
        "receive_summary": log.get("receive_summary"),  # 受け取り方の回数だけ
    }


RECEIVE_HISTORY_PATH = LOGS_DIR / "receive_history.json"
SELF_NEG_SIGNALS = ("self_blame",)  # 「自分を責める言葉」として数えるのは自責だけ（謝罪・あきらめは混ぜない。レビュー指摘9）


def receive_summary(log: dict) -> dict:
    """受け取り方のふりかえり。回数だけで作る（発言の本文は使わない）。デモ会話は数えない（レビュー指摘3）"""
    counts = {k: 0 for k in SKILL_KEYS}
    for row in log.get("receive_skills", []):
        if row.get("demo"):
            continue
        for k in row.get("skills", []):
            if k in counts:
                counts[k] += 1
    self_neg = sum(1 for s in log.get("subordinate_signals", [])
                   if not s.get("demo") and (s.get("signal") or {}).get("id") in SELF_NEG_SIGNALS)
    real_iv = [i for i in log.get("interventions", []) if i.get("speaker_source") != "demo"]
    personal = sum(1 for i in real_iv
                   if i["result"].get("category_id") == "personal_attack" and i["result"].get("should_intervene"))
    cues = {}
    for i in real_iv:
        r = i["result"]
        if r.get("should_intervene") and r.get("category_id") in CATEGORY_SKILL:
            k = CATEGORY_SKILL[r["category_id"]]
            cues[k] = cues.get(k, 0) + 1
    # 次の練習テーマ：view viewが促したのに、まだ使えていない型 → なければ一番少ない型
    pending = [k for k in SKILL_KEYS if cues.get(k) and not counts[k]]
    focus = pending[0] if pending else min(SKILL_KEYS, key=lambda k: (counts[k], SKILL_KEYS.index(k)))
    return {
        "skills": counts,
        "skills_total": sum(counts.values()),
        "self_negation": self_neg,
        "personal_attack_by_boss": personal,
        "cues": cues,
        "focus": focus,
        "sub_utterances": sum(1 for c in log.get("conversations", [])
                              if c.get("speaker") in ("subordinate", "any") and c.get("speaker_source") != "demo"),
    }


def load_receive_history() -> list[dict]:
    try:
        with open(RECEIVE_HISTORY_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def append_receive_history(summary: dict):
    rows = load_receive_history()
    rows.append({"date": datetime.now().isoformat(timespec="minutes"), **{k: summary[k] for k in
                 ("skills", "skills_total", "self_negation", "personal_attack_by_boss", "sub_utterances")}})
    LOGS_DIR.mkdir(exist_ok=True)
    with open(RECEIVE_HISTORY_PATH, "w", encoding="utf-8") as f:
        json.dump(rows[-50:], f, ensure_ascii=False, indent=2)


@app.post("/end-session")
def end_session(req: EndSessionRequest | None = None):
    if not session_log["started_at"]:
        return JSONResponse({"status": "no_active_session"})

    session_log["turn_log"] = (req.turn_log if req else [])[:2000]
    intent = session_meta.get("intent") or {}
    session_log["meeting"] = {
        "situation": session_meta.get("situation"),
        "situation_changes": [c.get("situation") for c in session_log.get("situation_changes", [])],
        "intent_goals": len(intent.get("goals") or []),
        "intent_takeaway": bool(intent.get("takeaway")),
        "intent_covered": req.intent_covered if req and isinstance(req.intent_covered, int) else None,
    }
    session_log["metrics"] = clean_metrics(req.metrics if req else [])
    summary = receive_summary(session_log)
    session_log["receive_summary"] = summary
    previous = load_receive_history()[-1:] or [None]
    if summary["sub_utterances"]:
        append_receive_history(summary)
    filename = f"session_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    filepath = LOGS_DIR / filename
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(log_for_disk(session_log, load_config()), f, ensure_ascii=False, indent=2)

    session_log["started_at"] = None
    return JSONResponse({"status": "saved", "file": str(filepath), "receive": summary, "receive_previous": previous[0],
                         "skill_labels": {k: v["label"] for k, v in RECEIVE_SKILLS.items()},
                         "skill_descs": {k: v["desc"] for k, v in RECEIVE_SKILLS.items()}})


# ---- 受け取り方の練習（面談の前に。入力した返しは保存しない） ----
PRACTICE_ITEMS = [
    {"id": "p1", "boss": "なんでもっと早く相談しなかったの？", "skill": "explain",
     "model": "経緯をお話しします。水曜の時点で自分で直せると判断していました。次は迷った日に一度相談します。"},
    {"id": "p2", "boss": "全然できてないじゃん", "skill": "extract",
     "model": "一番直すべきところはどこか教えてもらえますか？そこから直します。"},
    {"id": "p3", "boss": "もっとちゃんとやって", "skill": "clarify",
     "model": "どこまでできていれば十分か、具体的に教えてもらえますか？"},
    {"id": "p4", "boss": "何回言ったらわかるの", "skill": "separate",
     "model": "同じことが起きないように、次から提出前に確認の手順を一つ入れます。"},
    {"id": "p5", "boss": "期待してたのにがっかりだよ", "skill": "extract",
     "model": "次はどうなっていれば期待に近づけるか、教えてもらえますか？"},
]


@app.get("/practice/items")
def practice_items():
    return JSONResponse({
        "items": [{**it, "skill_label": RECEIVE_SKILLS[it["skill"]]["label"], "skill_desc": RECEIVE_SKILLS[it["skill"]]["desc"]}
                  for it in PRACTICE_ITEMS],
        "skills": {k: {"label": v["label"], "desc": v["desc"]} for k, v in RECEIVE_SKILLS.items()},
    })


class PracticeCheck(BaseModel):
    item_id: str
    reply: str


@app.post("/practice/check")
def practice_check(req: PracticeCheck):
    item = next((it for it in PRACTICE_ITEMS if it["id"] == req.item_id), None)
    if not item:
        return JSONResponse({"error": "unknown item"}, status_code=400)
    reply = (req.reply or "").strip()[:200]
    skills = detect_receive_skills(reply)
    # 練習は1回の返しだけを見る（「すみません」1回を謝罪の連続と数えない。レビュー指摘9）
    signal = detect_subordinate_signal(reply, [], "perfectionist") if reply else None
    got = {s["id"] for s in skills}
    target = RECEIVE_SKILLS[item["skill"]]
    signal_msg = {
        "self_blame": "自分を責める言葉が入っています。指摘は仕事についての話なので、行動と次の一手で言い直してみましょう。",
        "give_up": "「分からない」「無理」で止まっても大丈夫です。分かっている所と分からない所を分けて伝えてみましょう。",
    }
    if not reply:
        message = "思いついた返しを、そのまま書いてみてください。"
    elif signal and signal["id"] in signal_msg and not skills:
        message = signal_msg[signal["id"]]
    elif item["skill"] in got:
        message = f"いいですね！「{target['label']}」ができています。"
    elif skills:
        message = f"「{'」「'.join(s['label'] for s in skills)}」ができています。この場面は「{target['label']}」（{target['desc']}）も試せます。"
    else:
        message = f"この場面は「{target['label']}」がおすすめです。{target['desc']}。"
    return JSONResponse({
        "message": message,
        "skills": skills,
        "self_negation": bool(signal and signal["id"] in SELF_NEG_SIGNALS),
        "rewrite": signal.get("rewrite") if signal else "",
        "rewrite_example": signal.get("rewrite_example") if signal else "",
        "target": {"id": item["skill"], "label": target["label"], "desc": target["desc"]},
        "model": item["model"],
        "saved": False,
    })


class MeasureRequest(BaseModel):
    results: list[dict] = []


@app.post("/measure/save")
def save_measure(req: MeasureRequest):
    """読み上げ計測テストの結果を保存する。受け付けるのは時間・件数・真偽値だけ"""
    rows = clean_metrics(req.results, 50)
    filepath = LOGS_DIR / f"measure_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump({"measured_at": datetime.now().isoformat(), "raw_text_saved": False, "results": rows}, f, ensure_ascii=False, indent=2)
    return JSONResponse({"status": "saved", "file": str(filepath), "count": len(rows)})


LOGIN_HTML = """<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>view view｜合言葉</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#FBF7F2;color:#2B2522;font-family:"Hiragino Sans","Noto Sans JP",system-ui,sans-serif}
form{width:min(92vw,380px);background:#fff;border:1px solid #EDE5DC;border-radius:20px;padding:28px 24px;display:grid;gap:14px;box-shadow:0 8px 30px rgba(43,37,34,.06)}
h1{margin:0;font-size:20px}p{margin:0;font-size:14px;color:#6b625b;line-height:1.7}
input{font:inherit;font-size:16px;padding:12px 14px;border:1px solid #D9CDC1;border-radius:12px}
button{font:inherit;font-weight:700;padding:13px;border:0;border-radius:999px;background:#E9785F;color:#fff}
.err{color:#D2504B;font-weight:600}
</style></head><body>
<form method="post" action="/login">
<h1>view view（1on1見守りAI）</h1>
<p>合言葉を入力してください。</p>
{{MSG}}
<input type="password" name="password" autocomplete="current-password" autofocus required aria-label="合言葉">
<button type="submit">開く</button>
</form></body></html>"""
_login_fails: dict = {}  # IPごとの失敗回数（総当たり対策。再起動で消える）


def _login_page(msg: str = "", status: int = 200):
    return HTMLResponse(LOGIN_HTML.replace("{{MSG}}", f'<p class="err">{msg}</p>' if msg else ""), status_code=status)


@app.get("/login")
def login_page():
    if not LocalOnly.PASSWORD:
        return RedirectResponse("/", status_code=303)
    return _login_page()


@app.post("/login")
async def login(request: Request):
    if not LocalOnly.PASSWORD:
        return RedirectResponse("/", status_code=303)
    ip = request.headers.get("x-forwarded-for", "").split(",")[0].strip() or (request.client.host if request.client else "")
    now = time.monotonic()
    count, first = _login_fails.get(ip, (0, now))
    if now - first > 600:
        count, first = 0, now
    if count >= 8:
        return _login_page("失敗が続いたため、しばらくしてからやり直してください。", 429)
    form = parse_qs((await request.body()).decode("utf-8", "ignore"))
    given = (form.get("password") or [""])[0]
    if hmac.compare_digest(given.encode(), LocalOnly.PASSWORD.encode()):
        _login_fails.pop(ip, None)
        resp = RedirectResponse("/", status_code=303)
        resp.set_cookie(LocalOnly.COOKIE, LocalOnly.token(), max_age=30 * 86400, httponly=True, samesite="lax", secure=LocalOnly.PUBLIC_MODE)
        return resp
    _login_fails[ip] = (count + 1, first)
    return _login_page("合言葉が違います。", 401)


zoom_bridge.setup(load_config)
app.include_router(zoom_bridge.router)
app.include_router(stage_bridge.router)

app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")
