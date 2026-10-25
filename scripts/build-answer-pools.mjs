/** Build the fixed answer pools from the checked-in SSA name facts. */
import { readFileSync, writeFileSync } from "node:fs";

const names = JSON.parse(readFileSync(new URL("../data/names.json", import.meta.url)));
const notes = JSON.parse(readFileSync(new URL("../data/name-notes.json", import.meta.url)));

// Familiar favors widely used names and recent names with a substantial peak.
// Obscure is deliberately optional, but still requires a meaningful SSA record.
const familiar = names.answers.filter((name) => {
  const fact = notes.counts[name];
  return fact && [4, 5, 6, 7].includes(name.length) &&
    (fact.total >= 150_000 || (fact.peakYear >= 2010 && fact.peakCount >= 2_000));
});
const familiarSet = new Set(familiar);
const obscure = names.answers.filter((name) => {
  const total = notes.counts[name]?.total || 0;
  return name.length === 5 && total >= 5_000 && total < 20_000 && !familiarSet.has(name);
});

// From DAILY_FIVE_START_DATE the official daily is always five letters (like Wordle). Its pool
// is every familiar five-letter name plus the next most common ones (40,000+ U.S. births), so
// it runs close to a year before repeating. Never overlaps the obscure pool (under 20,000).
const dailyFive = names.answers.filter((name) => {
  const fact = notes.counts[name];
  return fact && name.length === 5 && (familiarSet.has(name) || fact.total >= 40_000);
});

// Weight lengths by recorded births, then give names within a length equal turns.
const lengthWeights = Object.fromEntries([4, 5, 6, 7].map((length) => [
  length, familiar.filter((name) => name.length === length)
    .reduce((sum, name) => sum + notes.counts[name].total, 0),
]));
const output = { familiar, obscure, dailyFive, lengthWeights };
writeFileSync(new URL("../data/answer-pools.json", import.meta.url), `${JSON.stringify(output)}\n`);
console.log(`Familiar: ${familiar.length}; daily five: ${dailyFive.length}; obscure: ${obscure.length}`);
