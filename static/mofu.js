// もふもふキャラクター「ミナト」: SVG描画・まばたき・視線・状態アニメーション
const Mofu = (() => {
  let uid = 0;
  const instances = new Set();

  function template(id) {
    return `
<svg class="mofu" viewBox="0 0 240 240" role="img" aria-label="ミナト" data-state="idle">
  <defs>
    <radialGradient id="${id}-fur" cx="42%" cy="34%" r="72%">
      <stop offset="0" stop-color="#FFFDF9"/>
      <stop offset="0.5" stop-color="#FCEBD6"/>
      <stop offset="1" stop-color="#EDCDA8"/>
    </radialGradient>
    <radialGradient id="${id}-face" cx="50%" cy="40%" r="60%">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.95"/>
      <stop offset="1" stop-color="#FFF8EE" stop-opacity="0"/>
    </radialGradient>
    <filter id="${id}-fluff" x="-25%" y="-25%" width="150%" height="150%">
      <feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves="3" seed="4" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="16" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <filter id="${id}-fluff2" x="-25%" y="-25%" width="150%" height="150%">
      <feTurbulence type="fractalNoise" baseFrequency="0.95" numOctaves="2" seed="11" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="8" xChannelSelector="G" yChannelSelector="R"/>
    </filter>
    <filter id="${id}-blur" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="3.2"/>
    </filter>
  </defs>

  <ellipse class="mofu-shadow" cx="120" cy="224" rx="60" ry="7"/>

  <g class="mofu-body">
    <g class="mofu-ear mofu-ear-l">
      <ellipse cx="74" cy="66" rx="19" ry="25" fill="#E8C9A5" filter="url(#${id}-fluff2)"/>
      <ellipse cx="74" cy="68" rx="9" ry="13" fill="#FFD3C8"/>
    </g>
    <g class="mofu-ear mofu-ear-r">
      <ellipse cx="166" cy="66" rx="19" ry="25" fill="#E8C9A5" filter="url(#${id}-fluff2)"/>
      <ellipse cx="166" cy="68" rx="9" ry="13" fill="#FFD3C8"/>
    </g>

    <circle cx="120" cy="131" r="89" fill="#DDBA93" filter="url(#${id}-fluff)"/>
    <circle cx="120" cy="130" r="85" fill="#F0D6B6" filter="url(#${id}-fluff)"/>
    <circle cx="120" cy="130" r="81" fill="url(#${id}-fur)" filter="url(#${id}-fluff2)"/>
    <circle cx="120" cy="130" r="76" fill="url(#${id}-fur)"/>
    <ellipse cx="120" cy="140" rx="58" ry="48" fill="url(#${id}-face)"/>

    <g class="mofu-tuft" filter="url(#${id}-fluff2)">
      <circle cx="108" cy="52" r="12" fill="#FFF6EA"/>
      <circle cx="122" cy="45" r="14" fill="#FFF8EE"/>
      <circle cx="134" cy="53" r="10" fill="#FFF3E4"/>
    </g>

    <g class="mofu-cheeks" filter="url(#${id}-blur)">
      <ellipse cx="80" cy="148" rx="14" ry="8.5" fill="#FFA9A3"/>
      <ellipse cx="160" cy="148" rx="14" ry="8.5" fill="#FFA9A3"/>
    </g>

    <g class="mofu-look">
      <g class="mofu-eyes">
        <g class="mofu-eye">
          <ellipse cx="96" cy="124" rx="9.5" ry="12.5" fill="#3A2E29"/>
          <circle cx="99.5" cy="118.5" r="3.8" fill="#fff"/>
          <circle cx="93" cy="129" r="1.6" fill="#fff" opacity="0.8"/>
        </g>
        <g class="mofu-eye">
          <ellipse cx="144" cy="124" rx="9.5" ry="12.5" fill="#3A2E29"/>
          <circle cx="147.5" cy="118.5" r="3.8" fill="#fff"/>
          <circle cx="141" cy="129" r="1.6" fill="#fff" opacity="0.8"/>
        </g>
      </g>
      <g class="mofu-happy-eyes" fill="none" stroke="#3A2E29" stroke-width="4" stroke-linecap="round">
        <path d="M86 127 Q96 114 106 127"/>
        <path d="M134 127 Q144 114 154 127"/>
      </g>
    </g>

    <g class="mofu-mouth">
      <path class="mofu-mouth-closed" d="M111 146 q4.5 5.5 9 0 q4.5 5.5 9 0" fill="none" stroke="#3A2E29" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
      <g class="mofu-mouth-open">
        <ellipse cx="120" cy="150" rx="7" ry="6" fill="#7A3B33"/>
        <ellipse cx="120" cy="153" rx="4" ry="2.4" fill="#FF8F86"/>
      </g>
    </g>

    <g class="mofu-paw mofu-paw-l">
      <ellipse cx="60" cy="170" rx="15" ry="13" fill="#F1DABD" filter="url(#${id}-fluff2)"/>
    </g>
    <g class="mofu-paw mofu-paw-r">
      <ellipse cx="180" cy="170" rx="15" ry="13" fill="#F1DABD" filter="url(#${id}-fluff2)"/>
    </g>

    <g class="mofu-feet" filter="url(#${id}-fluff2)">
      <ellipse cx="96" cy="210" rx="17" ry="10" fill="#E8C9A5"/>
      <ellipse cx="144" cy="210" rx="17" ry="10" fill="#E8C9A5"/>
    </g>
  </g>

  <g class="mofu-waves" fill="none" stroke="#E9785F" stroke-width="3" stroke-linecap="round">
    <path d="M196 54 q8 10 0 20"/>
    <path d="M206 46 q13 18 0 36"/>
  </g>
  <g class="mofu-dots" fill="#B9AEA5">
    <circle cx="186" cy="40" r="5"/>
    <circle cx="202" cy="30" r="5"/>
    <circle cx="218" cy="20" r="5"/>
  </g>
</svg>`;
  }

  class Character {
    constructor(container, { follow = false } = {}) {
      this.id = "mofu" + ++uid;
      container.innerHTML = template(this.id);
      this.svg = container.querySelector(".mofu");
      this.look = this.svg.querySelector(".mofu-look");
      this.follow = follow;
      this.baseState = "idle";
      instances.add(this);
      this.scheduleBlink();
    }

    setState(state) {
      this.baseState = state;
      if (!this.svg.classList.contains("is-reacting")) this.svg.dataset.state = state;
    }

    blink() {
      this.svg.classList.add("is-blinking");
      setTimeout(() => this.svg.classList.remove("is-blinking"), 150);
    }

    scheduleBlink() {
      const delay = 1800 + Math.random() * 3400;
      setTimeout(() => {
        if (this.isVisible()) {
          this.blink();
          if (Math.random() < 0.28) setTimeout(() => this.blink(), 280);
        }
        this.scheduleBlink();
      }, delay);
    }

    isVisible() {
      return !document.hidden && this.svg.isConnected && this.svg.getBoundingClientRect().width > 0;
    }

    // 挙手やにっこりなど一時的なリアクション。終わったら元の状態に戻る
    react(kind, duration = 1000) {
      this.svg.classList.remove("do-raise", "do-jump");
      void this.svg.getBoundingClientRect();
      if (kind === "happy") {
        this.svg.classList.add("is-reacting");
        this.svg.dataset.state = "happy";
      } else {
        this.svg.classList.add("do-" + kind);
      }
      clearTimeout(this.reactTimer);
      this.reactTimer = setTimeout(() => {
        this.svg.classList.remove("do-raise", "do-jump", "is-reacting");
        this.svg.dataset.state = this.baseState;
      }, duration);
    }

    // 話す前の「手を挙げて待つ」。下ろすまで保持する
    holdRaise(on) {
      this.svg.classList.toggle("is-raised", !!on);
    }

    lookAt(clientX, clientY) {
      const r = this.svg.getBoundingClientRect();
      if (!r.width) return;
      const dx = (clientX - (r.left + r.width / 2)) / (window.innerWidth / 2);
      const dy = (clientY - (r.top + r.height * 0.52)) / (window.innerHeight / 2);
      const clamp = (v) => Math.max(-1, Math.min(1, v));
      this.look.style.transform = `translate(${clamp(dx) * 6}px, ${clamp(dy) * 4}px)`;
    }
  }

  document.addEventListener("pointermove", (e) => {
    for (const m of instances) if (m.follow) m.lookAt(e.clientX, e.clientY);
  });

  return { create: (el, opts) => new Character(el, opts) };
})();
