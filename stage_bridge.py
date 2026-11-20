"""ミナト用PC（別のパソコン）との中継。

ミナト用PCのChromeでステージ画面（/stage）を開き、会議に「ミナト」として参加させる。
聞き取りと判定は上司のPC（このサーバー）で行い、「話す」と決めた文だけをステージ画面へ送る。

- /stage          … ステージ画面（ミナト用PC）。ほかのPCから開くときは合言葉が必要
- /stage/events   … ステージ画面への指示（Server-Sent Events）
- /stage/report   … ステージ画面からの報告（話し始めた・話し終えた 等）
- /stage/command  … 面談画面からの指示（このPCからのみ）
- /stage/feed     … 面談画面への報告の通り道（このPCからのみ）
- /stage/info     … 合言葉とアドレス（このPCからのみ）
- /stage/rotate   … 合言葉を作り直す（このPCからのみ）

ほかのPCからの接続を受け付けるのは、STAGE_LAN=1 で起動したときだけ（main.py の LocalOnly が制御する）。
"""
import asyncio
import hmac
import json
import os
import re
import secrets
import socket
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

router = APIRouter()

BASE_DIR = Path(__file__).parent
KEY_PATH = BASE_DIR / ".stage_key"
COOKIE = "minato_stage"
KEY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"   # 読み間違えやすい文字（0/o・1/l/i）を除く
KEY_LEN = 10

_stage_subs: set = set()   # ステージ画面（ミナト用PC）
_boss_subs: set = set()    # 面談画面（上司のPC）
_key: str | None = None
_stage_unlocked = False    # ミナト用PCで「開始する」が押されているか（あとから開いた面談画面にも伝える）


# ---------- 合言葉 ----------
def _new_key() -> str:
    return "".join(secrets.choice(KEY_ALPHABET) for _ in range(KEY_LEN))


def pairing_key() -> str:
    global _key
    if _key is None:
        try:
            k = KEY_PATH.read_text().strip()
            _key = k if re.fullmatch(f"[{KEY_ALPHABET}]{{{KEY_LEN}}}", k) else None
        except OSError:
            _key = None
        if _key is None:
            rotate_key()
    return _key


def rotate_key() -> str:
    global _key
    _key = _new_key()
    try:
        KEY_PATH.write_text(_key)
        os.chmod(KEY_PATH, 0o600)
    except OSError:
        pass  # 保存できなくても、この起動の間は使える
    return _key


def key_ok(given: str | None) -> bool:
    return bool(given) and hmac.compare_digest(given.encode(), pairing_key().encode())


def cookie_token() -> str:
    return hmac.new(pairing_key().encode(), b"minato-stage-v1", "sha256").hexdigest()


def cookie_ok(header: str | None) -> bool:
    for part in (header or "").split(";"):
        k, _, v = part.strip().partition("=")
        if k == COOKIE and hmac.compare_digest(v, cookie_token()):
            return True
    return False


def lan_addresses() -> list[str]:
    """このPCの同じネットワーク内でのアドレス（ミナト用PCに開いてもらう先）"""
    ips: list[str] = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))  # 実際には送信しない。経路からアドレスを知るだけ
        ips.append(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in ips:
                ips.append(ip)
    except OSError:
        pass
    return [ip for ip in ips if not ip.startswith("127.")]


def lan_enabled() -> bool:
    return os.environ.get("STAGE_LAN") == "1" and os.environ.get("PUBLIC_MODE") != "1"


# ---------- 配信 ----------
def _publish(subs: set, event: dict):
    for q in list(subs):
        q.put_nowait(event)


def _sse(request: Request, subs: set, on_change=None):
    q: asyncio.Queue = asyncio.Queue()
    subs.add(q)
    if on_change:
        on_change()

    async def stream():
        try:
            yield "retry: 2000\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=15)
                    if ev is None:  # 合言葉の作り直しで締め出された
                        break
                    yield "data: " + json.dumps(ev, ensure_ascii=False) + "\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            subs.discard(q)
            if on_change:
                on_change()

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


def _announce_stages():
    global _stage_unlocked
    if not _stage_subs:
        _stage_unlocked = False
    _publish(_boss_subs, {"type": "stage", "connected": len(_stage_subs), "unlocked": _stage_unlocked})


# ---------- 指示の中身を確かめる（ステージ画面に送ってよいものだけ通す） ----------
CHOICE_RE = re.compile(r"(vv:\d{1,6}|br:[^\n<>]{1,100})?")
STATES = {"idle", "thinking", "raise", "lower", "happy"}


def _text(v, limit: int) -> str:
    return v.strip()[:limit] if isinstance(v, str) else ""


BUBBLE_KEYS = ("cushion", "text", "tip", "intent", "label")


def clean_bubble(bubble: dict) -> dict:
    return {k: _text(bubble.get(k), 200) for k in BUBBLE_KEYS}


def clean_command(body: dict) -> dict | None:
    kind = body.get("type")
    if kind == "say" or kind == "preload":
        parts = [_text(p, 120) for p in (body.get("parts") or [])[:8]]
        parts = [p for p in parts if p]
        choice = _text(body.get("choice"), 104)
        if not parts or not CHOICE_RE.fullmatch(choice):
            return None
        out = {"type": kind, "parts": parts, "choice": choice}
        if kind == "say":
            if not isinstance(body.get("id"), int):
                return None
            bubble = body.get("bubble") if isinstance(body.get("bubble"), dict) else {}
            out["id"] = body["id"]
            out["bubble"] = clean_bubble(bubble)
        return out
    if kind == "show":
        bubble = clean_bubble(body.get("bubble") if isinstance(body.get("bubble"), dict) else {})
        return {"type": "show", "bubble": bubble} if bubble["text"] else None
    if kind == "cancel":
        return {"type": "cancel"}
    if kind == "duck":
        return {"type": "duck", "on": bool(body.get("on"))}
    if kind == "state" and body.get("name") in STATES:
        return {"type": "state", "name": body["name"]}
    if kind == "test":
        return {"type": "test"}
    return None


REPORTS = {"ready", "start", "end", "fail", "cancelled", "test"}


def clean_report(body: dict) -> dict | None:
    ev = body.get("event")
    if ev not in REPORTS:
        return None
    out = {"type": "report", "event": ev}
    if isinstance(body.get("id"), int):
        out["id"] = body["id"]
    if ev == "ready":
        out["unlocked"] = bool(body.get("unlocked"))
    if isinstance(body.get("kind"), str) and body["kind"] in ("vv", "browser"):
        out["kind"] = body["kind"]
    return out


# ---------- ステージ画面（ミナト用PC） ----------
@router.get("/stage")
async def stage_page(request: Request):
    resp = FileResponse(BASE_DIR / "static" / "stage.html")
    if key_ok(request.query_params.get("key")):
        # 以後は合言葉をアドレスに付けなくても、部品・声・報告に届くようにする
        resp.set_cookie(COOKIE, cookie_token(), httponly=True, samesite="strict", max_age=30 * 86400)
    return resp


@router.get("/stage/events")
async def stage_events(request: Request):
    return _sse(request, _stage_subs, _announce_stages)


@router.post("/stage/report")
async def stage_report(request: Request):
    try:
        body = await request.json()
    except ValueError:
        return JSONResponse({"error": "bad json"}, status_code=400)
    global _stage_unlocked
    ev = clean_report(body if isinstance(body, dict) else {})
    if not ev:
        return JSONResponse({"error": "bad report"}, status_code=400)
    if ev["event"] == "ready":
        _stage_unlocked = ev["unlocked"]
    _publish(_boss_subs, ev)
    return JSONResponse({"status": "ok"})


# ---------- 面談画面（上司のPC） ----------
@router.post("/stage/command")
async def stage_command(request: Request):
    try:
        body = await request.json()
    except ValueError:
        return JSONResponse({"error": "bad json"}, status_code=400)
    cmd = clean_command(body if isinstance(body, dict) else {})
    if not cmd:
        return JSONResponse({"error": "bad command"}, status_code=400)
    _publish(_stage_subs, cmd)
    return JSONResponse({"delivered": len(_stage_subs)})


@router.get("/stage/feed")
async def stage_feed(request: Request):
    resp = _sse(request, _boss_subs)
    _announce_stages()
    return resp


@router.get("/stage/info")
async def stage_info(request: Request):
    port = request.url.port or int(os.environ.get("PORT", "8001"))
    key = pairing_key()
    ips = lan_addresses() if lan_enabled() else []
    return JSONResponse({
        "lan_enabled": lan_enabled(),
        "key": key,
        "urls": [f"http://{ip}:{port}/stage?key={key}" for ip in ips],
        "local_url": f"http://127.0.0.1:{port}/stage",
        "connected": len(_stage_subs),
    })


@router.post("/stage/rotate")
async def stage_rotate():
    rotate_key()
    # 古い合言葉で開いていた画面は、今の接続も切る
    for q in list(_stage_subs):
        q.put_nowait(None)
    return JSONResponse({"status": "rotated"})
