// Named accounts: Sign in with Apple, synced stats, friends boards that follow the player.
// Full contract: docs/accounts-api.md. Routes (vercel.json rewrites /api/account/:action and
// /api/config here, so this is a single function):
//
//   GET    /api/config            public config (is web Sign in with Apple configured?)
//   POST   /api/account/nonce     single-use nonce for Sign in with Apple
//   POST   /api/account/apple     verify an Apple identity token, merge local history, issue a session
//   GET    /api/account           the account (stats, results, freezes, friends)
//   POST   /api/account/result    record one finished official daily (replay-validated)
//   POST   /api/account/freeze    use streak freezes for missed days
//   PATCH  /api/account           nickname and friends groups
//   POST   /api/account/logout    end this session
//   DELETE /api/account           delete everything (and revoke the Apple grant when configured)

import { randomBytes, randomUUID } from "node:crypto";
import names from "../data/names.json" with { type: "json" };
import answerPools from "../data/answer-pools.json" with { type: "json" };
import { HISTORY_START_DATE, MAX_GUESSES, puzzleNumber, shiftDateKey } from "../js/engine.js";
import { LOSS_SCORE, normalizeGroup, replayDaily, validDateKey as inBoardWindow } from "../js/leaderboard-core.js";
import {
  BadRequest,
  adopt as adoptVs,
  kvPipeline,
  normalizeInstallId,
  readBody,
  record as recordVs,
  remove as removeVs,
  summary as vsSummary,
  validDateKey as validResultsDate,
} from "./results.js";
import { AppleTokenError, IOS_BUNDLE_ID, createAppleAuth, sha256hex, siwaConfigured } from "../lib/apple.js";

export const EARLIEST_DATE = "2026-01-01";
const SESSION_TTL_SECONDS = 365 * 24 * 3600;
const NONCE_TTL_SECONDS = 600;
const NONCE_RATE_PER_MINUTE = 600;
const BOARD_TTL_SECONDS = 90 * 24 * 3600;
const BOARD_MAX_ENTRIES = 50;
const MAX_LOCAL_RESULTS = 1000;
const MAX_GROUPS = 10;
const MAX_FREEZE_DAYS_KEPT = 120;
const SIGNIN_LIMIT = 20;
const WRITE_LIMIT = 60;
const READ_LIMIT = 600;
const SIGNIN_BODY_BYTES = 64 * 1024;
const BODY_BYTES = 4 * 1024;
const LOCK_SECONDS = 5;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const SESSION = /^nms_[A-Za-z0-9_-]{43}$/;
const NICKNAME = /^[\p{L}\p{N} _.'-]{2,20}$/u;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const UUID_ANY_CASE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NAMES = {
  ...names,
  guessSet: new Set(names.guesses),
  familiarAnswers: answerPools.familiar,
  lengthWeights: answerPools.lengthWeights,
  dailyPools: answerPools,
};

// ---------------------------------------------------------------- keys

const K = {
  session: (hash) => `named:sess:${hash}`,
  sessions: (id) => `named:acct:${id}:sess`,
  apple: (sub) => `named:apple:${sub}`,
  account: (id) => `named:acct:${id}`,
  results: (id) => `named:acct:${id}:res`,
  lock: (id) => `named:acct:${id}:lock`,
  nonce: (hash) => `named:nonce:${hash}`,
  board: (group, dateKey) => `given:board:${group}:${dateKey}`,
};

// ---------------------------------------------------------------- errors

export class ApiError extends Error {
  constructor(status, code, message, retryAfter) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}
const badRequest = (message = "Invalid request") => new ApiError(400, "bad_request", message);
const unauthorized = () => new ApiError(401, "unauthorized", "Sign in again");
const unavailable = (message = "Accounts are unavailable right now") => new ApiError(503, "unavailable", message);

// ---------------------------------------------------------------- dates

const utcKey = (ms) => new Date(ms).toISOString().slice(0, 10);

function realDate(value) {
  if (typeof value !== "string" || !DATE_KEY.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** A date a device may report history for: 2026-01-01 .. the server's tomorrow. */
export function validLocalDate(value, nowMs) {
  return realDate(value) && value >= EARLIEST_DATE && value <= utcKey(nowMs + 86400000);
}

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** ISO week of a date key, "2026-W43" (matches the iPhone's StreakFreeze.week). */
export function isoWeek(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const weekday = (date.getUTCDay() + 6) % 7; // Monday 0
  date.setUTCDate(date.getUTCDate() - weekday + 3); // that week's Thursday
  const year = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((date - firstThursday) / (7 * 86400000));
  return `${String(year).padStart(4, "0")}-W${String(week).padStart(2, "0")}`;
}

export const freezeAllowance = (plus) => (plus ? 2 : 1);

// ---------------------------------------------------------------- pure stats

const clampInt = (value, low, high) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(high, Math.max(low, n)) : low;
};

export function emptyStats() {
  return { played: 0, wins: 0, dist: [0, 0, 0, 0, 0, 0], cleanWins: 0, maxStreak: 0, anchor: null };
}

/** Clamps a device's reported stats to something plausible. */
export function cleanLocalStats(raw, nowMs) {
  if (!raw || typeof raw !== "object") return null;
  const maxDays = daysBetween(EARLIEST_DATE, utcKey(nowMs)) + 2;
  const played = clampInt(raw.played, 0, 5000);
  const wins = Math.min(played, clampInt(raw.wins, 0, 5000));
  const dist = [0, 1, 2, 3, 4, 5].map((i) => clampInt(Array.isArray(raw.dist) ? raw.dist[i] : 0, 0, 5000));
  const lastDate = validLocalDate(raw.lastDate, nowMs) ? raw.lastDate : null;
  const streak = lastDate ? Math.min(maxDays, played, clampInt(raw.streak, 0, 5000)) : 0;
  const maxStreak = Math.min(maxDays, played, Math.max(streak, clampInt(raw.maxStreak, 0, 5000)));
  const cleanWins = Math.min(wins, clampInt(raw.cleanWins ?? raw.wins, 0, 5000));
  return { played, wins, dist, cleanWins, maxStreak, streak, lastDate };
}

/**
 * The streak as of the latest counted day: walk back from the latest on-day result, freeze day
 * or anchor date. A win adds one, a freeze day bridges, a loss or a gap ends it; reaching the
 * anchor adds the anchor's streak. `results` maps dateKey -> { s, a }.
 */
export function computeStreak(results, freezeDays, anchor) {
  const freezes = new Set(freezeDays || []);
  let last = null;
  for (const [date, r] of Object.entries(results)) if (!r.a && (!last || date > last)) last = date;
  for (const day of freezes) if (!last || day > last) last = day;
  if (anchor?.date && (!last || anchor.date > last)) last = anchor.date;
  if (!last) return { streak: 0, lastDate: null };
  let count = 0;
  let day = last;
  for (let guard = 0; guard < 5000 && day >= EARLIEST_DATE; guard++) {
    const r = results[day] && !results[day].a ? results[day] : null;
    if (anchor?.date === day && anchor.streak > 0 && (!r || r.s < LOSS_SCORE)) return { streak: count + anchor.streak, lastDate: last };
    if (r) {
      if (r.s >= LOSS_SCORE) break;
      count++;
    } else if (!freezes.has(day)) break;
    day = shiftDateKey(day, -1);
  }
  return { streak: count, lastDate: last };
}

/**
 * The days a live streak missed before `beforeDate` (exclusive). All of them are covered with a
 * freeze from that day's ISO week or none are. Returns { days, frz } or null.
 */
export function coverMissedDays(stats, results, frz, beforeDate, plus) {
  const { streak, lastDate } = computeStreak(results, frz.days, stats.anchor);
  if (streak <= 0 || !lastDate || lastDate >= beforeDate) return null;
  const days = [];
  for (let day = shiftDateKey(lastDate, 1); day < beforeDate; day = shiftDateKey(day, 1)) {
    days.push(day);
    if (days.length > 14) return null; // more than two weeks can never be covered
  }
  if (!days.length) return null;
  const used = { ...frz.used };
  for (const day of days) {
    const week = isoWeek(day);
    if ((used[week] || 0) >= freezeAllowance(plus)) return null;
    used[week] = (used[week] || 0) + 1;
  }
  const allDays = [...new Set([...(frz.days || []), ...days])].sort().slice(-MAX_FREEZE_DAYS_KEPT);
  return { days, frz: { used, days: allDays } };
}

/** Adds one new on-day result to the counts. */
export function countResult(stats, score, clean = true) {
  const next = { ...stats, dist: [...stats.dist] };
  next.played += 1;
  if (score < LOSS_SCORE) {
    next.wins += 1;
    next.dist[score - 1] += 1;
    if (clean) next.cleanWins += 1;
  }
  return next;
}

/** Validates the `local` block of a sign-in. */
export function parseLocal(raw, nowMs) {
  const local = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  if (Array.isArray(local.results) && local.results.length > MAX_LOCAL_RESULTS) throw new ApiError(413, "too_large", "Too many local results");
  if (Array.isArray(local.groups) && local.groups.length > MAX_GROUPS) throw badRequest("Too many groups");
  const results = new Map();
  for (const item of Array.isArray(local.results) ? local.results : []) {
    if (!item || typeof item !== "object" || !validLocalDate(item.dateKey, nowMs) || results.has(item.dateKey)) continue;
    const won = item.won === true;
    const guesses = won ? clampInt(item.guesses, 1, MAX_GUESSES) : MAX_GUESSES;
    if (won && !(Number(item.guesses) >= 1 && Number(item.guesses) <= MAX_GUESSES)) continue;
    let entry = { s: won ? guesses : LOSS_SCORE, a: item.archive === true ? 1 : 0, v: 0, at: nowMs, c: item.clean === false ? 0 : 1 };
    if (Array.isArray(item.words) && item.dateKey >= HISTORY_START_DATE) {
      try {
        const score = replayDaily(item.words, item.dateKey, NAMES);
        entry = { ...entry, s: score, v: 1, w: item.words };
      } catch { /* keep it as an unverified result */ }
    }
    results.set(item.dateKey, entry);
  }
  const nickname = cleanNickname(local.nickname);
  const groups = (Array.isArray(local.groups) ? local.groups : []).map(normalizeGroup).filter(Boolean);
  const used = {};
  for (const [week, count] of Object.entries(local.freezes?.used || {})) {
    if (/^\d{4}-W\d{2}$/.test(week)) used[week] = clampInt(count, 0, 2);
  }
  return {
    results,
    stats: cleanLocalStats(local.stats, nowMs),
    freezes: used,
    nickname,
    groups: [...new Set(groups)],
    // Friends-board entries are keyed by the player ID exactly as the device posted it (iOS sends
    // uppercase UUID strings), so keep its case.
    playerId: typeof local.playerId === "string" && UUID_ANY_CASE.test(local.playerId) ? local.playerId : null,
    installId: normalizeInstallId(local.installId),
  };
}

function cleanNickname(value) {
  if (typeof value !== "string") return null;
  const nickname = value.trim().replace(/\s+/g, " ");
  return NICKNAME.test(nickname) ? nickname : null;
}

/**
 * Merges a device's local history into an account state (pure). `state` is
 * { stats, frz, nick, groups, board, results } with results as a plain object.
 * Returns { state, writes: { dateKey: entry }, added, kept }.
 */
export function mergeLocal(state, local) {
  const results = { ...state.results };
  const writes = {};
  let added = 0;
  let kept = 0;
  let counts = { ...state.stats, dist: [...state.stats.dist] };
  for (const [date, entry] of local.results) {
    const existing = results[date];
    if (!existing) {
      results[date] = entry;
      writes[date] = entry;
      added++;
      if (!entry.a) counts = countResult(counts, entry.s, entry.c !== 0);
      continue;
    }
    kept++;
    if (!existing.v && entry.v && existing.s === entry.s) {
      results[date] = { ...existing, v: 1, w: entry.w };
      writes[date] = results[date];
    }
  }
  const L = local.stats;
  if (L) {
    counts.played = Math.max(counts.played, L.played);
    counts.wins = Math.max(counts.wins, L.wins);
    counts.dist = counts.dist.map((n, i) => Math.max(n, L.dist[i]));
    counts.cleanWins = Math.max(counts.cleanWins, L.cleanWins);
  }
  counts.wins = Math.max(counts.wins, counts.dist.reduce((a, b) => a + b, 0));
  counts.played = Math.max(counts.played, counts.wins);
  counts.cleanWins = Math.min(counts.cleanWins, counts.wins);

  const used = { ...(state.frz.used || {}) };
  for (const [week, n] of Object.entries(local.freezes)) used[week] = Math.max(used[week] || 0, n);
  const frz = { used, days: state.frz.days || [] };

  const candidates = [state.stats.anchor];
  if (L?.lastDate && L.streak > 0) candidates.push({ date: L.lastDate, streak: L.streak });
  let anchor = state.stats.anchor || null;
  let best = computeStreak(results, frz.days, anchor).streak;
  for (const candidate of candidates.slice(1)) {
    const streak = computeStreak(results, frz.days, candidate).streak;
    if (streak > best) {
      best = streak;
      anchor = candidate;
    }
  }
  counts.anchor = anchor;
  counts.maxStreak = Math.max(state.stats.maxStreak || 0, L?.maxStreak || 0, best);

  const groups = [...state.groups];
  for (const group of local.groups) if (!groups.includes(group)) groups.push(group);
  return {
    state: {
      ...state,
      results,
      stats: counts,
      frz,
      nick: state.nick || local.nickname || null,
      groups: groups.slice(0, MAX_GROUPS),
      board: state.board || local.playerId || randomUUID(),
    },
    writes,
    added,
    kept,
  };
}

/** The public account object (docs/accounts-api.md). */
export function accountView(id, state, { since = null } = {}) {
  const { streak, lastDate } = computeStreak(state.results, state.frz.days, state.stats.anchor);
  const results = Object.entries(state.results)
    .filter(([date]) => !since || date >= since)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([dateKey, r]) => {
      const out = {
        dateKey,
        number: puzzleNumber(dateKey),
        score: r.s,
        won: r.s < LOSS_SCORE,
        guesses: r.s < LOSS_SCORE ? r.s : MAX_GUESSES,
        archive: Boolean(r.a),
        verified: Boolean(r.v),
        at: r.at,
      };
      if (r.w) out.words = r.w;
      return out;
    });
  return {
    id,
    createdAt: state.created,
    provider: "apple",
    email: state.email || null,
    plus: Boolean(state.plus),
    resultsId: state.rid,
    stats: {
      played: state.stats.played,
      wins: state.stats.wins,
      streak,
      maxStreak: Math.max(state.stats.maxStreak || 0, streak),
      lastDate,
      dist: state.stats.dist,
      cleanWins: state.stats.cleanWins,
    },
    freezes: { used: state.frz.used || {}, days: state.frz.days || [] },
    social: { nickname: state.nick || null, groups: state.groups, boardId: state.board },
    results,
  };
}

// ---------------------------------------------------------------- storage helpers

function hashToObject(flat) {
  const out = {};
  for (let i = 0; i + 1 < (flat?.length || 0); i += 2) out[flat[i]] = flat[i + 1];
  return out;
}

const parseJSON = (value, fallback) => {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

function decodeState(raw, resultsRaw) {
  const results = {};
  for (const [date, value] of Object.entries(hashToObject(resultsRaw))) {
    const r = parseJSON(value, null);
    if (r && Number.isInteger(r.s)) results[date] = r;
  }
  const stats = { ...emptyStats(), ...parseJSON(raw.stats, {}) };
  return {
    sub: raw.sub || null,
    email: raw.email || null,
    created: Number(raw.created) || null,
    nick: raw.nick || null,
    groups: parseJSON(raw.groups, []),
    board: raw.board || null,
    rid: raw.rid || null,
    plus: raw.plus === "1",
    rt: raw.rt || null,
    rtc: raw.rtc || null,
    stats,
    frz: { used: {}, days: [], ...parseJSON(raw.frz, {}) },
    results,
  };
}

function encodeState(id, state) {
  const fields = {
    created: String(state.created),
    groups: JSON.stringify(state.groups || []),
    board: state.board,
    rid: state.rid,
    stats: JSON.stringify(state.stats),
    frz: JSON.stringify(state.frz),
    plus: state.plus ? "1" : "0",
  };
  if (state.sub) fields.sub = state.sub;
  if (state.email) fields.email = state.email;
  if (state.nick) fields.nick = state.nick;
  if (state.rt) fields.rt = state.rt;
  if (state.rtc) fields.rtc = state.rtc;
  return ["HSET", K.account(id), ...Object.entries(fields).flat()];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- handler

export function createHandler({
  env = process.env,
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  apple = null,
  lockRetryMs = 120,
} = {}) {
  const appleAuth = apple || createAppleAuth({ env, fetchImpl, now });

  async function limited(pipeline, bucket, id, max) {
    const hour = Math.floor(now() / 3600000);
    const key = `named:${bucket}:${id}:${hour}`;
    const [count] = await pipeline([["INCR", key], ["EXPIRE", key, 3600]]);
    if (Number(count) > max) {
      const retry = Math.max(1, Math.ceil(((hour + 1) * 3600000 - now()) / 1000));
      throw new ApiError(429, "rate_limited", "Too many requests, try again later", retry);
    }
  }

  async function authenticate(pipeline, req) {
    const header = String(req.headers?.authorization || "");
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!SESSION.test(token)) throw unauthorized();
    const hash = sha256hex(token);
    const [id] = await pipeline([["GET", K.session(hash)], ["EXPIRE", K.session(hash), SESSION_TTL_SECONDS]]);
    if (typeof id !== "string" || !ACCOUNT_ID.test(id)) throw unauthorized();
    return { id, hash };
  }

  async function load(pipeline, id) {
    const [raw, resultsRaw] = await pipeline([["HGETALL", K.account(id)], ["HGETALL", K.results(id)]]);
    const fields = hashToObject(raw);
    if (!fields.rid) return null;
    return decodeState(fields, resultsRaw);
  }

  async function withLock(pipeline, id, work) {
    const token = randomBytes(8).toString("hex");
    for (let attempt = 0; ; attempt++) {
      const [ok] = await pipeline([["SET", K.lock(id), token, "NX", "EX", LOCK_SECONDS]]);
      if (ok === "OK") break;
      if (attempt >= 8) throw unavailable("Your account is busy, try again");
      await sleep(lockRetryMs);
    }
    try {
      return await work();
    } finally {
      await pipeline([["DEL", K.lock(id)]]).catch(() => {});
    }
  }

  async function save(pipeline, id, state, writes = {}) {
    const commands = [encodeState(id, state)];
    const entries = Object.entries(writes);
    if (entries.length) commands.push(["HSET", K.results(id), ...entries.flatMap(([date, r]) => [date, JSON.stringify(r)])]);
    await pipeline(commands);
  }

  /** Posts one verified on-day result to each of the account's friends boards. */
  async function postBoards(pipeline, state, dateKey, score) {
    if (!state.nick || !state.groups.length || !state.board) return;
    const keys = state.groups.map((group) => K.board(group, dateKey));
    const sizes = await pipeline(keys.map((key) => ["HLEN", key]));
    const open = keys.filter((_, i) => Number(sizes[i]) < BOARD_MAX_ENTRIES);
    if (!open.length) return;
    const entry = JSON.stringify({ nickname: state.nick, score: score >= LOSS_SCORE ? null : score, createdAt: now() });
    const inserted = await pipeline(open.map((key) => ["HSETNX", key, state.board, entry]));
    const expire = open.filter((_, i) => Number(inserted[i]) === 1).map((key) => ["EXPIRE", key, BOARD_TTL_SECONDS]);
    if (expire.length) await pipeline(expire);
  }

  /** Moves a device's recent friends-board entries from its own player ID onto the account's. */
  async function adoptBoards(pipeline, groups, fromId, toId) {
    if (!fromId || !toId || fromId === toId || !groups.length) return;
    const today = utcKey(now());
    const dates = [shiftDateKey(today, -1), today, shiftDateKey(today, 1)];
    const keys = groups.flatMap((group) => dates.map((date) => K.board(group, date)));
    const found = await pipeline(keys.map((key) => ["HGET", key, fromId]));
    const commands = [];
    keys.forEach((key, i) => {
      if (found[i] == null) return;
      commands.push(["HSETNX", key, toId, found[i]], ["HDEL", key, fromId]);
    });
    if (commands.length) await pipeline(commands);
  }

  // ------------------------------------------------------------ actions

  function config() {
    const servicesId = env.APPLE_SERVICES_ID || null;
    return {
      accounts: Boolean(kvPipeline(env, fetchImpl)),
      apple: {
        web: Boolean(servicesId),
        servicesId,
        redirectURI: env.APPLE_REDIRECT_URI || "https://namedgame.com/",
        scope: "",
      },
    };
  }

  async function issueNonce(pipeline) {
    const minute = Math.floor(now() / 60000);
    const [count] = await pipeline([["INCR", `named:nrl:${minute}`], ["EXPIRE", `named:nrl:${minute}`, 120]]);
    if (Number(count) > NONCE_RATE_PER_MINUTE) throw new ApiError(429, "rate_limited", "Too many sign-ins right now", 60);
    const nonce = randomBytes(32).toString("base64url");
    await pipeline([["SET", K.nonce(sha256hex(nonce)), "1", "EX", NONCE_TTL_SECONDS]]);
    return { nonce, expiresIn: NONCE_TTL_SECONDS };
  }

  async function signIn(pipeline, body) {
    const platform = body.platform;
    if (platform !== "ios" && platform !== "web") throw badRequest("Invalid platform");
    if (typeof body.identityToken !== "string" || typeof body.nonce !== "string" || body.nonce.length > 200) throw badRequest("Missing identity token or nonce");
    const local = parseLocal(body.local, now());

    let identity;
    try {
      identity = await appleAuth.verifyIdentityToken(body.identityToken, { nonce: body.nonce });
    } catch (error) {
      if (error instanceof AppleTokenError) {
        if (error.code === "unavailable") throw unavailable("Apple sign-in is unreachable, try again");
        throw new ApiError(401, error.code, error.code === "invalid_nonce" ? "Sign-in expired, try again" : "Sign in didn't work, try again");
      }
      throw error;
    }
    const [consumed] = await pipeline([["DEL", K.nonce(sha256hex(body.nonce))]]);
    if (Number(consumed) !== 1) throw new ApiError(401, "invalid_nonce", "Sign-in expired, try again");
    await limited(pipeline, "srl", sha256hex(identity.sub).slice(0, 32), SIGNIN_LIMIT);

    let created = false;
    let [id] = await pipeline([["GET", K.apple(identity.sub)]]);
    if (!id) {
      const fresh = randomBytes(16).toString("hex");
      const [ok] = await pipeline([["SET", K.apple(identity.sub), fresh, "NX"]]);
      if (ok === "OK") {
        id = fresh;
        created = true;
        const state = {
          sub: identity.sub,
          email: identity.email,
          created: now(),
          nick: null,
          groups: [],
          board: null,
          rid: randomUUID(),
          plus: false,
          stats: emptyStats(),
          frz: { used: {}, days: [] },
          results: {},
        };
        await save(pipeline, id, { ...state, board: local.playerId || randomUUID() });
      } else {
        [id] = await pipeline([["GET", K.apple(identity.sub)]]);
      }
    }
    if (typeof id !== "string" || !ACCOUNT_ID.test(id)) throw unavailable();

    const refreshToken = body.authorizationCode ? await appleAuth.exchangeCode(body.authorizationCode, identity.aud) : null;

    const outcome = await withLock(pipeline, id, async () => {
      const state = await load(pipeline, id);
      if (!state) throw unavailable();
      const merged = mergeLocal(state, local);
      const next = { ...merged.state, sub: identity.sub };
      if (identity.email) next.email = identity.email;
      if (refreshToken) {
        next.rt = refreshToken;
        next.rtc = identity.aud;
      }
      await save(pipeline, id, next, merged.writes);
      return { state: next, added: merged.added, kept: merged.kept, upgraded: Object.keys(merged.writes) };
    });

    const session = `nms_${randomBytes(32).toString("base64url")}`;
    const hash = sha256hex(session);
    await pipeline([
      ["SET", K.session(hash), id, "EX", SESSION_TTL_SECONDS],
      ["SADD", K.sessions(id), hash],
    ]);

    // Best effort: rank and boards follow the person. A failure here never fails sign-in.
    try {
      if (local.installId) await adoptVs(pipeline, local.installId, outcome.state.rid);
      await adoptBoards(pipeline, local.groups, local.playerId, outcome.state.board);
      // Verified device results (sent with their words) feed "you vs everyone" too; HSETNX dedups.
      const verified = outcome.upgraded.filter((date) => outcome.state.results[date]?.v && date >= HISTORY_START_DATE).sort().slice(-60);
      for (const date of verified) {
        await recordVs(pipeline, { installId: outcome.state.rid, number: puzzleNumber(date), score: outcome.state.results[date].s });
      }
    } catch { /* ignore */ }

    return {
      session,
      created,
      merged: { added: outcome.added, kept: outcome.kept },
      account: accountView(id, outcome.state),
    };
  }

  async function recordResult(pipeline, id, body) {
    if (!validResultsDate(body.dateKey, now())) throw badRequest("Invalid day");
    if (!Array.isArray(body.guesses) || body.guesses.length > MAX_GUESSES) throw badRequest("Invalid guesses");
    let score;
    try {
      score = replayDaily(body.guesses, body.dateKey, NAMES);
    } catch (error) {
      throw badRequest(error.message);
    }
    const dateKey = body.dateKey;
    const archive = body.archive === true || !inBoardWindow(dateKey, new Date(now()));
    const outcome = await withLock(pipeline, id, async () => {
      const state = await load(pipeline, id);
      if (!state) throw unauthorized();
      if (typeof body.plus === "boolean") state.plus = body.plus;
      const existing = state.results[dateKey];
      if (existing) {
        if (!existing.v && existing.s === score) {
          state.results[dateKey] = { ...existing, v: 1, w: body.guesses };
          await save(pipeline, id, state, { [dateKey]: state.results[dateKey] });
          return { state, saved: false, duplicate: true, froze: [], feed: true, archive: Boolean(existing.a) };
        }
        await save(pipeline, id, state);
        return { state, saved: false, duplicate: true, froze: [], feed: false };
      }
      let froze = [];
      if (!archive) {
        const cover = coverMissedDays(state.stats, state.results, state.frz, dateKey, state.plus);
        if (cover) {
          froze = cover.days;
          state.frz = cover.frz;
        }
      }
      const entry = { s: score, a: archive ? 1 : 0, v: 1, at: now(), w: body.guesses, c: body.clean === false ? 0 : 1 };
      state.results[dateKey] = entry;
      if (!archive) state.stats = countResult(state.stats, score, body.clean !== false);
      const { streak } = computeStreak(state.results, state.frz.days, state.stats.anchor);
      state.stats.maxStreak = Math.max(state.stats.maxStreak || 0, streak);
      await save(pipeline, id, state, { [dateKey]: entry });
      return { state, saved: true, duplicate: false, froze, feed: true, archive };
    });

    let vs = null;
    const number = puzzleNumber(dateKey);
    try {
      if (outcome.feed) {
        await recordVs(pipeline, { installId: outcome.state.rid, number, score });
        if (!outcome.archive) await postBoards(pipeline, outcome.state, dateKey, score);
      }
      vs = await vsSummary(pipeline, number, outcome.state.rid);
    } catch {
      vs = null;
    }
    return { saved: outcome.saved, duplicate: outcome.duplicate, froze: outcome.froze, account: accountView(id, outcome.state), vs };
  }

  async function freeze(pipeline, id, body) {
    if (!realDate(body.today) || !inBoardWindow(body.today, new Date(now()))) throw badRequest("Invalid day");
    return withLock(pipeline, id, async () => {
      const state = await load(pipeline, id);
      if (!state) throw unauthorized();
      if (typeof body.plus === "boolean") state.plus = body.plus;
      const cover = coverMissedDays(state.stats, state.results, state.frz, body.today, state.plus);
      if (cover) {
        state.frz = cover.frz;
        const { streak } = computeStreak(state.results, state.frz.days, state.stats.anchor);
        state.stats.maxStreak = Math.max(state.stats.maxStreak || 0, streak);
      }
      await save(pipeline, id, state);
      return { saved: Boolean(cover), froze: cover?.days || [], account: accountView(id, state) };
    });
  }

  async function patch(pipeline, id, body) {
    const hasNick = Object.hasOwn(body, "nickname");
    const hasGroups = Object.hasOwn(body, "groups");
    if (!hasNick && !hasGroups) throw badRequest("Nothing to change");
    let nick;
    if (hasNick) {
      nick = body.nickname === null ? null : cleanNickname(body.nickname);
      if (body.nickname !== null && !nick) throw badRequest("Nickname must be 2–20 plain characters");
    }
    let groups;
    if (hasGroups) {
      if (!Array.isArray(body.groups) || body.groups.length > MAX_GROUPS) throw badRequest("Invalid groups");
      groups = body.groups.map(normalizeGroup);
      if (groups.some((g) => !g)) throw badRequest("Invalid group code");
      groups = [...new Set(groups)];
    }
    return withLock(pipeline, id, async () => {
      const state = await load(pipeline, id);
      if (!state) throw unauthorized();
      if (hasNick) state.nick = nick;
      if (hasGroups) state.groups = groups;
      const commands = [encodeState(id, state)];
      if (hasNick && !nick) commands.push(["HDEL", K.account(id), "nick"]);
      await pipeline(commands);
      return { account: accountView(id, state) };
    });
  }

  async function logout(pipeline, session) {
    await pipeline([["DEL", K.session(session.hash)], ["SREM", K.sessions(session.id), session.hash]]);
  }

  async function deleteAccount(pipeline, id, body) {
    const state = await load(pipeline, id);
    if (!state) throw unauthorized();
    let appleRevoked = false;
    if (siwaConfigured(env)) {
      if (state.rt) appleRevoked = await appleAuth.revoke(state.rt, state.rtc || IOS_BUNDLE_ID);
      if (!appleRevoked && typeof body.authorizationCode === "string") {
        const clientId = body.platform === "web" && env.APPLE_SERVICES_ID ? env.APPLE_SERVICES_ID : IOS_BUNDLE_ID;
        const token = await appleAuth.exchangeCode(body.authorizationCode, clientId);
        if (token) appleRevoked = await appleAuth.revoke(token, clientId);
      }
    }
    await removeVs(pipeline, state.rid);
    const cutoff = utcKey(now() - 92 * 86400000);
    const boardDeletes = [];
    if (state.board) {
      for (const [date, r] of Object.entries(state.results)) {
        if (r.a || date < cutoff) continue;
        for (const group of state.groups) boardDeletes.push(["HDEL", K.board(group, date), state.board]);
      }
    }
    const [hashes] = await pipeline([["SMEMBERS", K.sessions(id)]]);
    const commands = [
      ...boardDeletes,
      ...(hashes || []).map((hash) => ["DEL", K.session(hash)]),
      ["DEL", K.sessions(id)],
      ["DEL", K.account(id)],
      ["DEL", K.results(id)],
      ["DEL", K.lock(id)],
    ];
    if (state.sub) commands.push(["DEL", K.apple(state.sub)]);
    await pipeline(commands);
    return { deleted: true, appleRevoked };
  }

  // ------------------------------------------------------------ routing

  function actionOf(req) {
    if (req.query?.action) return String(req.query.action);
    const path = new URL(req.url || "/", "http://local").pathname.replace(/\/+$/, "");
    if (path === "/api/config") return "config";
    const match = path.match(/^\/api\/account(?:\/([a-z]+))?$/);
    return match ? match[1] || "" : "";
  }

  const ROUTES = {
    "": ["GET", "PATCH", "DELETE"],
    config: ["GET"],
    nonce: ["POST"],
    apple: ["POST"],
    result: ["POST"],
    freeze: ["POST"],
    logout: ["POST"],
  };

  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    const send = (status, data) => (data === undefined ? res.status(status).end() : res.status(status).json(data));
    try {
      const action = actionOf(req);
      const methods = ROUTES[action];
      if (!methods) throw new ApiError(404, "not_found", "Not found");
      if (!methods.includes(req.method)) {
        res.setHeader("Allow", methods.join(", "));
        throw new ApiError(405, "method_not_allowed", "Method not allowed");
      }
      if (action === "config") return send(200, config());

      const pipeline = kvPipeline(env, fetchImpl);
      if (!pipeline) throw new ApiError(503, "not_configured", "Accounts are not connected yet");
      const body = () => {
        try {
          return readBody(req, action === "apple" ? SIGNIN_BODY_BYTES : BODY_BYTES);
        } catch (error) {
          if (error instanceof BadRequest) {
            const size = Number(req.headers?.["content-length"] || 0);
            const limit = action === "apple" ? SIGNIN_BODY_BYTES : BODY_BYTES;
            throw size > limit ? new ApiError(413, "too_large", "Request too large") : badRequest();
          }
          throw error;
        }
      };
      const optionalBody = () => {
        if (req.body == null || req.body === "") return {};
        return body();
      };

      if (action === "nonce") return send(200, await issueNonce(pipeline));
      if (action === "apple") return send(200, await signIn(pipeline, body()));

      const session = await authenticate(pipeline, req);
      if (action === "logout") {
        await logout(pipeline, session);
        return send(204);
      }
      if (action === "" && req.method === "GET") {
        await limited(pipeline, "arr", session.id, READ_LIMIT);
        const state = await load(pipeline, session.id);
        if (!state) throw unauthorized();
        const since = realDate(req.query?.resultsSince) ? req.query.resultsSince : null;
        return send(200, { account: accountView(session.id, state, { since }) });
      }
      if (action === "" && req.method === "DELETE") return send(200, await deleteAccount(pipeline, session.id, optionalBody()));

      await limited(pipeline, "arl", session.id, WRITE_LIMIT);
      if (action === "result") return send(200, await recordResult(pipeline, session.id, body()));
      if (action === "freeze") return send(200, await freeze(pipeline, session.id, body()));
      return send(200, await patch(pipeline, session.id, body()));
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.retryAfter) res.setHeader("Retry-After", String(error.retryAfter));
        return send(error.status, { error: error.message, code: error.code });
      }
      console.error("account:", error?.message || error);
      return send(503, { error: "Accounts are unavailable right now", code: "unavailable" });
    }
  };
}

export default createHandler();
