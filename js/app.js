import {
  MAX_GUESSES,
  normalizePracticeLength,
  createGame,
  migrateSavedGame,
  typeLetter,
  backspace,
  submitGuess,
  pickDailyPuzzle,
  pickObscurePuzzle,
  pickRandomPuzzle,
  bestKeyStates,
  shareGrid,
  localDateKey,
  puzzleNumber,
  applyStreak,
  evaluateGuess,
  shiftDateKey,
  historyEndDate,
  HISTORY_START_DATE,
} from "./engine.js";
import { normalizeGroup } from "./leaderboard-core.js";
import {
  factCard,
  nameStory,
  meaningLine,
  sourcesLine,
  cultureKindLine,
  cultureTitle,
  titleCase as storyTitleCase,
} from "./name-story.js";
import { createAudio } from "./audio.js";

const KEYS = ["QWERTYUIOP".split(""), "ASDFGHJKL".split(""), ["ENTER", ..."ZXCVBNM".split(""), "DEL"]];
const STORAGE = "given-v2";
const SHARE_URL = "https://namedgame.com";

const els = {
  board: document.getElementById("board"),
  puzzleMeta: document.getElementById("puzzleMeta"),
  puzzleSwitch: document.getElementById("puzzleSwitch"),
  nextDayNote: document.getElementById("nextDayNote"),
  practiceLengthLink: document.getElementById("practiceLengthLink"),
  outcome: document.getElementById("outcome"),
  outcomeTitle: document.getElementById("outcomeTitle"),
  outcomeDetail: document.getElementById("outcomeDetail"),
  nextNameBtn: document.getElementById("nextNameBtn"),
  finishFx: document.getElementById("finishFx"),
  keyboard: document.getElementById("keyboard"),
  toast: document.getElementById("toast"),
  countdown: document.getElementById("countdown"),
  help: document.getElementById("helpOverlay"),
  stats: document.getElementById("statsOverlay"),
  settings: document.getElementById("settingsOverlay"),
  statsRow: document.getElementById("statsRow"),
  statsScopeNote: document.getElementById("statsScopeNote"),
  resultPanel: document.getElementById("resultPanel"),
  resultKicker: document.getElementById("resultKicker"),
  resultTitle: document.getElementById("resultTitle"),
  resultCopy: document.getElementById("resultCopy"),
  nameNote: document.getElementById("nameNote"),
  nameNoteText: document.getElementById("nameNoteText"),
  dist: document.getElementById("dist"),
  reveal: document.getElementById("reveal"),
  darkSwitch: document.getElementById("darkSwitch"),
  cbSwitch: document.getElementById("cbSwitch"),
  hardSwitch: document.getElementById("hardSwitch"),
  practiceLengthOptions: document.querySelectorAll("[data-practice-length]"),
  startPracticeFromSettings: document.getElementById("startPracticeFromSettings"),
  shareBtn: document.getElementById("shareBtn"),
  practiceBtn: document.getElementById("practiceBtn"),
  statsObscureBtn: document.getElementById("statsObscureBtn"),
  todayBtn: document.getElementById("todayBtn"),
  ex1: document.getElementById("ex1"),
  friends: document.getElementById("friendsOverlay"),
  friendsForm: document.getElementById("friendsForm"),
  friendsActive: document.getElementById("friendsActive"),
  nickname: document.getElementById("nickname"),
  groupCode: document.getElementById("groupCode"),
  activeGroupCode: document.getElementById("activeGroupCode"),
  friendsStatus: document.getElementById("friendsStatus"),
  leaderboardList: document.getElementById("leaderboardList"),
  app: document.querySelector(".app"),
  marqueePill: document.getElementById("marqueePill"),
  resultStub: document.getElementById("resultStub"),
  stubName: document.getElementById("stubName"),
  stubScore: document.getElementById("stubScore"),
  stubKicker: document.getElementById("stubKicker"),
  stubWord: document.getElementById("stubWord"),
  factHeadline: document.getElementById("factHeadline"),
  factChips: document.getElementById("factChips"),
  storyLink: document.getElementById("storyLink"),
  storyCard: document.getElementById("storyCard"),
  storyTitle: document.getElementById("storyTitle"),
  storyBody: document.getElementById("storyBody"),
  storySources: document.getElementById("storySources"),
  boardPrompt: document.getElementById("boardPrompt"),
  promptJoin: document.getElementById("promptJoin"),
  promptLead: document.getElementById("promptLead"),
  promptNickname: document.getElementById("promptNickname"),
  promptCodeRow: document.getElementById("promptCodeRow"),
  promptCode: document.getElementById("promptCode"),
  promptError: document.getElementById("promptError"),
  promptStartBtn: document.getElementById("promptStartBtn"),
  promptJoinBtn: document.getElementById("promptJoinBtn"),
  promptDone: document.getElementById("promptDone"),
  promptStatus: document.getElementById("promptStatus"),
  promptCopyBtn: document.getElementById("promptCopyBtn"),
  promptSeeBtn: document.getElementById("promptSeeBtn"),
  soundBtn: document.getElementById("soundBtn"),
  musicSwitch: document.getElementById("musicSwitch"),
  effectsSwitch: document.getElementById("effectsSwitch"),
  stubShareBtn: document.getElementById("stubShareBtn"),
  stubCountdown: document.getElementById("stubCountdown"),
  stubNextLabel: document.getElementById("stubNextLabel"),
  stubStatsBtn: document.getElementById("stubStatsBtn"),
  stubDailyBtn: document.getElementById("stubDailyBtn"),
};
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
/* Bulb rings for the marquee pill and the NOW PLAYING banner (see Marquee.swift BulbRing):
   warm gold bulbs that chase in three phases, alternating with white-diamond bulbs that twinkle. */
const bulbSpecs = {
  marqueePill: { inset: 7.25, spacing: 15, bulb: 2.3 },
  outcome: { inset: 9.5, spacing: 16, bulb: 3.1, radius: 22 },
};
const bulbObserver = "ResizeObserver" in window ? new ResizeObserver((entries) => {
  for (const entry of entries) layoutBulbs(entry.target, entry.target.dataset.chase === "on");
}) : null;


let names = { guesses: [], answers: [] };
let answerPools = { familiar: [], obscure: [] };
let guessSet = new Set();
let game;
let settings = loadSettings();
let stats = loadStats();
let revealing = false;
let toastTimer;
let mode = "daily";
let dailyGame = null;
let obscureGame = null;
let lastFocus = null;
let keyboardUser = false;
let tabbing = false;
window.addEventListener("keydown", (e) => {
  keyboardUser = true;
  if (e.key === "Tab") tabbing = true;
}, true);
window.addEventListener("pointerdown", () => {
  keyboardUser = false;
  tabbing = false;
}, true);
let finishFxTimer;
let nameNotesPromise;
let historyCursor;
let friends = readStore(STORAGE + ":friends", { group: "", nickname: "", playerId: "" });
let postState = { key: "", status: "idle", message: "" };
let storyDataPromise = null;
let holdingBoard = false;
let showToken = 0;
let celebrateTimer;
let beamFrame = 0;
const WIN_HOLD = 1400;
const BANNER_LEAD = 850;
const sound = createAudio({ music: settings.music, effects: settings.effects });
window.namedSound = { debug: () => sound.debug() };
for (const type of ["pointerup", "touchend", "keydown", "click"]) {
  window.addEventListener(type, (e) => {
    if (type === "keydown" && (e.key === "Escape" || e.metaKey || e.ctrlKey || e.altKey)) return;
    sound.unlock();
  }, { capture: true, passive: true });
}
window.addEventListener("pointerdown", (e) => {
  if (e.target.closest?.(".brass-btn, .puzzle-switch, .practice-length-link, .icon-btn, .switch, .close")) sound.play("ui_tap");
}, { capture: true, passive: true });
let invitedGroup = normalizeGroup(new URLSearchParams(location.search).get("group"));
let boardDate = localDateKey();

applySettings();
buildKeyboard();
buildHelpExample();
bindChrome();

try {
  const [namesResponse, poolsResponse] = await Promise.all([
    fetch("./data/names.json"),
    fetch("./data/answer-pools.json"),
  ]);
  if (!namesResponse.ok || !poolsResponse.ok) throw new Error("names");
  names = await namesResponse.json();
  answerPools = await poolsResponse.json();
  guessSet = new Set(names.guesses.map((n) => n.toUpperCase()));
  bootDaily();
  if (invitedGroup && invitedGroup !== friends.group) toast("Friend code ready — tap the trophy to join", 4000);
} catch {
  toast("Could not load names. Refresh the page.", 8000);
}

function loadSettings() {
  const stored = readStore(STORAGE + ":settings", {});
  const saved = stored && typeof stored === "object" ? stored : {};
  return {
    dark: window.matchMedia("(prefers-color-scheme: dark)").matches,
    colorblind: false,
    hardMode: false,
    seenHelp: false,
    music: true,
    effects: true,
    ...saved,
    practiceLength: normalizePracticeLength(saved.practiceLength),
  };
}

function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota */
  }
}

function saveSettings() {
  writeStore(STORAGE + ":settings", settings);
}

function loadStats() {
  return {
    played: 0,
    wins: 0,
    streak: 0,
    maxStreak: 0,
    lastDate: null,
    dist: [0, 0, 0, 0, 0, 0],
    ...readStore(STORAGE + ":stats", {}),
  };
}

function saveStats() {
  writeStore(STORAGE + ":stats", stats);
}

function applySettings() {
  document.documentElement.dataset.theme = settings.dark ? "dark" : "light";
  document.documentElement.dataset.colorblind = settings.colorblind ? "on" : "off";
  document.querySelector('meta[name="theme-color"]').setAttribute("content", settings.dark ? "#120203" : "#1a0305");
  toggleSwitch(els.darkSwitch, settings.dark);
  toggleSwitch(els.cbSwitch, settings.colorblind);
  toggleSwitch(els.hardSwitch, settings.hardMode);
  toggleSwitch(els.musicSwitch, settings.music);
  toggleSwitch(els.effectsSwitch, settings.effects);
  const soundOn = settings.music || settings.effects;
  els.soundBtn.classList.toggle("muted", !soundOn);
  els.soundBtn.setAttribute("aria-pressed", String(soundOn));
  els.soundBtn.setAttribute("aria-label", soundOn ? "Sound on" : "Sound off");
  for (const button of els.practiceLengthOptions) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.practiceLength) === settings.practiceLength));
  }
  els.startPracticeFromSettings.textContent = `Start a new ${settings.practiceLength}-letter round`;
}

function toggleSwitch(el, on) {
  el.classList.toggle("on", on);
  el.setAttribute("aria-pressed", String(on));
}

function bootDaily() {
  const puzzle = pickDailyPuzzle(names.answers, localDateKey(), answerPools.familiar, answerPools.lengthWeights, answerPools.dailyFive);
  const saved = loadDailySave(puzzle.dateKey);
  mode = "daily";
  if (saved) {
    game = saved;
    if (typeof saved.hardMode === "boolean") {
      settings.hardMode = saved.hardMode;
      applySettings();
    }
  } else {
    game = createGame(puzzle);
    game.hardMode = settings.hardMode;
  }
  dailyGame = game;
  renderAll();
  if (game.status !== "playing" && friends.group && friends.nickname) postResult();
  if (!settings.seenHelp) openOverlay("helpOverlay");
}

function bootObscure() {
  const puzzle = pickObscurePuzzle(answerPools.obscure, localDateKey());
  const saved = readStore(STORAGE + ":obscure", null);
  mode = "obscure";
  game = obscureGame?.puzzle?.dateKey === puzzle.dateKey
    ? obscureGame
    : saved?.puzzle?.dateKey === puzzle.dateKey && saved.puzzle.kind === "obscure"
      ? migrateSavedGame(saved)
      : createGame(puzzle);
  obscureGame = game;
  renderAll();
}

function loadDailySave(dateKey) {
  const raw = readStore(STORAGE + ":daily", null);
  if (!raw || raw.puzzle?.dateKey !== dateKey) return null;
  const migrated = migrateSavedGame(raw);
  if (migrated !== raw) writeStore(STORAGE + ":daily", migrated);
  return migrated;
}

function saveGame() {
  if (mode === "daily" && game?.puzzle?.dateKey) {
    game.hardMode = settings.hardMode;
    writeStore(STORAGE + ":daily", game);
    dailyGame = game;
  } else if (mode === "obscure" && game?.puzzle?.dateKey) {
    writeStore(STORAGE + ":obscure", game);
    obscureGame = game;
  }
}

function renderAll() {
  const p = game.puzzle;
  els.puzzleMeta.textContent = p.dateKey
    ? `${mode === "obscure" ? "Obscure" : "Daily"} #${puzzleNumber(p.dateKey)} · ${p.length} letters`
    : `Practice · ${p.length} letters`;
  els.puzzleSwitch.textContent = mode === "daily" ? "Try obscure" : mode === "practice" ? "Daily" : "Official daily";
  els.nextDayNote.hidden = !(p.dateKey && game.status !== "playing");
  els.practiceLengthLink.hidden = Boolean(p.dateKey);
  renderBoard();
  renderKeys();
  paintOutcome();
  layoutBulbs(els.marqueePill);
  sound.setShow(mode === "daily" ? "daily" : "late");
}

/**
 * The finished stage. `phase` "banner" is the win's middle beat: NOW PLAYING is up but the
 * full board and keyboard still hold the stage; "done" collapses the board and brings up the
 * ticket stub. `drop` and `rise` animate the banner and the stub in.
 */
function paintOutcome({ phase = "done", drop = false, rise = false } = {}) {
  const finished = game.status !== "playing";
  const done = finished && phase === "done";
  els.app.classList.toggle("is-over", finished);
  els.app.classList.toggle("is-finished", done);
  els.marqueePill.hidden = finished;
  els.outcome.hidden = !finished;
  els.resultStub.hidden = !done;
  if (!finished) {
    els.outcome.classList.remove("drop");
    els.resultStub.classList.remove("rise");
    return;
  }
  const won = game.status === "won";
  const daily = Boolean(game.puzzle.dateKey);
  const obscure = game.puzzle.kind === "obscure";
  const name = titleCase(game.puzzle.name);
  els.outcome.dataset.result = game.status;
  els.outcome.classList.toggle("compact", game.guesses.length >= 5);
  els.outcomeDetail.textContent = won ? "Now playing:" : "The name was:";
  els.outcomeTitle.textContent = game.puzzle.name.toUpperCase();
  els.outcomeTitle.setAttribute("aria-label", won ? `Now playing: ${name}` : `The name was ${name}`);
  els.stubName.textContent = game.puzzle.name.toUpperCase();
  els.stubScore.textContent = won ? `${game.guesses.length}/6` : "X/6";
  els.stubKicker.textContent = obscure
    ? `Obscure #${puzzleNumber(game.puzzle.dateKey)}`
    : !daily
      ? `Practice · ${game.puzzle.length} letters`
      : won
        ? `Streak ${stats.streak}`
        : stats.maxStreak > 0 ? `Streak reset · best ${stats.maxStreak}` : "Streak 0";
  els.stubWord.textContent = won ? winWord(game.guesses.length) : daily ? "One more tomorrow." : "Try again?";
  const obscureDone = obscureGame?.puzzle?.dateKey === localDateKey() && obscureGame.status !== "playing";
  const nextIsObscure = mode === "daily" && !obscureDone;
  const nextLabel = nextIsObscure ? "Play obscure" : "Another name";
  els.nextNameBtn.querySelector(".next-name-full").textContent = nextLabel;
  els.nextNameBtn.querySelector(".next-name-compact").textContent = nextIsObscure ? "Obscure" : "Next name";
  els.nextNameBtn.setAttribute("aria-label", nextIsObscure ? "Play today’s obscure puzzle" : "Play another name");
  els.nextNameBtn.onclick = nextIsObscure ? switchToObscure : startPractice;
  els.stubNextLabel.textContent = mode === "daily" ? "Next name in" : mode === "obscure" ? "Next obscure in" : "New daily name in";
  els.stubDailyBtn.hidden = mode === "daily";
  els.nextDayNote.hidden = !game.puzzle.dateKey;
  if (drop && !reducedMotion.matches) {
    els.outcome.classList.remove("drop");
    void els.outcome.offsetWidth;
    els.outcome.classList.add("drop");
  }
  if (rise && !reducedMotion.matches) {
    els.resultStub.classList.remove("rise");
    void els.resultStub.offsetWidth;
    els.resultStub.classList.add("rise");
  }
  layoutBulbs(els.outcome, won);
  if (done) {
    paintNameNote(game.puzzle.name);
    paintBoardPrompt();
  }
}

function layoutBulbs(host, chase = true) {
  const layer = host.querySelector(".pill-bulbs, .banner-bulbs");
  const spec = bulbSpecs[host.id];
  if (!layer || !spec || host.hidden) return;
  host.dataset.chase = chase ? "on" : "off";
  const w = host.offsetWidth;
  const h = host.offsetHeight;
  const key = `${w}x${h}:${chase}`;
  if (!w || !h || layer.dataset.key === key) return;
  layer.dataset.key = key;
  if (bulbObserver && !host.dataset.observed) {
    host.dataset.observed = "1";
    bulbObserver.observe(host);
  }
  const points = ringPoints(w, h, spec.inset, spec.radius ?? h / 2, spec.spacing);
  const gid = `bulbGlow-${host.id}`;
  const wid = `bulbWhite-${host.id}`;
  const halo = spec.bulb * 3.4;
  const glint = spec.bulb * 3.6;
  const c = (x, y, r) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}"/>`;
  // A four-point star: arms of length `glint`, pinched through the bulb's center.
  const star = (x, y) => {
    const [X, Y, l, r, t, b] = [x, y, x - glint, x + glint, y - glint, y + glint].map((v) => v.toFixed(1));
    return `<path d="M${X} ${t}Q${X} ${Y} ${r} ${Y}Q${X} ${Y} ${X} ${b}Q${X} ${Y} ${l} ${Y}Q${X} ${Y} ${X} ${t}Z"/>`;
  };
  let goldBase = "";
  let whiteBase = "";
  const gold = ["", "", ""];
  const twinkles = ["", "", "", "", ""];
  let g = 0;
  points.forEach(([x, y], i) => {
    if (i % 2 === 0) {
      goldBase += c(x, y, spec.bulb * 0.95);
      gold[g++ % 3] += c(x, y, halo);
    } else {
      whiteBase += c(x, y, spec.bulb * 2.2);
      twinkles[Math.floor(Math.random() * twinkles.length)] += c(x, y, spec.bulb * 2.8).replace("/>", ` fill="url(#${wid})"/>`) + star(x, y);
    }
  });
  layer.innerHTML = `<svg class="bulbs${chase ? " bulbs-chase" : ""}" viewBox="0 0 ${w} ${h}" aria-hidden="true" focusable="false">
    <defs>
      <radialGradient id="${gid}"><stop offset="0" stop-color="#fff"/><stop offset=".2" stop-color="#fff" stop-opacity=".92"/><stop offset=".3" stop-color="#ffd37a"/><stop offset=".55" stop-color="#ffd37a" stop-opacity=".4"/><stop offset="1" stop-color="#ffd37a" stop-opacity="0"/></radialGradient>
      <radialGradient id="${wid}"><stop offset="0" stop-color="#fffdf5"/><stop offset=".34" stop-color="#fffdf5" stop-opacity=".95"/><stop offset=".5" stop-color="#dfeaff" stop-opacity=".45"/><stop offset="1" stop-color="#cfe0ff" stop-opacity="0"/></radialGradient>
    </defs>
    <g class="bulb-gold">${goldBase}</g>
    ${gold.map((dots, i) => `<g class="ph${i}" fill="url(#${gid})">${dots}</g>`).join("")}
    <g class="bulb-white" fill="url(#${wid})">${whiteBase}</g>
    ${twinkles.map((dots, i) => `<g class="tw tw${i}">${dots}</g>`).join("")}
  </svg>`;
}

function ringPoints(width, height, inset, radius, spacing) {
  const bw = width - 2 * inset;
  const bh = height - 2 * inset;
  if (bw <= 0 || bh <= 0) return [];
  const r = Math.max(Math.min(radius - inset, bw / 2, bh / 2), 0.5);
  const sx = Math.max(bw - 2 * r, 0);
  const sy = Math.max(bh - 2 * r, 0);
  const arc = (Math.PI / 2) * r;
  const total = 2 * sx + 2 * sy + 4 * arc;
  const n = Math.max(4, Math.round(total / spacing));
  const o = inset;
  const at = (s0) => {
    let s = ((s0 % total) + total) % total;
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
  return Array.from({ length: n }, (_, i) => at((i / n) * total - arc / 2));
}

function renderBoard() {
  const len = game.puzzle.length;
  els.board.style.setProperty("--len", String(len));
  const fullBoard = game.status === "playing" || holdingBoard;
  els.board.style.setProperty("--rows", String(fullBoard ? MAX_GUESSES : Math.max(1, game.guesses.length)));
  const reuse = els.board.children.length === MAX_GUESSES && els.board.dataset.len === String(len);
  if (!reuse) {
    els.board.replaceChildren();
    els.board.dataset.len = String(len);
  }
  for (let r = 0; r < MAX_GUESSES; r++) {
    let row = els.board.children[r];
    if (!row) {
      row = document.createElement("div");
      row.className = "row";
      row.dataset.row = String(r);
      row.setAttribute("role", "row");
      els.board.appendChild(row);
    }
    row.classList.toggle("active", r === game.guesses.length && game.status === "playing");
    row.classList.toggle("spare", !fullBoard && r >= game.guesses.length);
    const filled =
      game.guesses[r] || (r === game.guesses.length && game.status === "playing" ? game.current : "");
    const ev = game.evaluations[r];
    if (!ev) row.classList.remove("chasing", "shake");
    for (let c = 0; c < len; c++) {
      let tile = row.children[c];
      if (!tile) {
        tile = document.createElement("div");
        tile.className = "tile";
        tile.dataset.row = String(r);
        tile.dataset.col = String(c);
        tile.setAttribute("role", "gridcell");
        row.appendChild(tile);
      }
      const ch = filled[c] || "";
      if (tile.textContent !== ch) tile.textContent = ch;
      let state;
      let label;
      if (ev) {
        state = ev[c];
        label = `${ch} ${ev[c]}`;
      } else {
        tile.classList.remove("flip", "landed", "lift");
        state = ch ? "tbd" : "empty";
        label = ch || "empty";
      }
      if (tile.dataset.state !== state) tile.dataset.state = state;
      tile.setAttribute("aria-label", label);
    }
  }
}

function renderKeys() {
  const best = bestKeyStates(game.guesses, game.evaluations);
  for (const key of els.keyboard.querySelectorAll(".key")) {
    const letter = key.dataset.key;
    if (letter.length === 1) key.dataset.state = best[letter] || "";
  }
}

function buildKeyboard() {
  els.keyboard.replaceChildren();
  for (const row of KEYS) {
    const rowEl = document.createElement("div");
    rowEl.className = "kb-row";
    for (const key of row) {
      const btn = document.createElement("button");
      btn.className = "key" + (key.length > 1 ? " wide" : "");
      btn.dataset.key = key;
      btn.type = "button";
      if (key === "DEL") {
        btn.innerHTML = '<svg viewBox="0 0 28 20" aria-hidden="true" focusable="false"><path d="M9 2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H9l-7.5-8z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M13 6.5l7 7m0-7-7 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
      } else {
        btn.textContent = key;
      }
      btn.setAttribute("aria-label", key === "DEL" ? "Backspace" : key === "ENTER" ? "Enter" : key);
      btn.addEventListener("click", () => handleKey(key));
      rowEl.appendChild(btn);
    }
    els.keyboard.appendChild(rowEl);
  }
}

function buildHelpExample() {
  const labels = "JAMIE";
  const show = evaluateGuess(labels, "JAMES");
  for (let i = 0; i < labels.length; i++) {
    const t = document.createElement("div");
    t.className = "tile";
    t.textContent = labels[i];
    t.dataset.state = show[i];
    els.ex1.appendChild(t);
  }
}

function bindChrome() {
  document.getElementById("helpBtn").onclick = () => openOverlay("helpOverlay");
  document.getElementById("statsBtn").onclick = () => {
    paintStats();
    openOverlay("statsOverlay");
  };
  document.getElementById("friendsBtn").onclick = openFriends;
  document.getElementById("statsFriendsBtn").onclick = () => { closeOverlay("statsOverlay"); openFriends(); };
  document.getElementById("historyBtn").onclick = () => {
    const today = localDateKey();
    const daily = mode === "daily" ? game : dailyGame;
    historyCursor = historyEndDate(today, daily);
    document.getElementById("nameHistory").replaceChildren();
    closeOverlay("statsOverlay");
    openOverlay("historyOverlay");
    paintHistory();
  };
  document.getElementById("moreHistoryBtn").onclick = paintHistory;
  document.getElementById("createGroupBtn").onclick = () => {
    els.groupCode.value = newGroupCode();
  };
  document.getElementById("copyInviteBtn").onclick = copyInvite;
  document.getElementById("changeGroupBtn").onclick = () => {
    els.friendsActive.hidden = true;
    els.friendsForm.hidden = false;
    els.groupCode.focus();
  };
  els.friendsForm.onsubmit = joinFriends;
  document.getElementById("settingsBtn").onclick = () => openOverlay("settingsOverlay");
  els.practiceLengthLink.onclick = () => openOverlay("settingsOverlay");
  els.puzzleSwitch.onclick = () => mode === "daily" ? switchToObscure() : returnToDaily();
  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.onclick = () => closeOverlay(btn.dataset.close);
  });
  document.querySelectorAll(".overlay").forEach((ov) => {
    ov.addEventListener("click", (e) => {
      if (e.target === ov) closeOverlay(ov.id);
    });
  });
  els.darkSwitch.onclick = () => {
    settings.dark = !settings.dark;
    saveSettings();
    applySettings();
  };
  els.soundBtn.onclick = () => {
    const on = !(settings.music || settings.effects);
    settings.music = on;
    settings.effects = on;
    saveSettings();
    applySettings();
    sound.setEffects(on);
    sound.setMusic(on);
    toast(on ? "Music and sound on" : "Sound off");
  };
  els.musicSwitch.onclick = () => {
    settings.music = !settings.music;
    saveSettings();
    applySettings();
    sound.setMusic(settings.music);
  };
  els.effectsSwitch.onclick = () => {
    settings.effects = !settings.effects;
    saveSettings();
    applySettings();
    sound.setEffects(settings.effects);
  };
  els.promptJoin.onsubmit = (e) => { e.preventDefault(); promptJoin(); };
  els.promptStartBtn.onclick = promptStart;
  els.promptJoinBtn.onclick = promptJoin;
  els.promptCopyBtn.onclick = copyInvite;
  els.promptSeeBtn.onclick = openFriends;
  els.storyLink.onclick = () => {
    els.storyCard.scrollIntoView({ behavior: reducedMotion.matches ? "auto" : "smooth", block: "start" });
    els.storyTitle.focus({ preventScroll: true });
  };
  els.cbSwitch.onclick = () => {
    settings.colorblind = !settings.colorblind;
    saveSettings();
    applySettings();
  };
  els.hardSwitch.onclick = () => {
    if (game?.guesses?.length) {
      toast("Hard mode can only be changed before the first guess");
      return;
    }
    settings.hardMode = !settings.hardMode;
    saveSettings();
    applySettings();
    saveGame();
  };
  for (const button of els.practiceLengthOptions) {
    button.onclick = () => {
      settings.practiceLength = normalizePracticeLength(button.dataset.practiceLength);
      saveSettings();
      applySettings();
      if (game && game.status !== "playing") paintOutcome();
    };
  }
  els.startPracticeFromSettings.onclick = () => {
    closeOverlay("settingsOverlay");
    startPractice();
  };
  els.shareBtn.onclick = share;
  els.stubShareBtn.onclick = share;
  els.stubStatsBtn.onclick = () => {
    paintStats();
    openOverlay("statsOverlay");
  };
  els.stubDailyBtn.onclick = returnToDaily;
  els.practiceBtn.onclick = startPractice;
  els.statsObscureBtn.onclick = switchToObscure;
  els.nextNameBtn.onclick = startPractice;
  els.todayBtn.onclick = returnToDaily;
  window.addEventListener("keydown", onKey, true);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) tickCountdown();
  });
  setInterval(tickCountdown, 1000);
  tickCountdown();
}

function openOverlay(id) {
  lastFocus = document.activeElement;
  const ov = document.getElementById(id);
  ov.classList.add("open");
  sound.duck(true);
  ov.querySelector(".close")?.focus({ focusVisible: keyboardUser });
  if (id === "helpOverlay") {
    settings.seenHelp = true;
    saveSettings();
  }
}
function closeOverlay(id) {
  document.getElementById(id).classList.remove("open");
  if (!document.querySelector(".overlay.open")) sound.duck(false);
  if (lastFocus?.classList?.contains("icon-btn")) lastFocus.blur();
  else if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
}

function onKey(e) {
  if (document.querySelector(".overlay.open")) {
    if (e.key === "Escape") {
      document.querySelectorAll(".overlay.open").forEach((ov) => closeOverlay(ov.id));
    }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "Enter") {
    // Let Enter activate a focused control (menu buttons, links); on-screen keys still submit.
    if (tabbing && document.activeElement?.matches?.("button:not(.key), a[href], input, summary")) return;
    e.preventDefault();
    handleKey("ENTER");
  } else if (e.key === "Backspace") {
    e.preventDefault();
    handleKey("DEL");
  } else if (/^[a-zA-Z]$/.test(e.key)) {
    e.preventDefault();
    handleKey(e.key.toUpperCase());
  }
}

function handleKey(key) {
  if (!game) return;
  if (document.querySelector(".overlay.open")) return;
  if (revealing || game.status !== "playing") {
    if (game.status !== "playing" && key === "ENTER") {
      paintStats();
      openOverlay("statsOverlay");
    }
    return;
  }
  if (key === "ENTER") return submit();
  const before = game.current;
  game = key === "DEL" ? backspace(game) : typeLetter(game, key, game.puzzle.length);
  if (game.current !== before) key === "DEL" ? sound.play("key_delete") : sound.keyTap();
  renderBoard();
}

async function submit() {
  const before = game;
  const { game: next, error } = submitGuess(game, guessSet, { hardMode: settings.hardMode });
  if (error) {
    toast(error);
    shakeCurrent();
    sound.play("invalid_buzz");
    return;
  }
  revealing = true;
  const evaluation = next.evaluations[next.evaluations.length - 1];
  revealSounds(evaluation);
  await flipRow(before.guesses.length, evaluation, next.guesses.at(-1));
  game = next;
  saveGame();
  renderKeys();
  if (game.status === "playing") {
    renderBoard();
    revealing = false;
    return;
  }
  const won = game.status === "won";
  loadStoryData().catch(() => {});
  recordFinish(won);
  await finishShow(won);
  revealing = false;
}

/** Sound lands with the tiles: a flip as each starts to turn, then its bulbs as the lit face shows. */
function revealSounds(states) {
  const reduce = reducedMotion.matches;
  states.forEach((state, i) => {
    if (!reduce) sound.play("tile_flip", { delay: i * 0.3 });
    // A long correct-bulb tail is cut short when more bulbs follow.
    const cut = state === "correct" && i < states.length - 1 ? 0.9 : null;
    sound.play(`bulb_${state}`, { delay: reduce ? i * 0.08 : i * 0.3 + 0.25, maxDuration: cut });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The finish, in the app's three beats (GameScreen.playWinMoment): on a win the full board
 * holds while the winning row chases and the fanfare starts; then the spotlights sweep down as
 * NOW PLAYING drops in; then the board collapses and the ticket stub slides up. A loss is the
 * quiet version: one soft spot, the banner and the stub. Under reduced motion it all simply
 * appears.
 */
async function finishShow(won) {
  const motion = !reducedMotion.matches;
  const token = ++showToken;
  const stale = () => token !== showToken || game.status === "playing";
  holdingBoard = motion;
  renderBoard();
  if (won) {
    celebrate();
    els.board.children[game.guesses.length - 1]?.classList.add("chasing");
    if (motion) {
      liftWin();
      await sleep(WIN_HOLD);
      if (stale()) return;
    }
  }
  if (motion) {
    paintOutcome({ phase: "banner", drop: true });
    spotlights(won ? "won" : "lost");
    await sleep(won ? BANNER_LEAD : 650);
    if (stale()) return;
    els.app.classList.add("collapsing");
    await sleep(220);
    els.app.classList.remove("collapsing");
    if (stale()) return;
  } else {
    spotlights(won ? "won" : "lost");
  }
  holdingBoard = false;
  renderBoard();
  if (won) els.board.children[game.guesses.length - 1]?.classList.add("chasing");
  paintOutcome({ phase: "done", rise: motion });
  sound.play("ticket_tear", { delay: won ? (motion ? 0.15 : 0.9) : 0.25 });
}

/** The fanfare, the marquee lit up and the bulbs racing, for 4.2 seconds. */
function celebrate() {
  // Fanfare B for a plain daily win; fanfare A for obscure, practice and streak milestones.
  const milestone = mode === "daily" && [7, 30, 100].includes(stats.streak);
  sound.playWin(mode === "daily" && !milestone);
  document.documentElement.classList.add("celebrating");
  clearTimeout(celebrateTimer);
  celebrateTimer = setTimeout(() => document.documentElement.classList.remove("celebrating"), reducedMotion.matches ? 2000 : 4200);
}

function titleCase(name) {
  return name[0] + name.slice(1).toLowerCase();
}

function winWord(n) {
  return ["Named.", "Of course.", "There they are.", "Yes.", "Got them.", "Barely."][n - 1] || "Barely.";
}

function tickCountdown() {
  if (!els.countdown) return;
  const now = new Date();
  if (boardDate !== localDateKey(now)) {
    boardDate = localDateKey(now);
    if (els.friends.classList.contains("open")) refreshFriends();
  }
  if ((mode === "daily" || mode === "obscure") && game?.puzzle?.dateKey && game.puzzle.dateKey !== localDateKey(now) && !revealing) {
    if (els.stats.classList.contains("open")) closeOverlay("statsOverlay");
    if (mode === "daily") bootDaily();
    else bootObscure();
  }
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  let ms = Math.max(0, next.getTime() - now.getTime());
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  ms %= 3600000;
  const m = String(Math.floor(ms / 60000)).padStart(2, "0");
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  els.countdown.textContent = `${h}:${m}:${s}`;
  els.stubCountdown.textContent = `${h}:${m}:${s}`;
}

function shakeCurrent() {
  const row = els.board.children[game.guesses.length];
  if (!row) return;
  row.classList.remove("shake");
  void row.offsetWidth;
  row.classList.add("shake");
}

function flipRow(rowIndex, evaluation, guess) {
  const row = els.board.children[rowIndex];
  const tiles = [...row.children];
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    tiles.forEach((tile, i) => {
      tile.textContent = guess[i];
      tile.dataset.state = evaluation[i];
      tile.setAttribute("aria-label", `${guess[i]} ${evaluation[i]}`);
    });
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    tiles.forEach((tile, i) => {
      setTimeout(() => {
        tile.classList.add("flip");
        setTimeout(() => {
          tile.textContent = guess[i];
          tile.dataset.state = evaluation[i];
          tile.setAttribute("aria-label", `${guess[i]} ${evaluation[i]}`);
        }, 250);
        setTimeout(() => tile.classList.add("landed"), 500);
        if (i === tiles.length - 1) setTimeout(resolve, 520);
      }, i * 300);
    });
  });
}

function liftWin() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return Promise.resolve();
  const row = els.board.children[game.guesses.length - 1];
  const tiles = [...row.children];
  return new Promise((resolve) => {
    tiles.forEach((tile, i) => {
      setTimeout(() => tile.classList.add("lift"), i * 80);
    });
    setTimeout(resolve, 700);
  });
}

/** Where a follow-spot is aimed, in degrees from straight down, t seconds in (SpotlightShow.angle). */
function beamAngle(side, t, motion) {
  const rest = 50;
  if (!motion) return side * rest;
  const ease = (x) => { const v = Math.min(Math.max(x, 0), 1); return v * v * (3 - 2 * v); };
  let aim;
  if (t < 0) aim = 86;
  else if (t < 1.0) aim = 86 + (30 - 86) * ease(t / 1.0);
  else if (t < 1.8) aim = 30 + (rest - 30) * ease((t - 1.0) / 0.8);
  else aim = rest + Math.min(1, (t - 1.8) / 1.2) * 8 * Math.sin((t - 1.8) * 0.9 + (side > 0 ? 2.1 : 0));
  return side * aim;
}

/**
 * Two follow-spots hung behind the valance in the top corners: as NOW PLAYING drops in they
 * sweep down from the fringe across the banner, then sway over the stage. A loss gets one soft
 * spot from above. Under reduced motion the beams just fade up, already aimed.
 */
function spotlights(result) {
  cancelAnimationFrame(beamFrame);
  const fx = els.finishFx;
  fx.replaceChildren();
  fx.className = `finish-fx ${result}`;
  const motion = !reducedMotion.matches;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const length = height * 1.15;
  const beamWidth = length * 0.24;
  const sides = result === "won" ? [-1, 1] : [0];
  const beams = sides.map((side) => {
    const beam = document.createElement("i");
    beam.className = "beam";
    beam.innerHTML = '<span class="cone"></span><span class="core"></span>';
    const x = side ? width * (0.5 + side * 0.56) : width / 2;
    Object.assign(beam.style, {
      left: `${(x - beamWidth / 2).toFixed(1)}px`,
      top: side ? "36px" : "-24px",
      width: `${beamWidth.toFixed(1)}px`,
      height: `${length.toFixed(1)}px`,
    });
    fx.append(beam);
    return { beam, side };
  });
  const peak = result === "won" ? (motion ? 1 : 0.6) : 0.5;
  const fadeIn = result === "won" ? (motion ? 0.35 : 0.5) : 0.6;
  const holdFor = result === "won" ? (motion ? (4200 - WIN_HOLD) / 1000 : 2) : 1.6;
  const fadeOut = 1.2;
  const begin = performance.now();
  const frame = (now) => {
    const t = (now - begin) / 1000;
    const strength = t < fadeIn ? peak * (t / fadeIn) : t < holdFor ? peak : peak * Math.max(0, 1 - (t - holdFor) / fadeOut);
    fx.style.opacity = strength.toFixed(3);
    for (const { beam, side } of beams) {
      const angle = side ? beamAngle(side, t, motion) : (motion ? 4 * Math.sin(t * 1.1) : 0);
      beam.style.transform = `rotate(${angle.toFixed(2)}deg)`;
    }
    if (t < holdFor + fadeOut) {
      // Under reduced motion only the fade runs; the aim never changes.
      beamFrame = requestAnimationFrame(frame);
    } else {
      fx.replaceChildren();
      fx.className = "finish-fx";
    }
  };
  beamFrame = requestAnimationFrame(frame);
}

function toast(msg, ms = 2000) {
  const anchor = [els.marqueePill, els.outcome].find((el) => !el.hidden);
  const box = anchor?.getBoundingClientRect();
  els.toast.parentElement.style.top = box && box.bottom > 0 ? `${Math.max(8, box.top + box.height / 2 - 22)}px` : "";
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), ms);
}

function recordFinish(won) {
  if (mode !== "daily") {
    paintStats();
    return;
  }
  if (stats.lastDate === game.puzzle.dateKey) {
    paintStats();
    return;
  }
  stats = applyStreak(stats, game.puzzle.dateKey, won);
  if (won) stats.dist[game.guesses.length - 1] += 1;
  saveStats();
  paintStats();
  if (friends.group && friends.nickname) postResult();
}

function openFriends() {
  els.nickname.value = friends.nickname || "";
  els.groupCode.value = invitedGroup && invitedGroup !== friends.group ? invitedGroup : friends.group || "";
  const active = Boolean(friends.group && friends.nickname && (!invitedGroup || invitedGroup === friends.group));
  els.friendsForm.hidden = active;
  els.friendsActive.hidden = !active;
  openOverlay("friendsOverlay");
  if (active) refreshFriends();
}

function joinFriends(event) {
  event.preventDefault();
  const problem = joinBoard(els.groupCode.value, els.nickname.value);
  if (problem) return toast(problem);
  els.friendsForm.hidden = true;
  els.friendsActive.hidden = false;
  refreshFriends();
}

const NICKNAME = /^[\p{L}\p{N} _.'-]{2,20}$/u;

function newGroupCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

/** Joins (or starts) a board and posts today's finished daily to it. Returns a problem, or "". */
function joinBoard(rawCode, rawNickname) {
  const group = normalizeGroup(String(rawCode || "").trim().toUpperCase());
  const nickname = String(rawNickname || "").trim().replace(/\s+/g, " ");
  if (!NICKNAME.test(nickname)) return "Use 2–20 plain characters for your nickname";
  if (!group) return "Enter an 8-character invite code";
  friends = { group, nickname, playerId: friends.playerId || crypto.randomUUID() };
  invitedGroup = group;
  writeStore(STORAGE + ":friends", friends);
  history.replaceState(null, "", `${location.pathname}?group=${group}`);
  postResult();
  paintBoardPrompt();
  return "";
}

function promptStart() {
  const problem = joinBoard(newGroupCode(), els.promptNickname.value);
  if (problem) return showPromptError(problem, els.promptNickname);
}

function promptJoin() {
  if (els.promptCodeRow.hidden) {
    els.promptCodeRow.hidden = false;
    els.promptJoinBtn.textContent = "Join board";
    els.promptError.hidden = true;
    (NICKNAME.test(els.promptNickname.value.trim()) ? els.promptCode : els.promptNickname).focus();
    return;
  }
  const nickname = els.promptNickname.value;
  if (!NICKNAME.test(nickname.trim().replace(/\s+/g, " "))) return showPromptError("Use 2–20 plain characters for your nickname", els.promptNickname);
  const problem = joinBoard(els.promptCode.value, nickname);
  if (problem) showPromptError(problem, els.promptCode);
}

function showPromptError(message, field) {
  els.promptError.textContent = message;
  els.promptError.hidden = false;
  field?.focus();
}

/** The stub's friends-board card: an invitation until you're on a board, then where your score went. */
function paintBoardPrompt() {
  const show = mode === "daily" && game?.status !== "playing" && game?.puzzle?.dateKey === localDateKey();
  els.boardPrompt.hidden = !show;
  if (!show) return;
  const joined = Boolean(friends.group && friends.nickname) && (!invitedGroup || invitedGroup === friends.group);
  els.promptJoin.hidden = joined;
  els.promptDone.hidden = !joined;
  if (!joined) {
    if (!els.promptNickname.value) els.promptNickname.value = friends.nickname || "";
    if (invitedGroup && invitedGroup !== friends.group) {
      els.promptCodeRow.hidden = false;
      els.promptCode.value = invitedGroup;
      els.promptJoinBtn.textContent = "Join board";
      els.promptLead.textContent = `A friend invited you to board ${invitedGroup}. Pick a nickname and today’s result goes on it.`;
    }
    return;
  }
  const score = game.status === "won" ? `${game.guesses.length}/6` : "X/6";
  const key = `${game.puzzle.dateKey}:${friends.group}`;
  const posted = postState.key === key ? postState.status : readStore(receiptKey(), false) ? "saved" : "idle";
  els.promptStatus.textContent = posted === "saved"
    ? `Your ${score} is on board ${friends.group} as ${friends.nickname}. Send friends the invite to see theirs.`
    : posted === "error"
      ? `Couldn’t post to board ${friends.group}: ${postState.message} It will try again next time you open Named.`
      : `Posting your ${score} to board ${friends.group} as ${friends.nickname}…`;
}

function receiptKey() {
  return `${STORAGE}:posted:${dailyGame?.puzzle?.dateKey}:${friends.group}:${friends.playerId}`;
}

function inviteUrl() {
  return `${SHARE_URL}/?group=${friends.group}`;
}

async function copyInvite() {
  try {
    await navigator.clipboard.writeText(inviteUrl());
    toast("Invite link copied");
  } catch { toast("Couldn’t copy invite"); }
}

async function refreshFriends() {
  if (!friends.group) return;
  els.activeGroupCode.textContent = friends.group;
  els.friendsStatus.textContent = `Daily #${puzzleNumber(localDateKey())} · Loading scores…`;
  els.leaderboardList.replaceChildren();
  try {
    const response = await fetch(`/api/leaderboard?group=${friends.group}&dateKey=${localDateKey()}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unavailable");
    els.friendsStatus.textContent = `Daily #${puzzleNumber(localDateKey())} · ${data.entries.length} finished`;
    if (!data.entries.length) els.friendsStatus.textContent += " · Be first to finish!";
    let rank = 0;
    let priorScore = -1;
    data.entries.forEach((entry, i) => {
      const row = document.createElement("li");
      const place = document.createElement("b");
      const name = document.createElement("span");
      const score = document.createElement("strong");
      const numericScore = entry.score ?? 7;
      if (numericScore !== priorScore) rank = i + 1;
      priorScore = numericScore;
      place.textContent = String(rank);
      name.textContent = entry.nickname;
      score.textContent = entry.score ? `${entry.score}/6` : "X/6";
      row.append(place, name, score);
      els.leaderboardList.appendChild(row);
    });
  } catch (error) {
    els.friendsStatus.textContent = error.message;
  }
}

async function postResult() {
  const finished = dailyGame?.puzzle?.dateKey === localDateKey() && dailyGame.status !== "playing";
  if (!finished || !friends.group || !friends.nickname) return;
  const key = `${dailyGame.puzzle.dateKey}:${friends.group}`;
  const receipt = receiptKey();
  if (readStore(receipt, false)) {
    postState = { key, status: "saved", message: "" };
    paintBoardPrompt();
    return;
  }
  postState = { key, status: "posting", message: "" };
  paintBoardPrompt();
  try {
    const response = await fetch("/api/leaderboard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...friends, dateKey: dailyGame.puzzle.dateKey, guesses: dailyGame.guesses }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Couldn’t save result");
    writeStore(receipt, true);
    postState = { key, status: "saved", message: "" };
    if (els.friends.classList.contains("open")) refreshFriends();
  } catch (error) {
    postState = { key, status: "error", message: /[.!?]$/.test(error.message) ? error.message : `${error.message}.` };
    if (els.friends.classList.contains("open")) els.friendsStatus.textContent = error.message;
  }
  paintBoardPrompt();
}

function paintStats() {
  const finished = game && game.status !== "playing";
  els.statsScopeNote.hidden = mode === "daily";
  els.statsObscureBtn.hidden = mode === "obscure";
  els.resultPanel.hidden = !finished;
  els.nameNote.hidden = !finished;
  els.shareBtn.disabled = !finished;
  if (finished) {
    const won = game.status === "won";
    const daily = Boolean(game.puzzle.dateKey);
    const obscure = game.puzzle.kind === "obscure";
    els.resultPanel.dataset.result = game.status;
    els.resultKicker.textContent = obscure
      ? `Obscure #${puzzleNumber(game.puzzle.dateKey)}`
      : daily ? `Daily #${puzzleNumber(game.puzzle.dateKey)}` : `Practice · ${game.puzzle.length} letters`;
    els.resultTitle.textContent = won ? winWord(game.guesses.length) : daily ? "One more tomorrow." : "Try again?";
    els.resultCopy.textContent = won
      ? `You found ${titleCase(game.puzzle.name)} in ${game.guesses.length} of 6 guesses.`
      : obscure
        ? `The obscure name was ${titleCase(game.puzzle.name)}. A new one arrives at midnight.`
        : daily
        ? `Today’s name was ${titleCase(game.puzzle.name)}. A fresh puzzle arrives at midnight.`
        : `The name was ${titleCase(game.puzzle.name)}. Start another practice round anytime.`;
    paintNameNote(game.puzzle.name);
  }
  const pct = stats.played ? Math.round((100 * stats.wins) / stats.played) : 0;
  const items = [
    [stats.played, "Played"],
    [pct, "Win %"],
    [stats.streak, "Streak"],
    [stats.maxStreak, "Max streak"],
  ];
  els.statsRow.replaceChildren(
    ...items.map(([n, label]) => {
      const d = document.createElement("div");
      d.className = "stat";
      d.innerHTML = `<b>${n}</b><span>${label}</span>`;
      return d;
    })
  );
  const max = Math.max(1, ...stats.dist);
  els.dist.replaceChildren(
    ...stats.dist.map((count, i) => {
      const row = document.createElement("div");
      row.className = "dist-row";
      const winBar = mode === "daily" && game?.status === "won" && game.guesses.length === i + 1;
      row.innerHTML = `<span>${i + 1}</span><div class="bar${winBar ? " win" : ""}" style="width:${Math.max(7, (100 * count) / max)}%">${count}</div>`;
      return row;
    })
  );
  if (game && game.status !== "playing") {
    els.reveal.textContent = titleCase(game.puzzle.name);
  } else {
    els.reveal.textContent = "";
  }
}

function paintHistory() {
  const list = document.getElementById("nameHistory");
  let count = 0;
  while (historyCursor >= HISTORY_START_DATE && count++ < 30) {
    const puzzle = pickDailyPuzzle(names.answers, historyCursor, answerPools.familiar, answerPools.lengthWeights, answerPools.dailyFive);
    const row = document.createElement("details");
    row.className = "history-entry";
    const label = document.createElement("summary");
    label.textContent = `${historyCursor} · ${titleCase(puzzle.name)} · ${puzzle.length} letters`;
    const fact = document.createElement("p");
    fact.textContent = "Loading name fact…";
    row.append(label, fact);
    row.addEventListener("toggle", async () => {
      if (!row.open) return;
      try {
        const { card, story } = await storyFor(puzzle.name);
        fact.textContent = [plainText(card.headline) + ".", ...card.chips.map((chip) => `${chip}.`), story.popularity].filter(Boolean).join(" ");
      } catch {
        fact.textContent = "Name fact unavailable. Close and reopen to retry.";
      }
    });
    list.append(row);
    historyCursor = shiftDateKey(historyCursor, -1);
  }
  if (!list.children.length) list.textContent = "Your first daily name appears here after you finish, or tomorrow.";
  document.getElementById("moreHistoryBtn").hidden = historyCursor < HISTORY_START_DATE;
}

function fetchJSON(url) {
  return fetch(url).then((response) => {
    if (!response.ok) throw new Error(url);
    return response.json();
  });
}

/** The Name Story data, fetched once and only after a round ends (never on first paint). */
function loadStoryData() {
  storyDataPromise ||= Promise.all([fetchJSON("./data/name-facts.json"), fetchJSON("./data/name-stories.json")])
    .then(([facts, stories]) => ({ facts, stories }))
    .catch((error) => { storyDataPromise = null; throw error; });
  return storyDataPromise;
}

/** The fact card and story for a name. Old names missing from the facts use the SSA notes. */
async function storyFor(name) {
  const { facts, stories } = await loadStoryData();
  let notes = null;
  if (!facts.names[String(name).toUpperCase()]) {
    nameNotesPromise ||= fetchJSON("./data/name-notes.json").catch((error) => { nameNotesPromise = null; throw error; });
    notes = await nameNotesPromise;
  }
  return { card: factCard(name, facts, notes), story: nameStory(name, facts, stories) };
}

const plainText = (text) => String(text).replace(/\u00A0/g, " ");

async function paintNameNote(name) {
  const current = () => game?.puzzle?.name === name && game.status !== "playing";
  if (els.storyCard.dataset.name !== name) {
    els.nameNoteText.textContent = "Looking up the name…";
    els.factHeadline.textContent = "Looking up the name…";
    els.factChips.replaceChildren();
    els.storyCard.hidden = true;
    els.storyLink.hidden = true;
  }
  try {
    const { card, story } = await storyFor(name);
    if (!current()) return;
    els.factHeadline.textContent = card.headline;
    els.factChips.replaceChildren(...card.chips.map((chip) => {
      const li = document.createElement("li");
      li.textContent = chip;
      return li;
    }));
    els.nameNoteText.textContent = [plainText(card.headline) + ".", ...card.chips.map((chip) => `${chip}.`)].join(" ");
    renderStory(story);
  } catch {
    if (!current()) return;
    els.factHeadline.textContent = "Name facts unavailable right now.";
    els.nameNoteText.textContent = "Name facts unavailable right now.";
  }
}

/**
 * The Name Story card (KeepsakeViews.NameStoryCard): the hook, meaning, then and now, the line
 * that lands, songs, films and books, famous namesakes and the sources.
 */
function renderStory(story) {
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const label = (text) => el("h3", "story-label", text);
  const culture = (item, lead) => {
    const block = el("div", lead ? "story-hook culture" : "culture");
    block.append(el("span", "culture-kind", cultureKindLine(item)), el(lead ? "strong" : "b", "culture-title", cultureTitle(item)), el("p", "culture-fact", item.fact));
    return block;
  };
  const parts = [];
  if (story.culture[0]) parts.push(culture(story.culture[0], true));
  else if (story.record) parts.push(el("p", "story-hook record", story.record));
  if (story.meaning || story.origin) {
    const block = el("section", "story-part");
    block.append(label("Meaning"), el("p", "story-meaning", meaningLine(story)));
    parts.push(block);
  }
  if (story.popularity) {
    const block = el("section", "story-part");
    block.append(label("Then and now"), el("p", "", story.popularity));
    parts.push(block);
  }
  if (story.feeling) parts.push(el("p", "story-feeling", story.feeling));
  if (story.culture.length > 1 || (story.culture.length === 1 && story.record)) {
    const block = el("section", "story-part story-ruled");
    block.append(label("In songs, films & books"));
    // The hook was the culture line; the record still belongs on the card.
    if (story.culture.length === 1 && story.record) block.append(el("p", "story-record", story.record));
    story.culture.slice(1).forEach((item) => block.append(culture(item, false)));
    parts.push(block);
  }
  if (story.namesakes.length) {
    const block = el("section", "story-part story-ruled");
    block.append(label("Famous namesakes"));
    const list = el("ul", "namesakes");
    for (const person of story.namesakes) {
      const li = el("li");
      li.append(el("b", "", person.person), el("span", "", person.fact));
      list.append(li);
    }
    block.append(list);
    parts.push(block);
  }
  els.storyTitle.textContent = `The story of ${story.name}`;
  els.storyTitle.tabIndex = -1;
  els.storyBody.replaceChildren(...parts);
  els.storySources.textContent = sourcesLine(story);
  els.storyCard.dataset.name = game.puzzle.name;
  els.storyCard.hidden = false;
  els.storyLink.textContent = `The story of ${story.name}`;
  els.storyLink.hidden = false;
}

async function share() {
  if (!game || game.status === "playing") {
    toast("Finish a game to share");
    return;
  }
  const url = friends.group ? inviteUrl() : SHARE_URL;
  const text = shareGrid(game, { url });
  try {
    if (navigator.share) {
      await navigator.share({ text: shareGrid(game), url });
      return;
    }
  } catch (err) {
    if (err?.name === "AbortError") return;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      toast("Copied to clipboard");
      return;
    }
  } catch {
    /* fall through */
  }
  toast("Couldn't copy");
}

function startPractice() {
  if (!answerPools.familiar.length) return toast("Names are still loading");
  if (els.stats.classList.contains("open")) closeOverlay("statsOverlay");
  if (mode === "daily") dailyGame = game;
  if (mode === "obscure") obscureGame = game;
  const previousName = game?.puzzle?.name;
  mode = "practice";
  game = createGame(pickRandomPuzzle(answerPools.familiar, Math.random, previousName, settings.practiceLength));
  stopShow();
  sound.play("curtain_whoosh");
  renderAll();
}

function switchToObscure() {
  if (!answerPools.obscure.length) return toast("Names are still loading");
  if (els.stats.classList.contains("open")) closeOverlay("statsOverlay");
  if (mode === "daily") dailyGame = game;
  stopShow();
  sound.play("curtain_whoosh");
  bootObscure();
}

function returnToDaily() {
  closeOverlay("statsOverlay");
  if (mode === "obscure") obscureGame = game;
  mode = "daily";
  const puzzle = pickDailyPuzzle(names.answers, localDateKey(), answerPools.familiar, answerPools.lengthWeights, answerPools.dailyFive);
  game = dailyGame && dailyGame.puzzle?.dateKey === puzzle.dateKey
    ? dailyGame
    : loadDailySave(puzzle.dateKey) || createGame(puzzle);
  stopShow();
  sound.play("curtain_whoosh");
  renderAll();
}

/** Leaving a round mid-show: stop the beams and the celebration. */
function stopShow() {
  showToken++;
  holdingBoard = false;
  revealing = false;
  cancelAnimationFrame(beamFrame);
  els.finishFx.replaceChildren();
  els.finishFx.className = "finish-fx";
  els.app.classList.remove("collapsing");
  document.documentElement.classList.remove("celebrating");
}
