// 声の特徴で「上司か部下か」を見分ける話者判定。音声そのものは保持しない（特徴の数値だけ）。
// 声の高さ（基本周波数）・声色（24帯域の平均スペクトル）に加えて、
//  ・声道の形を表すMFCC（声の高さが同じでも違いが出る）
//  ・無音区間から雑音を推定して差し引く（部屋の雑音で崩れない）
//  ・登録した2人の「違いが大きい方向」を自動で選んで判定する（ペア適応LDA）
// を使う。
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

  // ---- MFCC（声道の形）と雑音除去 ----
  const MEL_FILTERS = 30;      // MFCCのためのメルフィルタの数
  const CEP_HI = 4000;         // MFCCに使う上限の周波数。声の特徴（母音の共鳴）が集まり、雑音に埋もれにくい範囲
  const CEP_N = 16;            // MFCCの係数の数（c1〜c16。c0=音量は使わない）
  // ---- 登録した2人の声から「2人の違いが大きい方向」を作って判定する（ペア適応LDA） ----
  const PITCH_SIGMA = 3;       // 声の高さ（半音）の、同じ人の中のばらつき。興奮して上ずる分も見込む
  const PITCH_WEIGHT = 0.5;    // 声の高さを手がかりにする強さ。声の高さが近い2人では、声道の形（MFCC）が主役になる
  const LDA_SHRINK = 8;        // 同じ人の中のばらつきを、全体の平均へ寄せる強さ（登録が短くても暴れないように）
  const SEP_HIGH = 25, SEP_MEDIUM = 3;   // 2人の離れ具合の目安。3未満は「声が近い」警告（実測：3未満の組は正解率66%、5以上はほぼ満点）
  // 雑音・反響・声の調子など「条件が変わったときの特徴のずれ」の大きさ（次元ごと）。tools/test_similar_voices.js の条件で実測。
  // 登録がきれいな声でも、面談中の声がずれる分を見込んで、同じ人の中のばらつきに足す（足さないと、登録の声が安定しているほど重みが尖って外れる）
  const NUISANCE_VAR = [0.03813, 0.00464, 0.00328, 0.00167, 0.00151, 0.00084, 0.00094, 0.00085, 0.00084, 0.00085, 0.00064, 0.00052, 0.00041, 0.00049, 0.00045, 0.00034];
  // 登録がなくても使える、同じ人の中のばらつき（次元ごと）の事前の値。9つの音声の登録文を0.5秒ごとに区切って実測
  const PRIOR_WITHIN = [0.0285, 0.01423, 0.00898, 0.0024, 0.0017, 0.0023, 0.00139, 0.00086, 0.00127, 0.0013, 0.00106, 0.00098, 0.00216, 0.00412, 0.0047, 0.00235];
  const TUNE = { cepAll: true, cepClarity: 0.55, ltasWeight: 0.5, cepScale: 2, metricShrink: 6, adaptive: true, nuisance: 4, pmcLo: 0.035, pmcSpan: 0.03, pmcFloor: 0.1, ver: 0 };   // 検証用に調整できる値（アプリは触らない）
  const LLR_SCALE = 0.45;      // 判定の強さ→確信度への換算（実測で調整）
  const BANDS_REF = 18;        // 24帯域の平均を引くとき、基準にする帯域の数（約4kHzまで。高音域は雑音で動くので基準にしない）
  const CHUNK = 12;            // 約0.5秒（12フレーム）ごとの平均を作る。声のゆらぎ（同じ人の中のばらつき）の見積もりに使う
  const NOISE_OVERSUB = 1.0;   // 見積もった雑音をそのまま引く
  const NOISE_FLOOR = 0.04;    // 引きすぎて0にならないよう、元の強さのこの割合は残す
  const NOISE_SMOOTH = 0.2;    // スペクトルをならす速さ
  const NOISE_SUB = 12;        // 最小値を取る区間の長さ（フレーム）。約0.5秒
  const NOISE_SUBS = 5;        // 区間をいくつ遡るか（約2.5秒）
  const NOISE_BIAS = 1.7;      // 最小値は平均より小さく出るので、その分を戻す

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

  // 1フレームのパワースペクトル（0〜ナイキスト、N/2本）
  function powerSpectrum(x) {
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let i = 0; i < N; i++) re[i] = x[i] * hann[i];
    fft(re, im);
    const P = new Float32Array(N / 2);
    for (let k = 0; k < N / 2; k++) P[k] = re[k] * re[k] + im[k] * im[k];
    return P;
  }

  // メルフィルタ（三角形）。サンプリング周波数ごとに1回だけ作る
  const melCache = {};
  function melFilters(sampleRate) {
    if (melCache[sampleRate]) return melCache[sampleRate];
    const mel = (f) => 2595 * Math.log10(1 + f / 700);
    const inv = (m) => 700 * (Math.pow(10, m / 2595) - 1);
    const lo = mel(80), hi = mel(Math.min(CEP_HI, sampleRate / 2 - 100));
    const pts = [];
    for (let i = 0; i < MEL_FILTERS + 2; i++) pts.push((inv(lo + ((hi - lo) * i) / (MEL_FILTERS + 1)) * N) / sampleRate);
    const filters = [];
    for (let m = 1; m <= MEL_FILTERS; m++) {
      const a = pts[m - 1], b = pts[m], c = pts[m + 1];
      const start = Math.max(0, Math.floor(a)), end = Math.min(N / 2 - 1, Math.ceil(c));
      const w = [];
      for (let k = start; k <= end; k++) w.push(k <= b ? Math.max(0, (k - a) / (b - a || 1)) : Math.max(0, (c - k) / (c - b || 1)));
      filters.push({ start, w });
    }
    return (melCache[sampleRate] = filters);
  }

  // 離散コサイン変換（c1〜c20）。対数メルのなだらかな形（声道の形）だけを取り出し、声の高さの細かい縞は落とす
  const dct = [];
  for (let c = 1; c <= CEP_N; c++) {
    const row = new Float32Array(MEL_FILTERS);
    for (let m = 0; m < MEL_FILTERS; m++) row[m] = Math.cos((Math.PI * c * (m + 0.5)) / MEL_FILTERS);
    dct.push(row);
  }
  // パワースペクトル → 30個のメルパワー（線形）
  function melPower(P, sampleRate) {
    const filters = melFilters(sampleRate);
    const out = new Float32Array(MEL_FILTERS);
    for (let m = 0; m < MEL_FILTERS; m++) {
      const { start, w } = filters[m];
      let e = 0;
      for (let i = 0; i < w.length; i++) e += P[start + i] * w[i];
      out[m] = e;
    }
    return out;
  }
  // メルパワー（線形）→ ケプストラム c1〜c16。音量（c0）は捨てる
  function cepOfMel(mel) {
    const out = new Float32Array(CEP_N);
    const logE = new Float32Array(MEL_FILTERS);
    for (let m = 0; m < MEL_FILTERS; m++) logE[m] = Math.log10(mel[m] + 1e-12);
    for (let c = 0; c < CEP_N; c++) {
      let s = 0;
      for (let m = 0; m < MEL_FILTERS; m++) s += dct[c][m] * logE[m];
      out[c] = s / MEL_FILTERS;
    }
    return out;
  }
  const mfcc = (P, sampleRate) => cepOfMel(melPower(P, sampleRate));

  // 部屋の雑音の見積もり（最小統計法）。周波数ごとに、直近2〜3秒のスペクトルの最小値を追い続ける。
  // 話しているかどうかの判定に頼らないので、雑音がある部屋でも、話し始めからでも使える。毎フレーム update を呼ぶ
  function createNoiseModel() {
    const H = N / 2;
    let smooth = null, cur = null, count = 0;
    const subs = [];
    const model = {
      pow: new Float32Array(H),   // 雑音のパワーの見積もり（引くときに使う）
      n: 0,                       // これまでに見たフレーム数
      update(samples) {
        const P = powerSpectrum(samples.length === N ? samples : samples.subarray(0, N));
        if (!smooth) { smooth = P.slice(); cur = P.slice(); }
        else {
          for (let k = 0; k < H; k++) {
            smooth[k] += NOISE_SMOOTH * (P[k] - smooth[k]);
            if (smooth[k] < cur[k]) cur[k] = smooth[k];
          }
        }
        count++;
        if (count % NOISE_SUB === 0) {
          subs.push(cur);
          if (subs.length > NOISE_SUBS) subs.shift();
          cur = smooth.slice();
        }
        for (let k = 0; k < H; k++) {
          let m = cur[k];
          for (let s = 0; s < subs.length; s++) if (subs[s][k] < m) m = subs[s][k];
          model.pow[k] = NOISE_BIAS * m;
        }
        model.n++;
      },
    };
    return model;
  }

  // 1フレーム分の特徴（音量・声の高さ・声色・MFCC）。noise があれば雑音を引いてから計算する
  function frameFeatures(samples, sampleRate, noise) {
    const x = samples.length === N ? samples : samples.subarray(0, N);
    let sum = 0;
    for (let i = 0; i < N; i++) sum += x[i] * x[i];
    const rms = Math.sqrt(sum / N);

    const P0 = powerSpectrum(x);
    let P = P0;
    const noisy = noise && noise.n >= 8;
    if (noisy) {
      const Q = new Float32Array(N / 2);
      for (let k = 0; k < N / 2; k++) Q[k] = Math.max(P0[k] - NOISE_OVERSUB * noise.pow[k], NOISE_FLOOR * P0[k]);
      P = Q;
    }
    const edges = bandEdges(sampleRate);
    const bands = new Float32Array(BANDS);
    let mean = 0;
    for (let b = 0; b < BANDS; b++) {
      let e = 0;
      for (let k = edges[b]; k < edges[b + 1]; k++) e += P[k];
      bands[b] = Math.log10(e / (edges[b + 1] - edges[b]) + 1e-12);
      if (b < BANDS_REF) mean += bands[b];
    }
    mean /= BANDS_REF;
    for (let b = 0; b < BANDS; b++) bands[b] -= mean;

    const p = detectPitch(x, sampleRate);
    // cep: 雑音を引いたMFCC。mel / nmel: 引く前のメルパワーと、そのときの雑音のメルパワー（雑音適応の判定に使う）
    return { rms, f0: p.f0, clarity: p.clarity, bands, cep: mfcc(P, sampleRate), mel: melPower(P0, sampleRate), nmel: noisy ? melPower(noise.pow, sampleRate) : new Float32Array(MEL_FILTERS) };
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
    const print = {
      st: median(pitched),
      spread: q(0.75) - q(0.25),
      ltas,
      n: frames.length,
      nVoiced: pitched.length,
    };
    // MFCC：全体の平均と、約0.5秒ごとの平均（同じ人の中のばらつきの見積もりに使う）。音声そのものではなく数値だけ
    const withCep = (TUNE.cepAll ? frames : TUNE.cepClarity !== 0.55 ? frames.filter((f) => f.f0 > 0 && f.clarity > TUNE.cepClarity) : src).filter((f) => f.cep);
    if (withCep.length >= 4) {
      print.cep = meanVec(withCep.map((f) => f.cep));
      print.nCep = withCep.length;
      print.chunks = [];
      print.lchunks = [];
      print.melChunks = [];
      for (let i = 0; i + CHUNK <= withCep.length; i += CHUNK) {
        const part = withCep.slice(i, i + CHUNK);
        print.chunks.push(meanVec(part.map((f) => f.cep)));
        print.lchunks.push(meanVec(part.map((f) => f.bands)));
        if (part[0].mel) print.melChunks.push(meanVec(part.map((f) => f.mel)));
      }
      if (withCep[0].mel) {
        print.mel = meanVec(withCep.map((f) => f.mel));
        print.nmel = meanVec(withCep.map((f) => f.nmel));
      }
    }
    return print;
  }

  function meanVec(vs) {
    const m = new Array(vs[0].length).fill(0);
    vs.forEach((v) => { for (let d = 0; d < m.length; d++) m[d] += v[d]; });
    for (let d = 0; d < m.length; d++) m[d] /= vs.length;
    return m;
  }

  function distanceLegacy(u, ref) {
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

  const priorVar = (k) => PRIOR_WITHIN[k] + TUNE.nuisance * NUISANCE_VAR[k];

  // 分け終わった（または分けかけの）グループから、「同じ人の中でよく揺れる次元」を見つけて距離から割り引く。
  // 発言ごとの特徴が、同じ人でも話す内容で大きく揺れる次元ほど、その次元の差は信用しない。
  // groups: [[print, ...], [print, ...]]。グループ内の発言が少ないうちは事前の値（PRIOR_WITHIN）に寄せる
  function learnMetric(groups) {
    const all = [].concat(...groups);
    if (!all.length || !all.every((p) => p.cep)) return null;
    const D = all[0].cep.length;
    const v = new Array(D).fill(0);
    let cnt = 0, nonEmpty = 0;
    groups.forEach((g) => {
      if (!g.length) return;
      nonEmpty++;
      const m = new Array(D).fill(0);
      let w = 0;
      g.forEach((p) => { const wt = p.nCep || p.n || 1; for (let k = 0; k < D; k++) m[k] += p.cep[k] * wt; w += wt; });
      for (let k = 0; k < D; k++) m[k] /= w;
      g.forEach((p) => { for (let k = 0; k < D; k++) v[k] += (p.cep[k] - m[k]) ** 2; cnt++; });
    });
    const dof = Math.max(0, cnt - nonEmpty);
    return { V: v.map((x, k) => (x + TUNE.metricShrink * priorVar(k)) / (dof + TUNE.metricShrink)) };
  }
  // 学んだ距離の尺度が、事前の尺度からどれだけ絞られたか（絞りすぎたクラスタ分けを選ばないための罰）
  function metricPenalty(metric, n) {
    if (!metric) return 0;
    let s = 0;
    for (let k = 0; k < metric.V.length; k++) s += Math.log(metric.V[k] / priorVar(k));
    return (n * s) / TUNE.cepScale;
  }

  // 2つの声の特徴の距離（小さいほど同じ人）。MFCCがあれば、声道の形の違いも見る。
  // 声の登録がなくても使えるよう、同じ人の中のばらつきは事前の値（PRIOR_WITHIN）で割る
  function distance(u, ref, metric) {
    if (TUNE.legacy || !(u.cep && ref.cep)) return distanceLegacy(u, ref);
    let d = 0;
    if (u.nVoiced >= 3 && ref.nVoiced >= 3) {
      const dp = (u.st - ref.st) / PITCH_SCALE;
      d += dp * dp;
    }
    let c = 0;
    const V = metric && metric.V;
    for (let k = 0; k < u.cep.length; k++) c += (u.cep[k] - ref.cep[k]) ** 2 / (V ? V[k] : priorVar(k));
    d += c / TUNE.cepScale;
    if (TUNE.ltasWeight) {
      let s = 0;
      for (let b = 0; b < BANDS_REF; b++) { const v = u.ltas[b] - ref.ltas[b]; s += v * v; }
      const dl = Math.sqrt(s / BANDS_REF) / LTAS_SCALE;
      d += TUNE.ltasWeight * dl * dl;
    }
    return d;
  }

  // ---- 登録した2人の声から判定の方向を作る ----
  // a, b: makePrint の結果（chunks つき）。同じ人の中のばらつきを0.5秒ごとの平均から見積もり、
  // 次元ごとに「2人の差 ÷ ばらつき」を重みにする。2人の違いが大きい次元ほど強く効く
  const pairCache = new WeakMap();
  function pairModel(a, b) {
    let inner = pairCache.get(a);
    if (inner && inner.has(b) && inner.get(b).ver === TUNE.ver) return inner.get(b);
    const D = a.cep.length;
    const v = new Array(D).fill(0);
    let cnt = 0;
    [[a, a.cep], [b, b.cep]].forEach(([pr, mu]) => {
      (pr.chunks || []).forEach((c) => { for (let d = 0; d < D; d++) { const x = c[d] - mu[d]; v[d] += x * x; } cnt++; });
    });
    const var0 = v.map((x) => x / Math.max(1, cnt));
    const k = Math.max(1, cnt);
    // 登録は短く、0.5秒ごとの平均は数個しか取れない。足りない分は、次元ごとの事前の値（PRIOR_WITHIN）で埋める
    const vv = var0.map((x, d) => (x * k + LDA_SHRINK * (PRIOR_WITHIN[d] || 1e-3)) / (k + LDA_SHRINK) + TUNE.nuisance * (NUISANCE_VAR[d] || 0));
    const w = a.cep.map((m, d) => (m - b.cep[d]) / vv[d]);
    const mid = a.cep.map((m, d) => (m + b.cep[d]) / 2);
    const d2 = a.cep.reduce((s, m, d) => s + w[d] * (m - b.cep[d]), 0);  // 2人の離れ具合（ばらつきで割った距離の2乗）
    const model = { w, mid, d2, V: vv, ver: TUNE.ver };
    if (!inner) pairCache.set(a, (inner = new WeakMap()));
    inner.set(b, model);
    return model;
  }

  const hasCep = (p) => p && p.cep && p.chunks;
  // 正の値＝a の声に近い。声道の形（MFCC）の差と、声の高さの差を足す
  function llr(u, a, b) {
    const m = pairModel(a, b);
    let s = 0;
    for (let d = 0; d < m.w.length; d++) s += m.w[d] * (u.cep[d] - m.mid[d]);
    if (u.nVoiced >= 3 && a.nVoiced >= 3 && b.nVoiced >= 3) {
      s += (PITCH_WEIGHT * ((u.st - b.st) ** 2 - (u.st - a.st) ** 2)) / (2 * PITCH_SIGMA * PITCH_SIGMA);
    }
    return s;
  }

  // ---- 雑音適応（PMC）：登録した声に「いま測った雑音」を足してから、聞こえた声と比べる ----
  // 雑音に埋もれた帯域は、比べる2人とも同じ値になるので、間違った手がかりにならない
  const NOISE_RATIO_BANDS = 24;
  const hasMel = (p) => p && p.mel && p.nmel;
  function noiseRatio(u) {
    let r = 0;
    for (let m = 0; m < NOISE_RATIO_BANDS; m++) r += u.nmel[m] / (u.mel[m] + 1e-12);
    return r / NOISE_RATIO_BANDS;
  }
  function adapted(p, nu) {
    const m = new Float32Array(p.mel.length);
    for (let i = 0; i < m.length; i++) m[i] = Math.max(p.mel[i] - p.nmel[i], 0.02 * p.mel[i]) + nu[i];
    return cepOfMel(m);
  }
  function pmcLlr(u, a, b) {
    const V = pairModel(a, b).V, Ca = adapted(a, u.nmel), Cb = adapted(b, u.nmel), x = cepOfMel(u.mel);
    let da = 0, db = 0;
    for (let d = 0; d < V.length; d++) { da += (x[d] - Ca[d]) ** 2 / V[d]; db += (x[d] - Cb[d]) ** 2 / V[d]; }
    let s = 0.5 * (db - da);
    if (u.nVoiced >= 3 && a.nVoiced >= 3 && b.nVoiced >= 3) {
      s += (PITCH_WEIGHT * ((u.st - b.st) ** 2 - (u.st - a.st) ** 2)) / (2 * PITCH_SIGMA * PITCH_SIGMA);
    }
    return s;
  }
  // 正の値＝a の声に近い。雑音が少ないときは声道の形（LDA）、雑音が多いほど雑音適応を重く見る
  function blendedLlr(u, a, b) {
    const base = llr(u, a, b);
    if (!(hasMel(a) && hasMel(b) && hasMel(u))) return base;
    const g = Math.max(0, Math.min(1, (noiseRatio(u) - TUNE.pmcLo) / TUNE.pmcSpan));
    const w = TUNE.pmcFloor + (1 - TUNE.pmcFloor) * g;
    return (1 - w) * base + w * pmcLlr(u, a, b);
  }

  function classifyLegacy(u, refs, metric) {
    const keys = Object.keys(refs).filter((k) => refs[k]);
    if (!u || !keys.length) return null;
    const ds = keys.map((k) => distance(u, refs[k], metric));
    const min = Math.min(...ds);
    const ws = ds.map((d) => Math.exp(-(d - min) / TEMPERATURE));
    const total = ws.reduce((a, b) => a + b, 0);
    let best = 0;
    ds.forEach((d, i) => { if (d < ds[best]) best = i; });
    const distances = {};
    keys.forEach((k, i) => (distances[k] = Math.round(ds[i] * 100) / 100));
    return { speaker: keys[best], confidence: ws[best] / total, distances, frames: u.n };
  }

  // refs: { boss: print, subordinate: print }。登録された人の中で一番近い人を返す
  // 両方に MFCC があれば、2人の違いが大きい方向で判定する（声の高さが近くても分けられる）。なければ従来の距離
  function classify(u, refs, metric) {
    const keys = Object.keys(refs).filter((k) => refs[k]);
    if (!u || !keys.length) return null;
    if (keys.length === 2 && hasCep(refs[keys[0]]) && hasCep(refs[keys[1]]) && u.cep) {
      const [ka, kb] = keys;
      const s = blendedLlr(u, refs[ka], refs[kb]);
      const pa = 1 / (1 + Math.exp(-LLR_SCALE * s));
      const best = s >= 0 ? ka : kb;
      const half = Math.round(Math.abs(s) * 50) / 100;
      return { speaker: best, confidence: s >= 0 ? pa : 1 - pa, distances: { [ka]: s >= 0 ? 0 : half, [kb]: s >= 0 ? half : 0 }, frames: u.n, llr: s };
    }
    return classifyLegacy(u, refs, metric);
  }

  // 登録した2人の声がどれくらい見分けやすいか
  function separation(refs) {
    if (!refs.boss || !refs.subordinate) return null;
    if (hasCep(refs.boss) && hasCep(refs.subordinate)) {
      const m = pairModel(refs.boss, refs.subordinate);
      const dp = refs.boss.nVoiced >= 3 && refs.subordinate.nVoiced >= 3 ? ((refs.boss.st - refs.subordinate.st) / PITCH_SIGMA) ** 2 * PITCH_WEIGHT : 0;
      const score = m.d2 + dp;
      const level = score >= SEP_HIGH ? "high" : score >= SEP_MEDIUM ? "medium" : "low";
      return { score: Math.round(score * 10) / 10, level };
    }
    const score = distance(refs.boss, refs.subordinate);
    const level = score >= 15 ? "high" : score >= 6 ? "medium" : "low";
    return { score: Math.round(score * 10) / 10, level };
  }

  const api = { N, BANDS, CEP_N, LOW_CONFIDENCE, frameFeatures, createVad, createNoiseModel, cepOfMel, makePrint, distance, classify, classifyLegacy, distanceLegacy, learnMetric, metricPenalty, separation, toSemitone, TUNE };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VoicePrint = api;
})(typeof window !== "undefined" ? window : globalThis);
