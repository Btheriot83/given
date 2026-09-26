# Given

Guess a familiar five-letter first name each day in six tries. For a second daily challenge, try the optional Obscure puzzle. No letters are revealed before the first guess.

## Play locally

```bash
npm test
python3 -m http.server 4173 --bind 127.0.0.1
```

Open http://127.0.0.1:4173/

## Deploy on Vercel

Static HTML/CSS/JS with one serverless endpoint for the friends board. The game itself needs no environment variables. The board uses the free Upstash for Redis resource linked to the Vercel project, which injects `KV_REST_API_URL` and `KV_REST_API_TOKEN` into Preview and Production. Do not commit either value.

1. Import this repo in the Vercel dashboard (or run `npx vercel` while logged in).
2. Framework Preset: **Other** (`framework` is already `null` in `vercel.json`).
3. Build command: `node tests/engine.test.js` (runs the engine tests).
4. Output directory: `.` (project root).
5. Root directory: repository root. Leave install empty if asked; there are no npm dependencies.

After the first deploy, the game is at `https://<project>.vercel.app/`. Share that URL. HTTPS is required for clipboard copy.

## Rules

- 6 guesses at a first name. The official and Obscure dailies are five letters; unlimited unranked practice can be set to five, six, or seven letters in Settings.
- The board starts empty; every guess must be a real first name matching that round’s length.
- Bright green means the right spot, yellow means the wrong spot, and gray means the letter is absent (including duplicate-letter handling).
- There is one official daily and one optional Obscure puzzle per local calendar date. A missed day is replaced by the new names; an open tab refreshes the active daily at local midnight. Only the official daily affects streaks and the friends board. Obscure progress is saved separately on the device.
- The official daily uses the existing answer sequence through September 26, 2026, so games already in progress and leaderboard results remain valid. From September 27 onward it uses the familiar pool. Familiar answers have at least 150,000 published U.S. births for that spelling, or a peak of at least 2,000 births in a year since 2010. The optional Obscure pool has 5,000–19,999 total recorded births, excluding familiar answers. These are selection rules, not a measure of every culture's familiarity.
- After a finished round, **Play another name** starts an unranked practice round with a different answer at the selected length. Changing the length applies to the next round and does not erase the current board. It does not reset the shared daily or its friends-board score.
- Existing in-progress official games keep their saved answer and submitted guesses. Completed games and scores remain intact.

## Play with friends

Everyone on the same local calendar date gets the same numbered daily. After you finish, **Share result** sends or copies a spoiler-free grid and a link back to the game:

```
GIVEN 266 3/6

🟩⬛🟨⬛⬛
🟩🟩🟩🟩🟩

https://given-one.vercel.app/
```

The trophy button opens a friends board. Create an eight-character code or join one from a friend's link, choose a nickname, and finish the official daily puzzle. Scores rank by fewest guesses; losses show `X/6`. Obscure and practice rounds do not count. Codes are unlisted, not a privacy or identity guarantee. There is no login, so this is for friendly competition, not a cheat-proof public contest. A device can post once per group per day; entries expire after 90 days. The score endpoint replays submitted guesses against the official daily puzzle and never returns the answer.

## Name notes

After a name is revealed, the result view shows a short fact from the [Social Security Administration's national baby-name files](https://www.ssa.gov/oact/babynames/limits.html). Counts sum the published female and male birth records from 1880 through 2025 for that exact spelling. They are **recorded births, not the current number of living people with that name**, and exclude name/sex/year entries below the SSA's five-birth publication threshold. A missing count is shown as missing data, not as zero people.

To refresh the checked-in compact data file after obtaining SSA's `names.zip`:

```bash
node scripts/build-name-notes.mjs /path/to/names.zip
node scripts/build-answer-pools.mjs
npm test
```
