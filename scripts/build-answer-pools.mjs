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

// From DAILY_SHORT_START_DATE the official daily is mostly five or six letters, with a
// seven-letter name about one day a week (they are the hard ones). Each
// pool is every familiar name of that length plus the next most common ones (40,000+ U.S.
// births). Five-letter names never overlap the obscure pool (under 20,000).
const everyday = (length) => names.answers.filter((name) => {
  const fact = notes.counts[name];
  return fact && name.length === length && (familiarSet.has(name) || fact.total >= 40_000);
});
const dailyFive = everyday(5);
const dailySix = everyday(6);
const dailySeven = everyday(7);

// Weight lengths by recorded births, then give names within a length equal turns.
const lengthWeights = Object.fromEntries([4, 5, 6, 7].map((length) => [
  length, familiar.filter((name) => name.length === length)
    .reduce((sum, name) => sum + notes.counts[name].total, 0),
]));
const output = { familiar, obscure, dailyFive, dailySix, dailySeven, lengthWeights };
writeFileSync(new URL("../data/answer-pools.json", import.meta.url), `${JSON.stringify(output)}\n`);
console.log(`Familiar: ${familiar.length}; daily five: ${dailyFive.length}; daily six: ${dailySix.length}; daily seven: ${dailySeven.length}; obscure: ${obscure.length}`);
