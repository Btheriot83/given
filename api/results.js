// "You vs everyone" for numbered dailies (web and the Named iPhone app).
//
// POST /api/results
//   { "installId": "<uuid>", "dateKey": "2026-10-24", "guesses": ["CHARLES", "PAULINE"] }
//   The guesses are replayed against pickDailyPuzzle(dateKey). The first result per
//   install per number wins; a repeat returns the stored summary unchanged.
//   -> 200 summary (below) | 400 bad body or replay | 405 | 429 rate limited | 503 no storage
//
// GET /api/results?number=298&installId=<uuid>
//   -> 200 { number, players, solveRate, dist[6], failed, you, overall }
//
// DELETE /api/results?installId=<uuid>   (Authorization: Bearer $ATTRIBUTION_ADMIN_TOKEN)
//   -> 204 after removing every result of one install and backing out the counts; 404 if absent.
// DELETE /api/results?installIdPrefix=7e57d0d0-0000-   (same bearer; test cleanup)
//   -> 200 { removed } after deleting every install whose ID starts with the prefix.
//
// Storage (Upstash Redis):
//   named:res:<number>      hash d1..d6, x (failed), n (players)
//   named:res:<number>:p    hash installId -> score (1-6, 7 = loss), written with HSETNX
//   named:plr:<installId>   hash played, wins, sum (+ r<number> -> score, for deletion); 400-day TTL
//   named:rank              sorted set installId -> average, installs with 3+ results only
//   named:rl:<installId>:<hour>  POST counter, 60 per hour
// No IP addresses, user agents, names or accounts are read or stored.

import { createHash, timingSafeEqual } from "node:crypto";
import names from "../data/names.json" with { type: "json" };
import answerPools from "../data/answer-pools.json" with { type: "json" };
import { HISTORY_START_DATE, MAX_GUESSES, puzzleNumber } from "../js/engine.js";
import { replayDaily, LOSS_SCORE } from "../js/leaderboard-core.js";

const PLAYER_TTL_SECONDS = 400 * 24 * 3600;
const RATE_LIMIT = 60;
const RATE_WINDOW_SECONDS = 3600;
const MIN_RANKED = 3;
const MAX_BODY_BYTES = 4 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const RANK_KEY = "named:rank";

const resKey = (number) => `named:res:${number}`;
const playersKey = (number) => `named:res:${number}:p`;
const playerKey = (installId) => `named:plr:${installId}`;

const NAMES = {
  ...names,
  guessSet: new Set(names.guesses),
  familiarAnswers: answerPools.familiar,
  lengthWeights: answerPools.lengthWeights,
  dailyPools: answerPools,
};

export class BadRequest extends Error {}
const bad = (message = "Invalid request") => new BadRequest(message);

function utcKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Lowest and highest playable numbers right now: HISTORY_START_DATE .. the server's tomorrow. */
export function numberRange(nowMs) {
  return { first: puzzleNumber(HISTORY_START_DATE), last: puzzleNumber(utcKey(nowMs + 86400000)) };
}

export function validDateKey(value, nowMs) {
  if (typeof value !== "string" || !DATE_KEY.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return false;
  return value >= HISTORY_START_DATE && value <= utcKey(nowMs + 86400000);
}

export function normalizeInstallId(value) {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}

export function readBody(req) {
  if (Number(req.headers?.["content-length"] || 0) > MAX_BODY_BYTES) throw bad();
  let body;
  try {
    body = req.body;
  } catch {
    throw bad(); // Vercel throws on malformed JSON
  }
  if (Buffer.isBuffer(body)) body = body.toString("utf8");
  if (typeof body === "string") {
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw bad();
    try {
      body = JSON.parse(body);
    } catch {
      throw bad();
    }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad();
  return body;
}

/** Validates a POST body and replays it. Returns { installId, dateKey, number, score }. */
export function validatePost(body, nowMs) {
  const installId = normalizeInstallId(body.installId);
  if (!installId) throw bad("Invalid install ID");
  if (!validDateKey(body.dateKey, nowMs)) throw bad("Invalid day");
  if (!Array.isArray(body.guesses) || body.guesses.length > MAX_GUESSES) throw bad("Invalid guesses");
  let score;
  try {
    score = replayDaily(body.guesses, body.dateKey, NAMES);
  } catch (error) {
    throw bad(error.message);
  }
  return { installId, dateKey: body.dateKey, number: puzzleNumber(body.dateKey), score };
}

function hashToObject(flat) {
  const out = {};
  for (let i = 0; i + 1 < (flat?.length || 0); i += 2) out[flat[i]] = flat[i + 1];
  return out;
}

const pct = (part, whole) => (whole > 0 ? Math.round((100 * part) / whole) : 0);

/** Pure: builds the public summary from raw Redis values. */
export function buildSummary(number, stats, yourScore, player, rank) {
  const num = (field) => Number(stats?.[field]) || 0;
  const dist = [1, 2, 3, 4, 5, 6].map((i) => num(`d${i}`));
  const failed = num("x");
  const players = num("n");
  let you = null;
  const score = Number(yourScore);
  if (Number.isInteger(score) && score >= 1 && score <= LOSS_SCORE) {
    const counts = [...dist, failed];
    const worse = counts.slice(score).reduce((a, b) => a + b, 0);
    you = { score, betterThan: pct(worse, players), tiedWith: pct(counts[score - 1], players) };
  }
  let overall = null;
  if (player) {
    const played = Number(player.played) || 0;
    const wins = Number(player.wins) || 0;
    const sum = Number(player.sum) || 0;
    const ranked = played >= MIN_RANKED && rank && rank.total > 0;
    overall = {
      played,
      wins,
      average: played ? Math.round((sum / played) * 10) / 10 : null,
      percentile: ranked ? pct(rank.worse, rank.total) : null,
      rankedPlayers: ranked ? rank.total : null,
    };
  }
  return { number, players, solveRate: pct(players - failed, players), dist, failed, you, overall };
}

function sameSecret(given, expected) {
  const a = createHash("sha256").update(String(given)).digest();
  const b = createHash("sha256").update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

export function createHandler({ env = process.env, fetchImpl = (...args) => fetch(...args), now = () => Date.now() } = {}) {
  function storage() {
    const url = env.KV_REST_API_URL;
    const token = env.KV_REST_API_TOKEN;
    if (!url || !token) return null;
    return async function pipeline(commands) {
      const response = await fetchImpl(`${url.replace(/\/+$/, "")}/pipeline`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(commands),
      });
      if (!response.ok) throw new Error("storage");
      const payload = await response.json();
      if (!Array.isArray(payload)) throw new Error("storage");
      return payload.map((item) => {
        if (item?.error) throw new Error("storage");
        return item?.result;
      });
    };
  }

  async function summary(pipeline, number, installId) {
    if (!installId) {
      const [stats] = await pipeline([["HGETALL", resKey(number)]]);
      return buildSummary(number, hashToObject(stats), null, null, null);
    }
    const [stats, yourScore, playerRaw] = await pipeline([
      ["HGETALL", resKey(number)],
      ["HGET", playersKey(number), installId],
      ["HMGET", playerKey(installId), "played", "wins", "sum"],
    ]);
    const [played, wins, sum] = playerRaw || [];
    const player = played == null ? { played: 0, wins: 0, sum: 0 } : { played, wins, sum };
    let rank = null;
    if (Number(player.played) >= MIN_RANKED) {
      const average = Number(player.sum) / Number(player.played);
      // ZADD is idempotent; it also heals an average that a concurrent POST left stale.
      const [, worse, total] = await pipeline([
        ["ZADD", RANK_KEY, average, installId],
        ["ZCOUNT", RANK_KEY, `(${average}`, "+inf"],
        ["ZCARD", RANK_KEY],
      ]);
      rank = { worse: Number(worse) || 0, total: Number(total) || 0 };
    }
    return buildSummary(number, hashToObject(stats), yourScore, player, rank);
  }

  async function record(pipeline, { installId, number, score }) {
    const [claimed] = await pipeline([["HSETNX", playersKey(number), installId, score]]);
    if (Number(claimed) !== 1) return; // first result per install per number wins
    const won = score < LOSS_SCORE;
    const pk = playerKey(installId);
    const [, , played, , sum] = await pipeline([
      ["HINCRBY", resKey(number), won ? `d${score}` : "x", 1],
      ["HINCRBY", resKey(number), "n", 1],
      ["HINCRBY", pk, "played", 1],
      ["HINCRBY", pk, "wins", won ? 1 : 0],
      ["HINCRBY", pk, "sum", score],
      ["HSET", pk, `r${number}`, score],
      ["EXPIRE", pk, PLAYER_TTL_SECONDS],
    ]);
    if (Number(played) >= MIN_RANKED) {
      await pipeline([["ZADD", RANK_KEY, Number(sum) / Number(played), installId]]);
    }
  }

  async function rateLimited(pipeline, installId) {
    const window = Math.floor(now() / (RATE_WINDOW_SECONDS * 1000));
    const key = `named:rl:${installId}:${window}`;
    const [count] = await pipeline([["INCR", key], ["EXPIRE", key, RATE_WINDOW_SECONDS]]);
    return Number(count) > RATE_LIMIT;
  }

  // Admin deletion (privacy requests, test cleanup).
  async function remove(pipeline, installId) {
    const pk = playerKey(installId);
    const [raw] = await pipeline([["HGETALL", pk]]);
    const player = hashToObject(raw);
    const results = Object.entries(player).filter(([field]) => /^r\d+$/.test(field));
    const commands = [];
    let removed = 0;
    for (const [field, value] of results) {
      const number = Number(field.slice(1));
      const [deleted] = await pipeline([["HDEL", playersKey(number), installId]]);
      if (Number(deleted) !== 1) continue;
      removed++;
      const score = Number(value);
      commands.push(["HINCRBY", resKey(number), score < LOSS_SCORE ? `d${score}` : "x", -1]);
      commands.push(["HINCRBY", resKey(number), "n", -1]);
    }
    const [deletedPlayer, zrem] = await pipeline([["DEL", pk], ["ZREM", RANK_KEY, installId], ...commands]);
    return removed > 0 || Number(deletedPlayer) > 0 || Number(zrem) > 0;
  }

  async function scanPlayers(pipeline, prefix) {
    const found = new Set();
    let cursor = "0";
    for (let guard = 0; guard < 1000; guard++) {
      const [[next, keys]] = await pipeline([["SCAN", cursor, "MATCH", `${playerKey(prefix)}*`, "COUNT", 1000]]);
      for (const key of keys || []) {
        const id = normalizeInstallId(String(key).slice(playerKey("").length));
        if (id) found.add(id);
      }
      cursor = String(next);
      if (cursor === "0") break;
    }
    return [...found];
  }

  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    const fail = (status, error) => res.status(status).json({ error });

    if (req.method === "DELETE") {
      const secret = env.ATTRIBUTION_ADMIN_TOKEN;
      if (!secret) return fail(503, "Admin access is not configured");
      const header = String(req.headers?.authorization || "");
      const given = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!given || !sameSecret(given, secret)) return fail(401, "Unauthorized");
      const pipeline = storage();
      if (!pipeline) return fail(503, "Storage is not connected");
      const prefix = String(req.query?.installIdPrefix || "").toLowerCase();
      if (prefix) {
        if (!/^[0-9a-f]{8}-[0-9a-f-]{5,27}$/.test(prefix)) return fail(400, "Invalid request");
        try {
          let removed = 0;
          for (const installId of await scanPlayers(pipeline, prefix)) if (await remove(pipeline, installId)) removed++;
          return res.status(200).json({ removed });
        } catch {
          return fail(503, "Storage unavailable");
        }
      }
      const installId = normalizeInstallId(req.query?.installId);
      if (!installId) return fail(400, "Invalid request");
      try {
        return (await remove(pipeline, installId)) ? res.status(204).end() : fail(404, "Not found");
      } catch {
        return fail(503, "Storage unavailable");
      }
    }

    if (req.method !== "GET" && req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return fail(405, "Method not allowed");
    }
    const pipeline = storage();
    if (!pipeline) return fail(503, "Storage is not connected");

    if (req.method === "GET") {
      const raw = String(req.query?.number ?? "");
      const number = /^\d{1,6}$/.test(raw) ? Number(raw) : NaN;
      const { first, last } = numberRange(now());
      if (!(number >= first && number <= last)) return fail(400, "Invalid number");
      let installId = null;
      if (req.query?.installId != null && req.query.installId !== "") {
        installId = normalizeInstallId(req.query.installId);
        if (!installId) return fail(400, "Invalid install ID");
      }
      try {
        return res.status(200).json(await summary(pipeline, number, installId));
      } catch {
        return fail(503, "Storage unavailable");
      }
    }

    let result;
    try {
      result = validatePost(readBody(req), now());
    } catch (error) {
      return fail(400, error instanceof BadRequest ? error.message : "Invalid request");
    }
    try {
      if (await rateLimited(pipeline, result.installId)) return fail(429, "Too many results, try again later");
      await record(pipeline, result);
      return res.status(200).json(await summary(pipeline, result.number, result.installId));
    } catch {
      return fail(503, "Storage unavailable");
    }
  };
}

export default createHandler();
