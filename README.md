# Given

Guess the given name.

**B** is given. **H** is in the name. **BETH**.

## Play locally

```bash
npm test
python3 -m http.server 4173 --bind 127.0.0.1
```

Open http://127.0.0.1:4173/

## Deploy on Vercel

Static HTML/CSS/JS. No environment variables.

1. Import this repo in the Vercel dashboard (or run `npx vercel` while logged in).
2. Framework Preset: **Other** (`framework` is already `null` in `vercel.json`).
3. Build command: `node tests/engine.test.js` (runs the engine tests).
4. Output directory: `.` (project root).
5. Root directory: repository root. Leave install empty if asked; there are no npm dependencies.

After the first deploy, the game is at `https://<project>.vercel.app/`. Share that URL. HTTPS is required for clipboard copy.

## Rules

- 6 guesses
- The first letter is already on the board
- Every guess must be a real first name of the same length, starting with the given letter and containing the hidden letter
- Green / yellow / gray work like Wordle (including duplicate letters)

## Play with friends

Everyone gets the same numbered daily. After you finish, **Share** copies a spoiler-free grid into the group chat:

```
GIVEN 225 3/6

🟩⬛🟨⬛
🟩🟩🟩🟩
```

Compare scores there. No rooms, no leaderboard, no spoilers.
