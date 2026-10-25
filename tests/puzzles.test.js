import { createPuzzles, finishMoment, vsHeadline, rankLine, freeLine, freeWindowAllows, cleanSummary } from "../js/puzzles.js";

function equal(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

const today = "2026-10-24";
equal(freeWindowAllows("2026-10-23", today), true, "yesterday is free");
equal(freeWindowAllows("2026-10-17", today), true, "7 days back is free");
equal(freeWindowAllows("2026-10-16", today), false, "8 days back is locked");
equal(freeWindowAllows(today, today), false, "today is not a past puzzle");

// iPhone copy (GlobalStats.headline / rankLine)
const s = (you, players = 10, solveRate = 80) => cleanSummary({ number: 296, players, solveRate, dist: [], failed: 0, you });
equal(vsHeadline(s({ score: 2, betterThan: 60, tiedWith: 30 })), "Better than 60% of players", "better than");
equal(vsHeadline(s({ score: 4, betterThan: 20, tiedWith: 0 })), "You and 1% of players got it in 4", "tied, at least 1%");
equal(vsHeadline(s({ score: 7, betterThan: 0, tiedWith: 20 }, 1342, 91)), "91% of 1,342 players solved it", "loss");
equal(vsHeadline(s({ score: 2, betterThan: 0, tiedWith: 100 }, 1)), null, "single player has no headline");
equal(rankLine(null), "Play 3 more puzzles to get ranked", "no results");
equal(rankLine({ played: 2, average: 3, percentile: null }), "Play 1 more puzzle to get ranked", "two results");
equal(rankLine({ played: 14, average: 3.6, percentile: 72 }), "Better than 72% of players · average 3.6 over 14 puzzles", "ranked");
equal(rankLine({ played: 4, average: 4, percentile: 0 }), "Average 4.0 over 4 puzzles · keep playing to climb", "below half never says better than 0%");
equal(rankLine({ played: 9, average: 3.9, percentile: 49 }), "Average 3.9 over 9 puzzles · keep playing to climb", "49% uses the climb form");
equal(rankLine({ played: 9, average: 3.4, percentile: 50 }), "Better than 50% of players · average 3.4 over 9 puzzles", "50% keeps the better-than form");
equal(freeLine(2), "2 of 3 free today, from the last week", "free line");
equal(cleanSummary({ number: "<b>", players: "9", you: { score: "2" } }).number, 0, "summary is coerced to numbers");

// Moments
equal(finishMoment({ won: true, guesses: 4, daily: true, streak: 7, prevMax: 9 }).ribbon, "7 days in a row!", "milestone");
equal(finishMoment({ won: true, guesses: 4, daily: true, streak: 8, prevMax: 7 }).ribbon, "New best streak!", "new best");
equal(finishMoment({ won: true, guesses: 2, daily: true, streak: 5, prevMax: 4 }).ribbon, "5 days in a row! · New best streak!", "two moments");
equal(finishMoment({ won: true, guesses: 1, daily: false }).ribbon, "First guess. Named on sight!", "quick win on a past puzzle");
equal(finishMoment({ won: true, guesses: 2, daily: true, streak: 14, prevMax: 20 }).ribbon, "14 days in a row! · In two!", "milestone and quick");
equal(finishMoment({ won: true, guesses: 3, daily: true, streak: 1, prevMax: 0 }), { level: "win", ribbon: "", big: false }, "plain first win");
equal(finishMoment({ won: false, guesses: 6, daily: true, streak: 0, prevMax: 5 }).big, false, "loss");

// Free allowance
const store = new Map();
const p = createPuzzles({
  prefix: "t",
  readStore: (k, f) => (store.has(k) ? JSON.parse(store.get(k)) : f),
  writeStore: (k, v) => store.set(k, JSON.stringify(v)),
  toast: () => {},
  fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
});
equal(p.nextPast(today), "2026-10-23", "next is yesterday");
equal(p.status("2026-10-16", today).kind, "locked", "older than a week");
for (const d of ["2026-10-23", "2026-10-22", "2026-10-21"]) equal(p.claim(d, today), true, `claim ${d}`);
equal(p.freeLeft(today), 0, "three used");
equal(p.status("2026-10-20", today), { kind: "locked", reason: "limit" }, "fourth is locked");
equal(p.claim("2026-10-20", today), false, "can't claim a fourth");
equal(p.status("2026-10-22", today).kind, "playing", "claimed stays playable");
equal(p.freeLeft("2026-10-25"), 3, "resets the next day");
p.recordPlayed("2026-10-23", 3);
equal(p.status("2026-10-23", today), { kind: "solved", score: 3 }, "solved");
p.recordPlayed("2026-10-22", 7);
equal(p.status("2026-10-22", today), { kind: "missed", score: 7 }, "missed");
equal(p.recordPlayed("2026-10-22", 2), false, "first result stands locally");
equal(p.status(today, today, { status: "won", guesses: ["A", "B"] }), { kind: "solved", score: 2, today: true }, "today solved");

console.log("puzzles.test.js: all passed");
