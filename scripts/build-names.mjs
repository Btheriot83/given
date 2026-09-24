import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { normalizeName, isValidNameShape } from "../js/engine.js";

const BAN = new Set(["BOOT", "MAMA"]);

function isJunk(name) {
  if (!/^[A-Z]+$/.test(name)) return true;
  if (/(.)\1{3,}/.test(name)) return true;
  if (/^[AEIOU]{5,}$/.test(name)) return true;
  return false;
}

// Preserve the legacy data file's answer pool and daily sequence when regenerating it.
function pickContainLetter(name, guesses) {
  const rest = [...new Set(name.slice(1))].filter((ch) => ch !== name[0]);
  const pool = rest.length ? rest : [...new Set(name.slice(1))];
  if (!pool.length) return name[0];
  let best = pool[0];
  let bestScore = -1;
  for (const ch of pool) {
    const score = guesses.filter((guess) => guess.length === name.length && guess[0] === name[0] && guess.includes(ch)).length;
    if (score > bestScore) {
      bestScore = score;
      best = ch;
    }
  }
  return best;
}

const raw = new Set();

const csv = readFileSync("/tmp/yob2024.txt", "utf8");
for (const line of csv.split("\n").slice(1)) {
  const m = line.match(/^\d+,"([^"]+)"/);
  if (m) raw.add(normalizeName(m[1]));
}

try {
  const extra = JSON.parse(readFileSync("/home/ubuntu/.cursor/projects/agent/agent-tools/dfbd93b7-425e-4076-8b91-0caf50ac1760.txt", "utf8"));
  for (const n of extra) raw.add(normalizeName(n));
} catch {
  /* optional extra list */
}

for (const extra of ["BETH", "BEAH", "BOSH", "BUSH", "BERT", "BEAT", "BEAU"]) {
  raw.add(extra);
}

const guesses = [...raw]
  .filter((n) => isValidNameShape(n) && !BAN.has(n) && !isJunk(n))
  .sort();

const contain = {};
for (const name of guesses) {
  contain[name] = pickContainLetter(name, guesses);
}
contain.BETH = "H";

const answers = guesses.filter((name) => {
  if (name === "BETH" || BAN.has(name)) return false;
  const ch = contain[name];
  let n = 0;
  for (const g of guesses) {
    if (g.length === name.length && g[0] === name[0] && g.includes(ch)) n += 1;
    if (n >= 8) return true;
  }
  return false;
});

mkdirSync(new URL("../data", import.meta.url), { recursive: true });
const out = { guesses, answers, contain };
writeFileSync(new URL("../data/names.json", import.meta.url), JSON.stringify(out));
console.log(`guesses ${guesses.length} answers ${answers.length} bethContain ${contain.BETH}`);
