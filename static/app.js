"use strict";

const $ = (id) => document.getElementById(id);

const TYPE_META = {
  perfectionist: { color: "var(--type-perfectionist)", desc: "失敗を自分の能力不足と捉えやすい", tense: "自分を責めそう" },
  logical: { color: "var(--type-logical)", desc: "根拠のない指摘や感情論が苦手", tense: "納得できていなさそう" },
  sensitive: { color: "var(--type-sensitive)", desc: "声のトーンや場の空気に敏感", tense: "固まってしまいそう" },
  independent: { color: "var(--type-independent)", desc: "細かい指示や口出しで、やる気が下がりやすい", tense: "やり方を否定されたと感じていそう" },
};
const TYPE_ORDER = ["perfectionist", "logical", "sensitive", "independent"];
const DIM_LABEL = { perfectionist: "自分を責める傾向", logical: "根拠・納得を求める傾向", sensitive: "口調や空気への敏感さ", independent: "自分で決めたい傾向" };
const SITUATION_LABEL = { progress: "進捗の確認", feedback: "指摘とフォロー", goal: "目標の設定", casual: "雑談・相談" };
const CONFIDENCE_LABEL = { high: "確かさ：高", medium: "確かさ：中", low: "確かさ：低（参考程度に）" };
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

// デモ会話（上司・部下・view viewの声を聞き分けられるように、それぞれ別の声で再生する）
const DEMO_SCRIPT = [
  { who: "boss", text: "先週お願いした資料、進捗どうなってる？" },
  { who: "subordinate", text: "すみません…私の段取りが悪くて、まだ半分くらいです" },
  { who: "boss", text: "なんでもっと早く相談しなかったの？" },
  { who: "subordinate", text: "経緯をお話しします。データの集計で迷っていて、どこまで調べればいいか分からなくなっていました" },
  { who: "boss", text: "なるほど。じゃあ次は、どの時点で声をかけるか一緒に決めようか" },
  { who: "subordinate", text: "はい。次は迷った日に相談します。水曜までに一度見てもらえますか" },
];

// 受け取り方の4つの型（main.py の RECEIVE_SKILLS と同じ）
const SKILLS = {
  separate: { label: "分ける", desc: "人ではなく、行動・仕事の話として受け取る" },
  extract: { label: "取り出す", desc: "言い方が強くても、直してほしい中身を拾う" },
  clarify: { label: "確かめる", desc: "分からない所は、どの部分か具体的に聞く" },
  explain: { label: "伝える", desc: "自分の事情や考えを、落ち着いて伝える" },
};
const SKILL_ORDER = ["separate", "extract", "clarify", "explain"];

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
  form: "inperson",        // inperson（対面・1台のマイク）/ online（このPCで会議に参加中）
  localRole: "boss",       // オンライン会議で、このPCのマイクで話す人
  diar: null,              // 声の登録なしの話者判定（static/diarize.js）
  remoteNoText: 0,         // 会議の音が鳴っているのに文字にならない時間（古いChromeの検出用）
  voiceOut: "local",       // local（このPCから話す）/ stage（view view用PCで会議に参加して話す）
  voiceOn: true,           // view viewが声で話すか（オフなら画面だけ）
  earphone: false,         // イヤホンをつけた（対面でスピーカーから声を出して上司に聞こえないよう、確認が取れた時だけ声を出す）
  situation: "progress",   // 面談の状況
  respondent: "self",      // 診断は部下本人が答える
  intent: { goals: [], takeaway: "", outcome: "" },  // 上司が事前に伝えたいこと（この面談の間だけ）
  goalsAuto: new Set(),    // 話題に出た目的（目安）
  goalsManual: new Map(),  // 上司がクリックで付け外しした目的
  receiveTipAt: {},        // 受け取り方のヒントを最後に出した時刻（種類ごと）
  receive: null,           // 受け取り方メーター（この面談で部下ができた型の回数）
  practice: null,          // 受け取り方の練習
  stageTip: true,          // view view用PCの画面に、上司への言い換えの提案も出す
  stageInfo: null,
  remoteWarned: false,
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
  return (state.config && state.config.character_persona && state.config.character_persona.name) || "view view";
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
    const audio = config.audio || {};
    state.form = audio.form === "online" ? "online" : "inperson";
    state.localRole = audio.local_role === "subordinate" ? "subordinate" : "boss";
    state.voiceOut = audio.voice_out === "stage" ? "stage" : "local";
    state.stageTip = audio.stage_tip !== false;
    state.voiceOn = audio.voice_on !== false;
    state.earphone = audio.earphone === true;
    state.situation = SITUATION_LABEL[audio.situation] ? audio.situation : "progress";
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

// ---------- ② 傾向診断（部下本人が答える） ----------
function startAnalysis() {
  state.answers = {};
  state.qIndex = 0;
  state.respondent = "self";
  $("questionWrap").hidden = false;
  $("presetPicker").hidden = true;
  $("analyzeBubble").textContent = "部下さんご本人が答えてください。ふだんの自分にいちばん近いものを選んでくださいね。正解はありません！";
  chars.analyze.setState("idle");
  renderQuestion();
  showScreen("analyze");
}

function renderQuestion() {
  const qs = state.questions;
  const q = qs[state.qIndex];
  $("qNum").textContent = "Q" + (state.qIndex + 1);
  $("qCount").textContent = `${state.qIndex + 1} / ${qs.length}`;
  $("qText").textContent = q.self;
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
      finishAnalysis({ answers: state.answers, respondent: state.respondent });
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
  $("pfEyebrow").textContent = p.scores ? "診断結果・近いタイプ（参考）" : "選んだタイプ";
  document.querySelector(".result-card").style.setProperty("--accent", TYPE_META[p.primary].color);
  $("pfSecondary").textContent = p.secondary_label
    ? `「${p.secondary_label}」の傾向もあわせ持っています`
    : p.scores ? "" : "タイプを直接選択しました";

  const bars = $("pfScores");
  bars.replaceChildren();
  // 詳しい点数は見せない（判定の中だけで使う）
  bars.hidden = true;

  const conf = p.confidence;
  $("pfConfidence").hidden = !conf;
  if (conf) {
    $("pfConfidence").dataset.level = conf.level;
    $("pfConfidence").textContent = [CONFIDENCE_LABEL[conf.level], ...conf.reasons,
      conf.mixed ? "上位の傾向が近いため、1つのタイプに決めつけず両方を参考にします" : ""].filter(Boolean).join("　");
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
  state.config.audio = Object.assign({}, state.config.audio, { form: state.form, local_role: state.localRole, voice_out: state.voiceOut, stage_tip: state.stageTip, voice_on: state.voiceOn, earphone: state.earphone, situation: state.situation });
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
  renderForm();
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
        ? "マイクの使用が許可されていません。アドレスバー左のアイコンから許可すると、声で上司・部下を見分けられます。"
        : "マイクを開けませんでした。接続を確認してください。";
    }
  }
  renderEnroll();
}

// 面談のかたち：対面（1台のマイク）か、このPCで参加しているオンライン会議か
const OTHER_ROLE = { boss: "subordinate", subordinate: "boss" };

// 面談の準備：状況・伝えたいこと・声の有無
function renderPrep() {
  document.querySelectorAll("#situation button").forEach((b) => {
    const on = b.dataset.situation === state.situation;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-checked", String(on));
  });
  document.querySelectorAll("#voiceOn button").forEach((b) => {
    const on = (b.dataset.voice === "on") === state.voiceOn;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-checked", String(on));
  });
  $("earphoneOk").checked = state.earphone;
  $("earphoneRow").hidden = !state.voiceOn || state.voiceOut === "stage";
}

function readIntent() {
  const goals = $("intentGoals").value.split("\n").map((g) => g.trim()).filter(Boolean).slice(0, 3).map((g) => g.slice(0, 60));
  return { goals, takeaway: $("intentTakeaway").value.trim().slice(0, 40), outcome: $("intentOutcome").value.trim().slice(0, 60) };
}

function setSituation(sit) {
  if (!SITUATION_LABEL[sit] || sit === state.situation) return;
  state.situation = sit;
  renderPrep();
  $("mtSituation").value = sit;
  if (state.isRecording) {
    postJSON("/session/situation", { situation: sit }).catch(() => {});
    addSystemLine(`面談の状況を「${SITUATION_LABEL[sit]}」に切り替えました`);
  }
}

// 実際に声を出してよいか。このPCのスピーカーから話す時は、イヤホンの確認が取れていないと出さない（上司に聞こえるため）
function voiceActive() {
  return state.voiceOn && (state.voiceOut === "stage" || state.earphone);
}

function renderVoiceChip() {
  const b = $("mtVoice");
  b.dataset.on = String(state.voiceOn);
  b.textContent = voiceActive() ? "声：オン（イヤホン）" : state.voiceOn ? "声：待機（イヤホン未確認）" : "声：オフ（画面だけ）";
}

function setVoiceOn(on) {
  state.voiceOn = on;
  renderPrep();
  renderVoiceChip();
  if (!state.isRecording) return;
  feedTurn({ type: "mode", voiceOff: !voiceActive() });
  if (!voiceActive() && state.turn && !state.turn.idle) feedTurn({ type: "cancel", why: "voice_off" });
  addSystemLine(voiceActive() ? "view viewがイヤホンで話します" : on ? "イヤホンをつけたことを確認するまで、声は出さず画面でお伝えします" : "view viewは声を出さず、画面でお伝えします");
}

function renderForm() {
  renderPrep();
  const zoom = zoomEnabled();
  $("formCard").hidden = zoom;
  document.querySelectorAll("#formChoice button").forEach((b) => {
    const on = b.dataset.form === state.form;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-checked", String(on));
  });
  document.querySelectorAll("#localRole button").forEach((b) => {
    const on = b.dataset.role === state.localRole;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-checked", String(on));
  });
  $("formOnline").hidden = state.form !== "online";
  $("formInperson").hidden = state.form !== "inperson";
  const shared = Mic.hasRemote();
  $("btnShare").textContent = shared ? "共有し直す" : "会議の音を共有する";
  $("shareStatus").dataset.ok = String(shared);
  $("shareStatus").textContent = shared
    ? `会議の音を受け取っています（マイク＝${WHO[state.localRole]}、会議の音＝${WHO[OTHER_ROLE[state.localRole]]}）`
    : "まだ共有されていません";
  renderStageCard();
  if (state.form === "online" || state.voiceOut === "stage") $("moreDetails").open = true;
  $("voicesBubble").textContent = state.form === "online"
    ? "このPCのマイクの声と、会議から聞こえる相手の声を分けて聞きます。声の登録はいりません！"
    : "準備はこれだけです！「面談を開始」を押してください。上司さんの言葉で部下さんが傷つきそうな時に、そっと言い直しますね。";
}

function setForm(form) {
  state.form = form;
  if (form !== "online" && Mic.hasRemote()) Mic.detachRemote("form");
  renderForm();
}

async function shareMeetingAudio() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    toast("このブラウザは会議の音の共有に対応していません。Chromeをお使いください。");
    return;
  }
  if (!Mic.isOn()) {
    try { await Mic.start(); } catch (e) { toast("先にマイクの使用を許可してください。"); return; }
  }
  let ds;
  try {
    ds = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 1, width: 320, height: 180 },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
      systemAudio: "include",
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
      preferCurrentTab: false,
    });
  } catch (e) {
    if (e.name !== "NotAllowedError") toast("会議の音を共有できませんでした。");
    return;
  }
  if (!Mic.attachRemote(ds)) {
    toast("音声が共有されませんでした。共有の画面で「タブの音声も共有する」をオンにしてください。");
  } else {
    chars.voices.react("happy", 1200);
  }
  renderForm();
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
    : "自動の判定を間違えたときは、会話ログの名前の札をクリックすると直せます。直した結果は、その後の判定にも使います。";

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

// ---------- view view用PC（別のパソコン）で、view viewとして会議に参加する ----------
const useStage = () => state.voiceOut === "stage";
const stageReady = () => useStage() && StageLink.ready();

function mofuChoice() {
  const r = Voice.resolveAll().mofu || {};
  return r.kind === "vv" ? `vv:${r.id}` : r.voice ? `br:${r.voice.name}` : "";
}

// view viewの声：view view用PCが準備できていればそちらで、そうでなければこのPCで話す
const spokenName = (t) => (typeof t === "string" ? t.replace(/view view/gi, "ビュービュー") : t);
function speakMofu(parts, onStart, bubble) {
  parts = parts.map(spokenName);
  if (stageReady()) {
    return StageLink.speakParts(parts, { choice: mofuChoice(), bubble }, (kind) => {
      Mic.suppressRemote(true); // view viewの声が会議の音として戻ってきても、相手の声として数えない
      onStart(kind);
    });
  }
  return Voice.speakParts(parts, "mofu", onStart);
}
function preloadMofu(parts) {
  Voice.preload(parts, "mofu");
  if (stageReady()) StageLink.preload(parts, mofuChoice());
}
function cancelMofu() { Voice.cancel(); StageLink.cancel(); }
function duckMofu(on) { Voice.duck(on); StageLink.duck(on); }
function mofuHold(on) {
  chars.meeting.holdRaise(on);
  if (useStage() && state.isRecording) StageLink.state(on ? "raise" : "lower");
}
function mofuSetState(s) {
  chars.meeting.setState(s);
  if (useStage() && state.isRecording && s !== "speaking") StageLink.state(s === "thinking" ? "thinking" : "idle");
}

async function renderStageCard(refresh) {
  document.querySelectorAll("#voiceOut button").forEach((b) => {
    const on = b.dataset.out === state.voiceOut;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-checked", String(on));
  });
  $("stageSetup").hidden = !useStage();
  $("stageTip").checked = state.stageTip;
  if (!useStage()) return;
  StageLink.open();
  if (refresh || !state.stageInfo) {
    try { state.stageInfo = await StageLink.info(); } catch (e) { state.stageInfo = null; }
  }
  const info = state.stageInfo || { lan_enabled: false, urls: [], local_url: "", key: "" };
  $("stageLanNote").hidden = info.lan_enabled;
  $("stageUrl").textContent = info.urls[0] || "（ほかのパソコンから開ける設定で起動していません）";
  $("stageUrlMore").hidden = info.urls.length < 2;
  $("stageUrlMore").textContent = info.urls.length > 1 ? `つながらない時はこちら：${info.urls.slice(1).join("　")}` : "";
  $("btnStageCopy").disabled = !info.urls.length;
  const n = StageLink.connected();
  const status = $("stageStatus");
  status.dataset.ok = String(StageLink.ready());
  status.textContent = !n ? "view view用PCはまだつながっていません"
    : !StageLink.unlocked() ? "つながりました。view view用PCの画面で「開始する」を押してください"
      : n > 1 ? `準備OK（${n}台つながっています）` : "準備OK：view view用PCから話します";
  $("btnStageTest").disabled = !StageLink.ready();
}

function setVoiceOut(out) {
  state.voiceOut = out;
  renderStageCard();
  renderPrep();
  renderVoiceChip();
}

StageLink.onChange((ev) => {
  if (!$("stageCard").closest(".screen").hidden) renderStageCard();
  if (ev.type === "test") toast("view view用PCでテスト再生しました");
  if (!state.isRecording || !useStage()) return;
  if (ev.type === "connection" && ev.connected && !ev.before) addSystemLine("view view用PCがつながりました");
  if (ev.type === "connection" && !ev.connected && ev.before) addSystemLine("view view用PCとの接続が切れました。このPCから話します");
  if (ev.type === "ready" && ev.unlocked) addSystemLine("view view用PCの準備ができました。ここからはview view用PCが話します");
});

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
  state.turn.step({ type: "mode", remoteVoice: state.voiceOut === "stage", voiceOff: !voiceActive(), t: state.turnT0 });
  state.intent = readIntent();
  state.goalsAuto = new Set();
  state.goalsManual = new Map();
  state.receiveTipAt = {};
  resetReceive();
  state.turnLog = [];
  state.meter = Metrics.createMeter();
  state.verdicts = new Map();
  state.noSend = new Set();
  state.epoch++;
  state.activeSpeak = null;
  state.notNeeded = 0;
  preloadMofu(CUSHIONS);
  document.querySelector(".meeting-bar").classList.toggle("is-zoom", state.inputSource === "zoom");
  state.diar = Diarize.create();
  state.remoteNoText = 0;
  state.remoteWarned = false;
  state.lastRemoteSpeechAt = 0;
  // 登録した声が近すぎる時だけ手動。それ以外は登録しなくても自動で見分ける
  const closeVoices = hasVoices() && state.separation && state.separation.level === "low";
  setSpeakerMode(closeVoices ? "boss" : "auto");

  $("transcript").replaceChildren(el("p", "empty", "話し始めると、ここに文字起こしが表示されます"));
  $("speech").hidden = true;
  $("hintCard").hidden = true;
  $("dataPreview").textContent = "まだ送信されたデータはありません";
  $("mtType").hidden = !showProfile();
  $("forecast").hidden = !showProfile();
  $("speechFeedback").hidden = true;
  mofuHold(false);
  $("mtType").textContent = state.profile.label;
  $("mtType").style.background = "color-mix(in srgb, " + TYPE_META[state.profile.primary].color + " 14%, white)";
  $("mtType").style.color = TYPE_META[state.profile.primary].color;
  $("mtSensitivity").textContent = "感度：" + SENSITIVITY_LABEL[state.sensitivity];
  $("mtTimer").textContent = "00:00";
  $("mtSituation").value = state.situation;
  renderVoiceChip();
  renderGoals();
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
    await postJSON("/start-session", { situation: state.situation, intent: state.intent });
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
  const method = speakerMethod();
  addSystemLine(`面談の状況：${SITUATION_LABEL[state.situation]}${voiceActive() ? "" : state.voiceOn ? "（イヤホン未確認のため、声は出さず画面でお伝えします）" : "（view viewは声を出さず、画面でお伝えします）"}`);
  if (state.intent.goals.length) addSystemLine(`今日伝えたいこと（${state.intent.goals.length}件）を、上司の画面に出しています`);
  if (method === "zoom") addSystemLine("Zoomの参加者名で、上司・部下を見分けます");
  else if (method === "manual") addSystemLine("声が近いため、話者は上部のボタンで切り替えます");
  else if (method === "online") addSystemLine(`マイクの声＝${WHO[state.localRole]}、会議の音＝${WHO[OTHER_ROLE[state.localRole]]}として見分けます`);
  else if (method === "registered") addSystemLine("登録した声で、上司・部下を自動で見分けます");
  else addSystemLine("声の違いと話し方から、上司・部下を自動で見分けます（間違えたら名札をクリック）");
  if (method !== "zoom" && state.form === "online" && !Mic.hasRemote()) addSystemLine("会議の音が共有されていないため、このPCのマイクだけで聞きます");
  if (state.voiceOut === "stage") {
    addSystemLine(stageReady() ? "view view用PCから、声と姿を会議に届けます"
      : StageLink.connected() ? "view view用PCで「開始する」が押されていません。押されるまで、このPCから話します"
        : "view view用PCがつながっていません。つながるまで、このPCから話します");
  }
  const greeting = `${charName()}です。今日はよろしくお願いします！`;
  addMofuLine(greeting);
  $("stageCaption").textContent = "";
  // 声オフの時は、あいさつも画面だけ
  if (voiceActive()) await speakAs("mofu", greeting);
  else stageShow({ text: greeting });
  if (state.isRecording) $("stageCaption").textContent = captionIdle();
}

// いま話者をどう決めているか
function speakerMethod() {
  if (state.inputSource === "zoom") return "zoom";
  if (state.speakerMode !== "auto") return "manual";
  if (Mic.hasRemote()) return "online";
  return hasVoices() ? "registered" : "diar";
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
  cancelMofu();
  clearInterval(state.turnTimer);
  state.turn = null;
  mofuHold(false);
  clearInterval(state.meeting.timer);
  closeZoomFeed();
  if (state.meeting.unsubMic) state.meeting.unsubMic();
  setSeatActive(null);
  state.meeting.endedAt = Date.now();

  try {
    const data = await postJSON("/end-session", { turn_log: state.turnLog, metrics: state.meter ? state.meter.export() : [], intent_covered: goalsDoneCount() });
    state.meeting.logFile = data.file || null;
    state.meeting.receive = data.receive || null;
    state.meeting.receivePrev = data.receive_previous || null;
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
  state.speakerMode = mode;
  state.lastFinalT = performance.now();
  document.querySelectorAll("#speakerMode button").forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-checked", String(on));
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
let lastWatchT = 0;
function onMeetingFrame({ level, speech, rms, t, remoteSpeech, remoteLevel }) {
  if (!state.isRecording) return;
  const anySpeech = speech || remoteSpeech;
  if (anySpeech) state.lastVoiceAt = t;
  if (remoteSpeech) state.lastRemoteSpeechAt = t;
  if (state.meter) state.meter.frame(t, anySpeech);
  // 会議の音にはview viewの声が入らないので、相手の声は「人の声」として確実に伝える（話している最中なら譲る）
  feedTurn({ type: "frame", t, speech: anySpeech, rms: remoteSpeech ? 1 : rms, ref: Voice.outputLevel() });
  watchRemoteText(t, remoteSpeech);
  if (state.isSpeaking || state.demo) return;
  const before = state.liveSpeaker;
  const method = speakerMethod();
  if (method === "manual") {
    state.liveSpeaker = state.speakerMode;
  } else if (method === "online") {
    // 文字が届くのは話し終えた少し後なので、次の人が話し始めるまで直前の話者を保つ
    if (remoteSpeech) state.liveSpeaker = OTHER_ROLE[state.localRole];
    else if (speech) state.liveSpeaker = state.localRole;
  } else if (t - lastLiveGuess > 250) {
    lastLiveGuess = t;
    const frames = Mic.framesBetween(Math.max(state.lastFinalT, t - 4000), t);
    if (frames.length >= 6) {
      const print = VoicePrint.makePrint(frames);
      if (method === "registered") {
        const r = VoicePrint.classify(print, state.voices);
        state.liveSpeaker = r && r.confidence >= VoicePrint.LOW_CONFIDENCE ? r.speaker : null;
      } else {
        state.liveSpeaker = state.diar ? state.diar.live(print) : null;
      }
    } else if (!speech) {
      state.liveSpeaker = null;
    }
  }
  if (state.liveSpeaker !== before) feedTurn({ type: "speaker", t, who: state.liveSpeaker });
  people.boss.setSpeaking(anySpeech && state.liveSpeaker === "boss");
  people.subordinate.setSpeaking(anySpeech && state.liveSpeaker === "subordinate");
  setSeatActive(state.liveSpeaker, anySpeech ? (remoteSpeech && method === "online" ? remoteLevel : level) : 0);
}

// 古いChromeは、渡した音を無視して自分でマイクを開く。その場合、相手の声が文字にならない
function watchRemoteText(t, remoteSpeech) {
  const dt = lastWatchT ? Math.min(120, t - lastWatchT) : 40;
  lastWatchT = t;
  if (!remoteSpeech || state.remoteWarned || state.recPaused || state.micBlocked) return;
  state.remoteNoText += dt;
  if (state.remoteNoText > 6000) {
    state.remoteWarned = true;
    addSystemLine("相手の声が聞こえているのに文字になっていません。Chromeを最新版に更新すると、会議の音も文字にできます");
    toast("会議の音が文字になっていません。Chromeを最新版にしてください。");
  }
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
      mofuHold(true);
      setStatus("thinking", "話すタイミングを待っています");
      break;
    case "lower":
      mofuHold(false);
      if (a.why !== "speak" && !a.uttId && state.turn.idle) backToListening();
      break;
    case "speak":
      if (state.meter) state.meter.spoke(a.uttId, a.t);
      startVoice(a, v);
      break;
    case "hint": if (v) holdToScreen(v, a.why); break;
    case "duck": duckMofu(true); break;
    case "unduck": duckMofu(false); break;
    case "stop":
      cancelMofu();
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

// view viewが実際に口にする全文（自分の声の照合に使う）
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
    preloadMofu(Turn.splitSentences(res.reframed_speech));
    feedTurn({ type: "verdict", spec: true, uttId: 0, prio: res.risk_level, text, speech: spokenText(res), category: res.category_id });
  }
}

function showBossHint(title, result) {
  const parts = [result.boss_tip];
  if (showProfile() && result.meta_note) parts.push(result.meta_note);
  showHint("boss", title, parts.filter(Boolean).join(" "), showProfile() && result.reason ? "判定：" + result.reason : "");
}

// 部下が自分を責める言葉を言った時：声では割り込まず、view viewの画面に「行動と次の一手での言い直し」を出す
const RECEIVE_TIP_GAP_MS = 60000;
function showReceiveTip(sig) {
  const text = sig.rewrite || sig.reframe;
  if (!text) return;
  const now = performance.now();
  if (state.receiveTipAt[sig.id] && now - state.receiveTipAt[sig.id] < RECEIVE_TIP_GAP_MS) return;
  // 自己否定のサインのときだけ、最初に「声でも話す」を選んでいれば短く話しかける（内容は固定の文）
  if (sig.id === "self_blame" && voiceActive() && !state.demo && !state.isSpeaking && state.isRecording) {
    setTimeout(() => { if (state.isRecording && !state.isSpeaking) speakAs("mofu", "自分を責めなくて大丈夫です。起きたことと、自分への評価を分けて見てみましょう。"); }, 700);
  }
  state.receiveTipAt[sig.id] = now;
  const result = { cushion_phrase: "", reframed_speech: text, reply_example: sig.rewrite_example || "", reply_label: "言い直しの例", objective: sig.objective || null };
  showSpeechBubble(result, "自分を責めなくて大丈夫");
  addMofuLine(`${text}（画面で）`);
  const ob = sig.objective;
  stageShow({ intent: "自分を責めなくて大丈夫", text: ob ? `${text} ${ob.question}` : text, tip: sig.rewrite_example ? `言い直しの例：${sig.rewrite_example}` : "" });
  if (state.receive) state.receive.rewrites++;
}

function resetReceive() {
  state.receive = { rewrites: 0 };
}

// ---- 今日の目的（上司が事前に伝えたいこと）が話題に出たか：2文字のかたまりの重なりで見る目安 ----
function bigrams(text) {
  const t = (text || "").replace(/[\s、。，．,.!！?？「」『』（）()・…ー〜~]/g, "");
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
function goalCoverage(goal, text) {
  const g = bigrams(goal);
  if (g.size < 3) return 0;
  const tb = bigrams(text);
  let hit = 0;
  g.forEach((b) => { if (tb.has(b)) hit++; });
  return hit / g.size;
}
const goalDone = (i) => (state.goalsManual.has(i) ? state.goalsManual.get(i) : state.goalsAuto.has(i));
const goalsDoneCount = () => state.intent.goals.filter((_, i) => goalDone(i)).length;

function updateGoals() {
  const m = state.meeting;
  if (!m || !state.intent.goals.length) return;
  const bossText = m.lines.filter((e) => e.speaker === "boss").map((e) => e.text).join("。");
  let changed = false;
  state.intent.goals.forEach((g, i) => {
    if (!state.goalsAuto.has(i) && goalCoverage(g, bossText) >= 0.5) { state.goalsAuto.add(i); changed = true; }
  });
  if (changed) renderGoals();
}

function renderGoals() {
  const { goals, takeaway } = state.intent;
  $("goalsCard").hidden = !goals.length && !takeaway;
  const list = $("goalsList");
  list.replaceChildren();
  goals.forEach((g, i) => {
    const li = el("li", goalDone(i) ? "is-done" : "", g);
    li.title = "クリックで「伝えた／まだ」を切り替え";
    li.addEventListener("click", () => { state.goalsManual.set(i, !goalDone(i)); renderGoals(); });
    list.appendChild(li);
  });
  $("goalsTake").hidden = !takeaway;
  $("goalsTake").textContent = takeaway ? `部下に持ち帰ってほしいこと：${takeaway}（view viewの吹き出しに添えます）` : "";
}

// 声を出さなかった回：言うつもりだった一言と提案を画面に残す
function holdToScreen(v, why) {
  if (why === "voice_off") {
    // 声オフ：控えたのではなく、画面で伝えたこととして扱う
    v.iv.outcome = "screen";
    v.iv.holdReason = why;
    showSpeechBubble(v.result);
    addMofuLine(`${spokenText(v.result)}（画面で）`);
    showBossHint("💡 上司向けヒント", v.result);
    stageShow(bubbleFor(v.result));
    people.boss.setMood("listening");
    updateCounts();
    return;
  }
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
// 介入の吹き出し：上司が「部下に持ち帰ってほしいこと」を書いていれば添える（部下にも見える前提の欄）
function intentLine() {
  return state.intent && state.intent.takeaway ? `上司さんが伝えたいこと：${state.intent.takeaway}` : "";
}
function skillLine(result) {
  if (result.receive_note) return result.receive_note;
  return result.receive_skill ? `受け取り方：${result.receive_skill.label}（${result.receive_skill.desc}）` : "";
}
function bubbleFor(result) {
  const reply = result.reply_example ? `言えるひとこと：「${result.reply_example}」` : "";
  return {
    cushion: result.cushion_phrase || "",
    text: result.reframed_speech || "",
    tip: [reply, state.stageTip ? result.boss_tip || "" : ""].filter(Boolean).join("　"),
    intent: skillLine(result) || intentLine(),
  };
}
function stageShow(bubble) {
  if (useStage() && StageLink.connected()) StageLink.show(bubble);
}

function showSpeechBubble(result, label) {
  clearTimeout(oldSpeechTimer);
  const intent = label ? "" : intentLine();
  $("speechIntent").hidden = !(intent || label);
  $("speechIntent").textContent = label || intent;
  const skill = label ? "" : skillLine(result);
  $("speechSkill").hidden = !skill;
  $("speechSkill").textContent = skill;
  $("speechCushion").textContent = result.cushion_phrase || "";
  $("speechText").textContent = result.reframed_speech || "";
  const ob = result.objective;
  $("speechObjective").hidden = !ob;
  if (ob) {
    $("objFact").textContent = ob.fact ? `「${ob.fact}」` : "（何が起きたかを一言で言うと？）";
    $("objJudge").textContent = ob.judgement ? `「${ob.judgement}」` : "";
    $("objQuestion").textContent = ob.question;
  }
  $("speechReply").hidden = !result.reply_example;
  $("speechReplyLabel").textContent = result.reply_label || "言えるひとこと";
  $("speechReplyText").textContent = result.reply_example || "";
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
  const bubble = bubbleFor(result);
  const status = await speakMofu(parts, (kind) => {
    if (!state.activeSpeak || state.activeSpeak.speakId !== a.speakId) return;
    Mic.mute(true);
    iv.outcome = "voice";
    updateCounts();
    showSpeechBubble(result);
    addMofuLine(`${result.cushion_phrase || ""}${result.reframed_speech || ""}`);
    showBossHint("💡 上司向けヒント", result);
    people.boss.setMood("listening");
    feedTurn({ type: "playStart", speakId: a.speakId, levelOk: kind === "vv" });
  }, bubble);
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
  Mic.suppressRemote(false);
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
    state.voiceOn = false;
    renderPrep();
    renderVoiceChip();
    feedTurn({ type: "mode", voiceOff: true });
    toast("ここからは声を控えて、画面だけでお伝えします");
  }
}

// デモでは、view viewの判断と発話が終わるのを待ってから次の行へ進む
async function turnSettled(maxMs = 15000) {
  const t0 = performance.now();
  while (state.turn && !state.turn.idle && state.demo && !state.demo.abort && performance.now() - t0 < maxMs) await sleep(80);
}

// 確定した発言が誰のものかを決める
// 自信がない時は「上司」として扱う（言い換えの取りこぼしを避ける）。? を付けて直しやすくする
function assignSpeaker(tFinal, text) {
  const t1 = tFinal - 150;
  const t0 = state.lastFinalT;
  state.lastFinalT = t1;
  const method = speakerMethod();
  if (method === "manual") return { speaker: state.speakerMode, source: "manual", confidence: null, unsure: false };
  if (method === "online") {
    const v = Mic.voicedBetween(t0, t1);
    const r = Diarize.bySource(v.local, v.remote, state.localRole);
    if (!r.role) {
      const who = state.liveSpeaker;
      return { speaker: who || "boss", source: "online", confidence: null, unsure: !who };
    }
    const unsure = r.confidence < 0.6;
    return { speaker: unsure ? "boss" : r.role, source: "online", confidence: r.confidence, unsure };
  }
  const frames = Mic.framesBetween(t0, t1);
  const print = frames.length >= 6 ? VoicePrint.makePrint(frames) : null;
  if (method === "registered") {
    const r = print ? VoicePrint.classify(print, state.voices) : null;
    if (!r) return { speaker: "boss", source: "auto", confidence: null, unsure: true };
    const unsure = r.confidence < VoicePrint.LOW_CONFIDENCE;
    return { speaker: unsure ? "boss" : r.speaker, source: "auto", confidence: r.confidence, unsure };
  }
  const r = state.diar.add(print, text);
  return { speaker: r.sure ? r.role : "boss", source: "auto", confidence: r.confidence, unsure: !r.sure, diarIndex: r.index, changed: r.changed };
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
  const src = { auto: "声で判定", online: "マイク／会議の音", manual: "手動", demo: "デモ", text: "テキスト", zoom: "Zoom" }[entry.source] || "";
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
  // view view自身の声を認識したものは、発言として扱わない
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
    diarIndex: meta.diarIndex != null ? meta.diarIndex : null,  // 登録なしの話者判定での番号
    analyzedAsBoss: false,
    epoch: state.epoch,
    time: nowTime(),
  };
  m.lines.push(entry);
  m.utterances[entry.speaker]++;
  m.chars[entry.speaker] += text.length;
  if (entry.source === "auto" || entry.source === "online") m.autoCount++;
  addSpeakerLine(entry);
  showSeatBubble(entry.speaker, text);
  $("stageCaption").textContent = "";
  updateCounts();

  const ctx = state.context.slice(-6);
  const contextLine = `${WHO[entry.speaker]}: ${text}`;
  if (entry.unsure || entry.source === "demo") state.noSend.add(contextLine);
  state.context.push(contextLine);
  if (state.context.length > 8) state.context.shift();
  applyDiarChanges(meta.changed);
  updateGoals();
  await analyzeEntry(entry, ctx, true);
}

async function analyzeEntry(entry, ctx, live) {
  const m = state.meeting;
  const isBoss = entry.speaker === "boss";
  const thinkingTimer = isBoss ? setTimeout(() => {
    if (!state.isSpeaking) {
      mofuSetState("thinking");
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
      if (live) showReceiveTip(sig);
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
      if (!entry.unsure) preloadMofu(Turn.splitSentences(result.reframed_speech));
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
    mofuSetState("listening");
    if (state.demo) setStatus("speaking", "デモ会話を再生中");
    else if (state.inputSource === "zoom") setStatus("listening", "Zoomの会話を受信中");
    else if (state.micBlocked) setStatus("error", "マイク未許可（テキスト入力のみ）");
    else setStatus("listening", "聞いています");
  } else {
    mofuSetState("idle");
  }
}

// 話者をあとから直す（自動判定の間違いを1クリックで回復）
function toggleLineSpeaker(entry) {
  const m = state.meeting;
  if (!m || !state.isRecording) { toast("面談中だけ直せます"); return; }
  const from = entry.speaker;
  const to = from === "boss" ? "subordinate" : "boss";
  entry.unsure = false;
  // 話者の間違いが分かった発言には、声を出さない
  if (to === "subordinate" && state.turn && !state.turn.idle) feedTurn({ type: "cancel", why: "corrected" });
  moveSpeaker(entry, to);
  m.corrections++;
  renderWho(entry);
  updateCounts();
  postJSON("/speaker-correction", { transcript: entry.text, from_speaker: from, to_speaker: to, confidence: entry.confidence }).catch(() => {});
  toast(`「${WHO[to]}」の発言に直しました`);
  if (to === "boss" && !entry.analyzedAsBoss) analyzeEntry(entry, state.context.slice(-7, -1), false);
  // 直した結果を覚えて、ほかの発言の判定にも使う
  if (state.diar && entry.diarIndex != null) applyDiarChanges(state.diar.correct(entry.diarIndex, to).changed);
}

// 発言の話者を入れ替える（件数・送る文脈もそろえる）
function moveSpeaker(entry, to) {
  const m = state.meeting;
  const from = entry.speaker;
  if (from === to) return;
  entry.speaker = to;
  m.utterances[from]--;
  m.utterances[to]++;
  m.chars[from] -= entry.text.length;
  m.chars[to] += entry.text.length;
  const old = `${WHO[from]}: ${entry.text}`;
  const next = `${WHO[to]}: ${entry.text}`;
  const i = state.context.lastIndexOf(old);
  if (i >= 0) state.context[i] = next;
  // デモの発言と、まだ話者に自信がない発言は、札が変わっても外部へ送らない
  if (entry.source === "demo" || entry.unsure) state.noSend.add(next);
  updateGoals();
}

// 登録なしの話者判定が、それまでの発言を見直した結果を画面に反映する
function applyDiarChanges(changed) {
  const m = state.meeting;
  if (!m || !changed || !changed.length) return;
  let moved = 0;
  changed.forEach((c) => {
    const entry = m.lines.find((e) => e.diarIndex === c.index);
    if (!entry || entry.source !== "auto") return;
    const to = c.sure ? c.role : "boss";
    entry.confidence = c.confidence;
    entry.unsure = !c.sure;
    if (entry.speaker !== to) {
      if (to === "subordinate" && state.turn && !state.turn.idle && state.verdicts.has(entry.id)) feedTurn({ type: "cancel", why: "corrected" });
      moveSpeaker(entry, to);
      moved++;
    }
    renderWho(entry);
  });
  if (moved) {
    updateCounts();
    addSystemLine(`声の違いと話し方から、${moved}件の話者を見直しました`);
  }
  const info = state.diar && state.diar.info();
  if (info && info.hard && !m.hardNoted) {
    m.hardNoted = true;
    addSystemLine("お二人の声が近く、自動では見分けにくいようです。上部の「上司／部下」ボタン（キー1・2）で切り替えると確実です");
  }
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
    cancelMofu();
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
    // view viewが話している間に届いた発言も取りこぼさないよう、順番に処理する
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
      if (state.lastRemoteSpeechAt && performance.now() - state.lastRemoteSpeechAt < 2500) state.remoteNoText = 0;
      if (res.isFinal) {
        const meta = assignSpeaker(performance.now(), text);
        if (state.meter) meta.mid = state.meter.final(performance.now(), text.length);
        handleUtterance(text, meta);
      } else {
        if (state.meter) state.meter.interim(performance.now());
        // view viewの発話中も聞き続ける（人が話し始めたら譲るため）
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
  // このアプリが開いたマイク（＋会議の音）をそのまま渡す。音声認識が自分でマイクを開き直さないようにする
  const track = state.trackUnsupported ? null : Mic.recognitionTrack();
  try {
    if (track) state.recognition.start(track);
    else state.recognition.start();
  } catch (e) {
    if (track && (e.name === "TypeError" || e.name === "NotSupportedError")) {
      state.trackUnsupported = true;
      setTimeout(startRecognition, 0);
      return;
    }
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
  const viaStage = role === "mofu" && stageReady();
  try {
    if (role === "mofu") await speakMofu(Turn.splitSentences(text), () => {}, { text });
    else await Voice.speak(text, role);
  } finally {
    if (viaStage) Mic.suppressRemote(false);
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
      // view view用PCの声は会議を通って少し遅れて戻るので、聞き取りの再開も遅らせる
      if (state.isRecording) setTimeout(startRecognition, viaStage ? 1800 : 300);
    }
  }
}

function updateVoiceCredit() {
  const credits = Voice.credits();
  $("voiceCredit").textContent = credits.length ? "音声：" + credits.join("、") : "";
}

// ---------- 受け取り方の練習（入力した返しは保存しない） ----------
async function openPractice(back) {
  try {
    if (!state.practice) state.practice = { items: (await getJSON("/practice/items")).items };
  } catch (e) {
    toast("練習の問題を読み込めませんでした");
    return;
  }
  state.practice.i = 0;
  state.practice.back = back;
  renderPractice();
  showScreen("practice");
}
function renderPractice() {
  const p = state.practice;
  const it = p.items[p.i];
  $("prProgress").textContent = `${p.i + 1} / ${p.items.length}`;
  $("prBoss").textContent = it.boss;
  $("prReply").value = "";
  $("prResult").hidden = true;
  $("prNext").hidden = true;
  $("prNext").textContent = p.i === p.items.length - 1 ? "練習を終える" : "次の問題へ";
  $("prReply").focus();
}
async function checkPractice(e) {
  e.preventDefault();
  const it = state.practice.items[state.practice.i];
  let res;
  try {
    res = await postJSON("/practice/check", { item_id: it.id, reply: $("prReply").value });
  } catch (err) {
    toast("view viewに見てもらえませんでした");
    return;
  }
  $("prMessage").textContent = res.message;
  $("prSkills").replaceChildren(...(res.skills || []).map((s) => el("span", "tag tag-good", "👍 " + s.label)));
  $("prRewrite").hidden = !res.rewrite;
  $("prRewrite").textContent = res.rewrite ? `${res.rewrite} 例：${res.rewrite_example}` : "";
  $("prModel").textContent = res.model;
  $("prResult").hidden = false;
  $("prNext").hidden = false;
}
function nextPractice() {
  const p = state.practice;
  if (p.i >= p.items.length - 1) {
    showScreen(p.back || "voices");
    toast("練習おつかれさまでした！面談でも「言えるひとこと」を使ってみてください");
    return;
  }
  p.i++;
  renderPractice();
}

// ---------- ⑥ ふりかえり ----------
// 受け取り方のふりかえり：できたことを数える。自己否定の回数で本人を責めない
function renderReceiveSummary(m) {
  const r = m.receive;
  const selfNeg = r ? r.self_negation : 0;
  const pa = r ? r.personal_attack_by_boss : 0;
  const prev = m.receivePrev;
  const lines = [];
  lines.push(selfNeg
    ? `自分を責める言葉が出た場面が ${selfNeg}回 ありました。そのたびに、「起きたこと」と「自分への評価」を分けて見る手がかりを出しています。`
    : "今回は、自分を責める言葉は出ませんでした。");
  if (prev && typeof prev.self_negation === "number" && r && r.sub_utterances && selfNeg < prev.self_negation) {
    lines.push(`前回（${prev.self_negation}回）より減りました。`);
  }
  $("smReceiveText").textContent = lines.join(" ");
  $("smReceiveBoss").hidden = !pa;
  if (pa) $("smReceiveBoss").textContent = `上司の方へ：人や能力に向いた言葉が ${pa}回 ありました。これは受け取る側の練習ではなく、言い方で直す部分です。「どの行動を、なぜ、どう変えてほしいか」で伝えると届きやすくなります。`;
}

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
    ? `自動で話者を判定した発言 ${m.autoCount}件 ・ 手で直した発言 ${m.corrections}件`
    : m.corrections ? `手で直した発言 ${m.corrections}件` : "";

  const goals = state.intent.goals;
  $("smGoals").hidden = !goals.length;
  $("smGoalsList").replaceChildren(...goals.map((g, i) => el("li", goalDone(i) ? "is-done" : "", g + (goalDone(i) ? "" : "（まだ話題に出ていないかも）"))));

  renderReceiveSummary(m);

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
    ["話し終わり → view viewが話し出す", s.speak],
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
    "「話し終わり」は、声の検知で最後に声が出た時刻です。view viewが話し出すまでの時間は、声を出した回だけが対象です。件数が少ないうちは傾向の確認にとどまります。"));
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
  persona.name = $("setName").value.trim() || "view view";
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
document.querySelectorAll("#situation button").forEach((b) => b.addEventListener("click", () => setSituation(b.dataset.situation)));
document.querySelectorAll("#voiceOn button").forEach((b) => b.addEventListener("click", () => setVoiceOn(b.dataset.voice === "on")));
$("mtSituation").addEventListener("change", (e) => setSituation(e.target.value));
$("mtVoice").addEventListener("click", () => setVoiceOn(!state.voiceOn));
$("earphoneOk").addEventListener("change", (e) => {
  state.earphone = e.target.checked;
  setVoiceOn(state.voiceOn);
  saveProfileEdits().catch(() => {});
});
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
document.querySelectorAll("#formChoice button").forEach((b) => b.addEventListener("click", () => setForm(b.dataset.form)));
document.querySelectorAll("#localRole button").forEach((b) =>
  b.addEventListener("click", () => { state.localRole = b.dataset.role; renderForm(); })
);
$("btnShare").addEventListener("click", shareMeetingAudio);
document.querySelectorAll("#voiceOut button").forEach((b) => b.addEventListener("click", () => setVoiceOut(b.dataset.out)));
$("stageTip").addEventListener("change", (e) => { state.stageTip = e.target.checked; });
$("btnStageTest").addEventListener("click", () => StageLink.test());
$("btnStageCopy").addEventListener("click", () => {
  const url = state.stageInfo && state.stageInfo.urls[0];
  if (!url) return;
  navigator.clipboard.writeText(url).then(() => toast("アドレスをコピーしました"), () => toast("コピーできませんでした。手で入力してください"));
});
$("btnStageRotate").addEventListener("click", async () => {
  await StageLink.rotate();
  await renderStageCard(true);
  toast("合言葉を作り直しました。view view用PCでは新しいアドレスを開き直してください");
});
Mic.onRemoteEnded((why) => {
  if (why === "replaced" || why === "mic_stopped" || why === "form") return;
  renderForm();
  if (state.isRecording && state.inputSource !== "zoom") {
    addSystemLine("会議の音の共有が止まりました。ここからはこのPCのマイクだけで聞きます");
    stopRecognition(); // 止まると自動で再開し、そのときマイクだけの音に切り替わる
    if (state.speakerMode === "auto") $("stageCaption").textContent = captionIdle();
  }
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
$("btnPractice").addEventListener("click", () => openPractice("voices"));
$("btnPracticeAgain").addEventListener("click", () => openPractice("summary"));
$("prForm").addEventListener("submit", checkPractice);
$("prNext").addEventListener("click", nextPractice);
$("prQuit").addEventListener("click", () => showScreen(state.practice ? state.practice.back : "voices"));
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
    if (e.key === "v" || e.key === "V") setVoiceOn(!state.voiceOn);
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
