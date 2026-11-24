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

# ---- 発注書 v12：部下の受け取り方の支援 ----
print("\n受け取り方の支援（v12）")
lines_v12 = [s for v in main.MINATO_LINES.values() for s in v.values()]
check("view viewの声は上司の意図の代弁をしない（「〜だと思います」を使わない）", not any("だと思います" in s or "んだと思" in s for s in lines_v12))
check("部下に責任を移す言葉を使わない", not any(w in s for s in lines_v12 for w in ["受け取り方が悪", "前向きに", "気にしすぎ", "考えすぎ"]))
check("人格・能力の否定には、受け取るよう促さず「価値」か「行動」に分ける",
      all(("価値" in s or "行動" in s) for s in main.MINATO_LINES["personal_attack"].values()))
check("人格否定以外の全カテゴリに受け取り方の型があり、全カテゴリに言えるひとことがある",
      all((c["id"] == "personal_attack" or main.CATEGORY_SKILL.get(c["id"]) in main.RECEIVE_SKILLS) and main.REPLY_EXAMPLES.get(c["id"])
          for c in main.ATTACK_PATTERNS))
pa_v = main.get_dummy_response("お前は本当に使えないな", {"active_preset": "logical", "sensitivity": "medium", "personality_presets": {}}, [], {})
check("人格否定には型を付けず「受け取る練習の対象ではない」と示す（レビュー指摘6）",
      pa_v["receive_skill"] is None and "対象ではありません" in pa_v["receive_note"] and "personal_attack" not in main.CATEGORY_SKILL)
check("人格否定の声は「受け止めなくて大丈夫」と伝える", all("受け止めなくて大丈夫" in s for s in main.MINATO_LINES["personal_attack"].values()))
check("言えるひとことは40字以内で、上司の言い方として検出されない",
      all(len(s) <= 40 and not main.find_attack_matches(s) for s in main.REPLY_EXAMPLES.values()))
v = main.get_dummy_response("もっとちゃんとやって", {"active_preset": "logical", "sensitivity": "medium", "personality_presets": {}}, [], {})
check("判定結果に型（確かめる）と言えるひとことが付く", v["receive_skill"]["label"] == "確かめる" and v["reply_example"])

sig = main.detect_subordinate_signal("私が悪くて、資料の提出が遅れてしまいました、すみません", [], "perfectionist")
check("「私が悪くて」を自分を責める言葉として検出する", sig and sig["id"] == "self_blame")
check("言い直しに発言の中の出来事を引用する（「資料の提出が遅れてしまいました」）", sig and "資料の提出が遅れてしまいました" in sig["rewrite"] and "次は" in sig["rewrite_example"])
sig2 = main.detect_subordinate_signal("自分のせいです", [], "sensitive")
check("出来事が取れない時は、ひな形の言い直しを出す", sig2 and sig2["rewrite"] and "〇〇" in sig2["rewrite_example"])
check("あきらめ・謝罪の連続にも言い直しの例がある",
      all(main.self_rewrite(k, "x")["rewrite"] for k in ("give_up", "over_apology")))

GOOD = {"具体的にどの部分を直せばいいですか？": "clarify", "経緯をお話しします": "explain", "次は水曜までに見せます": "separate",
        "なるほど、ポイントは期限ですね": "extract", "どこまでできていれば十分ですか": "clarify"}
for t, k in GOOD.items():
    check(f"良い受け取り方を検出：{t} → {main.RECEIVE_SKILLS[k]['label']}", k in [s["id"] for s in main.detect_receive_skills(t)])
for t in ["はい", "わかりました", "すみません", "私のせいです", "無理です",
          "なるほど、つまり私が全部悪いってことですね", "例えば私がいなくなればいいってことですか", "もう辞めてみます", "次は無理です",
          "なるほど、全部私のせいです", "具体的に言うと私が無能ってことですよね"]:
    check(f"型として数えない（褒めない）：{t}", not main.detect_receive_skills(t))
check("1発言で数える型は1つだけ（レビュー指摘5）", len(main.detect_receive_skills("なるほど、具体的にどの部分ですか？経緯をお話しします。次は直します")) == 1)
for t, want in {"私のせいでお客様が怒ってしまいました": "お客様が怒ってしまいました", "止まってしまいました、私のせいです": "止まってしまいました"}.items():
    s = main.detect_subordinate_signal(t, [], "perfectionist")
    check(f"出来事の引用で活用を壊さない：{want}", s and want in s["rewrite_example"])
for t in ["上司に怒られました。私が悪いんです", "何回も言われました。私のせいです"]:
    s = main.detect_subordinate_signal(t, [], "perfectionist")
    check(f"上司の行為を部下の出来事として引用しない：{t}", s and "〇〇が起きました" in s["rewrite_example"])

rlog = {"conversations": [{"speaker": "subordinate", "original": "部下の本文"}] * 3,
        "receive_skills": [{"skills": ["clarify"]}, {"skills": ["clarify", "explain"]}],
        "subordinate_signals": [{"signal": {"id": "self_blame"}, "transcript": "部下の本文"}],
        "interventions": [{"result": {"should_intervene": True, "category_id": "personal_attack"}},
                          {"result": {"should_intervene": True, "category_id": "denial"}}]}
rs = main.receive_summary(rlog)
check("ふりかえりの回数（確かめる2・伝える1・自己否定1・人格否定1）",
      rs["skills"]["clarify"] == 2 and rs["skills"]["explain"] == 1 and rs["self_negation"] == 1 and rs["personal_attack_by_boss"] == 1)
check("次の練習テーマは、促したのに使えていない型", rs["focus"] in ("separate", "extract"))
check("ふりかえりの記録に発言の本文が入らない", "部下の本文" not in str(rs))
saved_r = str(main.log_for_disk({**rlog, "started_at": "x", "receive_summary": rs}, {}))
check("既定のログに受け取り方の回数は残り、本文は残らない", "'clarify': 2" in saved_r and "部下の本文" not in saved_r)

pc = tc.post("/practice/check", json={"item_id": "p3", "reply": "どこまでやれば十分か、具体的に教えてもらえますか？"}).json()
check("練習：狙いの型ができたら褒める", "確かめる" in pc["message"] and pc["saved"] is False)
pc2 = tc.post("/practice/check", json={"item_id": "p1", "reply": "すみません、私がダメでした"}).json()
check("練習：自分を責める返しに、言い直しの例を出す", pc2["self_negation"] and pc2["rewrite"])
pc3 = tc.post("/practice/check", json={"item_id": "p2", "reply": "なるほど、全部私のせいです"}).json()
check("練習：自己否定の返しを褒めない（レビュー指摘1）", not pc3["skills"] and "いいですね" not in pc3["message"] and pc3["self_negation"])
pc4 = tc.post("/practice/check", json={"item_id": "p2", "reply": "すみません、一番直すべきところはどこですか？"}).json()
check("練習：「すみません」1回を自分を責める言葉と言わない（レビュー指摘9）", not pc4["self_negation"] and "責める" not in pc4["message"])
pc5 = tc.post("/practice/check", json={"item_id": "p3", "reply": "わかりません"}).json()
check("練習：「わかりません」は自責ではなく、あきらめ向けの言葉で返す", "責める" not in pc5["message"] and "分かっている所" in pc5["message"])

# 面談の流れ：デモは数えない・話者を直したら取り消す（レビュー指摘2・3）
tc.post("/start-session")
tc.post("/analyze", json={"transcript": "具体的にどの部分ですか？", "speaker": "subordinate", "speaker_source": "demo"})
tc.post("/analyze", json={"transcript": "次は手順を見直してみます", "speaker": "subordinate", "speaker_source": "text"})
tc.post("/analyze", json={"transcript": "経緯をお話しします", "speaker": "subordinate", "speaker_source": "text"})
tc.post("/speaker-correction", json={"transcript": "経緯をお話しします", "from_speaker": "subordinate", "to_speaker": "boss"})
flow = main.receive_summary(main.session_log)
check("デモの発言は回数に入らず、話者を上司に直した発言は取り消される",
      flow["skills"] == {"separate": 1, "extract": 0, "clarify": 0, "explain": 0} and flow["skills_total"] == 1)
main.session_log["started_at"] = None

check("練習：5問あり、知らない問題は受け付けない",
      len(tc.get("/practice/items").json()["items"]) == 5 and tc.post("/practice/check", json={"item_id": "zz", "reply": "a"}).status_code == 400)

# ---- 発注書 v13：自己否定を、その場で客観視する支援 ----
print("\n自己否定の客観視（v13）")
for t in ["自分なんてダメです", "私は仕事ができない人間です", "本当に情けない", "自分が嫌になる"]:
    sg = main.detect_subordinate_signal(t, [], "perfectionist")
    check(f"自己否定として検出し、事実・評価・問いを出す：{t}", sg and sg["id"] == "self_blame" and sg["objective"]["judgement"] and sg["objective"]["question"])
for t in ["明日は会議に出席できないです", "私は来週休みを取ります", "資料の提出が遅れました"]:
    check(f"ふつうの発言は自己否定にしない：{t}", main.detect_subordinate_signal(t, [], "perfectionist") is None)
og = main.detect_subordinate_signal("私が悪くて、資料の提出が遅れてしまいました", [], "perfectionist")["objective"]
check("事実と評価を分けて返す", og["fact"] == "資料の提出が遅れてしまいました" and og["judgement"] == "私が悪く")
check("問いは評価の決めつけではなく、事実か評価かを聞く", all("べき" not in q and "ダメ" not in q for q in main.OBJECTIVE_QUESTIONS))

# ---- 発注書 v14：自己否定かどうかの見分け ----
print("\n自己否定の見分け（v14）")


def sb(t, recent=()):
    return main.detect_subordinate_signal(t, list(recent), "perfectionist")


for t in ["自分なんてダメです", "どうせ私なんて", "私は使えない人間です", "私は向いていないと思います"]:
    s = sb(t)
    check(f"重い自己否定は声も許す（strong）：{t}", s and s["id"] == "self_blame" and s["strength"] == "strong")
for t in ["私のせいです", "何をやっても怒られるだけです"]:
    s = sb(t)
    check(f"自己否定だが画面だけ（normal）：{t}", s and s["id"] == "self_blame" and s["strength"] == "normal")
check("謝罪が重なれば声も許す", sb("私のせいです、すみません")["strength"] == "strong")
check("直前にも自己否定があれば声も許す", sb("私のせいです", ["私が悪かったです"])["strength"] == "strong")
for t in ["私のせいではありません", "私が悪くないと思います", "彼は向いてないと思います", "お客様が情けないと言っていました",
          "私は使えないって言われました", "どうせなら今日やります", "何をやっても楽しいです",
          "私のせいです。次から確認を徹底します", "今回の遅れは私の責任です。今後は早めに共有します"]:
    check(f"自己否定として慰めない：{t}", (sb(t) or {}).get("id") != "self_blame")
check("責任を引き受けた上でも、重い自己否定が混じれば慰める", (sb("私は使えない人間でした。次から気をつけます") or {}).get("id") == "self_blame")
check("他人の話でも、自分の発言なら拾う（私のせいでお客様が…）", (sb("私のせいでお客様が怒ってしまいました") or {}).get("id") == "self_blame")
check("「もう無理です」はあきらめのサイン", (sb("もう無理です") or {}).get("id") == "give_up")
for t in ["明日までは無理です", "今週中は物理的に無理です"]:
    check(f"期限の断りはあきらめにしない：{t}", sb(t) is None)
check("当たった言葉を根拠として返す", sb("私が悪くて、資料の提出が遅れました")["objective"]["judgement"] == "私が悪く")

# ---- 発注書 v15：傾向に合わせたフォロー ----
print("\n傾向に合わせたフォロー（v15）")
types = list(main.SELF_BLAME_STYLE)
check("4つの傾向すべてに文面がある", set(types) == set(main.TYPE_KEYS) and set(main.GIVE_UP_STYLE) == set(main.TYPE_KEYS) == set(main.OVER_APOLOGY_STYLE))
texts_v15 = []
for k in types:
    st = main.SELF_BLAME_STYLE[k]
    texts_v15 += [st["event"], st["plain"], st["voice"], *st["questions"], *main.GIVE_UP_STYLE[k], *main.OVER_APOLOGY_STYLE[k]]
labels_v15 = [p["label"] for p in main.DEFAULT_PRESETS.values()] + [main.DIM_LABELS[k] for k in main.TYPE_KEYS]
check("傾向の名前や「タイプ」を画面にも声にも出さない", not any(lb in t for t in texts_v15 for lb in labels_v15) and not any("タイプ" in t for t in texts_v15))
check("声は40字以内で、性格の話をせず、上司の言い方として検出されない・上司の意図を代弁しない",
      all(len(main.SELF_BLAME_STYLE[k]["voice"]) <= 40 and main.speech_is_safe(main.SELF_BLAME_STYLE[k]["voice"], pcfg)
          and not main.find_attack_matches(main.SELF_BLAME_STYLE[k]["voice"]) and "だと思います" not in main.SELF_BLAME_STYLE[k]["voice"] for k in types)
      and len(main.DEFAULT_SELF_BLAME_STYLE["voice"]) <= 40)
check("問いは評価を決めつけない（「べき」「ダメ」を使わない）",
      all("べき" not in q and "ダメ" not in q for k in types for q in main.SELF_BLAME_STYLE[k]["questions"]))
check("文面は「起きたこと」を引用でき、性格に関係なく人格を否定しない", all("{e}" in main.SELF_BLAME_STYLE[k]["event"] for k in types))
for k in types:
    s = main.detect_subordinate_signal("私が悪くて、資料の提出が遅れてしまいました", [], k)
    check(f"{k}：自己否定に傾向別の文・問い・声が付き、出来事を引用する",
          s and "資料の提出が遅れてしまいました" in s["rewrite"] and s["voice"] == main.SELF_BLAME_STYLE[k]["voice"]
          and s["objective"]["question"] in main.SELF_BLAME_STYLE[k]["questions"])
rw = {k: main.detect_subordinate_signal("自分なんてダメです", [], k)["rewrite"] for k in types}
check("傾向ごとに言い回しが違う", len(set(rw.values())) == 4)
check("傾向が分からないときは従来の文のまま", main.detect_subordinate_signal("自分なんてダメです", [], "unknown")["voice"] == main.DEFAULT_SELF_BLAME_STYLE["voice"])
check("あきらめ・謝罪の連続も傾向で言い回しが変わる",
      len({main.self_rewrite("give_up", "x", None, k)["rewrite"] for k in types}) == 4
      and len({main.self_rewrite("over_apology", "x", None, k)["rewrite"] for k in types}) == 4)
check("傾向でフォローを変えても、自己否定の見分け（strength）は変わらない",
      len({main.detect_subordinate_signal("私のせいです", [], k)["strength"] for k in types}) == 1)

# ---- 発注書 v17：話者を分けなくても、部下をフォローする ----
print("\n話者を分けない設定（v17）")
# 手元の設定（感度など）に左右されないよう、感度「ふつう」・Claude判定オフで固定する
_orig_load_config = main.load_config
main.load_config = lambda: {**_orig_load_config(), "sensitivity": "medium", "judge": {"use_claude": False}}
tc.post("/start-session")


def any_say(t):
    r = tc.post("/analyze", json={"transcript": t, "speaker": "any", "speaker_source": "text"}).json()
    return r


HARSH = ["全然できてないじゃん", "なんでもっと早く相談しなかったの？", "何回言ったらわかるの", "使えないな", "もっとちゃんとやって",
         "期待してたのに残念だよ", "はぁ…もういいよ", "いつまでかかってるの", "普通はこうするでしょ"]
for t in HARSH:
    r = any_say(t)
    check(f"厳しい言葉は、誰の発言か分からなくても受け取る側へのフォローが出る：{t}", r["should_intervene"] and not r["subordinate_signal"])
for t in ["先週の資料、進捗どうなってる？", "そうだね。どういう経緯だったか教えてもらえる？", "責任は僕にあるよ、ごめん", "僕のせいだ、ごめん",
          "ちゃんとやってくれてありがとう", "なんでも相談してね"]:
    r = any_say(t)
    check(f"ふつうの言葉・上司の責任表明には、何も出さない：{t}", not r["should_intervene"] and not r["subordinate_signal"])
for t in ["自分なんてダメです", "どうせ私なんて", "何回も同じミスをしてしまって、本当に情けないです", "全然できてないと自分でも思います"]:
    r = any_say(t)
    check(f"自分を責める言葉には、事実と評価を分ける手がかりが出る（上司向けの判定にはしない）：{t}",
          r["subordinate_signal"] and r["subordinate_signal"]["id"] == "self_blame" and not r["should_intervene"] and r["subordinate_signal"]["objective"]["question"])
for t in ["なんで気づけなかったんだろう", "もっとちゃんとやるべきでした", "いつまでかかってるんだと自分でも思います", "なんで私ばっかりこうなるんだろう"]:
    r = any_say(t)
    check(f"自分に向けた言葉を、上司の厳しい言葉と取り違えない：{t}", not r["should_intervene"])
for t in ["上司に使えないと言われました", "全然できてないじゃんって言われて落ち込んでいます"]:
    r = any_say(t)
    check(f"人から言われた厳しい言葉を引きずっている時は、受け取り方の声かけか、つらさの受け止めが出る：{t}",
          r["should_intervene"] or (r["subordinate_signal"] and r["subordinate_signal"]["id"] in ("distress", "self_blame")))
for t in ["この案はダメだと思います", "データがまだ足りてないと思います", "明日までは無理です"]:
    r = any_say(t)
    check(f"仕事の話は、自己否定にも厳しい言葉にもしない：{t}", not r["subordinate_signal"] and not r["should_intervene"])
check("責任の引き受けだけで言い方が砕けている発言は、部下の自己否定と取り違えない（上司の「僕のせいだ」）", not any_say("俺のせいだ")["subordinate_signal"])
r = any_say("私のせいです、すみません")
check("丁寧な責任の引き受け＋謝罪は、部下の自己否定として拾う", r["subordinate_signal"] and r["subordinate_signal"]["strength"] == "strong")
r = any_say("私のせいで資料が遅れてしまいました")
check("同上：責任の引き受け（画面だけ）", r["subordinate_signal"] and r["subordinate_signal"]["id"] == "self_blame")
check("話者を分けない設定では、発言を外部に送らない", all(not any_say(t)["sent_data"]["external_sent"] for t in HARSH[:3]))
rs_any = main.receive_summary(main.session_log)
check("ふりかえりは、話者を分けない発言も部下の方の発言として数える", rs_any["sub_utterances"] > 0 and rs_any["self_negation"] > 0)
saved_any = str(main.log_for_disk(dict(main.session_log, started_at="x", receive_summary=rs_any), {}))
check("既定のログには、分けない発言の本文が入らない", "全然できてないと自分でも思います" not in saved_any)
main.session_log["started_at"] = None
main.load_config = _orig_load_config

# ---- 発注書 v18：反応する言葉の幅（面談にありそうな言葉のコーパス。tools/phrase_corpus.py） ----
print("\n反応する言葉の幅（v18）")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import phrase_corpus as corpus  # noqa: E402

_orig_load_config18 = main.load_config
main.load_config = lambda: {**_orig_load_config18(), "sensitivity": "medium", "judge": {"use_claude": False}}


def reacts(t):
    tc.post("/start-session")   # 直前の発言の影響（謝罪が続いている等）を受けないよう、毎回はじめから
    r = any_say(t)
    sg = r.get("subordinate_signal")
    return ("harsh" if r["should_intervene"] else None) or (sg["id"] if sg else None)


def coverage(name, items, ok_kinds):
    miss = [t for t in items if reacts(t) not in ok_kinds]
    check(f"{name}：コーパス{len(items)}文のうち、反応しない文が0（反応できた {len(items) - len(miss)}/{len(items)}）" + (f" 取りこぼし:{miss[:3]}" if miss else ""), not miss)


coverage("厳しい言葉（上司）", corpus.HARSH, ("harsh",))
coverage("自分を責める言葉（部下）", corpus.SELF, ("self_blame",))
coverage("あきらめ・手が止まっている", corpus.GIVEUP, ("give_up",))
coverage("人と比べて自分を低く見る", corpus.COMPARE, ("comparison", "self_blame"))
coverage("つらさ・しんどさ", corpus.DISTRESS, ("distress",))
fp = [t for t in corpus.NEUTRAL if reacts(t)]
check(f"何もしないべき言葉：コーパス{len(corpus.NEUTRAL)}文のうち、誤反応が0" + (f" 誤反応:{fp[:3]}" if fp else ""), not fp)
gap_counts = {k: len(v) for k, v in corpus.GAPS.items()}
print(f"  情報 未対応の文（まだ反応できない。パターンを足したら本体に移す）：{gap_counts}／合計 {sum(gap_counts.values())}文")
check("未対応のリストの文は、本当にまだ反応しない（反応するようになったら、本体に移す）", all(reacts(t) is None for v in corpus.GAPS.values() for t in v))
check("反応の種類（サインの種類）が5つある：自己否定・あきらめ・謝罪の連続・人と比べる・つらさ", {x["id"] for x in main.SUBORDINATE_SIGNALS} == {"self_blame", "give_up", "over_apology", "comparison", "distress"})
check("すべてのサインに、画面の見出しと、傾向4つぶんの予報と言い直しがある",
      all(x.get("title") and set(x["forecast"]) == set(main.TYPE_KEYS) for x in main.SUBORDINATE_SIGNALS)
      and all(set(d) == set(main.TYPE_KEYS) for d in (main.COMPARISON_STYLE, main.DISTRESS_STYLE, main.GIVE_UP_STYLE, main.OVER_APOLOGY_STYLE)))
texts18 = [t for d in (main.COMPARISON_STYLE, main.DISTRESS_STYLE) for v in d.values() for t in v]
check("新しい言い直しにも、傾向の名前や「タイプ」を出さない", not any(lb in t for t in texts18 for lb in labels_v15) and not any("タイプ" in t for t in texts18))
for k in main.TYPE_KEYS:
    sc = main.detect_subordinate_signal("同期はみんなできるのに、私だけできていません", [], k)
    sd = main.detect_subordinate_signal("正直、しんどいです", [], k)
    check(f"{k}：「人と比べる」「つらさ」に、傾向別の言い直しが出て、声は出さない（strengthなし）",
          sc and sd and sc["rewrite"] == main.COMPARISON_STYLE[k][0] and sd["rewrite"] == main.DISTRESS_STYLE[k][0] and "strength" not in sc and "strength" not in sd)
main.load_config = _orig_load_config18

print("\n失敗 0" if not failed else f"\n失敗 {failed}")
sys.exit(1 if failed else 0)
