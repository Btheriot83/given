/**
 * Build the web copies of the iPhone app's Name Story data:
 *   data/name-facts.json   SSA facts (same short keys as the app's name-facts.json)
 *   data/name-stories.json meanings, origins, up to two songs/films/books and three namesakes
 *
 * Only names that can be a web answer are kept: the familiar, dailyFive, dailySix, dailySeven and obscure pools,
 * plus every name the legacy schedule actually used (2026-01-01 through the day before
 * FAMILIAR_START_DATE). Source URLs and namesake eras are dropped; the card credits
 * Wiktionary and Wikipedia as a whole, like the app.
 *
 *   node scripts/build-name-story-data.mjs [path/to/shipaton-named/Named/Resources]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { pickDailyPuzzle, shiftDateKey, FAMILIAR_START_DATE } from "../js/engine.js";

const resources = resolve(process.argv[2] || `${homedir()}/projects/shipaton-named/Named/Resources`);
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const local = (path) => read(new URL(`../data/${path}`, import.meta.url));

const names = local("names.json");
const pools = local("answer-pools.json");
const facts = read(`${resources}/name-facts.json`);
const stories = read(`${resources}/name-stories.json`);

const keep = new Set([...pools.familiar, ...pools.dailyFive, ...(pools.dailySix || []), ...(pools.dailySeven || []), ...pools.obscure].map((n) => n.toUpperCase()));
for (let day = "2026-01-01"; day < FAMILIAR_START_DATE; day = shiftDateKey(day, 1)) {
  keep.add(pickDailyPuzzle(names.answers, day, pools.familiar, pools.lengthWeights, pools).name);
}

const sorted = [...keep].sort();
const factNames = {};
const storyNames = {};
for (const name of sorted) {
  if (facts.names[name]) factNames[name] = facts.names[name];
  const story = stories.names[name];
  if (!story) continue;
  const entry = {};
  if (story.meaning) entry.meaning = story.meaning;
  if (story.origin) entry.origin = story.origin;
  const namesakes = (story.namesakes || []).slice(0, 3).map(({ person, fact }) => ({ person, fact }));
  if (namesakes.length) entry.namesakes = namesakes;
  const culture = (story.culture || []).slice(0, 2).map(({ kind, title, year, fact }) =>
    (Number.isInteger(year) ? { kind, title, year, fact } : { kind, title, fact }));
  if (culture.length) entry.culture = culture;
  if (Object.keys(entry).length) storyNames[name] = entry;
}

const factsOut = { source: facts.source, firstYear: facts.firstYear, throughYear: facts.throughYear, yt: facts.yt, names: factNames };
writeFileSync(new URL("../data/name-facts.json", import.meta.url), `${JSON.stringify(factsOut)}\n`);
writeFileSync(new URL("../data/name-stories.json", import.meta.url), `${JSON.stringify({ names: storyNames })}\n`);
console.log(`Answer names: ${sorted.length}; with facts: ${Object.keys(factNames).length}; with stories: ${Object.keys(storyNames).length}`);
