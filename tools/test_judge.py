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
check("セリフは全カテゴリ×全タイプ（4タイプ）ある", len(lines) == len(main.ATTACK_PATTERNS) * len(main.TYPE_KEYS))
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

# ---- 対面の1on1で実際に出そうな言葉（見逃し・誤検知の回帰テスト） ----
print("\n実際に出そうな言葉")
HARSH = ["なんでもっと早く相談しなかったの？", "使えないな", "やる気あるの？", "君には向いてないかもね", "考えが甘いよ", "言い訳はいいから",
         "社会人としてありえない", "前にも言ったよね", "何回言ったらわかるの", "それじゃダメだよ", "普通はこうするでしょ", "いつまでかかってるの",
         "もっとちゃんとやって", "期待してたのにがっかりだよ", "はぁ…もういいよ", "この程度もできないの？", "全然わかってないね", "結果が出てないよね",
         "自分で考えてよ", "だから言ったでしょ", "ちょっと遅すぎるよ", "それ、意味ある？", "しっかりしてよ", "なんで報告しないの",
         "普通に考えたらわかるでしょ", "どうしてこうなったの？", "センスないね", "話にならない", "もう任せられないな", "君のせいでチームが遅れてる"]
CALM = ["ありがとう、助かったよ", "次はどうしたい？", "困ってることある？", "この資料、よくまとまってるね", "無理しないでね", "来週までにできそう？",
        "どういう経緯だったか教えて", "一緒に考えよう", "いいね、その案で進めよう", "なんでも相談してね", "このツール使えないね", "期待してるよ",
        "どうしてこうなったと思う？", "どういう意味か教えて", "向いてると思うよ", "自分で考えてみて、あとで聞かせて", "甘いもの好き？",
        "ありえないくらい良い出来だね", "僕の責任だから気にしないで", "意味のある仕事だと思う", "結果が出てよかったね", "遅くまでありがとう"]
for preset in main.TYPE_KEYS:
    cfg = {"active_preset": preset, "sensitivity": "medium", "personality_presets": {}, "judge": {"use_claude": False}}
    missed = [t for t in HARSH if not main.get_dummy_response(t, cfg, [], {"situation": "progress"})["should_intervene"]]
    wrong = [t for t in CALM if main.get_dummy_response(t, cfg, [], {"situation": "progress"})["should_intervene"]]
    check(f"{preset}：厳しい言葉30文の見逃し0（{missed}）", not missed)
    check(f"{preset}：介入不要な22文の誤検知0（{wrong}）", not wrong)
pa = main.get_dummy_response("使えないな", {"active_preset": "perfectionist", "sensitivity": "low", "personality_presets": {}}, [], {})
check("人格・能力の否定は、感度「控えめ」でも介入する", pa["should_intervene"] and pa["category_id"] == "personal_attack")

# ---- 4タイプの傾向診断（24問） ----
print("\n傾向診断")
Q = main.PROFILE_QUESTIONS
check("24問で、4つの傾向に6問ずつ（うち逆の聞き方1問）", len(Q) == 24 and all(
    sum(1 for q in Q if q["dim"] == d) == 6 and sum(1 for q in Q if q["dim"] == d and q["reverse"]) == 1 for d in main.TYPE_KEYS))
check("上司向け・本人向けの質問文が両方ある", all(q["boss"] and q["self"] for q in Q))
ans = {q["id"]: (0 if q["reverse"] else 3) if q["dim"] == "independent" else (3 if q["reverse"] else 0) for q in Q}
sc = main.score_profile(ans)
check("自分で決めたい傾向だけ強い答え → その傾向が100点・ほかは0点", sc == {"perfectionist": 0, "logical": 0, "sensitive": 0, "independent": 100}, ) if True else None
conf = main.profile_confidence(ans, sc)
check("偏りも矛盾もない答えは「確かさ：高」", conf["level"] == "high" and not conf["mixed"])
same = {q["id"]: 2 for q in Q}
check("全部同じ答えは「確かさ：低」", main.profile_confidence(same, main.score_profile(same))["level"] == "low")
contra = {q["id"]: 3 for q in Q if q["dim"] in ("perfectionist", "sensitive")}
contra.update({q["id"]: 0 for q in Q if q["dim"] in ("logical", "independent")})
check("逆の聞き方とも「当てはまる」と答える矛盾が2か所 →「確かさ：低」", main.profile_confidence(contra, main.score_profile(contra))["level"] == "low")
half = {q["id"]: 1 for q in Q[:10]}
check("未回答が多いと「確かさ：低」", main.profile_confidence(half, main.score_profile(half))["level"] == "low")

# ---- 面談の状況 ----
print("\n面談の状況")
base_cfg = {"active_preset": "perfectionist", "sensitivity": "medium", "personality_presets": {}, "judge": {"use_claude": False}}
hit = lambda text, cfg, sit: main.get_dummy_response(text, cfg, [], {"situation": sit})["should_intervene"]
check("進捗の確認では、急かしに介入する", hit("いつまでかかってるの", base_cfg, "progress"))
check("雑談・相談では、同じ急かしでも会話を止めない", not hit("いつまでかかってるの", base_cfg, "casual"))
low_cfg = dict(base_cfg, active_preset="logical", sensitivity="low")
check("指摘とフォローでは、失望の言葉にも介入する（他の状況では見守り）",
      hit("正直がっかりだよ", low_cfg, "feedback") and not hit("正直がっかりだよ", low_cfg, "progress"))
check("謝罪・感謝には、どの状況でも介入しない", not any(hit("ごめん、ありがとう", base_cfg, s) for s in main.SITUATIONS))

# ---- 上司が事前に伝えたいこと ----
print("\n伝えたいこと")
intent = main.clean_intent({"goals": ["田中さんに期限の前に相談してほしい", " ", "x" * 99, "4つ目"], "takeaway": "困ったら早めに声をかけていい" * 3, "outcome": 5})
check("伝えたいことは3つ・各60文字まで、持ち帰りは40文字まで、形の違う値は捨てる",
      len(intent["goals"]) == 3 and len(intent["goals"][1]) == 60 and len(intent["takeaway"]) == 40 and intent["outcome"] == "")
pcfg = main.load_config()
pcfg["name_masks"] = {"田中": "A"}
prompt = main.build_system_prompt(pcfg, {"situation": "feedback", "intent": intent})
check("Claudeへの指示に、状況と伝えたいことが入り、実名は置き換わる", "指摘とフォロー" in prompt and "Aさんに期限の前に相談してほしい" in prompt and "田中" not in prompt)
check("Claudeへの指示に「指摘の中身は消さない」がある", "指摘の中身は消さない" in prompt)
log = {"started_at": "x", "conversations": [], "interventions": [],
       "meeting": {"situation": "feedback", "situation_changes": [], "intent_goals": 3, "intent_takeaway": True, "intent_covered": 1}}
saved = str(main.log_for_disk(log, {}))
check("ログには状況と件数だけ残り、伝えたいことの本文は残らない", "'intent_goals': 3" in saved and "期限" not in saved)

from fastapi.testclient import TestClient  # noqa: E402
tc = TestClient(main.app, base_url="http://127.0.0.1:8001")
tc.post("/start-session", json={"situation": "goal", "intent": {"goals": ["範囲を先に決める"], "takeaway": "", "outcome": ""}})
check("面談の開始で、状況と伝えたいことを受け取る", main.session_meta["situation"] == "goal" and main.session_meta["intent"]["goals"] == ["範囲を先に決める"])
r = tc.post("/session/situation", json={"situation": "casual"})
check("面談中に状況を切り替えられる", r.status_code == 200 and main.session_meta["situation"] == "casual")
check("知らない状況は受け付けない", tc.post("/session/situation", json={"situation": "party"}).status_code == 400)
tc.post("/start-session")
check("本文なしの開始（古い画面）でも動く", main.session_meta["situation"] == "progress" and main.session_meta["intent"]["goals"] == [])

# ---- 部下の自己否定への「受け取り方の視点」 ----
print("\n受け取り方の視点")
tips = [sig["reframe"] for sig in main.SUBORDINATE_SIGNALS]
check("すべてのサインに受け取り方の視点がある", all(tips))
check("視点の文は短く、性格の話をせず、上司の言い方として検出されない",
      all(len(t) + 4 <= 40 and main.speech_is_safe(t, pcfg) and not main.find_attack_matches(t) for t in tips))
sig = main.detect_subordinate_signal("私のせいです、すみません", [], "independent")
check("自分を責める言葉に、視点と4つ目のタイプの予報が付く", sig and sig["reframe"] and sig["forecast"])

print("\n失敗 0" if not failed else f"\n失敗 {failed}")
sys.exit(1 if failed else 0)
