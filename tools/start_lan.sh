#!/bin/sh
# ミナト用PC（同じWi-Fiの別のパソコン）からステージ画面を開けるように起動する。
# ほかのパソコンから届くのは、合言葉つきのステージ画面と声の取得だけ（main.py の LocalOnly）。
cd "$(dirname "$0")/.." || exit 1
STAGE_LAN=1 exec uvicorn main:app --host 0.0.0.0 --port "${PORT:-8001}"
