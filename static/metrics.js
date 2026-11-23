"use strict";

// ---------- 音声の計測：認識の速さと区切りを数値で残す ----------
// 画面にもマイクにも触らない純粋なロジック。時刻はすべて引数で受け取るので、
// tools/test_metrics.js から時系列をそのまま再生して確認できる。
// 残すのは時間・件数・一致率だけ。発言の本文は持ち出さない。
(function (root) {
  const CFG = {
    runGapMs: 600,        // 声の途切れがこれ未満なら、ひとつながりの発話とみなす
    cutMs: 200,           // 確定の時点で声がまだ出ていたら「発話の途中で確定した」とみなす
    test: {
      endSilenceMs: 1500, // 確定が届いたあと、これだけ静かなら1文の終わり
      giveUpMs: 6000,     // 確定が届かなくても、これだけ静かなら打ち切る
      noSpeechMs: 20000,  // 声が出ないまま、これだけたてば飛ばす
      betweenMs: 700,
      pauseMinMs: 600,    // 「間をあけてください」の文で、実際にこれ以上あけたら間とみなす
    },
  };

  // 読み上げテストの文。種類ごとに、区切りや速さの癖が出やすいものを選んだ
  const PROMPTS = [
    { id: "p01", kind: "short", text: "今日はよろしくお願いします。", hint: "ふつうの速さで" },
    { id: "p02", kind: "question", text: "どうして相談してくれなかったの？", hint: "語尾を上げて" },
    { id: "p03", kind: "trailing", text: "悪くはないんだけど、もう少し考えてほしかったな。", hint: "「だけど、」のあとで1秒ほど間をあけて", pause: true },
    { id: "p04", kind: "long", text: "この前の資料なんだけど、数字の根拠が少し弱かったから、次はもう少し丁寧に確認してもらえると助かるかな。", hint: "息つぎは自然に" },
    { id: "p05", kind: "filler", text: "えっと、あの、その件なんですが、ちょっと確認させてください。", hint: "「その件なんですが、」のあとで1秒ほど間をあけて", pause: true },
    { id: "p06", kind: "backchannel", text: "はい。", hint: "短く返事をする" },
    { id: "p07", kind: "fast", text: "なるほど、じゃあ次はどの時点で声をかけるか一緒に決めようか。", hint: "少し早口で" },
    { id: "p08", kind: "number", text: "水曜までに一度見てもらえますか。", hint: "ふつうの速さで" },
    { id: "p09", kind: "quiet", text: "えっと、すみません、少し迷っていました。", hint: "小さな声で" },
    { id: "p10", kind: "question", text: "それは、あなたの判断だったのかな？", hint: "ゆっくり" },
  ];

  const normalize = (s) => (s || "").replace(/[\s、。，．,.…・!！?？「」]/g, "");

  function editDistance(a, b) {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), prev[j] + 1, cur[j - 1] + 1);
      }
      prev = cur;
    }
    return prev[b.length];
  }

  // 読み上げた文と認識結果の一致率（0〜1）。漢字・かなの表記ゆれも差として数える
  function matchRate(expected, actual) {
    const a = normalize(expected), b = normalize(actual);
    if (!a) return null;
    return Math.max(0, 1 - editDistance(a, b) / a.length);
  }

  // 件数が少ないうちは傾向の確認にとどまる。p90 は最近傍順位法
  function stats(values) {
    const v = (values || []).filter((x) => typeof x === "number" && isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const mid = v.length >> 1;
    return {
      n: v.length,
      median: Math.round(v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2),
      p90: Math.round(v[Math.min(v.length - 1, Math.ceil(v.length * 0.9) - 1)]),
      max: Math.round(v[v.length - 1]),
    };
  }

  // ---------- 面談中の計測 ----------
  // 声の区間（VAD）、途中文、確定文、判定、話し出しの時刻から、発話ごとの時間を出す
  function createMeter(options = {}) {
    const C = Object.assign({}, CFG, options);
    let runStart = null, lastVoiced = null, firstInterimAt = null;
    let seq = 0;
    const records = [];
    const byUtt = new Map();

    const find = (id) => records.find((r) => r.id === id);

    return {
      frame(t, speech) {
        if (!speech) return;
        if (runStart == null || lastVoiced == null || t - lastVoiced > C.runGapMs) {
          runStart = t;
          firstInterimAt = null;
        }
        lastVoiced = t;
      },
      interim(t) {
        if (runStart != null && firstInterimAt == null) firstInterimAt = t;
      },
      // 確定文が届いたとき。以後の接続に使う計測IDを返す
      final(t, chars) {
        const rec = {
          id: ++seq,
          chars: chars || 0,
          firstInterimMs: runStart != null && firstInterimAt != null ? Math.max(0, Math.round(firstInterimAt - runStart)) : null,
          finalMs: lastVoiced != null ? Math.round(t - lastVoiced) : null,
          cutWhileSpeaking: lastVoiced != null && t - lastVoiced < C.cutMs,
          judgeMs: null, raiseMs: null, speakMs: null,
          _finalAt: t, _endAt: lastVoiced,
        };
        records.push(rec);
        runStart = null;
        firstInterimAt = null;
        return rec.id;
      },
      bind(uttId, mid) { if (mid) byUtt.set(uttId, mid); },
      // view view自身の声を認識したものなど、発言として扱わなかった確定は計測から外す
      discard(mid) {
        const i = records.findIndex((r) => r.id === mid);
        if (i >= 0) records.splice(i, 1);
      },
      judged(mid, ms) { const r = find(mid); if (r && r.judgeMs == null) r.judgeMs = Math.round(ms); },
      raised(uttId, t) {
        const r = find(byUtt.get(uttId));
        if (r && r.raiseMs == null) r.raiseMs = Math.round(t - r._finalAt);
      },
      // 声で話し出した時刻。発話終了（最後に声が出た時刻）と確定の両方から測る
      spoke(uttId, t) {
        const r = find(byUtt.get(uttId));
        if (!r || r.speakMs != null) return;
        r.speakMs = r._endAt != null ? Math.round(t - r._endAt) : null;
        r.speakAfterFinalMs = Math.round(t - r._finalAt);
      },
      reset() { runStart = lastVoiced = firstInterimAt = null; records.length = 0; byUtt.clear(); },
      records: () => records,
      // 保存用。本文は含まず、数値と真偽値だけ
      export() {
        return records.map(({ _finalAt, _endAt, id, ...rest }) => rest);
      },
    };
  }

  function summarizeMeeting(records) {
    const pick = (key) => stats(records.map((r) => r[key]));
    return {
      utterances: records.length,
      firstInterim: pick("firstInterimMs"),
      final: pick("finalMs"),
      judge: pick("judgeMs"),
      raise: pick("raiseMs"),
      speak: pick("speakMs"),
      speakAfterFinal: pick("speakAfterFinalMs"),
      cut: records.filter((r) => r.cutWhileSpeaking).length,
    };
  }

  // ---------- 読み上げ計測テスト ----------
  // 1文ずつ表示し、声が出て静かになるまでを1文として測る
  function createTest(prompts = PROMPTS, options = {}) {
    const C = Object.assign({}, CFG.test, options);
    let idx = 0, cur = null, nextAt = null, shownAt = null;
    const results = [];

    function begin(t) {
      cur = { startAt: null, lastVoiced: null, firstInterimAt: null, finals: [], longestPause: 0, cut: false };
      shownAt = t;
      nextAt = null;
    }

    function finish(t, noSpeech) {
      const p = prompts[idx];
      let r;
      if (noSpeech) {
        r = { id: p.id, kind: p.kind, noSpeech: true };
      } else {
        const last = cur.finals[cur.finals.length - 1];
        r = {
          id: p.id,
          kind: p.kind,
          expectedChars: normalize(p.text).length,
          speechMs: Math.round(cur.lastVoiced - cur.startAt),
          firstInterimMs: cur.firstInterimAt != null ? Math.max(0, Math.round(cur.firstInterimAt - cur.startAt)) : null,
          finalMs: last ? Math.round(last.t - cur.lastVoiced) : null,
          finals: cur.finals.length,
          cutWhileSpeaking: cur.cut,
          longestPauseMs: Math.round(cur.longestPause),
          pauseExpected: !!p.pause,
          pauseDone: !p.pause || cur.longestPause >= C.pauseMinMs,
          matchPct: cur.finals.length ? Math.round(matchRate(p.text, cur.finals.map((f) => f.text).join("")) * 100) : null,
          noFinal: cur.finals.length === 0,
        };
      }
      results.push(r);
      cur = null;
      idx++;
      nextAt = t + C.betweenMs;
    }

    begin(0);

    const handlers = {
      frame(ev) {
        if (!cur || !ev.speech) return;
        if (cur.startAt == null) cur.startAt = ev.t;
        else cur.longestPause = Math.max(cur.longestPause, ev.t - cur.lastVoiced > 250 ? ev.t - cur.lastVoiced : 0);
        cur.lastVoiced = ev.t;
        const lastFinal = cur.finals[cur.finals.length - 1];
        if (lastFinal && ev.t > lastFinal.t + 50) cur.cut = true; // 確定の後に声が続いた
      },
      interim(ev) {
        if (cur && cur.firstInterimAt == null) cur.firstInterimAt = ev.t;
      },
      final(ev) {
        if (cur) cur.finals.push({ t: ev.t, text: ev.text || "" });
      },
    };

    return {
      prompts,
      // 現在の状態。UIはこれを見て描く
      get view() {
        if (idx >= prompts.length) return { phase: "done", index: prompts.length, total: prompts.length };
        const phase = nextAt != null ? "between" : cur.startAt == null ? "wait" : "heard";
        return { phase, index: idx, total: prompts.length, prompt: prompts[idx] };
      },
      step(ev) {
        const t = ev.t;
        const h = handlers[ev.type];
        if (h && cur) h(ev);
        if (nextAt != null && t >= nextAt && idx < prompts.length) begin(t);
        if (cur && idx < prompts.length) {
          if (cur.startAt == null) {
            if (t - shownAt >= C.noSpeechMs) finish(t, true);
          } else {
            const silence = t - cur.lastVoiced;
            if ((cur.finals.length && silence >= C.endSilenceMs) || silence >= C.giveUpMs) finish(t, false);
          }
        }
        return this.view;
      },
      // 開始の時刻を合わせる（最初の文の「声が出ないまま」の計測の起点）
      start(t) { if (cur) shownAt = t; },
      // 今の1文を飛ばす
      skip(t) { if (cur && idx < prompts.length) finish(t, true); },
      results: () => results,
    };
  }

  function summarizeTest(results) {
    const heard = results.filter((r) => !r.noSpeech);
    const pause = heard.filter((r) => r.pauseExpected && r.pauseDone);
    return {
      total: results.length,
      heard: heard.length,
      noSpeech: results.length - heard.length,
      noFinal: heard.filter((r) => r.noFinal).length,
      firstInterim: stats(heard.map((r) => r.firstInterimMs)),
      final: stats(heard.map((r) => r.finalMs)),
      split: heard.filter((r) => r.finals > 1).length,
      cut: heard.filter((r) => r.cutWhileSpeaking).length,
      pauseTried: pause.length,
      pauseSplit: pause.filter((r) => r.finals > 1 || r.cutWhileSpeaking).length,
      matchAvg: heard.filter((r) => r.matchPct != null).length
        ? Math.round(heard.filter((r) => r.matchPct != null).reduce((s, r) => s + r.matchPct, 0) / heard.filter((r) => r.matchPct != null).length)
        : null,
    };
  }

  const api = { CFG, PROMPTS, stats, matchRate, createMeter, summarizeMeeting, createTest, summarizeTest };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Metrics = api;
})(typeof window !== "undefined" ? window : globalThis);
