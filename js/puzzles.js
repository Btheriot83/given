/**
 * Numbered puzzles on the web: the Daily #N list, the free past-puzzle allowance,
 * "You vs everyone" from /api/results, and the finish-moment ribbons.
 * app.js owns the game loop and calls into this module through a few hooks.
 */
import { HISTORY_START_DATE, puzzleNumber, shiftDateKey, MAX_GUESSES } from "./engine.js";

export const FREE_PAST_PER_DAY = 3;
export const FREE_PAST_WINDOW_DAYS = 7;
export const STREAK_MILESTONES = Object.freeze([3, 5, 7, 10, 14, 21, 30, 50, 100]);
export const APP_STORE_URL = "https://apps.apple.com/app/id6817123058";
const LOSS = MAX_GUESSES + 1;

/** Pure: is this past date free to start today? */
export function freeWindowAllows(dateKey, today) {
  return dateKey < today && dateKey >= shiftDateKey(today, -FREE_PAST_WINDOW_DAYS);
}

/** Pure: the finish ribbon and how big the celebration is. */
export function finishMoment({ won, guesses, daily, streak = 0, prevMax = 0 }) {
  const milestone = daily && won && STREAK_MILESTONES.includes(streak);
  const newBest = daily && won && streak > prevMax && prevMax > 0;
  const quick = won && guesses <= 2;
  const lines = [];
  if (milestone) lines.push(`${streak} days in a row!`);
  if (newBest) lines.push("New best streak!");
  if (quick && lines.length) lines.push(guesses === 1 ? "In one!" : "In two!");
  else if (quick) lines.push(guesses === 1 ? "First guess. Named on sight!" : "Two guesses. Sharp eyes!");
  const level = milestone ? "milestone" : quick ? "quick" : newBest ? "best" : won ? "win" : "none";
  return { level, ribbon: lines.slice(0, 2).join(" · "), big: milestone || quick || newBest };
}

const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

/** Pure: coerces a server summary to plain numbers so it is safe to print. */
export function cleanSummary(raw) {
  if (!raw || typeof raw !== "object") return null;
  const dist = Array.from({ length: MAX_GUESSES }, (_, i) => int(raw.dist?.[i]));
  const you = raw.you && typeof raw.you === "object"
    ? { score: int(raw.you.score), betterThan: int(raw.you.betterThan), tiedWith: int(raw.you.tiedWith) }
    : null;
  const o = raw.overall;
  const overall = o && typeof o === "object"
    ? { played: int(o.played), wins: int(o.wins), average: num(o.average), percentile: num(o.percentile), rankedPlayers: num(o.rankedPlayers) }
    : null;
  return { number: int(raw.number), players: int(raw.players), solveRate: int(raw.solveRate), dist, failed: int(raw.failed), you, overall };
}

/** Pure: the "You vs everyone" headline, word for word as the iPhone (GlobalStats.headline). */
export function vsHeadline(summary) {
  const you = summary?.you;
  if (!you || summary.players < 2) return null;
  if (you.score === LOSS) return `${summary.solveRate}% of ${summary.players.toLocaleString("en-US")} players solved it`;
  if (you.betterThan >= 50) return `Better than ${you.betterThan}% of players`;
  return `You and ${Math.max(1, you.tiedWith)}% of players got it in ${you.score}`;
}

/** Pure: the overall rank line, word for word as the iPhone (GlobalStats.rankLine). */
export function rankLine(overall) {
  const o = overall || { played: 0 };
  if (o.percentile == null || o.average == null) {
    const left = Math.max(0, 3 - (o.played || 0));
    return `Play ${left} more ${left === 1 ? "puzzle" : "puzzles"} to get ranked`;
  }
  if (o.percentile < 50) return `Average ${o.average.toFixed(1)} over ${o.played} puzzles · keep playing to climb`;
  return `Better than ${o.percentile}% of players · average ${o.average.toFixed(1)} over ${o.played} puzzles`;
}

/** Pure: the free-tier line, as the iPhone's Program sheet. */
export function freeLine(left) {
  return `${left} of ${FREE_PAST_PER_DAY} free today, from the last week`;
}

export function createPuzzles({ prefix, readStore, writeStore, toast, fetchImpl = (...a) => fetch(...a) }) {
  const KEY = {
    played: `${prefix}:played`,
    past: `${prefix}:past`,
    free: `${prefix}:pastFree`,
    install: `${prefix}:installId`,
    pending: `${prefix}:pendingResults`,
    vs: `${prefix}:vs`,
    overall: `${prefix}:overall`,
  };
  let vsRequest = 0;

  const played = () => readStore(KEY.played, {}) || {};
  const pastGames = () => readStore(KEY.past, {}) || {};

  function installId() {
    let id = readStore(KEY.install, "");
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) {
      id = (crypto.randomUUID?.() || fallbackUuid()).toLowerCase();
      writeStore(KEY.install, id);
    }
    return id;
  }

  function fallbackUuid() {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  function freeState(today) {
    const s = readStore(KEY.free, null);
    return s && s.day === today && Array.isArray(s.used) ? s : { day: today, used: [] };
  }

  function freeLeft(today) {
    return Math.max(0, FREE_PAST_PER_DAY - freeState(today).used.length);
  }

  /** Status of one number: today | solved | missed | playing | unplayed | locked. */
  function status(dateKey, today, todayGame) {
    if (dateKey === today) {
      if (todayGame && todayGame.status !== "playing") return { kind: todayGame.status === "won" ? "solved" : "missed", score: todayGame.status === "won" ? todayGame.guesses.length : LOSS, today: true };
      return { kind: "today", today: true };
    }
    const score = Number(played()[dateKey]);
    if (score >= 1 && score <= MAX_GUESSES) return { kind: "solved", score };
    if (score === LOSS) return { kind: "missed", score };
    const saved = pastGames()[dateKey];
    if (saved?.guesses?.length || freeState(today).used.includes(dateKey)) return { kind: "playing", guesses: saved?.guesses?.length || 0 };
    if (freeWindowAllows(dateKey, today) && freeLeft(today) > 0) return { kind: "unplayed" };
    return { kind: "locked", reason: freeWindowAllows(dateKey, today) ? "limit" : "old" };
  }

  /** Claims a free slot if this past puzzle needs one. Returns false when it is locked. */
  function claim(dateKey, today) {
    const s = status(dateKey, today);
    if (s.kind === "locked") return false;
    if (s.kind === "unplayed") {
      const free = freeState(today);
      free.used = [...free.used, dateKey];
      writeStore(KEY.free, free);
    }
    return true;
  }

  /** The most recent past number that is free to play right now (not finished, not locked). */
  function nextPast(today) {
    for (let d = shiftDateKey(today, -1); d >= HISTORY_START_DATE && d >= shiftDateKey(today, -FREE_PAST_WINDOW_DAYS); d = shiftDateKey(d, -1)) {
      const k = status(d, today).kind;
      if (k === "unplayed" || k === "playing") return d;
    }
    return null;
  }

  function loadPast(dateKey) {
    return pastGames()[dateKey] || null;
  }

  function savePast(game) {
    const all = pastGames();
    all[game.puzzle.dateKey] = game;
    // Keep the archive small: the 40 most recent numbers are plenty to revisit a result card.
    for (const key of Object.keys(all).sort().reverse().slice(40)) delete all[key];
    writeStore(KEY.past, all);
  }

  function recordPlayed(dateKey, score) {
    const map = played();
    if (map[dateKey]) return false;
    map[dateKey] = score;
    writeStore(KEY.played, map);
    return true;
  }

  /** Remembers a finished numbered daily (today's or a past one) and sends it to /api/results. */
  function recordResult(game) {
    if (!game?.puzzle?.dateKey || game.puzzle.kind === "obscure" || game.status === "playing") return null;
    const score = game.status === "won" ? game.guesses.length : LOSS;
    recordPlayed(game.puzzle.dateKey, score);
    const number = puzzleNumber(game.puzzle.dateKey);
    const cached = cleanSummary(vsCache()[number]);
    if (cached?.you) return Promise.resolve(cached);
    return post({ installId: installId(), dateKey: game.puzzle.dateKey, guesses: game.guesses });
  }

  function vsCache() {
    return readStore(KEY.vs, {}) || {};
  }

  function remember(raw) {
    const summary = cleanSummary(raw);
    if (!summary?.number) return summary;
    const cache = vsCache();
    cache[summary.number] = { ...summary, at: Date.now() };
    const numbers = Object.keys(cache).map(Number).sort((a, b) => b - a);
    for (const n of numbers.slice(60)) delete cache[n];
    writeStore(KEY.vs, cache);
    if (summary.overall) writeStore(KEY.overall, summary.overall);
    return summary;
  }

  async function post(body) {
    try {
      const response = await fetchImpl("/api/results", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 400) return null; // never valid; don't retry
      if (!response.ok) throw new Error(data.error || "Unavailable");
      dropPending(body.dateKey);
      return remember(data);
    } catch {
      queuePending(body);
      return null;
    }
  }

  function queuePending(body) {
    const list = (readStore(KEY.pending, []) || []).filter((item) => item.dateKey !== body.dateKey);
    writeStore(KEY.pending, [...list, body].slice(-30));
  }

  function dropPending(dateKey) {
    const list = readStore(KEY.pending, []) || [];
    if (list.some((item) => item.dateKey === dateKey)) writeStore(KEY.pending, list.filter((item) => item.dateKey !== dateKey));
  }

  async function flushPending() {
    const list = readStore(KEY.pending, []) || [];
    for (const body of list) await post(body);
  }

  async function fetchSummary(number) {
    const id = readStore(KEY.install, "");
    const query = id ? `&installId=${encodeURIComponent(id)}` : "";
    const response = await fetchImpl(`/api/results?number=${number}${query}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Unavailable");
    return remember(await response.json());
  }

  /** Paints the "You vs everyone" ticket for a finished numbered game. */
  async function paintVs(card, game) {
    const numbered = game?.puzzle?.dateKey && game.puzzle.kind !== "obscure" && game.status !== "playing";
    card.hidden = !numbered;
    if (!numbered) return;
    const token = ++vsRequest;
    const number = puzzleNumber(game.puzzle.dateKey);
    const cached = cleanSummary(vsCache()[number]);
    const score = game.status === "won" ? game.guesses.length : LOSS;
    if (cached?.you) renderVs(card, cached, score);
    else renderVsState(card, number, "loading");
    let summary = null;
    try {
      summary = cached?.you ? await fetchSummary(number) : await recordResult(game);
      if (!summary?.you && !cached?.you) summary = await fetchSummary(number);
    } catch {
      summary = null;
    }
    if (token !== vsRequest) return;
    if (summary?.you) renderVs(card, summary, score);
    else if (!cached?.you) renderVsState(card, number, navigator.onLine === false ? "offline" : "error");
  }

  function renderVsState(card, number, state) {
    const copy = {
      loading: ["Counting the house…", "Comparing your score with everyone who played this number."],
      offline: ["You’re offline", "Your result is saved. We’ll compare it with everyone as soon as you’re back."],
      error: ["The box office is busy", "Your result is saved. We’ll add it to the house count next time you open Named."],
    }[state];
    card.dataset.state = state;
    card.dataset.number = String(number);
    card.innerHTML = `<div class="ticket-face">
      <span class="vs-kicker">You vs everyone · #${number}</span>
      <strong class="vs-head">${copy[0]}</strong>
      <p class="vs-sub">${copy[1]}</p>
    </div>`;
  }

  function renderVs(card, summary, score) {
    if (!summary.you) return renderVsState(card, summary.number, "error");
    const head = vsHeadline(summary) || `You’re the first to finish #${summary.number}`;
    const sub = summary.players < 2 ? "Check back later to see how everyone else does." : "";
    const counts = [...summary.dist, summary.failed];
    const max = Math.max(1, ...counts);
    const yours = (summary.you?.score ?? score) - 1;
    const bars = counts.map((count, i) => {
      const pct = summary.players ? Math.round((100 * count) / summary.players) : 0;
      const label = i === MAX_GUESSES ? "X" : String(i + 1);
      const mine = i === yours;
      return `<div class="vs-bar${mine ? " mine" : ""}" role="listitem" aria-label="${label === "X" ? "Missed" : `${label} guess${label === "1" ? "" : "es"}`}: ${pct}%${mine ? " (you)" : ""}">
        <span class="vs-fill" style="height:${Math.max(4, (100 * count) / max)}%"><i>${pct}%</i></span>
        <b>${label}</b>
      </div>`;
    }).join("");
    card.dataset.anim = card.dataset.state === "ready" && card.dataset.number === String(summary.number) ? "off" : "on";
    card.dataset.state = "ready";
    card.dataset.number = String(summary.number);
    card.innerHTML = `<div class="ticket-face">
      <span class="vs-kicker">You vs everyone · #${summary.number}</span>
      <strong class="vs-head">${head}</strong>
      ${sub ? `<p class="vs-sub">${sub}</p>` : ""}
      <div class="vs-chart" role="list" aria-label="How everyone did">${bars}</div>
      <p class="vs-foot"><span>Solve rate <b>${summary.solveRate}%</b></span><span><b>${summary.players.toLocaleString()}</b> player${summary.players === 1 ? "" : "s"}</span></p>
    </div>`;
  }

  /** Paints the overall rank line on the stats screen, then refreshes it from the server. */
  async function paintRank(el, today) {
    el.textContent = rankLine(cleanSummary({ overall: readStore(KEY.overall, null) })?.overall);
    if (!readStore(KEY.install, "")) return;
    try {
      const summary = await fetchSummary(puzzleNumber(today));
      el.textContent = rankLine(summary.overall);
    } catch {
      /* keep the cached line */
    }
  }

  /** Paints the Daily #N list, newest first. */
  function renderList(list, { today, todayGame, onPlay, onLocked, bonus, onBonus }) {
    list.replaceChildren();
    const extras = document.createElement("div");
    extras.className = "puzzles-extras";
    extras.append(
      extraRow({ title: "Bonus name", detail: BONUS_DETAIL, kind: bonus?.kind || "unplayed", label: bonus?.label || "Play", onClick: onBonus }),
      extraRow({ title: "Long name", detail: LONG_DETAIL, kind: "locked", label: "Named+", onClick: () => onLocked(null, "long") }),
    );
    list.append(extras);
    const left = freeLeft(today);
    const info = document.createElement("div");
    info.className = "puzzles-free";
    info.innerHTML = `<b>${freeLine(left)}</b><span>Past puzzles from the last ${FREE_PAST_WINDOW_DAYS} days. Today’s daily is always free.</span>`;
    list.append(info);
    let lockPlaced = false;
    for (let d = today; d >= HISTORY_START_DATE; d = shiftDateKey(d, -1)) {
      const s = status(d, today, todayGame);
      if (s.kind === "locked" && !lockPlaced) {
        list.append(lockCard());
        lockPlaced = true;
      }
      const row = document.createElement("button");
      row.type = "button";
      row.className = "puzzle-row";
      row.dataset.kind = s.kind;
      const n = puzzleNumber(d);
      const label = { today: "Play", solved: `Solved in ${s.score}`, missed: "Missed", playing: "In progress", unplayed: "Play", locked: "Named+" }[s.kind];
      row.innerHTML = `<span class="pr-num">#${n}</span><span class="pr-date">${dayLabel(d, today)}</span><span class="pr-status">${s.kind === "locked" ? LOCK_SVG : ""}${label}</span>`;
      row.setAttribute("aria-label", `Daily #${n}, ${dayLabel(d, today)}: ${s.kind === "locked" ? "locked, Named+ on iPhone" : label}`);
      row.onclick = () => (s.kind === "locked" ? onLocked(d, s.reason) : onPlay(d));
      list.append(row);
    }
  }

  function extraRow({ title, detail, kind, label, onClick }) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "puzzle-row extra-row";
    row.dataset.kind = kind;
    row.innerHTML = `<span class="pr-extra"><b>${title}</b><span>${detail}</span></span><span class="pr-status">${kind === "locked" ? LOCK_SVG : ""}${label}</span>`;
    row.setAttribute("aria-label", `${title}: ${detail}. ${kind === "locked" ? "Locked, Named+ on iPhone" : label}`);
    row.onclick = onClick;
    return row;
  }

  function lockCard() {
    const lock = document.createElement("aside");
    lock.className = "puzzles-lock";
    lock.id = "puzzlesLock";
    lock.innerHTML = `${LOCK_SVG}<strong>Every number, any day</strong>
      <p>Named+ unlocks the whole archive with no daily limit, plus the Long name every day. It lives in the Named iPhone app.</p>
      <a class="brass-btn" href="${APP_STORE_URL}" target="_blank" rel="noopener">Get Named for iPhone</a>`;
    return lock;
  }

  function lockMessage(reason) {
    if (reason === "long") return "The Long name is a Named+ extra: a seven-letter name every day, in the Named iPhone app.";
    return reason === "limit"
      ? "That’s your 3 free past puzzles for today. More at midnight, or every number with Named+ on iPhone."
      : `Free past puzzles go back ${FREE_PAST_WINDOW_DAYS} days. Older numbers come with Named+ on iPhone.`;
  }

  /** A burst of gold streamers for the big moments. */
  function burst(moment, reduced) {
    if (!moment?.big || reduced) return;
    const layer = document.createElement("div");
    layer.className = `puzzles-burst ${moment.level}`;
    layer.setAttribute("aria-hidden", "true");
    const count = moment.level === "milestone" ? 44 : 30;
    for (let i = 0; i < count; i++) {
      const piece = document.createElement("i");
      piece.style.setProperty("--x", `${(Math.random() * 100).toFixed(1)}vw`);
      piece.style.setProperty("--d", `${(Math.random() * 0.9).toFixed(2)}s`);
      piece.style.setProperty("--t", `${(2.4 + Math.random() * 1.6).toFixed(2)}s`);
      piece.style.setProperty("--r", `${Math.round(Math.random() * 720 - 360)}deg`);
      piece.style.setProperty("--dx", `${Math.round(Math.random() * 80 - 40)}px`);
      piece.style.setProperty("--s", `${(0.7 + Math.random() * 0.7).toFixed(2)}`);
      piece.dataset.c = String(i % 4);
      layer.append(piece);
    }
    document.body.append(layer);
    setTimeout(() => layer.remove(), 5200);
  }

  return {
    installId, freeLeft, status, claim, nextPast, loadPast, savePast, recordPlayed, recordResult,
    flushPending, paintVs, paintRank, renderList, lockMessage, burst, toast,
  };
}

export const BONUS_DETAIL = "A rarer five-letter name, new every midnight";
export const LONG_DETAIL = "A seven-letter name, new every day (the tough one)";

export function dayLabel(dateKey, today) {
  if (dateKey === today) return "Today";
  if (dateKey === shiftDateKey(today, -1)) return "Yesterday";
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

const LOCK_SVG = '<svg class="lock" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 10V7.5a5 5 0 0 1 10 0V10h1a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 18 21H6a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 6 10zm2.2 0h5.6V7.5a2.8 2.8 0 0 0-5.6 0z"/></svg>';
