import { createHandler, validatePost, pickAppleFields, APPLE_URL } from "../api/attribution.js";

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
const INSTALL = "3F2504E0-4F89-41D3-9A0C-0305E82C3301";
const KEY = `given:attr:${INSTALL.toLowerCase()}`;

// Minimal in-memory Upstash: hashes only, plus EXPIRE bookkeeping.
function fakeRedis() {
  const hashes = new Map();
  const ttl = new Map();
  const hash = (key) => {
    if (!hashes.has(key)) hashes.set(key, new Map());
    return hashes.get(key);
  };
  function run([cmd, key, ...args]) {
    const h = hash(key);
    switch (cmd) {
      case "HSETNX":
        if (h.has(args[0])) return 0;
        h.set(args[0], String(args[1]));
        return 1;
      case "HSET":
        for (let i = 0; i < args.length; i += 2) h.set(args[i], String(args[i + 1]));
        return args.length / 2;
      case "HDEL":
        return args.filter((field) => h.delete(field)).length;
      case "HGETALL":
        return [...h.entries()].flat();
      case "HMGET":
        return args.map((field) => (h.has(field) ? h.get(field) : null));
      case "HINCRBY": {
        const next = Number(h.get(args[0]) || 0) + Number(args[1]);
        h.set(args[0], String(next));
        return next;
      }
      case "DEL": {
        const existed = hashes.has(key) && hashes.get(key).size > 0;
        hashes.delete(key);
        return existed ? 1 : 0;
      }
      case "EXPIRE":
        ttl.set(key, Number(args[0]));
        return 1;
      default:
        throw new Error(`unexpected redis command ${cmd}`);
    }
  }
  return { hashes, ttl, run, get: (key) => Object.fromEntries(hash(key)) };
}

function setup({ apple = [], envOverride } = {}) {
  const redis = fakeRedis();
  const appleCalls = [];
  const sleeps = [];
  const appleQueue = [...apple];
  async function fetchImpl(url, init) {
    if (url === `${KV_URL}/pipeline`) {
      assert(init.headers.authorization === "Bearer kv-token", "kv auth header");
      const commands = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => commands.map((c) => ({ result: redis.run(c) })) };
    }
    if (url === APPLE_URL) {
      appleCalls.push(init);
      const next = appleQueue.shift() || { status: 404 };
      if (next.throws) throw new Error("network");
      return { ok: next.status === 200, status: next.status, json: async () => next.body };
    }
    throw new Error(`unexpected fetch ${url}`);
  }
  const handler = createHandler({
    env: envOverride || env,
    fetchImpl,
    sleep: async (ms) => { sleeps.push(ms); },
    now: () => 1_800_000_000_000,
  });
  return { handler, redis, appleCalls, sleeps };
}

function call(handler, { method = "POST", body, headers = {}, query = {} } = {}) {
  const res = {
    statusCode: 200, headers: {}, payload: undefined, ended: false,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    json(data) { this.payload = data; this.ended = true; return this; },
    end() { this.ended = true; return this; },
  };
  return handler({ method, body, headers, query }, res).then(() => res);
}

// --- validation -----------------------------------------------------------
equal(validatePost({ installId: INSTALL, token: "abc" }), { kind: "token", installId: INSTALL.toLowerCase(), token: "abc" }, "token body");
equal(validatePost({ installId: INSTALL, purchased: true }), { kind: "purchase", installId: INSTALL.toLowerCase() }, "purchase body");
for (const bad of [
  {},
  { installId: "not-a-uuid", token: "abc" },
  { installId: "3F2504E0-4F89-11D3-9A0C-0305E82C3301", token: "abc" }, // v1, not v4
  { installId: INSTALL, token: "" },
  { installId: INSTALL, token: "   " },
  { installId: INSTALL, token: 42 },
  { installId: INSTALL, token: "x".repeat(4097) },
  { installId: INSTALL, token: "a\nb" },
  { installId: INSTALL, purchased: false },
  { installId: INSTALL, purchased: "true" },
  { installId: INSTALL, token: "abc", purchased: true },
  { installId: INSTALL, token: "abc", ip: "1.2.3.4" },
]) {
  let rejected = false;
  try { validatePost(bad); } catch { rejected = true; }
  assert(rejected, `rejects ${JSON.stringify(bad).slice(0, 80)}`);
}
equal(
  pickAppleFields({ attribution: true, orgId: 40669820, campaignId: 542370539, adGroupId: 542317095, keywordId: 87675432, adId: 542317136, countryOrRegion: "us", conversionType: "Download", clickDate: "2020-04-08T17:17Z", extra: "dropped" }),
  { attribution: "1", orgId: "40669820", campaignId: "542370539", adGroupId: "542317095", keywordId: "87675432", adId: "542317136", countryOrRegion: "US", conversionType: "Download", clickDate: "2020-04-08T17:17Z" },
  "keeps only documented Apple fields",
);
equal(pickAppleFields({ attribution: false }), { attribution: "0" }, "organic install");

// --- HTTP contract ----------------------------------------------------------
{
  const { handler } = setup();
  equal((await call(handler, { method: "GET" })).statusCode, 405, "GET without summary is 405");
  equal((await call(handler, { method: "PUT", body: {} })).statusCode, 405, "PUT is 405");
  equal((await call(handler, { body: { installId: "nope", token: "t" } })).statusCode, 400, "bad uuid is 400");
  equal((await call(handler, { body: "{not json" })).statusCode, 400, "malformed JSON string is 400");
  equal((await call(handler, { body: [1, 2] })).statusCode, 400, "array body is 400");
  equal((await call(handler, { body: { installId: INSTALL, token: "t" }, headers: { "content-length": "9000" } })).statusCode, 400, "oversized body is 400");
  equal((await call(handler, { body: { installId: INSTALL, token: "t", pad: "x".repeat(9000) } })).statusCode, 400, "oversized parsed body is 400");
  let code;
  const res = { status(c) { code = c; return this; }, setHeader() { return this; }, json() { return this; }, end() { return this; } };
  await handler({ method: "POST", headers: {}, query: {}, get body() { throw new Error("Invalid JSON"); } }, res);
  equal(code, 400, "body getter that throws (Vercel malformed JSON) is 400");
}
{
  const { handler } = setup({ envOverride: {} });
  equal((await call(handler, { body: { installId: INSTALL, token: "t" } })).statusCode, 503, "missing storage env is 503");
}

// --- token post: Apple returns attribution after one 404 ---------------------
{
  const appleBody = { attribution: true, orgId: 1234567890, campaignId: 1234567890, adGroupId: 1234567890, keywordId: 12323222, adId: 1234567890, countryOrRegion: "US", conversionType: "Download", clickDate: "2020-04-08T17:17Z" };
  const { handler, redis, appleCalls, sleeps } = setup({ apple: [{ status: 404 }, { status: 200, body: appleBody }] });
  const res = await call(handler, { body: { installId: INSTALL, token: "real-token" } });
  equal(res.statusCode, 204, "token post returns 204");
  equal(res.payload, undefined, "204 has no body");
  equal(appleCalls.length, 2, "retried once after 404");
  equal(appleCalls[0].body, "real-token", "raw token posted to Apple");
  equal(appleCalls[0].headers["content-type"], "text/plain", "Apple call is text/plain");
  equal(sleeps, [5000], "5 s backoff between attempts");
  const record = redis.get(KEY);
  equal(record.campaignId, "1234567890", "campaign stored");
  equal(record.attribution, "1", "attribution stored");
  equal(record.appleStatus, "ok", "status ok");
  assert(record.firstSeen && record.resolvedAt, "timestamps stored");
  assert(!("token" in record), "token dropped once resolved");
  assert(!Object.keys(record).some((k) => /ip|agent/i.test(k)), "no IP or user agent stored");
  equal(redis.ttl.get(KEY), 400 * 24 * 3600, "record expires after 400 days");
  equal(redis.get("given:attr:stats"), { installs: "1", resolved: "1", attributed: "1" }, "install counters");

  // Repeat post is idempotent and does not call Apple again.
  equal((await call(handler, { body: { installId: INSTALL, token: "real-token" } })).statusCode, 204, "repeat token post 204");
  equal(appleCalls.length, 2, "resolved record is not re-exchanged");
  equal(redis.get("given:attr:stats").installs, "1", "install counted once");

  // Purchase, twice.
  equal((await call(handler, { body: { installId: INSTALL, purchased: true } })).statusCode, 204, "purchase 204");
  equal((await call(handler, { body: { installId: INSTALL, purchased: true } })).statusCode, 204, "repeat purchase 204");
  const after = redis.get(KEY);
  equal(after.purchased, "1", "purchased flag");
  assert(after.purchasedAt, "purchasedAt set");
  equal(redis.get("given:attr:stats").purchases, "1", "purchase counted once");
  equal(redis.get("given:attr:campaigns"), { "1234567890:installs": "1", "1234567890:purchases": "1" }, "per-campaign counts");

  // Summary.
  equal((await call(handler, { method: "GET", query: { summary: "1" } })).statusCode, 401, "summary needs bearer");
  equal((await call(handler, { method: "GET", query: { summary: "1" }, headers: { authorization: "Bearer wrong" } })).statusCode, 401, "wrong bearer 401");
  const summary = await call(handler, { method: "GET", query: { summary: "1" }, headers: { authorization: "Bearer admin-secret" } });
  equal(summary.statusCode, 200, "summary 200");
  equal(summary.payload, { installs: 1, purchases: 1, resolved: 1, attributed: 1, campaigns: [{ campaignId: "1234567890", installs: 1, purchases: 1 }] }, "summary body");
  equal(summary.headers["cache-control"], "no-store", "summary not cached");

  // Admin delete backs the record out of every counter.
  const del = (headers, installId = INSTALL) => call(handler, { method: "DELETE", query: { installId }, headers });
  equal((await del({})).statusCode, 401, "delete needs bearer");
  equal((await del({ authorization: "Bearer admin-secret" }, "nope")).statusCode, 400, "delete validates installId");
  equal((await del({ authorization: "Bearer admin-secret" })).statusCode, 204, "delete 204");
  assert(!redis.hashes.get(KEY)?.size, "record removed");
  equal((await del({ authorization: "Bearer admin-secret" })).statusCode, 404, "second delete 404");
  const cleared = await call(handler, { method: "GET", query: { summary: "1" }, headers: { authorization: "Bearer admin-secret" } });
  equal(cleared.payload, { installs: 0, purchases: 0, resolved: 0, attributed: 0, campaigns: [] }, "counters backed out");
}

// --- fake token: Apple says 400, still 204 -----------------------------------
{
  const { handler, redis, appleCalls } = setup({ apple: [{ status: 400 }] });
  const res = await call(handler, { body: { installId: INSTALL, token: "fake" } });
  equal(res.statusCode, 204, "rejected token still 204");
  equal(appleCalls.length, 1, "no retry on 400");
  equal(redis.get(KEY).appleStatus, "invalid", "invalid recorded");
  assert(!("token" in redis.get(KEY)), "invalid token not kept");
  equal(redis.get("given:attr:stats"), { installs: "1" }, "invalid token counts install only");
}

// --- Apple never ready: token kept, purchase resolves it lazily, campaign purchase counted once
{
  const { handler, redis, appleCalls, sleeps } = setup({
    apple: [{ status: 404 }, { throws: true }, { status: 503 }, { status: 200, body: { attribution: true, campaignId: 77, orgId: 1 } }],
  });
  equal((await call(handler, { body: { installId: INSTALL, token: "slow" } })).statusCode, 204, "unresolved token still 204");
  equal(appleCalls.length, 3, "three attempts");
  equal(sleeps, [5000, 5000], "two backoffs");
  equal(redis.get(KEY).token, "slow", "token kept for lazy resolution");
  equal(redis.get(KEY).appleStatus, "error", "last status recorded");
  equal((await call(handler, { body: { installId: INSTALL, purchased: true } })).statusCode, 204, "purchase 204");
  equal(appleCalls.length, 4, "purchase retried the exchange once");
  equal(redis.get(KEY).campaignId, "77", "resolved on purchase");
  equal(redis.get("given:attr:campaigns"), { "77:installs": "1", "77:purchases": "1" }, "late attribution counts the earlier purchase");
}

// --- purchase before any token creates the record ----------------------------
{
  const { handler, redis, appleCalls } = setup();
  equal((await call(handler, { body: { installId: INSTALL, purchased: true } })).statusCode, 204, "purchase without record 204");
  equal(redis.get(KEY).purchased, "1", "record created");
  equal(appleCalls.length, 0, "no Apple call without a token");
  equal(redis.get("given:attr:stats"), { purchases: "1" }, "purchase counted, no install");
}

// --- storage failure is 503, never 500 --------------------------------------
{
  const handler = createHandler({ env, fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }), sleep: async () => {} });
  equal((await call(handler, { body: { installId: INSTALL, token: "t" } })).statusCode, 503, "storage down is 503");
}

console.log("attribution.test.js: all passed");
