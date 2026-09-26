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
};

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
  document.querySelector('meta[name="theme-color"]').setAttribute("content", settings.dark ? "#030e2b" : "#061947");
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
}

function paintOutcome() {
  if (game.status === "playing") {
    els.outcome.hidden = true;
    return;
  }
  els.outcome.hidden = false;
  els.outcome.dataset.result = game.status;
  els.outcomeTitle.textContent = game.status === "won"
    ? `${winWord(game.guesses.length)} ${game.guesses.length}/6`
    : `The name was ${titleCase(game.puzzle.name)}.`;
  els.outcomeDetail.textContent = game.puzzle.kind === "obscure"
    ? "Another obscure name arrives tomorrow"
    : `Next: ${settings.practiceLength}-letter practice`;
  els.nextDayNote.hidden = !game.puzzle.dateKey;
}

function renderBoard() {
  const len = game.puzzle.length;
  els.board.style.setProperty("--len", String(len));
  els.board.replaceChildren();
  for (let r = 0; r < MAX_GUESSES; r++) {
    const row = document.createElement("div");
    row.className = "row";
    if (r === game.guesses.length && game.status === "playing") row.classList.add("active");
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
  saveGame();
  renderKeys();
  if (game.status === "won") {
    await liftWin();
    recordFinish(true);
    paintOutcome();
    showFinishEffect("won");
    toast(winWord(game.guesses.length));
    setTimeout(() => {
      paintStats();
      if (!document.querySelector(".overlay.open")) openOverlay("statsOverlay");
    }, 450);
  } else if (game.status === "lost") {
    recordFinish(false);
    paintOutcome();
    showFinishEffect("lost");
    toast(`The name was ${titleCase(game.puzzle.name)}`, 2400);
    setTimeout(() => {
      paintStats();
      if (!document.querySelector(".overlay.open")) openOverlay("statsOverlay");
    }, 700);
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
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  els.finishFx.className = `finish-fx ${result}`;
  const count = result === "won" ? 28 : 12;
  for (let i = 0; i < count; i++) {
    const piece = document.createElement("i");
    piece.style.setProperty("--x", `${Math.round(5 + Math.random() * 90)}%`);
    piece.style.setProperty("--delay", `${Math.round(Math.random() * 380)}ms`);
    piece.style.setProperty("--drift", `${Math.round((Math.random() - 0.5) * 150)}px`);
    piece.style.setProperty("--turn", `${Math.round((Math.random() - 0.5) * 800)}deg`);
    els.finishFx.appendChild(piece);
  }
  finishFxTimer = setTimeout(() => {
    els.finishFx.className = "finish-fx";
    els.finishFx.replaceChildren();
  }, 2000);
}

function toast(msg, ms = 2000) {
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
  nameNotesPromise ||= fetch("./data/name-notes.json").then((response) => {
    if (!response.ok) throw new Error("name notes");
    return response.json();
  });
  try {
    const notes = await nameNotesPromise;
    if (game?.puzzle?.name === name && game.status !== "playing") {
      els.nameNoteText.textContent = describeName(name, notes);
    }
  } catch {
    nameNotesPromise = null;
    if (game?.puzzle?.name === name) els.nameNoteText.textContent = "Name note unavailable right now.";
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
