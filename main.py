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

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["path"] != "/zoom/webhook":
            headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
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

SPEAKER_LABELS = {"boss": "上司", "subordinate": "部下"}


class AnalyzeRequest(BaseModel):
    transcript: str
    context: list[str] = []
    speaker: str = "boss"                     # boss / subordinate
    speaker_source: str = "manual"            # auto（声で判定）/ manual / demo / text
    speaker_confidence: float | None = None
    speaker_unsure: bool = False              # 話者に自信がない発言は外部へ送らず、声にもしない
    reanalysis: bool = False                  # 話者を直した発言の再判定（会話記録は増やさない）
    speculative: bool = False                 # 話し終わりの気配で途中文を先に判定する（記録しない）


def load_config() -> dict:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_config(data: dict):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def build_system_prompt(config: dict) -> str:
    persona = config["character_persona"]
    active_key = config.get("active_preset", "perfectionist")
    personality = config["personality_presets"].get(active_key, {})
    sensitivity = config.get("sensitivity", "medium")

    sensitivity_desc = {
        "low": "明確な人格否定・詰問の場合のみ介入する",
        "medium": "人格否定に加え、抽象論やプレッシャーを感じる発言にも介入する",
        "high": "軽い指摘でも、対象者が傷つく可能性があれば介入する",
    }

    return f"""あなたは1on1面談に同席するAIキャラクターです。上司の言葉と部下の受け取り方のすれ違いを、短い一言で橋渡しします。

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

【介入感度】
{sensitivity_desc.get(sensitivity, sensitivity_desc['medium'])}

【判断】
直近の会話には「上司:」「部下:」の話者ラベルが付いています。判定するのは最新の上司の発言だけで、部下の発言は文脈です。
- 上司自身の謝罪、感謝、気遣いには介入しない
- この部下なら問題なく受け取れる発言には介入しない

【reframed_speech の書き方】
- 部下に向けて話す。上司への助言や評価はしない
- 「上司の意図の推測」＋「部下が自分の状況を客観視できる短い問い」の2文
- 意図は断定せず「〜だと思います」「〜かもです」と言う
- 38文字以内。呼びかけの言葉は付けない
- 性格、タイプ、特性、傾向に関する言葉は使わない

boss_tip には、上司だけが画面で読む言い換えの提案を60文字以内で書きます。介入しない場合、reframed_speech と boss_tip は空文字にします。"""


VERDICT_SCHEMA = {
    "type": "object",
    "properties": {
        "should_intervene": {"type": "boolean"},
        "risk_level": {"type": "string", "enum": ["none", "low", "medium", "high"]},
        "reason": {"type": "string"},
        "reframed_speech": {"type": "string"},
        "boss_tip": {"type": "string"},
    },
    "required": ["should_intervene", "risk_level", "reason", "reframed_speech", "boss_tip"],
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
        "id": "accusatory_why",
        "label": "追及型の「なぜ」",
        "patterns": [
            r"(?:なぜ|なんで|何で|何故).*(?:なかった|しなかった|できなかった|やらなかった|言わなかった|しない)",
            r"(?:なぜ|なんで|何で|何故).*(?:の\s*$|んだ|のか)",
            r"(?:どうして).*(?:なかった|しなかった|できなかった|くれない|しない)",
        ],
        "safe_patterns": [
            r"(?:なぜ|なんで|何で).*(?:だと思|と思い|と考え|にした|になった|を選|ですか)",
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
            r"(?:責任|自覚|意識).*(?:ない|ある|足りない|持って|して)",
        ],
        "safe_patterns": [
            r"期待(?:して|できる|できそう|したい)",
        ],
        "score": 7,
    },
    {
        "id": "sigh_tone",
        "label": "ため息・呆れ",
        "patterns": [
            r"(?:はぁ|はあ|ふぅ|あのさ|ねえ).*(?:何回|なんで|どうして|いつ)",
            r"(?:もういい|もういいよ|話にならない|無理だ)",
        ],
        "safe_patterns": [],
        "score": 8,
    },
]


# 上司自身の謝罪・感謝・気遣いの言葉。この部分は介入の根拠にしない
SAFE_CLAUSE_PATTERNS = [
    r"(?:ごめん|すまん|すまない|申し訳|悪かった|悪いね)",
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

# ミナトが声で話すセリフ。部下に向けて「上司の意図の推測＋問い」を短く伝える。
# 性格の話は一切しない（プロダクト方針）。呼びかけ込みで40字以内
MINATO_LINES = {
    "accusatory_why": {
        "perfectionist": "責める話じゃないと思うんです。どの時点なら声をかけやすいですか？",
        "logical": "経緯を知りたいんだと思います。どこで判断が分かれました？",
        "sensitive": "怒ってるのとは違うと思います。一番困ったのはどの場面でした？",
    },
    "common_sense_push": {
        "perfectionist": "できてない話じゃないと思います。どこを揃えたいか話せそうですか？",
        "logical": "やり方を揃えたいんだと思います。今の進め方の理由は何でした？",
        "sensitive": "一緒に確認したいんだと思います。迷ったところはありますか？",
    },
    "pressure": {
        "perfectionist": "全部じゃなくて大丈夫かもです。まずどこまでなら見せられそうですか？",
        "logical": "見通しを知りたいんだと思います。残りの作業はどれくらいですか？",
        "sensitive": "心配してくれてるんだと思います。今止まってるのはどこですか？",
    },
    "denial": {
        "perfectionist": "直したいのは一部だと思います。うまくいった所はどこでした？",
        "logical": "気になる点があるんだと思います。どの部分か確かめてみませんか？",
        "sensitive": "全部がだめって話じゃないと思います。一番気になる所はどこですか？",
    },
    "repetition_blame": {
        "perfectionist": "仕組みで防ぎたいんだと思います。どの手順で止まりやすいですか？",
        "logical": "原因を揃えたいんだと思います。前回と違った条件は何でした？",
        "sensitive": "一緒に防ぎたいんだと思います。つまずきやすいのはどこですか？",
    },
    "vague_demand": {
        "perfectionist": "全部じゃなく一点だと思います。まずどこを整えたいですか？",
        "logical": "基準を揃えたいんだと思います。どこが曖昧でした？",
        "sensitive": "心配なんだと思います。今いちばん不安なのはどこですか？",
    },
    "disappointment": {
        "perfectionist": "期待があるからだと思います。次に試したいことはありますか？",
        "logical": "期待との差を話したいんだと思います。どこがずれてそうですか？",
        "sensitive": "見放す話じゃないと思います。今の気持ちを話せそうですか？",
    },
    "sigh_tone": {
        "perfectionist": "少し考え中なのかもです。今どこで止まってるか話せそうですか？",
        "logical": "言葉を探してるのかもです。状況を一度整理してみませんか？",
        "sensitive": "怒ってるとは限らないかもです。今話しづらいことはありますか？",
    },
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
    "accusatory_why": {
        "perfectionist": "このタイプは「なぜ」と問われると「自分が無能だから」と自責に向かう傾向があります",
        "logical": "このタイプは感情的な追及と受け取り、論理的な対話ができなくなる傾向があります",
        "sensitive": "このタイプは「なぜ」を「怒られている」と感じフリーズする傾向があります",
    },
    "common_sense_push": {
        "perfectionist": "このタイプは「普通もできない自分」と全否定に向かう傾向があります",
        "logical": "このタイプは論理的根拠のない主張に反発し、対話が止まる傾向があります",
        "sensitive": "このタイプは「自分だけがおかしい」と孤立感を覚える傾向があります",
    },
    "pressure": {
        "perfectionist": "このタイプは急かされると「完璧にしなきゃ」と焦り、ミスが増える傾向があります",
        "logical": "このタイプは急かす根拠が不明確だと期限設定自体に疑問を持つ傾向があります",
        "sensitive": "このタイプはパニックになって思考停止してしまう傾向があります",
    },
    "denial": {
        "perfectionist": "このタイプは部分的な否定を人格全体の否定として受け取る傾向があります",
        "logical": "このタイプは主観的な評価に不信感を持つ傾向があります",
        "sensitive": "このタイプは否定が続くと「見放された」と感じる傾向があります",
    },
    "repetition_blame": {
        "perfectionist": "このタイプは「自分は学べない人間だ」と自責に直結する傾向があります",
        "logical": "このタイプは感情的な繰り返し指摘を「非論理的」と受け取り壁を作る傾向があります",
        "sensitive": "このタイプは「自分はダメな人間だ」と思い込む傾向があります",
    },
    "vague_demand": {
        "perfectionist": "このタイプは基準が不明確だと「何をしても足りない」と不安が膨らむ傾向があります",
        "logical": "このタイプは曖昧な指示から目的を読み取れずストレスを感じる傾向があります",
        "sensitive": "このタイプは「今の自分じゃダメ」と自己否定につながる傾向があります",
    },
    "disappointment": {
        "perfectionist": "このタイプは「期待に応えられない自分は無価値」と存在否定に至る傾向があります",
        "logical": "このタイプは感情的な表現から改善点を読み取れず困惑する傾向があります",
        "sensitive": "このタイプは「自分のせいで悲しませた」と罪悪感に押しつぶされる傾向があります",
    },
    "sigh_tone": {
        "perfectionist": "このタイプは「呆れられている、見捨てられる」と感じて萎縮する傾向があります",
        "logical": "このタイプは感情的な態度に壁を作り、コミュニケーションが断絶する傾向があります",
        "sensitive": "このタイプはため息や呆れた態度で「怒っている」と感じフリーズする傾向があります",
    },
}


# 同じ言い方でも性格タイプによって響き方が違うため、カテゴリごとに基本スコアを補正する
TYPE_WEIGHTS = {
    "perfectionist": {"accusatory_why": 2, "repetition_blame": 1, "disappointment": 2, "denial": 1,
                      "vague_demand": 1, "common_sense_push": 0, "pressure": 0, "sigh_tone": 0},
    "logical": {"accusatory_why": -1, "repetition_blame": 0, "disappointment": -1, "denial": 0,
                "vague_demand": 2, "common_sense_push": 2, "pressure": -1, "sigh_tone": 0},
    "sensitive": {"accusatory_why": 1, "repetition_blame": 1, "disappointment": 1, "denial": 2,
                  "vague_demand": 0, "common_sense_push": 0, "pressure": 2, "sigh_tone": 2},
}

CATEGORY_EXAMPLES = {
    "accusatory_why": "「なんで〜しなかったの？」",
    "common_sense_push": "「普通はこうするでしょ」",
    "pressure": "「いつまでかかってるの」",
    "denial": "「全然できてないじゃん」",
    "repetition_blame": "「何回言ったらわかるの」",
    "vague_demand": "「もっとちゃんとやって」",
    "disappointment": "「期待してたのに残念だよ」",
    "sigh_tone": "「はぁ…もういいよ」",
}

PROFILE_QUESTIONS = [
    {"id": "q1", "text": "ミスをすると、必要以上に自分を責めているように見える", "weights": {"perfectionist": 2, "sensitive": 1}},
    {"id": "q2", "text": "仕事の完成度にこだわり、なかなか「できました」と言わない", "weights": {"perfectionist": 2}},
    {"id": "q3", "text": "指示を受けると「なぜそうするのか」理由や根拠を確認したがる", "weights": {"logical": 2}},
    {"id": "q4", "text": "気持ちに訴えるより、事実やデータで話すと納得しやすい", "weights": {"logical": 2}},
    {"id": "q5", "text": "こちらの声のトーンや表情の変化に敏感に反応する", "weights": {"sensitive": 2}},
    {"id": "q6", "text": "強めに指摘されると、黙り込んだり固まったりする", "weights": {"sensitive": 2, "perfectionist": 1}},
    {"id": "q7", "text": "困っていても、自分から相談するのが遅れがち", "weights": {"perfectionist": 1, "sensitive": 1}},
    {"id": "q8", "text": "曖昧な指示だと、動き出しが遅くなったり質問が増えたりする", "weights": {"logical": 1, "perfectionist": 1}},
]

TYPE_KEYS = ["perfectionist", "logical", "sensitive"]


# 部下の発言に出る「萎縮のサイン」。介入はせず、上司向けに画面だけでヒントを出す
SUBORDINATE_SIGNALS = [
    {
        "id": "self_blame",
        "label": "自分を責める言葉",
        "patterns": [
            r"(?:私|僕|自分|わたし|ぼく|俺)(?:が|の)(?:せい|責任|ダメ|だめ|悪い|悪かった|力不足)",
            r"(?:私|僕|自分|わたし|ぼく|俺)の.{0,8}(?:が悪くて|が悪かった|が甘かった|が足りなくて|が足りなかった)",
            r"(?:向いて(?:い)?ない|力不足|能力が(?:足りない|ない))",
            r"ダメ(?:な|だ)(?:人間|やつ|奴)",
            r"(?:どうせ|何をやっても|なにをやっても)",
        ],
        "hint": "部下さんが自分を責める言葉を使っています。まず「話してくれてありがとう」と受け止めてから、事実の話に戻すと安心しやすいです。",
        "forecast": {"perfectionist": "自分を責めているかも", "logical": "結論を急いでいるかも", "sensitive": "気持ちが沈んでいるかも"},
    },
    {
        "id": "give_up",
        "label": "あきらめの言葉",
        "patterns": [
            r"(?:もう)?(?:無理|むり)(?:です|かも|だと|っす)",
            r"(?:わかりません|分かりません|できません|わからないです|分からないです)(?:\s*$|[。…])",
        ],
        "hint": "「わからない」「無理」は、手が止まっているサインかもしれません。どこまでは分かっているかを一緒に区切ると動きやすくなります。",
        "forecast": {"perfectionist": "手が止まっているかも", "logical": "情報が足りないのかも", "sensitive": "固まっているかも"},
    },
    {
        "id": "over_apology",
        "label": "謝罪が続いている",
        "patterns": [r"(?:すみません|すいません|申し訳(?:ない|ありません|ございません)|ごめんなさい)"],
        "repeat": 2,   # 直近3回の部下の発言のうち2回以上で出たときだけ
        "hint": "謝罪が続いています。責めていないことを一言伝えると、次の言葉が出やすくなります。",
        "forecast": {"perfectionist": "身構えているかも", "logical": "身構えているかも", "sensitive": "身構えているかも"},
    },
]


def detect_subordinate_signal(text: str, recent_sub_texts: list[str], type_key: str):
    for sig in SUBORDINATE_SIGNALS:
        if not any(re.search(p, text) for p in sig["patterns"]):
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
            "hint": sig["hint"],
            "forecast": sig["forecast"].get(type_key, "様子を見たい場面です"),
        }
    return None


def category_weights(config: dict) -> dict:
    """主タイプの補正に、副タイプの補正を半分だけ加える"""
    primary = config.get("active_preset", "perfectionist")
    secondary = (config.get("profile_analysis") or {}).get("secondary")
    weights = dict(TYPE_WEIGHTS.get(primary, {}))
    if secondary and secondary != primary:
        for cat, w in TYPE_WEIGHTS.get(secondary, {}).items():
            weights[cat] = weights.get(cat, 0) + w * 0.5
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


def score_profile(answers: dict) -> dict:
    totals = {k: 0.0 for k in TYPE_KEYS}
    maxima = {k: 0.0 for k in TYPE_KEYS}
    for q in PROFILE_QUESTIONS:
        a = max(0, min(3, int(answers.get(q["id"], 0))))
        for t, w in q["weights"].items():
            totals[t] += a * w
            maxima[t] += 3 * w
    return {t: round(totals[t] / maxima[t] * 100) if maxima[t] else 0 for t in TYPE_KEYS}


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


def get_dummy_response(transcript: str, config: dict, context: list[str] = None) -> dict:
    """攻撃パターン検出 × 部下の性格補正で介入を判定する（ローカル判定エンジン）"""
    active_key = config.get("active_preset", "perfectionist")
    sensitivity = config.get("sensitivity", "medium")
    threshold = {"low": 8, "medium": 6, "high": 4}.get(sensitivity, 6)
    weights = category_weights(config)

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
        "boss_tip": pick(BOSS_TIPS[pattern_id], transcript),
        "meta_note": META_NOTES.get(pattern_id, {}).get(active_key, "配慮が必要な場面です"),
        "character_emotion": "gentle_smile",
    }
    if final >= threshold:
        result.update({
            "should_intervene": True,
            "risk_level": "high" if final >= 8 else "medium",
            "reason": f"「{pattern_group['label']}」を検出｜基本{base} 性格補正{adj_text} → {final}/10（閾値{threshold}）",
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


@app.get("/profile/questions")
async def profile_questions():
    return JSONResponse([{"id": q["id"], "text": q["text"]} for q in PROFILE_QUESTIONS])


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

    config["active_preset"] = result["primary"]
    config["profile_analysis"] = result
    save_config(config)
    return JSONResponse(result)


api_state = {"disabled": not os.environ.get("ANTHROPIC_API_KEY"), "last_error": None}


def claude_allowed(config: dict) -> bool:
    """Claudeへの送信は、設定で明示的にオンにしたときだけ行う（既定はオフ）"""
    return bool((config.get("judge") or {}).get("use_claude")) and not api_state["disabled"]


def ask_claude(config: dict, transcript: str, context: list[str]) -> dict | None:
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
            system=build_system_prompt(config),
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
    merged.update({
        "should_intervene": True,
        "risk_level": ai.get("risk_level", "medium"),
        "reframed_speech": speech if speech_is_safe(speech, config) else local["reframed_speech"],
        "boss_tip": (ai.get("boss_tip") or "").strip() or local["boss_tip"],
    })
    return merged


def judge_boss(transcript: str, context: list[str], config: dict, allow_external: bool) -> dict:
    """まず端末内で判定し、気になる言い方が見つかった発言だけClaudeに確認する"""
    local = get_dummy_response(transcript, config, context)
    result, sent = local, False
    if allow_external and local.get("attack_score", 0) > 0 and claude_allowed(config):
        sent = True
        ai = ask_claude(config, transcript, context)
        if ai:
            result = merge_claude(ai, local, config)
    return {**result, "external_sent": sent}


def cached_judge(transcript: str, context: list[str], config: dict, allow_external: bool) -> dict:
    key = (re.sub(r"[\s、。，．,.…・!！?？]", "", transcript), tuple(context), allow_external)
    now = time.monotonic()
    with judge_cache_lock:
        for k in [k for k, (exp, _) in judge_cache.items() if exp < now]:
            del judge_cache[k]
        entry = judge_cache.get(key)
        if entry is None:
            entry = (now + 30, judge_pool.submit(judge_boss, transcript, context, config, allow_external))
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
        "also_sent": ["部下の特性プロファイル", "介入感度", "キャラクター設定"],
    }


@app.post("/analyze")
def analyze(req: AnalyzeRequest):
    config = load_config()
    masked_transcript = mask_names(req.transcript, config)
    masked_context = [mask_names(c, config) for c in req.context][-6:]

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

    # 部下の発言は介入判定にかけない（ミナトが割り込む理由にならない）
    if speaker == "subordinate":
        signal = detect_subordinate_signal(masked_transcript, recent_sub, config.get("active_preset", "perfectionist"))
        if signal:
            session_log["subordinate_signals"].append({
                "timestamp": datetime.now().isoformat(),
                "transcript": req.transcript,
                "signal": signal,
            })
        return JSONResponse({
            "should_intervene": False,
            "speaker": "subordinate",
            "risk_level": "none",
            "reason": f"部下の発言（{signal['label']}）" if signal else "部下の発言のため介入判定の対象外",
            "subordinate_signal": signal,
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


@app.post("/start-session")
async def start_session():
    config = load_config()
    session_log["started_at"] = datetime.now().isoformat()
    session_log["config_snapshot"] = config
    session_log["conversations"] = []
    session_log["interventions"] = []
    session_log["subordinate_signals"] = []
    session_log["speaker_corrections"] = []
    session_log["turn_log"] = []
    session_log["metrics"] = []
    with judge_cache_lock:
        judge_cache.clear()
    return JSONResponse({"status": "session_started", "started_at": session_log["started_at"]})


class EndSessionRequest(BaseModel):
    turn_log: list[dict] = []   # 話す／見送るの判断の記録（発言の本文は含まない）
    metrics: list[dict] = []    # 音声認識の速さと区切りの計測（時間と件数だけ）


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
    }


@app.post("/end-session")
def end_session(req: EndSessionRequest | None = None):
    if not session_log["started_at"]:
        return JSONResponse({"status": "no_active_session"})

    session_log["turn_log"] = (req.turn_log if req else [])[:2000]
    session_log["metrics"] = clean_metrics(req.metrics if req else [])
    filename = f"session_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    filepath = LOGS_DIR / filename
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(log_for_disk(session_log, load_config()), f, ensure_ascii=False, indent=2)

    session_log["started_at"] = None
    return JSONResponse({"status": "saved", "file": str(filepath)})


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
<title>ミナト｜合言葉</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#FBF7F2;color:#2B2522;font-family:"Hiragino Sans","Noto Sans JP",system-ui,sans-serif}
form{width:min(92vw,380px);background:#fff;border:1px solid #EDE5DC;border-radius:20px;padding:28px 24px;display:grid;gap:14px;box-shadow:0 8px 30px rgba(43,37,34,.06)}
h1{margin:0;font-size:20px}p{margin:0;font-size:14px;color:#6b625b;line-height:1.7}
input{font:inherit;font-size:16px;padding:12px 14px;border:1px solid #D9CDC1;border-radius:12px}
button{font:inherit;font-weight:700;padding:13px;border:0;border-radius:999px;background:#E9785F;color:#fff}
.err{color:#D2504B;font-weight:600}
</style></head><body>
<form method="post" action="/login">
<h1>ミナト（1on1見守りAI）</h1>
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

app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")
