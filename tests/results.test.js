import names from "../data/names.json" with { type: "json" };
import answerPools from "../data/answer-pools.json" with { type: "json" };
import { createHandler, buildSummary, validDateKey } from "../api/results.js";
import { pickDailyPuzzle, puzzleNumber, HISTORY_START_DATE } from "../js/engine.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function equal(a, b, msg) {
  const left = JSON.stringify(a);
  const right = JSON.stringify(b);
  if (left !== right) throw new Error(`${msg || "assert"}: ${left} !== ${right}`);
}

const KV_URL = "https://kv.example.test";
const env = { KV_REST_API_URL: KV_URL, KV_REST_API_TOKEN: "kv-token", ATTRIBUTION_ADMIN_TOKEN: "admin-secret" };
const NOW = Date.parse("2026-10-24T15:00:00Z");
const TODAY = "2026-10-24";

// In-memory Upstash: hashes, strings, sorted sets, EXPIRE bookkeeping.
function fakeRedis() {
  const hashes = new Map();
  const strings = new Map();
  const zsets = new Map();
  const ttl = new Map();
  const hash = (key) => {
    if (!hashes.has(key)) hashes.set(key, new Map());
    return hashes.get(key);
  };
  const zset = (key) => {
    if (!zsets.has(key)) zsets.set(key, new Map());
    return zsets.get(key);
  };
  const bound = (value, low) => {
    if (value === "+inf") return { v: Infinity, open: false };
    if (value === "-inf") return { v: -Infinity, open: false };
    const s = String(value);
    return s.startsWith("(") ? { v: Number(s.slice(1)), open: true } : { v: Number(s), open: false, low };
  };
  function run([cmd, key, ...args]) {
    switch (cmd) {
      case "HSETNX": {
        const h = hash(key);
        if (h.has(args[0])) return 0;
        h.set(args[0], String(args[1]));
        return 1;
      }
      case "HSET": {
        const h = hash(key);
        for (let i = 0; i < args.length; i += 2) h.set(args[i], String(args[i + 1]));
        return args.length / 2;
      }
      case "HGET":
        return hash(key).has(args[0]) ? hash(key).get(args[0]) : null;
      case "HDEL":
        return args.filter((field) => hash(key).delete(field)).length;
      case "HGETALL":
        return [...hash(key).entries()].flat();
      case "HMGET":
        return args.map((field) => (hash(key).has(field) ? hash(key).get(field) : null));
      case "HINCRBY": {
        const h = hash(key);
        const next = Number(h.get(args[0]) || 0) + Number(args[1]);
        h.set(args[0], String(next));
        return next;
      }
      case "INCR": {
        const next = Number(strings.get(key) || 0) + 1;
        strings.set(key, String(next));
        return next;
      }
      case "EXPIRE":
        ttl.set(key, Number(args[0]));
        return 1;
      case "DEL": {
        const existed = (hashes.get(key)?.size || 0) > 0 || strings.has(key);
        hashes.delete(key);
        strings.delete(key);
        return existed ? 1 : 0;
      }
      case "SCAN": {
        const pattern = String(args[1]).replace(/\*$/, "");
        return ["0", [...hashes.keys()].filter((k) => k.startsWith(pattern) && hashes.get(k).size)];
      }
      case "ZADD":
        zset(key).set(args[1], Number(args[0]));
        return 1;
      case "ZREM":
        return zset(key).delete(args[0]) ? 1 : 0;
      case "ZCARD":
        return zset(key).size;
      case "ZCOUNT": {
        const lo = bound(args[0]);
        const hi = bound(args[1]);
        return [...zset(key).values()].filter((v) => (lo.open ? v > lo.v : v >= lo.v) && (hi.open ? v < hi.v : v <= hi.v)).length;
      }
      default:
        throw new Error(`unexpected redis command ${cmd}`);
    }
  }
  return { hashes, zsets, ttl, strings, run, hget: (key) => Object.fromEntries(hash(key)) };
}

function setup({ envOverride, now = NOW } = {}) {
  const redis = fakeRedis();
  let calls = 0;
  async function fetchImpl(url, init) {
    assert(url === `${KV_URL}/pipeline`, `unexpected fetch ${url}`);
    assert(init.headers.authorization === "Bearer kv-token", "kv auth header");
    calls++;
    const commands = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => commands.map((c) => ({ result: redis.run(c) })) };
  }
  const handler = createHandler({ env: envOverride || env, fetchImpl, now: () => now });
  return { redis, handler, calls: () => calls };
}

async function call(handler, { method = "POST", body, query = {}, headers = {} } = {}) {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    end() { return this; },
  };
  await handler({ method, body, query, headers }, res);
  return res;
}

const NAMES = { ...names, familiarAnswers: answerPools.familiar, lengthWeights: answerPools.lengthWeights, dailyFive: answerPools.dailyFive };
const answerFor = (dateKey) => pickDailyPuzzle(NAMES.answers, dateKey, NAMES.familiarAnswers, NAMES.lengthWeights, NAMES.dailyFive).name;
function wrongGuesses(dateKey, count) {
  const answer = answerFor(dateKey);
  return names.guesses.filter((g) => g.length === answer.length && g !== answer).slice(0, count);
}
const winIn = (dateKey, n) => [...wrongGuesses(dateKey, n - 1), answerFor(dateKey)];
const lose = (dateKey) => wrongGuesses(dateKey, 6);
const uuid = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("date window: HISTORY_START_DATE through the server's tomorrow", () => {
  assert(validDateKey(HISTORY_START_DATE, NOW), "first day");
  assert(validDateKey("2026-10-25", NOW), "tomorrow");
  assert(!validDateKey("2026-10-26", NOW), "day after tomorrow");
  assert(!validDateKey("2026-09-25", NOW), "before history");
  assert(!validDateKey("2026-02-30", NOW), "impossible date");
  assert(!validDateKey(20261024, NOW), "number");
});

test("POST a win records counts, player hash, TTL and returns the summary", async () => {
  const { redis, handler } = setup();
  const n = puzzleNumber(TODAY);
  const res = await call(handler, { body: { installId: uuid(1).toUpperCase(), dateKey: TODAY, guesses: winIn(TODAY, 2) } });
  equal(res.statusCode, 200, "status");
  equal(res.headers["cache-control"], "no-store", "no-store");
  equal(res.body, {
    number: n, players: 1, solveRate: 100, dist: [0, 1, 0, 0, 0, 0], failed: 0,
    you: { score: 2, betterThan: 0, tiedWith: 100 },
    overall: { played: 1, wins: 1, average: 2, percentile: null, rankedPlayers: null },
  }, "summary");
  equal(redis.hget(`named:res:${n}`), { d2: "1", n: "1" }, "number hash");
  equal(redis.hget(`named:res:${n}:p`), { [uuid(1)]: "2" }, "players hash, lowercased id");
  equal(redis.hget(`named:plr:${uuid(1)}`), { played: "1", wins: "1", sum: "2", [`r${n}`]: "2" }, "player hash");
  equal(redis.ttl.get(`named:plr:${uuid(1)}`), 400 * 24 * 3600, "player TTL");
  assert(!redis.zsets.get("named:rank")?.size, "not ranked before 3 results");
});

test("POST a loss scores 7 and counts as failed", async () => {
  const { redis, handler } = setup();
  const n = puzzleNumber(TODAY);
  const res = await call(handler, { body: { installId: uuid(2), dateKey: TODAY, guesses: lose(TODAY) } });
  equal(res.statusCode, 200, "status");
  equal(res.body.you, { score: 7, betterThan: 0, tiedWith: 100 }, "you");
  equal(res.body.failed, 1, "failed");
  equal(res.body.solveRate, 0, "solve rate");
  equal(redis.hget(`named:res:${n}`), { x: "1", n: "1" }, "number hash");
  equal(res.body.overall, { played: 1, wins: 0, average: 7, percentile: null, rankedPlayers: null }, "overall");
});

test("first result per install per number wins; a replay changes nothing", async () => {
  const { redis, handler } = setup();
  const n = puzzleNumber(TODAY);
  const first = await call(handler, { body: { installId: uuid(3), dateKey: TODAY, guesses: winIn(TODAY, 4) } });
  const again = await call(handler, { body: { installId: uuid(3), dateKey: TODAY, guesses: winIn(TODAY, 1) } });
  equal(again.statusCode, 200, "status");
  equal(again.body, first.body, "same summary");
  equal(redis.hget(`named:res:${n}`), { d4: "1", n: "1" }, "counted once");
  equal(redis.hget(`named:plr:${uuid(3)}`).played, "1", "played once");
});

test("past numbers back to HISTORY_START_DATE are accepted, older and future ones are not", async () => {
  const { handler } = setup();
  const ok = await call(handler, { body: { installId: uuid(4), dateKey: HISTORY_START_DATE, guesses: winIn(HISTORY_START_DATE, 3) } });
  equal(ok.statusCode, 200, "first history day");
  equal(ok.body.number, puzzleNumber(HISTORY_START_DATE), "number");
  const tomorrow = await call(handler, { body: { installId: uuid(4), dateKey: "2026-10-25", guesses: winIn("2026-10-25", 3) } });
  equal(tomorrow.statusCode, 200, "server tomorrow is allowed");
  const early = await call(handler, { body: { installId: uuid(4), dateKey: "2026-09-25", guesses: ["ANNA"] } });
  equal(early.statusCode, 400, "before history");
  const future = await call(handler, { body: { installId: uuid(4), dateKey: "2026-10-27", guesses: winIn("2026-10-27", 1) } });
  equal(future.statusCode, 400, "future");
});

test("the five-letter daily pool is used from DAILY_FIVE_START_DATE", async () => {
  const { handler } = setup({ now: Date.parse("2026-11-02T10:00:00Z") });
  const day = "2026-11-02";
  assert(answerFor(day).length === 5, "five letters");
  const res = await call(handler, { body: { installId: uuid(5), dateKey: day, guesses: winIn(day, 5) } });
  equal(res.statusCode, 200, "status");
  equal(res.body.you.score, 5, "score");
});

test("bad bodies and replay mismatches return 400 without writing", async () => {
  const { redis, handler } = setup();
  const answer = answerFor(TODAY);
  const cases = [
    undefined,
    "not json",
    [],
    { installId: "nope", dateKey: TODAY, guesses: winIn(TODAY, 1) },
    { installId: uuid(6), dateKey: "2026-13-01", guesses: winIn(TODAY, 1) },
    { installId: uuid(6), dateKey: TODAY },
    { installId: uuid(6), dateKey: TODAY, guesses: [] },
    { installId: uuid(6), dateKey: TODAY, guesses: wrongGuesses(TODAY, 3) }, // unfinished
    { installId: uuid(6), dateKey: TODAY, guesses: [...wrongGuesses(TODAY, 7)] }, // too many
    { installId: uuid(6), dateKey: TODAY, guesses: ["ZZZZZ".slice(0, answer.length).padEnd(answer.length, "Z")] }, // not a name
    { installId: uuid(6), dateKey: TODAY, guesses: [answer.toLowerCase()] },
    { installId: uuid(6), dateKey: TODAY, guesses: [answer, answer] }, // guess after the win
    { installId: uuid(6), dateKey: "2026-10-23", guesses: [answer] }, // right name, wrong day (unless equal)
  ].filter((body) => !(body?.dateKey === "2026-10-23" && answerFor("2026-10-23") === answer));
  for (const body of cases) {
    const res = await call(handler, { body });
    equal(res.statusCode, 400, `400 for ${JSON.stringify(body)}`);
    assert(typeof res.body.error === "string", "error message");
  }
  const big = await call(handler, { body: { installId: uuid(6) }, headers: { "content-length": "9000" } });
  equal(big.statusCode, 400, "oversized body");
  equal(redis.hashes.size, 0, "nothing written");
});

test("string bodies are parsed", async () => {
  const { handler } = setup();
  const res = await call(handler, { body: JSON.stringify({ installId: uuid(7), dateKey: TODAY, guesses: winIn(TODAY, 1) }) });
  equal(res.statusCode, 200, "status");
  equal(res.body.you.score, 1, "score");
});

test("distribution, betterThan and tiedWith across players", async () => {
  const { handler } = setup();
  const scores = [1, 2, 2, 3, 4, 7, 7, 3, 2, 6];
  let last;
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i];
    last = await call(handler, { body: { installId: uuid(100 + i), dateKey: TODAY, guesses: s === 7 ? lose(TODAY) : winIn(TODAY, s) } });
    equal(last.statusCode, 200, `post ${i}`);
  }
  equal(last.body.players, 10, "players");
  equal(last.body.dist, [1, 3, 2, 1, 0, 1], "dist");
  equal(last.body.failed, 2, "failed");
  equal(last.body.solveRate, 80, "solve rate");
  const get = await call(handler, { method: "GET", query: { number: String(puzzleNumber(TODAY)), installId: uuid(101) } });
  equal(get.statusCode, 200, "get");
  // score 2: worse = 3,3,4,6,7,7 = 6 of 10; tied = 3 of 10
  equal(get.body.you, { score: 2, betterThan: 60, tiedWith: 30 }, "you");
});

test("overall rank needs 3 results and compares averages", async () => {
  const { redis, handler } = setup();
  const days = ["2026-10-22", "2026-10-23", "2026-10-24"];
  const play = (id, day, s) => call(handler, { body: { installId: uuid(id), dateKey: day, guesses: s === 7 ? lose(day) : winIn(day, s) } });
  // A: 2,3,4 -> 3.0   B: 4,5,7 -> 5.33   C: 1,2,3 -> 2.0   D: two results only
  for (const [id, scores] of [[201, [2, 3, 4]], [202, [4, 5, 7]], [203, [1, 2, 3]], [204, [6, 6]]]) {
    for (let i = 0; i < scores.length; i++) await play(id, days[i], scores[i]);
  }
  equal(redis.zsets.get("named:rank").size, 3, "only 3+ results are ranked");
  const a = await call(handler, { method: "GET", query: { number: String(puzzleNumber("2026-10-24")), installId: uuid(201) } });
  equal(a.body.overall, { played: 3, wins: 3, average: 3, percentile: 33, rankedPlayers: 3 }, "A beats B only");
  const b = await call(handler, { method: "GET", query: { number: String(puzzleNumber("2026-10-24")), installId: uuid(202) } });
  equal(b.body.overall, { played: 3, wins: 2, average: 5.3, percentile: 0, rankedPlayers: 3 }, "B is last");
  const c = await call(handler, { method: "GET", query: { number: String(puzzleNumber("2026-10-24")), installId: uuid(203) } });
  equal(c.body.overall.percentile, 67, "C beats A and B");
  const d = await call(handler, { method: "GET", query: { number: String(puzzleNumber("2026-10-23")), installId: uuid(204) } });
  equal(d.body.overall, { played: 2, wins: 2, average: 6, percentile: null, rankedPlayers: null }, "D unranked");
  equal(d.body.you.score, 6, "D you");
});

test("GET for an unplayed number or without installId", async () => {
  const { handler } = setup();
  const n = puzzleNumber(TODAY);
  const res = await call(handler, { method: "GET", query: { number: String(n), installId: uuid(9) } });
  equal(res.statusCode, 200, "status");
  equal(res.body, {
    number: n, players: 0, solveRate: 0, dist: [0, 0, 0, 0, 0, 0], failed: 0, you: null,
    overall: { played: 0, wins: 0, average: null, percentile: null, rankedPlayers: null },
  }, "empty summary");
  const anon = await call(handler, { method: "GET", query: { number: String(n) } });
  equal(anon.body.you, null, "no you");
  equal(anon.body.overall, null, "no overall");
  for (const query of [{ number: "abc" }, { number: String(puzzleNumber(HISTORY_START_DATE) - 1) }, { number: String(n + 2) }, { number: String(n), installId: "bad" }]) {
    const r = await call(handler, { method: "GET", query });
    equal(r.statusCode, 400, `400 for ${JSON.stringify(query)}`);
  }
});

test("rate limit: 60 POSTs per install per hour", async () => {
  const { handler } = setup();
  const body = { installId: uuid(10), dateKey: TODAY, guesses: winIn(TODAY, 3) };
  for (let i = 0; i < 60; i++) equal((await call(handler, { body })).statusCode, 200, `post ${i}`);
  const limited = await call(handler, { body });
  equal(limited.statusCode, 429, "61st is limited");
  const other = await call(handler, { body: { ...body, installId: uuid(11) } });
  equal(other.statusCode, 200, "other installs unaffected");
  const nextHour = setup({ now: NOW + 3600 * 1000 });
  equal((await call(nextHour.handler, { body })).statusCode, 200, "fresh window");
});

test("405, 503 and admin DELETE", async () => {
  const { redis, handler } = setup();
  equal((await call(handler, { method: "PUT" })).statusCode, 405, "PUT");
  const none = setup({ envOverride: {} });
  equal((await call(none.handler, { body: {} })).statusCode, 503, "no storage POST");
  equal((await call(none.handler, { method: "GET", query: { number: "298" } })).statusCode, 503, "no storage GET");

  const n = puzzleNumber(TODAY);
  await call(handler, { body: { installId: uuid(12), dateKey: TODAY, guesses: winIn(TODAY, 2) } });
  await call(handler, { body: { installId: uuid(13), dateKey: TODAY, guesses: lose(TODAY) } });
  for (const day of ["2026-10-22", "2026-10-23"]) await call(handler, { body: { installId: uuid(12), dateKey: day, guesses: winIn(day, 3) } });
  assert(redis.zsets.get("named:rank").has(uuid(12)), "ranked before delete");

  equal((await call(handler, { method: "DELETE", query: { installId: uuid(12) } })).statusCode, 401, "no bearer");
  equal((await call(handler, { method: "DELETE", query: { installId: uuid(12) }, headers: { authorization: "Bearer nope" } })).statusCode, 401, "wrong bearer");
  const auth = { authorization: "Bearer admin-secret" };
  equal((await call(handler, { method: "DELETE", query: { installId: "bad" }, headers: auth })).statusCode, 400, "bad id");
  equal((await call(handler, { method: "DELETE", query: { installId: uuid(12).toUpperCase() }, headers: auth })).statusCode, 204, "deleted");
  equal(redis.hget(`named:res:${n}`), { d2: "0", n: "1", x: "1" }, "counts backed out");
  equal(redis.hget(`named:res:${n}:p`), { [uuid(13)]: "7" }, "other player kept");
  equal(redis.hget(`named:res:${puzzleNumber("2026-10-22")}`), { d3: "0", n: "0" }, "older number backed out");
  assert(!redis.zsets.get("named:rank").has(uuid(12)), "removed from rank");
  equal(redis.hget(`named:plr:${uuid(12)}`), {}, "player hash gone");
  equal((await call(handler, { method: "DELETE", query: { installId: uuid(12) }, headers: auth })).statusCode, 404, "second delete");
});

test("admin DELETE by test prefix removes only matching installs", async () => {
  const { redis, handler } = setup();
  const auth = { authorization: "Bearer admin-secret" };
  const testId = (i) => `7e57d0d0-0000-4000-8000-${String(i).padStart(12, "0")}`;
  await call(handler, { body: { installId: testId(1), dateKey: TODAY, guesses: winIn(TODAY, 2) } });
  await call(handler, { body: { installId: testId(2), dateKey: TODAY, guesses: lose(TODAY) } });
  await call(handler, { body: { installId: uuid(20), dateKey: TODAY, guesses: winIn(TODAY, 4) } });
  equal((await call(handler, { method: "DELETE", query: { installIdPrefix: "7e57d0d0-0000-" } })).statusCode, 401, "needs bearer");
  equal((await call(handler, { method: "DELETE", query: { installIdPrefix: "7e5" }, headers: auth })).statusCode, 400, "prefix too short");
  const res = await call(handler, { method: "DELETE", query: { installIdPrefix: "7E57D0D0-0000-" }, headers: auth });
  equal(res.statusCode, 200, "status");
  equal(res.body, { removed: 2 }, "removed two");
  const n = puzzleNumber(TODAY);
  equal(redis.hget(`named:res:${n}:p`), { [uuid(20)]: "4" }, "real player kept");
  const stats = redis.hget(`named:res:${n}`);
  equal([stats.n, stats.d4, stats.d2, stats.x], ["1", "1", "0", "0"], "counts backed out");
});

test("buildSummary handles a missing number hash", () => {
  equal(buildSummary(5, {}, null, null, null), { number: 5, players: 0, solveRate: 0, dist: [0, 0, 0, 0, 0, 0], failed: 0, you: null, overall: null }, "empty");
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}\n  ${error.message}`);
  }
}
if (failed) {
  console.error(`results.test.js: ${failed} failed`);
  process.exit(1);
}
console.log(`results.test.js: all ${tests.length} passed`);
