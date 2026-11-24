"use strict";

// ---------- 読み上げ計測テストの画面 ----------
// 計測の算出は metrics.js。ここはマイク・音声認識・画面をつなぐだけ。
// app.js の面談とは独立していて、面談中には入れない（スタート画面から入る）。
const Measure = (() => {
  const KIND_LABEL = {
    short: "短文", question: "問いかけ", trailing: "言いさし", long: "長文", filler: "言い淀み",
    backchannel: "相づち", fast: "早口", number: "曜日入り", quiet: "小声",
  };

  let test = null, recog = null, unsub = null, timer = null, running = false, lastKey = "";

  const ms = (v) => (v == null ? "—" : `${v}ms`);

  function feed(ev) {
    if (!test || !running) return;
    test.step(ev);
    const v = test.view;
    const key = `${v.phase}:${v.index}`;
    if (key !== lastKey) {
      lastKey = key;
      render();
      if (v.phase === "done") finish();
    }
  }

  function render() {
    const v = test.view;
    if (v.phase === "done") return;
    $("mCount").textContent = `${Math.min(v.index + 1, v.total)} / ${v.total}`;
    $("mBar").style.width = `${(v.index / v.total) * 100}%`;
    $("mPrompt").textContent = v.prompt.text;
    $("mHint").textContent = v.prompt.hint;
    $("mState").textContent = v.phase === "wait" ? "読み上げてください" : v.phase === "heard" ? "聞き取っています…" : "次の文へ";
    $("mState").dataset.phase = v.phase;
  }

  function showPart(name) {
    ["mIntro", "mRun", "mResult"].forEach((id) => ($(id).hidden = id !== name));
  }

  function setError(text) {
    $("mError").hidden = !text;
    $("mError").textContent = text || "";
  }

  function newRecognition() {
    const r = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
    r.lang = "ja-JP";
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const text = res[0].transcript.trim();
        if (!text) continue;
        feed({ type: res.isFinal ? "final" : "interim", t: performance.now(), text });
      }
    };
    r.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        stop();
        setError("マイクの使用が許可されていません。アドレスバー左のアイコンから許可してください。");
        showPart("mIntro");
      }
    };
    r.onend = () => {
      if (running) setTimeout(() => { try { r.start(); } catch (e) { /* 開始済み */ } }, 300);
    };
    return r;
  }

  async function start() {
    setError("");
    if (!("SpeechRecognition" in window || "webkitSpeechRecognition" in window)) {
      setError("このブラウザは音声認識に対応していません。ChromeかSafariの新しい版でお試しください。");
      return;
    }
    try {
      await Mic.start();
    } catch (e) {
      setError("マイクを開けませんでした。マイクの許可を確認してください。");
      return;
    }
    Mic.mute(false);
    test = Metrics.createTest();
    lastKey = "";
    running = true;
    unsub = Mic.onFrame(({ speech, t }) => feed({ type: "frame", t, speech }));
    timer = setInterval(() => feed({ type: "tick", t: performance.now() }), 100);
    recog = newRecognition();
    try { recog.start(); } catch (e) { /* 開始済み */ }
    test.start(performance.now());
    showPart("mRun");
    render();
  }

  // 計測の後片付け。マイクと認識を閉じる
  function stop() {
    running = false;
    clearInterval(timer);
    if (unsub) unsub();
    unsub = null;
    if (recog) { try { recog.stop(); } catch (e) { /* 停止済み */ } }
    recog = null;
    if (Mic.isOn()) Mic.stop();
  }

  async function finish() {
    const results = test.results();
    stop();
    renderResult(results);
    showPart("mResult");
    try {
      const data = await postJSON("/measure/save", { results });
      $("mFile").textContent = "結果を保存しました：" + data.file;
    } catch (e) {
      $("mFile").textContent = "結果の保存に失敗しました（画面の結果はコピーできます）";
    }
  }

  function resultNote(r) {
    if (r.noSpeech) return "声が聞き取れず飛ばしました";
    const notes = [];
    if (r.noFinal) notes.push("確定文が届きませんでした");
    if (r.finals > 1) notes.push(`${r.finals}回に割れました`);
    if (r.cutWhileSpeaking) notes.push("確定のあとに声が続きました");
    if (r.pauseExpected && !r.pauseDone) notes.push("間があいていません（判定の参考にならない）");
    return notes.join("、") || "問題なし";
  }

  function summaryLines(sum) {
    const lines = [`読み上げ ${sum.heard}/${sum.total}文（飛ばした文 ${sum.noSpeech}、確定文なし ${sum.noFinal}）`];
    if (sum.final) lines.push(`話し終わり → 確定文：中央値 ${sum.final.median}ms、90%点 ${sum.final.p90}ms、最大 ${sum.final.max}ms`);
    if (sum.firstInterim) lines.push(`話し始め → 最初の途中文：中央値 ${sum.firstInterim.median}ms、90%点 ${sum.firstInterim.p90}ms`);
    lines.push(`1文が複数に割れた：${sum.split}文 ／ 確定のあとに声が続いた：${sum.cut}文`);
    if (sum.pauseTried) lines.push(`間をあけた文での割れ：${sum.pauseSplit}/${sum.pauseTried}文`);
    if (sum.matchAvg != null) lines.push(`読んだ文との一致率（平均）：${sum.matchAvg}%（漢字・かなの表記ゆれを含む）`);
    return lines;
  }

  function renderResult(results) {
    const sum = Metrics.summarizeTest(results);
    const box = $("mSummary");
    box.replaceChildren();
    const ul = el("ul", "measure-summary");
    summaryLines(sum).forEach((l) => ul.appendChild(el("li", "", l)));
    box.appendChild(ul);

    const table = $("mTable");
    table.replaceChildren();
    const head = el("tr");
    ["#", "種類", "話し始め → 途中文", "話し終わり → 確定", "確定の回数", "一致率", "メモ"].forEach((h) => head.appendChild(el("th", "", h)));
    table.appendChild(head);
    results.forEach((r, i) => {
      const tr = el("tr");
      tr.appendChild(el("td", "num", String(i + 1)));
      tr.appendChild(el("td", "", KIND_LABEL[r.kind] || r.kind));
      tr.appendChild(el("td", "num", r.noSpeech ? "—" : ms(r.firstInterimMs)));
      tr.appendChild(el("td", "num", r.noSpeech ? "—" : ms(r.finalMs)));
      tr.appendChild(el("td", "num", r.noSpeech ? "—" : String(r.finals)));
      tr.appendChild(el("td", "num", r.matchPct == null ? "—" : `${r.matchPct}%`));
      tr.appendChild(el("td", "", resultNote(r)));
      table.appendChild(tr);
    });
    $("mNote").textContent = "1回の計測は10文までで、この数字は参考値です。マイクや声の大きさ、ネットワークで変わるため、場所や相手を変えて繰り返して比べてください。";
    $("mCopy").dataset.text = ["音声の計測テスト（" + new Date().toLocaleString("ja-JP") + "）", ...summaryLines(sum)].join("\n");
  }

  function open() {
    if (state.isRecording) { toast("面談中です。終了してから計測してください。"); return; }
    setError("");
    showPart("mIntro");
    showScreen("measure");
  }

  function leave() {
    stop();
    updateQuickStart();
    showScreen("start");
  }

  $("brandHome").addEventListener("click", () => { if (running) stop(); });
  $("btnMeasure").addEventListener("click", open);
  $("mStart").addEventListener("click", start);
  $("mAgain").addEventListener("click", () => { showPart("mIntro"); setError(""); });
  $("mBack").addEventListener("click", leave);
  $("mHome").addEventListener("click", leave);
  $("mStop").addEventListener("click", () => { stop(); showPart("mIntro"); toast("計測を中止しました"); });
  $("mSkip").addEventListener("click", () => { if (test && running) { test.skip(performance.now()); feed({ type: "tick", t: performance.now() }); } });
  $("mCopy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("mCopy").dataset.text || "");
      toast("結果をコピーしました");
    } catch (e) {
      toast("コピーできませんでした。画面の結果を選択してコピーしてください。");
    }
  });

  return { summaryLines, resultNote, _debug: { feed, get test() { return test; } } };
})();
