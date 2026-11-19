"""公開サーバー用のアクセス制限（ホスト名・合言葉・公開モード）のテスト。  python3 tools/test_access.py
環境変数で挙動が変わるため、ケースごとに別プロセスで確かめる。"""
import base64
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CODE = """
import base64, os, sys
sys.path.insert(0, ".")
from fastapi.testclient import TestClient
import main
host, user_pw = os.environ["T_HOST"], os.environ.get("T_PW")
h = {}
if user_pw is not None:
    h["Authorization"] = "Basic " + base64.b64encode(("u:" + user_pw).encode()).decode()
r = TestClient(main.app, base_url="http://" + host).get("/config", headers=h)
print(r.status_code, r.headers.get("www-authenticate", ""))
"""
failed = 0


def run(host, pw=None, **env):
    e = {k: v for k, v in os.environ.items() if k not in ("ACCESS_PASSWORD", "PUBLIC_MODE", "ALLOWED_HOST_SUFFIXES")}
    e.update({"T_HOST": host, **{k: v for k, v in env.items()}})
    if pw is not None:
        e["T_PW"] = pw
    out = subprocess.run([sys.executable, "-c", CODE], cwd=ROOT, env=e, capture_output=True, text=True)
    return out.stdout.split()[0] if out.stdout.strip() else "ERR:" + out.stderr[-200:]


def check(name, got, want):
    global failed
    ok = got == want
    failed += 0 if ok else 1
    print(("  ok   " if ok else "  NG   ") + name + ("" if ok else f"  （結果 {got}、期待 {want}）"))


check("既定：このPCからは通る", run("127.0.0.1"), "200")
check("既定：外部ホスト名は拒否", run("x.onrender.com"), "403")
check("合言葉あり：合言葉なしは401", run("127.0.0.1", ACCESS_PASSWORD="pw"), "401")
check("合言葉あり：誤りは401", run("127.0.0.1", "bad", ACCESS_PASSWORD="pw"), "401")
check("合言葉あり：正しければ200", run("127.0.0.1", "pw", ACCESS_PASSWORD="pw"), "200")
check("公開モードで合言葉が未設定：503", run("x.onrender.com", PUBLIC_MODE="1", ALLOWED_HOST_SUFFIXES=".onrender.com"), "503")
render = dict(PUBLIC_MODE="1", ALLOWED_HOST_SUFFIXES=".onrender.com", ACCESS_PASSWORD="pw")
check("Render想定：合言葉なしは401", run("x.onrender.com", **render), "401")
check("Render想定：正しい合言葉は200", run("x.onrender.com", "pw", **render), "200")
check("Render想定：別ホスト名は合言葉が正しくても403", run("evil.example", "pw", **render), "403")
check("Render想定：似た別ドメインは403", run("evilonrender.com", "pw", **render), "403")
print("\n失敗 0" if not failed else f"\n失敗 {failed}")
sys.exit(1 if failed else 0)
