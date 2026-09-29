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
import { describeName } from "./name-notes.js";
import { normalizeGroup } from "./leaderboard-core.js";

const KEYS = ["QWERTYUIOP".split(""), "ASDFGHJKL".split(""), ["ENTER", ..."ZXCVBNM".split(""), "DEL"]];
const STORAGE = "given-v2";
const SHARE_URL = "https://given-one.vercel.app/";

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
  stubFact: document.getElementById("stubFact"),
  stubShareBtn: document.getElementById("stubShareBtn"),
  stubCountdown: document.getElementById("stubCountdown"),
  stubNextLabel: document.getElementById("stubNextLabel"),
  stubStatsBtn: document.getElementById("stubStatsBtn"),
  stubDailyBtn: document.getElementById("stubDailyBtn"),
};
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
/* Bulb rings for the marquee pill and the NOW PLAYING banner (see Marquee.swift BulbRing). */
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
  const puzzle = pickDailyPuzzle(names.answers, localDateKey(), answerPools.familiar, answerPools.lengthWeights);
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
}

function paintOutcome(animate = false) {
  const finished = game.status !== "playing";
  els.app.classList.toggle("is-finished", finished);
  els.marqueePill.hidden = finished;
  els.outcome.hidden = !finished;
  els.resultStub.hidden = !finished;
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
  paintNameNote(game.puzzle.name);
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
  if (animate && !reducedMotion.matches) {
    els.outcome.classList.remove("drop");
    els.resultStub.classList.remove("rise");
    void els.outcome.offsetWidth;
    els.outcome.classList.add("drop");
    els.resultStub.classList.add("rise");
  }
  layoutBulbs(els.outcome, won);
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
  const halo = spec.bulb * 3.4;
  let off = "";
  const on = ["", "", ""];
  points.forEach(([x, y], i) => {
    off += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(spec.bulb * 0.9).toFixed(2)}"/>`;
    on[i % 3] += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${halo.toFixed(2)}"/>`;
  });
  layer.innerHTML = `<svg class="${chase ? "bulbs-chase" : ""}" viewBox="0 0 ${w} ${h}" aria-hidden="true" focusable="false">
    <defs><radialGradient id="${gid}"><stop offset="0" stop-color="#fff"/><stop offset=".2" stop-color="#fff" stop-opacity=".92"/><stop offset=".3" stop-color="#ffd37a"/><stop offset=".55" stop-color="#ffd37a" stop-opacity=".4"/><stop offset="1" stop-color="#ffd37a" stop-opacity="0"/></radialGradient></defs>
    <g class="bulb-off">${off}</g>
    ${on.map((c, g) => `<g class="ph${g}" fill="url(#${gid})">${c}</g>`).join("")}
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
  els.board.style.setProperty("--rows", String(game.status === "playing" ? MAX_GUESSES : Math.max(1, game.guesses.length)));
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
    row.classList.toggle("spare", game.status !== "playing" && r >= game.guesses.length);
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
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    els.groupCode.value = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
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
  ov.querySelector(".close")?.focus({ focusVisible: keyboardUser });
  if (id === "helpOverlay") {
    settings.seenHelp = true;
    saveSettings();
  }
}
function closeOverlay(id) {
  document.getElementById(id).classList.remove("open");
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
  if (key === "DEL") {
    game = backspace(game);
    renderBoard();
    return;
  }
  game = typeLetter(game, key, game.puzzle.length);
  renderBoard();
}

async function submit() {
  const before = game;
  const { game: next, error } = submitGuess(game, guessSet, { hardMode: settings.hardMode });
  if (error) {
    toast(error);
    shakeCurrent();
    return;
  }
  revealing = true;
  await flipRow(before.guesses.length, next.evaluations[next.evaluations.length - 1], next.guesses.at(-1));
  game = next;
  saveGame();
  renderKeys();
  if (game.status === "won") {
    await liftWin();
    recordFinish(true);
    renderBoard();
    els.board.children[game.guesses.length - 1]?.classList.add("chasing");
    paintOutcome(true);
    showFinishEffect("won");
  } else if (game.status === "lost") {
    recordFinish(false);
    renderBoard();
    paintOutcome(true);
    showFinishEffect("lost");
  } else {
    renderBoard();
  }
  revealing = false;
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

function showFinishEffect(result) {
  clearTimeout(finishFxTimer);
  els.finishFx.replaceChildren();
  els.finishFx.className = "finish-fx";
  if (result !== "won" || reducedMotion.matches) return;
  void els.finishFx.offsetWidth;
  els.finishFx.className = "finish-fx won";
  els.finishFx.append(document.createElement("i"), document.createElement("i"));
  finishFxTimer = setTimeout(() => {
    els.finishFx.className = "finish-fx";
    els.finishFx.replaceChildren();
  }, 3800);
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
  const group = normalizeGroup(els.groupCode.value.trim());
  const nickname = els.nickname.value.trim().replace(/\s+/g, " ");
  if (!group) return toast("Enter an 8-character invite code");
  if (!/^[\p{L}\p{N} _.'-]{2,20}$/u.test(nickname)) return toast("Use 2–20 plain characters for your nickname");
  friends = { group, nickname, playerId: friends.playerId || crypto.randomUUID() };
  invitedGroup = group;
  writeStore(STORAGE + ":friends", friends);
  history.replaceState(null, "", `${location.pathname}?group=${group}`);
  els.friendsForm.hidden = true;
  els.friendsActive.hidden = false;
  refreshFriends();
  if (dailyGame?.status !== "playing") postResult();
}

function inviteUrl() {
  return `${SHARE_URL}?group=${friends.group}`;
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
  const receiptKey = `${STORAGE}:posted:${dailyGame.puzzle.dateKey}:${friends.group}:${friends.playerId}`;
  if (readStore(receiptKey, false)) return;
  try {
    const response = await fetch("/api/leaderboard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...friends, dateKey: dailyGame.puzzle.dateKey, guesses: dailyGame.guesses }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Couldn’t save result");
    writeStore(receiptKey, true);
    if (els.friends.classList.contains("open")) refreshFriends();
  } catch (error) {
    if (els.friends.classList.contains("open")) els.friendsStatus.textContent = error.message;
  }
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
    const puzzle = pickDailyPuzzle(names.answers, historyCursor, answerPools.familiar, answerPools.lengthWeights);
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
        nameNotesPromise ||= fetch("./data/name-notes.json").then(response => {
          if (!response.ok) throw new Error("name notes");
          return response.json();
        });
        fact.textContent = describeName(puzzle.name, await nameNotesPromise);
      } catch {
        nameNotesPromise = null;
        fact.textContent = "Name fact unavailable. Close and reopen to retry.";
      }
    });
    list.append(row);
    historyCursor = shiftDateKey(historyCursor, -1);
  }
  if (!list.children.length) list.textContent = "Your first daily name appears here after you finish, or tomorrow.";
  document.getElementById("moreHistoryBtn").hidden = historyCursor < HISTORY_START_DATE;
}

async function paintNameNote(name) {
  els.nameNoteText.textContent = "Looking up the name…";
  els.stubFact.textContent = "Looking up the name…";
  nameNotesPromise ||= fetch("./data/name-notes.json").then((response) => {
    if (!response.ok) throw new Error("name notes");
    return response.json();
  });
  try {
    const notes = await nameNotesPromise;
    if (game?.puzzle?.name === name && game.status !== "playing") {
      els.nameNoteText.textContent = describeName(name, notes);
      els.stubFact.textContent = els.nameNoteText.textContent;
    }
  } catch {
    nameNotesPromise = null;
    if (game?.puzzle?.name === name) {
      els.nameNoteText.textContent = "Name note unavailable right now.";
      els.stubFact.textContent = els.nameNoteText.textContent;
    }
  }
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
  renderAll();
}

function switchToObscure() {
  if (!answerPools.obscure.length) return toast("Names are still loading");
  if (els.stats.classList.contains("open")) closeOverlay("statsOverlay");
  if (mode === "daily") dailyGame = game;
  bootObscure();
}

function returnToDaily() {
  closeOverlay("statsOverlay");
  if (mode === "obscure") obscureGame = game;
  mode = "daily";
  const puzzle = pickDailyPuzzle(names.answers, localDateKey(), answerPools.familiar, answerPools.lengthWeights);
  game = dailyGame && dailyGame.puzzle?.dateKey === puzzle.dateKey
    ? dailyGame
    : loadDailySave(puzzle.dateKey) || createGame(puzzle);
  renderAll();
}
