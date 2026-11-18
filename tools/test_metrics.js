"use strict";
// 音声計測（static/metrics.js）の再生テスト。  node tools/test_metrics.js
// 合成した時系列で、計測の算出が正しいことを確かめるもの。実マイクの速度や精度を示すものではない。
const path = require("path");
const M = require(path.join(__dirname, "..", "static", "metrics.js"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  ok  ", name); }
  else { fail++; console.log("  NG  ", name, detail !== undefined ? JSON.stringify(detail) : ""); }
}

// from〜to の間、40msごとに声あり／なしのフレームを流す
const frames = (target, from, to, speech) => { for (let t = from; t < to; t += 40) target.frame(t, speech); };

// ---- 統計 ----
check("統計：中央値・90%点・最大", JSON.stringify(M.stats([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000])) === JSON.stringify({ n: 10, median: 550, p90: 900, max: 1000 }));
check("統計：空とNaNは除く", M.stats([]) === null && M.stats([NaN, null, 5]).n === 1);
check("一致率：同じ文は100%", M.matchRate("今日はよろしくお願いします。", "今日は よろしくお願いします") === 1);
check("一致率：1文字違いは下がる", Math.abs(M.matchRate("水曜までに一度", "水曜までに一読") - 6 / 7) < 1e-9);
check("一致率：空の認識は0%", M.matchRate("はい。", "") === 0);

// ---- 面談中の計測 ----
{
  const m = M.createMeter();
  frames(m, 1000, 3000, true);          // 最後の声は 2960
  m.interim(1300);
  m.interim(1900);                      // 最初の途中文だけを使う
  const id = m.final(3500, 12);
  const r = m.records()[0];
  check("最初の途中文まで＝発話開始から300ms", r.firstInterimMs === 300, r);
  check("確定まで＝最後の声から540ms", r.finalMs === 540, r);
  check("静かなあとの確定は途中確定ではない", r.cutWhileSpeaking === false);
  m.bind(7, id);
  m.judged(id, 41.6);
  m.raised(7, 3600);
  m.spoke(7, 4700);
  check("判定時間・手を挙げるまで・話し出しまで", r.judgeMs === 42 && r.raiseMs === 100 && r.speakMs === 1740 && r.speakAfterFinalMs === 1200, r);
  const s = M.summarizeMeeting(m.records());
  check("要約：件数と中央値", s.utterances === 1 && s.final.median === 540 && s.speak.median === 1740 && s.cut === 0, s);
  const ex = JSON.stringify(m.export());
  check("保存用は数値のみ（内部時刻・IDを含まない）", !/_finalAt|_endAt|"id"/.test(ex) && /"finalMs":540/.test(ex), ex);
}
{
  const m = M.createMeter();
  frames(m, 0, 1000, true);
  m.final(1000, 5);                     // 声が出ている最中に確定
  check("声が続いているうちの確定を検出", m.records()[0].cutWhileSpeaking === true, m.records()[0]);
}
{
  const m = M.createMeter();
  frames(m, 0, 800, true);
  m.interim(200);
  m.final(1500, 6);
  frames(m, 1500, 2300, true);          // 確定の直後に次の発話。前の途中文を引き継がない
  m.final(3000, 6);
  const [a, b] = m.records();
  check("2つ目の発話は計測が引き継がれない", a.firstInterimMs === 200 && b.firstInterimMs === null && b.finalMs > 0, [a, b]);
}
{
  const m = M.createMeter();
  frames(m, 0, 500, true);
  frames(m, 500, 1200, false);          // 600ms以上あいたら別の発話
  frames(m, 1200, 1600, true);
  m.interim(1300);
  m.final(2400, 4);
  check("声の途切れが長ければ新しい発話として数える", m.records()[0].firstInterimMs === 100, m.records()[0]);
}
{
  const m = M.createMeter();
  m.final(100, 3);
  check("声を聞く前の確定でも落ちない", m.records()[0].finalMs === null && m.records()[0].cutWhileSpeaking === false);
}

// ---- 読み上げテスト ----
function drive(test, script) {
  for (const ev of script) test.step(ev);
}
const speechFrames = (from, to) => { const a = []; for (let t = from; t < to; t += 40) a.push({ t, type: "frame", speech: true }); return a; };
const quietFrames = (from, to) => { const a = []; for (let t = from; t < to; t += 40) a.push({ t, type: "frame", speech: false }); return a; };

{
  // p01：ふつうに読む → 認識は1回で確定
  const test = M.createTest();
  test.start(0);
  drive(test, [
    ...quietFrames(0, 1000),
    ...speechFrames(1000, 3000),
    { t: 1400, type: "interim", text: "今日は" },
    ...quietFrames(3000, 3400),
    { t: 3500, type: "final", text: "今日はよろしくお願いします" },
    ...quietFrames(3400, 5300),
  ]);
  const r = test.results()[0];
  check("テスト：1文目が記録される", r && r.id === "p01" && r.finals === 1, r);
  check("テスト：速さ（途中文400ms・確定540ms）", r.firstInterimMs === 400 && r.finalMs === 540, r);
  check("テスト：一致率100%・区切りすぎなし", r.matchPct === 100 && r.cutWhileSpeaking === false && r.noFinal === false, r);
  check("テスト：次の文へ進む", test.view.index === 1 && (test.view.phase === "between" || test.view.phase === "wait"), test.view);
}
{
  // p03：「だけど、」で1秒止まったら認識が確定してしまった（区切りすぎ）
  const test = M.createTest();
  test.start(0);
  test.skip(0); test.step({ t: 800, type: "tick" }); test.skip(800); test.step({ t: 1600, type: "tick" }); // p01・p02を飛ばす
  const base = 2400;
  drive(test, [
    ...speechFrames(base, base + 1500),                      // 〜んだけど、
    { t: base + 1800, type: "final", text: "悪くはないんだけど" },
    ...quietFrames(base + 1500, base + 2500),                // 1秒の間
    ...speechFrames(base + 2500, base + 4000),               // 続き
    { t: base + 4600, type: "final", text: "もう少し考えてほしかったな" },
    ...quietFrames(base + 4000, base + 6400),
  ]);
  const r = test.results()[2];
  check("テスト：p03 は間をあけた文として扱う", r.id === "p03" && r.pauseExpected && r.pauseDone, r);
  check("テスト：間で確定して2回に割れたことを検出", r.finals === 2 && r.cutWhileSpeaking === true, r);
  const s = M.summarizeTest(test.results());
  check("テスト要約：間をあけた文の割れ", s.pauseTried === 1 && s.pauseSplit === 1, s);
}
{
  // 声が出ない文は飛ばす。確定が届かない文は打ち切る
  const test = M.createTest();
  test.start(0);
  test.step({ t: 19000, type: "tick" });
  check("テスト：声が出ないうちは待つ", test.view.index === 0 && test.view.phase === "wait", test.view);
  test.step({ t: 20000, type: "tick" });
  check("テスト：20秒で飛ばす", test.results()[0].noSpeech === true && test.view.index === 1, test.results());
  drive(test, [{ t: 21000, type: "tick" }, ...speechFrames(21000, 22000), ...quietFrames(22000, 28100)]);
  const r = test.results()[1];
  check("テスト：確定が届かなければ未確定として打ち切る", r.noFinal === true && r.finalMs === null && r.matchPct === null, r);
}
{
  // 10文すべてが終わる
  const test = M.createTest(M.PROMPTS.slice(0, 2));
  test.start(0);
  let t = 0;
  for (let i = 0; i < 2; i++) {
    drive(test, [...speechFrames(t, t + 800), { t: t + 1500, type: "final", text: "x" }, ...quietFrames(t + 800, t + 3000)]);
    t += 3000;
    test.step({ t, type: "tick" });
    t += 800;
    test.step({ t, type: "tick" });
  }
  check("テスト：すべて終えると完了になる", test.view.phase === "done" && test.results().length === 2, test.view);
  const ex = JSON.stringify(test.results());
  check("テスト：結果に文の本文を含まない", !/text|よろしく/.test(ex), ex);
}
check("読み上げの文は10個で、間をあける文が含まれる", M.PROMPTS.length === 10 && M.PROMPTS.filter((p) => p.pause).length === 2);

console.log(`\n${pass}/${pass + fail} 通過`);
process.exit(fail ? 1 : 0);
