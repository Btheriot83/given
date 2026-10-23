// Apple Search Ads attribution for the Named iOS app (com.theriot.named).
//
// POST /api/attribution
//   { "installId": "<uuid v4>", "token": "<AAAttribution token>" }   first launch
//   { "installId": "<same uuid>", "purchased": true }                 Named+ bought
//   -> 204 on success. Stored data is never echoed back.
//
// GET /api/attribution?summary=1   (Authorization: Bearer $ATTRIBUTION_ADMIN_TOKEN)
//   -> 200 { installs, purchases, resolved, attributed, campaigns: [...] }
//
// Storage: Upstash Redis hash given:attr:<installId>, kept 400 days.
// Counters: given:attr:stats (installs, purchases, resolved, attributed) and
// given:attr:campaigns (<campaignId>:installs, <campaignId>:purchases).
// No IP addresses or user agents are read or stored.

import { createHash, timingSafeEqual } from "node:crypto";

export const APPLE_URL = "https://api-adservices.apple.com/api/v1/";
const TTL_SECONDS = 400 * 24 * 3600;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_TOKEN_BYTES = 4 * 1024;
const TOKEN_LIFETIME_MS = 24 * 3600 * 1000; // Apple tokens expire after 24 hours
const APPLE_TIMEOUT_MS = 4000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATS_KEY = "given:attr:stats";
const CAMPAIGNS_KEY = "given:attr:campaigns";
const ID_FIELDS = ["orgId", "campaignId", "adGroupId", "keywordId", "adId"];

const recordKey = (installId) => `given:attr:${installId}`;

export class BadRequest extends Error {}

function bad() {
  return new BadRequest("Invalid request");
}

// Accepts the body as Vercel parses it (object), or as a raw string/Buffer.
export function readBody(req) {
  const declared = Number(req.headers?.["content-length"] || 0);
  if (declared > MAX_BODY_BYTES) throw bad();
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
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) throw bad();
  return body;
}

export function validatePost(body) {
  const keys = Object.keys(body).sort().join(",");
  const { installId } = body;
  if (typeof installId !== "string" || !UUID_V4.test(installId)) throw bad();
  const id = installId.toLowerCase();
  if (keys === "installId,token") {
    const { token } = body;
    if (typeof token !== "string" || !token.trim()) throw bad();
    if (Buffer.byteLength(token) > MAX_TOKEN_BYTES) throw bad();
    if (/[\u0000-\u001f\u007f]/.test(token)) throw bad();
    return { kind: "token", installId: id, token };
  }
  if (keys === "installId,purchased") {
    if (body.purchased !== true) throw bad();
    return { kind: "purchase", installId: id };
  }
  throw bad();
}

// Keep only the documented AdServices fields, normalised to short strings.
export function pickAppleFields(data) {
  const out = { attribution: data?.attribution === true ? "1" : "0" };
  for (const field of ID_FIELDS) {
    const value = data?.[field];
    if (Number.isSafeInteger(value) && value >= 0) out[field] = String(value);
    else if (typeof value === "string" && /^\d{1,20}$/.test(value)) out[field] = value;
  }
  if (typeof data?.countryOrRegion === "string" && /^[A-Za-z]{2,3}$/.test(data.countryOrRegion)) {
    out.countryOrRegion = data.countryOrRegion.toUpperCase();
  }
  if (typeof data?.conversionType === "string" && /^[A-Za-z]{1,32}$/.test(data.conversionType)) {
    out.conversionType = data.conversionType;
  }
  if (typeof data?.clickDate === "string" && /^[0-9T:.+\-Z ]{1,40}$/.test(data.clickDate)) {
    out.clickDate = data.clickDate;
  }
  return out;
}

function hashToObject(flat) {
  const out = {};
  for (let i = 0; i + 1 < (flat?.length || 0); i += 2) out[flat[i]] = flat[i + 1];
  return out;
}

function sameSecret(given, expected) {
  const a = createHash("sha256").update(String(given)).digest();
  const b = createHash("sha256").update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

export function createHandler({
  env = process.env,
  fetchImpl = (...args) => fetch(...args),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  retryDelayMs = 5000,
  appleAttempts = 3,
} = {}) {
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

  // Returns { status: "ok", data } | { status: "invalid" } | { status: "pending" } | { status: "error" }.
  async function exchange(appleToken, attempts) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let status = 0;
      try {
        const response = await fetchImpl(APPLE_URL, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: appleToken,
          signal: AbortSignal.timeout(APPLE_TIMEOUT_MS),
        });
        status = response.status;
        if (response.ok) {
          const data = await response.json().catch(() => null);
          return data && typeof data === "object" ? { status: "ok", data } : { status: "error" };
        }
      } catch {
        status = 0; // network error or timeout
      }
      if (status === 400) return { status: "invalid" };
      const retryable = status === 404 || status === 0 || status >= 500;
      if (!retryable) return { status: "error" };
      if (attempt < attempts) await sleep(retryDelayMs);
      else return { status: status === 404 ? "pending" : "error" };
    }
    return { status: "error" };
  }

  // Counts a purchase against its campaign exactly once, whichever of
  // "attribution resolved" and "purchased" lands second.
  async function countCampaignPurchase(pipeline, key) {
    const [campaignId, purchased, attribution] = (await pipeline([["HMGET", key, "campaignId", "purchased", "attribution"]]))[0] || [];
    if (!campaignId || purchased !== "1" || attribution !== "1") return;
    const [claimed] = await pipeline([["HSETNX", key, "campaignPurchaseCounted", "1"]]);
    if (Number(claimed) === 1) await pipeline([["HINCRBY", CAMPAIGNS_KEY, `${campaignId}:purchases`, 1]]);
  }

  async function resolve(pipeline, key, appleToken, attempts) {
    const result = await exchange(appleToken, attempts);
    const at = String(now());
    if (result.status === "ok") {
      const [claimed] = await pipeline([["HSETNX", key, "resolvedAt", at]]);
      if (Number(claimed) !== 1) return; // a parallel request already resolved it
      const fields = pickAppleFields(result.data);
      const commands = [
        ["HSET", key, "appleStatus", "ok", ...Object.entries(fields).flat()],
        ["HDEL", key, "token", "tokenAt"],
        ["EXPIRE", key, TTL_SECONDS],
        ["HINCRBY", STATS_KEY, "resolved", 1],
      ];
      if (fields.attribution === "1") {
        commands.push(["HINCRBY", STATS_KEY, "attributed", 1]);
        if (fields.campaignId) commands.push(["HINCRBY", CAMPAIGNS_KEY, `${fields.campaignId}:installs`, 1]);
      }
      await pipeline(commands);
      if (fields.attribution === "1" && fields.campaignId) await countCampaignPurchase(pipeline, key);
    } else if (result.status === "invalid") {
      await pipeline([
        ["HSET", key, "appleStatus", "invalid", "resolvedAt", at],
        ["HDEL", key, "token", "tokenAt"],
        ["EXPIRE", key, TTL_SECONDS],
      ]);
    } else {
      // Token kept so a later call (within Apple's 24 h window) can resolve it.
      await pipeline([["HSET", key, "appleStatus", result.status], ["EXPIRE", key, TTL_SECONDS]]);
    }
  }

  async function handleToken(pipeline, { installId, token }) {
    const key = recordKey(installId);
    const at = String(now());
    const [, firstToken, , raw] = await pipeline([
      ["HSETNX", key, "firstSeen", at],
      ["HSETNX", key, "installCounted", "1"],
      ["EXPIRE", key, TTL_SECONDS],
      ["HGETALL", key],
    ]);
    if (Number(firstToken) === 1) await pipeline([["HINCRBY", STATS_KEY, "installs", 1]]);
    const record = hashToObject(raw);
    if (record.resolvedAt) return;
    await pipeline([["HSET", key, "token", token, "tokenAt", at, "appleStatus", "pending"]]);
    await resolve(pipeline, key, token, appleAttempts);
  }

  async function handlePurchase(pipeline, { installId }) {
    const key = recordKey(installId);
    const at = String(now());
    const [, firstPurchase, , raw] = await pipeline([
      ["HSETNX", key, "firstSeen", at],
      ["HSETNX", key, "purchased", "1"],
      ["EXPIRE", key, TTL_SECONDS],
      ["HGETALL", key],
    ]);
    const record = hashToObject(raw);
    if (Number(firstPurchase) === 1) {
      await pipeline([["HSET", key, "purchasedAt", at], ["HINCRBY", STATS_KEY, "purchases", 1]]);
      await countCampaignPurchase(pipeline, key);
    }
    // Lazy retry of a token Apple was not ready to resolve on first launch.
    const tokenAge = Number(at) - Number(record.tokenAt || 0);
    if (!record.resolvedAt && record.token && tokenAge < TOKEN_LIFETIME_MS) {
      await resolve(pipeline, key, record.token, 1);
    }
  }

  async function summary(pipeline) {
    const [statsRaw, campaignsRaw] = await pipeline([["HGETALL", STATS_KEY], ["HGETALL", CAMPAIGNS_KEY]]);
    const stats = hashToObject(statsRaw);
    const byCampaign = {};
    for (const [field, value] of Object.entries(hashToObject(campaignsRaw))) {
      const [campaignId, metric] = field.split(":");
      if (!campaignId || (metric !== "installs" && metric !== "purchases")) continue;
      byCampaign[campaignId] ||= { campaignId, installs: 0, purchases: 0 };
      byCampaign[campaignId][metric] = Number(value) || 0;
    }
    const num = (name) => Number(stats[name]) || 0;
    return {
      installs: num("installs"),
      purchases: num("purchases"),
      resolved: num("resolved"),
      attributed: num("attributed"),
      campaigns: Object.values(byCampaign).sort((a, b) => b.installs - a.installs || b.purchases - a.purchases),
    };
  }

  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    const fail = (status, error) => res.status(status).json({ error });

    if (req.method === "GET" && req.query?.summary === "1") {
      const secret = env.ATTRIBUTION_ADMIN_TOKEN;
      if (!secret) return fail(503, "Summary is not configured");
      const header = String(req.headers?.authorization || "");
      const given = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!given || !sameSecret(given, secret)) return fail(401, "Unauthorized");
      const pipeline = storage();
      if (!pipeline) return fail(503, "Storage is not connected");
      try {
        return res.status(200).json(await summary(pipeline));
      } catch {
        return fail(503, "Storage unavailable");
      }
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return fail(405, "Method not allowed");
    }
    const pipeline = storage();
    if (!pipeline) return fail(503, "Storage is not connected");

    let request;
    try {
      request = validatePost(readBody(req));
    } catch {
      return fail(400, "Invalid request");
    }
    try {
      if (request.kind === "token") await handleToken(pipeline, request);
      else await handlePurchase(pipeline, request);
    } catch {
      return fail(503, "Storage unavailable");
    }
    return res.status(204).end();
  };
}

export default createHandler();
