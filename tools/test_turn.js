"use strict";
// フロア管理（static/turn.js）の会話シナリオ再生テスト。  node tools/test_turn.js
// 合成した時系列で判断の筋道を確かめるもの。実面談での効果や精度を示すものではない。
const path = require("path");
const { createTurn, classifyTail, isEchoText, splitSentences } = require(path.join(__dirname, "..", "static", "turn.js"));

const HARSH = "なんでもっと早く相談しなかったの";
const LINE = "あの、経緯を知りたいんだと思います。どこで迷いました？";

// 会話を組み立てる小さな台本ツール
function script() {
  const ev = [];
  const api = {
    ev,
    // from〜to の間、40msごとのマイクフレーム
    frames(from, to, o = {}) {
      for (let t = from; t < to; t += 40) ev.push({ t, type: "frame", speech: !!o.speech, rms: o.rms ?? (o.speech ? 0.08 : 0.001), ref: o.ref ?? 1 });
      return api;
    },
    say(from, to) { return api.frames(from, to, { speech: true }); },
    quiet(from, to) { return api.frames(from, to); },
    add(t, type, o = {}) { ev.push(Object.assign({ t, type }, o)); return api; },
    final(t, uttId, text = HARSH, who = "boss") { return api.add(t, "final", { uttId, text, who }); },
    verdict(t, uttId, prio = "high", o = {}) { return api.add(t, "verdict", Object.assign({ uttId, prio, text: HARSH, speech: LINE, category: "accusatory_why" }, o)); },
  };
  return api;
}

// 台本を再生する。speak が出たら、必要に応じて再生開始・終了を自動で返す
function run(s, opt = {}) {
  const turn = createTurn({ pace: opt.pace || "check", textOnly: opt.textOnly, t0: 0, timing: opt.timing });
  const queue = s.ev.map((e, i) => Object.assign({ _i: i }, e)).sort((a, b) => a.t - b.t || a._i - b._i);
  const actions = [];
  while (queue.length) {
    const e = queue.shift();
    for (const a of turn.step(e)) {
      actions.push(a);
      if (a.type === "speak" && opt.playAfter != null) {
        const ins = (x) => { const i = queue.findIndex((q) => q.t > x.t); queue.splice(i < 0 ? queue.length : i, 0, x); };
        ins({ t: a.t + opt.playAfter, type: "playStart", speakId: a.speakId });
        if (opt.playMs) ins({ t: a.t + opt.playAfter + opt.playMs, type: "playEnd", speakId: a.speakId });
      }
    }
  }
  return { actions, turn, has: (type, f = () => true) => actions.some((a) => a.type === type && f(a)), first: (type) => actions.find((a) => a.type === type) };
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };

// 共通の出だし：上司が 0〜2000ms 話し、2300ms に確定、2350ms に判定が届く
const base = () => script().say(0, 2000).final(2300, 1).verdict(2350, 1);

test("言い切り：無音が続けば挙手のあと話す", () => {
  const r = run(base().quiet(2000, 5000));
  ok(r.has("raise"), "手を挙げていない");
  const sp = r.first("speak");
  ok(sp, "話していない");
  ok(sp.t >= 2350 + 800, `挙手から間がない: ${sp.t}`);
  ok(sp.t - 2000 <= 1400, `話し出しが遅い: 発話終了から${sp.t - 2000}ms`);
});
test("息継ぎのあと上司が続ける：話さず画面へ", () => {
  const r = run(base().quiet(2000, 2500).say(2500, 3200).quiet(3200, 6000));
  ok(!r.has("speak"), "話してしまった");
  ok(r.has("hint", (a) => a.why === "moved_on"), "画面ヒントに回っていない");
});
test("部下が答え始めた：話さず画面へ", () => {
  const r = run(base().quiet(2000, 2600).say(2600, 3400).quiet(3400, 6000));
  ok(!r.has("speak"), "部下の発言にかぶせた");
  ok(r.has("lower"), "手を下ろしていない");
});
test("短い相づち1回では見送らない", () => {
  const r = run(base().quiet(2000, 2500).say(2500, 2700).quiet(2700, 6000));
  ok(r.has("speak"), "相づちで諦めた");
});
test("言いさし「〜けど」は長く待つ", () => {
  const text = "それは分かるんだけど";
  const r = run(script().say(0, 2000).final(2300, 1, text).verdict(2350, 1, "high", { text }).quiet(2000, 6000));
  const sp = r.first("speak");
  ok(sp && sp.t - 1960 >= 1500, `待ちが短い: ${sp && sp.t - 1960}`); // 最後の発話フレームは1960ms
});
test("判定待ちの間に次の発言が確定：古い判定は声にしない", () => {
  const r = run(script().say(0, 2000).final(2300, 1).say(2400, 3000).final(3300, 2, "はい、すみません", "subordinate").verdict(3400, 1).quiet(3000, 7000));
  ok(!r.has("speak"), "古い判定で話した");
  ok(r.has("hint", (a) => a.why === "stale"), "stale になっていない");
});
test("判定の到着が逆順でも最新だけ扱う", () => {
  const r = run(script().say(0, 1000).final(1200, 1).say(1300, 2000).final(2200, 2).verdict(2300, 2).verdict(2400, 1).quiet(2000, 6000));
  ok(r.has("speak", (a) => a.uttId === 2) && !r.has("speak", (a) => a.uttId === 1), "順序の扱いが誤り");
});
test("low は画面のみ", () => {
  const r = run(script().say(0, 2000).final(2300, 1).verdict(2350, 1, "low").quiet(2000, 6000));
  ok(!r.has("raise") && !r.has("speak") && r.has("hint", (a) => a.why === "low"), "low の扱いが誤り");
});
test("判定が遅すぎれば期限切れ", () => {
  const r2 = run(script().say(0, 2000).final(2300, 1).verdict(2350, 1).add(2800, "tick"), { timing: { ttlMs: { high: 300, medium: 300 }, raiseLeadMs: 5000 } });
  ok(r2.has("hint", (a) => a.why === "expired"), "期限切れにならない");
});
test("途中文の先行判定：確定で同じ文なら発話まで進む", () => {
  const s = script().add(100, "speaker", { who: "boss" }).add(500, "interim", { text: HARSH }).say(0, 2000).quiet(2000, 5000)
    .verdict(2300, 0, "high", { spec: true }).final(2600, 1).verdict(2620, 1);
  const r = run(s);
  ok(r.first("raise").spec, "先行で手を挙げていない");
  ok(r.has("speak", (a) => a.uttId === 1), "話していない");
});
test("先行判定と確定文が違えば取り下げ", () => {
  const s = script().add(100, "speaker", { who: "boss" }).add(500, "interim", { text: HARSH }).say(0, 2000).quiet(2000, 5000)
    .verdict(2300, 0, "high", { spec: true }).final(2600, 1, "なんでもっと早く相談しなかったのかは聞かないよ");
  const r = run(s);
  ok(!r.has("speak"), "違う文で話した");
  ok(r.has("lower", (a) => a.why === "moved_on"), "手を下ろしていない");
});
test("先行判定だけでは話さない（確定が来ない）", () => {
  const r = run(script().add(100, "speaker", { who: "boss" }).add(500, "interim", { text: HARSH }).say(0, 2000).quiet(2000, 9000).verdict(2300, 0, "high", { spec: true }));
  ok(!r.has("speak"), "確定前に話した");
  ok(r.has("lower", (a) => a.why === "expired"), "期限切れで下ろしていない");
});
test("確定後の判定が届くまでは話さない", () => {
  const s = script().add(100, "speaker", { who: "boss" }).add(500, "interim", { text: HARSH }).say(0, 2000).quiet(2000, 3400)
    .verdict(2300, 0, "high", { spec: true }).final(2600, 1);
  ok(!run(s).has("speak"), "確定判定の前に話した");
});
test("話者不明の途中文では手を挙げない", () => {
  const s = script().add(500, "interim", { text: HARSH }).say(0, 2000).quiet(2000, 4000).verdict(2300, 0, "high", { spec: true });
  ok(!run(s).has("raise"), "話者不明で手を挙げた");
});
test("無音の気配で途中文を先行判定に回す", () => {
  const r = run(script().add(500, "interim", { text: HARSH }).say(0, 2000).quiet(2000, 2600));
  const a = r.first("speculate");
  ok(a && a.t - 1960 >= 250 && a.text === HARSH, "先行判定が出ない");
});
test("部下の途中文は先行判定しない", () => {
  const r = run(script().add(100, "speaker", { who: "subordinate" }).add(500, "interim", { text: "すみません遅くなりました" }).say(0, 2000).quiet(2000, 2600));
  ok(!r.has("speculate"), "部下の発言を先行判定した");
});

// --- 話している最中 ---
const speaking = () => base().quiet(2000, 3400);
test("話し終えれば done", () => {
  const r = run(speaking().quiet(3400, 8000), { playAfter: 100, playMs: 3000 });
  ok(r.has("done"), "done が無い");
  ok(r.turn.state === "LISTEN", "待機に戻っていない");
});
test("再生の回り込みでは止まらない", () => {
  const s = speaking();
  for (let t = 3400; t < 7000; t += 40) s.add(t, "frame", { speech: true, rms: 0.05, ref: 1 });
  const r = run(s, { playAfter: 100, playMs: 3000 });
  ok(!r.has("stop"), "自分の声で止まった");
  ok(r.has("done"), "最後まで話していない");
});
test("人が話し始めたら音量を下げて止まる", () => {
  const s = speaking();
  for (let t = 3400; t < 4400; t += 40) s.add(t, "frame", { speech: true, rms: 0.03, ref: 1 });
  for (let t = 4400; t < 5200; t += 40) s.add(t, "frame", { speech: true, rms: 0.2, ref: 1 });
  const r = run(s, { playAfter: 100 });
  const duck = r.first("duck"), stop = r.first("stop");
  ok(duck && stop, "duck/stop が無い");
  ok(duck.t < stop.t && stop.t - 4400 <= 560, `止まるのが遅い: ${stop.t - 4400}ms`);
  ok(stop.why === "barge", stop.why);
});
test("音量の取れない声は、大きな音だけでは止まらない", () => {
  const s = speaking();
  const id = run(speaking()).first("speak").speakId;
  s.add(3450, "playStart", { speakId: id, levelOk: false });
  for (let t = 3500; t < 5200; t += 40) s.add(t, "frame", { speech: true, rms: 0.3, ref: 1 });
  const r = run(s);
  ok(!r.has("stop"), "音量だけで止まった");
  const r2 = run(speaking().add(3450, "playStart", { speakId: id, levelOk: false }).add(3700, "interim", { text: "いや今のは違うんです" }));
  ok(r2.has("stop", (a) => a.why === "barge"), "言葉では止まるはず");
});
test("短い相づちなら音量を戻して続ける", () => {
  const s = speaking();
  for (let t = 3400; t < 4400; t += 40) s.add(t, "frame", { speech: true, rms: 0.03, ref: 1 });
  for (let t = 4400; t < 4700; t += 40) s.add(t, "frame", { speech: true, rms: 0.2, ref: 1 });
  for (let t = 4700; t < 5600; t += 40) s.add(t, "frame", { speech: true, rms: 0.03, ref: 1 });
  const r = run(s, { playAfter: 100 });
  ok(r.has("duck") && r.has("unduck") && !r.has("stop"), "相づちの扱いが誤り");
});
test("再生前に人が話し始めたら声を出さない（回数も消費しない）", () => {
  const r = run(speaking().say(3400, 3800));
  ok(r.has("stop", (a) => a.why === "before_play" && !a.started), "止まっていない");
  ok(r.turn.voiceCount === 0, "回数を消費した");
});
test("合成が遅すぎれば諦める", () => {
  const r = run(speaking().add(5500, "tick"));
  ok(r.has("stop", (a) => a.why === "late"), "諦めていない");
  ok(r.turn.voiceCount === 0, "回数を消費した");
});
test("再生失敗は画面ヒントに回す", () => {
  const s = speaking();
  const r0 = run(s);
  const id = r0.first("speak").speakId;
  const r = run(speaking().add(3450, "playFail", { speakId: id }));
  ok(r.has("hint", (a) => a.why === "play_failed") && r.turn.state === "LISTEN" && r.turn.voiceCount === 0, "失敗の扱いが誤り");
});
test("自分の声の認識結果は発言として扱わない", () => {
  const r = run(speaking().add(3600, "final", { uttId: 2, text: "経緯を知りたいんだと思います", who: "boss" }), { playAfter: 50 });
  ok(r.has("dropEcho") && !r.has("stop"), "エコー文の扱いが誤り");
});
test("話し終えた直後に届く自分の声も捨てる", () => {
  const r = run(speaking().quiet(3400, 6000).add(5400, "final", { uttId: 2, text: "どこで迷いました", who: "boss" }), { playAfter: 50, playMs: 1500 });
  ok(r.has("done") && r.has("dropEcho"), "余韻のエコーを捨てていない");
});
test("発話中に別の言葉が認識されたら止まる", () => {
  const r = run(speaking().add(3700, "interim", { text: "いや今のは違うんです" }), { playAfter: 50 });
  ok(r.has("stop", (a) => a.why === "barge"), "止まっていない");
});
test("誤って止まり続けない（言葉が続かなければ感度を下げる）", () => {
  const s = speaking();
  for (let t = 3400; t < 4400; t += 40) s.add(t, "frame", { speech: true, rms: 0.03, ref: 1 });
  for (let t = 4400; t < 5000; t += 40) s.add(t, "frame", { speech: true, rms: 0.2, ref: 1 });
  s.quiet(5000, 7600);
  const r = run(s, { playAfter: 100 });
  ok(r.has("stop") && r.has("falseBarge"), "誤検知の扱いが無い");
  ok(r.turn.voiceCount === 0, "誤検知で回数を消費した");
});

// --- レビューで見つかった取りこぼしの再発防止 ---
const ASK = "あの、心配してくれてるんだと思います。今止まってるのはどこですか？";
const speakingAsk = () => script().say(0, 2000).final(2300, 1).verdict(2350, 1, "high", { speech: ASK }).quiet(2000, 3400);
test("発話中の人の言葉は、セリフと似ていても消さずに止まる", () => {
  for (const [speech, text] of [["あの、怒ってるのとは違うと思います。どの場面でした？", "いや違うと思います"], [ASK, "今止まってるのは集計"]]) {
    const s = script().say(0, 2000).final(2300, 1).verdict(2350, 1, "high", { speech }).quiet(2000, 3400).add(3700, "final", { uttId: 2, text, who: "subordinate" });
    const r = run(s, { playAfter: 50 });
    ok(!r.has("dropEcho") && r.has("stop", (a) => a.why === "barge"), `${text} の扱いが誤り`);
  }
});
test("少し崩れて認識された自分の声では止まらない", () => {
  const speech = "あの、心配してくれてるんだと思います。今止まってるのはどこですか？";
  const s = script().say(0, 2000).final(2300, 1).verdict(2350, 1, "high", { speech }).quiet(2000, 3400).add(3700, "final", { uttId: 2, text: "心配してくれているんだと思います", who: "boss" });
  const r = run(s, { playAfter: 50 });
  ok(r.has("dropEcho") && !r.has("stop"), "自分の声で止まった");
});
test("Zoom：短い相づちの合図では止まらず、長い発話では止まる", () => {
  const build = (chars) => {
    const s = script().final(1000, 1).verdict(1050, 1);
    for (let t = 1100; t < 3000; t += 100) s.add(t, "tick");
    return s.add(2600, "activity", { who: "subordinate", chars });
  };
  ok(!run(build(2), { textOnly: true, playAfter: 50 }).has("stop"), "相づちで止まった");
  ok(run(build(8), { textOnly: true, playAfter: 50 }).has("stop"), "長い発話で止まらない");
});
for (const reply of ["今止まってるのは集計です", "止まってるのは集計のところです"]) {
  test(`ミナトの問いへの返答は消さない：${reply}`, () => {
    const r = run(speakingAsk().quiet(3400, 6000).add(5300, "final", { uttId: 2, text: reply, who: "subordinate" }), { playAfter: 50, playMs: 1500 });
    ok(r.has("done") && !r.has("dropEcho"), "返答を自分の声として捨てた");
  });
}
test("セリフと同じ言葉でも、人の声があれば消さない", () => {
  const s = speakingAsk().quiet(3400, 5000).say(5000, 5400).add(5450, "final", { uttId: 2, text: "今止まってるのはどこですか", who: "boss" });
  const r = run(s, { playAfter: 50, playMs: 1500 });
  ok(!r.has("dropEcho"), "人の発言を捨てた");
});
for (const word of ["はい", "うん", "なるほど"]) {
  test(`相づち「${word}」の確定では止まらない`, () => {
    const r = run(speaking().add(3700, "final", { uttId: 2, text: word, who: "subordinate" }), { playAfter: 50 });
    ok(!r.has("stop") && !r.has("dropEcho"), "止まった、または発言を捨てた");
  });
}
test("呼びかけを認識しても止まらない", () => {
  const r = run(speaking().add(3600, "final", { uttId: 2, text: "あの", who: "boss" }), { playAfter: 50 });
  ok(r.has("dropEcho") && !r.has("stop"), "呼びかけの扱いが誤り");
});
test("Zoom：確定より新しい発話が届いていれば話さない", () => {
  const s = script().add(900, "activity", { who: "subordinate", at: 10.5 }).final(1000, 1, HARSH, "boss");
  s.ev[s.ev.length - 1].at = 10.0;
  s.verdict(1050, 1);
  for (let t = 1100; t < 4000; t += 100) s.add(t, "tick");
  const r = run(s, { textOnly: true });
  ok(!r.has("speak") && r.has("hint", (a) => a.why === "moved_on"), "話してしまった");
});
test("Zoom：発言者本人の合図だけなら話す", () => {
  const s = script().add(900, "activity", { who: "boss", at: 9.5 }).final(1000, 1, HARSH, "boss");
  s.ev[s.ev.length - 1].at = 10.0;
  s.verdict(1050, 1);
  for (let t = 1100; t < 4000; t += 100) s.add(t, "tick");
  ok(run(s, { textOnly: true }).has("speak"), "話していない");
});
test("先行判定で待機中に届いた前の発言の判定は画面に回す", () => {
  const s = script().add(100, "speaker", { who: "boss" }).final(200, 1, "全然できてないじゃん").add(500, "interim", { text: HARSH }).say(300, 2000).quiet(2000, 2600)
    .verdict(2300, 0, "high", { spec: true }).verdict(2400, 1);
  ok(run(s).has("hint", (a) => a.uttId === 1), "判定が消えた");
});

// --- 回数の上限 ---
test("控えめ：開始3分は声を出さない", () => {
  const r = run(base().quiet(2000, 5000), { pace: "gentle" });
  ok(!r.has("speak") && r.has("hint", (a) => a.why === "warmup"), "開始直後に話した");
});
function twoInterventions(gapMs, cat2 = "pressure") {
  const t2 = 200000 + gapMs;
  const s = script();
  const at = (t, id, category) => s.say(t, t + 2000).final(t + 2300, id).verdict(t + 2350, id, "high", { category }).quiet(t + 2000, t + 5000);
  at(200000, 1, "accusatory_why");
  s.add(205000, "playEnd", { speakId: 1 });
  at(t2, 2, cat2);
  return s;
}
test("控えめ：間隔が5分未満なら2回目は画面へ", () => {
  const r = run(twoInterventions(120000), { pace: "gentle", playAfter: 50 });
  ok(r.actions.filter((a) => a.type === "speak").length === 1, "間隔を守っていない");
  ok(r.has("hint", (a) => a.why === "gap"), "gap になっていない");
});
test("控えめ：間隔が空けば2回目も話す", () => {
  const r = run(twoInterventions(320000), { pace: "gentle", playAfter: 50 });
  ok(r.actions.filter((a) => a.type === "speak").length === 2, "2回目を話していない");
});
test("控えめ：同じカテゴリは1回まで", () => {
  const r = run(twoInterventions(320000, "accusatory_why"), { pace: "gentle", playAfter: 50 });
  ok(r.has("hint", (a) => a.why === "category"), "同カテゴリを止めていない");
});
test("ふつう：30分で5回まで", () => {
  const s = script();
  const at = (t, id) => s.say(t, t + 2000).final(t + 2300, id).verdict(t + 2350, id).quiet(t + 2000, t + 5000).add(t + 4500, "playEnd", { speakId: id });
  for (let i = 0; i < 6; i++) at(60000 + i * 120000, i + 1);
  const r = run(s, { pace: "normal", playAfter: 50 });
  ok(r.actions.filter((a) => a.type === "speak").length === 5, "上限を守っていない");
  ok(r.has("hint", (a) => a.why === "budget"), "budget になっていない");
});
test("「不要」が続いたら以後は声を出さない", () => {
  const r = run(script().add(0, "mode", { voiceOff: true }).say(0, 2000).final(2300, 1).verdict(2350, 1).quiet(2000, 5000));
  ok(!r.has("speak") && r.has("hint", (a) => a.why === "voice_off"), "voiceOff が効いていない");
});

// --- Zoom・デモ（マイクなし） ---
test("文字だけのモード：確定後の無音を長めに待って話す", () => {
  const s = script().final(1000, 1).verdict(1050, 1);
  for (let t = 1100; t < 4000; t += 100) s.add(t, "tick");
  const r = run(s, { textOnly: true });
  const sp = r.first("speak");
  ok(sp && sp.t - 1000 >= 500 * 1.5, "待ちが短い"); // 「〜の」は問いかけ扱い
});
test("文字だけのモード：次の途中文が届いたら見送る", () => {
  const s = script().final(1000, 1).verdict(1050, 1).add(1400, "activity", { who: "subordinate" });
  for (let t = 1100; t < 4000; t += 100) s.add(t, "tick");
  const r = run(s, { textOnly: true });
  ok(!r.has("speak") && r.has("hint", (a) => a.why === "moved_on"), "見送っていない");
});
test("文字だけのモード：話している最中の発言で止まる", () => {
  const s = script().final(1000, 1).verdict(1050, 1);
  for (let t = 1100; t < 3000; t += 100) s.add(t, "tick");
  s.add(2600, "activity", { who: "boss" });
  const r = run(s, { textOnly: true, playAfter: 50 });
  ok(r.has("stop", (a) => a.why === "barge"), "止まっていない");
});
test("同じ入力なら必ず同じ結果（再現性）", () => {
  const a = JSON.stringify(run(speaking().quiet(3400, 8000), { playAfter: 100, playMs: 3000 }).actions);
  const b = JSON.stringify(run(speaking().quiet(3400, 8000), { playAfter: 100, playMs: 3000 }).actions);
  ok(a === b, "結果が揺れた");
});

// --- 文の処理 ---
test("句末の分類", () => {
  const t = { "なんで相談しなかったの": "question", "どう思いますか": "question", "全然できてないじゃん": "complete", "それは違うと思います": "complete", "分かるんだけど": "trailing", "遅れたので": "trailing", "もっとちゃんとやって": "trailing", "資料": "unknown", "なんで相談しなかったのとか": "trailing", "それでなんか": "trailing", "ええと、あの": "trailing", "その": "trailing", "部長の": "trailing", "全然できてないじゃん、お客さんの": "trailing", "田中さんの": "trailing", "みんなの": "trailing", "あなたの": "trailing", "そうなの": "question" };
  for (const [k, v] of Object.entries(t)) ok(classifyTail(k) === v, `${k} → ${classifyTail(k)}（期待 ${v}）`);
});
test("ミナト用PCで話すときは、話し出しの遅れを長めに待つ", () => {
  // 普段は1.5秒で諦めるが、ミナト用PC（Wi-Fi越しの合成・再生）では2.5秒遅れても話す
  const local = run(speaking().quiet(3400, 9000), { playAfter: 2500, playMs: 2000 });
  ok(local.has("stop", (a) => a.why === "late"), "このPCで話すときに、遅れても諦めなかった");
  const remote = run(speaking().add(0, "mode", { remoteVoice: true }).quiet(3400, 9000), { playAfter: 2500, playMs: 2000 });
  ok(!remote.has("stop") && remote.has("done"), "ミナト用PCで話すときに、2.5秒の遅れで諦めた");
  const tooLate = run(speaking().add(0, "mode", { remoteVoice: true }).quiet(3400, 12000), { playAfter: 5000, playMs: 2000 });
  ok(tooLate.has("stop", (a) => a.why === "late"), "ミナト用PCでも、遅れすぎたら諦める");
});
test("ミナト用PCの声（音量が測れない）は、音だけでは止まらない", () => {
  const s = speaking().add(0, "mode", { remoteVoice: true });
  s.add(3550, "playStart", { speakId: 1, levelOk: false });
  for (let t = 3600; t < 6000; t += 40) s.add(t, "frame", { speech: true, rms: 1, ref: null });
  s.add(6100, "playEnd", { speakId: 1 });
  const r = run(s);
  ok(!r.has("stop"), "会議から戻ってきた音で止まった");
  ok(r.has("done"), "最後まで話していない");
});
test("エコー判定と文分割", () => {
  ok(isEchoText("経緯を知りたい", LINE), "自分の声を見逃した");
  ok(!isEchoText("今の言い方はちょっと", LINE), "別の発言をエコー扱いした");
  ok(splitSentences("あの、そうです。どこですか？はい").length === 3, "文分割が誤り");
});

let failed = 0;
for (const c of cases) {
  try {
    c.fn();
    console.log(`  ok   ${c.name}`);
  } catch (e) {
    failed++;
    console.log(`  NG   ${c.name}\n         ${e.message}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} 通過`);
process.exit(failed ? 1 : 0);
