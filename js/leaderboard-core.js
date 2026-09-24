import { createGame, pickDailyPuzzle, submitGuess, MAX_GUESSES } from "./engine.js";

export function validDateKey(value, now = new Date()) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return false;
  return Math.abs(date.getTime() - now.getTime()) <= 36 * 3600 * 1000;
}

export function normalizeGroup(value) {
  const code = String(value || "").toUpperCase();
  return /^[A-HJ-NP-Z2-9]{8}$/.test(code) ? code : null;
}

export function validateResult(body, names, now = new Date()) {
  if (!body || typeof body !== "object") throw new Error("Invalid result");
  const group = normalizeGroup(body.group);
  if (!group || !validDateKey(body.dateKey, now)) throw new Error("Invalid group or day");
  const nickname = String(body.nickname || "").trim().replace(/\s+/g, " ");
  if (!/^[\p{L}\p{N} _.'-]{2,20}$/u.test(nickname)) throw new Error("Nickname must be 2–20 plain characters");
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,44}$/i.test(String(body.playerId || ""))) throw new Error("Invalid player ID");
  if (!Array.isArray(body.guesses) || body.guesses.length < 1 || body.guesses.length > MAX_GUESSES) throw new Error("Invalid guesses");
  const puzzle = pickDailyPuzzle(names.answers, names.contain, body.dateKey);
  const guessSet = new Set(names.guesses);
  let game = createGame(puzzle);
  for (const guess of body.guesses) {
    if (typeof guess !== "string" || !/^[A-Z]{5}$/.test(guess)) throw new Error("Invalid guess");
    game.current = guess;
    const next = submitGuess(game, guessSet);
    if (next.error) throw new Error("Invalid guess sequence");
    game = next.game;
  }
  if (game.status === "playing") throw new Error("Finish the daily puzzle first");
  return {
    group,
    dateKey: body.dateKey,
    playerId: body.playerId,
    nickname,
    score: game.status === "won" ? game.guesses.length : null,
  };
}

export function rankEntries(entries) {
  return entries.sort((a, b) => (a.score ?? 7) - (b.score ?? 7) || a.createdAt - b.createdAt || a.nickname.localeCompare(b.nickname));
}
