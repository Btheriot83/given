// Accounts API tests. Apple's JWKS is mocked with a locally generated RSA key; no network.

import { generateKeyPairSync, sign, verify, createPublicKey } from "node:crypto";
import names from "../data/names.json" with { type: "json" };
import answerPools from "../data/answer-pools.json" with { type: "json" };
import { createHandler, computeStreak, isoWeek, mergeLocal, parseLocal, emptyStats } from "../api/account.js";
import { APPLE_KEYS_URL, APPLE_REVOKE_URL, APPLE_TOKEN_URL, sha256hex } from "../lib/apple.js";
import { pickDailyPuzzle, puzzleNumber, shiftDateKey } from "../js/engine.js";
import { fakeRedis, fakeRes } from "./helpers/fake-redis.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function equal(a, b, msg) {
  const left = JSON.stringify(a);
  const right = JSON.stringify(b);
  if (left !== right) throw new Error(`${msg || "assert"}: ${left} !== ${right}`);
}

const KV_URL = "https://kv.example.test";
const BASE_ENV = { KV_REST_API_URL: KV_URL, KV_REST_API_TOKEN: "kv-token" };
const NOW = Date.parse("2026-10-24T15:00:00Z");
const TODAY = "2026-10-24";
const YESTERDAY = "2026-10-23";

// ------------------------------------------------------------ Apple mock

const appleKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rogueKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-kid-1";
const jwk = { ...appleKey.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };
const siwaKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const SIWA_ENV = {
  APPLE_SIWA_KEY_ID: "KEY123",
  APPLE_TEAM_ID: "TEAM123",
  APPLE_SIWA_KEY: siwaKey.privateKey.export({ format: "pem", type: "pkcs8" }).replace(/\n/g, "\\n"),
};

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
function appleToken(claims = {}, { key = appleKey.privateKey, kid = KID, alg = "RS256", at = NOW } = {}) {
  const payload = {
    iss: "https://appleid.apple.com",
    aud: "com.theriot.named",
    exp: Math.floor(at / 1000) + 600,
    iat: Math.floor(at / 1000) - 5,
    sub: "001234.apple-user.0001",
    ...claims,
  };
  const input = `${b64({ alg, kid })}.${b64(payload)}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")}`;
}

// ------------------------------------------------------------ game helpers

const NAMES = { ...names, familiarAnswers: answerPools.familiar, lengthWeights: answerPools.lengthWeights, dailyPools: answerPools };
const answerFor = (dateKey) => pickDailyPuzzle(NAMES.answers, dateKey, NAMES.familiarAnswers, NAMES.lengthWeights, NAMES.dailyPools).name;
const wrong = (dateKey, count) => {
  const answer = answerFor(dateKey);
  return names.guesses.filter((g) => g.length === answer.length && g !== answer).slice(0, count);
};
const winIn = (dateKey, n) => [...wrong(dateKey, n - 1), answerFor(dateKey)];
const lose = (dateKey) => wrong(dateKey, 6);
const uuid = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

// ------------------------------------------------------------ harness

function setup({ env = BASE_ENV, now = NOW } = {}) {
  const redis = fakeRedis();
  const calls = { jwks: 0, token: [], revoke: [] };
  const clock = { now };
  async function fetchImpl(url, init = {}) {
    if (url === `${KV_URL}/pipeline`) {
      assert(init.headers.authorization === "Bearer kv-token", "kv auth");
      const commands = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => commands.map((c) => ({ result: redis.run(c) })) };
    }
    if (url === APPLE_KEYS_URL) {
      calls.jwks++;
      return { ok: true, status: 200, json: async () => ({ keys: [jwk] }) };
    }
    if (url === APPLE_TOKEN_URL) {
      calls.token.push(Object.fromEntries(new URLSearchParams(init.body)));
      return { ok: true, status: 200, json: async () => ({ refresh_token: "apple-refresh-token", access_token: "x" }) };
    }
    if (url === APPLE_REVOKE_URL) {
      calls.revoke.push(Object.fromEntries(new URLSearchParams(init.body)));
      return { ok: true, status: 200, json: async () => ({}) };
    }
    throw new Error(`unexpected fetch ${url}`);
  }
  const handler = createHandler({ env, fetchImpl, now: () => clock.now, lockRetryMs: 1 });
  async function call(method, path, { body, headers = {}, session, query = {} } = {}) {
    const res = fakeRes();
    const h = { ...headers };
    if (session) h.authorization = `Bearer ${session}`;
    await handler({ method, url: path, body, headers: h, query }, res);
    return res;
  }
  async function signIn(local, { sub, claims = {}, platform = "ios", authorizationCode } = {}) {
    const { body: n } = await call("POST", "/api/account/nonce");
    const token = appleToken({ nonce: sha256hex(n.nonce), ...(sub ? { sub } : {}), ...claims }, { at: clock.now });
    return call("POST", "/api/account/apple", { body: { identityToken: token, nonce: n.nonce, platform, local, authorizationCode } });
  }
  return { redis, calls, clock, call, signIn };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ------------------------------------------------------------ pure pieces

test("isoWeek matches ISO 8601 (the iPhone's StreakFreeze.week)", () => {
  equal(isoWeek("2026-10-19"), "2026-W43", "Monday");
  equal(isoWeek("2026-10-25"), "2026-W43", "Sunday");
  equal(isoWeek("2026-10-26"), "2026-W44", "next Monday");
  equal(isoWeek("2026-01-01"), "2026-W01", "Thursday Jan 1");
  equal(isoWeek("2027-01-01"), "2026-W53", "Friday Jan 1 belongs to the old year");
  equal(isoWeek("2025-12-29"), "2026-W01", "Monday Dec 29 belongs to the new year");
});

test("computeStreak: wins count, freezes bridge, losses and gaps end it, anchors carry", () => {
  const r = (s, a = 0) => ({ s, a });
  equal(computeStreak({}, [], null), { streak: 0, lastDate: null }, "empty");
  equal(computeStreak({ "2026-10-22": r(3), "2026-10-23": r(2), "2026-10-24": r(4) }, [], null).streak, 3, "three wins");
  equal(computeStreak({ "2026-10-22": r(3), "2026-10-24": r(4) }, [], null).streak, 1, "gap");
  equal(computeStreak({ "2026-10-22": r(3), "2026-10-24": r(4) }, ["2026-10-23"], null).streak, 2, "freeze bridges without counting");
  equal(computeStreak({ "2026-10-23": r(7), "2026-10-24": r(4) }, [], null).streak, 1, "loss ends it");
  equal(computeStreak({ "2026-10-24": r(7) }, [], null), { streak: 0, lastDate: "2026-10-24" }, "loss today");
  equal(computeStreak({ "2026-10-23": r(2), "2026-10-24": r(4, 1) }, [], null), { streak: 1, lastDate: "2026-10-23" }, "archive ignored");
  equal(computeStreak({ "2026-10-23": r(2), "2026-10-24": r(4) }, [], { date: "2026-10-22", streak: 10 }).streak, 12, "anchor adds");
  equal(computeStreak({ "2026-10-22": r(2), "2026-10-24": r(4) }, [], { date: "2026-10-22", streak: 10 }).streak, 1, "anchor behind a gap");
  equal(computeStreak({}, [], { date: "2026-10-22", streak: 10 }), { streak: 10, lastDate: "2026-10-22" }, "anchor alone");
});

test("mergeLocal: union by date, first finished wins, max counts, best anchor, friends", () => {
  const nowMs = NOW;
  const state = {
    stats: { ...emptyStats(), played: 2, wins: 2, dist: [0, 1, 1, 0, 0, 0], cleanWins: 2, maxStreak: 2 },
    frz: { used: { "2026-W42": 1 }, days: [] },
    nick: "Bran",
    groups: ["AAAAAAAA"],
    board: uuid(9),
    results: { "2026-10-23": { s: 2, a: 0, v: 1 }, "2026-10-24": { s: 3, a: 0, v: 1 } },
  };
  const local = parseLocal({
    results: [
      { dateKey: "2026-10-24", guesses: 5, won: true },
      { dateKey: "2026-10-22", guesses: 4, won: true },
      { dateKey: "2026-10-21", guesses: 6, won: false, archive: true },
      { dateKey: "2030-01-01", guesses: 1, won: true },
    ],
    stats: { played: 40, wins: 30, streak: 8, maxStreak: 9, lastDate: "2026-10-22", dist: [0, 5, 10, 10, 5, 0] },
    freezes: { used: { "2026-W42": 0, "2026-W41": 1 } },
    nickname: "Other",
    groups: ["BBBBBBBB", "aaaaaaaa"],
    playerId: uuid(5),
  }, nowMs);
  const out = mergeLocal(state, local);
  equal(out.added, 2, "two new dates (future date dropped)");
  equal(out.kept, 1, "account kept 10-24");
  equal(out.state.results["2026-10-24"].s, 3, "first finished result kept");
  equal(out.state.stats.played, 40, "played takes the device's larger count");
  equal(out.state.stats.dist, [0, 5, 10, 10, 5, 0], "dist max per bucket");
  equal(out.state.stats.wins, 30, "wins");
  // Anchor (10-22, 8) + 10-23 + 10-24 = 10.
  equal(computeStreak(out.state.results, out.state.frz.days, out.state.stats.anchor).streak, 10, "device anchor gives the longer streak");
  equal(out.state.stats.maxStreak, 10, "max streak");
  equal(out.state.frz.used, { "2026-W42": 1, "2026-W41": 1 }, "freeze ledgers union");
  equal(out.state.nick, "Bran", "account nickname wins");
  equal(out.state.groups, ["AAAAAAAA", "BBBBBBBB"], "groups union");
  equal(out.state.board, uuid(9), "existing board ID kept");
});

// ------------------------------------------------------------ endpoints

test("GET /api/config hides web sign-in until APPLE_SERVICES_ID exists", async () => {
  const off = setup();
  const res = await off.call("GET", "/api/config");
  equal(res.statusCode, 200, "status");
  equal(res.body, { accounts: true, apple: { web: false, servicesId: null, redirectURI: "https://namedgame.com/", scope: "" } }, "off");
  const on = setup({ env: { ...BASE_ENV, APPLE_SERVICES_ID: "com.namedgame.web" } });
  const res2 = await on.call("GET", "/api/config");
  equal(res2.body.apple.web, true, "on");
  equal(res2.body.apple.servicesId, "com.namedgame.web", "services id");
  const rewritten = await on.call("GET", "/api/account", { query: { action: "config" } });
  equal(rewritten.body.apple.web, true, "rewrite query form");
  const noKv = setup({ env: {} });
  equal((await noKv.call("GET", "/api/config")).body.accounts, false, "no storage");
});

test("no session: 401 on every authenticated route", async () => {
  const { call } = setup();
  for (const [method, path] of [["GET", "/api/account"], ["PATCH", "/api/account"], ["DELETE", "/api/account"], ["POST", "/api/account/result"], ["POST", "/api/account/logout"], ["POST", "/api/account/freeze"]]) {
    const res = await call(method, path, { body: {} });
    equal(res.statusCode, 401, `${method} ${path}`);
    equal(res.body.code, "unauthorized", "code");
  }
  const bogus = await call("GET", "/api/account", { session: "nms_" + "x".repeat(43) });
  equal(bogus.statusCode, 401, "unknown session");
  equal((await call("POST", "/api/account")).statusCode, 405, "405");
  equal((await call("GET", "/api/account/nope")).statusCode, 404, "404");
});

test("sign in (iOS): verifies the token, merges local history, adopts the install's rank and board entry", async () => {
  const { call, signIn, redis, calls } = setup();
  // The device already posted yesterday's daily to /api/results and today's to a friends board.
  const resultsHandler = (await import("../api/results.js")).createHandler;
  const fetchKv = async (url, init) => ({ ok: true, json: async () => JSON.parse(init.body).map((c) => ({ result: redis.run(c) })) });
  const results = resultsHandler({ env: BASE_ENV, fetchImpl: fetchKv, now: () => NOW });
  await results({ method: "POST", body: { installId: uuid(1), dateKey: YESTERDAY, guesses: winIn(YESTERDAY, 3) }, headers: {}, query: {} }, fakeRes());
  redis.run(["HSET", `given:board:K7P2QX9M:${TODAY}`, uuid(2), JSON.stringify({ nickname: "Bran", score: 4, createdAt: NOW })]);

  const res = await signIn({
    results: [
      { dateKey: YESTERDAY, guesses: 3, won: true },
      { dateKey: TODAY, guesses: 4, won: true, words: winIn(TODAY, 4) },
    ],
    stats: { played: 12, wins: 11, streak: 6, maxStreak: 7, lastDate: TODAY, dist: [0, 1, 4, 4, 2, 0] },
    freezes: { used: { "2026-W42": 1 } },
    nickname: "Bran",
    groups: ["K7P2QX9M"],
    playerId: uuid(2),
    installId: uuid(1),
  });
  equal(res.statusCode, 200, `status ${JSON.stringify(res.body)}`);
  assert(/^nms_[A-Za-z0-9_-]{43}$/.test(res.body.session), "session format");
  equal(res.body.created, true, "created");
  equal(res.body.merged, { added: 2, kept: 0 }, "merged");
  const account = res.body.account;
  equal(account.stats, { played: 12, wins: 11, streak: 6, maxStreak: 7, lastDate: TODAY, dist: [0, 1, 4, 4, 2, 0], cleanWins: 11 }, "stats");
  equal(account.social, { nickname: "Bran", groups: ["K7P2QX9M"], boardId: uuid(2) }, "friends follow the account");
  equal(account.results.map((r) => [r.dateKey, r.score, r.verified]), [[YESTERDAY, 3, false], [TODAY, 4, true]], "results");
  equal(account.results[1].words, winIn(TODAY, 4), "words kept for verified results");
  equal(account.email, null, "no email without scopes");
  equal(calls.jwks, 1, "JWKS fetched once");

  // Session stored hashed with a 1-year TTL; nothing stores the raw token.
  const hash = sha256hex(res.body.session);
  equal(redis.strings.get(`named:sess:${hash}`), account.id, "session -> account");
  equal(redis.ttl.get(`named:sess:${hash}`), 365 * 24 * 3600, "1-year TTL");
  assert(![...redis.strings.keys()].some((k) => k.includes(res.body.session)), "raw token never stored");

  // The install's "you vs everyone" history now belongs to the account's resultsId.
  const yNum = puzzleNumber(YESTERDAY);
  const tNum = puzzleNumber(TODAY);
  equal(redis.hget(`named:res:${yNum}:p`), { [account.resultsId]: "3" }, "yesterday moved to resultsId");
  equal(redis.hget(`named:res:${yNum}`).n, "1", "no double count");
  assert(!redis.exists(`named:plr:${uuid(1)}`), "install history removed");
  equal(redis.hget(`named:res:${tNum}:p`), { [account.resultsId]: "4" }, "verified local result fed under resultsId");

  // GET reads it back and refreshes the session.
  redis.ttl.set(`named:sess:${hash}`, 5);
  const got = await call("GET", "/api/account", { session: res.body.session });
  equal(got.statusCode, 200, "get");
  equal(got.body.account.stats.played, 12, "get stats");
  equal(redis.ttl.get(`named:sess:${hash}`), 365 * 24 * 3600, "TTL refreshed on use");
  const since = await call("GET", "/api/account", { session: res.body.session, query: { resultsSince: TODAY } });
  equal(since.body.account.results.length, 1, "resultsSince");
});

test("sign in rejects bad tokens and replayed or mismatched nonces", async () => {
  const { call, signIn, calls } = setup();
  const cases = [
    [{ aud: "com.someone.else" }, "invalid_token", "wrong audience"],
    [{ iss: "https://evil.example" }, "invalid_token", "wrong issuer"],
    [{ exp: Math.floor(NOW / 1000) - 3600 }, "invalid_token", "expired"],
    [{ sub: "" }, "invalid_token", "no subject"],
  ];
  for (const [claims, code, label] of cases) {
    const res = await signIn(undefined, { claims });
    equal(res.statusCode, 401, label);
    equal(res.body.code, code, label);
  }
  // Web audience is refused until APPLE_SERVICES_ID is set.
  const web = await signIn(undefined, { claims: { aud: "com.namedgame.web" }, platform: "web" });
  equal(web.body.code, "invalid_token", "web audience without a Services ID");

  // Signed by a key Apple never published.
  const { body: n } = await call("POST", "/api/account/nonce");
  const forged = appleToken({ nonce: sha256hex(n.nonce) }, { key: rogueKey.privateKey });
  equal((await call("POST", "/api/account/apple", { body: { identityToken: forged, nonce: n.nonce, platform: "ios" } })).body.code, "invalid_token", "bad signature");
  // Unknown kid: refetch JWKS once, then fail.
  const before = calls.jwks;
  const unknownKid = appleToken({ nonce: sha256hex(n.nonce) }, { kid: "rotated" });
  equal((await call("POST", "/api/account/apple", { body: { identityToken: unknownKid, nonce: n.nonce, platform: "ios" } })).body.code, "invalid_token", "unknown kid");
  equal(calls.jwks, before + 1, "refetched JWKS for the unknown kid");
  // alg none / HS256 refused.
  const none = `${b64({ alg: "none", kid: KID })}.${b64({ sub: "x" })}.`;
  equal((await call("POST", "/api/account/apple", { body: { identityToken: none, nonce: n.nonce, platform: "ios" } })).body.code, "invalid_token", "alg none");

  // Nonce: token must carry sha256(nonce), the nonce must be ours, and single use.
  const mismatch = appleToken({ nonce: sha256hex("something else") });
  equal((await call("POST", "/api/account/apple", { body: { identityToken: mismatch, nonce: n.nonce, platform: "ios" } })).body.code, "invalid_nonce", "mismatch");
  const unissued = "made-up-nonce";
  const unissuedToken = appleToken({ nonce: sha256hex(unissued) });
  equal((await call("POST", "/api/account/apple", { body: { identityToken: unissuedToken, nonce: unissued, platform: "ios" } })).body.code, "invalid_nonce", "never issued");
  const good = appleToken({ nonce: sha256hex(n.nonce) });
  const first = await call("POST", "/api/account/apple", { body: { identityToken: good, nonce: n.nonce, platform: "ios" } });
  equal(first.statusCode, 200, "first use ok");
  const again = await call("POST", "/api/account/apple", { body: { identityToken: good, nonce: n.nonce, platform: "ios" } });
  equal(again.body.code, "invalid_nonce", "replay refused");
  equal((await call("POST", "/api/account/apple", { body: { identityToken: good, platform: "ios" } })).statusCode, 400, "missing nonce");
  equal((await call("POST", "/api/account/apple", { body: { identityToken: good, nonce: n.nonce, platform: "android" } })).statusCode, 400, "platform");
});

test("web sign-in works once APPLE_SERVICES_ID is set; email is kept only if Apple sends it", async () => {
  const { signIn } = setup({ env: { ...BASE_ENV, APPLE_SERVICES_ID: "com.namedgame.web" } });
  const res = await signIn(undefined, { platform: "web", claims: { aud: "com.namedgame.web", email: "x@privaterelay.appleid.com" } });
  equal(res.statusCode, 200, "web ok");
  equal(res.body.account.email, "x@privaterelay.appleid.com", "email stored when shared");
});

test("iOS player IDs keep their case so existing board entries line up", async () => {
  const { signIn, redis } = setup();
  const upper = "A1B2C3D4-0000-4000-8000-00000000ABCD";
  redis.run(["HSET", `given:board:K7P2QX9M:${TODAY}`, upper, JSON.stringify({ nickname: "Bran", score: 2, createdAt: NOW })]);
  const res = await signIn({ nickname: "Bran", groups: ["K7P2QX9M"], playerId: upper });
  equal(res.body.account.social.boardId, upper, "boardId is the device's ID as posted");
  equal(Object.keys(redis.hget(`given:board:K7P2QX9M:${TODAY}`)), [upper], "one entry, untouched");
});

test("second device: same Apple ID, merge keeps the account's results and adds new dates", async () => {
  const { signIn, call } = setup();
  const a = await signIn({ results: [{ dateKey: TODAY, guesses: 2, won: true }], nickname: "Bran", groups: ["K7P2QX9M"], playerId: uuid(2) });
  const b = await signIn({
    results: [{ dateKey: TODAY, guesses: 5, won: true }, { dateKey: YESTERDAY, guesses: 4, won: true }],
    nickname: "Phone2",
    groups: ["Q4ZR8T2W"],
    playerId: uuid(3),
  });
  equal(b.statusCode, 200, "status");
  equal(b.body.created, false, "same account");
  equal(b.body.account.id, a.body.account.id, "same id");
  equal(b.body.merged, { added: 1, kept: 1 }, "merged counts");
  equal(b.body.account.results.find((r) => r.dateKey === TODAY).score, 2, "first finished result wins");
  equal(b.body.account.stats.played, 2, "played counts the added day");
  equal(b.body.account.stats.streak, 2, "streak spans both devices");
  equal(b.body.account.social, { nickname: "Bran", groups: ["K7P2QX9M", "Q4ZR8T2W"], boardId: uuid(2) }, "friends");
  // Both sessions work.
  equal((await call("GET", "/api/account", { session: a.body.session })).statusCode, 200, "session a");
  equal((await call("GET", "/api/account", { session: b.body.session })).statusCode, 200, "session b");
});

test("POST /result: replay-validated, feeds you-vs-everyone and the friends board, first result wins", async () => {
  const { signIn, call, redis } = setup();
  const { body } = await signIn({ nickname: "Bran", groups: ["K7P2QX9M"], playerId: uuid(2) });
  const session = body.session;
  const res = await call("POST", "/api/account/result", { session, body: { dateKey: TODAY, guesses: winIn(TODAY, 3) } });
  equal(res.statusCode, 200, `status ${JSON.stringify(res.body)}`);
  equal(res.body.saved, true, "saved");
  equal(res.body.duplicate, false, "not duplicate");
  equal(res.body.account.stats, { played: 1, wins: 1, streak: 1, maxStreak: 1, lastDate: TODAY, dist: [0, 0, 1, 0, 0, 0], cleanWins: 1 }, "stats");
  equal(res.body.vs.you.score, 3, "vs summary");
  equal(res.body.vs.number, puzzleNumber(TODAY), "vs number");
  equal(redis.hget(`named:res:${puzzleNumber(TODAY)}:p`), { [body.account.resultsId]: "3" }, "fed under resultsId");
  const entry = JSON.parse(redis.hget(`given:board:K7P2QX9M:${TODAY}`)[uuid(2)]);
  equal([entry.nickname, entry.score], ["Bran", 3], "board entry under boardId");

  const dup = await call("POST", "/api/account/result", { session, body: { dateKey: TODAY, guesses: winIn(TODAY, 1) } });
  equal([dup.statusCode, dup.body.saved, dup.body.duplicate], [200, false, true], "duplicate ignored");
  equal(dup.body.account.stats.played, 1, "unchanged");

  const badReplay = await call("POST", "/api/account/result", { session, body: { dateKey: YESTERDAY, guesses: wrong(YESTERDAY, 2) } });
  equal(badReplay.statusCode, 400, "unfinished game rejected");
  const notNames = await call("POST", "/api/account/result", { session, body: { dateKey: YESTERDAY, guesses: ["ZZZZZ"] } });
  equal(notNames.statusCode, 400, "invalid guess rejected");
  const future = await call("POST", "/api/account/result", { session, body: { dateKey: "2026-10-30", guesses: winIn("2026-10-30", 1) } });
  equal(future.statusCode, 400, "future date rejected");

  // An old number is archive: stored and ranked, but not in streak stats or on boards.
  const old = "2026-10-01";
  const arch = await call("POST", "/api/account/result", { session, body: { dateKey: old, guesses: lose(old) } });
  equal(arch.statusCode, 200, "archive ok");
  equal(arch.body.account.results.find((r) => r.dateKey === old).archive, true, "forced archive");
  equal(arch.body.account.stats.played, 1, "archive not counted");
  equal(arch.body.vs.you.score, 7, "archive ranked");
  assert(!redis.exists(`given:board:K7P2QX9M:${old}`), "no board post for archive");
});

test("an unverified merged result is upgraded when the same score is posted with its guesses", async () => {
  const { signIn, call, redis } = setup();
  const { body } = await signIn({ results: [{ dateKey: TODAY, guesses: 2, won: true }] });
  const res = await call("POST", "/api/account/result", { session: body.session, body: { dateKey: TODAY, guesses: winIn(TODAY, 2) } });
  equal([res.body.saved, res.body.duplicate], [false, true], "duplicate");
  equal(res.body.account.results[0].verified, true, "now verified");
  equal(res.body.account.stats.played, 1, "not counted twice");
  equal(redis.hget(`named:res:${puzzleNumber(TODAY)}:p`), { [body.account.resultsId]: "2" }, "fed after upgrade");
});

test("out-of-order posts land correctly (offline queue)", async () => {
  const { signIn, call } = setup();
  const { body } = await signIn();
  await call("POST", "/api/account/result", { session: body.session, body: { dateKey: TODAY, guesses: winIn(TODAY, 4) } });
  const late = await call("POST", "/api/account/result", { session: body.session, body: { dateKey: YESTERDAY, guesses: winIn(YESTERDAY, 2) } });
  equal(late.body.account.stats.streak, 2, "streak 2");
  equal(late.body.account.stats.lastDate, TODAY, "lastDate today");
});

test("streak freezes: auto-applied on result, one a week (two with Named+), all or nothing", async () => {
  const day = (offset) => shiftDateKey("2026-10-21", offset); // Wednesday of W43
  const run = async (plus, skip) => {
    const t = setup({ now: Date.parse("2026-10-21T15:00:00Z") });
    const { body } = await t.signIn();
    await t.call("POST", "/api/account/result", { session: body.session, body: { dateKey: day(0), guesses: winIn(day(0), 3), plus } });
    const next = day(skip + 1);
    t.clock.now = Date.parse(`${next}T15:00:00Z`);
    return t.call("POST", "/api/account/result", { session: body.session, body: { dateKey: next, guesses: winIn(next, 3), plus } });
  };
  const one = await run(false, 1);
  equal(one.body.froze, [day(1)], "one missed day frozen");
  equal(one.body.account.stats.streak, 2, "streak saved");
  equal(one.body.account.freezes.used, { "2026-W43": 1 }, "ledger");
  const two = await run(false, 2);
  equal(two.body.froze, [], "two missed days in one week: not free");
  equal(two.body.account.stats.streak, 1, "streak reset");
  const plus = await run(true, 2);
  equal(plus.body.froze, [day(1), day(2)], "Named+ covers two");
  equal(plus.body.account.stats.streak, 2, "streak saved with Named+");
});

test("POST /freeze saves a lapsed streak on launch", async () => {
  const t = setup({ now: Date.parse("2026-10-21T15:00:00Z") });
  const { body } = await t.signIn();
  await t.call("POST", "/api/account/result", { session: body.session, body: { dateKey: "2026-10-21", guesses: winIn("2026-10-21", 2) } });
  t.clock.now = Date.parse("2026-10-23T15:00:00Z");
  const res = await t.call("POST", "/api/account/freeze", { session: body.session, body: { today: "2026-10-23", plus: false } });
  equal([res.statusCode, res.body.saved, res.body.froze], [200, true, ["2026-10-22"]], "saved");
  equal(res.body.account.stats.lastDate, "2026-10-22", "lastDate is yesterday, like the app");
  equal(res.body.account.stats.streak, 1, "streak alive");
  const again = await t.call("POST", "/api/account/freeze", { session: body.session, body: { today: "2026-10-23" } });
  equal(again.body.saved, false, "nothing more to save");
  const bad = await t.call("POST", "/api/account/freeze", { session: body.session, body: { today: "2026-12-01" } });
  equal(bad.statusCode, 400, "today must be near the server clock");
});

test("PATCH nickname and groups; validation", async () => {
  const { signIn, call } = setup();
  const { body } = await signIn();
  const ok = await call("PATCH", "/api/account", { session: body.session, body: { nickname: "  Bran  T ", groups: ["k7p2qx9m", "Q4ZR8T2W", "K7P2QX9M"] } });
  equal(ok.statusCode, 200, "ok");
  equal(ok.body.account.social.nickname, "Bran T", "nickname normalized");
  equal(ok.body.account.social.groups, ["K7P2QX9M", "Q4ZR8T2W"], "groups normalized and deduped");
  equal((await call("PATCH", "/api/account", { session: body.session, body: { nickname: "x" } })).statusCode, 400, "short nickname");
  equal((await call("PATCH", "/api/account", { session: body.session, body: { groups: ["NOPE"] } })).statusCode, 400, "bad code");
  equal((await call("PATCH", "/api/account", { session: body.session, body: {} })).statusCode, 400, "empty");
  const cleared = await call("PATCH", "/api/account", { session: body.session, body: { nickname: null } });
  equal(cleared.body.account.social.nickname, null, "cleared");
  equal((await call("GET", "/api/account", { session: body.session })).body.account.social.nickname, null, "cleared persists");
});

test("logout ends only that session", async () => {
  const { signIn, call } = setup();
  const a = await signIn();
  const b = await signIn();
  equal((await call("POST", "/api/account/logout", { session: a.body.session })).statusCode, 204, "204");
  equal((await call("GET", "/api/account", { session: a.body.session })).statusCode, 401, "a ended");
  equal((await call("GET", "/api/account", { session: b.body.session })).statusCode, 200, "b alive");
});

test("DELETE removes everything server-side; skips Apple revocation without the key", async () => {
  const { signIn, call, redis, calls } = setup();
  const { body } = await signIn({ nickname: "Bran", groups: ["K7P2QX9M"], playerId: uuid(2) }, { authorizationCode: "code-1" });
  await call("POST", "/api/account/result", { session: body.session, body: { dateKey: TODAY, guesses: winIn(TODAY, 3) } });
  const other = await signIn();
  equal(calls.token.length, 0, "no code exchange without the key");
  const res = await call("DELETE", "/api/account", { session: body.session });
  equal(res.statusCode, 200, "status");
  equal(res.body, { deleted: true, appleRevoked: false }, "body");
  equal(calls.revoke.length, 0, "no revoke call");
  const left = [...redis.allKeys()].filter((k) => !/^named:(arl|arr|srl|nrl):/.test(k));
  // Only the public per-number totals hash (now zeroed) may remain.
  const n = puzzleNumber(TODAY);
  equal(left, [`named:res:${n}`], "nothing personal left");
  equal(redis.hget(`named:res:${n}`), { d3: "0", n: "0" }, "score backed out of the totals");
  equal((await call("GET", "/api/account", { session: other.body.session })).statusCode, 401, "every session ended");
  // Signing in again starts a fresh account.
  const again = await signIn();
  equal(again.body.created, true, "fresh account");
});

test("DELETE revokes the Apple grant when the Sign in with Apple key is configured", async () => {
  const { signIn, call, calls } = setup({ env: { ...BASE_ENV, ...SIWA_ENV } });
  const { body } = await signIn(undefined, { authorizationCode: "code-1" });
  equal(calls.token.length, 1, "code exchanged at sign-in");
  equal([calls.token[0].client_id, calls.token[0].grant_type, calls.token[0].code], ["com.theriot.named", "authorization_code", "code-1"], "exchange fields");
  const res = await call("DELETE", "/api/account", { session: body.session });
  equal(res.body, { deleted: true, appleRevoked: true }, "revoked");
  const revoke = calls.revoke[0];
  equal([revoke.client_id, revoke.token, revoke.token_type_hint], ["com.theriot.named", "apple-refresh-token", "refresh_token"], "revoke fields");
  // The client secret is an ES256 JWT signed by the configured key.
  const [h, p, s] = revoke.client_secret.split(".");
  const header = JSON.parse(Buffer.from(h, "base64url"));
  const payload = JSON.parse(Buffer.from(p, "base64url"));
  equal([header.alg, header.kid], ["ES256", "KEY123"], "secret header");
  equal([payload.iss, payload.sub, payload.aud], ["TEAM123", "com.theriot.named", "https://appleid.apple.com"], "secret claims");
  const pub = createPublicKey(siwaKey.privateKey);
  assert(verify("sha256", Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")), "secret signature");
});

test("rate limits: 60 writes per account per hour, with Retry-After", async () => {
  const { signIn, call } = setup();
  const { body } = await signIn();
  let last;
  for (let i = 0; i < 61; i++) last = await call("PATCH", "/api/account", { session: body.session, body: { nickname: `Player ${i % 10}x` } });
  equal(last.statusCode, 429, "61st write limited");
  equal(last.body.code, "rate_limited", "code");
  assert(Number(last.headers["retry-after"]) > 0, "Retry-After");
});

test("storage missing: 503 not_configured", async () => {
  const { call } = setup({ env: {} });
  const res = await call("GET", "/api/account", { session: "nms_" + "a".repeat(43) });
  equal([res.statusCode, res.body.code], [503, "not_configured"], "503");
});

let passed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    passed++;
  } catch (error) {
    console.error(`FAIL ${name}\n  ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}
console.log(`account.test.js: ${passed}/${tests.length} passed`);
