/**
 * The Name Story (hook, meaning, then and now, feeling, songs and films, namesakes) and the fact card, ported line for line from the iPhone app
 * (Named/Engine/NameStory.swift and Named/Engine/NameFacts.swift) so both say the same thing.
 * Pure: works in the browser and in Node. Data: data/name-facts.json and data/name-stories.json,
 * built by scripts/build-name-story-data.mjs from the app's resources.
 */

const NBSP = " ";

export function titleCase(name) {
  const s = String(name || "");
  return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;
}

function key(name) {
  return String(name || "").toUpperCase().replace(/[^A-Z]/g, "");
}

/** Year bounds and per-year totals, parsed once (NameFacts.Context). */
export function factsContext(facts) {
  const yearTotals = new Map();
  for (const [year, total] of Object.entries(facts?.yt || {})) {
    if (/^\d+$/.test(year)) yearTotals.set(Number(year), total);
  }
  const firstYear = facts?.firstYear ?? 1880;
  const throughYear = facts?.throughYear ?? 2025;
  return { firstYear, throughYear, yearTotals, currentYear: throughYear + 1 };
}

const contexts = new WeakMap();
function contextOf(facts) {
  if (!contexts.has(facts)) contexts.set(facts, factsContext(facts));
  return contexts.get(facts);
}

// ---------- Copy helpers (NameFacts) ----------

export function number(n) {
  return Number(n).toLocaleString("en-US");
}

/** Two significant figures, as words for millions: 4,156,654 → "4.2 million", 618,857 → "620,000". */
export function rounded(n) {
  if (n < 100) return String(n);
  const magnitude = Math.pow(10, Math.floor(Math.log10(n)) - 1);
  const value = Math.trunc(Math.round(n / magnitude) * magnitude);
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    const text = millions === Math.round(millions) ? String(Math.trunc(millions)) : millions.toFixed(1);
    return `${text} million`;
  }
  return number(value);
}

export function plural(label) {
  const lower = label.toLowerCase();
  return ["s", "x", "z", "ch", "sh"].some((end) => lower.endsWith(end)) ? `${label}es` : `${label}s`;
}

const decadeOf = (year) => Math.trunc(year / 10) * 10;

export function girlsPercent(e) {
  if (!(e.t > 0)) return 0;
  return Math.round((e.g * 100) / e.t);
}

export function shareOfYear(e, c) {
  const total = c.yearTotals.get(e.py);
  if (!(total > 0) || !(e.pc > 0)) return null;
  return Math.round(total / e.pc);
}

export function reboundChip(e) {
  if (!(e.c0 > 0)) return "Unlisted in 2000";
  const ratio = e.cN / e.c0;
  if (ratio >= 10) return `Up ${Math.floor(ratio)}× since 2000`;
  const tenths = Math.floor(ratio * 10);
  return tenths % 10 === 0 ? `Up ${tenths / 10}× since 2000` : `Up ${Math.trunc(tenths / 10)}.${tenths % 10}× since 2000`;
}

export function preciseGenderChip(e) {
  const girls = girlsPercent(e);
  if (girls >= 5 && girls <= 95) return `${girls}% girls · ${100 - girls}% boys`;
  const girlsMajority = 2 * e.g >= e.t;
  const majority = girlsMajority ? e.g : e.t - e.g;
  const who = girlsMajority ? "girls" : "boys";
  if (majority === e.t) return `100% ${who}`;
  const tenths = Math.min(999, Math.round((majority * 1000) / e.t));
  return `${Math.trunc(tenths / 10)}.${tenths % 10}% ${who}`;
}

export function trendChip(e, c) {
  if (!(e.cN > 0)) return `Too rare to list in ${c.throughYear}`;
  const arrow = e.cN * 4 >= e.c0 * 5 ? "↑" : e.cN * 5 <= e.c0 * 4 ? "↓" : "→";
  return `${arrow} ${number(e.cN)} born in ${c.throughYear}`;
}

export function decadeName(decade) {
  return decade >= 1950 && decade <= 1990 ? `A ’${decade % 100}s name` : `A ${decade}s name`;
}

export function times(ratio) {
  const whole = Math.floor(ratio);
  const exact = ratio === whole;
  if (whole === 2) return exact ? "Twice" : "More than twice";
  return exact ? `${whole} times` : `More than ${whole} times`;
}

function countHeadline(label, e) {
  return e.t >= 250_000 ? `About ${rounded(e.t)} U.S. babies named ${label}` : `At least ${number(e.t)} U.S. babies named ${label}`;
}

/** Keeps "in 2025" (and "Month 2025") on one line when a headline wraps. */
export function keepYearsTogether(text) {
  return text
    .replace(/(\S+) in (\d{4})\b/g, `$1${NBSP}in${NBSP}$2`)
    .replace(/\b([A-Za-z]+) (\d{4})\b/g, `$1${NBSP}$2`);
}

/** The years a line mentions ("1926", not the "1920" in "1920s"). */
export function yearsIn(text) {
  return new Set([...String(text).matchAll(/\b(1[89]\d\d|20\d\d)\b/g)].map((m) => m[1]));
}

// ---------- Headline rules, in tie-break order ----------

const candidate = (kind, score, headline) => ({ kind, score, headline });

const headlineRules = [
  // Its best-ever rank.
  (_label, e) => {
    const who = 2 * e.g >= e.t ? "girls’" : "boys’";
    if (e.br === 1 && e.bn > 1) return candidate("rank", 99, `The No. 1 ${who} name for ${e.bn} years`);
    if (e.br >= 1 && e.br <= 10) return candidate("rank", 100 - e.br, `The No. ${e.br} ${who} name in ${e.by}`);
    if (e.br >= 11 && e.br <= 25) return candidate("rank", 82, `A top 25 ${who} name in ${e.by}`);
    if (e.br >= 26 && e.br <= 50) return candidate("rank", 70, `A top 50 ${who} name in ${e.by}`);
    if (e.br >= 51 && e.br <= 100) return candidate("rank", 58, `A top 100 ${who} name in ${e.by}`);
    if (e.br >= 101 && e.br <= 1000) {
      const [band, score] = e.br <= 200 ? ["200", 38] : e.br <= 500 ? ["500", 30] : ["1,000", 20];
      return candidate("rank", score - (e.by < 1900 ? 10 : 0), `A top ${band} ${who} name in ${e.by}`);
    }
    return null;
  },
  // A steep rise since 2000.
  (_label, e, c) => {
    if (e.c0 === 0 && e.cN >= 300) {
      return candidate("rise", 90, `Not on SSA’s list in 2000. ${number(e.cN)} babies in ${c.throughYear}.`);
    }
    if (!(e.c0 > 0 && e.cN >= 500 && e.cN >= 2 * e.c0)) return null;
    const ratio = e.cN / e.c0;
    const score = Math.min(94, 72 + Math.trunc(5 * Math.log2(ratio)));
    if (e.c0 < 100) return candidate("rise", score, `From ${e.c0} babies in 2000 to ${number(e.cN)} in ${c.throughYear}`);
    return candidate("rise", score, `${times(ratio)} as many born in ${c.throughYear} as in 2000`);
  },
  // An old name on its way back.
  (_label, e) => {
    if (!(e.py <= 1959 && e.cN >= 100 && e.c0 * 3 <= e.pc && (e.c0 === 0 || e.cN >= 3 * e.c0))) return null;
    const ratio = e.c0 === 0 ? 8 : e.cN / e.c0;
    return candidate("comeback", Math.min(95, 76 + Math.trunc(5 * Math.log2(ratio))), `A ${decadeOf(e.py)}s name making a comeback`);
  },
  // Never more popular than right now.
  (_label, e, c) => {
    if (!(e.py >= c.throughYear - 1 && e.pc >= 200)) return null;
    return candidate("record", 86, e.py === c.throughYear ? `Never more popular than in ${e.py}` : `Hit its all-time high in ${e.py}`);
  },
  // Given to boys and girls alike.
  (_label, e) => {
    if (!(e.t >= 1000)) return null;
    const girls = girlsPercent(e);
    if (girls >= 45 && girls <= 55) {
      return candidate("split", 84, girls === 50 ? "Split 50/50 between boys and girls" : "Split nearly 50/50 between boys and girls");
    }
    if (girls >= 35 && girls <= 65) return candidate("split", 56, `Given to boys and girls: ${girls}% girls`);
    return null;
  },
  // A crowd.
  (label, e) => {
    if (e.t >= 1_000_000) return candidate("total", 80, `About ${rounded(e.t)} U.S. babies named ${label}`);
    if (e.t >= 250_000) return candidate("total", 44, `About ${rounded(e.t)} U.S. babies named ${label}`);
    return null;
  },
  // A steep fall since 2000.
  (_label, e, c) => {
    if (!(e.c0 >= 1000 && e.cN * 3 <= e.c0)) return null;
    const ratio = e.c0 / Math.max(e.cN, 1);
    return candidate("fall", Math.min(78, 60 + Math.trunc(5 * Math.log2(ratio))),
      `Down from ${number(e.c0)} babies in 2000 to ${e.cN === 0 ? "too few to list" : number(e.cN)} in ${c.throughYear}`);
  },
  // A newcomer.
  (_label, e, c) => {
    if (!(e.fy > c.firstYear)) return null;
    if (e.fy >= 1980) return candidate("debut", 68, `First recorded in ${e.fy}`);
    if (e.fy >= 1950) return candidate("debut", 42, `First recorded in ${e.fy}`);
    return candidate("debut", 16, `First recorded in ${e.fy}`);
  },
  // An old soul.
  (_label, e) => {
    if (!(e.py <= 1935)) return null;
    if (e.t < 50_000) return candidate("vintage", 66, `A rare vintage name: it peaked in ${e.py}`);
    return candidate("vintage", 50, `Most popular back in ${e.py}`);
  },
  // A decade that owns the name.
  (label, e) => {
    const dp = e.dp ?? 0;
    if (dp > 50) return candidate("decade", 36, `More than half of all ${plural(label)} were born in the ${e.pd}s`);
    if (!(dp >= 30)) return null;
    return candidate("decade", 32, `${dp}% of all ${plural(label)} were born in the ${e.pd}s`);
  },
  // Rare on the record.
  (label, e) => {
    if (!(e.t < 5000)) return null;
    const amount = e.t < 100 ? number(e.t) : `about ${rounded(e.t)}`;
    return candidate("rare", e.t < 1000 ? 34 : 26, `Only ${amount} ${plural(label)} on record, ever`);
  },
  // Its share of the babies born in its best year.
  (label, e, c) => {
    const share = shareOfYear(e, c);
    if (share === null || share > 50_000) return null;
    return candidate("share", 24, `In ${e.py}, about 1 in ${rounded(share)} babies was named ${label}`);
  },
  // Always true.
  (label, e) => candidate("count", 10, countHeadline(label, e)),
];

/** Up to three short chips, skipping anything the headline already says. */
export function chips(label, e, c, headline, saying = "") {
  const said = yearsIn(saying);
  const fresh = (chip) => [...yearsIn(chip)].every((year) => !said.has(year));
  if (headline === "comeback") return [`Peaked in ${e.py}`, reboundChip(e), preciseGenderChip(e)].filter(fresh);
  const out = [];
  const girls = girlsPercent(e);
  const mixed = girls >= 5 && girls <= 95;
  let peakSaid = headline === "vintage" || headline === "record" || (headline === "rank" && e.by === e.py && e.bn === 1);
  const share = shareOfYear(e, c);
  if (e.pr <= 50 && headline !== "share" && share !== null) {
    out.push(`About 1 in ${rounded(share)} babies in ${e.py}`);
    peakSaid = true;
  }
  if (headline === "rank" && e.br === 1 && e.bn > 1) out.push(`First No. 1 in ${e.by}`);
  if (headline !== "split" && mixed) out.push(`${girls}% girls · ${100 - girls}% boys`);
  if (!peakSaid) out.push(`Peaked in ${e.py}`);
  if (headline !== "decade" && (peakSaid || Math.trunc(e.pd / 10) !== Math.trunc(e.py / 10))) out.push(decadeName(e.pd));
  out.push(e.my >= 1970 ? `Most are ${c.currentYear - e.my} or younger` : `Half born by ${e.my}`);
  if (headline !== "rise" && headline !== "fall") out.push(trendChip(e, c));
  if (headline !== "debut" && e.fy > c.firstYear) out.push(`First recorded in ${e.fy}`);
  if (headline !== "split" && !mixed) out.push(preciseGenderChip(e));
  if (!["total", "count", "rare"].includes(headline)) out.push(`${number(e.t)} babies in all`);
  return out.filter(fresh).slice(0, 3);
}

/** The most surprising true headline, with up to three chips that don't repeat it. */
export function pickFactCard(name, e, c) {
  const label = titleCase(key(name));
  let best = null;
  for (const rule of headlineRules) {
    const found = rule(label, e, c);
    if (found && (!best || found.score > best.score)) best = found;
  }
  best ||= candidate("count", 0, countHeadline(label, e));
  return { headline: keepYearsTogether(best.headline), chips: chips(label, e, c, best.kind, best.headline), kind: best.kind };
}

/** The fact card for any name: full facts, else the older name-notes counts, else "not listed". */
export function factCard(name, facts, notes) {
  const k = key(name);
  const entry = facts?.names?.[k];
  if (entry) return pickFactCard(k, entry, contextOf(facts));
  const label = titleCase(k);
  const note = notes?.counts?.[k];
  if (!note) {
    return { headline: `${label} is too rare for SSA’s national list`, chips: ["Fewer than 5 births a year", "That’s not the same as no one"], kind: "unlisted" };
  }
  return { headline: `At least ${number(note.total)} U.S. babies named ${label}`, chips: [`Peaked in ${note.peakYear}`, `${number(note.peakCount)} born that year`], kind: "notes" };
}

// ---------- The Name Story (NameStory.swift) ----------

/** "In 1918 it was the No. 3 name for girls in America." Only for a top-20 peak. */
export function recordLine(e) {
  if (!(e.pr > 0 && e.pr <= 20)) return null;
  const sex = e.ps === "F" ? "girls" : "boys";
  return `In ${e.py} it was the No. ${e.pr} name for ${sex} in America.`;
}

const CULTURE_KINDS = { song: "Song", film: "Film", tv: "TV", book: "Book", play: "Play", character: "Character" };

/** The small label over a song, film or book: "Film · 1914". */
export function cultureKindLine(item) {
  const kind = CULTURE_KINDS[item.kind] || (item.kind ? item.kind[0].toUpperCase() + item.kind.slice(1).toLowerCase() : "");
  return Number.isInteger(item.year) ? `${kind} · ${item.year}` : kind;
}

/** A character's name as is; a title in quotes. */
export function cultureTitle(item) {
  return item.kind === "character" ? item.title : `“${item.title}”`;
}

/** "Peaked in 1987 at #4 for boys. Today it's #212." */
export function popularityLine(e, c) {
  const peakSex = e.ps === "F" ? "girls" : "boys";
  const nowSex = e.g * 2 >= e.t ? "girls" : "boys";
  const latest = c.throughYear;
  const rank = e.lr ?? 0;
  if (e.py === latest) {
    return rank > 0
      ? `More popular than ever: #${number(rank)} for ${nowSex} in ${latest}.`
      : `More babies got it in ${latest} than in any year before.`;
  }
  const peak = `Peaked in ${e.py} at #${number(e.pr)} for ${peakSex}.`;
  if (!(rank > 0)) return `${peak} Fewer than five babies got it in ${latest}.`;
  const today = nowSex === peakSex ? `Today it's #${number(rank)}.` : `Today it's #${number(rank)} for ${nowSex}.`;
  return `${peak} ${today}`;
}

/** One honest, human line from the counts, or null when nothing true and striking applies. */
export function feelingLine(e, c) {
  const decade = decadeOf(e.py);
  // "’80s" only where it can't be misread as this century's decade.
  const decadeLabel = decade >= 1950 && decade <= 1999 ? `’${String(decade).slice(-2)}s` : `${decade}s`;
  // How many of them a school of 500 kids born in its peak year would have had.
  const total = c.yearTotals.get(e.py);
  const school = total ? (e.pc * 500) / total : 0;
  const rank = e.lr ?? 0;
  if (e.py >= c.throughYear - 2 && rank > 0 && rank <= 300) {
    return "If you have a toddler, you’ve probably met one at the playground.";
  }
  if (school >= 4 && e.py < c.throughYear - 15) return `If you grew up in the ${decadeLabel}, you knew at least two.`;
  if (school >= 1.5 && e.py < c.throughYear - 15) return `If you grew up in the ${decadeLabel}, there was probably one in your school.`;
  if (e.my < 1950 && e.cN < Math.trunc(e.pc / 20)) {
    return "Most people with this name were born before 1950. Ask someone’s grandmother.";
  }
  if (e.c0 > 0 && e.cN >= e.c0 * 3 && e.my < 1960) {
    return `An old name coming back: three times as many babies got it in ${c.throughYear} as in 2000.`;
  }
  if (e.t < 2_000) return `Fewer than ${e.t < 1_000 ? "1,000" : "2,000"} Americans on record have ever had it. You may never meet another.`;
  return null;
}

/** Everything the Name Story card says about one name. */
export function nameStory(name, facts, stories) {
  const k = key(name);
  const research = stories?.names?.[k];
  const entry = facts?.names?.[k];
  const c = facts ? contextOf(facts) : null;
  const story = {
    name: titleCase(k),
    meaning: research?.meaning || null,
    origin: research?.origin || null,
    popularity: entry ? popularityLine(entry, c) : null,
    feeling: entry ? feelingLine(entry, c) : null,
    namesakes: (research?.namesakes || []).slice(0, 3),
    culture: (research?.culture || []).slice(0, 2),
    record: entry ? recordLine(entry) : null,
  };
  story.hasResearch = Boolean(story.meaning || story.origin || story.namesakes.length || story.culture.length);
  return story;
}

/** “Small, younger”, from Latin, via French */
export function meaningLine(story) {
  const m = story.meaning ? story.meaning[0].toUpperCase() + story.meaning.slice(1) : null;
  if (m && story.origin) return `“${m}”, from ${story.origin}`;
  if (m) return `“${m}”`;
  if (story.origin) return `From ${story.origin}`;
  return "";
}

export function sourcesLine(story) {
  const parts = ["Popularity: U.S. Social Security Administration birth records."];
  if (story.hasResearch) parts.push("Meanings, works and namesakes: Wiktionary and Wikipedia.");
  if (story.namesakes.length || story.culture.length) {
    parts.push("People and works are listed for interest only and don't endorse Named.");
  }
  return parts.join(" ");
}
