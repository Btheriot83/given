import names from "../data/names.json" with { type: "json" };
import answerPools from "../data/answer-pools.json" with { type: "json" };
import { normalizeGroup, rankEntries, validDateKey, validateResult } from "../js/leaderboard-core.js";

const url = process.env.KV_REST_API_URL;
const token = process.env.KV_REST_API_TOKEN;

async function redis(...command) {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error("Leaderboard storage unavailable");
  const payload = await response.json();
  if (payload.error) throw new Error("Leaderboard storage unavailable");
  return payload.result;
}

function send(res, status, data) {
  res.status(status).setHeader("Cache-Control", "no-store").json(data);
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
  if (!url || !token) return send(res, 503, { error: "Friends board is not connected yet" });
  try {
    if (req.method === "GET") {
      const group = normalizeGroup(req.query.group);
      const dateKey = req.query.dateKey;
      if (!group || !validDateKey(dateKey)) return send(res, 400, { error: "Invalid group or day" });
      const raw = await redis("HGETALL", `given:board:${group}:${dateKey}`);
      const entries = [];
      for (let i = 0; i < (raw?.length || 0); i += 2) {
        try { entries.push(JSON.parse(raw[i + 1])); } catch { /* ignore corrupt entry */ }
      }
      return send(res, 200, { group, dateKey, entries: rankEntries(entries) });
    }
    const length = Number(req.headers["content-length"] || 0);
    if (length > 2048) return send(res, 413, { error: "Result too large" });
    const result = validateResult(req.body, { ...names, familiarAnswers: answerPools.familiar });
    const key = `given:board:${result.group}:${result.dateKey}`;
    const count = await redis("HLEN", key);
    if (Number(count) >= 50) return send(res, 409, { error: "This group is full for today" });
    const entry = { nickname: result.nickname, score: result.score, createdAt: Date.now() };
    const inserted = await redis("HSETNX", key, result.playerId, JSON.stringify(entry));
    if (Number(inserted) === 1) await redis("EXPIRE", key, 90 * 24 * 3600);
    return send(res, 200, { saved: Number(inserted) === 1 });
  } catch (error) {
    const known = /^(Invalid|Nickname|Finish)/.test(error.message);
    return send(res, known ? 400 : 503, { error: known ? error.message : "Friends board unavailable right now" });
  }
}
