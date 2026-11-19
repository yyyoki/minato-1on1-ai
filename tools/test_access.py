"""公開サーバー用のアクセス制限（ホスト名・合言葉・ログイン画面・公開モード）のテスト。  python3 tools/test_access.py
環境変数で挙動が変わるため、ケースごとに別プロセスで確かめる。"""
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CODE = r"""
import base64, json, os, sys
sys.path.insert(0, ".")
from fastapi.testclient import TestClient
import main
spec = json.loads(os.environ["T_SPEC"])
c = TestClient(main.app, base_url="http://" + spec["host"], follow_redirects=False)
def call(s):
    h = dict(s.get("headers", {}))
    if "basic" in s:
        h["Authorization"] = "Basic " + base64.b64encode(("u:" + s["basic"]).encode()).decode()
    if s.get("method", "GET") == "POST":
        return c.post(s["path"], content=s.get("body", ""), headers={"Content-Type": "application/x-www-form-urlencoded", **h})
    return c.get(s["path"], headers=h)
out = []
for s in spec["steps"]:
    r = call(s)
    out.append({"status": r.status_code, "location": r.headers.get("location", ""), "cookie": "minato_auth=" in r.headers.get("set-cookie", ""),
                "httponly": "httponly" in r.headers.get("set-cookie", "").lower(), "auth": r.headers.get("www-authenticate", ""), "body": r.text[:3000]})
    if s.get("keep_cookie") and out[-1]["cookie"]:
        c.cookies.set("minato_auth", r.cookies.get("minato_auth"))
print(json.dumps(out))
"""
failed = 0


def run(host, steps, **env):
    e = {k: v for k, v in os.environ.items() if k not in ("ACCESS_PASSWORD", "PUBLIC_MODE", "ALLOWED_HOST_SUFFIXES")}
    e.update(env)
    e["T_SPEC"] = json.dumps({"host": host, "steps": steps})
    out = subprocess.run([sys.executable, "-c", CODE], cwd=ROOT, env=e, capture_output=True, text=True)
    try:
        return json.loads(out.stdout.strip().splitlines()[-1])
    except Exception:
        print("実行エラー:", out.stderr[-300:])
        return [{"status": "ERR"}] * len(steps)


def check(name, cond, detail=None):
    global failed
    failed += 0 if cond else 1
    print(("  ok   " if cond else "  NG   ") + name + ("" if cond else f"  （{detail}）"))


HTML = {"Accept": "text/html"}
RENDER = dict(PUBLIC_MODE="1", ALLOWED_HOST_SUFFIXES=".onrender.com", ACCESS_PASSWORD="pw")

r = run("127.0.0.1", [{"path": "/config"}])
check("既定：このPCからは通る", r[0]["status"] == 200, r)
r = run("x.onrender.com", [{"path": "/config"}])
check("既定：外部ホスト名は拒否", r[0]["status"] == 403, r)

r = run("127.0.0.1", [{"path": "/config"}, {"path": "/config", "basic": "bad"}, {"path": "/config", "basic": "pw"}], ACCESS_PASSWORD="pw")
check("合言葉あり：APIは、合言葉なし・誤りは401、正しければ200（curl等のBasic）", [x["status"] for x in r] == [401, 401, 200], r)
check("合言葉あり：APIの401には Basic の案内を付ける", "Basic" in r[0]["auth"], r)

r = run("127.0.0.1", [{"path": "/", "headers": HTML}], ACCESS_PASSWORD="pw")
check("画面で開くと、ログイン画面へ誘導（303）", r[0]["status"] == 303 and r[0]["location"] == "/login", r)
r = run("127.0.0.1", [{"path": "/login"}], ACCESS_PASSWORD="pw")
check("ログイン画面は合言葉なしで表示でき、入力欄がある", r[0]["status"] == 200 and 'type="password"' in r[0]["body"], r)

steps = [
    {"method": "POST", "path": "/login", "body": "password=bad"},
    {"method": "POST", "path": "/login", "body": "password=pw", "keep_cookie": True},
    {"path": "/config"},
    {"path": "/", "headers": HTML},
]
r = run("127.0.0.1", steps, ACCESS_PASSWORD="pw")
check("誤った合言葉：401でCookieなし", r[0]["status"] == 401 and not r[0]["cookie"], r[0])
check("正しい合言葉：303でCookieを発行（HttpOnly）", r[1]["status"] == 303 and r[1]["cookie"] and r[1]["httponly"], r[1])
check("ログイン後：Cookieだけで、APIも画面も通る", r[2]["status"] == 200 and r[3]["status"] == 200, r[2:])

r = run("127.0.0.1", [{"path": "/config", "headers": {"Cookie": "minato_auth=forged"}}], ACCESS_PASSWORD="pw")
check("偽のCookieは拒否", r[0]["status"] == 401, r)

r = run("127.0.0.1", [{"method": "POST", "path": "/login", "body": "password=bad"}] * 9, ACCESS_PASSWORD="pw")
check("失敗が8回続くと、9回目は429（総当たり対策）", [x["status"] for x in r][-2:] == [401, 429], [x["status"] for x in r])

r = run("x.onrender.com", [{"path": "/config"}], PUBLIC_MODE="1", ALLOWED_HOST_SUFFIXES=".onrender.com")
check("公開モードで合言葉が未設定：503", r[0]["status"] == 503, r)
r = run("x.onrender.com", [{"path": "/", "headers": HTML}, {"path": "/config"}, {"path": "/config", "basic": "pw"}], **RENDER)
check("Render想定：画面はログインへ、APIは401、Basicなら200", [x["status"] for x in r] == [303, 401, 200], r)
r = run("evil.example", [{"path": "/login"}, {"path": "/config", "basic": "pw"}], **RENDER)
check("Render想定：別ホスト名は、ログイン画面も含めて403", [x["status"] for x in r] == [403, 403], r)
r = run("evilonrender.com", [{"path": "/login"}], **RENDER)
check("Render想定：似た別ドメインは403", r[0]["status"] == 403, r)
r = run("x.onrender.com", [{"method": "POST", "path": "/login", "body": "password=pw", "headers": {"Origin": "https://evil.example"}}], **RENDER)
check("Render想定：別サイトからのログイン送信は403", r[0]["status"] == 403, r)

print("\n失敗 0" if not failed else f"\n失敗 {failed}")
sys.exit(1 if failed else 0)
