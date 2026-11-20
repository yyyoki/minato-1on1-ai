// 声を登録しなくても、上司と部下を見分ける。
// 対面：発言ごとの声の特徴を2つのグループに自動で分け、「名札の修正 → 敬語の差 → 最初に話した方」の順で上司・部下を割り当てる。
// オンライン：マイク（このPCの人）と会議の音（相手）のどちらが鳴っていたかで決める。
// ブラウザ（window.Diarize）と Node（テスト用）の両方で動く。
(function (root) {
  "use strict";

  const VP = typeof module !== "undefined" && module.exports ? require("./voiceprint.js") : root.VoicePrint;

  const NEW_SPEAKER_DIST = 7;   // 1人目の声の平均からこれ以上離れたら、2人目の候補にする
  const MIN_FRAMES = 10;        // これ未満の短い発言（「はい」など）は、2人目の根拠にしない
  const LOW_SEPARATION = 4;     // 2人の声の平均がこれより近いと、見分けられないとみなす
  const SURE_MAPPING = 1;       // 上司・部下の割り当ての確かさ。これ未満は「?」
  const ANCHOR_WEIGHT = 3;      // 名札の修正1件の重み
  const KEIGO_WEIGHT = 2;       // 敬語の割合の差 × 少ない方の発言数 にかける重み
  const FIRST_WEIGHT = 1;       // 最初に話した方を上司とみなす重み
  const HARD_AFTER = 8;         // これだけ話しても1人分の声しか見つからなければ「見分けにくい」
  const KEIGO = /(です|ます|まし|ません|でした|でしょう|ございま|ください|いただ|おりま|申し訳|すみません|すいません)/;
  const OTHER = { boss: "subordinate", subordinate: "boss" };

  // 複数の発言の特徴を、長さで重みをつけて平均する
  function merge(prints) {
    const ltas = new Array(VP.BANDS).fill(0);
    let n = 0, nVoiced = 0, st = 0;
    prints.forEach((p) => {
      for (let b = 0; b < VP.BANDS; b++) ltas[b] += p.ltas[b] * p.n;
      n += p.n;
      if (p.nVoiced >= 3) { st += p.st * p.nVoiced; nVoiced += p.nVoiced; }
    });
    if (!n) return null;
    for (let b = 0; b < VP.BANDS; b++) ltas[b] /= n;
    return { ltas, n, nVoiced, st: nVoiced ? st / nVoiced : 0, spread: 0 };
  }

  function create() {
    const utts = [];        // { print, keigo, label }
    let assign = [];        // 発言ごとのグループ（0 / 1）
    let cents = [null, null];
    let twoFound = false;
    let seed = null;        // 名札の修正で2人目の起点になった発言（取り消された時に元に戻すため）

    const usable = () => utts.map((u, i) => i).filter((i) => utts[i].print);
    const members = (a, k) => usable().filter((i) => a[i] === k).map((i) => utts[i].print);

    // 割り当ての点数：プラスならグループ0が上司
    function mappingScore(a) {
      let s = 0;
      utts.forEach((u, i) => {
        if (!u.label || a[i] == null) return;
        s += ANCHOR_WEIGHT * (u.label === "boss" ? 1 : -1) * (a[i] === 0 ? 1 : -1);
      });
      if (twoFound) {
        const stat = [0, 1].map((k) => {
          const idx = usable().filter((i) => a[i] === k);
          return { n: idx.length, k: idx.length ? idx.filter((i) => utts[i].keigo).length / idx.length : 0 };
        });
        s += (stat[1].k - stat[0].k) * Math.min(stat[0].n, stat[1].n) * KEIGO_WEIGHT;
      }
      const first = usable()[0];
      if (first != null) s += FIRST_WEIGHT * (a[first] === 0 ? 1 : -1);
      return s;
    }

    const roleOfGroup = (k, score) => ((score >= 0) === (k === 0) ? "boss" : "subordinate");

    function kmeans(init) {
      const a = init.slice();
      let cs = [null, null];
      for (let it = 0; it < 10; it++) {
        cs = [0, 1].map((k) => merge(members(a, k)));
        if (!cs[0] || !cs[1]) return { a, cs, cost: Infinity };
        let changed = false;
        usable().forEach((i) => {
          if (utts[i].forced != null) {
            if (a[i] !== utts[i].forced) { a[i] = utts[i].forced; changed = true; }
            return;
          }
          const k = VP.distance(utts[i].print, cs[0]) <= VP.distance(utts[i].print, cs[1]) ? 0 : 1;
          if (k !== a[i]) { a[i] = k; changed = true; }
        });
        if (!changed) break;
      }
      cs = [0, 1].map((k) => merge(members(a, k)));
      if (!cs[0] || !cs[1]) return { a, cs, cost: Infinity };
      const cost = usable().reduce((s, i) => s + VP.distance(utts[i].print, cs[a[i]]), 0);
      return { a, cs, cost };
    }

    // 一番離れた2つの発言を起点に分け直す（最初の分け方が悪かった時の立て直し）
    function farthestInit() {
      const idx = usable().filter((i) => utts[i].print.n >= MIN_FRAMES);
      let best = null;
      for (let x = 0; x < idx.length; x++) {
        for (let y = x + 1; y < idx.length; y++) {
          const d = VP.distance(utts[idx[x]].print, utts[idx[y]].print);
          if (!best || d > best.d) best = { d, p: idx[x], q: idx[y] };
        }
      }
      if (!best) return null;
      const a = assign.slice();
      usable().forEach((i) => {
        a[i] = VP.distance(utts[i].print, utts[best.p].print) <= VP.distance(utts[i].print, utts[best.q].print) ? 0 : 1;
      });
      return a;
    }

    // 名札で直した発言は、その役のグループに固定する
    function applyLabels(a) {
      const score = mappingScore(a);
      utts.forEach((u, i) => {
        u.forced = u.label && u.print ? (roleOfGroup(0, score) === u.label ? 0 : 1) : null;
      });
    }

    function refit() {
      if (!twoFound) {
        cents = [merge(members(assign, 0)), null];
        return;
      }
      applyLabels(assign);
      const tries = [kmeans(assign)];
      const alt = farthestInit();
      if (alt) tries.push(kmeans(alt));
      let best = tries.reduce((p, c) => (c.cost < p.cost ? c : p));
      if (best.cost === Infinity) return;
      // グループの番号が入れ替わらないよう、これまでの分け方と揃える
      const same = usable().filter((i) => best.a[i] === assign[i]).length;
      if (same * 2 < usable().length) best = { a: best.a.map((k) => (k == null ? k : 1 - k)), cs: [best.cs[1], best.cs[0]] };
      assign = best.a;
      cents = best.cs;
    }

    function separation() {
      return twoFound && cents[0] && cents[1] ? VP.distance(cents[0], cents[1]) : 0;
    }

    function verdict(i) {
      const u = utts[i];
      if (!u.print || assign[i] == null) return { role: "boss", sure: false, confidence: null, group: null };
      const score = mappingScore(assign);
      const role = roleOfGroup(assign[i], score);
      if (u.label) return { role: u.label, sure: true, confidence: 1, group: assign[i] };
      if (!twoFound) return { role, sure: false, confidence: null, group: assign[i] };
      const r = VP.classify(u.print, { 0: cents[0], 1: cents[1] });
      const confidence = r ? (String(assign[i]) === r.speaker ? r.confidence : 1 - r.confidence) : 0;
      const sure = confidence >= VP.LOW_CONFIDENCE && Math.abs(score) >= SURE_MAPPING
        && separation() >= LOW_SEPARATION && u.print.n >= MIN_FRAMES / 2;
      return { role, sure, confidence, group: assign[i] };
    }

    const snapshot = () => utts.map((u, i) => verdict(i));

    function diff(before) {
      const changed = [];
      before.forEach((b, i) => {
        const v = verdict(i);
        if (v.role !== b.role || v.sure !== b.sure) changed.push({ index: i, role: v.role, sure: v.sure, confidence: v.confidence });
      });
      return changed;
    }

    return {
      // 確定した発言を1つ加える。changed は、それまでの発言で判定が変わったもの
      add(print, text = "") {
        const before = snapshot();
        const index = utts.length;
        utts.push({ print: print || null, keigo: KEIGO.test(text), label: null, forced: null });
        if (!print) {
          assign[index] = null;
        } else if (!usable().some((i) => i !== index)) {
          assign[index] = 0;
        } else if (!twoFound) {
          const d = VP.distance(print, cents[0]);
          if (d > NEW_SPEAKER_DIST && print.n >= MIN_FRAMES) {
            twoFound = true;
            assign[index] = 1;
          } else {
            assign[index] = 0;
          }
        } else {
          assign[index] = VP.distance(print, cents[0]) <= VP.distance(print, cents[1]) ? 0 : 1;
        }
        refit();
        return Object.assign({ index }, verdict(index), { changed: diff(before) });
      },

      // 名札で直した結果を覚える
      correct(index, role) {
        if (!utts[index]) return { changed: [] };
        const before = snapshot();
        const undo = utts[index].label && utts[index].label !== role;
        utts[index].label = role;
        if (undo && seed === index) {
          // 2人目の起点にした修正が取り消された：1人分の声に戻す（ほかの発言の札まで入れ替えないため）
          twoFound = false;
          seed = null;
          assign = assign.map((k) => (k == null ? k : 0));
        } else if (!twoFound && utts[index].print) {
          // 2人目がまだ見つかっていない時は、直された発言を2人目の起点にする
          const others = usable().filter((i) => i !== index);
          if (others.length && others.some((i) => assign[i] === 0)) {
            twoFound = true;
            seed = index;
            assign[index] = 1;
          }
        }
        refit();
        return { changed: diff(before) };
      },

      // 話している最中の推定（ステージで光らせる用）
      live(print) {
        if (!print || !twoFound || separation() < LOW_SEPARATION) return null;
        const r = VP.classify(print, { 0: cents[0], 1: cents[1] });
        if (!r || r.confidence < VP.LOW_CONFIDENCE) return null;
        const score = mappingScore(assign);
        if (Math.abs(score) < SURE_MAPPING) return null;
        return roleOfGroup(Number(r.speaker), score);
      },

      info() {
        const n = usable().length;
        return {
          utterances: utts.length,
          twoFound,
          separation: Math.round(separation() * 10) / 10,
          mapping: Math.round(mappingScore(assign) * 10) / 10,
          hard: (!twoFound && n >= HARD_AFTER) || (twoFound && n >= HARD_AFTER && separation() < LOW_SEPARATION),
        };
      },
    };
  }

  // オンライン会議：発言のあいだに鳴っていたのが、マイク（このPCの人）か会議の音（相手）か
  function bySource(localVoiced, remoteVoiced, localRole) {
    const total = localVoiced + remoteVoiced;
    if (total < 4) return { role: null, confidence: null };
    const remoteShare = remoteVoiced / total;
    return {
      role: remoteShare >= 0.5 ? OTHER[localRole] : localRole,
      confidence: Math.max(remoteShare, 1 - remoteShare),
    };
  }

  const api = { create, bySource, merge, KEIGO, NEW_SPEAKER_DIST, LOW_SEPARATION };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Diarize = api;
})(typeof window !== "undefined" ? window : globalThis);
