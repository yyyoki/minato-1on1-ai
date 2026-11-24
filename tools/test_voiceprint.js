// 話者判定のオフライン検証。macOS の say で作った声を使い、
// 「登録文で声を登録 → 別の文で上司/部下を当てられるか」を確かめる。
// 使い方: node tools/test_voiceprint.js <wavを置くフォルダ>
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const VP = require("../static/voiceprint.js");

const outDir = process.env.VP_WAV_DIR || process.argv[2] || fs.mkdtempSync("/tmp/vp-");
const SR = 48000;

// アプリの「声の登録」と同じ読み上げ文（上司・部下で同じ文にして、文の違いが判定に混ざらないようにする）
const ENROLL_TEXT = "今日はよろしくお願いします。最近の仕事の様子や、気になっていることを、順番に話していきますね。";
const ENROLL = { boss: ENROLL_TEXT, subordinate: ENROLL_TEXT };
const LINES = {
  boss: ["先週の資料、進捗どうなってる？", "なんでもっと早く相談しなかったの？", "そうだね。どういう経緯だったか教えてもらえる？", "じゃあ次は、どの時点で声をかけるか一緒に決めようか"],
  subordinate: ["すみません、まだ半分くらいで…", "データの集計で迷っていて、どこまで調べればいいか分からなくなっていました", "はい、来週の水曜までには一度見せられると思います"],
};

function synth(voice, text, rate = SR) {
  const safe = voice.replace(/[^A-Za-z]/g, "");
  const file = path.join(outDir, `${safe}_${Buffer.from(text).toString("hex").slice(0, 24)}_${rate}.wav`);
  if (!fs.existsSync(file)) execFileSync("say", ["-v", voice, "-o", file, "--file-format=WAVE", `--data-format=LEI16@${rate}`, text]);
  return file;
}

function readWav(file) {
  const buf = fs.readFileSync(file);
  let off = 12, sr = 0, data = null;
  while (off < buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") sr = buf.readUInt32LE(off + 12);
    if (id === "data") data = buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  const out = new Float32Array(data.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = data.readInt16LE(i * 2) / 32768;
  return { sr, samples: out };
}

// noise: 部屋の雑音を模した白色雑音（信号RMSに対する比）。maxSec: 冒頭だけ使う。gain: 声の大きさ
// speed: 再生速度の比（声の高さと声色が同時にずれる。声の調子の違いの模擬）／ tilt: 高音寄り(+)・低音寄り(−)の音質変化（マイクとの距離・向きの模擬）
// reverb: 部屋の反響の強さ（0〜1）
function frames(file, { noise = 0, maxSec = Infinity, gain = 1, speed = 1, tilt = 0, reverb = 0 } = {}) {
  let { sr, samples } = readWav(file);
  if (speed !== 1) {
    const out = new Float32Array(Math.floor(samples.length / speed));
    for (let i = 0; i < out.length; i++) {
      const p = i * speed, k = Math.floor(p), f = p - k;
      out[i] = samples[k] * (1 - f) + (samples[Math.min(k + 1, samples.length - 1)] || 0) * f;
    }
    samples = out;
  }
  if (tilt) {
    const out = new Float32Array(samples.length);
    // tilt>0: 1次の高域強調、tilt<0: 1次の低域通過
    for (let i = 0; i < samples.length; i++) {
      out[i] = tilt > 0 ? samples[i] - tilt * (i ? samples[i - 1] : 0) : (1 + tilt) * samples[i] - tilt * (i ? out[i - 1] : 0);
    }
    samples = out;
  }
  if (reverb) {
    // まばらな反射（約0.25秒まで、指数で減衰）を足す。同じ設定なら毎回同じ反響になる
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const taps = Array.from({ length: 36 }, (_, t) => ({ d: Math.floor(sr * (0.004 + rnd() * 0.25)), g: reverb * (rnd() * 2 - 1) * Math.exp(-t / 14) }));
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      let v = samples[i];
      for (const t of taps) if (i >= t.d) v += t.g * samples[i - t.d];
      out[i] = v;
    }
    samples = out;
  }
  if (noise) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const level = Math.sqrt(sum / samples.length) * noise * Math.sqrt(3);
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    samples = samples.map((v) => v + rnd() * level);
  }
  const vad = VP.createVad();
  const noiseModel = VP.createNoiseModel();   // アプリと同じ：毎フレームで雑音を見積もり、特徴を取るときに引く
  const hop = Math.round(sr * 0.04);
  const res = [];
  for (let s = 0; s + VP.N <= samples.length; s += hop) {
    const chunk = samples.slice(s, s + VP.N).map((v) => v * gain);
    noiseModel.update(chunk);   // 話している最中でも毎フレーム更新する（最小統計法）
    const f = VP.frameFeatures(chunk, sr, noiseModel);
    if (vad(f.rms)) res.push(f);
    if (res.length * 0.04 >= maxSec) break;
  }
  return res;
}

function runPair(bossVoice, subVoice, opts = {}) {
  const refs = {
    boss: VP.makePrint(frames(synth(bossVoice, ENROLL.boss))),
    subordinate: VP.makePrint(frames(synth(subVoice, ENROLL.subordinate))),
  };
  let ok = 0, total = 0;
  const confs = [];
  const rows = [];
  for (const who of ["boss", "subordinate"]) {
    const voice = who === "boss" ? bossVoice : subVoice;
    for (const line of LINES[who]) {
      const fr = frames(synth(voice, line), who === "boss" ? opts.boss || {} : opts.subordinate || {});
      const u = VP.makePrint(fr);
      if (who === "boss" && opts.bossPitchUp) u.st += opts.bossPitchUp;
      const r = VP.classify(u, refs);
      total++;
      if (r.speaker === who) ok++;
      confs.push(r.speaker === who ? r.confidence : 1 - r.confidence);
      rows.push(`${who === r.speaker ? "○" : "×"} ${who.padEnd(11)} → ${r.speaker.padEnd(11)} ${(r.confidence * 100).toFixed(0)}%  ${JSON.stringify(r.distances)}`);
    }
  }
  return { ok, total, minConf: Math.min(...confs), rows, refs };
}

module.exports = { frames, synth, ENROLL, LINES, VP };
if (require.main !== module) return;

const PAIRS = [
  ["Reed (日本語（日本）)", "Kyoko", "男性上司 × 女性部下"],
  ["Kyoko", "Eddy (日本語（日本）)", "女性上司 × 男性部下"],
  ["Reed (日本語（日本）)", "Eddy (日本語（日本）)", "男性 × 男性"],
  ["Kyoko", "Flo (日本語（日本）)", "女性 × 女性"],
  ["Grandpa (日本語（日本）)", "Rocko (日本語（日本）)", "男性 × 男性(2)"],
  ["Sandy (日本語（日本）)", "Shelley (日本語（日本）)", "女性 × 女性(2)"],
];

const verbose = process.env.VERBOSE === "1";
let allOk = 0, allTotal = 0, failures = 0;
for (const [b, s, label] of PAIRS) {
  const r = runPair(b, s);
  const sep = VP.separation(r.refs);
  const head = `${label.padEnd(14)} 見分けやすさ ${sep.level.padEnd(6)}(${sep.score})  正解 ${r.ok}/${r.total}  最低確信度 ${(r.minConf * 100).toFixed(0)}%`;
  if (sep.level === "low") {
    // 声が近すぎるペアは、登録時に警告が出ること自体を合格条件にする（自動判定の対象外）
    console.log(`${head}  → 登録時に「声が近い」警告を出す（手動切替を案内）`);
  } else {
    allOk += r.ok; allTotal += r.total;
    if (r.ok !== r.total) failures++;
    console.log(head);
  }
  if (verbose) r.rows.forEach((x) => console.log("   " + x));
}
// 上司が感情的になって声が3半音上がった場合（声色はそのまま）
const excited = runPair(PAIRS[4][0], PAIRS[4][1], { bossPitchUp: 3 });
console.log(`興奮した上司(男×男(2), +3半音)     正解 ${excited.ok}/${excited.total}  最低確信度 ${(excited.minConf * 100).toFixed(0)}%`);
// 部屋の雑音あり（SNR 約20dB）
const noisy = runPair(PAIRS[5][0], PAIRS[5][1], { boss: { noise: 0.1 }, subordinate: { noise: 0.1 } });
console.log(`雑音あり(女×女(2), SNR約20dB)      正解 ${noisy.ok}/${noisy.total}  最低確信度 ${(noisy.minConf * 100).toFixed(0)}%`);
// 小さな声・話し始め0.8秒だけ（話している最中のライブ表示用）
const quiet = runPair(PAIRS[3][0], PAIRS[3][1], { boss: { gain: 0.25, maxSec: 0.8 }, subordinate: { gain: 0.25, maxSec: 0.8 } });
console.log(`小声・冒頭0.8秒だけ(女×女)         正解 ${quiet.ok}/${quiet.total}  最低確信度 ${(quiet.minConf * 100).toFixed(0)}%`);
for (const r of [excited, noisy, quiet]) { allOk += r.ok; allTotal += r.total; if (r.ok !== r.total) failures++; }
console.log(`\n自動判定の対象ペア 合計 ${allOk}/${allTotal}`);
process.exit(failures ? 1 : 0);
