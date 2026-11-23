"""view view用PC（別のパソコン）との中継のテスト。  python3 tools/test_stage.py
- ほかのPCから届くのは、合言葉つきのステージ画面・その部品・声の取得・報告だけか
- 名乗り（Host）を偽っても、設定や会話には届かないか
- ステージ画面へ送る指示・受け取る報告の中身が、決めた形に絞られているか
環境変数で挙動が変わるため、ケースごとに別プロセスで確かめる。"""
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CODE = r"""
import json, os, sys
sys.path.insert(0, ".")
from fastapi.testclient import TestClient
import main, stage_bridge
spec = json.loads(os.environ["T_SPEC"])
key = stage_bridge.pairing_key()
c = TestClient(main.app, base_url="http://" + spec["host"], client=(spec["peer"], 50000), follow_redirects=False)
out = []
for s in spec["steps"]:
    path = s["path"].replace("{KEY}", key)
    h = dict(s.get("headers", {}))
    if s.get("method") == "POST":
        r = c.post(path, json=s.get("json", {}), headers=h)
    else:
        r = c.get(path, headers=h)
    out.append({"status": r.status_code, "cookie": "minato_stage=" in r.headers.get("set-cookie", ""), "body": r.text[:400]})
    if s.get("keep_cookie") and out[-1]["cookie"]:
        c.cookies.set("minato_stage", r.cookies.get("minato_stage"))
print(json.dumps(out))
"""
failed = 0


def run(host, peer, steps, **env):
    e = {k: v for k, v in os.environ.items() if k not in ("ACCESS_PASSWORD", "PUBLIC_MODE", "ALLOWED_HOST_SUFFIXES", "STAGE_LAN")}
    e.update(env)
    e["T_SPEC"] = json.dumps({"host": host, "peer": peer, "steps": steps})
    out = subprocess.run([sys.executable, "-c", CODE], cwd=ROOT, env=e, capture_output=True, text=True)
    try:
        return json.loads(out.stdout.strip().splitlines()[-1])
    except Exception:
        print("実行エラー:", out.stderr[-500:])
        return [{"status": "ERR", "cookie": False, "body": ""}] * len(steps)


def check(name, cond, detail=None):
    global failed
    failed += 0 if cond else 1
    print(("  ok   " if cond else "  NG   ") + name + ("" if cond else f"  （{detail}）"))


LAN = dict(STAGE_LAN="1")
HOST, PEER = "192.168.1.5:8001", "192.168.1.20"
SAME = {"Origin": "http://192.168.1.5:8001"}

print("ほかのPC（同じWi-Fi）からの接続：STAGE_LAN=1")
r = run(HOST, PEER, [{"path": "/stage"}, {"path": "/stage?key=wrongwrong"}, {"path": "/stage?key={KEY}", "keep_cookie": True},
                     {"path": "/static/stage.js"}, {"path": "/static/audio.js"}, {"path": "/tts/status"},
                     {"method": "POST", "path": "/stage/report", "json": {"event": "start", "id": 3}, "headers": SAME},
                     {"method": "POST", "path": "/stage/report", "json": {"event": "start", "id": 3}, "headers": {"Origin": "http://evil.example"}}], **LAN)
check("合言葉なし・違う合言葉のステージ画面は403", [x["status"] for x in r[:2]] == [403, 403], r[:2])
check("正しい合言葉なら200で、Cookieを発行", r[2]["status"] == 200 and r[2]["cookie"] and "view view｜ステージ" in r[2]["body"], r[2])
check("Cookieで、ステージ画面の部品と声の取得に届く", [x["status"] for x in r[3:6]] == [200, 200, 200], r[3:6])
check("同じ画面からの報告は200", r[6]["status"] == 200, r[6])
check("別サイトからの報告は403", r[7]["status"] == 403, r[7])

r = run(HOST, PEER, [{"path": "/stage?key={KEY}", "keep_cookie": True}, {"path": "/config"}, {"path": "/"}, {"path": "/static/app.js"},
                     {"path": "/stage/info"}, {"path": "/stage/feed"},
                     {"method": "POST", "path": "/stage/command", "json": {"type": "test"}, "headers": SAME},
                     {"method": "POST", "path": "/analyze", "json": {"transcript": "x"}, "headers": SAME},
                     {"path": "/config", "headers": {"Host": "127.0.0.1:8001"}}], **LAN)
check("合言葉があっても、設定・面談画面・アプリ本体には届かない", [x["status"] for x in r[1:4]] == [403, 403, 403], r[1:4])
check("合言葉・報告の通り道・指示の送信は、ほかのPCから使えない", [x["status"] for x in r[4:7]] == [403, 403, 403], r[4:7])
check("判定にも届かない", r[7]["status"] == 403, r[7])
check("名乗り（Host）を「このPC」と偽っても403", r[8]["status"] == 403, r[8])

r = run(HOST, PEER, [{"path": "/stage?key=bad" + str(i)} for i in range(11)], **LAN)
check("合言葉の間違いが10回続くと、11回目は429", [x["status"] for x in r][-2:] == [403, 429], [x["status"] for x in r])

print("\nこのPCからの接続")
r = run("127.0.0.1:8001", "127.0.0.1", [{"path": "/config"}, {"path": "/stage"}, {"path": "/stage/info"}], **LAN)
info = json.loads(r[2]["body"]) if r[2]["status"] == 200 else {}
check("STAGE_LAN=1 でも、このPCからは今まで通り使える", r[0]["status"] == 200 and r[1]["status"] == 200, r[:2])
check("このPCでは合言葉とアドレスを確認できる", info.get("lan_enabled") is True and len(info.get("key", "")) == 10, info)

print("\nSTAGE_LAN なし（ふだんの起動）")
r = run(HOST, PEER, [{"path": "/stage?key={KEY}"}, {"path": "/config"}])
check("ほかのPCからは、合言葉があってもすべて403", [x["status"] for x in r] == [403, 403], r)
r = run("127.0.0.1:8001", "127.0.0.1", [{"path": "/stage/info"}])
check("ふだんの起動では、ほかのPCから開けないことを画面に伝える", json.loads(r[0]["body"]).get("lan_enabled") is False, r)
r = run("x.onrender.com", PEER, [{"path": "/stage?key={KEY}"}], PUBLIC_MODE="1", ALLOWED_HOST_SUFFIXES=".onrender.com", ACCESS_PASSWORD="pw", STAGE_LAN="1")
check("公開サーバー（PUBLIC_MODE）では、ステージ画面の合言葉だけでは開けない", r[0]["status"] in (401, 303), r)

print("\n指示と報告の中身")
sys.path.insert(0, str(ROOT))
import stage_bridge as sb  # noqa: E402

c = sb.clean_command({"type": "say", "id": 4, "parts": ["あの、", "責める話じゃないと思うんです。", "", 5], "choice": "vv:8",
                      "bubble": {"cushion": "あの、", "text": "x" * 500, "tip": "ヒント", "profile": "完璧主義"}, "extra": 1})
check("話す指示は、決めた項目だけ残し、長すぎる文は切る", c and c["parts"] == ["あの、", "責める話じゃないと思うんです。"] and len(c["bubble"]["text"]) == 200
      and set(c["bubble"]) == {"cushion", "text", "tip", "intent", "label"} and "profile" not in c["bubble"] and "extra" not in c, c)
check("声の指定が決めた形でなければ送らない", sb.clean_command({"type": "say", "id": 1, "parts": ["a"], "choice": "<script>"}) is None)
check("番号のない話す指示は送らない", sb.clean_command({"type": "say", "parts": ["a"], "choice": ""}) is None)
check("知らない表情・知らない指示は送らない", sb.clean_command({"type": "state", "name": "angry"}) is None and sb.clean_command({"type": "eval"}) is None)
shown = sb.clean_command({"type": "show", "bubble": {"label": "受け取り方のヒント", "text": "起きたことと、自分の評価は分けて見てみませんか？", "intent": "上司さんが伝えたいこと：早めに相談", "profile": "x"}})
check("声なしの吹き出し（show）は、決めた項目だけ送る", shown and shown["bubble"]["label"] == "受け取り方のヒント" and "profile" not in shown["bubble"], shown)
check("本文のない吹き出しは送らない", sb.clean_command({"type": "show", "bubble": {"label": "x"}}) is None)
rep = sb.clean_report({"event": "start", "id": 2, "kind": "vv", "text": "盗み見"})
check("報告は決めた項目だけ", rep == {"type": "report", "event": "start", "id": 2, "kind": "vv"}, rep)
check("知らない報告は受け取らない", sb.clean_report({"event": "transcript"}) is None)


class Sink:
    def __init__(self):
        self.items = []

    def put_nowait(self, x):
        self.items.append(x)


from fastapi.testclient import TestClient  # noqa: E402
import main  # noqa: E402

stage_sink, boss_sink = Sink(), Sink()
sb._stage_subs.add(stage_sink)
sb._boss_subs.add(boss_sink)
tc = TestClient(main.app, base_url="http://127.0.0.1:8001", client=("127.0.0.1", 50000))
d = tc.post("/stage/command", json={"type": "say", "id": 9, "parts": ["こんにちは"], "choice": "", "bubble": {"text": "こんにちは"}}).json()
check("面談画面の指示が、ステージ画面へ届く", d.get("delivered") == 1 and stage_sink.items[-1]["type"] == "say" and stage_sink.items[-1]["id"] == 9, (d, stage_sink.items))
tc.post("/stage/report", json={"event": "ready", "unlocked": True})
sb._announce_stages()  # 面談画面が新しくつながった時と同じ知らせ
check("あとから開いた面談画面にも「開始する」が押されていることを伝える", boss_sink.items[-1] == {"type": "stage", "connected": 1, "unlocked": True}, boss_sink.items[-1:])
tc.post("/stage/report", json={"event": "end", "id": 9})
check("ステージ画面の報告が、面談画面へ届く", boss_sink.items[-1] == {"type": "report", "event": "end", "id": 9}, boss_sink.items)
import tempfile  # noqa: E402
sb.KEY_PATH = Path(tempfile.mkdtemp()) / "stage_key"   # 本物の合言葉（view view用PCのアドレス）を変えない
tc.post("/stage/rotate")
check("合言葉を作り直すと、開いていたステージ画面の接続を切る", stage_sink.items[-1] is None, stage_sink.items[-1:])
sb._stage_subs.discard(stage_sink)
sb._boss_subs.discard(boss_sink)

print("\n失敗 0" if not failed else f"\n失敗 {failed}")
sys.exit(1 if failed else 0)
