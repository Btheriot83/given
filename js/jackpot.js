/**
 * Jackpot: the win show, Wheel of Fortune style. The iPhone app follows the same script, so the
 * timings and the words below are the spec (keep them in step with the app):
 *
 *   0.0 s  the winning row's tiles ding one at a time, left to right, 110 ms apart: each pops
 *          (scale 1 → 1.25 → 1), flashes white-hot and rings a rising chime.
 *   0.6 s  every marquee bulb on the page chases fast for 1.2 s, then all flash together 3 times.
 *   0.7 s  a big marquee sign drops in over the stage with the tier word; its letters light one
 *          by one like the puzzle board (a ding per letter, faster than the row) under a sweeping
 *          gold spotlight.
 *   0.8 s  confetti cannons fire from both bottom corners (gold, red, cream and green paper plus
 *          star sparkles) with the fanfare, a crowd cheer and an applause swell.
 *   2.8 s  the sign shrinks up and away into the result area; confetti falls until about 4 s.
 *
 * Tiers by guesses: 1–2 JACKPOT! (adds a falling shower of gold coins and stars), 3–4 WINNER!,
 * 5 SOLVED!, 6 PHEW!. A tap or key press anywhere skips to the end. Under reduced motion only the
 * sign fades in and out and the bulbs flash once; nothing flies. Sound goes through the shared
 * audio director, so the effects switch and the speaker mode apply (no sound when off).
 *
 * Everything that moves is transform or opacity, and all the paper and coins share one canvas.
 */

export const JACKPOT = Object.freeze({
  rowStep: 0.11,
  bulbsAt: 0.6,
  chaseFor: 1.2,
  flashes: 3,
  flashStep: 0.28,
  signAt: 0.7,
  letterLead: 0.22,
  letterStep: 0.075,
  cannonsAt: 0.8,
  exitAt: 2.8,
  exitFor: 0.5,
  confettiUntil: 4.0,
});

/** The tier for a win in `guesses` tries: the word on the sign and whether coins rain. */
export function jackpotTier(guesses) {
  if (guesses <= 2) return { id: "jackpot", word: "JACKPOT!", coins: true };
  if (guesses <= 4) return { id: "winner", word: "WINNER!", coins: false };
  if (guesses === 5) return { id: "solved", word: "SOLVED!", coins: false };
  return { id: "phew", word: "PHEW!", coins: false };
}

/** Which chime (1–6) and playback rate ring for tile or letter `i`: past the sixth, a step higher each. */
export function chimeFor(i) {
  if (i < 6) return { name: `jackpot_chime_${i + 1}`, rate: 1 };
  return { name: "jackpot_chime_6", rate: 2 ** ((2 * (i - 5)) / 12) };
}

const PAPER = ["#e7c06a", "#c9953b", "#ffd37a", "#d23a2a", "#8e1a16", "#fbf3dc", "#f3e6c4", "#1f8a4a", "#46e07a"];

export function createJackpot({ sound, reducedMotion }) {
  let run = null; // { timers, sounds, sign, fx, root, resolveExit, resolveSkip, skipped, done }

  const root = document.documentElement;
  const CLASSES = ["jp-show", "jp-chase", "jp-flash", "jp-flash-once"];

  function later(ms, fn) {
    run.timers.push(setTimeout(fn, ms));
  }

  function ding(name, opts) {
    const handle = sound.play(name, opts);
    if (handle) run.sounds.push(handle);
  }

  /**
   * Runs the show. `row` is the winning row; `target()` returns the element the sign shrinks
   * into. Resolves at the 2.8 s hand-off with `false`, or right away with `true` when skipped.
   */
  function play({ row, guesses, target }) {
    stop();
    const calm = reducedMotion.matches;
    const tier = jackpotTier(guesses);
    let resolveExit;
    let resolveSkip;
    const exit = new Promise((r) => { resolveExit = r; });
    const skippedP = new Promise((r) => { resolveSkip = r; });
    run = { timers: [], sounds: [], sign: null, fx: null, row, skipped: false, resolveExit, resolveSkip, skippedP, calm };
    root.classList.add("jp-show");
    root.dataset.jackpot = tier.id;

    // 0.0 s: the row dings.
    const tiles = row ? [...row.children] : [];
    tiles.forEach((tile, i) => {
      const { name, rate } = chimeFor(i);
      ding(name, { delay: i * JACKPOT.rowStep, rate });
      if (!calm) later(i * JACKPOT.rowStep * 1000, () => dingTile(tile));
    });

    // 0.6 s: the bulbs.
    if (calm) {
      later(JACKPOT.bulbsAt * 1000, () => root.classList.add("jp-flash-once"));
      later((JACKPOT.bulbsAt + JACKPOT.flashStep * 1.6) * 1000, () => root.classList.remove("jp-flash-once"));
    } else {
      later(JACKPOT.bulbsAt * 1000, () => root.classList.add("jp-chase"));
      later((JACKPOT.bulbsAt + JACKPOT.chaseFor) * 1000, () => {
        root.classList.remove("jp-chase");
        root.classList.add("jp-flash");
      });
      later((JACKPOT.bulbsAt + JACKPOT.chaseFor + JACKPOT.flashes * JACKPOT.flashStep) * 1000, () => root.classList.remove("jp-flash"));
    }

    // 0.7 s: the sign, and a ding per letter as it lights.
    later(JACKPOT.signAt * 1000, () => { run.sign = mountSign(tier, calm); });
    const letters = [...tier.word];
    letters.forEach((_, i) => {
      const { name, rate } = chimeFor(i);
      const at = calm ? JACKPOT.signAt + 0.2 : JACKPOT.signAt + JACKPOT.letterLead + i * JACKPOT.letterStep;
      if (!calm || i === 0) ding(name, { delay: at, rate: calm ? 1 : rate, gain: 0.75 });
    });

    // 0.8 s: the cannons and the crowd (the fanfare is fired by the caller with the same lead).
    ding("jackpot_cheer", { delay: JACKPOT.cannonsAt });
    if (!calm) later(JACKPOT.cannonsAt * 1000, () => { run.fx = confetti(tier.coins); });

    // 2.8 s: the sign heads for the result area; the show hands the stage back.
    later(JACKPOT.exitAt * 1000, () => {
      exitSign(run.sign, target?.(), calm);
      resolveExit(false);
    });
    later((JACKPOT.exitAt + JACKPOT.exitFor) * 1000 + 60, () => { run?.sign?.remove(); });
    later((JACKPOT.confettiUntil + 0.3) * 1000, finish);

    addEventListener("pointerdown", onSkip, true);
    addEventListener("keydown", onSkip, true);
    return Promise.race([exit, skippedP]);
  }

  function onSkip(e) {
    if (!run || run.skipped) return;
    if (e.type === "keydown" && (e.metaKey || e.ctrlKey || e.altKey || e.key === "Tab" || e.repeat)) return;
    run.skipped = true;
    // Before the stub is up, the layout jumps under the finger; after it, taps go through.
    if (e.type === "pointerdown" && !run.released) swallowClick();
    if (!run.released) for (const s of run.sounds) s.stop(0.25);
    run.resolveSkip(true);
    run.resolveExit(true);
    finish();
  }

  /** The tap that skipped must not also press whatever lands under the finger. */
  function swallowClick() {
    const eat = (ev) => { ev.preventDefault(); ev.stopPropagation(); };
    addEventListener("click", eat, { capture: true, once: true });
    setTimeout(() => removeEventListener("click", eat, true), 700);
  }

  /** The finished page is up: from here a tap only clears the falling paper, and still counts. */
  function release() {
    if (run) run.released = true;
  }

  /** While the show runs: resolves `true` the moment it is skipped, else `false` after `ms`. */
  function hold(ms) {
    if (!run) return new Promise((r) => setTimeout(() => r(false), ms));
    return Promise.race([new Promise((r) => setTimeout(() => r(false), ms)), run.skippedP]);
  }

  /** Clears the stage: timers, sign, canvas, bulb classes, tile flashes. Sounds already ringing finish. */
  function finish() {
    if (!run) return;
    const r = run;
    run = null;
    r.timers.forEach(clearTimeout);
    r.sign?.remove();
    r.fx?.stop();
    document.querySelectorAll(".jp-sign").forEach((el) => el.remove());
    root.classList.remove(...CLASSES);
    delete root.dataset.jackpot;
    r.row?.querySelectorAll(".jp-hot").forEach((el) => el.remove());
    // .jp-ding stays on the tiles (its animation is over); taking it off would replay the flip.
    // renderBoard clears it when the row is reused for a new game.
    removeEventListener("pointerdown", onSkip, true);
    removeEventListener("keydown", onSkip, true);
    r.resolveExit(r.skipped);
  }

  /** Leaving mid-show: everything stops, sounds included. */
  function stop() {
    if (!run) return;
    for (const s of run.sounds) s.stop(0.15);
    finish();
  }

  return {
    play, hold, stop, release, skip: () => onSkip({ type: "skip" }),
    get running() { return Boolean(run); },
    get skipped() { return Boolean(run?.skipped); },
  };
}

function dingTile(tile) {
  tile.classList.remove("jp-ding");
  void tile.offsetWidth;
  const hot = document.createElement("span");
  hot.className = "jp-hot";
  hot.setAttribute("aria-hidden", "true");
  tile.append(hot);
  tile.classList.add("jp-ding");
  setTimeout(() => hot.remove(), 700);
}

// ---------- The sign ----------

function mountSign(tier, calm) {
  const sign = document.createElement("div");
  sign.className = `jp-sign ${calm ? "calm" : "drop"}`;
  sign.dataset.tier = tier.id;
  sign.setAttribute("aria-hidden", "true");
  const letters = [...tier.word]
    .map((ch, i) => `<span class="jp-letter" style="--i:${i}"><i class="jp-face">${ch}</i><i class="jp-glare"></i></span>`)
    .join("");
  sign.innerHTML = `<div class="jp-swing"><div class="jp-frame">
    <span class="jp-ring"></span>
    <div class="jp-board" style="--n:${tier.word.length}">${letters}</div>
    <span class="jp-sweep"></span>
  </div></div>`;
  document.body.append(sign);
  ringBulbs(sign.querySelector(".jp-ring"), sign.querySelector(".jp-frame"));
  return sign;
}

/** A ring of marquee bulbs around the sign, in the same three chase phases as the page's. */
function ringBulbs(layer, frame) {
  const w = frame.offsetWidth;
  const h = frame.offsetHeight;
  if (!w || !h) return;
  const inset = 9;
  const r = 14;
  const spacing = 17;
  const bw = w - 2 * inset;
  const bh = h - 2 * inset;
  const sx = bw - 2 * r;
  const sy = bh - 2 * r;
  const arc = (Math.PI / 2) * r;
  const total = 2 * sx + 2 * sy + 4 * arc;
  const n = Math.max(12, Math.round(total / spacing / 3) * 3);
  const at = (s0) => {
    let s = s0;
    const o = inset;
    if (s < sx) return [o + r + s, o];
    s -= sx;
    if (s < arc) { const a = -Math.PI / 2 + s / r; return [o + bw - r + r * Math.cos(a), o + r + r * Math.sin(a)]; }
    s -= arc;
    if (s < sy) return [o + bw, o + r + s];
    s -= sy;
    if (s < arc) { const a = s / r; return [o + bw - r + r * Math.cos(a), o + bh - r + r * Math.sin(a)]; }
    s -= arc;
    if (s < sx) return [o + bw - r - s, o + bh];
    s -= sx;
    if (s < arc) { const a = Math.PI / 2 + s / r; return [o + r + r * Math.cos(a), o + bh - r + r * Math.sin(a)]; }
    s -= arc;
    if (s < sy) return [o, o + bh - r - s];
    s -= sy;
    const a = Math.PI + s / r;
    return [o + r + r * Math.cos(a), o + r + r * Math.sin(a)];
  };
  const base = [];
  const phases = ["", "", ""];
  for (let i = 0; i < n; i++) {
    const [x, y] = at((i / n) * total);
    base.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6"/>`);
    phases[i % 3] += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="8"/>`;
  }
  layer.innerHTML = `<svg class="bulbs bulbs-chase" viewBox="0 0 ${w} ${h}" focusable="false">
    <defs><radialGradient id="jpGlow"><stop offset="0" stop-color="#fff"/><stop offset=".22" stop-color="#fff" stop-opacity=".92"/><stop offset=".34" stop-color="#ffd37a"/><stop offset=".6" stop-color="#ffd37a" stop-opacity=".35"/><stop offset="1" stop-color="#ffd37a" stop-opacity="0"/></radialGradient></defs>
    <g class="bulb-gold">${base.join("")}</g>
    ${phases.map((dots, i) => `<g class="ph${i}" fill="url(#jpGlow)">${dots}</g>`).join("")}
  </svg>`;
}

/** At 2.8 s the sign shrinks up and away into `target` (the result area); under reduced motion it fades. */
function exitSign(sign, target, calm) {
  if (!sign) return;
  if (!calm && target && !target.hidden) {
    const a = sign.querySelector(".jp-frame").getBoundingClientRect();
    const b = target.getBoundingClientRect();
    if (b.width && a.width) {
      const dx = b.left + b.width / 2 - (a.left + a.width / 2);
      const dy = b.top + b.height / 2 - (a.top + a.height / 2);
      sign.style.setProperty("--jp-dx", `${dx.toFixed(1)}px`);
      sign.style.setProperty("--jp-dy", `${dy.toFixed(1)}px`);
      sign.style.setProperty("--jp-s", Math.max(0.18, Math.min(0.6, b.width / a.width)).toFixed(3));
    }
  }
  sign.classList.add("out");
}

// ---------- Confetti, coins and stars: one canvas ----------

function confetti(coins) {
  const canvas = document.createElement("canvas");
  canvas.className = "jp-confetti";
  canvas.setAttribute("aria-hidden", "true");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = window.innerWidth;
  const H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  document.body.append(canvas);
  const ctx = canvas.getContext("2d");
  const rand = (a, b) => a + Math.random() * (b - a);
  const parts = [];
  const begin = performance.now();
  const until = (JACKPOT.confettiUntil - JACKPOT.cannonsAt) * 1000;
  const lift = Math.sqrt(H) * 88; // launch speed that carries paper most of the way up the screen

  function volley(count, power) {
    for (const side of [-1, 1]) {
      for (let i = 0; i < count; i++) {
        const angle = (rand(56, 82) * Math.PI) / 180; // above the horizon, aimed inward
        const v = lift * power * rand(0.72, 1.12);
        const star = i % 9 === 0;
        parts.push({
          kind: star ? "spark" : "paper",
          x: side < 0 ? rand(-6, 14) : W - rand(-6, 14),
          y: H + rand(0, 12),
          vx: -side * Math.cos(angle) * v,
          vy: -Math.sin(angle) * v,
          rot: rand(0, 6.28), vr: rand(-9, 9),
          flip: rand(0, 6.28), vf: rand(5, 13),
          w: rand(6, 11), h: rand(9, 15),
          color: PAPER[(Math.random() * PAPER.length) | 0],
          sway: rand(0.6, 1.6), phase: rand(0, 6.28),
          size: rand(4, 7),
          drag: star ? 1.6 : rand(2.1, 2.8),
          born: 0,
        });
      }
    }
  }
  volley(70, 1);
  const spawns = [[350, () => volley(34, 0.85)]];
  if (coins) {
    for (let k = 0; k < 9; k++) spawns.push([200 + k * 170, () => rain(7)]);
  }

  function rain(count) {
    for (let i = 0; i < count; i++) {
      const coin = Math.random() < 0.68;
      parts.push({
        kind: coin ? "coin" : "star",
        x: rand(8, W - 8), y: rand(-60, -14),
        vx: rand(-30, 30), vy: rand(220, 420),
        rot: rand(0, 6.28), vr: rand(-3, 3),
        flip: rand(0, 6.28), vf: rand(6, 11),
        size: coin ? rand(9, 13) : rand(7, 11),
        drag: 0.25, sway: 0, phase: 0, born: 0,
      });
    }
  }

  let last = begin;
  let frame = 0;
  let stopped = false;
  const g = 1500;

  function step(now) {
    if (stopped) return;
    const dt = Math.min(0.034, (now - last) / 1000);
    last = now;
    const t = now - begin;
    while (spawns.length && spawns[0][0] <= t) spawns.shift()[1]();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const fade = t > until - 500 ? Math.max(0, (until - t) / 500) : 1;
    let alive = 0;
    for (const p of parts) {
      if (p.dead) continue;
      p.vy += g * (p.kind === "coin" || p.kind === "star" ? 0.35 : 1) * dt;
      const k = Math.exp(-p.drag * dt);
      p.vx *= k;
      p.vy *= k;
      p.x += (p.vx + Math.sin(t / 1000 * 3 * p.sway + p.phase) * 40 * p.sway * (p.vy > 0 ? 1 : 0)) * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      p.flip += p.vf * dt;
      if (p.y > H + 40 || p.x < -60 || p.x > W + 60) { p.dead = true; continue; }
      alive++;
      draw(p, t, fade);
    }
    if (t < until && (alive || spawns.length)) frame = requestAnimationFrame(step);
    else stop();
  }

  function draw(p, t, fade) {
    const c = Math.cos(p.rot) * dpr;
    const s = Math.sin(p.rot) * dpr;
    ctx.setTransform(c, s, -s, c, p.x * dpr, p.y * dpr);
    ctx.globalAlpha = fade;
    if (p.kind === "paper") {
      const sy = Math.cos(p.flip);
      ctx.scale(1, sy || 0.05);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      if (sy < 0) { ctx.fillStyle = "rgba(0,0,0,.22)"; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); }
    } else if (p.kind === "coin") {
      const sx = Math.cos(p.flip);
      ctx.scale(Math.abs(sx) < 0.08 ? 0.08 : Math.abs(sx), 1);
      ctx.fillStyle = "#8a6124";
      circle(0, 0, p.size);
      ctx.fillStyle = sx > 0 ? "#f2cf72" : "#d9a845";
      circle(0, 0, p.size * 0.82);
      ctx.fillStyle = "#fff3c8";
      ctx.fillRect(-p.size * 0.12, -p.size * 0.5, p.size * 0.24, p.size);
    } else {
      const tw = p.kind === "spark" ? 0.55 + 0.45 * Math.sin(t / 60 + p.phase * 4) : 1;
      ctx.globalAlpha = fade * tw;
      ctx.fillStyle = p.kind === "spark" ? "#fffdf5" : "#ffd37a";
      starPath(p.kind === "spark" ? 4 : 5, p.size, p.kind === "spark" ? 0.28 : 0.45);
      ctx.fill();
    }
  }

  function circle(x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 6.2832);
    ctx.fill();
  }

  function starPath(points, r, inner) {
    ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
      const rr = i % 2 ? r * inner : r;
      const a = (i * Math.PI) / points - Math.PI / 2;
      i ? ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    canvas.remove();
  }

  frame = requestAnimationFrame(step);
  return { stop, canvas };
}
