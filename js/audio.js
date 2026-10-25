/**
 * Every sound in Named on the web, after Named/Services/AudioDirector.swift: the same files
 * (audio/, converted from the app's Resources/Audio), the same levels and the same moments.
 *
 * Browsers only allow sound after the player touches the page, so nothing loads or plays
 * until the first tap or key press (`unlock`). Effects are decoded once into buffers so a key
 * tap has no lag and sounds can overlap. The music is one seamless loop per show (A for the
 * daily, B for obscure and practice) that ducks under sheets, fades under the win fanfare and
 * stops while the tab is hidden. On Safari the session starts "ambient": the ring/silent switch
 * mutes Named and the player's own podcast or playlist keeps playing. Once the player turns sound
 * on themselves (the speaker or the Music switch), the session becomes "playback" so the show
 * plays even with the iPhone on silent (`setPlayback`).
 */

/** Whether this browser exposes the Audio Session API (Safari 16.4+), i.e. has a silent-switch mode. */
export const hasAudioSession = () => typeof navigator !== "undefined" && "audioSession" in navigator;

const BASE = "audio/";
/** Relative levels from the app's reference mix (Sound.gain). */
const EFFECTS = {
  key_tap_1: 0.8, key_tap_2: 0.8, key_tap_3: 0.8, key_delete: 0.8,
  tile_flip: 0.75,
  bulb_correct: 0.55, bulb_present: 0.55, bulb_absent: 0.8,
  invalid_buzz: 0.5,
  ui_tap: 0.6,
  curtain_whoosh: 0.7,
  ticket_tear: 0.85,
  win_sparkle: 0.85,
};
const LOOPS = { daily: "music_loop", late: "music_loop_alt" };
const FANFARES = { a: "win_fanfare", b: "win_fanfare_alt" };
const MUSIC_LEVEL = 0.4;
const FANFARE_LEVEL = 0.8;

export function createAudio({ music = true, effects = true, playback = false } = {}) {
  let ctx = null;
  let musicBus = null;
  let fanfareBus = null;
  const buffers = new Map();
  const loading = new Map();
  const lastPlayed = new Map();
  let lastTap = null;
  let show = "daily";
  let loop = null; // { name, source, gain }
  let ducked = false;
  let holding = false; // the win fanfare has the stage
  let holdTimer = 0;
  let visible = typeof document === "undefined" || !document.hidden;
  const state = { music, effects, playback: Boolean(playback) };

  function applySession() {
    try {
      if (hasAudioSession()) navigator.audioSession.type = state.playback ? "playback" : "ambient";
    } catch { /* older Safari */ }
  }

  const now = () => ctx.currentTime;
  const musicTarget = () => (ducked ? MUSIC_LEVEL * 0.4 : MUSIC_LEVEL);
  const musicShouldPlay = () => state.music && visible && !holding;

  function load(name) {
    if (buffers.has(name)) return Promise.resolve(buffers.get(name));
    if (!loading.has(name)) {
      loading.set(name, fetch(`${BASE}${name}.m4a`)
        .then((r) => { if (!r.ok) throw new Error(name); return r.arrayBuffer(); })
        .then((data) => new Promise((resolve, reject) => ctx.decodeAudioData(data, resolve, reject)))
        .then((buffer) => { buffers.set(name, buffer); return buffer; })
        .catch(() => null)
        .finally(() => loading.delete(name)));
    }
    return loading.get(name);
  }

  function ramp(param, value, seconds) {
    const t = now();
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.linearRampToValueAtTime(value, t + Math.max(seconds, 0.01));
  }

  /** Called from the first tap or key press: creates the audio context inside the gesture. */
  function unlock() {
    if (ctx) {
      if (ctx.state === "suspended" && visible) ctx.resume().catch(() => {});
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    applySession();
    ctx = new Ctx({ latencyHint: "interactive" });
    musicBus = ctx.createGain();
    musicBus.gain.value = 1;
    musicBus.connect(ctx.destination);
    fanfareBus = ctx.createGain();
    fanfareBus.gain.value = FANFARE_LEVEL;
    fanfareBus.connect(ctx.destination);
    // iOS needs a sound started inside the gesture to wake the output.
    const blip = ctx.createBufferSource();
    blip.buffer = ctx.createBuffer(1, 1, 22050);
    blip.connect(ctx.destination);
    blip.start();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    if (state.effects) Object.keys(EFFECTS).forEach(load);
    startMusic();
  }

  // ---------- Effects ----------

  /** Plays an effect after `delay` seconds. The same sound never fires twice within 40 ms. */
  function play(name, { delay = 0, gain = 1, maxDuration = null } = {}) {
    if (!ctx || !state.effects || !(name in EFFECTS)) return;
    const buffer = buffers.get(name);
    if (!buffer) { load(name); return; }
    const at = now() + Math.max(0, delay);
    const last = lastPlayed.get(name);
    if (last !== undefined && Math.abs(at - last) < 0.04) return;
    lastPlayed.set(name, at);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const level = ctx.createGain();
    level.gain.value = EFFECTS[name] * gain;
    source.connect(level).connect(ctx.destination);
    source.start(at);
    if (maxDuration) {
      // A quick fade instead of a click.
      level.gain.setValueAtTime(EFFECTS[name] * gain, at + maxDuration);
      level.gain.linearRampToValueAtTime(0, at + maxDuration + 0.072);
      source.stop(at + maxDuration + 0.08);
    }
  }

  /** Rotates the three key-tap takes, never the same one twice in a row. */
  function keyTap() {
    const takes = ["key_tap_1", "key_tap_2", "key_tap_3"].filter((t) => t !== lastTap);
    lastTap = takes[Math.floor(Math.random() * takes.length)];
    play(lastTap);
  }

  // ---------- Music ----------

  async function startMusic(fade = 1.2) {
    if (!ctx || !musicShouldPlay()) return;
    const name = LOOPS[show];
    if (loop?.name === name) {
      ramp(loop.gain.gain, musicTarget(), fade);
      return;
    }
    const buffer = await load(name);
    if (!buffer || !musicShouldPlay() || LOOPS[show] !== name || loop?.name === name) return;
    const old = loop;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(musicBus);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(gain);
    source.start();
    loop = { name, source, gain };
    ramp(gain.gain, musicTarget(), old ? 0.6 : fade);
    if (old) retire(old, 0.6);
  }

  function retire(old, fade) {
    ramp(old.gain.gain, 0, fade);
    setTimeout(() => {
      try { old.source.stop(); } catch { /* already stopped */ }
      old.gain.disconnect();
      // Keep only the playing loop decoded: a two-minute loop is tens of MB of samples.
      if (loop?.name !== old.name) buffers.delete(old.name);
    }, fade * 1000 + 80);
  }

  function stopMusic(fade = 0.8) {
    if (!ctx || !loop) return;
    const old = loop;
    loop = null;
    retire(old, fade);
  }

  /** "daily" plays loop A; "late" (obscure and practice) plays loop B. Crossfades over 0.6 s. */
  function setShow(next) {
    if (next === show || !LOOPS[next]) return;
    show = next;
    if (ctx && loop && musicShouldPlay()) startMusic(0.6);
  }

  function duck(on) {
    ducked = Boolean(on);
    if (ctx && loop && !holding) ramp(loop.gain.gain, musicTarget(), 0.35);
  }

  /**
   * The win: the loop fades out over 0.3 s, then the sparkle and the fanfare play together and
   * the loop comes back afterwards. `alternate` is fanfare B (plain daily wins).
   */
  async function playWin(alternate) {
    if (!ctx) return;
    clearTimeout(holdTimer);
    holding = true;
    if (loop) ramp(loop.gain.gain, 0, 0.3);
    const name = FANFARES[alternate ? "b" : "a"];
    const fanfare = state.effects || state.music ? await load(name) : null;
    const start = now() + 0.3;
    play("win_sparkle", { delay: 0.3 });
    let length = 2.5;
    if (fanfare) {
      const source = ctx.createBufferSource();
      source.buffer = fanfare;
      source.connect(fanfareBus);
      source.start(start);
      length = fanfare.duration;
    }
    holdTimer = setTimeout(() => {
      holding = false;
      if (musicShouldPlay()) startMusic(1.5);
    }, (0.3 + length + 0.3) * 1000);
  }

  // ---------- Settings and the tab ----------

  function setMusic(on) {
    state.music = Boolean(on);
    if (!ctx) return;
    if (state.music) startMusic();
    else stopMusic(0.6);
  }

  /** "playback" plays through the silent switch; "ambient" (the default) respects it. */
  function setPlayback(on) {
    state.playback = Boolean(on);
    applySession();
    if (ctx && ctx.state === "suspended" && visible) ctx.resume().catch(() => {});
  }

  function setEffects(on) {
    state.effects = Boolean(on);
    if (ctx && state.effects) Object.keys(EFFECTS).forEach(load);
  }

  function setVisible(isVisible) {
    visible = isVisible;
    if (!ctx) return;
    if (visible) {
      ctx.resume().catch(() => {});
      startMusic();
    } else {
      stopMusic(0.4);
      setTimeout(() => { if (!visible) ctx.suspend().catch(() => {}); }, 500);
    }
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => setVisible(!document.hidden));
    window.addEventListener("pagehide", () => setVisible(false));
    window.addEventListener("pageshow", () => setVisible(!document.hidden));
  }

  return {
    unlock, play, keyTap, setShow, duck, playWin, setMusic, setEffects, setPlayback,
    get unlocked() { return Boolean(ctx); },
    /** For tests and debugging: what is loaded and playing. */
    debug() {
      return {
        context: ctx?.state || "none", music: state.music, effects: state.effects, playback: state.playback,
        session: hasAudioSession() ? navigator.audioSession.type : "unsupported", show, ducked, holding,
        loop: loop?.name || null, loaded: [...buffers.keys()].sort(),
      };
    },
  };
}
