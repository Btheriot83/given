// Records the og.mp4 gameplay (HARRY, CASEY, HAYES on Daily #271, 2026-09-28) from the live site.
// Headless, --mute-audio, fresh profile, /api/* stubbed so nothing is posted. Needs `npm i playwright` in a scratch dir.
// Usage: node record-og-video.mjs <framesDir> 1750 4500, then: python3 composite-og-video.py, then ffmpeg (see commit).
import { chromium } from 'playwright';
import fs from 'fs';
const OUT = process.argv[2] || 'frames';
const WAIT = Number(process.argv[3] || 1900);
const TAIL = Number(process.argv[4] || 5000);
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT);
const browser = await chromium.launch({ args: ['--mute-audio'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
const blocked = [];
await ctx.route(/\/api\/|\/_vercel\//, (r) => {
  const q = r.request(); blocked.push(q.method() + ' ' + q.url());
  if (q.method() === 'GET') return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  return r.fulfill({ status: 503, body: '' });
});
await ctx.addInitScript(() => {
  try { localStorage.setItem('given-v2:settings', JSON.stringify({ seenHelp: true, music: false, effects: false })); } catch {}
  const mute = () => document.querySelectorAll('audio,video').forEach(m => { m.muted = true; m.volume = 0; });
  document.addEventListener('DOMContentLoaded', mute); setInterval(mute, 500);
});
const page = await ctx.newPage();
await page.clock.setSystemTime(new Date('2026-09-28T18:00:00'));
await page.goto('https://namedgame.com/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const cdp = await ctx.newCDPSession(page);
const frames = [];
cdp.on('Page.screencastFrame', async (f) => {
  frames.push({ t: f.metadata.timestamp, data: f.data });
  cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: 780, maxHeight: 1688 });
const t0 = Date.now(); const marks = {};
await page.waitForTimeout(500);
for (const word of ['HARRY', 'CASEY', 'HAYES']) {
  marks[word] = (Date.now() - t0) / 1000;
  for (const ch of word) { await page.keyboard.press(ch); await page.waitForTimeout(110); }
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(WAIT);
}
await page.waitForTimeout(TAIL);
await cdp.send('Page.stopScreencast');
await page.waitForTimeout(200);
frames.forEach((f, i) => fs.writeFileSync(`${OUT}/${String(i).padStart(5, '0')}.png`, Buffer.from(f.data, 'base64')));
fs.writeFileSync(`${OUT}/times.json`, JSON.stringify(frames.map(f => f.t)));
console.log('frames', frames.length, 'span', frames.at(-1).t - frames[0].t, 'marks', marks);
console.log('blocked', blocked);
console.log('ls', await page.evaluate(() => Object.keys(localStorage)));
await browser.close();
