/** Pure GIVEN game engine. Works in the browser and in Node. */

export const MAX_GUESSES = 6;
export const MIN_LEN = 4;
export const MAX_LEN = 7;
export const PLAY_LENGTH = 5;
export const PRACTICE_LENGTHS = Object.freeze([5, 6, 7]);

export function normalizePracticeLength(value) {
  const length = Number(value);
  return PRACTICE_LENGTHS.includes(length) ? length : PLAY_LENGTH;
}

export function normalizeName(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
}

export function isValidNameShape(name) {
  const n = normalizeName(name);
  return n.length >= MIN_LEN && n.length <= MAX_LEN;
}

/**
 * Two-pass Wordle evaluation.
 * First correct letters consume counts, then misplaced letters consume what remains.
 */
export function evaluateGuess(guess, secret) {
  const g = normalizeName(guess);
  const s = normalizeName(secret);
  if (g.length !== s.length) {
    throw new Error("Guess and secret must be the same length");
  }

  const result = Array(g.length).fill("absent");
  const remaining = {};
  for (const ch of s) remaining[ch] = (remaining[ch] || 0) + 1;

  for (let i = 0; i < g.length; i++) {
    if (g[i] === s[i]) {
      result[i] = "correct";
      remaining[g[i]] -= 1;
    }
  }

  for (let i = 0; i < g.length; i++) {
    if (result[i] === "correct") continue;
    if (remaining[g[i]] > 0) {
      result[i] = "present";
      remaining[g[i]] -= 1;
    }
  }

  return result;
}

export function bestKeyStates(guesses, evaluations) {
  const rank = { absent: 1, present: 2, correct: 3 };
  const best = {};
  for (let i = 0; i < guesses.length; i++) {
    const guess = normalizeName(guesses[i]);
    const ev = evaluations[i];
    for (let j = 0; j < guess.length; j++) {
      const ch = guess[j];
      const state = ev[j];
      if (!best[ch] || rank[state] > rank[best[ch]]) best[ch] = state;
    }
  }
  return best;
}

export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function utcDateKey(date = new Date()) {
  return localDateKey(date);
}

export function puzzleNumber(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const origin = Date.UTC(2026, 0, 1);
  const day = Date.UTC(y, m - 1, d);
  return Math.floor((day - origin) / 86400000) + 1;
}

export function dateKeyFromPuzzleNumber(n) {
  const origin = Date.UTC(2026, 0, 1);
  const day = new Date(origin + (Number(n) - 1) * 86400000);
  const y = day.getUTCFullYear();
  const m = String(day.getUTCMonth() + 1).padStart(2, "0");
  const d = String(day.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function shiftDateKey(dateKey, days) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  return localDateKey(dt);
}

export function applyStreak(stats, dateKey, won) {
  if (stats.lastDate === dateKey) return { ...stats, dist: [...(stats.dist || [])] };
  const next = {
    played: stats.played + 1,
    wins: stats.wins,
    streak: stats.streak,
    maxStreak: stats.maxStreak,
    lastDate: dateKey,
    dist: [...(stats.dist || [0, 0, 0, 0, 0, 0])],
  };
  if (!won) {
    next.streak = 0;
    return next;
  }
  next.wins = stats.wins + 1;
  next.streak = stats.lastDate === shiftDateKey(dateKey, -1) ? stats.streak + 1 : 1;
  next.maxStreak = Math.max(stats.maxStreak || 0, next.streak);
  return next;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function dailyOrder(answers) {
  const rng = mulberry32(hashString("GIVEN-DAILY-v2"));
  const arr = answers.map(normalizeName);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function pickDailyPuzzle(answers, dateKey) {
  const eligible = answers.filter((name) => normalizeName(name).length === PLAY_LENGTH);
  if (!eligible.length) throw new Error("No five-letter answers");
  const order = dailyOrder(eligible);
  const num = puzzleNumber(dateKey);
  const name = order[(num - 1 + order.length) % order.length];
  return {
    name,
    length: name.length,
    dateKey,
    index: num,
  };
}

export function pickRandomPuzzle(answers, rng = Math.random, excludeName = null, length = PLAY_LENGTH) {
  if (!PRACTICE_LENGTHS.includes(length)) throw new Error("Practice length must be 5, 6, or 7");
  const eligible = answers.filter((name) => normalizeName(name).length === length);
  if (!eligible.length) throw new Error(`No ${length}-letter answers`);
  const fresh = eligible.filter((name) => normalizeName(name) !== normalizeName(excludeName));
  const pool = fresh.length ? fresh : eligible;
  const idx = Math.floor(rng() * pool.length);
  const name = normalizeName(pool[idx]);
  return {
    name,
    length: name.length,
    dateKey: null,
    index: null,
  };
}

export function validateGuess(guess, puzzle, guessSet, prior) {
  const g = normalizeName(guess);
  const secretLen = puzzle.length;
  if (g.length !== secretLen) {
    return { ok: false, reason: g.length < secretLen ? "Not enough letters" : `Must be ${secretLen} letters` };
  }
  if (!guessSet.has(g)) {
    return { ok: false, reason: "Not in name list" };
  }
  if (prior && prior.hardMode) {
    const hard = checkHardMode(g, prior.guesses, prior.evaluations);
    if (!hard.ok) return hard;
  }
  return { ok: true, guess: g };
}

export function checkHardMode(guess, guesses, evaluations) {
  const g = normalizeName(guess);
  for (let i = 0; i < guesses.length; i++) {
    const prev = normalizeName(guesses[i]);
    const ev = evaluations[i];
    const neededPresent = {};
    for (let j = 0; j < prev.length; j++) {
      if (ev[j] === "correct" && g[j] !== prev[j]) {
        return { ok: false, reason: `${prev[j]} must stay in position ${j + 1}` };
      }
      if (ev[j] === "present") {
        neededPresent[prev[j]] = (neededPresent[prev[j]] || 0) + 1;
      }
    }
    for (const [ch, count] of Object.entries(neededPresent)) {
      const have = g.split("").filter((c) => c === ch).length;
      if (have < count) {
        return { ok: false, reason: `Must use ${ch}` };
      }
    }
  }
  return { ok: true };
}

export function createGame(puzzle) {
  return {
    puzzle,
    guesses: [],
    evaluations: [],
    status: "playing",
    current: "",
  };
}

export function migrateSavedGame(saved) {
  if (saved.status !== "playing" || !saved.puzzle?.start) return saved;
  const puzzle = { ...saved.puzzle };
  delete puzzle.start;
  delete puzzle.contain;
  return { ...saved, puzzle, current: "" };
}

export function typeLetter(game, letter, maxLen) {
  if (game.status !== "playing") return game;
  const ch = normalizeName(letter);
  if (!ch || ch.length !== 1) return game;
  if (game.current.length >= maxLen) return game;
  return { ...game, current: game.current + ch };
}

export function backspace(game) {
  if (game.status !== "playing") return game;
  if (!game.current.length) return game;
  return { ...game, current: game.current.slice(0, -1) };
}

export function submitGuess(game, guessSet, options = {}) {
  if (game.status !== "playing") {
    return { game, error: "Game is over" };
  }
  const check = validateGuess(game.current, game.puzzle, guessSet, {
    hardMode: Boolean(options.hardMode),
    guesses: game.guesses,
    evaluations: game.evaluations,
  });
  if (!check.ok) return { game, error: check.reason };

  const evaluation = evaluateGuess(check.guess, game.puzzle.name);
  const guesses = [...game.guesses, check.guess];
  const evaluations = [...game.evaluations, evaluation];
  const won = evaluation.every((s) => s === "correct");
  const lost = !won && guesses.length >= MAX_GUESSES;
  return {
    game: {
      ...game,
      guesses,
      evaluations,
      current: won || lost ? check.guess : "",
      status: won ? "won" : lost ? "lost" : "playing",
    },
    error: null,
  };
}

export function shareGrid(game, { url = "" } = {}) {
  const glyphs = { correct: "🟩", present: "🟨", absent: "⬛" };
  const rows = game.evaluations.map((ev) => ev.map((s) => glyphs[s]).join(""));
  const score = game.status === "won" ? String(game.guesses.length) : "X";
  const num = game.puzzle.dateKey ? puzzleNumber(game.puzzle.dateKey) : null;
  const title = num
    ? `GIVEN ${num} ${score}/${MAX_GUESSES}`
    : `GIVEN PRACTICE · ${game.puzzle.length} LETTERS ${score}/${MAX_GUESSES}`;
  return [title, "", ...rows, ...(url ? ["", url] : [])].join("\n");
}
