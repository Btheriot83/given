/** The web Name Story and fact card must say exactly what the iPhone app says. */
import { readFileSync } from "node:fs";
import {
  factCard,
  nameStory,
  popularityLine,
  feelingLine,
  recordLine,
  meaningLine,
  sourcesLine,
  cultureKindLine,
  cultureTitle,
  factsContext,
  rounded,
  reboundChip,
  preciseGenderChip,
  keepYearsTogether,
} from "../js/name-story.js";

const read = (path) => JSON.parse(readFileSync(new URL(`../data/${path}`, import.meta.url)));
const facts = read("name-facts.json");
const stories = read("name-stories.json");
const pools = read("answer-pools.json");
const c = factsContext(facts);
const plain = (s) => s.replace(/ /g, " ");
let count = 0;
function equal(a, b, msg) {
  count++;
  const left = JSON.stringify(a);
  const right = JSON.stringify(b);
  if (left !== right) throw new Error(`${msg}: ${left} !== ${right}`);
}

// The cases the iPhone tests pin (NamedTests/KeepsakesTests.swift).
const emma = nameStory("EMMA", facts, stories);
equal(emma.popularity, "Peaked in 2003 at #2 for girls. Today it's #3.", "EMMA popularity");
equal(emma.record, "In 2003 it was the No. 2 name for girls in America.", "EMMA record");
const pauline = nameStory("pauline", facts, stories);
equal(pauline.popularity, "Peaked in 1918 at #35 for girls. Today it's #2,957.", "PAULINE popularity");
equal(pauline.feeling, "If you grew up in the 1910s, there was probably one in your school.", "PAULINE feeling");
equal(pauline.record, null, "PAULINE has no record (peak #35)");
equal(pauline.name, "Pauline", "title case");
equal(meaningLine(pauline), "“Small, younger”, from Latin, via French", "PAULINE meaning line");
equal(nameStory("HAYES", facts, stories).popularity, "More popular than ever: #162 for boys in 2025.", "HAYES popularity");
equal(nameStory("HAYES", facts, stories).feeling, "If you have a toddler, you’ve probably met one at the playground.", "HAYES feeling");

// Decades 1950–1999 read ’80s; others in full.
const base = { t: 500000, g: 490000, fy: 1880, py: 1985, pc: 30000, pr: 3, ps: "F", br: 3, by: 1985, bn: 1, pd: 1980, dp: 40, my: 1984, c0: 2000, cN: 300, lr: 900 };
equal(feelingLine(base, c), "If you grew up in the ’80s, you knew at least two.", "’80s decade");
equal(feelingLine({ ...base, py: 1947 }, c), "If you grew up in the 1940s, you knew at least two.", "1940s in full");
equal(feelingLine({ ...base, py: 2005, pc: 40000 }, c), "If you grew up in the 2000s, you knew at least two.", "2000s in full");
equal(feelingLine({ ...base, t: 900, py: 2024, pc: 3, lr: 0, my: 2010, c0: 0, cN: 3 }, c), "Fewer than 1,000 Americans on record have ever had it. You may never meet another.", "rare feeling");

// Popularity wording.
equal(popularityLine({ ...base, py: 1987, pr: 4, ps: "M", g: 1000, lr: 212 }, c), "Peaked in 1987 at #4 for boys. Today it's #212.", "boys popularity");
equal(popularityLine({ ...base, lr: 0 }, c), "Peaked in 1985 at #3 for girls. Fewer than five babies got it in 2025.", "unranked today");
equal(popularityLine({ ...base, ps: "M" }, c), "Peaked in 1985 at #3 for boys. Today it's #900 for girls.", "sex changed");
equal(popularityLine({ ...base, py: 2025, lr: 0 }, c), "More babies got it in 2025 than in any year before.", "record year, unranked");
equal(recordLine({ ...base, pr: 1, ps: "M", py: 1947 }), "In 1947 it was the No. 1 name for boys in America.", "No. 1 record");
equal(recordLine({ ...base, pr: 21 }), null, "no record past 20");

// Fact card headlines and chips.
equal(factCard("EMMA", facts).headline, "The No. 1 girls’ name for 6 years", "EMMA headline");
equal(factCard("EMMA", facts).chips, ["About 1 in 170 babies in 2003", "First No. 1 in 2008", "A 2010s name"], "EMMA chips");
equal(plain(factCard("PAULINE", facts).headline), "A top 50 girls’ name in 1915", "PAULINE headline");
equal(factCard("PAULINE", facts).chips, ["About 1 in 300 babies in 1918", "A 1920s name", "Half born by 1925"], "PAULINE chips");
equal(plain(factCard("HAYES", facts).headline), "From 84 babies in 2000 to 2,327 in 2025", "HAYES headline");
equal(factCard("HAZEL", facts).chips, ["Peaked in 1918", "Up 25× since 2000", "99.1% girls"], "HAZEL comeback chips");
equal(factCard("ZZZZQ", facts, { counts: {} }).kind, "unlisted", "unlisted card");
equal(factCard("ZZZZQ", facts, { counts: { ZZZZQ: { total: 1234, peakYear: 1990, peakCount: 56 } } }),
  { headline: "At least 1,234 U.S. babies named Zzzzq", chips: ["Peaked in 1990", "56 born that year"], kind: "notes" }, "notes fallback");
equal(keepYearsTogether("Hit its all-time high in 2024"), "Hit its all-time high in 2024", "years stay together");
equal(rounded(618857), "620,000", "rounded");
equal(rounded(4156654), "4.2 million", "rounded millions");
equal(reboundChip({ c0: 10, cN: 30 }), "Up 3× since 2000", "rebound whole");
equal(preciseGenderChip({ t: 10000, g: 9999 }), "99.9% girls", "precise gender");
equal(preciseGenderChip({ t: 1000, g: 20 }), "98.0% boys", "precise gender boys");

// Songs, films and books.
equal(cultureKindLine({ kind: "film", title: "The Perils of Pauline", year: 1914 }), "Film · 1914", "culture label");
equal(cultureKindLine({ kind: "tv", title: "X" }), "TV", "culture label without year");
equal(cultureTitle({ kind: "film", title: "The Perils of Pauline" }), "“The Perils of Pauline”", "quoted title");
equal(cultureTitle({ kind: "character", title: "Pauline Marvel" }), "Pauline Marvel", "character unquoted");

// Sources note.
equal(sourcesLine({ hasResearch: false, namesakes: [], culture: [] }), "Popularity: U.S. Social Security Administration birth records.", "sources, counts only");
equal(sourcesLine(pauline), "Popularity: U.S. Social Security Administration birth records. Meanings, works and namesakes: Wiktionary and Wikipedia. People and works are listed for interest only and don't endorse Named.", "sources, full");

// Every possible answer has a popularity line; no story has more than three namesakes or two works.
for (const name of [...pools.familiar, ...pools.dailyFive, ...(pools.dailySix || []), ...(pools.dailySeven || []), ...pools.obscure]) {
  const story = nameStory(name, facts, stories);
  if (!story.popularity) throw new Error(`${name} has no popularity line`);
  if (story.namesakes.length > 3 || story.culture.length > 2) throw new Error(`${name} story too long`);
}
console.log(`name story: ${count} checks ok`);
