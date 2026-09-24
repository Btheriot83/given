/** Build compact, sourced post-game name facts from SSA's national names.zip. */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const zip = process.argv[2];
if (!zip) {
  console.error("Usage: node scripts/build-name-notes.mjs /path/to/ssa-names.zip");
  process.exit(1);
}

const answers = new Set(
  JSON.parse(readFileSync(new URL("../data/names.json", import.meta.url))).answers
);
const files = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" })
  .split("\n")
  .filter((name) => /^yob\d{4}\.txt$/.test(name))
  .sort();
if (!files.length || files.at(-1) !== "yob2025.txt") {
  throw new Error("Expected SSA national name files through 2025");
}

const counts = new Map();
for (const file of files) {
  const year = Number(file.slice(3, 7));
  const annual = new Map();
  const rows = execFileSync("unzip", ["-p", zip, file], { encoding: "utf8" }).trim().split("\n");
  for (const row of rows) {
    const [rawName, , rawCount] = row.trim().split(",");
    const name = rawName?.toUpperCase();
    const count = Number(rawCount);
    if (!answers.has(name) || !Number.isSafeInteger(count) || count < 5) continue;
    annual.set(name, (annual.get(name) || 0) + count);
  }
  for (const [name, count] of annual) {
    const current = counts.get(name) || { total: 0, peakYear: year, peakCount: 0 };
    current.total += count;
    if (count > current.peakCount) {
      current.peakYear = year;
      current.peakCount = count;
    }
    counts.set(name, current);
  }
}

const output = {
  source: "https://www.ssa.gov/oact/babynames/limits.html",
  throughYear: 2025,
  counts: Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b))),
};
writeFileSync(new URL("../data/name-notes.json", import.meta.url), JSON.stringify(output));
console.log(`Wrote facts for ${counts.size} of ${answers.size} answers`);
