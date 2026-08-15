import {
  MAX_GUESSES,
  createGame,
  typeLetter,
  backspace,
  submitGuess,
  pickDailyPuzzle,
  pickRandomPuzzle,
  bestKeyStates,
  shareGrid,
  localDateKey,
  applyStreak,
  evaluateGuess,
} from "./engine.js";

const KEYS = ["QWERTYUIOP".split(""), "ASDFGHJKL".split(""), ["ENTER", ..."ZXCVBNM".split(""), "DEL"]];
const STORAGE = "given-v2";

const els = {
  board: document.getElementById("board"),
  keyboard: document.getElementById("keyboard"),
  startLetter: document.getElementById("startLetter"),
  containLetter: document.getElementById("containLetter"),
  pair: document.getElementById("pair"),
  toast: document.getElementById("toast"),
  countdown: document.getElementById("countdown"),
  help: document.getElementById("helpOverlay"),
  stats: document.getElementById("statsOverlay"),
  settings: document.getElementById("settingsOverlay"),
  statsRow: document.getElementById("statsRow"),
  dist: document.getElementById("dist"),
  reveal: document.getElementById("reveal"),
  darkSwitch: document.getElementById("darkSwitch"),
  cbSwitch: document.getElementById("cbSwitch"),
  hardSwitch: document.getElementById("hardSwitch"),
  shareBtn: document.getElementById("shareBtn"),
  practiceBtn: document.getElementById("practiceBtn"),
  todayBtn: document.getElementById("todayBtn"),
  ex1: document.getElementById("ex1"),
};

let names = { guesses: [], answers: [], contain: {} };
let guessSet = new Set();
let game;
let settings = loadSettings();
let stats = loadStats();
let revealing = false;
let toastTimer;
let mode = "daily";
let dailyGame = null;
let lastFocus = null;

applySettings();
buildKeyboard();
buildHelpExample();
bindChrome();

try {
  const res = await fetch("./data/names.json");
  if (!res.ok) throw new Error("names");
  const data = await res.json();
  names = data;
  guessSet = new Set(data.guesses.map((n) => n.toUpperCase()));
  bootDaily();
} catch {
  toast("Could not load names. Refresh the page.", 8000);
}

function loadSettings() {
  return {
    dark: window.matchMedia("(prefers-color-scheme: dark)").matches,
    colorblind: false,
    hardMode: false,
    seenHelp: false,
    ...readStore(STORAGE + ":settings", {}),
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
  document.querySelector('meta[name="theme-color"]').setAttribute("content", settings.dark ? "#121213" : "#ffffff");
  toggleSwitch(els.darkSwitch, settings.dark);
  toggleSwitch(els.cbSwitch, settings.colorblind);
  toggleSwitch(els.hardSwitch, settings.hardMode);
}

function toggleSwitch(el, on) {
  el.classList.toggle("on", on);
  el.setAttribute("aria-pressed", String(on));
}

function bootDaily() {
  const puzzle = pickDailyPuzzle(names.answers, names.contain, localDateKey());
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
  if (!settings.seenHelp) openOverlay("helpOverlay");
}

function loadDailySave(dateKey) {
  const raw = readStore(STORAGE + ":daily", null);
  if (!raw || raw.puzzle?.dateKey !== dateKey) return null;
  return raw;
}

function saveDaily() {
  if (mode === "daily" && game?.puzzle?.dateKey) {
    game.hardMode = settings.hardMode;
    writeStore(STORAGE + ":daily", game);
    dailyGame = game;
  }
}

function renderAll() {
  const p = game.puzzle;
  els.startLetter.textContent = p.start;
  els.containLetter.textContent = p.contain;
  els.pair.setAttribute("aria-label", `${p.start} given, ${p.contain} in the name`);
  renderBoard();
  renderKeys();
}

function renderBoard() {
  const len = game.puzzle.length;
  els.board.style.setProperty("--len", String(len));
  els.board.replaceChildren();
  for (let r = 0; r < MAX_GUESSES; r++) {
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.row = String(r);
    const filled =
      game.guesses[r] || (r === game.guesses.length && game.status === "playing" ? game.current : "");
    const ev = game.evaluations[r];
    for (let c = 0; c < len; c++) {
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.dataset.row = String(r);
      tile.dataset.col = String(c);
      const ch = filled[c] || "";
      tile.textContent = ch;
      tile.setAttribute("role", "gridcell");
      if (ev) {
        tile.dataset.state = ev[c];
        tile.setAttribute("aria-label", `${ch} ${ev[c]}`);
      } else if (c === 0 && ch) {
        tile.dataset.state = "given";
        tile.setAttribute("aria-label", `${ch} given`);
      } else if (ch) {
        tile.dataset.state = "tbd";
        tile.setAttribute("aria-label", ch);
      } else {
        tile.dataset.state = "empty";
        tile.setAttribute("aria-label", "empty");
      }
      row.appendChild(tile);
    }
    els.board.appendChild(row);
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
      btn.textContent = key === "DEL" ? "⌫" : key;
      btn.setAttribute("aria-label", key === "DEL" ? "Backspace" : key === "ENTER" ? "Enter" : key);
      btn.addEventListener("click", () => handleKey(key));
      rowEl.appendChild(btn);
    }
    els.keyboard.appendChild(rowEl);
  }
}

function buildHelpExample() {
  const labels = "BEAT";
  const show = evaluateGuess("BEAT", "BETH");
  for (let i = 0; i < 4; i++) {
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
  document.getElementById("settingsBtn").onclick = () => openOverlay("settingsOverlay");
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
    saveDaily();
  };
  els.shareBtn.onclick = share;
  els.practiceBtn.onclick = startPractice;
  els.todayBtn.onclick = returnToDaily;
  window.addEventListener("keydown", onKey, true);
  setInterval(tickCountdown, 1000);
  tickCountdown();
}

function openOverlay(id) {
  lastFocus = document.activeElement;
  const ov = document.getElementById(id);
  ov.classList.add("open");
  ov.querySelector(".close")?.focus();
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
  saveDaily();
  renderKeys();
  if (game.status === "won") {
    await bounceWin();
    recordFinish(true);
    toast(winWord(game.guesses.length));
    setTimeout(() => {
      paintStats();
      openOverlay("statsOverlay");
    }, 900);
  } else if (game.status === "lost") {
    recordFinish(false);
    toast(titleCase(game.puzzle.name), 2400);
    setTimeout(() => {
      paintStats();
      openOverlay("statsOverlay");
    }, 1200);
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
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  let ms = Math.max(0, next.getTime() - now.getTime());
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  ms %= 3600000;
  const m = String(Math.floor(ms / 60000)).padStart(2, "0");
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  els.countdown.textContent = `${h}:${m}:${s}`;
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
        if (i === tiles.length - 1) setTimeout(resolve, 520);
      }, i * 300);
    });
  });
}

function bounceWin() {
  const row = els.board.children[game.guesses.length - 1];
  const tiles = [...row.children];
  return new Promise((resolve) => {
    tiles.forEach((tile, i) => {
      setTimeout(() => tile.classList.add("bounce"), i * 80);
    });
    setTimeout(resolve, 700);
  });
}

function toast(msg, ms = 2000) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), ms);
}

function recordFinish(won) {
  if (!game.puzzle.dateKey) {
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
}

function paintStats() {
  const pct = stats.played ? Math.round((100 * stats.wins) / stats.played) : 0;
  const items = [
    [stats.played, "Played"],
    [pct, "Win %"],
    [stats.streak, "Current streak"],
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
      const winBar = game?.status === "won" && game.guesses.length === i + 1;
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

async function share() {
  if (!game || game.status === "playing") {
    toast("Finish a game to share");
    return;
  }
  const text = shareGrid(game, { dark: settings.dark, colorblind: settings.colorblind });
  try {
    if (navigator.share) {
      await navigator.share({ text });
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
  closeOverlay("statsOverlay");
  if (mode === "daily") dailyGame = game;
  mode = "practice";
  game = createGame(pickRandomPuzzle(names.answers, names.contain));
  renderAll();
}

function returnToDaily() {
  closeOverlay("statsOverlay");
  mode = "daily";
  const puzzle = pickDailyPuzzle(names.answers, names.contain, localDateKey());
  game = dailyGame && dailyGame.puzzle?.dateKey === puzzle.dateKey
    ? dailyGame
    : loadDailySave(puzzle.dateKey) || createGame(puzzle);
  renderAll();
}
