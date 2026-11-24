// 声の高さが近い2人でも見分けられるか。macOS の say の日本語9音声から作れる全36ペアで、
// 「きれいな声で登録 → 別の文を、実際の面談に近い悪い条件で当てる」を試す。
// 声の高さの差が2.5半音以内のペアを「似た声」として別に数える。
// 使い方: node tools/test_similar_voices.js
//   環境変数  VP_WAV_DIR=音声の置き場所  VERBOSE=1=ペアごとに表示  MIN_ALL / MIN_CLOSE=合格ライン（既定 0.97 / 0.92）
"use strict";
process.env.VP_WAV_DIR = process.env.VP_WAV_DIR || "/tmp/vp-similar";
require("fs").mkdirSync(process.env.VP_WAV_DIR, { recursive: true });
const { frames, synth, ENROLL, LINES, VP } = require("./test_voiceprint.js");

const VOICES = ["Reed (日本語（日本）)", "Kyoko", "Eddy (日本語（日本）)", "Flo (日本語（日本）)", "Grandpa (日本語（日本）)",
  "Rocko (日本語（日本）)", "Sandy (日本語（日本）)", "Shelley (日本語（日本）)", "Grandma (日本語（日本）)"];
const SHORT = (v) => v.replace(/ \(.*\)$/, "");
const TEXTS = [...LINES.boss, ...LINES.subordinate];
const CLOSE_ST = 2.5;

// 実際の面談で起きること。登録はきれいな声、面談中の発話にだけ掛ける
const CONDITIONS = [
  { name: "きれいな声", opts: {} },
  { name: "雑音 SNR約20dB", opts: { noise: 0.1 } },
  { name: "雑音 SNR約10dB", opts: { noise: 0.3 } },
  { name: "小声・冒頭0.8秒だけ", opts: { gain: 0.25, maxSec: 0.8 } },
  { name: "マイクから遠い（こもる）", opts: { tilt: -0.75 } },
  { name: "マイクが近い（きつい）", opts: { tilt: 0.75 } },
  { name: "部屋の反響", opts: { reverb: 0.35 } },
  { name: "声の調子が低い（−4%）", opts: { speed: 0.96 } },
  { name: "声の調子が高い（+4%）", opts: { speed: 1.04 } },
  { name: "興奮して声が+3半音（上司側）", opts: {}, mutate: (u) => Object.assign({}, u, { st: u.st + 3 }) },
  { name: "全部まとめて（雑音+音質+反響+調子）", opts: { noise: 0.1, tilt: 0.4, reverb: 0.25, speed: 1.03 } },
];

const enrollCache = {}, testCache = {};
const enrollOf = (voice) => (enrollCache[voice] = enrollCache[voice] || VP.makePrint(frames(synth(voice, ENROLL.boss))));
function testsOf(voice, opts) {
  const key = voice + JSON.stringify(opts);
  return (testCache[key] = testCache[key] || TEXTS.map((t) => VP.makePrint(frames(synth(voice, t), opts))));
}

function runCondition(cond) {
  const rows = [];
  for (let i = 0; i < VOICES.length; i++) {
    for (let j = i + 1; j < VOICES.length; j++) {
      const refs = { boss: enrollOf(VOICES[i]), subordinate: enrollOf(VOICES[j]) };
      let ok = 0, total = 0, minConf = 1;
      for (const [who, v] of [["boss", VOICES[i]], ["subordinate", VOICES[j]]]) {
        for (const u0 of testsOf(v, cond.opts)) {
          const u = cond.mutate && who === "boss" ? cond.mutate(u0) : u0;
          const r = VP.classify(u, refs);
          total++;
          const good = r.speaker === who;
          if (good) ok++;
          minConf = Math.min(minConf, good ? r.confidence : 1 - r.confidence);
        }
      }
      const dst = Math.abs(refs.boss.st - refs.subordinate.st);
      rows.push({ a: SHORT(VOICES[i]), b: SHORT(VOICES[j]), dst, close: dst <= CLOSE_ST, ok, total, minConf, sep: VP.separation(refs) });
    }
  }
  return rows;
}

function summarize(rows) {
  const sum = (rs) => rs.reduce((s, r) => ({ ok: s.ok + r.ok, total: s.total + r.total }), { ok: 0, total: 0 });
  return { all: sum(rows), close: sum(rows.filter((r) => r.close)), perfect: rows.filter((r) => r.ok === r.total).length, pairs: rows.length };
}

module.exports = { VOICES, CONDITIONS, runCondition, summarize, enrollOf, testsOf, CLOSE_ST };
if (require.main !== module) return;

const pct = (x) => ((x.ok / x.total) * 100).toFixed(1).padStart(5) + "%";
console.log(`${"条件（登録はきれいな声）".padEnd(34)} 全${VOICES.length * (VOICES.length - 1) / 2}ペア   似た声のペア`);
let totAll = { ok: 0, total: 0 }, totClose = { ok: 0, total: 0 }, worst = { all: 1, close: 1, name: "" };
for (const cond of CONDITIONS) {
  const rows = runCondition(cond);
  const s = summarize(rows);
  totAll = { ok: totAll.ok + s.all.ok, total: totAll.total + s.all.total };
  totClose = { ok: totClose.ok + s.close.ok, total: totClose.total + s.close.total };
  if (s.all.ok / s.all.total < worst.all) worst = { all: s.all.ok / s.all.total, close: s.close.ok / s.close.total, name: cond.name };
  console.log(`${cond.name.padEnd(34 - [...cond.name].filter((c) => c.charCodeAt(0) > 255).length)} ${pct(s.all)}（${s.all.ok}/${s.all.total}）  ${pct(s.close)}（${s.close.ok}/${s.close.total}）`);
  if (process.env.VERBOSE === "1") {
    rows.filter((r) => r.ok !== r.total).forEach((r) => console.log(`     × ${r.a} × ${r.b}  差${r.dst.toFixed(1)}半音  ${r.ok}/${r.total}`));
  }
}
console.log(`\n全条件の合計  全ペア ${pct(totAll)}（${totAll.ok}/${totAll.total}）  似た声のペア ${pct(totClose)}（${totClose.ok}/${totClose.total}）`);
console.log(`いちばん悪い条件  ${worst.name}  全ペア ${(worst.all * 100).toFixed(1)}%  似た声 ${(worst.close * 100).toFixed(1)}%`);
// 合格ライン（実測は全ペア98.6%・似た声95.3%）。これを下回ったら、声の見分けが悪化したとみなす
const MIN_ALL = Number(process.env.MIN_ALL || 0.97), MIN_CLOSE = Number(process.env.MIN_CLOSE || 0.92);
process.exit(totAll.ok / totAll.total >= MIN_ALL && totClose.ok / totClose.total >= MIN_CLOSE ? 0 : 1);
