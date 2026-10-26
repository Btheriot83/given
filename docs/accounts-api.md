# Named accounts API (Sign in with Apple)

Server: `https://namedgame.com`, one Vercel function (`api/account.js`) on the same Upstash
Redis as the friends board and `/api/results`. This file is the full contract: the iPhone
client is built from it alone.

## The model ("how Wordle does it")

- **Play first, always.** There is no sign-in wall anywhere. Every screen works signed out.
- **Signed out:** stats stay on the device exactly as today.
- **Soft prompt:** after the player's first finished official daily on this device, the result
  screen shows:
  > **Save your streak.** Sign in free so your stats follow you to namedgame.com and any new phone.
  >
  > [Sign in with Apple] [Not now]

  "Not now" hides the prompt for 7 days (store the dismissal time on the device). The prompt
  never shows while signed in.
- **Stats screen:** always shows one small line: `Signed in as <nickname or "your Apple ID">`
  with a "Sign out" action in Settings, or a "Save your stats" button that starts sign-in.
- **Signed in:** the account holds the canonical record (per-date results, streak, max
  streak, guess distribution, clean wins, streak freezes, nickname, friends groups). The first
  sign-in merges the device's local history into the account. Every later finished official
  daily (today's or a past number) is posted to the account, and the stats screens show the
  account's numbers.
- **Settings → Delete account** deletes everything server-side (App Store rule 5.1.1(v)).

## Conventions

- JSON in and out. Request bodies are at most 64 KB for `POST /api/account/apple` and 4 KB
  everywhere else.
- Auth: `Authorization: Bearer <session>` where `<session>` is the token returned by sign-in.
  iOS keeps it in the Keychain (`kSecAttrAccessibleAfterFirstUnlock`); the web keeps it in
  `localStorage` under `given-v2:session`. No cookies.
- Every response has `Cache-Control: no-store`.
- Dates are `YYYY-MM-DD` date keys in the player's local calendar (the same keys the game uses).
- Scores: `1`–`6` for a win in that many guesses, `7` for a loss (shown as X), as in `/api/results`.
- Errors are always `{ "error": "Human readable message", "code": "machine_code" }`:

| HTTP | code | Meaning | Client action |
|---|---|---|---|
| 400 | `bad_request` | Malformed body, bad date, invalid guesses, failed replay | Don't retry. Drop the item. |
| 401 | `unauthorized` | Missing, unknown or expired session | Treat as signed out: delete the stored session, keep local stats, show "Save your stats". |
| 401 | `invalid_token` | Apple identity token failed verification (signature, issuer, audience, expiry) | Show "Sign in didn't work. Try again." |
| 401 | `invalid_nonce` | Nonce unknown, expired, already used, or doesn't match the token | Fetch a new nonce and sign in again. |
| 404 | `not_found` | Unknown action | — |
| 405 | `method_not_allowed` | Wrong method | — |
| 413 | `too_large` | Body over the limit | Send fewer local results (newest first). |
| 429 | `rate_limited` | Too many requests | Retry after the `Retry-After` seconds. |
| 503 | `unavailable` | Storage down, Apple unreachable, or a concurrent write held the account | Retry later with backoff (queue result posts). |
| 503 | `not_configured` | Storage not connected | Hide account UI. |

## Endpoints

### `GET /api/config`
Public configuration. No auth. Cached by clients for the session.
```json
{
  "accounts": true,
  "apple": {
    "web": false,
    "servicesId": null,
    "redirectURI": "https://namedgame.com/",
    "scope": ""
  }
}
```
- `accounts`: false when storage isn't connected (hide all account UI).
- `apple.web`: true only once the `APPLE_SERVICES_ID` env var exists. The web hides its Sign in
  with Apple button until then. iOS ignores `apple.*` (native sign-in always works).

### `POST /api/account/nonce`
No auth, empty body. Returns a single-use nonce valid for 10 minutes.
```json
{ "nonce": "Jx4…43 base64url chars", "expiresIn": 600 }
```
Pass **`sha256hex(nonce)`** (lowercase hex of the SHA-256 of the UTF-8 nonce) to Apple
(`ASAuthorizationAppleIDRequest.nonce` on iOS, `nonce` in `AppleID.auth.init` on the web), then
send the **raw** `nonce` to `/api/account/apple`. Unused nonces expire after 10 minutes. Rate
limit: 600 nonces per minute across all clients (429 with `Retry-After: 60` above that).

### `POST /api/account/apple`: sign in (and first-time merge)
No auth. Request:
```json
{
  "identityToken": "eyJraWQiOi…",
  "nonce": "the raw nonce from /api/account/nonce",
  "platform": "ios",
  "authorizationCode": "c1a2…",
  "local": {
    "results": [
      { "dateKey": "2026-10-23", "guesses": 4, "won": true, "archive": false },
      { "dateKey": "2026-10-24", "guesses": 6, "won": false, "words": ["CHARLES", "PAULINE", "…"] }
    ],
    "stats": { "played": 31, "wins": 29, "streak": 12, "maxStreak": 14, "lastDate": "2026-10-24",
               "dist": [0, 2, 9, 11, 6, 1], "cleanWins": 27 },
    "freezes": { "used": { "2026-W43": 1 } },
    "nickname": "Bran",
    "groups": ["K7P2QX9M"],
    "playerId": "the device's friends-board player UUID",
    "installId": "the device's /api/results install UUID"
  }
}
```
- `identityToken` (required): the JWT from Apple. Request **no scopes** (`requestedScopes = []`
  on iOS, `scope: ""` on the web). The server verifies it against Apple's JWKS
  (`https://appleid.apple.com/auth/keys`): RS256 signature by a current Apple key, `iss` =
  `https://appleid.apple.com`, `aud` is `com.theriot.named` (iOS) or the web Services ID,
  `exp` in the future (60 s skew), and `nonce` = `sha256hex(nonce)`.
- `nonce` (required): the raw nonce. Single use.
- `platform` (required): `"ios"` or `"web"`.
- `authorizationCode` (optional, recommended): Apple's one-time authorization code (UTF-8 string
  of `credential.authorizationCode` on iOS; `authorization.code` on the web). When the Sign in
  with Apple key is configured on the server, the server exchanges it for a refresh token so it
  can revoke the Apple grant if the account is deleted. Ignored otherwise.
- `local` (optional): everything on this device, sent on **every** sign-in (first or not). Limits:
  `results` ≤ 1000 items (send newest first if trimming), `groups` ≤ 10.
  - `results[]`: official daily results only (not the Bonus name or Long name).
    - `dateKey`: 2026-01-01 … server tomorrow.
    - `guesses`: guess count 1–6 (for a loss send 6).
    - `won`: boolean.
    - `archive`: true if it was a past-number replay rather than that day's daily. Default false.
    - `words` (optional): the actual guesses. When present the server replays them and the
      result is stored as verified (the score comes from the replay) and also feeds "you vs
      everyone" (for dates from 2026-09-26). Results without `words` are stored unverified: they
      count toward the account's own stats but never toward "you vs everyone" or friends boards.
      Only send words you still have; a failed replay just stores the result unverified.
  - `stats`: the device's aggregate stats (the same fields the app already keeps). Used so
    history from before per-date records existed is not lost (see merge rules).
  - `freezes.used`: the iOS streak-freeze ledger, ISO week → freezes used.
  - `nickname`, `groups`, `playerId`: the friends-board membership (iOS has one group; send it
    as a one-item list).
  - `installId`: the device's `/api/results` install ID. Its "you vs everyone" history is moved
    to the account so the rank follows the person, not the device.

Response 200:
```json
{
  "session": "nms_Qk3…43 chars",
  "created": true,
  "merged": { "added": 31, "kept": 0 },
  "account": { "…": "the account object below" }
}
```
- `created`: true if this Apple ID had no account yet.
- `merged.added`: local results that were new to the account. `merged.kept`: local results for
  dates the account already had (the account's result was kept).
- After success the client must **replace** its local stats, results map, freezes and friends
  membership with the returned account (the account is now canonical), and switch the install
  ID it uses for `/api/results` GETs to `account.resultsId`.
- Rate limit: 20 sign-ins per Apple ID per hour.

### `GET /api/account`
Auth required. Query: optional `resultsSince=YYYY-MM-DD` to return only results on or after a
date (the stats are always complete). Response 200: `{ "account": { … } }`.
Refresh on app launch/foreground and when opening Stats. Every authenticated call refreshes the
session's 1-year expiry.

### `POST /api/account/result`: record one finished official daily
Auth required. Request:
```json
{ "dateKey": "2026-10-25", "guesses": ["CHARLES", "PAULINE"], "archive": false, "clean": true, "plus": false }
```
- `guesses` (required): the submitted guesses, replayed against `pickDailyPuzzle(dateKey)`
  exactly as `/api/results` does (`replayDaily` in `js/leaderboard-core.js`). The game must be
  finished. `dateKey` must be between `HISTORY_START_DATE` (2026-09-26) and the server's tomorrow.
- `archive`: true for a past-number replay. The server also treats any date outside the
  friends-board window (more than 36 hours from the date's noon UTC) as archive.
- `clean` (iOS): false if clues were used. Counts toward `stats.cleanWins` on a win. Default true.
- `plus`: whether Named+ is unlocked (2 streak freezes a week instead of 1). Stored as
  `account.plus`.
- **First finished result per date wins.** A repeat for the same date returns 200 with
  `"duplicate": true` and the account unchanged.
- Response 200:
```json
{ "saved": true, "duplicate": false, "froze": [], "account": { "…": "…" }, "vs": { "…": "the /api/results summary" } }
```
  - `froze`: days a streak freeze was used for while recording this result (see freezes).
    When non-empty, show "We saved your streak."
  - `vs`: the "you vs everyone" summary for this number (exact `/api/results` GET shape), or
    null if it couldn't be computed. Clients signed in no longer need to `POST /api/results`
    themselves; the account feeds it.
- Side effects (verified results only):
  - Feeds `/api/results` under `account.resultsId`.
  - On-day results with a nickname set are posted to every one of the account's friends groups
    with `account.social.boardId` as the board player ID (same rules as `/api/leaderboard`:
    first entry per player per day wins, 50 entries per group per day, 90-day expiry).
- Offline: queue the post and retry later (same as the iOS `/api/results` queue). Retrying is
  safe: duplicates are ignored.
- Rate limit: 60 writes per account per hour (shared by result, freeze and PATCH).

### `POST /api/account/freeze`: use streak freezes for missed days
Auth required. Call on launch, at local midnight and when Named+ unlocks (where iOS calls
`applyStreakFreezes` today). Request:
```json
{ "today": "2026-10-25", "plus": true }
```
- `today`: the device's local date key (must be within 36 hours of the server's clock).
- Missed days = from the day after `stats.lastDate` through `today - 1`, when `stats.streak > 0`.
  All of them are covered with freezes from each day's ISO week (1 per week, 2 with Named+), or
  none are (same as `StreakFreeze.cover`).
- Response 200: `{ "saved": true, "froze": ["2026-10-23"], "account": { … } }`. `saved` false
  when nothing was missed or the streak can't be saved.

### `PATCH /api/account`: nickname and friends groups
Auth required. Any subset of:
```json
{ "nickname": "Bran", "groups": ["K7P2QX9M", "Q4ZR8T2W"] }
```
- `nickname`: 2–20 characters of letters, digits, space, `_ . ' -` (the friends-board rule), or
  null to clear.
- `groups`: the full list (replaces the old one), most recent first, ≤ 10 eight-character codes
  (`A–H J–N P–Z 2–9`). A client with one active board uses `groups[0]` and sends
  `[newCode, ...oldGroups]` when the player joins another board.
- Response 200: `{ "account": { … } }`.

### `POST /api/account/logout`
Auth required. Deletes this session only. Response 204. The client deletes the stored token,
**keeps the account's last stats as local stats** (so the screen doesn't empty), and goes back to
its own install ID.

### `DELETE /api/account`: delete the account
Auth required. Optional body: `{ "authorizationCode": "…" }` (a fresh code from a new Sign in
with Apple, if the app re-authenticates before deleting, which Apple recommends).
- Deletes: the account record, every per-date result, the Apple ID link, every session, the
  account's `/api/results` history (and backs its scores out of the public totals), and its
  friends-board entries for the last 90 days.
- Revokes the Sign in with Apple grant via `https://appleid.apple.com/auth/revoke` when the
  server has the Sign in with Apple key (`APPLE_SIWA_KEY_ID`, `APPLE_SIWA_KEY`,
  `APPLE_TEAM_ID`) and a refresh token (stored at sign-in) or the fresh `authorizationCode`.
  Skipped otherwise; the account data is deleted either way.
- Response 200: `{ "deleted": true, "appleRevoked": false }`.
- Client: confirm first ("Delete your Named account? Your stats on this phone stay, but the
  account, its synced history and its friends-board entries are deleted. This can't be undone."),
  then clear the session and switch back to a **new** install ID.

## The account object
```json
{
  "id": "4f0c…32 hex",
  "createdAt": 1793000000000,
  "provider": "apple",
  "email": null,
  "plus": false,
  "resultsId": "uuid used for /api/results",
  "stats": {
    "played": 31, "wins": 29, "streak": 12, "maxStreak": 14, "lastDate": "2026-10-24",
    "dist": [0, 2, 9, 11, 6, 1], "cleanWins": 27
  },
  "freezes": { "used": { "2026-W43": 1 }, "days": ["2026-10-20"] },
  "social": { "nickname": "Bran", "groups": ["K7P2QX9M"], "boardId": "uuid" },
  "results": [
    { "dateKey": "2026-10-23", "number": 296, "score": 4, "won": true, "guesses": 4,
      "archive": false, "verified": false, "at": 1793000000000 },
    { "dateKey": "2026-10-24", "number": 297, "score": 7, "won": false, "guesses": 6,
      "archive": false, "verified": true, "at": 1793000000000,
      "words": ["CHARLES", "PAULINE", "…"] }
  ]
}
```
- `email`: only if Apple put one in the token (we request no scopes, so normally null).
- `stats.streak` is the streak as of `stats.lastDate`. Display it exactly like the app does
  today: it counts only while `lastDate` is today or yesterday (`Stats.currentStreak(today:)`).
- `results` are sorted by `dateKey` ascending. `words` is present for verified results, so a new
  phone can redraw a finished board.
- `social.boardId`: use it as the friends-board `playerId` on every device while signed in, so
  the same person shows once per board. Keep invite links (`/join/<code>`) working exactly as
  today for people who aren't signed in.

## How stats are computed

- **Counted results:** only on-day results (`archive: false`) count toward `played`, `wins`,
  `dist`, `cleanWins` and the streak, matching the game's rule "Streak and stats count each
  day's daily on its day". Archive results are stored (so Puzzles shows them solved) and feed
  "you vs everyone" when verified.
- **Counts** are incremental: a new on-day result adds 1 to `played`, and on a win 1 to `wins`,
  `dist[guesses-1]` and (if clean) `cleanWins`.
- **Streak** is recomputed on every write by walking back from the latest on-day result:
  a win adds 1, a freeze day is skipped (bridges without counting), a loss or a missing day
  ends the run. If the walk reaches the account's **anchor** (a `{date, streak}` carried over
  from a device's pre-account stats), the anchor's streak is added and the walk stops. This makes
  out-of-order (offline-queued) posts land correctly.
- `maxStreak` = the highest of the stored value, every device's reported `maxStreak` and the
  current streak. It never goes down.
- `lastDate` = the latest of the latest on-day result, the latest freeze day and the anchor date.

## Merge rules (every sign-in that sends `local`)

1. **Results: union by date.** For a date only the device has, the device's result is added. For
   a date both have, the account's result is kept (it was finished first). Exception: when the
   account's result is unverified and the device sends the same score with its words, the
   account's result becomes verified (counts don't change). `POST /api/account/result` does the
   same for a date the account already has unverified with the same score.
2. **Counts:** `played`, `wins`, `cleanWins` and each `dist` bucket become
   `max(account + newly added on-day results, device stats)`. Taking the max means history the
   device counted before it kept per-date records is not lost, and nothing is double counted.
3. **Streak:** the device's `{lastDate, streak}` becomes a candidate anchor. The server computes
   the streak with the account's anchor and with the device's, and keeps whichever gives the
   longer current streak. `maxStreak` = max of both sides and the result.
4. **Freezes:** union of the two ledgers, per ISO week the higher count.
5. **Friends:** the account's nickname wins if it has one, otherwise the device's. Groups are
   the account's followed by the device's new ones (≤ 10). The first device's `playerId` becomes
   `boardId`; if a later device posted to one of its boards in the last day under its own
   player ID, that entry is moved to `boardId` so the person isn't listed twice.
6. **"You vs everyone":** the device's `installId` history is moved onto `account.resultsId`
   (for a number both have, the account's score is kept and the device's is backed out).
7. Device stats are sanity-clamped: counts 0–5000, `wins ≤ played`, `streak` and `maxStreak` ≤
   days since 2026-01-01, `lastDate` between 2026-01-01 and the server's tomorrow.

## Freezes (iOS rule, enforced server-side once signed in)

- 1 freeze per ISO week, 2 with Named+ (`plus`, as last reported by the device: the server trusts
  it until server-side entitlement checks exist).
- `POST /api/account/result` applies freezes automatically before recording a result that
  follows missed days (same all-or-nothing rule), so the web, which has no freeze UI, keeps the
  iPhone's streak behaviour.

## Redis keys

| Key | Type | Contents | TTL |
|---|---|---|---|
| `named:sess:<sha256hex(session)>` | string | account ID | 1 year, refreshed on use |
| `named:acct:<id>:sess` | set | session hashes (for logout-all on delete) | none |
| `named:apple:<sub>` | string | account ID for an Apple user ID | none |
| `named:acct:<id>` | hash | `sub`, `email`, `created`, `nick`, `groups` (JSON), `board`, `rid`, `stats` (JSON), `frz` (JSON), `plus`, `rt` (Apple refresh token, only with the SIWA key), `rtc` (its client ID) | none |
| `named:acct:<id>:res` | hash | dateKey → JSON `{s, a, v, at, w?}` (score, archive, verified, time, words) | none |
| `named:acct:<id>:lock` | string | write lock (SET NX) | 5 s |
| `named:nonce:<sha256hex(nonce)>` | string | `1` until used | 10 min |
| `named:arl:<id>:<hour>` / `named:arr:<id>:<hour>` | string | write / read counters | 1 h |
| `named:srl:<sub>:<hour>` | string | sign-in counter | 1 h |
| `named:res:*`, `named:plr:<resultsId>`, `named:rank` | | "you vs everyone" (see `api/results.js`) | as there |
| `given:board:<group>:<dateKey>` | hash | friends board, field = `boardId` | 90 days |

No IP addresses, user agents or device identifiers are stored.

## Rate limits

| Bucket | Limit |
|---|---|
| Nonces (`/nonce`), all clients together | 600 per minute |
| Sign-in (`/apple`), per Apple ID | 20 per hour |
| Writes (`/result`, `/freeze`, `PATCH`), per account | 60 per hour |
| Reads (`GET /api/account`), per account | 600 per hour |

Over the limit: 429 with `Retry-After` (seconds to the next hour).

## iPhone implementation checklist

1. `GET /api/config` is optional on iOS. Native Sign in with Apple:
   `ASAuthorizationAppleIDProvider().createRequest()`, `requestedScopes = []`,
   `nonce = sha256hex(rawNonce)` where `rawNonce` comes from `POST /api/account/nonce`.
2. On success, `POST /api/account/apple` with `platform: "ios"`, the identity token, the raw
   nonce, the authorization code and `local` (stats, journal daily results with
   `archive` from the archive store, freezes ledger, friends membership, install ID).
3. Store `session` in the Keychain. Replace local stats/freezes/membership with the account's.
   Use `account.resultsId` for `/api/results` GETs; stop POSTing `/api/results` while signed in.
4. After each finished official daily: `POST /api/account/result` (queue offline).
   Use `vs` from the response for the "you vs everyone" ticket.
5. On launch/foreground: `POST /api/account/freeze` then `GET /api/account`.
6. Friends: when joining/leaving a board, `PATCH /api/account` with the new `groups` (and
   `nickname`). Post to `/api/leaderboard` with `playerId = account.social.boardId` (or rely on
   the server, which posts verified on-day results itself).
7. Settings: "Signed in with Apple" row with Sign out; "Delete account" (destructive, confirm,
   then `DELETE /api/account`). Also check `ASAuthorizationAppleIDProvider.getCredentialState`
   on launch: if `.revoked` or `.notFound`, sign out locally.
8. 401 `unauthorized` anywhere = signed out locally (keep stats).
