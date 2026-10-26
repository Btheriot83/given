// The Jackpot win show's script: the tier words and timings the iPhone app mirrors.
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { JACKPOT, jackpotTier, chimeFor } from "../js/jackpot.js";

const words = [1, 2, 3, 4, 5, 6].map((n) => jackpotTier(n).word);
assert.deepEqual(words, ["JACKPOT!", "JACKPOT!", "WINNER!", "WINNER!", "SOLVED!", "PHEW!"]);
assert.equal(jackpotTier(1).coins, true);
assert.equal(jackpotTier(2).coins, true);
assert.ok([3, 4, 5, 6].every((n) => !jackpotTier(n).coins), "only JACKPOT! rains coins");

assert.equal(JACKPOT.rowStep, 0.11);
assert.equal(JACKPOT.bulbsAt, 0.6);
assert.equal(JACKPOT.chaseFor, 1.2);
assert.equal(JACKPOT.flashes, 3);
assert.equal(JACKPOT.signAt, 0.7);
assert.equal(JACKPOT.cannonsAt, 0.8);
assert.equal(JACKPOT.exitAt, 2.8);
assert.equal(JACKPOT.confettiUntil, 4.0);
assert.ok(JACKPOT.letterStep < JACKPOT.rowStep, "letters ding faster than the row");

// One note higher per tile: six chimes, then the sixth pitched up a whole step at a time.
assert.deepEqual([0, 1, 2, 3, 4, 5].map((i) => chimeFor(i)), [1, 2, 3, 4, 5, 6].map((n) => ({ name: `jackpot_chime_${n}`, rate: 1 })));
assert.ok(chimeFor(6).rate > 1 && chimeFor(7).rate > chimeFor(6).rate);

for (const name of ["jackpot_chime_1", "jackpot_chime_2", "jackpot_chime_3", "jackpot_chime_4", "jackpot_chime_5", "jackpot_chime_6", "jackpot_cheer"]) {
  const file = new URL(`../audio/${name}.m4a`, import.meta.url);
  assert.ok(existsSync(file), `${name}.m4a is shipped`);
  assert.ok(statSync(file).size < 150 * 1024, `${name}.m4a stays under 150 KB`);
}

console.log("jackpot: ok");
