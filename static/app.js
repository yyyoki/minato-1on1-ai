"use strict";

const $ = (id) => document.getElementById(id);

const TYPE_META = {
  perfectionist: { color: "var(--type-perfectionist)", desc: "失敗を自分の能力不足と捉えやすい", tense: "自分を責めそう" },
  logical: { color: "var(--type-logical)", desc: "根拠のない指摘や感情論が苦手", tense: "納得できていなさそう" },
  sensitive: { color: "var(--type-sensitive)", desc: "声のトーンや場の空気に敏感", tense: "固まってしまいそう" },
};
const TYPE_ORDER = ["perfectionist", "logical", "sensitive"];
const OPTIONS = [["まったく", "当てはまらない"], ["あまり", "当てはまらない"], ["やや", "当てはまる"], ["とても", "当てはまる"]];
const SENSITIVITY_LABEL = { low: "控えめ", medium: "ふつう", high: "積極的" };
const SCREENS = ["analyze", "profile", "voices", "meeting", "summary"];
const WHO = { boss: "上司", subordinate: "部下" };

// 声を出さなかった理由（画面に出す言葉）
const HOLD_REASON = {
  moved_on: "会話が続いていたので",
  stale: "話題が先に進んでいたので",
  expired: "話すタイミングがなかったので",
  low: "声に出すほどではなさそうなので",
  unsure: "誰の発言か確かでないので",
  warmup: "面談が始まったばかりなので",
  gap: "少し前に話したばかりなので",
  budget: "今日はもう十分話したので",
  category: "同じ話題は一度にしたので",
  voice_off: "声は控える設定になっているので",
  busy: "別の話をしていたので",
  late: "声の準備が間に合わなかったので",
  before_play: "どなたかが話し始めたので",
  play_failed: "声を出せなかったので",
  corrected: "話者が直されたので",
};
const OUTCOME_LABEL = { voice: "声で伝えた", interrupted: "途中で譲った", yielded: "会話を優先", screen: "画面のみ", pending: "判定のみ" };
const CUSHIONS = ["あの、", "えっと、"];

// デモ会話（上司・部下・ミナトの声を聞き分けられるように、それぞれ別の声で再生する）
const DEMO_SCRIPT = [
  { who: "boss", text: "先週お願いした資料、進捗どうなってる？" },
  { who: "subordinate", text: "すみません…私の段取りが悪くて、まだ半分くらいです" },
  { who: "boss", text: "なんでもっと早く相談しなかったの？" },
  { who: "boss", text: "そうだね。どういう経緯だったか教えてもらえる？" },
  { who: "subordinate", text: "データの集計で迷っていて、どこまで調べればいいか分からなくなっていました" },
  { who: "boss", text: "なるほど。じゃあ次は、どの時点で声をかけるか一緒に決めようか" },
  { who: "subordinate", text: "はい、ありがとうございます。水曜までに一度見てもらえますか" },
];

const state = {
  config: null,
  questions: [],
  answers: {},
  qIndex: 0,
  profile: null,
  sensitivity: "medium",
  isRecording: false,
  isSpeaking: false,
  micBlocked: false,
  recognition: null,
  context: [],
  meeting: null,
  voices: { boss: null, subordinate: null },
  separation: null,
  micError: null,
  speakerMode: "boss",
  lastFinalT: 0,
  liveSpeaker: null,
  demo: null,
  testWho: "boss",
  inputSource: "mic",      // mic（このPCのマイク）/ zoom（Zoomの参加者名つき文字起こし）
  zoomFeed: null,
  zoomQueue: Promise.resolve(),
  turn: null,              // フロア管理（static/turn.js）
  turnTimer: null,
  turnLog: [],
  turnT0: 0,
  verdicts: new Map(),     // 発言ID → 判定結果
  noSend: new Set(),       // 外部へ送る文脈に含めない発言（話者不明・デモ）
  epoch: 0,                // デモ開始などで、それ以前の判定を声にしないための世代
  activeSpeak: null,
  recPaused: false,        // 挨拶・デモの再生中は音声認識を止める
  lastVoiceAt: 0,
  notNeeded: 0,
  meter: null,             // 音声の計測（static/metrics.js）
};

const privacy = () => (state.config && state.config.privacy) || {};
const showProfile = () => !!privacy().show_profile;
const paceKey = () => (state.config && state.config.turn && state.config.turn.pace) || "normal";

function zoomEnabled() {
  return !!(state.config && state.config.zoom && state.config.zoom.enabled);
}
const chars = {};
const people = {};
let lineSeq = 0;

// ---------- 通信 ----------
async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(url + " " + res.status);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(url + " " + res.status);
  return res.json();
}

// ---------- 共通UI ----------
let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

function showScreen(name) {
  document.querySelectorAll(".screen").forEach((s) => (s.hidden = s.dataset.screen !== name));
  $("app").dataset.screen = name;
  const idx = SCREENS.indexOf(name);
  document.querySelectorAll("#stepper li").forEach((li, i) => {
    li.classList.toggle("is-current", i === idx);
    li.classList.toggle("is-done", idx > -1 && i < idx);
  });
  window.scrollTo({ top: 0 });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nowTime() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function charName() {
  return (state.config && state.config.character_persona && state.config.character_persona.name) || "ミナト";
}

function roleName(role) {
  return role === "mofu" ? charName() : WHO[role];
}

function hasVoices() {
  return !!(state.voices.boss && state.voices.subordinate);
}

// ---------- 起動 ----------
async function init() {
  chars.start = Mofu.create($("charStart"), { follow: true });
  chars.analyze = Mofu.create($("charAnalyze"), { follow: true });
  chars.profile = Mofu.create($("charProfile"), { follow: true });
  chars.voices = Mofu.create($("charVoices"), { follow: true });
  chars.meeting = Mofu.create($("charMeeting"));
  chars.summary = Mofu.create($("charSummary"), { follow: true });
  people.boss = People.create($("personBoss"), "boss");
  people.subordinate = People.create($("personSub"), "subordinate");
  people.enrollBoss = People.create($("personEnrollBoss"), "boss");
  people.enrollSub = People.create($("personEnrollSub"), "subordinate");

  try {
    const [config, questions, profile] = await Promise.all([
      getJSON("/config"),
      getJSON("/profile/questions"),
      getJSON("/profile"),
    ]);
    state.config = config;
    state.questions = questions;
    state.profile = profile;
    state.sensitivity = config.sensitivity || "medium";
    Voice.setConfig(config.voice);
  } catch (e) {
    console.error(e);
    toast("サーバーに接続できません。アプリを起動し直してください。");
    return;
  }

  Voice.refresh().then(updateVoiceCredit);
  updateQuickStart();
  showScreen("start");
  setTimeout(() => chars.start.react("happy", 1500), 600);
}

function updateQuickStart() {
  const p = state.profile;
  $("btnQuick").hidden = !p;
  $("quickNote").hidden = !p;
  if (p) {
    const d = new Date(p.analyzed_at);
    $("quickNote").textContent = `前回の分析：${p.label}（${d.getMonth() + 1}/${d.getDate()}）`;
  }
}

// ---------- ② 特性分析 ----------
function startAnalysis() {
  state.answers = {};
  state.qIndex = 0;
  $("questionWrap").hidden = false;
  $("presetPicker").hidden = true;
  $("analyzeBubble").textContent = "部下さんのこと、少し教えてください！ふだんの様子にいちばん近いものを選んでくださいね。";
  chars.analyze.setState("idle");
  renderQuestion();
  showScreen("analyze");
}

function renderQuestion() {
  const qs = state.questions;
  const q = qs[state.qIndex];
  $("qNum").textContent = "Q" + (state.qIndex + 1);
  $("qCount").textContent = `${state.qIndex + 1} / ${qs.length}`;
  $("qText").textContent = q.text;
  $("qProgress").style.width = (state.qIndex / qs.length) * 100 + "%";
  $("qPrev").style.visibility = state.qIndex === 0 ? "hidden" : "visible";

  const wrap = $("qOptions");
  wrap.replaceChildren();
  OPTIONS.forEach((label, i) => {
    const b = el("button", "q-option");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(state.answers[q.id] === i));
    if (state.answers[q.id] === i) b.classList.add("is-selected");
    const scale = el("span", "q-scale");
    for (let k = 0; k < 4; k++) scale.appendChild(el("i", k <= i ? "on" : ""));
    const text = el("span", "q-label");
    label.forEach((part) => text.appendChild(el("span", "", part)));
    b.append(scale, text);
    b.addEventListener("click", () => chooseAnswer(i));
    wrap.appendChild(b);
  });

  const card = $("questionCard");
  card.classList.remove("is-changing");
  void card.offsetWidth;
  card.classList.add("is-changing");
}

let answering = false;
function chooseAnswer(value) {
  if (answering) return;
  answering = true;
  const q = state.questions[state.qIndex];
  state.answers[q.id] = value;
  document.querySelectorAll(".q-option").forEach((b, i) => b.classList.toggle("is-selected", i === value));

  const half = Math.floor(state.questions.length / 2) - 1;
  if (state.qIndex === half) {
    $("analyzeBubble").textContent = "いい感じです！あと半分ですね〜";
    chars.analyze.react("jump", 700);
  } else if (Math.random() < 0.35) {
    chars.analyze.blink();
  }

  setTimeout(() => {
    answering = false;
    if (state.qIndex < state.questions.length - 1) {
      state.qIndex++;
      renderQuestion();
    } else {
      finishAnalysis({ answers: state.answers });
    }
  }, 260);
}

async function finishAnalysis(payload) {
  $("qProgress").style.width = "100%";
  $("analyzeBubble").textContent = "ありがとうございます！今、受け止め方の傾向を分析していますね…";
  chars.analyze.setState("thinking");
  try {
    const [result] = await Promise.all([
      postJSON("/profile/analyze", payload),
      new Promise((r) => setTimeout(r, 900)),
    ]);
    state.profile = result;
    state.config = await getJSON("/config");
    state.sensitivity = result.recommended_sensitivity || "medium";
    chars.analyze.setState("idle");
    renderProfile(true);
    showScreen("profile");
    setTimeout(() => chars.profile.react("happy", 1400), 300);
  } catch (e) {
    console.error(e);
    chars.analyze.setState("idle");
    toast("分析に失敗しました。もう一度お試しください。");
  }
}

function showPresets() {
  const grid = $("presetGrid");
  grid.replaceChildren();
  const presets = state.config.personality_presets || {};
  TYPE_ORDER.filter((k) => presets[k]).forEach((key) => {
    const p = presets[key];
    const card = el("button", "preset-card");
    card.type = "button";
    card.style.setProperty("--accent", TYPE_META[key].color);
    card.append(el("b", "", p.label), el("span", "", p.traits));
    card.addEventListener("click", () => finishAnalysis({ preset: key }));
    grid.appendChild(card);
  });
  $("questionWrap").hidden = true;
  $("presetPicker").hidden = false;
  $("analyzeBubble").textContent = "タイプがわかっている場合は、ここから選んでくださいね！";
}

// ---------- ③ 分析結果 ----------
function renderProfile(fresh) {
  const p = state.profile;
  const preset = state.config.personality_presets[p.primary] || {};

  $("pfLabel").textContent = p.label;
  document.querySelector(".result-card").style.setProperty("--accent", TYPE_META[p.primary].color);
  $("pfSecondary").textContent = p.secondary_label
    ? `「${p.secondary_label}」の傾向もあわせ持っています`
    : p.scores ? "" : "タイプを直接選択しました";

  const bars = $("pfScores");
  bars.replaceChildren();
  bars.hidden = !p.scores;
  if (p.scores) {
    TYPE_ORDER.forEach((key) => {
      const row = el("div", "score-row" + (key === p.primary ? " is-primary" : ""));
      const track = el("div", "track");
      const fill = el("div", "fill");
      fill.style.setProperty("--c", TYPE_META[key].color);
      track.appendChild(fill);
      row.append(el("span", "name", state.config.personality_presets[key].label), track, el("span", "val", p.scores[key] + "%"));
      bars.appendChild(row);
      requestAnimationFrame(() => requestAnimationFrame(() => (fill.style.width = p.scores[key] + "%")));
    });
  }

  $("pfTraits").textContent = preset.traits || "";
  $("pfLowSignal").hidden = !p.low_signal;
  $("pfApproach").textContent = preset.meta_triggers || "";

  const watch = $("pfWatch");
  watch.replaceChildren();
  (p.watch_points || []).slice(0, 4).forEach((w) => {
    const li = el("li");
    li.append(el("b", "", w.label), el("span", "", w.example));
    watch.appendChild(li);
  });

  $("pfEditTraits").value = preset.traits || "";
  $("pfEditLandmines").value = preset.landmines || "";
  $("pfEditMeta").value = preset.meta_triggers || "";

  if (fresh) state.sensitivity = p.recommended_sensitivity || state.sensitivity;
  renderSensitivity();
  $("profileBubble").textContent = `わかりました！今日は「${p.label}」の受け止め方に合わせて、そっと見守りますね。`;
}

function renderSensitivity() {
  document.querySelectorAll("#sensitivity button").forEach((b) => {
    const active = b.dataset.level === state.sensitivity;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-checked", String(active));
  });
  const rec = state.profile && state.profile.recommended_sensitivity;
  $("pfRecommend").textContent = rec ? `分析結果からは「${SENSITIVITY_LABEL[rec]}」をおすすめしています` : "";
}

async function saveProfileEdits() {
  const key = state.profile.primary;
  const preset = state.config.personality_presets[key];
  preset.traits = $("pfEditTraits").value.trim();
  preset.landmines = $("pfEditLandmines").value.trim();
  preset.meta_triggers = $("pfEditMeta").value.trim();
  state.config.active_preset = key;
  state.config.sensitivity = state.sensitivity;
  await postJSON("/config", state.config);
}

// ---------- ④ 声の登録 ----------
const ENROLL_IDS = { boss: "enrollBoss", subordinate: "enrollSub" };
const ENROLL_TARGET_SEC = 5;   // これだけ話せば十分
const ENROLL_MIN_SEC = 2;      // これ未満はやり直し
let rec = null;
let tryUnsub = null;

const ZOOM_MIC_NOTE = "Zoom連携がオンのときは参加者名で見分けるため、声の登録は不要です。マイクは使わず、このまま面談を開始できます。";

async function openVoices() {
  showScreen("voices");
  people.enrollSub.setType(state.profile && state.profile.primary);
  if (zoomEnabled()) {
    if (Mic.isOn()) Mic.stop();
    state.micError = ZOOM_MIC_NOTE;
    renderEnroll();
    return;
  }
  if (state.micError === ZOOM_MIC_NOTE) state.micError = null;
  renderEnroll();
  if (!Mic.isOn()) {
    try {
      await Mic.start();
      state.micError = null;
    } catch (e) {
      console.error(e);
      state.micError = e.name === "NotAllowedError"
        ? "マイクの使用が許可されていません。アドレスバー左のアイコンから許可すると、声を登録できます。"
        : "マイクを開けませんでした。接続を確認してください。";
    }
  }
  renderEnroll();
}

function renderEnroll() {
  $("micError").hidden = !state.micError;
  $("micError").textContent = state.micError || "";
  ["boss", "subordinate"].forEach((role) => {
    const card = $(ENROLL_IDS[role]);
    const recording = rec && rec.role === role;
    const done = !!state.voices[role];
    const cardState = recording ? "recording" : card.dataset.state === "error" ? "error" : done ? "done" : "empty";
    card.dataset.state = cardState;
    const btn = card.querySelector("[data-action=record]");
    btn.disabled = !!state.micError || (rec && !recording);
    btn.textContent = recording ? "■ 読み終えたら押す" : done ? "録り直す" : "録音して登録する";
    const status = card.querySelector(".enroll-status");
    if (recording) status.textContent = "上の文を読んでください…";
    else if (cardState === "error") status.textContent = card.dataset.error || "もう一度お願いします";
    else if (done) status.textContent = "✓ 登録しました";
    else status.textContent = "まだ登録していません";
    if (!recording) card.querySelector(".meter-fill").style.width = done ? "100%" : "0%";
  });

  const sep = state.separation;
  $("sepCard").hidden = !sep;
  if (sep) {
    const info = {
      high: ["◎", "はっきり見分けられそうです", "面談中は声で自動的に上司・部下を判定します。"],
      medium: ["○", "おおむね見分けられそうです", "間違えたときは、会話ログの名前の札をクリックすると直せます。"],
      low: ["△", "お二人の声が近いため、自動判定は間違えやすそうです", "面談中は画面上部の「上司／部下」ボタン（キー1・2）で切り替えるのがおすすめです。"],
    }[sep.level];
    $("sepCard").dataset.level = sep.level;
    $("sepMark").textContent = info[0];
    $("sepTitle").textContent = info[1];
    $("sepText").textContent = info[2];
  }
  $("voicesHint").textContent = hasVoices()
    ? "登録した声は、この画面を閉じるまで使えます。"
    : "登録しない場合は、面談中に画面上部の「上司／部下」ボタンで話者を切り替えます。";

  if (hasVoices()) $("voicesBubble").textContent = "ばっちりです！話している人を、ステージの上で光らせてお知らせしますね。";
  else if (state.voices.boss) $("voicesBubble").textContent = "上司さんの声、覚えました！次は部下さんの番です。同じ文を読んでくださいね。";
  else if (state.voices.subordinate) $("voicesBubble").textContent = "部下さんの声、覚えました！上司さんも同じ文を読んでくださいね。";
}

function toggleRecord(role) {
  if (rec && rec.role === role) { finishRecord(); return; }
  if (rec || state.micError) return;
  stopTry();
  const card = $(ENROLL_IDS[role]);
  card.dataset.state = "recording";
  rec = { role, t0: performance.now(), lastSpeech: 0 };
  const person = role === "boss" ? people.enrollBoss : people.enrollSub;
  rec.unsub = Mic.onFrame(({ level, speech, t }) => {
    if (!rec) return;
    person.setSpeaking(speech);
    const sec = Mic.framesBetween(rec.t0, t).length * 0.04;
    card.querySelector(".meter-fill").style.width = Math.min(100, (sec / ENROLL_TARGET_SEC) * 100) + "%";
    card.style.setProperty("--lv", level.toFixed(2));
    if (speech) rec.lastSpeech = t;
    const quietFor = rec.lastSpeech ? t - rec.lastSpeech : 0;
    // 十分話して、少し間があいたら自動で終了。長すぎる場合も終了
    if ((sec >= ENROLL_TARGET_SEC && quietFor > 900) || t - rec.t0 > 15000) finishRecord();
  });
  renderEnroll();
  chars.voices.setState("listening");
  $("voicesBubble").textContent = `${WHO[role]}さん、上の文をゆっくり読んでください。聞いていますね！`;
}

function finishRecord() {
  if (!rec) return;
  const { role, t0, unsub } = rec;
  unsub();
  rec = null;
  (role === "boss" ? people.enrollBoss : people.enrollSub).setSpeaking(false);
  chars.voices.setState("idle");
  const card = $(ENROLL_IDS[role]);
  const frames = Mic.framesBetween(t0);
  if (frames.length * 0.04 < ENROLL_MIN_SEC) {
    card.dataset.state = "error";
    card.dataset.error = "声が短いか小さいようです。マイクに近づいて、もう一度お願いします";
    renderEnroll();
    return;
  }
  state.voices[role] = VoicePrint.makePrint(frames);
  state.separation = VoicePrint.separation(state.voices);
  card.dataset.state = "done";
  (role === "boss" ? people.enrollBoss : people.enrollSub).flash("relieved", 1400);
  chars.voices.react("happy", 1200);
  renderEnroll();
}

function toggleTry() {
  if (!tryUnsub && !Mic.isOn()) return;
  if (tryUnsub) { stopTry(); return; }
  if (!hasVoices()) return;
  $("btnTry").textContent = "確かめるのをやめる";
  $("tryResult").textContent = "どちらかが話してみてください…";
  let lastShow = 0;
  tryUnsub = Mic.onFrame(({ t }) => {
    if (t - lastShow < 300) return;
    lastShow = t;
    const frames = Mic.framesBetween(t - 2500, t);
    if (frames.length < 8 || t - Mic.lastSpeechAt() > 1500) return;
    const r = VoicePrint.classify(VoicePrint.makePrint(frames), state.voices);
    if (!r) return;
    const unsure = r.confidence < VoicePrint.LOW_CONFIDENCE;
    $("tryResult").dataset.speaker = r.speaker;
    $("tryResult").textContent = `いまの声：${WHO[r.speaker]}${unsure ? "？（自信なし）" : ""}　${Math.round(r.confidence * 100)}%`;
    (r.speaker === "boss" ? people.enrollBoss : people.enrollSub).flash("relieved", 600);
  });
}

function stopTry() {
  if (tryUnsub) tryUnsub();
  tryUnsub = null;
  $("btnTry").textContent = "試しに話して確かめる";
  $("tryResult").textContent = "";
  delete $("tryResult").dataset.speaker;
}

// ---------- ⑤ 面談 ----------
async function startMeeting() {
  Voice.warmup();
  if (rec) finishRecord();
  stopTry();
  try {
    await saveProfileEdits();
  } catch (e) {
    console.error(e);
    toast("設定の保存に失敗しました。");
    return;
  }

  state.meeting = {
    startedAt: Date.now(),
    timer: null,
    utterances: { boss: 0, subordinate: 0 },
    chars: { boss: 0, subordinate: 0 },
    interventions: [],
    signals: [],
    lines: [],
    autoCount: 0,
    corrections: 0,
    logFile: null,
  };
  state.context = [];
  state.micBlocked = false;
  state.demo = null;
  state.inputSource = zoomEnabled() ? "zoom" : "mic";
  state.turnT0 = performance.now();
  state.turn = Turn.createTurn({ pace: paceKey(), textOnly: state.inputSource === "zoom", t0: state.turnT0 });
  state.turnLog = [];
  state.meter = Metrics.createMeter();
  state.verdicts = new Map();
  state.noSend = new Set();
  state.epoch++;
  state.activeSpeak = null;
  state.notNeeded = 0;
  Voice.preload(CUSHIONS, "mofu");
  document.querySelector(".meeting-bar").classList.toggle("is-zoom", state.inputSource === "zoom");
  const autoOk = hasVoices() && state.separation && state.separation.level !== "low";
  setSpeakerMode(autoOk ? "auto" : "boss");

  $("transcript").replaceChildren(el("p", "empty", "話し始めると、ここに文字起こしが表示されます"));
  $("speech").hidden = true;
  $("hintCard").hidden = true;
  $("dataPreview").textContent = "まだ送信されたデータはありません";
  $("mtType").hidden = !showProfile();
  $("forecast").hidden = !showProfile();
  $("speechFeedback").hidden = true;
  chars.meeting.holdRaise(false);
  $("mtType").textContent = state.profile.label;
  $("mtType").style.background = "color-mix(in srgb, " + TYPE_META[state.profile.primary].color + " 14%, white)";
  $("mtType").style.color = TYPE_META[state.profile.primary].color;
  $("mtSensitivity").textContent = "感度：" + SENSITIVITY_LABEL[state.sensitivity];
  $("mtTimer").textContent = "00:00";
  $("npMofu").textContent = charName();
  people.subordinate.setType(state.profile.primary);
  people.boss.setMood("calm");
  people.subordinate.setMood("calm");
  setForecast("calm");
  document.querySelectorAll(".seat-bubble").forEach((b) => (b.hidden = true));
  updateDemoButton();
  updateCounts();
  updateVoiceCredit();
  showScreen("meeting");

  try {
    await postJSON("/start-session");
  } catch (e) {
    console.error(e);
  }

  state.isRecording = true;
  state.turnTimer = setInterval(() => feedTurn({ type: "tick" }), 100);
  state.meeting.timer = setInterval(() => {
    $("mtTimer").textContent = formatDuration(Date.now() - state.meeting.startedAt);
  }, 1000);

  // Zoomモードでは、このPCのマイクを使わない（声の登録で開いていれば閉じる）
  if (state.inputSource === "zoom" && Mic.isOn()) Mic.stop();
  if (state.inputSource !== "zoom" && !Mic.isOn()) {
    try { await Mic.start(); } catch (e) { /* 音量表示なしで続行（音声認識側でも許可を求める） */ }
  }
  if (state.inputSource !== "zoom" && Mic.isOn()) state.meeting.unsubMic = Mic.onFrame(onMeetingFrame);

  if (state.inputSource === "zoom") {
    openZoomFeed();
  } else if (!("webkitSpeechRecognition" in window)) {
    state.micBlocked = true;
    setStatus("error", "音声認識に未対応");
    toast("このブラウザは音声認識に対応していません。Chromeをお使いください（テキスト入力で試せます）。");
  }

  chars.meeting.react("raise", 1000);
  addSystemLine("面談を開始しました");
  if (state.inputSource === "zoom") addSystemLine("Zoomの参加者名で、上司・部下を見分けます");
  else if (state.speakerMode === "auto") addSystemLine("登録した声で、上司・部下を自動で見分けます");
  else if (hasVoices()) addSystemLine("声が近いため、話者は上部のボタンで切り替えます");
  const greeting = `${charName()}です。今日はよろしくお願いします！`;
  addMofuLine(greeting);
  $("stageCaption").textContent = "";
  await speakAs("mofu", greeting);
  if (state.isRecording) $("stageCaption").textContent = captionIdle();
}

function captionIdle() {
  if (state.inputSource === "zoom") return "Zoomの会話を聞いています…（話している人が光ります）";
  return state.speakerMode === "auto" ? "会話を聞いています…（話している人が光ります）" : `会話を聞いています…（いまの話者：${WHO[state.speakerMode]}）`;
}

async function endMeeting() {
  if (!state.isRecording) return;
  feedTurn({ type: "cancel", why: "ended" });
  state.isRecording = false;
  if (state.demo) state.demo.abort = true;
  stopRecognition();
  Voice.cancel();
  clearInterval(state.turnTimer);
  state.turn = null;
  chars.meeting.holdRaise(false);
  clearInterval(state.meeting.timer);
  closeZoomFeed();
  if (state.meeting.unsubMic) state.meeting.unsubMic();
  setSeatActive(null);
  state.meeting.endedAt = Date.now();

  try {
    const data = await postJSON("/end-session", { turn_log: state.turnLog, metrics: state.meter ? state.meter.export() : [] });
    state.meeting.logFile = data.file || null;
  } catch (e) {
    console.error(e);
  }

  renderSummary();
  showScreen("summary");
  setTimeout(() => chars.summary.react("happy", 1800), 300);
}

function setStatus(kind, text) {
  $("mtStatus").dataset.state = kind;
  $("mtStatusText").textContent = text;
}

function updateCounts() {
  const m = state.meeting;
  $("mtCounts").textContent = m
    ? `上司 ${m.utterances.boss} ・ 部下 ${m.utterances.subordinate} ・ ひとこと ${voicedCount(m)}`
    : "上司 0 ・ 部下 0 ・ ひとこと 0";
}

function setSpeakerMode(mode) {
  if (mode === "auto" && !hasVoices()) {
    toast("声を登録すると、自動で見分けられます");
    return;
  }
  state.speakerMode = mode;
  state.lastFinalT = performance.now();
  document.querySelectorAll("#speakerMode button").forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-checked", String(on));
    if (b.dataset.mode === "auto") b.disabled = !hasVoices();
  });
  if (state.isRecording && !state.isSpeaking) $("stageCaption").textContent = captionIdle();
}

// ステージ：話している人を光らせる
const seatLevel = { boss: 0, subordinate: 0 };
function setSeatActive(role, level = 0) {
  ["boss", "subordinate"].forEach((r) => {
    const target = r === role ? level : 0;
    seatLevel[r] = seatLevel[r] * 0.5 + target * 0.5;
    const seat = $(r === "boss" ? "seatBoss" : "seatSub");
    seat.classList.toggle("is-speaking", seatLevel[r] > 0.06);
    seat.style.setProperty("--lv", Math.min(1, seatLevel[r] * 1.6).toFixed(2));
  });
}

let lastLiveGuess = 0;
function onMeetingFrame({ level, speech, rms, t }) {
  if (!state.isRecording) return;
  if (speech) state.lastVoiceAt = t;
  if (state.meter) state.meter.frame(t, speech);
  feedTurn({ type: "frame", t, speech, rms, ref: Voice.outputLevel() });
  if (state.isSpeaking || state.demo) return;
  const before = state.liveSpeaker;
  if (state.speakerMode !== "auto") {
    state.liveSpeaker = state.speakerMode;
  } else if (t - lastLiveGuess > 250) {
    lastLiveGuess = t;
    const frames = Mic.framesBetween(Math.max(state.lastFinalT, t - 4000), t);
    if (frames.length >= 6) {
      const r = VoicePrint.classify(VoicePrint.makePrint(frames), state.voices);
      state.liveSpeaker = r && r.confidence >= VoicePrint.LOW_CONFIDENCE ? r.speaker : null;
    } else if (!speech) {
      state.liveSpeaker = null;
    }
  }
  if (state.liveSpeaker !== before) feedTurn({ type: "speaker", t, who: state.liveSpeaker });
  people.boss.setSpeaking(speech && state.liveSpeaker === "boss");
  people.subordinate.setSpeaking(speech && state.liveSpeaker === "subordinate");
  setSeatActive(state.liveSpeaker, speech ? level : 0);
}

// ---------- フロア管理との接続：turn.js の判断を、画面と声で実行する ----------
function voicedCount(m) {
  return m.interventions.filter((iv) => iv.outcome === "voice" || iv.outcome === "interrupted").length;
}

function logTurn(a, extra = {}) {
  if (state.turnLog.length >= 2000) return;
  const rec = { ms: Math.round(a.t - state.turnT0), type: a.type };
  ["why", "uttId", "started", "gain"].forEach((k) => { if (a[k] !== undefined) rec[k] = a[k]; });
  state.turnLog.push(Object.assign(rec, extra));
}

function feedTurn(ev) {
  if (!state.turn) return [];
  if (ev.t == null) ev.t = performance.now();
  const actions = state.turn.step(ev);
  actions.forEach(applyTurnAction);
  return actions;
}

let flashTimer = null;
function flashStatus(text) {
  if (state.isSpeaking) return;
  setStatus("thinking", text);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { if (state.turn && state.turn.idle) backToListening(); }, 2600);
}

function applyTurnAction(a) {
  if (a.type !== "speculate" && a.type !== "dropEcho") logTurn(a);
  const v = a.uttId ? state.verdicts.get(a.uttId) : null;
  switch (a.type) {
    case "speculate": runSpeculation(a.text); break;
    case "raise":
      if (a.uttId && state.meter) state.meter.raised(a.uttId, a.t);
      chars.meeting.holdRaise(true);
      setStatus("thinking", "話すタイミングを待っています");
      break;
    case "lower":
      chars.meeting.holdRaise(false);
      if (a.why !== "speak" && !a.uttId && state.turn.idle) backToListening();
      break;
    case "speak":
      if (state.meter) state.meter.spoke(a.uttId, a.t);
      startVoice(a, v);
      break;
    case "hint": if (v) holdToScreen(v, a.why); break;
    case "duck": Voice.duck(true); break;
    case "unduck": Voice.duck(false); break;
    case "stop":
      Voice.cancel();
      finishVoice();
      if (!v) break;
      if (a.started) {
        v.iv.outcome = "interrupted";
        $("speech").classList.add("is-old");
        $("speechFeedback").hidden = true;
        flashStatus("お話を優先しました");
      } else {
        holdToScreen(v, a.why);
      }
      updateCounts();
      break;
    case "done":
      finishVoice();
      if (state.isRecording) setForecast("watch");
      askFeedback(a.uttId);
      break;
  }
}

// ミナトが実際に口にする全文（自分の声の照合に使う）
const spokenText = (result) => `${result.cushion_phrase || ""}${result.reframed_speech || ""}`;
const sendableContext = (lines) => lines.filter((c) => !state.noSend.has(c));

async function runSpeculation(text) {
  const who = state.speakerMode !== "auto" ? state.speakerMode : state.liveSpeaker;
  if (who !== "boss" || state.demo) return;
  let res;
  try {
    res = await postJSON("/analyze", {
      transcript: text,
      context: sendableContext(state.context.slice(-6)),
      speaker: "boss",
      speaker_source: state.speakerMode === "auto" ? "auto" : "manual",
      speculative: true,
    });
  } catch (e) {
    return;
  }
  if (res.sent_data && res.sent_data.external_sent) $("dataPreview").textContent = JSON.stringify(res.sent_data, null, 2);
  if (res.should_intervene && state.isRecording) {
    Voice.preload(Turn.splitSentences(res.reframed_speech), "mofu");
    feedTurn({ type: "verdict", spec: true, uttId: 0, prio: res.risk_level, text, speech: spokenText(res), category: res.category_id });
  }
}

function showBossHint(title, result) {
  const parts = [result.boss_tip];
  if (showProfile() && result.meta_note) parts.push(result.meta_note);
  showHint("boss", title, parts.filter(Boolean).join(" "), showProfile() && result.reason ? "判定：" + result.reason : "");
}

// 声を出さなかった回：言うつもりだった一言と提案を画面に残す
function holdToScreen(v, why) {
  v.iv.outcome = why === "moved_on" || why === "stale" || why === "before_play" ? "yielded" : "screen";
  v.iv.holdReason = why;
  const reason = HOLD_REASON[why] || "";
  showHint("boss", `💡 今は控えました${reason ? "（" + reason + "）" : ""}`,
    [`言うつもりだった一言：「${v.result.reframed_speech || ""}」`, v.result.boss_tip].filter(Boolean).join(" "),
    showProfile() && v.result.reason ? "判定：" + v.result.reason : "");
  flashStatus("今は控えました");
  updateCounts();
}

let oldSpeechTimer = null;
function showSpeechBubble(result) {
  clearTimeout(oldSpeechTimer);
  $("speechCushion").textContent = result.cushion_phrase || "";
  $("speechText").textContent = result.reframed_speech || "";
  $("speechFeedback").hidden = true;
  const speech = $("speech");
  speech.hidden = false;
  speech.classList.remove("is-old");
  speech.style.animation = "none";
  void speech.offsetWidth;
  speech.style.animation = "";
  $("stageCaption").textContent = "";
}

async function startVoice(a, v) {
  if (!v) { feedTurn({ type: "playFail", speakId: a.speakId }); return; }
  const { result, iv } = v;
  state.activeSpeak = { speakId: a.speakId, uttId: a.uttId };
  state.isSpeaking = true;
  chars.meeting.setState("speaking");
  setStatus("speaking", `${charName()}が話しています`);
  logTurn(a, { type: "speak_gap", gap_ms: state.lastVoiceAt ? Math.round(a.t - state.lastVoiceAt) : null });
  const parts = [result.cushion_phrase, ...Turn.splitSentences(result.reframed_speech)];
  const status = await Voice.speakParts(parts, "mofu", (kind) => {
    if (!state.activeSpeak || state.activeSpeak.speakId !== a.speakId) return;
    Mic.mute(true);
    iv.outcome = "voice";
    updateCounts();
    showSpeechBubble(result);
    addMofuLine(`${result.cushion_phrase || ""}${result.reframed_speech || ""}`);
    showBossHint("💡 上司向けヒント", result);
    people.boss.setMood("listening");
    feedTurn({ type: "playStart", speakId: a.speakId, levelOk: kind === "vv" });
  });
  if (!state.activeSpeak || state.activeSpeak.speakId !== a.speakId || status === "cancelled") return;
  if (status === "done") {
    feedTurn({ type: "playEnd", speakId: a.speakId });
  } else {
    feedTurn({ type: "playFail", speakId: a.speakId });
    finishVoice();
  }
}

function finishVoice() {
  if (!state.activeSpeak) return;
  state.activeSpeak = null;
  state.isSpeaking = false;
  people.boss.setMood("calm");
  if (!state.demo) Mic.mute(false);
  state.lastFinalT = performance.now();
  backToListening();
  oldSpeechTimer = setTimeout(() => $("speech").classList.add("is-old"), 15000);
}

let feedbackTimer = null;
function askFeedback(uttId) {
  if (state.demo) return;
  const box = $("speechFeedback");
  box.dataset.utt = uttId;
  box.hidden = false;
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => { box.hidden = true; }, 8000);
}

function giveFeedback(kind) {
  const box = $("speechFeedback");
  box.hidden = true;
  clearTimeout(feedbackTimer);
  state.turnLog.push({ ms: Math.round(performance.now() - state.turnT0), type: "feedback", value: kind, uttId: Number(box.dataset.utt) });
  if (kind === "bad" && ++state.notNeeded >= 2) {
    feedTurn({ type: "mode", voiceOff: true });
    toast("ここからは声を控えて、画面だけでお伝えします");
  }
}

// デモでは、ミナトの判断と発話が終わるのを待ってから次の行へ進む
async function turnSettled(maxMs = 15000) {
  const t0 = performance.now();
  while (state.turn && !state.turn.idle && state.demo && !state.demo.abort && performance.now() - t0 < maxMs) await sleep(80);
}

// 確定した発言が誰のものかを決める
function assignSpeaker(tFinal) {
  const t1 = tFinal - 150;
  const t0 = state.lastFinalT;
  state.lastFinalT = t1;
  if (state.speakerMode !== "auto") return { speaker: state.speakerMode, source: "manual", confidence: null, unsure: false };
  const frames = Mic.framesBetween(t0, t1);
  const r = frames.length >= 6 ? VoicePrint.classify(VoicePrint.makePrint(frames), state.voices) : null;
  if (!r) return { speaker: "boss", source: "auto", confidence: null, unsure: true };
  // 自信がない時は「上司」として扱う（言い換えの取りこぼしを避ける）。? を付けて直しやすくする
  const unsure = r.confidence < VoicePrint.LOW_CONFIDENCE;
  return { speaker: unsure ? "boss" : r.speaker, source: "auto", confidence: r.confidence, unsure };
}

const bubbleTimers = {};
function showSeatBubble(role, text, interim = false) {
  const seat = $(role === "boss" ? "seatBoss" : "seatSub");
  const bubble = seat.querySelector(".seat-bubble");
  const shown = text.length > 64 ? text.slice(0, 63) + "…" : text;
  bubble.querySelector(".sb-text").textContent = interim ? shown + "…" : shown;
  bubble.hidden = false;
  bubble.classList.toggle("is-interim", interim);
  bubble.classList.remove("is-old");
  if (!interim) {
    bubble.style.animation = "none";
    void bubble.offsetWidth;
    bubble.style.animation = "";
  }
  clearTimeout(bubbleTimers[role]);
  bubbleTimers[role] = setTimeout(() => bubble.classList.add("is-old"), interim ? 4000 : 9000);
}

// 受け止め予報（分析した特性から予想した反応。実際の気持ちを測ったものではない）
function setForecast(level, label) {
  const type = state.profile ? state.profile.primary : "perfectionist";
  const text = label || {
    calm: "おだやか",
    mild: "少し身構えそう",
    tense: TYPE_META[type].tense,
    watch: "様子を見ています",
  }[level] || "おだやか";
  $("forecast").dataset.level = level;
  $("forecastText").textContent = text;
  const mood = { calm: "calm", watch: "calm", mild: "uneasy", tense: "tense", signal: "tense" }[level] || "calm";
  people.subordinate.setMood(mood);
}

// ---- 会話ログ ----
function clearEmpty() {
  const empty = $("transcript").querySelector(".empty");
  if (empty) empty.remove();
}

function appendLine(line) {
  const list = $("transcript");
  clearEmpty();
  list.appendChild(line);
  list.scrollTop = list.scrollHeight;
  return line;
}

function addSystemLine(text) {
  return appendLine(el("div", "line is-system", text));
}

function addMofuLine(text) {
  const line = el("div", "line is-mofu");
  const head = el("div", "line-head");
  head.append(el("span", "who who-mofu", charName()), el("time", "", nowTime()));
  line.append(head, el("span", "line-text", text));
  return appendLine(line);
}

function renderWho(entry) {
  const who = entry.el.querySelector(".who");
  who.textContent = WHO[entry.speaker];
  if (entry.unsure) who.appendChild(el("span", "conf", "?"));
  const conf = entry.confidence != null ? `（声の判定 ${Math.round(entry.confidence * 100)}%）` : "";
  who.title = `${WHO[entry.speaker]}${conf}・クリックで${entry.speaker === "boss" ? "部下" : "上司"}に直す`;
  who.setAttribute("aria-label", `話者：${WHO[entry.speaker]}。クリックで${entry.speaker === "boss" ? "部下" : "上司"}に直す`);
  entry.el.dataset.speaker = entry.speaker;
}

function addSpeakerLine(entry) {
  const line = el("div", "line is-person");
  const head = el("div", "line-head");
  const who = el("button", "who");
  who.type = "button";
  who.addEventListener("click", () => toggleLineSpeaker(entry));
  const src = { auto: "声で判定", manual: "手動", demo: "デモ", text: "テキスト", zoom: "Zoom" }[entry.source] || "";
  head.append(who, el("time", "", nowTime()), el("span", "src", src));
  line.append(head, el("span", "line-text", entry.text));
  entry.el = line;
  renderWho(entry);
  return appendLine(line);
}

async function handleUtterance(text, meta = {}) {
  const m = state.meeting;
  if (!m || !state.isRecording) return;
  const uttId = ++lineSeq;
  const speakerForTurn = meta.speaker || "boss";
  // ミナト自身の声を認識したものは、発言として扱わない
  if (feedTurn({ type: "final", uttId, text, who: speakerForTurn, at: meta.at }).some((a) => a.type === "dropEcho")) {
    if (state.meter && meta.mid) state.meter.discard(meta.mid);
    return;
  }
  if (state.meter && meta.mid) state.meter.bind(uttId, meta.mid);
  const entry = {
    id: uttId,
    text,
    speaker: meta.speaker || "boss",
    source: meta.source || "manual",
    confidence: meta.confidence != null ? meta.confidence : null,
    unsure: !!meta.unsure,
    mid: meta.mid || 0,        // 音声計測のID（マイクで拾った発言だけ）
    analyzedAsBoss: false,
    epoch: state.epoch,
    time: nowTime(),
  };
  m.lines.push(entry);
  m.utterances[entry.speaker]++;
  m.chars[entry.speaker] += text.length;
  if (entry.source === "auto") m.autoCount++;
  addSpeakerLine(entry);
  showSeatBubble(entry.speaker, text);
  $("stageCaption").textContent = "";
  updateCounts();

  const ctx = state.context.slice(-6);
  const contextLine = `${WHO[entry.speaker]}: ${text}`;
  if (entry.unsure || entry.source === "demo") state.noSend.add(contextLine);
  state.context.push(contextLine);
  if (state.context.length > 8) state.context.shift();
  await analyzeEntry(entry, ctx, true);
}

async function analyzeEntry(entry, ctx, live) {
  const m = state.meeting;
  const isBoss = entry.speaker === "boss";
  const thinkingTimer = isBoss ? setTimeout(() => {
    if (!state.isSpeaking) {
      chars.meeting.setState("thinking");
      setStatus("thinking", "考え中");
    }
  }, 350) : null;

  let result;
  const judgeT0 = performance.now();
  try {
    result = await postJSON("/analyze", {
      transcript: entry.text,
      context: sendableContext(ctx),
      speaker: entry.speaker,
      speaker_source: entry.source,
      speaker_confidence: entry.confidence,
      speaker_unsure: entry.unsure,
      reanalysis: !live,
    });
  } catch (e) {
    console.error(e);
    clearTimeout(thinkingTimer);
    backToListening();
    toast("判定に失敗しました。サーバーの状態を確認してください。");
    return;
  }
  clearTimeout(thinkingTimer);
  if (!state.isRecording) return;
  if (live && isBoss && state.meter && entry.mid) state.meter.judged(entry.mid, performance.now() - judgeT0);

  if (result.sent_data) $("dataPreview").textContent = JSON.stringify(result.sent_data, null, 2);
  if (showProfile()) entry.el.title = result.reason || "";

  if (!isBoss) {
    const sig = result.subordinate_signal;
    if (sig) {
      entry.el.classList.add("is-signal");
      entry.el.appendChild(el("span", "tag tag-signal", "💭 " + sig.label));
      m.signals.push({ time: entry.time, transcript: entry.text, label: sig.label, hint: sig.hint });
      setForecast("signal", sig.forecast);
      showHint("sub", "💭 部下さんのサイン", sig.hint, "部下の発言から：" + sig.label);
    } else {
      if ($("forecast").dataset.level !== "calm") people.subordinate.flash("relieved", 2200);
      setForecast("calm");
    }
    backToListening();
    return;
  }

  entry.analyzedAsBoss = true;
  $("mtEngine").textContent = result.demo_mode ? "ローカル判定" : "Claude判定";

  if (result.should_intervene) {
    entry.el.classList.add("is-flagged");
    entry.el.appendChild(el("span", "tag", (live ? "⚠ " : "⚠ あとから判定：") + (result.detected_category || "要配慮")));
    const iv = {
      time: entry.time,
      transcript: entry.text,
      cushion: result.cushion_phrase || "",
      speech: result.reframed_speech || "",
      tip: result.boss_tip || "",
      meta: result.meta_note || "",
      category: result.detected_category || "その他",
      late: !live,
      outcome: "pending",
    };
    m.interventions.push(iv);
    updateCounts();
    setForecast("tense");
    if (live && entry.epoch !== state.epoch) {
      iv.outcome = "screen"; // デモ開始前の発言の判定が、デモ中に届いた場合は声にしない
    } else if (live) {
      state.verdicts.set(entry.id, { entry, result, iv });
      if (!entry.unsure) Voice.preload(Turn.splitSentences(result.reframed_speech), "mofu");
      // 話者に自信がない発言は、部下の発言かもしれないので声にしない
      const prio = entry.unsure ? "low" : result.risk_level;
      const acts = feedTurn({ type: "verdict", uttId: entry.id, prio, text: entry.text, speech: spokenText(result), category: result.category_id });
      if (entry.unsure && acts.some((a) => a.type === "hint")) holdToScreen(state.verdicts.get(entry.id), "unsure");
    } else {
      // 話者をあとから直した場合は、会話を遮らないよう画面だけで知らせる
      iv.outcome = "screen";
      showBossHint("💡 上司向けヒント（あとから判定）", result);
    }
  } else {
    if (live && entry.epoch === state.epoch) feedTurn({ type: "verdict", uttId: entry.id, prio: "none", text: entry.text });
    const score = result.attack_score || 0;
    const risk = result.risk_level || "none";
    setForecast(score >= 4 || risk === "low" || risk === "medium" ? "mild" : "calm");
    if (state.turn && state.turn.idle) backToListening();
  }
}

function showHint(kind, title, text, reason) {
  $("hintCard").dataset.kind = kind;
  $("hintTitle").textContent = title;
  $("hintText").textContent = text || "";
  $("hintReason").textContent = reason || "";
  $("hintCard").hidden = !text;
  const card = $("hintCard");
  card.style.animation = "none";
  void card.offsetWidth;
  card.style.animation = "";
}

function backToListening() {
  if (state.isSpeaking) return;
  if (state.turn && state.turn.state === "RAISED") return;
  if (state.isRecording) {
    chars.meeting.setState("listening");
    if (state.demo) setStatus("speaking", "デモ会話を再生中");
    else if (state.inputSource === "zoom") setStatus("listening", "Zoomの会話を受信中");
    else if (state.micBlocked) setStatus("error", "マイク未許可（テキスト入力のみ）");
    else setStatus("listening", "聞いています");
  } else {
    chars.meeting.setState("idle");
  }
}

// 話者をあとから直す（自動判定の間違いを1クリックで回復）
function toggleLineSpeaker(entry) {
  const m = state.meeting;
  if (!m || !state.isRecording) { toast("面談中だけ直せます"); return; }
  const from = entry.speaker;
  const to = from === "boss" ? "subordinate" : "boss";
  entry.speaker = to;
  entry.unsure = false;
  // 話者の間違いが分かった発言には、声を出さない
  if (to === "subordinate" && state.turn && !state.turn.idle) feedTurn({ type: "cancel", why: "corrected" });
  m.utterances[from]--;
  m.utterances[to]++;
  m.chars[from] -= entry.text.length;
  m.chars[to] += entry.text.length;
  m.corrections++;
  renderWho(entry);
  updateCounts();
  const old = `${WHO[from]}: ${entry.text}`;
  const i = state.context.lastIndexOf(old);
  if (i >= 0) state.context[i] = `${WHO[to]}: ${entry.text}`;
  if (entry.source === "demo") state.noSend.add(`${WHO[to]}: ${entry.text}`); // デモの発言は、札を直しても外部へ送らない
  postJSON("/speaker-correction", { transcript: entry.text, from_speaker: from, to_speaker: to, confidence: entry.confidence }).catch(() => {});
  toast(`「${WHO[to]}」の発言に直しました`);
  if (to === "boss" && !entry.analyzedAsBoss) analyzeEntry(entry, state.context.slice(-7, -1), false);
}

// ---- デモ会話 ----
function updateDemoButton() {
  const b = $("btnDemo");
  b.textContent = state.demo ? "■ デモを止める" : "▶ デモ会話を再生";
  b.classList.toggle("is-playing", !!state.demo);
}

async function toggleDemo() {
  if (state.demo) {
    state.demo.abort = true;
    state.epoch++;
    feedTurn({ type: "cancel", why: "demo_stop" });
    Voice.cancel();
    return;
  }
  if (!state.isRecording) return;
  if (state.isSpeaking) { toast(`${charName()}が話し終わってから再生してください`); return; }
  state.epoch++;
  feedTurn({ type: "cancel", why: "demo_start" });
  // デモはマイクを使わず、毎回同じ流れで再生する
  feedTurn({ type: "mode", pace: "check", textOnly: true });
  state.demo = { abort: false };
  updateDemoButton();
  stopRecognition();
  Mic.mute(true);
  setSeatActive(null);
  addSystemLine("デモ会話を再生します（上司・部下の声は合成音声です）");
  setStatus("speaking", "デモ会話を再生中");

  for (const line of DEMO_SCRIPT) {
    if (!state.demo || state.demo.abort || !state.isRecording) break;
    showSeatBubble(line.who, line.text);
    await speakAs(line.who, line.text);
    if (!state.demo || state.demo.abort || !state.isRecording) break;
    await handleUtterance(line.text, { speaker: line.who, source: "demo" });
    await sleep(300);
    await turnSettled();
    await sleep(350);
  }

  const aborted = state.demo && state.demo.abort;
  state.demo = null;
  feedTurn({ type: "mode", pace: paceKey(), textOnly: state.inputSource === "zoom" });
  Mic.mute(false);
  updateDemoButton();
  if (!state.isRecording) return;
  addSystemLine(aborted ? "デモ会話を止めました" : "デモ会話が終わりました");
  state.lastFinalT = performance.now();
  backToListening();
  $("stageCaption").textContent = captionIdle();
  startRecognition();
}

// ---------- Zoom連携：サーバーから話者名つきの発言を受け取る ----------
function openZoomFeed() {
  closeZoomFeed();
  const feed = new EventSource("/events");
  state.zoomFeed = feed;
  feed.onopen = () => { if (!state.isSpeaking && !state.demo) setStatus("listening", "Zoomの会話を受信中"); };
  feed.onerror = () => { if (!state.isSpeaking) setStatus("error", "Zoom連携の接続が切れました（再接続中）"); };
  feed.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch (err) { return; }
    if (ev.type === "zoom") {
      addSystemLine(ev.state === "started" ? "Zoomからの受信を開始しました" : "Zoomからの受信が終わりました");
      return;
    }
    if (ev.type === "activity") {
      if (state.isRecording && !state.demo) feedTurn({ type: "activity", who: ev.speaker || null, chars: ev.chars, at: ev.at });
      return;
    }
    if (ev.type !== "utterance" || !state.isRecording || state.demo) return;
    // ミナトが話している間に届いた発言も取りこぼさないよう、順番に処理する
    state.zoomQueue = state.zoomQueue.then(() => receiveZoomUtterance(ev)).catch((err) => console.error(err));
  };
}

function closeZoomFeed() {
  if (state.zoomFeed) state.zoomFeed.close();
  state.zoomFeed = null;
}

async function receiveZoomUtterance(ev) {
  if (!state.isRecording) return;
  const known = ev.speaker === "boss" || ev.speaker === "subordinate";
  if (!known) toast(`Zoomの表示名「${ev.user_name}」が未登録です。上司として扱います（名札クリックで直せます）`);
  const speaker = known ? ev.speaker : "boss";
  const seat = $(speaker === "boss" ? "seatBoss" : "seatSub");
  seat.classList.add("is-voiced");
  setTimeout(() => seat.classList.remove("is-voiced"), 1400);
  await handleUtterance(ev.text, { speaker, source: "zoom", confidence: known ? 1 : null, unsure: !known, at: ev.at });
}

// ---------- 音声認識（インスタンスを使い回して安定化） ----------
function initRecognition() {
  const r = new webkitSpeechRecognition();
  r.lang = "ja-JP";
  r.continuous = true;
  r.interimResults = true;

  r.onresult = (event) => {
    if (state.demo || state.recPaused) return;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      const text = res[0].transcript.trim();
      if (!text) continue;
      if (res.isFinal) {
        const meta = assignSpeaker(performance.now());
        if (state.meter) meta.mid = state.meter.final(performance.now(), text.length);
        handleUtterance(text, meta);
      } else {
        if (state.meter) state.meter.interim(performance.now());
        // ミナトの発話中も聞き続ける（人が話し始めたら譲るため）
        const echo = feedTurn({ type: "interim", text }).some((a) => a.type === "dropEcho");
        if (echo || state.isSpeaking) continue;
        const who = state.liveSpeaker || (state.speakerMode !== "auto" ? state.speakerMode : null);
        if (who) showSeatBubble(who, text, true);
        else $("stageCaption").textContent = text + "…";
      }
    }
  };

  r.onerror = (event) => {
    if (event.error === "no-speech" || event.error === "aborted") return;
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      state.micBlocked = true;
      setStatus("error", "マイク未許可（テキスト入力のみ）");
      toast("マイクの使用が許可されていません。アドレスバー左のアイコンから許可してください。");
      return;
    }
    console.error("[認識] エラー:", event.error);
  };

  r.onend = () => {
    if (state.isRecording && !state.recPaused && !state.micBlocked && !state.demo) {
      setTimeout(startRecognition, 300);
    }
  };
  return r;
}

function startRecognition() {
  if (!state.isRecording || state.micBlocked || state.demo || state.recPaused || state.inputSource === "zoom" || !("webkitSpeechRecognition" in window)) return;
  if (!state.recognition) state.recognition = initRecognition();
  try {
    state.recognition.start();
  } catch (e) {
    if (!(e.message || "").includes("already started")) {
      console.error("[認識] 開始失敗:", e);
      state.recognition = null;
      setTimeout(startRecognition, 600);
    }
  }
}

function stopRecognition() {
  if (state.recognition) {
    try { state.recognition.stop(); } catch (e) { /* 停止済み */ }
  }
}

// ---------- 挨拶とデモの再生（面談中の介入は startVoice が担当） ----------
async function speakAs(role, text) {
  text = (text || "").trim();
  if (!text) return;
  state.isSpeaking = true;
  state.recPaused = true;
  stopRecognition();
  Mic.mute(true);
  setSeatActive(null);
  if (role === "mofu") chars.meeting.setState("speaking");
  else {
    people[role].setSpeaking(true);
    $(role === "boss" ? "seatBoss" : "seatSub").classList.add("is-voiced");
  }
  setStatus("speaking", `${roleName(role)}が話しています`);
  try {
    await Voice.speak(text, role);
  } finally {
    if (role === "mofu") chars.meeting.setState("idle");
    else {
      people[role].setSpeaking(false);
      $(role === "boss" ? "seatBoss" : "seatSub").classList.remove("is-voiced");
    }
    state.isSpeaking = false;
    state.recPaused = false;
    if (!state.demo) {
      Mic.mute(false);
      state.lastFinalT = performance.now();
      backToListening();
      if (state.isRecording) setTimeout(startRecognition, 300);
    }
  }
}

function updateVoiceCredit() {
  const credits = Voice.credits();
  $("voiceCredit").textContent = credits.length ? "音声：" + credits.join("、") : "";
}

// ---------- ⑥ ふりかえり ----------
function renderSummary() {
  const m = state.meeting;
  const count = voicedCount(m);

  $("smSubtitle").textContent = `${showProfile() ? state.profile.label + "の部下との面談 ・ " : ""}感度「${SENSITIVITY_LABEL[state.sensitivity]}」`;
  $("smDuration").textContent = formatDuration((m.endedAt || Date.now()) - m.startedAt);
  $("smBoss").textContent = m.utterances.boss;
  $("smSub").textContent = m.utterances.subordinate;
  $("smInterv").textContent = count;

  const total = m.chars.boss + m.chars.subordinate;
  const bossPct = total ? Math.round((m.chars.boss / total) * 100) : 0;
  const subPct = total ? 100 - bossPct : 0;
  $("smRatioBoss").style.width = (total ? bossPct : 50) + "%";
  $("smRatioSub").style.width = (total ? subPct : 50) + "%";
  $("smRatio").classList.toggle("is-empty", !total);
  $("smRatioBossVal").textContent = bossPct + "%";
  $("smRatioSubVal").textContent = subPct + "%";
  $("smRatioNote").textContent = !total
    ? "発言の記録がありませんでした。"
    : subPct >= 50
      ? "部下さんがたくさん話せていました。1on1では、部下が話す時間が長いほど本音が出やすいと言われます。"
      : "上司の発言が多めでした。次回は問いかけを増やして、部下さんが話す時間をつくってみましょう。";
  $("smAuto").textContent = m.autoCount
    ? `声で自動判定した発言 ${m.autoCount}件 ・ 手で直した発言 ${m.corrections}件`
    : m.corrections ? `手で直した発言 ${m.corrections}件` : "";

  const byOutcome = (keys) => m.interventions.filter((iv) => keys.includes(iv.outcome)).length;
  $("smOutcomes").textContent = m.interventions.length
    ? `声で伝えた ${byOutcome(["voice"])}回 ・ 途中で譲った ${byOutcome(["interrupted"])}回 ・ 会話を優先 ${byOutcome(["yielded"])}回 ・ 画面のみ ${byOutcome(["screen", "pending"])}回`
    : "";

  const tally = {};
  m.interventions.forEach((iv) => (tally[iv.category] = (tally[iv.category] || 0) + 1));
  const cats = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const catWrap = $("smCategories");
  catWrap.replaceChildren();
  if (!cats.length) {
    catWrap.appendChild(el("p", "empty-note", "今回は、萎縮につながりそうな言い方は検出されませんでした。おだやかな面談でしたね！"));
  } else {
    const max = cats[0][1];
    cats.forEach(([name, n]) => {
      const row = el("div", "cat-row");
      const track = el("div", "track");
      const fill = el("div", "fill");
      fill.style.width = (n / max) * 100 + "%";
      track.appendChild(fill);
      row.append(el("span", "", name), track, el("span", "val", n + "回"));
      catWrap.appendChild(row);
    });
  }

  const list = $("smList");
  list.replaceChildren();
  const items = [
    ...m.interventions.map((iv) => ({ kind: "interv", ...iv })),
    ...m.signals.map((s) => ({ kind: "signal", ...s })),
  ].sort((a, b) => a.time.localeCompare(b.time));
  if (!items.length) list.appendChild(el("li", "empty-note", "介入も、部下のサインもありませんでした"));
  items.forEach((it) => {
    const li = el("li", it.kind === "signal" ? "is-signal" : "");
    if (it.kind === "signal") {
      li.append(el("div", "iv-time", `${it.time} ・ 部下のサイン：${it.label}`), el("p", "iv-sub", it.transcript), el("p", "iv-meta", "💡 " + it.hint));
    } else {
      li.append(el("div", "iv-time", `${it.time} ・ ${it.category} ・ ${OUTCOME_LABEL[it.outcome] || ""}${it.late ? "（あとから判定）" : ""}`), el("p", "iv-boss", it.transcript));
      const mofu = el("p", "iv-mofu", it.speech);
      mofu.dataset.name = charName() + "：";
      li.appendChild(mofu);
      if (it.tip) li.appendChild(el("p", "iv-meta", "💡 " + it.tip));
      if (showProfile() && it.meta) li.appendChild(el("p", "iv-meta", it.meta));
    }
    list.appendChild(li);
  });

  renderMetrics();
  $("smFile").textContent = m.logFile ? "検証ログを保存しました：" + m.logFile : "";
}

// 音声の計測（マイクで拾った発言だけが対象。デモ・テキスト入力・Zoomは含まない）
function renderMetrics() {
  const box = $("smMetrics");
  box.replaceChildren();
  const records = state.meter ? state.meter.records() : [];
  if (!records.length) {
    box.appendChild(el("p", "empty-note", "マイクで拾った発言がなかったため、計測値はありません。"));
    return;
  }
  const s = Metrics.summarizeMeeting(records);
  const rows = [
    ["話し終わり → 確定文", s.final],
    ["話し始め → 最初の途中文", s.firstInterim],
    ["確定文 → 判定の完了", s.judge],
    ["話し終わり → ミナトが話し出す", s.speak],
  ];
  const table = el("table", "metric-table");
  const head = el("tr");
  ["項目", "件数", "中央値", "90%点", "最大"].forEach((h) => head.appendChild(el("th", "", h)));
  table.appendChild(head);
  rows.forEach(([label, v]) => {
    const tr = el("tr");
    tr.appendChild(el("td", "", label));
    [v && v.n, v && v.median, v && v.p90, v && v.max].forEach((x, i) => {
      tr.appendChild(el("td", "num", x == null ? "—" : i === 0 ? `${x}件` : `${x}ms`));
    });
    table.appendChild(tr);
  });
  box.appendChild(table);
  box.appendChild(el("p", "muted metric-note",
    `発話の途中で確定した発言：${s.cut}/${s.utterances}件。` +
    "「話し終わり」は、声の検知で最後に声が出た時刻です。ミナトが話し出すまでの時間は、声を出した回だけが対象です。件数が少ないうちは傾向の確認にとどまります。"));
}

// ---------- 設定ドロワー ----------
const VOICE_SELECTS = { mofu: "voiceMofu", boss: "voiceBoss", subordinate: "voiceSub" };

async function openDrawer() {
  const persona = state.config.character_persona || {};
  $("setName").value = persona.name || "";
  $("setPosition").value = persona.position || "";
  $("setTone").value = persona.tone || "";
  $("setEngineUrl").value = (state.config.voice && state.config.voice.engine_url) || "";
  const zc = state.config.zoom || {};
  $("setPace").value = paceKey();
  $("setUseClaude").checked = !!(state.config.judge && state.config.judge.use_claude);
  $("setShowProfile").checked = showProfile();
  $("setLogRaw").checked = !!privacy().log_raw;
  $("zoomEnabled").checked = !!zc.enabled;
  $("zoomBoss").value = zc.boss_name || "";
  $("zoomSub").value = zc.subordinate_name || "";
  $("zoomIgnore").value = zc.ignore_names || "";
  renderZoomStatus();
  const list = $("maskList");
  list.replaceChildren();
  Object.entries(state.config.name_masks || {}).forEach(([real, alias]) => addMaskRow(real, alias));
  $("drawer").hidden = false;
  $("drawerBackdrop").hidden = false;
  $("setName").focus();
  renderVoiceSelects();
  await Voice.refresh();
  renderVoiceSelects();
}

async function renderZoomStatus() {
  const box = $("zoomStatus");
  try {
    const z = await getJSON("/zoom/status");
    const ready = z.rtms_sdk_installed && z.webhook_secret_set && z.client_set;
    box.dataset.ok = String(ready);
    const missing = [];
    if (!z.rtms_sdk_installed) missing.push("rtms SDK（pip install rtms）");
    if (!z.client_set) missing.push("ZM_RTMS_CLIENT / ZM_RTMS_SECRET");
    if (!z.webhook_secret_set) missing.push("ZOOM_WEBHOOK_SECRET_TOKEN");
    box.textContent = ready
      ? `Zoomの受信準備ができています（受信中の会議 ${z.active_streams}件）`
      : "未設定：" + missing.join("、") + "（模擬データでの確認はできます）";
  } catch (e) {
    box.textContent = "Zoom連携の状態を取得できませんでした";
  }
}

function renderVoiceSelects() {
  const eng = Voice.engine();
  const status = $("engineStatus");
  status.dataset.ok = String(!!eng.available);
  status.textContent = eng.available
    ? `VOICEVOX系エンジンに接続しています（${eng.engine_url}）`
    : "VOICEVOXは起動していません。このPCの声で話します";
  const resolved = Voice.resolveAll();
  const roles = (state.config.voice && state.config.voice.roles) || {};
  Object.entries(VOICE_SELECTS).forEach(([role, id]) => {
    const sel = $(id);
    const current = (roles[role] && roles[role].choice) || "";
    sel.replaceChildren();
    const auto = el("option", "", `おまかせ（いま：${resolved[role].kind === "vv" ? "VOICEVOX " : ""}${resolved[role].label}）`);
    auto.value = "";
    sel.appendChild(auto);
    if (eng.available) {
      const g = el("optgroup");
      g.label = "VOICEVOX";
      Voice.vvStyles().forEach((s) => {
        const o = el("option", "", s.label);
        o.value = "vv:" + s.id;
        g.appendChild(o);
      });
      sel.appendChild(g);
    }
    const bv = Voice.browserVoices();
    if (bv.length) {
      const g = el("optgroup");
      g.label = "このPCの声";
      bv.forEach((v) => {
        const o = el("option", "", v.name);
        o.value = "br:" + v.name;
        g.appendChild(o);
      });
      sel.appendChild(g);
    }
    sel.value = current;
    if (sel.value !== current) sel.value = "";
  });
}

function voiceChoicesFromForm() {
  const roles = {};
  Object.entries(VOICE_SELECTS).forEach(([role, id]) => (roles[role] = { choice: $(id).value }));
  return roles;
}

async function previewVoice(role) {
  if (state.isRecording) { toast("面談中は試聴できません"); return; }
  Voice.setConfig({ roles: voiceChoicesFromForm() });
  const sample = {
    mofu: `${$("setName").value.trim() || charName()}です。今日はそっと見守りますね。`,
    boss: "先週お願いした資料、進捗どうなってる？",
    subordinate: "はい、いま半分くらいまで進んでいます。",
  }[role];
  Voice.cancel();
  await Voice.speak(sample, role);
  Voice.setConfig(state.config.voice);
}

function closeDrawer() {
  $("drawer").hidden = true;
  $("drawerBackdrop").hidden = true;
  Voice.setConfig(state.config.voice);
}

function addMaskRow(real = "", alias = "") {
  const row = el("div", "mask-row");
  const a = el("input");
  a.placeholder = "実名（例：田中）";
  a.value = real;
  a.className = "mask-real";
  const b = el("input");
  b.placeholder = "置き換え（例：Aさん）";
  b.value = alias;
  b.className = "mask-alias";
  const rm = el("button", "remove", "✕");
  rm.type = "button";
  rm.setAttribute("aria-label", "削除");
  rm.addEventListener("click", () => row.remove());
  row.append(a, el("span", "arrow", "→"), b, rm);
  $("maskList").appendChild(row);
}

async function saveSettings() {
  const persona = state.config.character_persona;
  persona.name = $("setName").value.trim() || "ミナト";
  persona.position = $("setPosition").value.trim();
  persona.tone = $("setTone").value.trim();
  const masks = {};
  document.querySelectorAll(".mask-row").forEach((row) => {
    const real = row.querySelector(".mask-real").value.trim();
    const alias = row.querySelector(".mask-alias").value.trim();
    if (real) masks[real] = alias || "匿名";
  });
  state.config.name_masks = masks;
  state.config.turn = { pace: $("setPace").value };
  state.config.judge = { use_claude: $("setUseClaude").checked };
  state.config.privacy = { show_profile: $("setShowProfile").checked, log_raw: $("setLogRaw").checked };
  if (state.isRecording) {
    feedTurn({ type: "mode", pace: state.demo ? "check" : paceKey() });
    $("mtType").hidden = !showProfile();
    $("forecast").hidden = !showProfile();
    if (!showProfile()) {
      // すでに画面に出ている判定理由と傾向の説明も消す
      state.meeting.lines.forEach((l) => { if (l.el) l.el.title = ""; });
      $("hintReason").textContent = "";
      $("hintCard").hidden = true;
    }
  }
  state.config.zoom = {
    enabled: $("zoomEnabled").checked,
    boss_name: $("zoomBoss").value.trim(),
    subordinate_name: $("zoomSub").value.trim(),
    ignore_names: $("zoomIgnore").value.trim(),
  };
  state.config.voice = {
    engine_url: $("setEngineUrl").value.trim() || "http://127.0.0.1:50021",
    roles: voiceChoicesFromForm(),
  };
  try {
    await postJSON("/config", state.config);
    Voice.setConfig(state.config.voice);
    await Voice.refresh();
    updateVoiceCredit();
    $("npMofu").textContent = charName();
    closeDrawer();
    toast("設定を保存しました");
  } catch (e) {
    console.error(e);
    toast("保存に失敗しました");
  }
}

// ---------- イベント ----------
$("btnBegin").addEventListener("click", startAnalysis);
$("btnQuick").addEventListener("click", () => {
  renderProfile(false);
  showScreen("profile");
});
$("brandHome").addEventListener("click", () => {
  if (state.isRecording) { toast("面談中です。終了してから戻ってください。"); return; }
  if (rec) finishRecord();
  stopTry();
  updateQuickStart();
  showScreen("start");
});
$("qPrev").addEventListener("click", () => {
  if (state.qIndex > 0) { state.qIndex--; renderQuestion(); }
});
$("btnShowPresets").addEventListener("click", showPresets);
$("btnBackToQuestions").addEventListener("click", () => {
  $("questionWrap").hidden = false;
  $("presetPicker").hidden = true;
});
document.querySelectorAll("#sensitivity button").forEach((b) =>
  b.addEventListener("click", () => { state.sensitivity = b.dataset.level; renderSensitivity(); })
);
$("btnReanalyze").addEventListener("click", startAnalysis);
$("btnToVoices").addEventListener("click", openVoices);
document.querySelectorAll(".enroll [data-action=record]").forEach((b) =>
  b.addEventListener("click", () => toggleRecord(b.closest(".enroll").dataset.role))
);
$("btnTry").addEventListener("click", toggleTry);
$("btnStartMeeting").addEventListener("click", startMeeting);
$("btnSkipVoices").addEventListener("click", () => {
  if (rec) finishRecord();
  if (hasVoices()) {
    state.voices = { boss: null, subordinate: null };
    state.separation = null;
  }
  startMeeting();
});
$("btnEndMeeting").addEventListener("click", endMeeting);
$("btnDemo").addEventListener("click", toggleDemo);
document.querySelectorAll("#speechFeedback button").forEach((b) =>
  b.addEventListener("click", () => giveFeedback(b.dataset.feedback))
);
document.querySelectorAll("#speakerMode button").forEach((b) =>
  b.addEventListener("click", () => setSpeakerMode(b.dataset.mode))
);
$("btnAgain").addEventListener("click", startMeeting);
$("btnHome").addEventListener("click", () => { updateQuickStart(); showScreen("start"); });

$("testWho").addEventListener("click", () => {
  state.testWho = state.testWho === "boss" ? "subordinate" : "boss";
  $("testWho").dataset.speaker = state.testWho;
  $("testWho").textContent = WHO[state.testWho];
});
$("testForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("testText");
  const text = input.value.trim();
  if (!text) return;
  if (state.isSpeaking || state.demo) { toast(`${charName()}が話し終わってから送信してください`); return; }
  input.value = "";
  handleUtterance(text, { speaker: state.testWho, source: "text" });
});

$("btnSettings").addEventListener("click", openDrawer);
$("btnCloseDrawer").addEventListener("click", closeDrawer);
$("drawerBackdrop").addEventListener("click", closeDrawer);
$("btnAddMask").addEventListener("click", () => addMaskRow());
$("btnSaveSettings").addEventListener("click", saveSettings);
document.querySelectorAll("[data-preview]").forEach((b) =>
  b.addEventListener("click", () => previewVoice(b.dataset.preview))
);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("drawer").hidden) closeDrawer();
  if (e.target.closest && e.target.closest("input, textarea, select")) return;
  const screen = $("app").dataset.screen;
  if (screen === "analyze" && !$("questionWrap").hidden && ["1", "2", "3", "4"].includes(e.key)) {
    chooseAnswer(Number(e.key) - 1);
  }
  if (screen === "meeting" && state.isRecording && $("drawer").hidden) {
    const mode = { 0: "auto", 1: "boss", 2: "subordinate" }[e.key];
    if (mode) setSpeakerMode(mode);
  }
});

window.addEventListener("beforeunload", (e) => {
  if (state.isRecording) e.preventDefault();
});

if (typeof speechSynthesis !== "undefined") {
  speechSynthesis.onvoiceschanged = () => {
    updateVoiceCredit();
    if (!$("drawer").hidden) renderVoiceSelects();
  };
}

init();
