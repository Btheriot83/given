// In-memory stand-in for the Upstash commands the API uses. Tests only; no network.

export function fakeRedis() {
  const hashes = new Map();
  const strings = new Map();
  const sets = new Map();
  const zsets = new Map();
  const ttl = new Map();
  const getMap = (store, key) => {
    if (!store.has(key)) store.set(key, store === sets ? new Set() : new Map());
    return store.get(key);
  };
  const bound = (value) => {
    if (value === "+inf") return { v: Infinity, open: false };
    if (value === "-inf") return { v: -Infinity, open: false };
    const s = String(value);
    return s.startsWith("(") ? { v: Number(s.slice(1)), open: true } : { v: Number(s), open: false };
  };
  const exists = (key) => strings.has(key) || (hashes.get(key)?.size || 0) > 0 || (sets.get(key)?.size || 0) > 0 || (zsets.get(key)?.size || 0) > 0;

  function run([cmd, key, ...args]) {
    switch (cmd) {
      case "GET":
        return strings.has(key) ? strings.get(key) : null;
      case "SET": {
        const flags = args.slice(1).map(String);
        if (flags.includes("NX") && exists(key)) return null;
        strings.set(key, String(args[0]));
        const ex = flags.indexOf("EX");
        if (ex >= 0) ttl.set(key, Number(flags[ex + 1]));
        return "OK";
      }
      case "DEL": {
        const had = exists(key);
        for (const store of [hashes, strings, sets, zsets]) store.delete(key);
        ttl.delete(key);
        return had ? 1 : 0;
      }
      case "EXPIRE":
        if (!exists(key)) return 0;
        ttl.set(key, Number(args[0]));
        return 1;
      case "INCR": {
        const next = Number(strings.get(key) || 0) + 1;
        strings.set(key, String(next));
        return next;
      }
      case "HSET": {
        const h = getMap(hashes, key);
        let added = 0;
        for (let i = 0; i < args.length; i += 2) {
          if (!h.has(args[i])) added++;
          h.set(String(args[i]), String(args[i + 1]));
        }
        return added;
      }
      case "HSETNX": {
        const h = getMap(hashes, key);
        if (h.has(args[0])) return 0;
        h.set(String(args[0]), String(args[1]));
        return 1;
      }
      case "HGET":
        return hashes.get(key)?.has(args[0]) ? hashes.get(key).get(args[0]) : null;
      case "HMGET":
        return args.map((f) => (hashes.get(key)?.has(f) ? hashes.get(key).get(f) : null));
      case "HGETALL":
        return [...(hashes.get(key)?.entries() || [])].flat();
      case "HDEL": {
        const h = hashes.get(key);
        const n = args.filter((f) => h?.delete(f)).length;
        if (h && !h.size) hashes.delete(key);
        return n;
      }
      case "HLEN":
        return hashes.get(key)?.size || 0;
      case "HINCRBY": {
        const h = getMap(hashes, key);
        const next = Number(h.get(args[0]) || 0) + Number(args[1]);
        h.set(args[0], String(next));
        return next;
      }
      case "SADD": {
        const s = getMap(sets, key);
        let n = 0;
        for (const m of args) if (!s.has(m)) { s.add(m); n++; }
        return n;
      }
      case "SREM": {
        const s = sets.get(key);
        return args.filter((m) => s?.delete(m)).length;
      }
      case "SMEMBERS":
        return [...(sets.get(key) || [])];
      case "SCAN": {
        const pattern = String(args[1]).replace(/\*$/, "");
        return ["0", [...hashes.keys()].filter((k) => k.startsWith(pattern) && hashes.get(k).size)];
      }
      case "ZADD":
        getMap(zsets, key).set(args[1], Number(args[0]));
        return 1;
      case "ZREM":
        return zsets.get(key)?.delete(args[0]) ? 1 : 0;
      case "ZCARD":
        return zsets.get(key)?.size || 0;
      case "ZCOUNT": {
        const lo = bound(args[0]);
        const hi = bound(args[1]);
        return [...(zsets.get(key)?.values() || [])].filter((v) => (lo.open ? v > lo.v : v >= lo.v) && (hi.open ? v < hi.v : v <= hi.v)).length;
      }
      default:
        throw new Error(`unexpected redis command ${cmd}`);
    }
  }

  const allKeys = () => new Set([...hashes.keys(), ...strings.keys(), ...sets.keys(), ...zsets.keys()].filter(exists));
  return { hashes, strings, sets, zsets, ttl, run, exists, allKeys, hget: (key) => Object.fromEntries(hashes.get(key) || []) };
}

/** A fake Vercel response object. */
export function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    end() { return this; },
  };
}
