"""判定とログ保存の確認（外部通信なし）。  python3 tools/test_judge.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main  # noqa: E402

config = {
    "active_preset": "logical",
    "sensitivity": "high",
    "personality_presets": {"logical": {"label": "論理重視タイプ"}},
    "judge": {"use_claude": False},
}
failed = 0


def check(name, cond):
    global failed
    print(("  ok   " if cond else "  NG   ") + name)
    failed += 0 if cond else 1


def intervenes(text):
    return main.get_dummy_response(text, config)["should_intervene"]


for text in ["責任は僕にあるよ、ごめん", "無理だったら言ってね", "ちゃんとやってくれてありがとう", "なんでも相談してね", "いつでも相談して"]:
    check(f"介入しない：{text}", not intervenes(text))
for text in ["なんでもっと早く相談しなかったの？", "ありがとう、でも何回言ったらわかるの", "ありがとうでも何回言ったらわかるの", "ごめんけどもっとちゃんとやって", "全然できてないじゃん"]:
    check(f"介入する：{text}", intervenes(text))

lines = [(c, t, s) for c, v in main.MINATO_LINES.items() for t, s in v.items()]
check("セリフは全カテゴリ×全タイプある", len(lines) == len(main.ATTACK_PATTERNS) * 3)
check("呼びかけ込みで40字以内", all(len(s) + 4 <= 40 for _, _, s in lines))
check("性格の話を声に出さない", all(main.speech_is_safe(s, config) for _, _, s in lines))
check("自分のセリフが検出に反応しない", not any(main.find_attack_matches(s) for _, _, s in lines))
check("性格語を含む生成文は声にしない", not main.speech_is_safe("論理重視タイプなので心配です", config))
check("長すぎる生成文は声にしない", not main.speech_is_safe("あ" * 39, config))
check("Claude無効なら外部送信しない", main.judge_boss("全然できてないじゃん", [], config, True)["external_sent"] is False)

log = {
    "started_at": "x",
    "config_snapshot": {"sensitivity": "high", "name_masks": {"実名": "A"}, "profile_analysis": {"answers": {"q1": 3}}},
    "conversations": [{"timestamp": "t", "speaker": "boss", "original": "実名の発言", "masked": "Aの発言"}],
    "interventions": [{"timestamp": "t", "transcript": "実名の発言", "result": {"should_intervene": True, "reason": "性格補正", "reframed_speech": "セリフ"}}],
    "subordinate_signals": [{"timestamp": "t", "transcript": "部下の原文", "signal": {"id": "give_up", "hint": "h"}}],
    "speaker_corrections": [{"timestamp": "t", "transcript": "実名の発言", "from": "boss", "to": "subordinate"}],
    "turn_log": [{"ms": 1, "type": "raise"}],
}
saved = str(main.log_for_disk(log, {}))
check("既定のログに原文・実名・回答が残らない", not any(w in saved for w in ["実名", "部下の原文", "answers", "性格補正", "セリフ"]))
check("判断の記録は残る", "raise" in saved)
check("設定すれば原文も残せる", main.log_for_disk(log, {"privacy": {"log_raw": True}}) is log)

# Claudeへの依頼内容（通信はしない）
from types import SimpleNamespace as NS  # noqa: E402

seen = {}


def fake_create(**kwargs):
    seen.update(kwargs)
    text = '{"should_intervene": false, "risk_level": "none", "reason": "r", "reframed_speech": "", "boss_tip": ""}'
    return NS(stop_reason="end_turn", content=[NS(type="text", text=text)])


real_client, real_disabled = main.client, main.api_state["disabled"]
main.client = NS(with_options=lambda **kw: NS(messages=NS(create=fake_create)))
main.api_state["disabled"] = False
claude_config = {**config, "judge": {"use_claude": True}, "character_persona": {"name": "n", "position": "p", "tone": "t", "first_person": "f", "forbidden": "x"}}
result = main.judge_boss("全然できてないじゃん", ["上司: 進捗どう"], claude_config, True)
main.client, main.api_state["disabled"] = real_client, real_disabled
check("既定モデルはHaiku 5.5", main.CLAUDE_MODEL == "claude-haiku-5-5" or "CLAUDE_MODEL" in __import__("os").environ)
check("Haikuは思考オフ・低effortで依頼する", seen.get("thinking") == {"type": "disabled"} and seen["output_config"]["effort"] == "low")
check("Claudeが不要と判断したら介入を取り消す", result["should_intervene"] is False and result["external_sent"] is True)

# Zoom：前の人の発言を確定してから、次の人の発話の合図を配信する
import asyncio  # noqa: E402
import zoom_bridge  # noqa: E402


async def zoom_order():
    zoom_bridge.setup(lambda: {"zoom": {"boss_name": "上司", "subordinate_name": "部下", "ignore_names": ""}})
    zoom_bridge._ensure_loop()
    q = asyncio.Queue()
    zoom_bridge._subscribers.add(q)
    zoom_bridge._ingest("上司", "なんで相談しなかったの", "test", False)
    zoom_bridge._ingest("部下", "すみません", "test", False)
    events = []
    while not q.empty():
        events.append(q.get_nowait())
    zoom_bridge._subscribers.discard(q)
    for buf in zoom_bridge._buffers.values():
        if buf.get("timer"):
            buf["timer"].cancel()
    zoom_bridge._buffers.clear()
    return [e["type"] + ":" + str(e.get("speaker")) for e in events]


check("Zoomの配信順（発言の確定→次の人の合図）",
      asyncio.run(zoom_order()) == ["activity:boss", "utterance:boss", "activity:subordinate"])

# 音声計測の保存：数値・真偽値・固定の種別だけを通し、本文など他の項目は落とす
dirty = [{"finalMs": 540, "cutWhileSpeaking": True, "text": "発言の本文", "transcript": "原文", "kind": "short", "id": "p01",
          "matchPct": 95, "judgeMs": "42", "kind2": "x"},
         {"kind": "日本語の種別", "id": "名前", "finals": float("inf"), "speakMs": None}, "文字列", 3]
cleaned = main.clean_metrics(dirty)
check("計測の保存は許可した項目だけ（本文・原文を落とす）",
      cleaned[0] == {"finalMs": 540, "cutWhileSpeaking": True, "kind": "short", "id": "p01", "matchPct": 95})
check("計測の保存：数値以外・想定外の種別・無限大・辞書でない値を落とす",
      cleaned[1] == {"speakMs": None} and len(cleaned) == 2)
rows = [{"finalMs": 100, "chars": 5, "text": "漏れてはいけない発言"}]
saved_metrics = str(main.log_for_disk({"started_at": "x", "conversations": [], "interventions": [], "metrics": rows}, {}))
check("既定のログに計測の数値は残り、本文は残らない", "'finalMs': 100" in saved_metrics and "漏れてはいけない発言" not in saved_metrics)
check("計測の保存は件数に上限がある", len(main.clean_metrics([{"finalMs": 1}] * 800)) == 500 and len(main.clean_metrics([{"finalMs": 1}] * 80, 50)) == 50)

print("\n失敗 0" if not failed else f"\n失敗 {failed}")
sys.exit(1 if failed else 0)
