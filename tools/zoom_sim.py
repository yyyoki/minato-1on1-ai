"""Zoom RTMS の「話者名つき文字起こし」を模擬して /ingest に流す。
Zoomアカウントが無くても、面談画面がZoomモードでどう動くかを確認できる。

使い方:
  1. 設定でZoom連携をオンにし、上司・部下・無視する表示名を登録して面談を開始
  2. python3 tools/zoom_sim.py            （登録した表示名を使う）
     python3 tools/zoom_sim.py --fast     （待ち時間を短くする）
"""
import json
import sys
import time
import urllib.request

BASE = "http://127.0.0.1:8001"


def post(path, body):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req))


def main():
    fast = "--fast" in sys.argv
    cfg = json.load(urllib.request.urlopen(BASE + "/config")).get("zoom") or {}
    boss = cfg.get("boss_name") or "上司"
    sub = cfg.get("subordinate_name") or "部下"
    mofu = (cfg.get("ignore_names") or "ミナト").split(",")[0].strip()
    gap = 0.6 if fast else 2.5

    # (表示名, 文字起こしの断片たち)。RTMSは細切れで届くことがあるので、わざと分けて送る
    script = [
        (boss, ["先週お願いした資料、", "進捗どうなってる？"]),
        (sub, ["すみません…私の段取りが悪くて、", "まだ半分くらいです"]),
        (boss, ["なんでもっと早く", "相談しなかったの？"]),
        (mofu, ["あ、すみません〜ちょっといいですか！"]),          # ミナトPC自身の声 → 無視されるはず
        (boss, ["そうだね。どういう経緯だったか教えてもらえる？"]),
        ("ゲスト参加者", ["失礼します、少しだけ聞かせてください"]),  # 未登録の名前 → 上司?として表示
        (sub, ["データの集計で迷っていて、", "どこまで調べればいいか分からなくなっていました"]),
    ]
    for name, parts in script:
        for p in parts:
            r = post("/ingest", {"user_name": name, "text": p, "source": "zoom"})
            print(f"{name:>8} → {r['speaker']!s:<11} {p}")
            time.sleep(0.25)
        time.sleep(gap + 1.3)   # 1.2秒途切れたら1発言として確定する
    print("完了")


if __name__ == "__main__":
    main()
