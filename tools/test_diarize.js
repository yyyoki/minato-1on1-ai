// 声を登録しない話者判定の検証。macOS の say で作った2人の会話を流し、
// 「声の特徴で2人に分ける → 敬語の差と最初に話した方で上司・部下を割り当てる」が当たるかを確かめる。
// 使い方: node tools/test_diarize.js <wavを置くフォルダ>
"use strict";
const { frames, synth, VP } = require("./test_voiceprint.js");
const D = require("../static/diarize.js");

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "ok  " : "NG  "} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
}

// ---- 1. 音を使わない単体テスト ----
console.log("単体テスト");
const fake = (offset, n = 30, st = 20) => ({ st, spread: 1, n, nVoiced: n, ltas: new Array(VP.BANDS).fill(0).map((_, b) => (b % 2 ? offset : -offset)) });
{
  const d = D.create();
  const a = d.add(fake(0), "先週の資料どうなってる？");
  check("1人目の最初の発言は「?」付きで上司", a.role === "boss" && !a.sure);
  const b = d.add(fake(0.6, 30, 30), "すみません、まだ半分くらいです");
  check("離れた声は2人目になる", d.info().twoFound);
  check("敬語の少ない方（最初に話した方）が上司", b.role === "subordinate", JSON.stringify(b));
}
{
  // 部下が先に話した場合：敬語の差で入れ替わり、最初の発言の札も直る
  const d = D.create();
  d.add(fake(0.6, 30, 30), "お疲れさまです。よろしくお願いします");
  d.add(fake(0), "じゃあ始めようか");
  d.add(fake(0.6, 30, 30), "はい、先週の件から話してもいいですか");
  const r = d.add(fake(0), "うん、どうなってる？");
  const first = r.changed.find((c) => c.index === 0);
  check("部下が先に話しても、敬語の差で部下と判定する", r.role === "boss");
  check("それまでの札も見直される（最初の発言＝部下）", !first || first.role === "subordinate");
}
{
  // 敬語では決まらない時は、名札の修正で決まる
  const d = D.create();
  d.add(fake(0), "よろしくお願いします");
  d.add(fake(0.6, 30, 30), "よろしくお願いします");
  const c = d.correct(0, "subordinate");
  const v = d.add(fake(0.6, 30, 30), "それで、どうしましょうか");
  check("名札の修正で上司・部下が入れ替わる", v.role === "boss" && c.changed.some((x) => x.index === 1 && x.role === "boss"));
}
{
  const d = D.create();
  for (let i = 0; i < 9; i++) d.add(fake(0.01 * (i % 3)), "はい");
  check("1人分の声しか見つからない時は「見分けにくい」", d.info().hard);
}
{
  // 声が近く1人分しか見つからない時に、名札を押し間違えて取り消しても、ほかの発言の札は入れ替わらない
  const d = D.create();
  d.add(fake(0), "先週の資料どうなってる？");
  d.add(fake(0.01), "なるほどね");
  d.add(fake(0.02), "じゃあ次はどうする？");
  d.correct(1, "subordinate");
  const back = d.correct(1, "boss");
  check("名札の修正を取り消しても、ほかの発言は上司のまま", !back.changed.some((c) => c.index !== 1 && c.role === "subordinate"), JSON.stringify(back.changed));
}
check("オンライン：会議の音が多ければ相手", D.bySource(3, 40, "boss").role === "subordinate");
check("オンライン：マイクが多ければこのPCの人", D.bySource(40, 2, "subordinate").role === "subordinate");
check("オンライン：音がほとんどなければ未定", D.bySource(1, 1, "boss").role === null);

// ---- 2. 合成音声の会話 ----
// 上司はくだけた話し方、部下は丁寧語（よくある1on1）。「はい」などの短い相づちも混ぜる
const BOSS = [
  "先週の資料、進捗どうなってる？",
  "なんでもっと早く相談しなかったの？",
  "そうだね。どういう経緯だったか教えてもらえる？",
  "じゃあ次は、どの時点で声をかけるか一緒に決めようか",
  "集計のところは、最初に範囲を決めておくと楽になるよ",
  "水曜なら大丈夫。午後に少し時間を取ろう",
];
const SUB = [
  "すみません、まだ半分くらいで…",
  "データの集計で迷っていて、どこまで調べればいいか分からなくなっていました",
  "はい、来週の水曜までには一度見せられると思います",
  "ありがとうございます。範囲を先に決めるようにします",
  "午後でお願いします。それまでに下書きを用意しておきます",
  "はい",
];
const SCRIPTS = {
  "上司から話し始める": [["b", 0], ["s", 0], ["b", 1], ["s", 1], ["b", 2], ["s", 2], ["b", 3], ["s", 5], ["b", 4], ["s", 3], ["b", 5], ["s", 4]],
  "部下から話し始める": [["s", 0], ["b", 0], ["s", 1], ["b", 1], ["b", 2], ["s", 2], ["b", 3], ["s", 5], ["b", 4], ["s", 3], ["b", 5], ["s", 4]],
};

function runConversation(bossVoice, subVoice, script) {
  const d = D.create();
  const shown = [];   // 発言した時点で画面に出た話者（自信がない時は上司扱い）
  const truth = [];
  let sureWrongLive = 0;
  for (const [who, k] of script) {
    const voice = who === "b" ? bossVoice : subVoice;
    const text = who === "b" ? BOSS[k] : SUB[k];
    const r = d.add(VP.makePrint(frames(synth(voice, text))), text);
    truth.push(who === "b" ? "boss" : "subordinate");
    shown.push({ role: r.sure ? r.role : "boss", sure: r.sure });
    if (r.sure && r.role !== truth[truth.length - 1]) sureWrongLive++;
    r.changed.forEach((c) => { if (shown[c.index]) shown[c.index] = { role: c.sure ? c.role : "boss", sure: c.sure }; });
  }
  const finalOk = shown.filter((s, i) => s.role === truth[i]).length;
  const sureWrong = shown.filter((s, i) => s.sure && s.role !== truth[i]).length;
  const unsure = shown.filter((s) => !s.sure).length;
  return { finalOk, total: truth.length, sureWrong, sureWrongLive, unsure, info: d.info() };
}

const PAIRS = [
  ["Reed (日本語（日本）)", "Kyoko", "男性上司 × 女性部下"],
  ["Kyoko", "Eddy (日本語（日本）)", "女性上司 × 男性部下"],
  ["Kyoko", "Flo (日本語（日本）)", "女性 × 女性"],
  ["Grandpa (日本語（日本）)", "Rocko (日本語（日本）)", "男性 × 男性(2)"],
  ["Sandy (日本語（日本）)", "Shelley (日本語（日本）)", "女性 × 女性(2)"],
  ["Reed (日本語（日本）)", "Eddy (日本語（日本）)", "男性 × 男性（声が近い）"],
];

console.log("\n合成音声の会話（声の登録なし）");
let ok = 0, total = 0;
for (const [b, s, label] of PAIRS) {
  for (const [name, script] of Object.entries(SCRIPTS)) {
    const r = runConversation(b, s, script);
    const close = r.info.separation < D.LOW_SEPARATION;
    const line = `${label.padEnd(16)} ${name}  最終 ${r.finalOk}/${r.total}  「?」${r.unsure}件  自信ありで誤り ${r.sureWrong}件（その場 ${r.sureWrongLive}件）  2人の距離 ${r.info.separation}`;
    if (close) {
      // 声が近すぎるペアは、自信ありで間違えない（=「?」を付けて手動を促す）ことを合格条件にする
      check(line + "  → 見分けにくいので「?」で手動に任せる", r.sureWrong === 0);
    } else {
      ok += r.finalOk; total += r.total;
      check(line, r.finalOk >= r.total - 1 && r.sureWrong === 0);
    }
  }
}
console.log(`\n見分けられるペアの合計 ${ok}/${total}`);
console.log(failures ? `\n失敗 ${failures}` : "\n失敗 0");
process.exit(failures ? 1 : 0);
