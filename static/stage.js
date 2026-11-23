"use strict";

// view view用PCのステージ画面。上司のPCからの指示で、声を出し・吹き出しと表情を変える。
// 届くのは「話す文・吹き出し・表情」だけ。会話の記録や部下の特性はここには来ない。
(() => {
  const $ = (id) => document.getElementById(id);
  const mofu = Mofu.create($("stageChar"), { follow: false });
  const BUBBLE_FADE_MS = 12000;
  let unlocked = false;
  let speakingId = null;
  let fadeTimer = null;

  const report = (body) =>
    fetch("/stage/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});

  function setConnected(ok) {
    $("stageConn").dataset.ok = String(ok);
  }

  function showBubble(b) {
    clearTimeout(fadeTimer);
    const bubble = $("stageBubble");
    const intent = (b && b.intent) || "";
    $("stageIntent").hidden = !intent;
    $("stageIntent").textContent = intent;
    $("stageIntent").classList.remove("is-old");
    $("stageLabel").hidden = !(b && b.label);
    $("stageLabel").textContent = (b && b.label) || "";
    $("stageCushion").textContent = (b && b.cushion) || "";
    $("stageText").textContent = (b && b.text) || "";
    bubble.classList.remove("is-empty", "is-old", "pop");
    void bubble.offsetWidth;
    bubble.classList.add("pop");
    const tip = (b && b.tip) || "";
    $("stageTip").hidden = !tip;
    $("stageTip").classList.remove("is-old");
    $("stageTipText").textContent = tip;
  }

  function fadeLater() {
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      $("stageBubble").classList.add("is-old");
      $("stageTip").classList.add("is-old");
      $("stageIntent").classList.add("is-old");
    }, BUBBLE_FADE_MS);
  }

  async function say(cmd) {
    // 「開始」を押す前は音を出せない。上司のPCに知らせて、上司のPCから話してもらう
    if (!unlocked) { report({ event: "fail", id: cmd.id }); return; }
    Voice.setConfig({ roles: { mofu: { choice: cmd.choice } } });
    const id = cmd.id;
    speakingId = id;
    mofu.holdRaise(false);
    const status = await Voice.speakParts(cmd.parts, "mofu", (kind) => {
      report({ event: "start", id, kind });
      showBubble(cmd.bubble);
      mofu.setState("speaking");
    });
    if (speakingId === id) {
      speakingId = null;
      mofu.setState("idle");
    }
    report({ event: status === "done" ? "end" : status === "cancelled" ? "cancelled" : "fail", id });
    fadeLater();
  }

  async function test() {
    if (!unlocked) return;
    const parts = ["ビュービューです。", "聞こえていますか？"];
    showBubble({ text: parts.join("") });
    mofu.setState("speaking");
    await Voice.speakParts(parts, "mofu");
    mofu.setState("idle");
    report({ event: "test" });
    fadeLater();
  }

  function handle(cmd) {
    switch (cmd.type) {
      case "say": say(cmd); break;
      case "cancel": Voice.cancel(); break;
      case "duck": Voice.duck(cmd.on); break;
      case "preload":
        if (!unlocked) break;
        Voice.setConfig({ roles: { mofu: { choice: cmd.choice } } });
        Voice.preload(cmd.parts, "mofu");
        break;
      case "state":
        if (cmd.name === "raise") mofu.holdRaise(true);
        else if (cmd.name === "lower") mofu.holdRaise(false);
        else if (cmd.name === "happy") mofu.react("happy", 1500);
        else if (!speakingId) mofu.setState(cmd.name === "thinking" ? "thinking" : "idle");
        break;
      case "test": test(); break;
      case "show":
        showBubble(cmd.bubble);
        if (!speakingId) mofu.react("happy", 1200);
        fadeLater();
        break;
    }
  }

  function connect() {
    const es = new EventSource("/stage/events");
    es.onopen = () => {
      setConnected(true);
      report({ event: "ready", unlocked });
    };
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      let cmd;
      try { cmd = JSON.parse(e.data); } catch (err) { return; }
      handle(cmd);
    };
  }

  $("btnStageStart").addEventListener("click", async () => {
    Voice.warmup();
    unlocked = true;
    $("stageOverlay").hidden = true;
    mofu.react("happy", 1500);
    await Voice.refresh();
    report({ event: "ready", unlocked: true });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "t" || e.key === "T") test();
    if (e.key === "f" || e.key === "F") {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else document.documentElement.requestFullscreen().catch(() => {});
    }
  });

  // 画面共有に映るので、しばらく動かさなければカーソルを隠す
  let cursorTimer = null;
  document.addEventListener("pointermove", () => {
    document.body.classList.remove("hide-cursor");
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => document.body.classList.add("hide-cursor"), 2500);
  });

  connect();
})();
