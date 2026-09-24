/** Short post-reveal notes derived from SSA national baby-name records. */
export function describeName(name, notes) {
  const label = name[0] + name.slice(1).toLowerCase();
  const fact = notes.counts[name.toUpperCase()];
  if (!fact) {
    return `The spelling ${label} does not appear in SSA's published national birth-name data, which omits any name with fewer than five births for a sex in a year. That does not mean no one has the name.`;
  }
  const total = fact.total.toLocaleString("en-US");
  const peak = fact.peakCount.toLocaleString("en-US");
  return `SSA records at least ${total} U.S. births named ${label} from 1880–${notes.throughYear}. Its busiest year was ${fact.peakYear}, with ${peak} recorded births.`;
}
