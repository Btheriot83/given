import { readFileSync } from "fs";
import { describeName } from "../js/name-notes.js";
import { normalizeGroup, rankEntries, validDateKey, validateResult } from "../js/leaderboard-core.js";
import {
  evaluateGuess,
  validateGuess,
  pickDailyPuzzle,
  pickRandomPuzzle,
  pickContainLetter,
  checkHardMode,
  createGame,
  typeLetter,
  backspace,
  submitGuess,
  shareGrid,
  utcDateKey,
  puzzleNumber,
  bestKeyStates,
  applyStreak,
  shiftDateKey,
  dailyOrder,
  clueCandidates,
  MAX_GUESSES,
  PLAY_LENGTH,
  dateKeyFromPuzzleNumber,
} from "../js/engine.js";

const names = JSON.parse(readFileSync(new URL("../data/names.json", import.meta.url)));
const nameNotes = JSON.parse(readFileSync(new URL("../data/name-notes.json", import.meta.url)));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function equal(a, b, msg) {
  const left = JSON.stringify(a);
  const right = JSON.stringify(b);
  if (left !== right) throw new Error(`${msg || "assert"}: ${left} !== ${right}`);
}

equal(evaluateGuess("BETH", "BETH"), ["correct", "correct", "correct", "correct"], "exact");
equal(evaluateGuess("BERT", "BETH"), ["correct", "correct", "absent", "present"], "bert vs beth");
equal(evaluateGuess("ELLE", "ELLA"), ["correct", "correct", "correct", "absent"], "elle vs ella");
equal(evaluateGuess("EMMA", "AMEL"), ["present", "correct", "absent", "present"], "emma vs amel");
equal(evaluateGuess("ANNA", "NANA"), ["present", "present", "correct", "correct"], "anna vs nana");
equal(evaluateGuess("ARRAY", "ARMOR"), ["correct", "correct", "present", "absent", "absent"], "array vs armor");
equal(evaluateGuess("SPEED", "ERASE"), ["present", "absent", "present", "present", "absent"], "speed vs erase");
equal(evaluateGuess("EEEEL", "STEAL"), ["absent", "absent", "correct", "absent", "correct"], "eeeel vs steal");

const puzzle = { name: "BETH", start: "B", contain: "H", length: 4 };
const dict = new Set(["BETH", "BART", "BENT", "BERT", "BRET", "BEAU", "BEAH"]);

equal(validateGuess("BETH", puzzle, dict).ok, true, "beth valid");
equal(validateGuess("BART", puzzle, dict).ok, false, "bart missing H");
assert(validateGuess("BART", puzzle, dict).reason.includes("H"), "missing contain reason");
assert(validateGuess("KATE", puzzle, dict).reason.includes("B"), "must start with B");
assert(validateGuess("BET", puzzle, dict).reason.includes("Not enough letters"), "short");
assert(validateGuess("BASH", puzzle, dict).reason.includes("Not in name list"), "unknown name");

const yellowFail = checkHardMode("BEAU", ["BERT"], [evaluateGuess("BERT", "BETH")]);
equal(yellowFail.ok, false, "hard mode requires yellow T");
assert(yellowFail.reason.includes("T"), "yellow reason names T");
const hard = checkHardMode("BETH", ["BERT"], [evaluateGuess("BERT", "BETH")]);
equal(hard.ok, true, "hard mode allows beth after bert");

let game = createGame(puzzle);
equal(game.current, "B", "first letter given");
game = typeLetter(game, "B", 4);
equal(game.current, "B", "retyping given letter is ignored");
game = typeLetter(game, "E", 4);
game = typeLetter(game, "T", 4);
game = typeLetter(game, "H", 4);
equal(game.current, "BETH", "typed remaining letters");
game = typeLetter(game, "X", 4);
equal(game.current, "BETH", "does not overflow");
game = backspace(game);
equal(game.current, "BET", "backspace");
game = backspace(backspace(backspace(game)));
equal(game.current, "B", "cannot delete given letter");

game = createGame(puzzle);
for (const ch of "ETH") game = typeLetter(game, ch, 4);
const submitted = submitGuess(game, dict);
equal(submitted.game.status, "won", "win on beth");
assert(shareGrid(submitted.game).includes("🟩🟩🟩🟩"), "share greens");
assert(shareGrid(submitted.game).startsWith("GIVEN PRACTICE"), "practice share is labeled");
assert(!shareGrid(submitted.game).includes("http"), "share has no link");
assert(puzzleNumber("2026-01-01") === 1, "puzzle number origin");

const afterWin = submitGuess(submitted.game, dict);
assert(afterWin.error === "Game is over", "no submit after win");

let loss = createGame(puzzle);
for (let i = 0; i < MAX_GUESSES; i++) {
  loss.current = "BEAH";
  const step = submitGuess(loss, dict);
  loss = step.game;
}
equal(loss.status, "lost", "loss at 6");

const mixedAnswers = ["BETH", "JAMES", "MARIA", "SARAH", "AARON", "ELLA"];
const mixedClues = { JAMES: "A", MARIA: "R", SARAH: "A", AARON: "R" };
const a = pickDailyPuzzle(mixedAnswers, mixedClues, "2026-08-13");
const b = pickDailyPuzzle(mixedAnswers, mixedClues, "2026-08-13");
equal(a.name, b.name, "daily is stable");
equal(a.length, PLAY_LENGTH, "daily uses five letters");
const c = pickDailyPuzzle(mixedAnswers, mixedClues, "2026-08-14");
assert(a.name !== c.name, "next day moves in shuffled order");
equal(pickRandomPuzzle(mixedAnswers, mixedClues, () => 0).length, PLAY_LENGTH, "practice uses five letters");
assert(names.answers.filter((name) => name.length === PLAY_LENGTH).length > 365, "five-letter pool spans a year");
assert(utcDateKey(new Date("2026-08-13T12:00:00Z")) === "2026-08-13", "local date key at noon utc");
equal(pickContainLetter("BETH", ["BETH", "BEAH", "BOSH", "BUSH"]), "H", "contain maximizes B+H");

const keys = bestKeyStates(["BERT"], [evaluateGuess("BERT", "BETH")]);
equal(keys.B, "correct", "key B");
equal(keys.E, "correct", "key E");
equal(keys.T, "present", "key T");
equal(keys.R, "absent", "key R");

const streak0 = { played: 3, wins: 3, streak: 3, maxStreak: 3, lastDate: "2026-08-10", dist: [0, 0, 3, 0, 0, 0] };
const broken = applyStreak(streak0, "2026-08-13", true);
equal(broken.streak, 1, "skipped day breaks streak");
const continued = applyStreak(streak0, shiftDateKey("2026-08-10", 1), true);
equal(continued.streak, 4, "yesterday continues streak");

assert(names.contain.BETH === "H", "BETH contain is H");
assert(!names.guesses.includes("BOOT"), "BOOT is not a valid name");
assert(!names.answers.includes("MAMA"), "MAMA is not an answer");
assert(!names.answers.includes("BETH"), "BETH is teaching-only, not a singleton daily");

for (const name of names.answers) {
  const ch = names.contain[name];
  const pool = clueCandidates(name[0], ch, name.length, names.guesses);
  assert(pool.length >= 8, `${name} clue-set too small: ${pool.length}`);
}

const order = dailyOrder(names.answers);
assert(new Set(order).size === names.answers.length, "shuffled daily order is a permutation");

equal(dateKeyFromPuzzleNumber(1), "2026-01-01", "puzzle 1");
equal(puzzleNumber(dateKeyFromPuzzleNumber(225)), 225, "puzzle number roundtrip");

const numbered = { ...submitted.game, puzzle: { ...submitted.game.puzzle, dateKey: "2026-08-13" } };
const shared = shareGrid(numbered);
assert(shared.startsWith("GIVEN "), "share title");
assert(shared.includes("1/6"), "share score");
assert(!shared.includes("B · H"), "share is grid only");
const linkedShare = shareGrid(numbered, { url: "https://given-one.vercel.app/" });
assert(linkedShare.endsWith("https://given-one.vercel.app/"), "share includes play link");
assert(!linkedShare.includes("BETH"), "share does not spoil the answer");

assert(nameNotes.source === "https://www.ssa.gov/oact/babynames/limits.html", "name facts have primary source");
assert(nameNotes.counts.JAMES.total > 1_000_000, "common name has SSA count");
assert(describeName("JAMES", nameNotes).includes("1880–2025"), "fact gives data window");
assert(describeName("ZZZZZ", nameNotes).includes("does not appear"), "missing fact avoids invented count");
assert(normalizeGroup("ABCD2345") === "ABCD2345", "invite code accepted");
assert(normalizeGroup("BAD!CODE") === null, "invite code rejects punctuation");
assert(validDateKey("2026-09-23", new Date("2026-09-23T12:00:00Z")), "current daily date accepted");
assert(!validDateKey("2026-09-31", new Date("2026-09-23T12:00:00Z")), "invalid calendar date rejected");
assert(!validDateKey("2026-08-23", new Date("2026-09-23T12:00:00Z")), "old results rejected");
const testDate = "2026-09-23";
const testAnswer = pickDailyPuzzle(names.answers, names.contain, testDate).name;
const playerId = "12345678-1234-4234-8234-123456789abc";
const payload = { group: "ABCD2345", dateKey: testDate, nickname: "Name Fan", playerId, guesses: [testAnswer] };
const verified = validateResult(payload, names, new Date("2026-09-23T12:00:00Z"));
assert(verified.score === 1 && verified.nickname === "Name Fan", "server replays valid win");
for (const bad of [
  { ...payload, guesses: ["AAAAA"] },
  { ...payload, guesses: [] },
  { ...payload, nickname: "<script>" },
  { ...payload, group: "invalid!" },
]) {
  let rejected = false;
  try { validateResult(bad, names, new Date("2026-09-23T12:00:00Z")); } catch { rejected = true; }
  assert(rejected, "invalid leaderboard result rejected");
}
equal(rankEntries([
  { nickname: "Lost", score: null, createdAt: 1 },
  { nickname: "Two", score: 2, createdAt: 2 },
  { nickname: "One", score: 1, createdAt: 3 },
]).map((entry) => entry.nickname), ["One", "Two", "Lost"], "rank by guesses then loss");

console.log("engine.test.js: all passed");
