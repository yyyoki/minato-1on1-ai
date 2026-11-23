"""Zoom連携：話者名つきの発言を受け取り、上司／部下を決めて面談画面へ流す。

- /ingest       … 話者名つきの発言の入口（Zoom RTMS・模擬データ共通）
- /events       … 面談画面への通り道（Server-Sent Events）
- /zoom/webhook … Zoomからの通知（URL確認・署名検証・RTMSの開始/終了）
- /zoom/status  … 設定と接続の状態

RTMSの接続部分は Zoom 公式の Python クイックスタート（rtms-quickstart-py）に合わせているが、
実際の Zoom アカウントでの動作は未検証。
"""
import asyncio
import hashlib
import hmac
import json
import os
import re
import threading
import time
import unicodedata

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

router = APIRouter()

MERGE_GAP_SEC = 1.2   # 同じ人の文字起こしが、これだけ途切れたら1つの発言として確定する

_load_config = None   # main.py から渡される
_loop: asyncio.AbstractEventLoop | None = None
_subscribers: set[asyncio.Queue] = set()
_buffers: dict[str, dict] = {}
_status = {"last_event": None, "active_streams": 0, "last_error": None}
_clients: dict[str, object] = {}
_clients_lock = threading.Lock()


def setup(load_config):
    global _load_config
    _load_config = load_config


def _ensure_loop():
    """RTMS のスレッドからサーバーのイベントループへ戻すために、ループを覚えておく"""
    global _loop
    if _loop is None:
        _loop = asyncio.get_running_loop()


def zoom_config() -> dict:
    return (_load_config() or {}).get("zoom") or {}


def normalize(name: str) -> str:
    """全角/半角・空白・大文字小文字の違いを無視して比べる"""
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", name or "")).lower()


def resolve_speaker(user_name: str) -> str | None:
    """Zoomの表示名 → boss / subordinate / ignore / None（未登録）"""
    cfg = zoom_config()
    n = normalize(user_name)
    if not n:
        return None
    ignore = [normalize(x) for x in re.split(r"[,、\n]", cfg.get("ignore_names", "")) if x.strip()]
    if n in ignore:
        return "ignore"
    if n == normalize(cfg.get("boss_name", "")):
        return "boss"
    if n == normalize(cfg.get("subordinate_name", "")):
        return "subordinate"
    return None


# ---------- 面談画面への配信 ----------
def _publish(event: dict):
    for q in list(_subscribers):
        q.put_nowait(event)


def _flush(user_name: str):
    buf = _buffers.pop(user_name, None)
    if not buf:
        return
    if buf.get("timer"):
        buf["timer"].cancel()
    text = buf["text"].strip()
    if not text:
        return
    speaker = resolve_speaker(user_name)
    if speaker == "ignore":
        return
    _publish({
        "type": "utterance",
        "speaker": speaker,
        "user_name": user_name,
        "text": text,
        "source": buf["source"],
        "at": time.time(),
    })


def _ingest(user_name: str, text: str, source: str, final: bool):
    speaker = resolve_speaker(user_name)
    if speaker == "ignore":
        return
    # 別の人が話し始めたら、前の人の発言は確定させる
    for other in [u for u in _buffers if u != user_name]:
        _flush(other)
    buf = _buffers.setdefault(user_name, {"text": "", "source": source, "timer": None})
    prev = buf["text"]
    # 途中経過が「伸びていく」形で届いても、細切れで届いても扱えるようにする
    if text.startswith(prev):
        buf["text"] = text
    elif not prev.endswith(text):
        buf["text"] = prev + text
    if buf["timer"]:
        buf["timer"].cancel()
    # 文字が届いている＝誰かが話している。view viewが話し出さないための合図（本文は含めず、文字数だけ）
    _publish({"type": "activity", "speaker": speaker, "chars": len(re.sub(r"\s", "", buf["text"])), "at": time.time()})
    if final:
        _flush(user_name)
    else:
        buf["timer"] = _loop.call_later(MERGE_GAP_SEC, _flush, user_name)


def ingest_threadsafe(user_name: str, text: str, source: str = "zoom", final: bool = False):
    """RTMS のコールバック（別スレッド）からも呼べる入口"""
    if _loop is None:
        return
    _loop.call_soon_threadsafe(_ingest, user_name, text, source, final)


class IngestRequest(BaseModel):
    user_name: str
    text: str
    source: str = "external"
    final: bool = False


@router.post("/ingest")
async def ingest(req: IngestRequest):
    _ensure_loop()
    _ingest(req.user_name, req.text, req.source, req.final)
    return JSONResponse({"status": "accepted", "speaker": resolve_speaker(req.user_name)})


@router.get("/events")
async def events(request: Request):
    _ensure_loop()
    q: asyncio.Queue = asyncio.Queue()
    _subscribers.add(q)

    async def stream():
        try:
            yield "retry: 2000\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=15)
                    yield "data: " + json.dumps(ev, ensure_ascii=False) + "\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            _subscribers.discard(q)

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


# ---------- Zoom Webhook / RTMS ----------
def _webhook_secret() -> str:
    return os.environ.get("ZOOM_WEBHOOK_SECRET_TOKEN", "")


def _valid_signature(request: Request, body: bytes) -> bool:
    secret = _webhook_secret()
    if not secret:
        return False
    ts = request.headers.get("x-zm-request-timestamp", "")
    sig = request.headers.get("x-zm-signature", "")
    expected = "v0=" + hmac.new(secret.encode(), f"v0:{ts}:{body.decode()}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)


def _start_rtms(payload: dict):
    try:
        import rtms  # pip install rtms（Zoom公式SDK）
    except ImportError:
        _status["last_error"] = "rtms SDK が入っていません（pip install rtms）"
        return
    stream_id = payload.get("rtms_stream_id")
    client = rtms.Client()

    @client.on_transcript_data
    def _on_transcript(data, _size, _timestamp, metadata):
        name = getattr(metadata, "userName", None) or getattr(metadata, "user_name", "") or ""
        text = data.decode("utf-8", "ignore") if isinstance(data, (bytes, bytearray)) else str(data)
        ingest_threadsafe(name, text, "zoom")

    with _clients_lock:
        _clients[stream_id] = client
        _status["active_streams"] = len(_clients)
    if not client.join(payload):
        _status["last_error"] = "RTMS への接続に失敗しました"


def _stop_rtms(payload: dict):
    with _clients_lock:
        client = _clients.pop(payload.get("rtms_stream_id"), None)
        _status["active_streams"] = len(_clients)
    if client:
        try:
            client.leave()
        except Exception as e:  # SDK側の終了エラーで落とさない
            _status["last_error"] = f"RTMS の終了でエラー: {e}"


@router.post("/zoom/webhook")
async def zoom_webhook(request: Request):
    _ensure_loop()
    body = await request.body()
    try:
        data = json.loads(body or b"{}")
    except ValueError:
        return JSONResponse({"error": "bad json"}, status_code=400)
    event = data.get("event")
    payload = data.get("payload") or {}

    # イベント通知先URLの確認（Zoomが登録時・定期的に送ってくる）
    if event == "endpoint.url_validation":
        secret = _webhook_secret()
        if not secret:
            return JSONResponse({"error": "ZOOM_WEBHOOK_SECRET_TOKEN が未設定です"}, status_code=500)
        plain = payload.get("plainToken", "")
        encrypted = hmac.new(secret.encode(), plain.encode(), hashlib.sha256).hexdigest()
        return JSONResponse({"plainToken": plain, "encryptedToken": encrypted})

    if not _valid_signature(request, body):
        return JSONResponse({"error": "invalid signature"}, status_code=401)

    _status["last_event"] = {"event": event, "at": time.time()}
    if event == "meeting.rtms_started":
        threading.Thread(target=_start_rtms, args=(payload,), daemon=True).start()
        _publish({"type": "zoom", "state": "started"})
    elif event == "meeting.rtms_stopped":
        _stop_rtms(payload)
        _publish({"type": "zoom", "state": "stopped"})
    return JSONResponse({"status": "ok"})


@router.get("/zoom/status")
async def zoom_status():
    try:
        import importlib.util
        sdk = importlib.util.find_spec("rtms") is not None
    except (ImportError, ValueError):
        sdk = False
    cfg = zoom_config()
    return JSONResponse({
        "enabled": bool(cfg.get("enabled")),
        "rtms_sdk_installed": sdk,
        "webhook_secret_set": bool(_webhook_secret()),
        "client_set": bool(os.environ.get("ZM_RTMS_CLIENT") and os.environ.get("ZM_RTMS_SECRET")),
        "active_streams": _status["active_streams"],
        "last_event": _status["last_event"],
        "last_error": _status["last_error"],
        "listeners": len(_subscribers),
    })
