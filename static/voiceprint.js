// 声の特徴で「上司か部下か」を見分ける簡易話者判定。
// 声の高さ（基本周波数）と声色（長時間平均スペクトル）だけを使う。音声そのものは保持しない。
// ブラウザ（window.VoicePrint）と Node（テスト用）の両方で動く。
(function (root) {
  "use strict";

  const N = 2048;              // 1フレームのサンプル数
  const BANDS = 24;            // 声色を表す帯域の数
  const F_LO = 90, F_HI = 7000;
  const PITCH_MIN = 70, PITCH_MAX = 420;
  const YIN_THRESHOLD = 0.2;

  // 判定の重み（say の複数音声で調整済み。tools/test_voiceprint.js 参照）
  // 同じ人でも文ごとに 声の高さ ±2.5半音・声色 0.1〜0.4 程度はぶれる
  const PITCH_SCALE = 2.5;     // 半音。これだけ離れると距離1
  const LTAS_SCALE = 0.2;      // log10パワーのRMS差。これだけ離れると距離1
  const TEMPERATURE = 2;
  const LOW_CONFIDENCE = 0.65; // これ未満は「たぶん」扱い（画面に ? を出す）

  const hann = new Float32Array(N);
  for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const ang = (-2 * Math.PI) / len;
      const wlr = Math.cos(ang), wli = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let wr = 1, wi = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const vr = re[b] * wr - im[b] * wi;
          const vi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - vr; im[b] = im[a] - vi;
          re[a] += vr; im[a] += vi;
          const nwr = wr * wlr - wi * wli;
          wi = wr * wli + wi * wlr;
          wr = nwr;
        }
      }
    }
  }

  const edgeCache = {};
  function bandEdges(sampleRate) {
    if (edgeCache[sampleRate]) return edgeCache[sampleRate];
    const mel = (f) => 2595 * Math.log10(1 + f / 700);
    const inv = (m) => 700 * (Math.pow(10, m / 2595) - 1);
    const lo = mel(F_LO), hi = mel(Math.min(F_HI, sampleRate / 2 - 100));
    const edges = [];
    for (let b = 0; b <= BANDS; b++) {
      const f = inv(lo + ((hi - lo) * b) / BANDS);
      edges.push(Math.round((f * N) / sampleRate));
    }
    for (let b = 1; b <= BANDS; b++) if (edges[b] <= edges[b - 1]) edges[b] = edges[b - 1] + 1;
    return (edgeCache[sampleRate] = edges);
  }

  // YIN法で基本周波数を推定（16kHz前後に間引いてから計算）
  function detectPitch(x, sampleRate) {
    const d = Math.max(1, Math.round(sampleRate / 16000));
    const sr = sampleRate / d;
    const len = Math.floor(x.length / d);
    const y = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let k = 0; k < d; k++) s += x[i * d + k];
      y[i] = s / d;
    }
    const minLag = Math.floor(sr / PITCH_MAX);
    const maxLag = Math.ceil(sr / PITCH_MIN);
    const W = len - maxLag;
    if (W < maxLag) return { f0: 0, clarity: 0 };
    const diff = new Float32Array(maxLag + 1);
    for (let tau = 1; tau <= maxLag; tau++) {
      let s = 0;
      for (let i = 0; i < W; i++) {
        const v = y[i] - y[i + tau];
        s += v * v;
      }
      diff[tau] = s;
    }
    const cmnd = new Float32Array(maxLag + 1);
    cmnd[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= maxLag; tau++) {
      running += diff[tau];
      cmnd[tau] = running > 0 ? (diff[tau] * tau) / running : 1;
    }
    let tau = -1;
    for (let t = minLag; t <= maxLag; t++) {
      if (cmnd[t] < YIN_THRESHOLD) {
        while (t + 1 <= maxLag && cmnd[t + 1] < cmnd[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) return { f0: 0, clarity: 0 };
    let better = tau;
    if (tau > 1 && tau < maxLag) {
      const a = cmnd[tau - 1], b = cmnd[tau], c = cmnd[tau + 1];
      const den = a + c - 2 * b;
      if (den !== 0) better = tau + (a - c) / (2 * den);
    }
    return { f0: sr / better, clarity: 1 - cmnd[tau] };
  }

  // 1フレーム分の特徴（音量・声の高さ・声色）
  function frameFeatures(samples, sampleRate) {
    const x = samples.length === N ? samples : samples.subarray(0, N);
    let sum = 0;
    for (let i = 0; i < N; i++) sum += x[i] * x[i];
    const rms = Math.sqrt(sum / N);

    const re = new Float32Array(N), im = new Float32Array(N);
    for (let i = 0; i < N; i++) re[i] = x[i] * hann[i];
    fft(re, im);
    const edges = bandEdges(sampleRate);
    const bands = new Float32Array(BANDS);
    let mean = 0;
    for (let b = 0; b < BANDS; b++) {
      let e = 0;
      for (let k = edges[b]; k < edges[b + 1]; k++) e += re[k] * re[k] + im[k] * im[k];
      bands[b] = Math.log10(e / (edges[b + 1] - edges[b]) + 1e-12);
      mean += bands[b];
    }
    mean /= BANDS;
    for (let b = 0; b < BANDS; b++) bands[b] -= mean;

    const p = detectPitch(x, sampleRate);
    return { rms, f0: p.f0, clarity: p.clarity, bands };
  }

  // 周囲の雑音レベルに追従して、話している区間かどうかを判断する
  function createVad() {
    let floor = 0.004;
    return function isSpeech(rms) {
      if (rms < floor) floor = floor * 0.7 + rms * 0.3;
      else floor = Math.min(floor * 1.003, 0.05);
      return rms > Math.max(floor * 3, 0.006);
    };
  }

  const toSemitone = (f0) => 12 * Math.log2(f0 / 55);
  const median = (arr) => {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  // 話している区間のフレーム群 → 声の特徴（24個の数値＋声の高さ）
  function makePrint(frames) {
    if (!frames || !frames.length) return null;
    const voiced = frames.filter((f) => f.f0 > 0 && f.clarity > 0.55);
    const pitched = voiced.map((f) => toSemitone(f.f0));
    // 声色は母音（声帯が震えている区間）だけで平均すると、話す内容に左右されにくい
    const src = voiced.length >= 8 ? voiced : frames;
    const ltas = new Array(BANDS).fill(0);
    src.forEach((f) => { for (let b = 0; b < BANDS; b++) ltas[b] += f.bands[b]; });
    for (let b = 0; b < BANDS; b++) ltas[b] = ltas[b] / src.length;
    const sorted = pitched.slice().sort((a, b) => a - b);
    const q = (p) => (sorted.length ? sorted[Math.floor((sorted.length - 1) * p)] : 0);
    return {
      st: median(pitched),
      spread: q(0.75) - q(0.25),
      ltas,
      n: frames.length,
      nVoiced: pitched.length,
    };
  }

  function distance(u, ref) {
    let d = 0;
    if (u.nVoiced >= 3 && ref.nVoiced >= 3) {
      const dp = (u.st - ref.st) / PITCH_SCALE;
      d += dp * dp;
    }
    let s = 0;
    for (let b = 0; b < BANDS; b++) {
      const v = u.ltas[b] - ref.ltas[b];
      s += v * v;
    }
    const dl = Math.sqrt(s / BANDS) / LTAS_SCALE;
    d += dl * dl;
    return d;
  }

  // refs: { boss: print, subordinate: print }。登録された人の中で一番近い人を返す
  function classify(u, refs) {
    const keys = Object.keys(refs).filter((k) => refs[k]);
    if (!u || !keys.length) return null;
    const ds = keys.map((k) => distance(u, refs[k]));
    const min = Math.min(...ds);
    const ws = ds.map((d) => Math.exp(-(d - min) / TEMPERATURE));
    const total = ws.reduce((a, b) => a + b, 0);
    let best = 0;
    ds.forEach((d, i) => { if (d < ds[best]) best = i; });
    const distances = {};
    keys.forEach((k, i) => (distances[k] = Math.round(ds[i] * 100) / 100));
    return { speaker: keys[best], confidence: ws[best] / total, distances, frames: u.n };
  }

  // 登録した2人の声がどれくらい見分けやすいか
  function separation(refs) {
    if (!refs.boss || !refs.subordinate) return null;
    const score = distance(refs.boss, refs.subordinate);
    const level = score >= 15 ? "high" : score >= 6 ? "medium" : "low";
    return { score: Math.round(score * 10) / 10, level };
  }

  const api = { N, BANDS, LOW_CONFIDENCE, frameFeatures, createVad, makePrint, distance, classify, separation, toSemitone };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VoicePrint = api;
})(typeof window !== "undefined" ? window : globalThis);
