"use strict";

// 上司のPC → ミナト用PC（ステージ画面）への指示と、その報告の受け取り。
// speakParts は Voice.speakParts と同じ形（done / cancelled / failed を返し、音が出始めたら onStart）。
const StageLink = (() => {
  const START_TIMEOUT_MS = 5000;   // 合成と再生がこれより遅れたら諦めて、上司のPCから話す判断に回す
  const MAX_PLAY_MS = 25000;
  let feed = null;
  let connected = 0;
  let unlocked = false;
  let seq = 0;
  const pending = new Map();       // id → { onStart, resolve, started, timers }
  const listeners = new Set();

  const notify = (ev) => listeners.forEach((fn) => fn(ev));

  function settle(id, status) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    p.timers.forEach(clearTimeout);
    p.resolve(status);
  }

  function onReport(ev) {
    if (ev.event === "ready") {
      unlocked = !!ev.unlocked;
      notify({ type: "ready", unlocked });
      return;
    }
    if (ev.event === "test") { notify({ type: "test" }); return; }
    const p = pending.get(ev.id);
    if (!p) return;
    if (ev.event === "start" && !p.started) {
      p.started = true;
      p.onStart("stage");
    } else if (ev.event === "end") settle(ev.id, "done");
    else if (ev.event === "cancelled") settle(ev.id, "cancelled");
    else if (ev.event === "fail") {
      // 「開始」が押されていないと失敗が返る。次からは上司のPCで話す
      if (!p.started) unlocked = false;
      settle(ev.id, "failed");
      notify({ type: "ready", unlocked });
    }
  }

  function open() {
    if (feed) return;
    feed = new EventSource("/stage/feed");
    feed.onmessage = (e) => {
      let ev;
      try { ev = JSON.parse(e.data); } catch (err) { return; }
      if (ev.type === "stage") {
        const before = connected;
        connected = ev.connected || 0;
        if (typeof ev.unlocked === "boolean") unlocked = ev.unlocked;
        if (!connected) unlocked = false;
        if (before !== connected) notify({ type: "connection", connected, before });
        else notify({ type: "status" });
      } else if (ev.type === "report") {
        onReport(ev);
      }
    };
    feed.onerror = () => {
      if (connected) { connected = 0; unlocked = false; notify({ type: "connection", connected: 0, before: 1 }); }
    };
  }

  async function command(body) {
    try {
      const res = await fetch("/stage/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) return 0;
      return (await res.json()).delivered || 0;
    } catch (e) {
      return 0;
    }
  }

  function speakParts(parts, { choice = "", bubble = {} } = {}, onStart = () => {}) {
    parts = (parts || []).map((p) => (p || "").trim()).filter(Boolean);
    if (!parts.length) return Promise.resolve("done");
    // 新しい発話が来たら、前の発話は打ち切る（Voice と同じ）
    [...pending.keys()].forEach((id) => settle(id, "cancelled"));
    const id = ++seq;
    return new Promise((resolve) => {
      const entry = { onStart, resolve, started: false, timers: [] };
      pending.set(id, entry);
      entry.timers.push(setTimeout(() => { if (!entry.started) settle(id, "failed"); }, START_TIMEOUT_MS));
      entry.timers.push(setTimeout(() => settle(id, "failed"), MAX_PLAY_MS));
      command({ type: "say", id, parts, choice, bubble }).then((n) => { if (!n) settle(id, "failed"); });
    });
  }

  return {
    open,
    // 話を任せてよい状態か（つながっていて、ミナト用PCで「開始」が押されている）
    ready: () => connected > 0 && unlocked,
    connected: () => connected,
    unlocked: () => unlocked,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    speakParts,
    speaking: () => pending.size > 0,
    cancel() {
      if (!pending.size) return;
      [...pending.keys()].forEach((id) => settle(id, "cancelled"));
      command({ type: "cancel" });
    },
    duck(on) { if (pending.size) command({ type: "duck", on }); },
    state(name) { if (connected) command({ type: "state", name }); },
    preload(parts, choice) {
      parts = (parts || []).filter(Boolean);
      if (connected && unlocked && parts.length) command({ type: "preload", parts, choice });
    },
    test() { return command({ type: "test" }); },
    // 声を出さずに吹き出しだけ出す（声オフの時・受け取り方のヒント）
    show(bubble) { if (connected) command({ type: "show", bubble }); },
    async info() {
      const res = await fetch("/stage/info");
      return res.json();
    },
    async rotate() {
      await fetch("/stage/rotate", { method: "POST" });
    },
  };
})();
