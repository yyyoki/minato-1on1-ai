"use strict";

// ---------- マイク：声の特徴だけを取り続ける（話者判定・声の登録・音量表示用） ----------
// 録音データは持たない。保持するのは直近30秒ぶんの特徴量（数値）だけ。
// マイクはこの1本だけを開き、音声認識にも同じ音を渡す（会議アプリと取り合わないため）。
// オンライン会議では「会議の音」（タブやシステムの音声）も受け取り、相手が話している時間を数える。
const Mic = (() => {
  // 自動音量調整を切る：オンだとChromeがPC全体のマイク音量を書き換え、会議アプリの声まで小さくなる
  const CONSTRAINTS = { echoCancellation: true, noiseSuppression: false, autoGainControl: false };
  const REMOTE_HOLD_MS = 250;   // 会議の音が止んでからこの間は、マイク側を自分の声として数えない（スピーカーの回り込み対策）
  let ctx = null, stream = null, analyser = null, timer = null, buf = null, vad = null, localGain = null, localSrc = null;
  let remote = null;            // { stream, src, analyser, buf, vad, dest, lastSpeech, level }
  let muted = false, muteUntil = 0, level = 0;
  let remoteSuppressed = false, suppressUntil = 0; // ミナト用PCの声が会議の音として戻ってくる間
  const frames = [];
  const remoteTimes = [];       // 相手が話していたフレームの時刻だけ
  const listeners = new Set();
  const endListeners = new Set();

  async function start() {
    if (stream) return;
    stream = await navigator.mediaDevices.getUserMedia({ audio: CONSTRAINTS });
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    localSrc = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = VoicePrint.N;
    analyser.smoothingTimeConstant = 0;
    localSrc.connect(analyser);
    buf = new Float32Array(analyser.fftSize);
    vad = VoicePrint.createVad();
    timer = setInterval(tick, 40);
  }

  function rmsOf(an, b) {
    an.getFloatTimeDomainData(b);
    let sum = 0;
    for (let i = 0; i < b.length; i++) sum += b[i] * b[i];
    return Math.sqrt(sum / b.length);
  }

  function tick() {
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const now = performance.now();
    let remoteSpeech = false;
    if (remote) {
      // ミナトの声は会議の音に入らないので、話している間も相手の声は数える
      const r = rmsOf(remote.analyser, remote.buf);
      const heard = remote.vad(r);
      remote.level = remote.level * 0.55 + Math.min(1, r * 14) * 0.45;
      if (heard) remote.lastSpeech = now;   // マイク側の回り込み対策には、ミナトの声も含めて使う
      // ミナト用PCの声は相手の声として数えない
      remoteSpeech = heard && !(remoteSuppressed || now < suppressUntil);
      if (remoteSpeech) remoteTimes.push(now);
      // 相手が話している間は、音声認識に渡すマイクの音を下げる（回り込んだ相手の声が二重に入らないように）
      localGain.gain.setTargetAtTime(now - remote.lastSpeech < REMOTE_HOLD_MS ? 0.15 : 1, ctx.currentTime, 0.03);
    }
    const rms = rmsOf(analyser, buf);
    const ignored = muted || now < muteUntil;
    const remoteRecent = remote && now - remote.lastSpeech < REMOTE_HOLD_MS;
    const speech = !ignored && vad(rms) && !remoteRecent; // ミナトの声で雑音レベルの学習が狂わないようにする
    level = level * 0.55 + Math.min(1, rms * 14) * 0.45;
    if (speech) {
      const f = VoicePrint.frameFeatures(buf, ctx.sampleRate);
      frames.push({ t: now, f0: f.f0, clarity: f.clarity, bands: f.bands });
    }
    while (frames.length && now - frames[0].t > 30000) frames.shift();
    while (remoteTimes.length && now - remoteTimes[0] > 30000) remoteTimes.shift();
    const ev = { level: ignored ? 0 : level, speech, rms, t: now, remoteSpeech, remoteLevel: remote ? remote.level : 0 };
    listeners.forEach((fn) => fn(ev));
  }

  function detachRemote(why) {
    if (!remote) return;
    const r = remote;
    remote = null;
    try { r.src.disconnect(); } catch (e) { /* 切断済み */ }
    r.stream.getTracks().forEach((t) => t.stop());
    if (localGain) {
      try { localGain.disconnect(); } catch (e) { /* 切断済み */ }
      localGain.gain.value = 1;
    }
    remoteTimes.length = 0;
    endListeners.forEach((fn) => fn(why || "stopped"));
  }

  return {
    start,
    isOn: () => !!stream,
    onFrame(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    // (t0, t1] の間に話していたフレーム（このPCのマイク）
    framesBetween(t0, t1 = performance.now()) {
      return frames.filter((f) => f.t > t0 && f.t <= t1);
    },
    // (t0, t1] の間に、マイク側と会議の音側で声がしていたフレーム数
    voicedBetween(t0, t1 = performance.now()) {
      return {
        local: frames.filter((f) => f.t > t0 && f.t <= t1).length,
        remote: remoteTimes.filter((t) => t > t0 && t <= t1).length,
      };
    },
    lastSpeechAt: () => (frames.length ? frames[frames.length - 1].t : 0),
    // 会議の音（getDisplayMedia で共有されたタブ・画面の音声）をつなぐ。音声が含まれていなければ false
    attachRemote(displayStream) {
      const track = displayStream.getAudioTracks()[0];
      if (!stream || !track) {
        displayStream.getTracks().forEach((t) => t.stop());
        return false;
      }
      detachRemote("replaced");
      const audioOnly = new MediaStream([track]);
      const src = ctx.createMediaStreamSource(audioOnly);
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      an.smoothingTimeConstant = 0;
      src.connect(an);
      // 音声認識へは「マイク＋会議の音」を混ぜて渡す
      const dest = ctx.createMediaStreamDestination();
      if (!localGain) {
        localGain = ctx.createGain();
        localSrc.connect(localGain);
      }
      localGain.connect(dest);
      src.connect(dest);
      remote = { stream: displayStream, src, analyser: an, buf: new Float32Array(an.fftSize), vad: VoicePrint.createVad(), dest, lastSpeech: -1e9, level: 0 };
      // 映像は使わない。共有をやめる操作（ブラウザの「共有を停止」）で音声も止まったら知らせる
      track.addEventListener("ended", () => detachRemote("ended"));
      displayStream.getVideoTracks().forEach((t) => t.addEventListener("ended", () => detachRemote("ended")));
      return true;
    },
    detachRemote,
    hasRemote: () => !!remote,
    onRemoteEnded(fn) {
      endListeners.add(fn);
      return () => endListeners.delete(fn);
    },
    // 音声認識に渡す音。会議の音があれば混ぜたもの、なければマイクそのもの
    recognitionTrack() {
      if (remote) return remote.dest.stream.getAudioTracks()[0] || null;
      return stream ? stream.getAudioTracks()[0] || null : null;
    },
    // ミナト用PCが話している間と、その少し後（会議の遅れ）は、会議の音を相手の声として数えない
    suppressRemote(on) {
      remoteSuppressed = on;
      if (!on) suppressUntil = performance.now() + 1500;
    },
    // ミナトや合成音声が話している間は拾わない（スピーカーの音を人の声と取り違えないため）
    mute(on) {
      muted = on;
      if (!on) muteUntil = performance.now() + 400;
    },
    stop() {
      detachRemote("mic_stopped");
      clearInterval(timer);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (ctx) ctx.close().catch(() => {});
      stream = ctx = analyser = localGain = localSrc = null;
      frames.length = 0;
    },
  };
})();

// ---------- 声：ミナト・上司・部下でそれぞれ違う声で話す ----------
// VOICEVOX（またはAivisSpeech）が起動していればその声、無ければブラウザの声を使う
const Voice = (() => {
  const ROLES = {
    mofu: {
      vv: ["冥鳴ひまり", "九州そら", "春日部つむぎ", "WhiteCUL", "四国めたん"],
      br: ["Kyoko", "O-Ren", "Google 日本語", "Flo", "Shelley", "Sandy"],
      pitch: 1.18, rate: 0.95, vvSpeed: 0.95, vvPitch: 0, intonation: 1.15,
    },
    boss: {
      vv: ["玄野武宏", "青山龍星", "白上虎太郎", "No.7", "剣崎雌雄"],
      br: ["Otoya", "Hattori", "Reed", "Eddy", "Rocko", "Grandpa"],
      pitch: 0.82, rate: 0.98, vvSpeed: 1.0, vvPitch: -0.02, intonation: 1.0,
    },
    subordinate: {
      vv: ["春日部つむぎ", "雨晴はう", "WhiteCUL", "波音リツ", "四国めたん"],
      br: ["Flo", "Sandy", "Shelley", "Google 日本語", "O-Ren", "Kyoko"],
      pitch: 1.04, rate: 1.0, vvSpeed: 1.02, vvPitch: 0, intonation: 1.0,
    },
  };
  const ORDER = ["mofu", "boss", "subordinate"];

  let engine = { available: false, speakers: [] };
  let roleConfig = {};
  let warmed = false;

  function browserVoices() {
    if (typeof speechSynthesis === "undefined") return [];
    return speechSynthesis.getVoices().filter((v) => (v.lang || "").toLowerCase().startsWith("ja"));
  }

  function vvStyles() {
    const out = [];
    (engine.speakers || []).forEach((s) =>
      (s.styles || []).forEach((st) => out.push({ id: st.id, speaker: s.name, style: st.name, label: `${s.name}（${st.name}）` }))
    );
    return out;
  }

  function pickVV(role, usedSpeakers) {
    const styles = vvStyles();
    for (const name of ROLES[role].vv) {
      if (usedSpeakers.has(name)) continue;
      const mine = styles.filter((s) => s.speaker === name);
      const st = mine.find((s) => /ノーマル|ふつう/.test(s.style)) || mine[0];
      if (st) return st;
    }
    return styles.find((s) => !usedSpeakers.has(s.speaker)) || styles[0] || null;
  }

  function pickBrowser(role, usedNames) {
    const vs = browserVoices();
    for (const name of ROLES[role].br) {
      const v = vs.find((x) => x.name.includes(name) && !usedNames.has(x.name));
      if (v) return v;
    }
    return vs.find((x) => !usedNames.has(x.name)) || vs[0] || null;
  }

  // 3人ぶんの声を、なるべく重ならないように決める
  function resolveAll() {
    const usedVV = new Set(), usedBr = new Set(), out = {};
    const styles = vvStyles();
    for (const role of ORDER) {
      const choice = (roleConfig[role] && roleConfig[role].choice) || "";
      let r = null;
      if (choice.startsWith("vv:") && engine.available) {
        const st = styles.find((s) => String(s.id) === choice.slice(3));
        if (st) r = { kind: "vv", id: st.id, speaker: st.speaker, label: st.label };
      } else if (choice.startsWith("br:")) {
        const v = browserVoices().find((x) => x.name === choice.slice(3));
        if (v) r = { kind: "br", voice: v, label: v.name };
      }
      if (!r && engine.available) {
        const st = pickVV(role, usedVV);
        if (st) r = { kind: "vv", id: st.id, speaker: st.speaker, label: st.label };
      }
      if (!r) {
        const v = pickBrowser(role, usedBr);
        r = { kind: "br", voice: v, label: v ? v.name : "ブラウザ標準" };
      }
      if (r.kind === "vv") usedVV.add(r.speaker);
      else if (r.voice) usedBr.add(r.voice.name);
      out[role] = r;
    }
    return out;
  }

  // ---- Web Audio：音量を下げる・なめらかに止めるために、声はここを通して再生する ----
  let ac = null, master = null, analyser = null, levelBuf = null;
  let gen = 0, current = null;
  const buffers = new Map();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function ensureAudio() {
    if (ac) return ac;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ac = new AC();
    master = ac.createGain();
    analyser = ac.createAnalyser();
    analyser.fftSize = 1024;
    levelBuf = new Float32Array(analyser.fftSize);
    master.connect(analyser);
    analyser.connect(ac.destination);
    return ac;
  }

  function fetchBuffer(text, id, d) {
    const key = `${id}:${text}`;
    if (buffers.has(key)) return buffers.get(key);
    const p = fetch("/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, speaker: id, speed: d.vvSpeed, pitch: d.vvPitch, intonation: d.intonation }),
    })
      .then((res) => {
        if (!res.ok) throw new Error("tts " + res.status);
        return res.arrayBuffer();
      })
      .then((data) => ensureAudio().decodeAudioData(data));
    p.catch(() => buffers.delete(key));
    buffers.set(key, p);
    if (buffers.size > 40) buffers.delete(buffers.keys().next().value);
    return p;
  }

  function playBuffer(buffer) {
    return new Promise((resolve) => {
      if (ac.state === "suspended") ac.resume().catch(() => {});
      const src = ac.createBufferSource();
      src.buffer = buffer;
      src.connect(master);
      const entry = { src, finish: resolve };
      current = entry;
      src.onended = () => {
        if (current === entry) current = null;
        resolve();
      };
      src.start();
    });
  }

  async function playVV(parts, id, d, onStart, myGen) {
    let started = false;
    try {
      for (let i = 0; i < parts.length; i++) {
        const buffer = await fetchBuffer(parts[i], id, d);
        if (myGen !== gen) return "cancelled";
        if (parts[i + 1]) fetchBuffer(parts[i + 1], id, d).catch(() => {}); // 次の文を先に合成しておく
        if (!started) {
          started = true;
          master.gain.cancelScheduledValues(ac.currentTime);
          master.gain.setValueAtTime(1, ac.currentTime);
          onStart("vv");
        }
        await playBuffer(buffer);
        if (myGen !== gen) return "cancelled";
        if (i < parts.length - 1) {
          await wait(i === 0 ? 90 : 150); // 呼びかけの後は短く、文の間は少し長く
          if (myGen !== gen) return "cancelled";
        }
      }
      return "done";
    } catch (e) {
      if (started) return "failed";
      throw e;
    }
  }

  function speakUtterance(text, voice, d, onStart) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ja-JP";
      u.rate = d.rate;
      u.pitch = d.pitch;
      if (voice) u.voice = voice;
      let done = false, began = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearInterval(watchdog);
        clearTimeout(timeout);
        resolve(ok);
      };
      u.onstart = () => { began = true; onStart(); };
      u.onend = () => { if (!began) onStart(); finish(true); };
      u.onerror = () => finish(false);
      speechSynthesis.speak(u);
      // Chromeは長い発話が途中で止まるため、定期的に pause/resume して継続させる
      const watchdog = setInterval(() => {
        if (speechSynthesis.speaking) { speechSynthesis.pause(); speechSynthesis.resume(); }
      }, 8000);
      const timeout = setTimeout(() => { speechSynthesis.cancel(); finish(false); }, 20000);
    });
  }

  async function playBrowser(parts, voice, d, onStart, myGen) {
    if (typeof speechSynthesis === "undefined") return "failed";
    speechSynthesis.cancel();
    let started = false;
    for (const part of parts) {
      const ok = await speakUtterance(part, voice, d, () => {
        if (!started) { started = true; onStart("browser"); }
      });
      if (myGen !== gen) return "cancelled";
      if (!ok) return "failed";
    }
    return "done";
  }

  // 文の配列を順に話す。結果は done / cancelled / failed。onStart は実際に音が出始めた時に呼ぶ
  async function speakParts(parts, role, onStart = () => {}) {
    parts = (parts || []).map((p) => (p || "").trim()).filter(Boolean);
    if (!parts.length) return "done";
    const myGen = ++gen;
    const d = ROLES[role] || ROLES.mofu;
    const r = resolveAll()[role] || {};
    if (r.kind === "vv" && ensureAudio()) {
      try {
        return await playVV(parts, r.id, d, onStart, myGen);
      } catch (e) {
        console.warn("[声] VOICEVOXで再生できなかったため、ブラウザの声で話します", e);
        if (myGen !== gen) return "cancelled";
      }
    }
    return playBrowser(parts, r.voice || pickBrowser(role, new Set()), d, onStart, myGen);
  }

  return {
    ROLES,
    async refresh() {
      try {
        const res = await fetch("/tts/status");
        engine = await res.json();
      } catch (e) {
        engine = { available: false, speakers: [] };
      }
      return engine;
    },
    engine: () => engine,
    setConfig(voiceConfig) {
      roleConfig = (voiceConfig && voiceConfig.roles) || {};
    },
    resolveAll,
    browserVoices,
    vvStyles,
    // VOICEVOXの利用規約で必要なクレジット表記
    credits() {
      const r = resolveAll();
      const names = [...new Set(ORDER.filter((k) => r[k].kind === "vv").map((k) => r[k].speaker))];
      return names.map((n) => "VOICEVOX:" + n);
    },
    warmup() {
      ensureAudio();
      if (ac && ac.state === "suspended") ac.resume().catch(() => {});
      if (warmed || typeof speechSynthesis === "undefined") return;
      const u = new SpeechSynthesisUtterance("");
      u.volume = 0;
      speechSynthesis.speak(u);
      warmed = true;
    },
    speakParts,
    async speak(text, role) {
      return speakParts(Turn.splitSentences(text), role);
    },
    // 話す前に合成しておく（話し出しの待ち時間を減らす）。VOICEVOX使用時のみ効く
    preload(parts, role) {
      const r = resolveAll()[role] || {};
      if (r.kind !== "vv" || !ensureAudio()) return;
      (parts || []).filter(Boolean).forEach((p) => fetchBuffer(p, r.id, ROLES[role] || ROLES.mofu).catch(() => {}));
    },
    // 再生中の音量（回り込みの判定用）。VOICEVOXの再生中だけ取れる
    outputLevel() {
      if (!current || !analyser) return null;
      analyser.getFloatTimeDomainData(levelBuf);
      let sum = 0;
      for (let i = 0; i < levelBuf.length; i++) sum += levelBuf[i] * levelBuf[i];
      return Math.sqrt(sum / levelBuf.length);
    },
    duck(on) {
      if (master) master.gain.setTargetAtTime(on ? 0.25 : 1, ac.currentTime, 0.04);
    },
    cancel() {
      gen++;
      if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
      if (current) {
        const { src, finish } = current;
        current = null;
        const now = ac.currentTime;
        master.gain.cancelScheduledValues(now);
        master.gain.setTargetAtTime(0, now, 0.03);
        try { src.stop(now + 0.12); } catch (e) { /* 停止済み */ }
        finish();
      }
    },
  };
})();
