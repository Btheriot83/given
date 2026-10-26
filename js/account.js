/**
 * Named accounts on the web: an optional Sign in with Apple that saves the streak.
 * Play first, always. Signed out, stats stay in this browser exactly as before. Signed in,
 * the account (docs/accounts-api.md) is canonical: every finished daily posts to it and the
 * stats screen shows its numbers. Sign-in stays hidden until /api/config says the web
 * Services ID exists.
 */

const API = "/api/account";
const APPLE_JS = "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js";
const SNOOZE_MS = 7 * 24 * 3600 * 1000;
const MAX_LOCAL_RESULTS = 400;
const MAX_WORDS = 40;
const CANCELLED = new Set(["popup_closed_by_user", "user_cancelled_authorize", "user_trigger_new_signin_flow"]);

const APPLE_LOGO = '<svg class="apple-logo" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.37 1.43c0 1.14-.5 2.27-1.18 3.08-.74.9-1.99 1.57-2.99 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.57-2.27 1.2-2.98.8-.94 2.15-1.64 3.25-1.68.03.13.06.28.06.43zm4.56 15.71c-.03.07-.46 1.58-1.52 3.12-.94 1.34-1.94 2.71-3.43 2.71-1.52 0-1.9-.88-3.63-.88-1.7 0-2.3.91-3.67.91-1.38 0-2.33-1.26-3.43-2.8C4 18.38 2.96 15.57 2.96 12.92c0-4.28 2.8-6.55 5.55-6.55 1.45 0 2.68.95 3.6.95.87 0 2.22-1.01 3.9-1.01.62 0 2.89.06 4.38 2.19-.13.09-2.38 1.37-2.38 4.19 0 3.26 2.85 4.42 2.95 4.45z"/></svg>';

async function sha256hex(text) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.AppleID?.auth) return resolve();
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => (window.AppleID?.auth ? resolve() : reject(new Error("apple")));
    script.onerror = () => reject(new Error("apple"));
    document.head.append(script);
  });
}

export function createAccount({
  prefix,
  readStore,
  writeStore,
  toast,
  getStats,
  setStats,
  getFriends,
  setFriends,
  fetchImpl = (...args) => fetch(...args),
}) {
  const KEY = {
    session: `${prefix}:session`,
    account: `${prefix}:account`,
    snooze: `${prefix}:savePromptUntil`,
    pending: `${prefix}:accountPending`,
    deviceInstall: `${prefix}:deviceInstallId`,
    install: `${prefix}:installId`,
    played: `${prefix}:played`,
    past: `${prefix}:past`,
    daily: `${prefix}:daily`,
  };
  let config = null;
  let account = readStore(KEY.account, null);
  let busy = false;
  let last = { stub: null, game: null, mode: "" };
  const ui = {};

  const session = () => {
    const value = readStore(KEY.session, "");
    return typeof value === "string" && value.startsWith("nms_") ? value : "";
  };
  const signedIn = () => Boolean(session());
  const canSignIn = () => Boolean(config?.accounts && config?.apple?.web && config.apple.servicesId);
  const nick = () => account?.social?.nickname || "";

  async function api(path, { method = "GET", body, auth = true } = {}) {
    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth) headers.authorization = `Bearer ${session()}`;
    const response = await fetchImpl(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    const data = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && auth) dropSession();
      const error = new Error(data?.error || "Unavailable");
      error.status = response.status;
      error.code = data?.code;
      throw error;
    }
    return data;
  }

  // ---------------------------------------------------------- state

  /** Makes the account canonical on this device: stats, friends, played map, install ID. */
  function apply(next) {
    if (!next?.id) return;
    account = next;
    writeStore(KEY.account, { id: next.id, social: next.social, resultsId: next.resultsId });
    const s = next.stats;
    setStats({ played: s.played, wins: s.wins, streak: s.streak, maxStreak: s.maxStreak, lastDate: s.lastDate, dist: [...s.dist] });
    const friends = getFriends() || {};
    setFriends({
      group: next.social.groups[0] || friends.group || "",
      nickname: next.social.nickname || friends.nickname || "",
      playerId: next.social.boardId || friends.playerId || "",
    });
    const played = readStore(KEY.played, {}) || {};
    for (const r of next.results || []) played[r.dateKey] = r.score;
    writeStore(KEY.played, played);
    if (next.resultsId) writeStore(KEY.install, next.resultsId);
    paint();
  }

  function rememberDeviceInstall() {
    const current = readStore(KEY.install, "");
    if (!readStore(KEY.deviceInstall, "") && current) writeStore(KEY.deviceInstall, current);
  }

  /** Back to signed out. Stats stay on the device; the install ID goes back to this device's own (or a fresh one). */
  function dropSession({ fresh = false } = {}) {
    writeStore(KEY.session, "");
    writeStore(KEY.account, null);
    writeStore(KEY.pending, []);
    writeStore(KEY.install, fresh ? "" : readStore(KEY.deviceInstall, "") || "");
    writeStore(KEY.deviceInstall, "");
    account = null;
    paint();
  }

  /** Everything this browser knows, for the first-time merge. */
  function localPayload() {
    const played = readStore(KEY.played, {}) || {};
    const past = readStore(KEY.past, {}) || {};
    const daily = readStore(KEY.daily, null);
    const results = [];
    for (const [dateKey, raw] of Object.entries(played)) {
      const score = Number(raw);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !(score >= 1 && score <= 7)) continue;
      const today = daily?.puzzle?.dateKey === dateKey ? daily : null;
      const game = today || past[dateKey];
      results.push({
        dateKey,
        won: score < 7,
        guesses: score < 7 ? score : 6,
        archive: Boolean(past[dateKey] && !today),
        words: game && game.status !== "playing" && Array.isArray(game.guesses) ? game.guesses.map(String) : undefined,
      });
    }
    results.sort((a, b) => (a.dateKey < b.dateKey ? 1 : -1));
    results.forEach((r, i) => { if (i >= MAX_WORDS || !r.words?.length) delete r.words; });
    const friends = getFriends() || {};
    const installId = readStore(KEY.install, "");
    return {
      results: results.slice(0, MAX_LOCAL_RESULTS),
      stats: getStats(),
      nickname: friends.nickname || undefined,
      groups: friends.group ? [friends.group] : [],
      playerId: friends.playerId || undefined,
      installId: typeof installId === "string" && installId ? installId : undefined,
    };
  }

  // ---------------------------------------------------------- actions

  async function signIn() {
    if (busy || !canSignIn()) return;
    busy = true;
    paint();
    try {
      await loadScript(APPLE_JS);
      const { nonce } = await api(`${API}/nonce`, { method: "POST", auth: false });
      window.AppleID.auth.init({
        clientId: config.apple.servicesId,
        scope: config.apple.scope || "",
        redirectURI: config.apple.redirectURI,
        state: crypto.randomUUID(),
        nonce: await sha256hex(nonce),
        usePopup: true,
      });
      const reply = await window.AppleID.auth.signIn();
      const authorization = reply?.authorization;
      if (!authorization?.id_token) throw new Error("Sign in didn't finish");
      const data = await api(`${API}/apple`, {
        method: "POST",
        auth: false,
        body: { identityToken: authorization.id_token, nonce, platform: "web", authorizationCode: authorization.code, local: localPayload() },
      });
      rememberDeviceInstall();
      writeStore(KEY.session, data.session);
      apply(data.account);
      toast(data.created ? "Signed in. Your streak is saved." : "Signed in. Your stats are synced.", 3200);
    } catch (error) {
      if (!CANCELLED.has(error?.error)) toast("Sign in didn’t work. Try again.", 3200);
    } finally {
      busy = false;
      paint();
    }
  }

  async function signOut() {
    if (!signedIn()) return;
    try {
      await api(`${API}/logout`, { method: "POST" });
    } catch { /* the session ends locally either way */ }
    dropSession();
    toast("Signed out. Your stats stay on this device.", 3000);
  }

  async function deleteAccount() {
    if (!signedIn() || busy) return;
    const ok = window.confirm("Delete your Named account? Your stats on this device stay, but the account, its synced history and its friends-board entries are deleted. This can’t be undone.");
    if (!ok) return;
    busy = true;
    paint();
    try {
      await api(API, { method: "DELETE" });
      dropSession({ fresh: true });
      toast("Account deleted. Your stats on this device stay.", 3500);
    } catch (error) {
      if (error.status !== 401) toast("Couldn’t delete right now. Try again.", 3200);
    } finally {
      busy = false;
      paint();
    }
  }

  function queue(body) {
    const list = (readStore(KEY.pending, []) || []).filter((item) => item.dateKey !== body.dateKey);
    writeStore(KEY.pending, [...list, body].slice(-30));
  }

  function unqueue(dateKey) {
    const list = readStore(KEY.pending, []) || [];
    if (list.some((item) => item.dateKey === dateKey)) writeStore(KEY.pending, list.filter((item) => item.dateKey !== dateKey));
  }

  async function post(body) {
    try {
      const data = await api(`${API}/result`, { method: "POST", body });
      unqueue(body.dateKey);
      apply(data.account);
      if (data.froze?.length) toast("We saved your streak.", 3500);
    } catch (error) {
      if (error.status === 400) unqueue(body.dateKey);
      else if (error.status !== 401) queue(body);
    }
  }

  async function flushPending() {
    if (!signedIn()) return;
    for (const body of readStore(KEY.pending, []) || []) await post(body);
  }

  /** A finished numbered daily (today's or a past one). */
  function recordGame(game, archive) {
    if (!signedIn() || !game?.puzzle?.dateKey || game.puzzle.kind === "obscure" || game.status === "playing") return;
    post({ dateKey: game.puzzle.dateKey, guesses: game.guesses.map(String), archive: Boolean(archive) });
  }

  /** The friends board changed on this device: the account follows. */
  function syncFriends(friends) {
    if (!signedIn() || !friends?.group) return;
    const groups = [friends.group, ...(account?.social?.groups || []).filter((g) => g !== friends.group)].slice(0, 10);
    api(API, { method: "PATCH", body: { nickname: friends.nickname || null, groups } })
      .then((data) => {
        account = data.account;
        writeStore(KEY.account, { id: account.id, social: account.social, resultsId: account.resultsId });
        paint();
      })
      .catch(() => {});
  }

  // ---------------------------------------------------------- UI

  function el(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  const appleButton = (label = "Sign in with Apple") =>
    `<button class="apple-btn" type="button" data-account="signin">${APPLE_LOGO}<span>${label}</span></button>`;

  function build() {
    if (!document.querySelector('link[href$="css/account.css"]')) {
      document.head.append(el('<link rel="stylesheet" href="css/account.css" />'));
    }
    ui.prompt = el(`
      <section class="ticket account-ticket" id="savePrompt" aria-labelledby="savePromptTitle" hidden>
        <div class="ticket-face">
          <span class="prompt-kicker">Your stats</span>
          <h3 id="savePromptTitle">Save your streak.</h3>
          <p class="prompt-lead">Sign in free so your stats follow you to namedgame.com and any new phone.</p>
          <div class="account-actions">${appleButton()}<button class="text-link account-later" type="button" data-account="later">Not now</button></div>
        </div>
      </section>`);
    ui.line = el('<p class="account-line" id="accountLine" hidden></p>');
    ui.settings = el(`
      <div class="account-settings" id="accountSettings" hidden>
        <div class="settings-row">
          <div><h3>Account</h3><p data-account-text></p></div>
          <button class="brass-btn small-btn" type="button" data-account="signout">Sign out</button>
        </div>
        <div class="account-signin">${appleButton()}</div>
        <button class="text-link account-delete" type="button" data-account="delete">Delete account</button>
      </div>`);
    const rank = document.getElementById("overallRank");
    if (rank) rank.after(ui.line);
    const settingsBody = document.querySelector("#settingsOverlay .sheet-body");
    if (settingsBody) settingsBody.append(ui.settings);
    document.addEventListener("click", (event) => {
      const target = event.target.closest?.("[data-account]");
      if (!target) return;
      const action = target.dataset.account;
      if (action === "signin") signIn();
      else if (action === "signout") signOut();
      else if (action === "delete") deleteAccount();
      else if (action === "later") {
        writeStore(KEY.snooze, Date.now() + SNOOZE_MS);
        paint();
      }
    });
  }

  function paint() {
    if (!ui.line) return;
    const inside = signedIn();
    const offer = !inside && canSignIn();
    for (const button of document.querySelectorAll('[data-account="signin"]')) button.disabled = busy;

    // Stats: "Signed in as …" or "Save your stats".
    ui.line.hidden = !inside && !offer;
    if (inside) {
      ui.line.textContent = nick() ? `Signed in as ${nick()}` : "Signed in with Apple";
      ui.line.dataset.state = "in";
    } else if (offer) {
      ui.line.replaceChildren(el(appleButton("Save your stats")));
      ui.line.dataset.state = "out";
    }

    // Settings: sign out and delete, or sign in.
    ui.settings.hidden = !inside && !offer;
    ui.settings.querySelector("[data-account-text]").textContent = inside
      ? `Signed in with Apple${nick() ? ` as ${nick()}` : ""}. Your streak and stats follow you to every device you sign in on.`
      : "Sign in free so your stats follow you to namedgame.com and any new phone.";
    ui.settings.querySelector('[data-account="signout"]').hidden = !inside;
    ui.settings.querySelector(".account-signin").hidden = inside;
    ui.settings.querySelector('[data-account="delete"]').hidden = !inside;
    ui.settings.querySelector('[data-account="delete"]').disabled = busy;

    paintPrompt(last.stub, last.game, last.mode);
  }

  /** The soft prompt on a finished official daily. Never a wall: "Not now" hides it for 7 days. */
  function paintPrompt(stub, game, mode) {
    last = { stub, game, mode };
    if (!ui.prompt || !stub) return;
    if (ui.prompt.parentElement !== stub) {
      const anchor = stub.querySelector("#vsCard");
      if (anchor) anchor.before(ui.prompt);
      else stub.append(ui.prompt);
    }
    const snoozed = Number(readStore(KEY.snooze, 0)) > Date.now();
    const finishedDaily = mode === "daily" && game?.puzzle?.dateKey && game.puzzle.kind !== "obscure" && game.status !== "playing";
    ui.prompt.hidden = !(finishedDaily && !signedIn() && canSignIn() && !snoozed);
  }

  async function init() {
    build();
    paint();
    try {
      const response = await fetchImpl("/api/config", { cache: "no-store" });
      config = response.ok ? await response.json() : null;
    } catch {
      config = null;
    }
    paint();
    if (signedIn()) {
      try {
        const data = await api(API);
        apply(data.account);
        await flushPending();
      } catch { /* offline: keep the last known stats */ }
    }
    window.addEventListener("online", flushPending);
  }

  return { init, recordGame, syncFriends, paintPrompt, paint, signedIn, signIn, signOut, deleteAccount, localPayload };
}
