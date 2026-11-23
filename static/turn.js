"use strict";

// ---------- フロア管理：view viewが「今、割って入ってよいか」を決める ----------
// 画面にも音声にも触らない純粋なロジック。時刻はすべて引数で受け取るので、
// tools/test_turn.js から会話シナリオをそのまま再生して確認できる。
// 数値はすべて仮置き（実面談では未検証）。迷ったら話さず、画面ヒントに回す。
(function (root) {
  const TIMING = {
    needMs: { question: 500, complete: 700, unknown: 1000, trailing: 1500 }, // 句末ごとに必要な無音
    prioScale: { high: 1, medium: 1.3 },
    textOnlyScale: 1.5,      // Zoomなど、無音を直接測れないときは長めに待つ
    raiseLeadMs: 800,        // 手を挙げてから話し出すまでの最短時間（人が譲る／無視する余地）
    ttlMs: { high: 6000, medium: 4000 },
    movedOnMs: 350,          // 発言の確定後にこれだけ声が出たら、会話は先へ進んだとみなす
    speculateSilenceMs: 250,
    speculateMinChars: 6,
    playStartTimeoutMs: 1500, // 合成・再生がこれより遅れたら、声を諦める
    remoteStartScale: 3,      // view view用PC（Wi-Fi越し）で話すときは、話し出しの待ちを長くする
    maxPlayMs: 20000,
    echoLearnMs: 400,
    echoMargin: 2.5,
    minHumanRms: 0.012,
    maxEchoRatio: 0.2,
    duckAtMs: 200,           // 人の声が続いたら、まず音量を下げる
    stopAtMs: 500,           // さらに続いたら止める（短い相づちでは止まらない）
    falseBargeWindowMs: 2000,
    echoTailMs: 3000,
    echoTailRatio: 0.9,       // 話し終えた後は、ほぼ全文が一致するときだけ自分の声とみなす
    echoTailVoiceMs: 150,     // 話し終えた後に人の声があれば、捨てない
    minBargeChars: 6,         // これより短い認識文（はい、うん等）では止まらない
  };

  // 声で話す回数の上限。いずれも仮説で、「助かった／不要」の記録で見直す
  const PACES = {
    gentle: { label: "控えめ", maxVoices: 3, windowMs: 30 * 60000, minGapMs: 5 * 60000, warmupMs: 3 * 60000, oncePerCategory: true },
    normal: { label: "ふつう", maxVoices: 5, windowMs: 30 * 60000, minGapMs: 90000, warmupMs: 30000, oncePerCategory: false },
    check: { label: "確認用", maxVoices: 0, windowMs: 0, minGapMs: 8000, warmupMs: 0, oncePerCategory: false },
  };

  const normalize = (s) => (s || "").replace(/[\s、。，．,.…・!！?？「」]/g, "");

  // 句末から「言い切ったか」を推定する。「けど」等は禁止せず、待ち時間を延ばすだけ
  function classifyTail(text) {
    const x = (text || "").trim().replace(/[。…\s]+$/, "");
    if (!x) return "unknown";
    if (/[?？]$/.test(x)) return "question";
    if (/((けど|けれど|けども|から|ので|のに)[さねな]?|たら|なら|ながら|とか|なんか|あの|その|えーと|えっと|まあ|、)$/.test(x)) return "trailing";
    if (/(さん|くん|ちゃん|さま|様|みんな|皆|あなた|君|きみ|僕|ぼく|私|わたし|俺|自分|部長|課長|先輩|後輩|上司|部下)の$/.test(x)) return "trailing";
    if (/(ですか|ますか|ませんか|でしょうか|かな|のか|でしょ|だろ|だろう|よね|じゃない|[なたるいん]の|か)$/.test(x)) return "question";
    if (/[がでてとしばの]$/.test(x)) return "trailing";
    if (/(です|ます|ました|ません|でした|ください|だ|よ|ね|な|ぞ|わ|た|ない|る|ろ|じゃん|う)$/.test(x)) return "complete";
    return "unknown";
  }

  // text を spoken のどこか一続きの部分に合わせたときの最小の編集距離
  function alignDistance(a, b) {
    let row = new Array(b.length + 1).fill(0); // spoken のどこから始まってもよい
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) {
        next[j] = Math.min(row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), row[j] + 1, next[j - 1] + 1);
      }
      row = next;
    }
    return Math.min(...row);
  }

  // 認識結果が、view view自身の声を拾ったものかどうか。
  // 順序まで見て比べ、セリフと違う部分が一定以上あれば人の発言として扱う
  function isEchoText(text, spoken, similarity = 0.85) {
    const a = normalize(text), b = normalize(spoken);
    if (!a) return true;
    return 1 - alignDistance(a, b) / a.length >= similarity;
  }

  function splitSentences(text) {
    return (text || "").match(/[^。！？!?\n]+[。！？!?]*/g)?.map((s) => s.trim()).filter(Boolean) || [];
  }

  function createTurn(options = {}) {
    const T = Object.assign({}, TIMING, options.timing || {});
    let pace = PACES[options.pace] || PACES.normal;
    let textOnly = !!options.textOnly;
    let voiceOff = false;
    let remoteVoice = false;     // view view用PCで話す（出力音量が測れず、話し出しが遅れる）
    let startedAt = options.t0 || 0;

    let state = "LISTEN";
    let cand = null;             // 手を挙げて待っている介入
    let sp = null;               // 話している最中の情報
    let latestUtt = 0, latestFinalAt = -Infinity;
    let lastSpeechAt = -Infinity, lastFrameAt = null;
    let speechRun = 0, speechAfterFinal = 0;
    let who = null, interim = "", interimRaw = "", speculated = "";
    let speakSeq = 0;
    let voices = [];             // { t, category }
    let lastSpoken = null;       // { text, until }
    let voiceSinceSpoke = 0;     // view viewが話し終えてから聞こえた人の声
    let lastActivityAt = null;   // Zoomで最後に誰かの発話が届いた時刻（サーバー時計）
    let pendingBarge = null;     // 音量だけで止まった直後の確認用
    let bargeGain = 1;
    let out = [];

    const emit = (t, type, extra = {}) => out.push(Object.assign({ t, type }, extra));

    function blockedReason(t, prio, category) {
      if (voiceOff) return "voice_off";
      if (t - startedAt < pace.warmupMs) return "warmup";
      const last = voices[voices.length - 1];
      if (last && t - last.t < pace.minGapMs) return "gap";
      if (pace.maxVoices && voices.filter((v) => t - v.t < pace.windowMs).length >= pace.maxVoices) return "budget";
      if (pace.oncePerCategory && category && voices.some((v) => v.category === category)) return "category";
      return null;
    }

    function drop(t, why) {
      const c = cand;
      cand = null;
      state = "LISTEN";
      emit(t, "lower", { why });
      if (c.uttId) emit(t, "hint", { uttId: c.uttId, why });
    }

    function checkRaised(t) {
      if (state !== "RAISED") return;
      const anchor = cand.finalAt != null ? cand.finalAt : cand.raisedAt;
      if (t - anchor > T.ttlMs[cand.prio]) return drop(t, "expired");
      if (speechAfterFinal >= T.movedOnMs) return drop(t, "moved_on");
      if (!cand.uttId || !cand.confirmed || speechRun > 0) return;
      if (t - cand.raisedAt < T.raiseLeadMs) return;
      const need = T.needMs[cand.tail] * T.prioScale[cand.prio] * (textOnly ? T.textOnlyScale : 1);
      if (t - lastSpeechAt < need) return;
      const blocked = blockedReason(t, cand.prio, cand.category);
      if (blocked) return drop(t, blocked);
      const c = cand;
      cand = null;
      state = "SPEAKING";
      sp = { id: ++speakSeq, text: c.text, uttId: c.uttId, askedAt: t, playAt: null, samples: [], k: null, level: 0, run: 0, ducked: false };
      voices.push({ t, category: c.category, speakId: sp.id });
      emit(t, "lower", { why: "speak" });
      emit(t, "speak", { uttId: c.uttId, speakId: sp.id });
    }

    function refund(id) {
      voices = voices.filter((v) => v.speakId !== id);
    }

    function endSpeaking(t) {
      lastSpoken = { text: sp.text, until: t + T.echoTailMs };
      voiceSinceSpoke = 0;
      lastSpeechAt = Math.max(lastSpeechAt, t);
      speechRun = 0;
      speechAfterFinal = 0;
      sp = null;
      state = "LISTEN";
    }

    function stopSpeaking(t, why, viaLevel) {
      const id = sp.id, uttId = sp.uttId, started = sp.playAt != null;
      if (!started) refund(id);
      if (viaLevel && started) pendingBarge = { speakId: id, t };
      emit(t, "stop", { speakId: id, uttId, why, started });
      endSpeaking(t);
    }

    function confirmBarge() {
      pendingBarge = null;
    }

    function checkPendingBarge(t) {
      if (pendingBarge && t - pendingBarge.t > T.falseBargeWindowMs) {
        // 止まったのに誰の言葉も認識されなかった：自分の声の回り込みだった可能性が高い
        refund(pendingBarge.speakId);
        bargeGain = Math.min(bargeGain * 1.6, 6);
        pendingBarge = null;
        emit(t, "falseBarge", { gain: bargeGain });
      }
    }

    function onSpeakingFrame(ev, dt) {
      const t = ev.t;
      let human;
      if (sp.playAt != null && !sp.useLevel) return; // 出力音量が取れない声は、認識された言葉でだけ止める
      if (sp.playAt == null) {
        human = !!ev.speech;
      } else if (t < sp.playAt + T.echoLearnMs) {
        sp.samples.push(ev.rms / Math.max(ev.ref == null ? 1 : ev.ref, 0.05));
        human = false;
      } else {
        if (sp.k == null) {
          const s = sp.samples.sort((a, b) => a - b);
          sp.k = Math.min(s[Math.floor(s.length * 0.9)] || 0, T.maxEchoRatio);
        }
        sp.level = Math.max(ev.ref == null ? 1 : ev.ref, sp.level * 0.85);
        human = ev.rms > Math.max(T.echoMargin * bargeGain * sp.k * sp.level, T.minHumanRms);
      }
      // 音節の切れ目で途切れないよう、減らすときはゆっくり
      sp.run = human ? sp.run + dt : Math.max(0, sp.run - dt * 2);
      if (sp.playAt == null) {
        if (sp.run >= T.duckAtMs) stopSpeaking(t, "before_play", false);
        return;
      }
      if (sp.run >= T.stopAtMs) return stopSpeaking(t, "barge", true);
      if (sp.run >= T.duckAtMs && !sp.ducked) {
        sp.ducked = true;
        emit(t, "duck", { speakId: sp.id });
      } else if (sp.run === 0 && sp.ducked) {
        sp.ducked = false;
        emit(t, "unduck", { speakId: sp.id });
      }
    }

    function checkSpeaking(t) {
      if (state !== "SPEAKING") return;
      if (sp.playAt == null && t - sp.askedAt > T.playStartTimeoutMs * (remoteVoice ? T.remoteStartScale : 1)) return stopSpeaking(t, "late", false);
      if (sp.playAt != null && t - sp.playAt > T.maxPlayMs) return stopSpeaking(t, "too_long", false);
    }

    function isEcho(t, text, ratio) {
      if (textOnly) return false; // Zoomの発言は参加者名で区別できている
      if (state === "SPEAKING") return isEchoText(text, sp.text, ratio);
      return !!(lastSpoken && t <= lastSpoken.until && voiceSinceSpoke < T.echoTailVoiceMs
        && isEchoText(text, lastSpoken.text, T.echoTailRatio));
    }

    const handlers = {
      mode(ev) {
        if (ev.pace && PACES[ev.pace]) pace = PACES[ev.pace];
        if (ev.textOnly != null) textOnly = ev.textOnly;
        if (ev.voiceOff != null) voiceOff = ev.voiceOff;
        if (ev.remoteVoice != null) remoteVoice = ev.remoteVoice;
      },
      start(ev) { startedAt = ev.t; },
      frame(ev) {
        const t = ev.t;
        const dt = lastFrameAt == null ? 40 : Math.min(120, t - lastFrameAt);
        lastFrameAt = t;
        if (textOnly) return;
        if (state === "SPEAKING") return onSpeakingFrame(ev, dt);
        if (ev.speech) {
          lastSpeechAt = t;
          speechRun += dt;
          speechAfterFinal += dt;
          voiceSinceSpoke += dt;
        } else {
          speechRun = 0;
          if (state === "LISTEN" && t - lastSpeechAt >= T.speculateSilenceMs && interim.length >= T.speculateMinChars
              && interim !== speculated && who !== "subordinate") {
            speculated = interim;
            emit(t, "speculate", { text: interimRaw });
          }
        }
      },
      activity(ev) {
        const t = ev.t;
        if (ev.who) who = ev.who;
        if (ev.at != null) lastActivityAt = ev.at;
        lastSpeechAt = Math.max(lastSpeechAt, t);
        if (state === "SPEAKING") {
          // 文字数が分かるときは、短い相づちでは止まらない
          if (ev.chars == null || ev.chars >= T.minBargeChars) stopSpeaking(t, "barge", false);
          return;
        }
        speechAfterFinal += T.movedOnMs;
      },
      speaker(ev) { who = ev.who; },
      interim(ev) {
        const t = ev.t;
        if (isEcho(t, ev.text, 0.75)) { emit(t, "dropEcho", { interim: true }); return; } // 途中文は誤認識が多いので甘めに判定
        confirmBarge();
        if (state === "SPEAKING") {
          if (normalize(ev.text).length >= T.minBargeChars) stopSpeaking(t, "barge", false);
          return;
        }
        interimRaw = ev.text;
        interim = normalize(ev.text);
      },
      final(ev) {
        const t = ev.t;
        if (isEcho(t, ev.text, 0.85)) { emit(t, "dropEcho", { text: ev.text }); return; }
        confirmBarge();
        // 「はい」などの短い相づちでは止まらない。発言としては記録する
        if (state === "SPEAKING" && normalize(ev.text).length >= T.minBargeChars) stopSpeaking(t, "barge", false);
        latestUtt = ev.uttId;
        latestFinalAt = t;
        if (ev.who) who = ev.who;
        if (textOnly) lastSpeechAt = Math.max(lastSpeechAt, t);
        const key = normalize(ev.text);
        const sameAsSpec = state === "RAISED" && !cand.uttId && cand.key === key && ev.who !== "subordinate";
        interim = ""; interimRaw = ""; speculated = "";
        // この発言より新しい発話がすでに届いていれば、会話は先へ進んでいる
        speechAfterFinal = ev.at != null && lastActivityAt != null && lastActivityAt > ev.at ? T.movedOnMs : 0;
        if (sameAsSpec) {
          cand.uttId = ev.uttId;
          cand.finalAt = t;
          cand.tail = classifyTail(ev.text);
        } else if (state === "RAISED") {
          drop(t, "moved_on");
        }
      },
      verdict(ev) {
        const t = ev.t, p = ev.prio;
        if (ev.spec) {
          if (state === "LISTEN" && (p === "high" || p === "medium") && who === "boss"
              && interim === normalize(ev.text) && !blockedReason(t, p, ev.category)) {
            cand = { uttId: 0, key: interim, text: ev.speech || "", prio: p, category: ev.category, tail: classifyTail(ev.text), raisedAt: t, finalAt: null, confirmed: false };
            state = "RAISED";
            speechAfterFinal = 0;
            emit(t, "raise", { spec: true });
          }
          return;
        }
        if (state === "RAISED" && cand.uttId === ev.uttId) {
          // 先行判定と確定判定の結果を突き合わせる。確定側が正
          if (p !== "high" && p !== "medium") return drop(t, "low");
          cand.prio = p; cand.text = ev.speech || cand.text; cand.category = ev.category || cand.category;
          cand.confirmed = true;
          return;
        }
        if (!p || p === "none") return;
        if (state === "RAISED" && !cand.uttId && cand.key) { // 別の発言の確定待ち
          emit(t, "hint", { uttId: ev.uttId, why: "stale" });
          return;
        }
        let why = null;
        if (ev.uttId !== latestUtt) why = "stale";
        else if (p === "low") why = "low";
        else if (speechAfterFinal >= T.movedOnMs) why = "moved_on";
        else if (state !== "LISTEN") why = "busy";
        else why = blockedReason(t, p, ev.category);
        if (why) { emit(t, "hint", { uttId: ev.uttId, why }); return; }
        cand = { uttId: ev.uttId, text: ev.speech || "", prio: p, category: ev.category, tail: classifyTail(ev.text), raisedAt: t, finalAt: latestFinalAt, confirmed: true };
        state = "RAISED";
        emit(t, "raise", { uttId: ev.uttId });
      },
      playStart(ev) {
        if (sp && sp.id === ev.speakId && sp.playAt == null) {
          sp.playAt = ev.t;
          sp.useLevel = ev.levelOk !== false;
        }
      },
      playEnd(ev) {
        if (!sp || sp.id !== ev.speakId) return;
        emit(ev.t, "done", { speakId: sp.id, uttId: sp.uttId });
        endSpeaking(ev.t);
      },
      playFail(ev) {
        if (!sp || sp.id !== ev.speakId) return;
        const uttId = sp.uttId;
        refund(sp.id);
        emit(ev.t, "hint", { uttId, why: "play_failed" });
        endSpeaking(ev.t);
      },
      cancel(ev) {
        if (state === "RAISED") drop(ev.t, ev.why || "cancel");
        else if (state === "SPEAKING") stopSpeaking(ev.t, ev.why || "cancel", false);
      },
      tick() {},
    };

    return {
      step(ev) {
        out = [];
        const h = handlers[ev.type];
        if (h) h(ev);
        checkPendingBarge(ev.t);
        checkSpeaking(ev.t);
        checkRaised(ev.t);
        return out;
      },
      get state() { return state; },
      get speakId() { return sp ? sp.id : 0; },
      get voiceCount() { return voices.length; },
      get idle() { return state === "LISTEN"; },
    };
  }

  const api = { TIMING, PACES, createTurn, classifyTail, isEchoText, splitSentences, normalize };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Turn = api;
})(typeof window !== "undefined" ? window : globalThis);
