// 面談ステージに座る「上司」と「部下」のアバター。
// 部下は性格タイプによって、身構えたときの反応が変わる（完璧主義=うつむいて汗 / 論理=眉をひそめて「？」 / 繊細=縮こまって震える）
const People = (() => {
  const LOOK = {
    boss: { cloth: "#3F4B7C", dark: "#323D68", hair: "#2F2724", skin: "#F5D6BE", shade: "#EBC3A6", label: "上司" },
    subordinate: { cloth: "#4E9E83", dark: "#3F876F", hair: "#7A5543", skin: "#F8DCC6", shade: "#EFC9AF", label: "部下" },
  };

  function outfit(role, L) {
    if (role === "boss") {
      return `
      <path d="M38 206 C38 160 62 140 100 140 C138 140 162 160 162 206 Z" fill="${L.cloth}"/>
      <path d="M86 142 L100 172 L114 142 Z" fill="#FFFFFF"/>
      <path d="M97 150 L103 150 L105 178 L100 186 L95 178 Z" fill="#E9785F"/>
      <path d="M85 142 L100 174 L91 182 L76 148 Z" fill="${L.dark}"/>
      <path d="M115 142 L100 174 L109 182 L124 148 Z" fill="${L.dark}"/>`;
    }
    return `
      <path d="M38 206 C38 160 62 140 100 140 C138 140 162 160 162 206 Z" fill="${L.cloth}"/>
      <path d="M82 142 C86 170 92 190 100 206 C108 190 114 170 118 142 Z" fill="#F6EBD3"/>
      <path d="M88 142 L100 156 L112 142 Z" fill="#FFFFFF"/>
      <path d="M82 142 C86 170 92 190 100 206" fill="none" stroke="${L.dark}" stroke-width="3"/>
      <path d="M118 142 C114 170 108 190 100 206" fill="none" stroke="${L.dark}" stroke-width="3"/>
      <circle cx="91" cy="176" r="2.2" fill="${L.dark}"/>
      <circle cx="94" cy="190" r="2.2" fill="${L.dark}"/>`;
  }

  function hair(role, L) {
    if (role === "boss") {
      return {
        back: "",
        front: `<path d="M57 88 C54 52 80 37 104 38 C131 39 148 58 143 86 C137 66 120 57 101 60 C84 62 68 70 57 88 Z" fill="${L.hair}"/>
                <path d="M101 60 C110 52 128 54 138 66 C128 60 114 60 101 60 Z" fill="#463A35"/>`,
      };
    }
    return {
      back: `<path d="M53 94 C49 54 76 35 100 35 C126 35 152 54 147 94 L148 120 C141 126 133 123 131 115 L131 86 L69 86 L69 115 C67 123 59 126 52 120 Z" fill="${L.hair}"/>`,
      front: `<path d="M59 84 C61 57 80 45 100 45 C122 45 141 57 141 84 C129 71 116 66 104 70 C94 64 76 68 59 84 Z" fill="${L.hair}"/>`,
    };
  }

  function template(role) {
    const L = LOOK[role];
    const h = hair(role, L);
    const glasses = role === "boss"
      ? `<g class="p-glasses" fill="none" stroke="#2F2724" stroke-width="2.2"><circle cx="85" cy="93" r="10.5"/><circle cx="115" cy="93" r="10.5"/><path d="M95.5 93 h9"/></g>`
      : "";
    return `
<svg class="person" viewBox="0 0 200 210" role="img" aria-label="${L.label}" data-role="${role}" data-mood="calm">
  <ellipse class="p-shadow" cx="100" cy="203" rx="56" ry="6"/>
  <g class="p-body">
    ${outfit(role, L)}
    <rect x="91" y="120" width="18" height="24" rx="8" fill="${L.shade}"/>
    <g class="p-head">
      ${h.back}
      <ellipse cx="58.5" cy="94" rx="6.5" ry="9" fill="${L.shade}"/>
      <ellipse cx="141.5" cy="94" rx="6.5" ry="9" fill="${L.shade}"/>
      <circle cx="100" cy="90" r="42" fill="${L.skin}"/>
      <g class="p-cheeks" fill="#FF9F96"><ellipse cx="77" cy="106" rx="7.5" ry="4.5"/><ellipse cx="123" cy="106" rx="7.5" ry="4.5"/></g>
      <g class="p-face">
        <g class="p-eyes" fill="#2F2622"><ellipse class="p-eye" cx="85" cy="93" rx="3.6" ry="4.6"/><ellipse class="p-eye" cx="115" cy="93" rx="3.6" ry="4.6"/></g>
        <g class="p-brows" fill="none" stroke="#3B2F2A" stroke-width="2.6" stroke-linecap="round">
          <g class="p-brows-calm"><path d="M78 80 q7 -4 14 0"/><path d="M108 80 q7 -4 14 0"/></g>
          <g class="p-brows-worry"><path d="M78 81 q7 0 14 -5"/><path d="M108 76 q7 5 14 5"/></g>
          <g class="p-brows-furrow"><path d="M78 77 q7 1 14 5"/><path d="M108 82 q7 -4 14 -5"/></g>
        </g>
        ${glasses}
        <g fill="none" stroke="#3B2F2A" stroke-width="2.6" stroke-linecap="round">
          <path class="p-mouth p-mouth-calm" d="M93 111 q7 4.5 14 0"/>
          <path class="p-mouth p-mouth-smile" d="M90 108 q10 10 20 0"/>
          <path class="p-mouth p-mouth-wavy" d="M92 112 q4 -3 8 0 q4 3 8 0"/>
          <path class="p-mouth p-mouth-flat" d="M93 112 h14"/>
        </g>
        <ellipse class="p-mouth p-mouth-open" cx="100" cy="112" rx="6" ry="4.6" fill="#8A4038"/>
      </g>
      ${h.front}
    </g>
  </g>
  <g class="p-fx p-sweat"><path d="M150 66 q7 10 0 15 q-7 -5 0 -15 Z" fill="#9CC9F0" stroke="#7FB3E0" stroke-width="1"/></g>
  <g class="p-fx p-question"><circle cx="156" cy="50" r="15" fill="#EEF0FD"/><text x="156" y="57" text-anchor="middle" font-size="21" font-weight="800" fill="#5B6CD9" font-family="Hiragino Sans, sans-serif">?</text></g>
  <g class="p-fx p-shiver" fill="none" stroke="#C46BAE" stroke-width="2.4" stroke-linecap="round"><path d="M40 112 q-7 7 0 14"/><path d="M33 106 q-10 13 0 26"/><path d="M160 112 q7 7 0 14"/><path d="M167 106 q10 13 0 26"/></g>
  <g class="p-fx p-sparkle" fill="#F2B84B"><path d="M154 44 l3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3 Z"/><path d="M46 60 l2 4.5 4.5 2 -4.5 2 -2 4.5 -2 -4.5 -4.5 -2 4.5 -2 Z"/></g>
</svg>`;
  }

  class Person {
    constructor(container, role) {
      this.role = role;
      container.innerHTML = template(role);
      this.svg = container.querySelector(".person");
      this.mood = "calm";
      this.scheduleBlink();
    }

    // calm / uneasy / tense / listening / relieved
    setMood(mood) {
      this.mood = mood;
      if (!this.flashing) this.svg.dataset.mood = mood;
    }

    // 一時的な表情。終わったら setMood の状態に戻る
    flash(mood, ms = 2200) {
      this.flashing = true;
      this.svg.dataset.mood = mood;
      clearTimeout(this.flashTimer);
      this.flashTimer = setTimeout(() => {
        this.flashing = false;
        this.svg.dataset.mood = this.mood;
      }, ms);
    }

    setType(type) {
      this.svg.dataset.type = type || "";
    }

    setSpeaking(on) {
      this.svg.classList.toggle("is-speaking", !!on);
    }

    blink() {
      this.svg.classList.add("is-blinking");
      setTimeout(() => this.svg.classList.remove("is-blinking"), 140);
    }

    scheduleBlink() {
      setTimeout(() => {
        if (!document.hidden && this.svg.isConnected) this.blink();
        this.scheduleBlink();
      }, 2200 + Math.random() * 3800);
    }
  }

  return { create: (el, role) => new Person(el, role) };
})();
