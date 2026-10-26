// Sign in with Apple, server side: identity-token verification against Apple's JWKS, and
// (when the Sign in with Apple key is configured) code exchange and token revocation.
// No dependencies: node:crypto only.

import { createHash, createPublicKey, createPrivateKey, sign, verify } from "node:crypto";

export const APPLE_ISSUER = "https://appleid.apple.com";
export const APPLE_KEYS_URL = "https://appleid.apple.com/auth/keys";
export const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
export const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";
export const IOS_BUNDLE_ID = "com.theriot.named";

const JWKS_TTL_MS = 60 * 60 * 1000;
const SKEW_SECONDS = 60;

export class AppleTokenError extends Error {
  constructor(message, code = "invalid_token") {
    super(message);
    this.code = code;
  }
}

export const sha256hex = (value) => createHash("sha256").update(String(value), "utf8").digest("hex");

const b64urlJSON = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
const b64url = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

/** The audiences an identity token may carry: the iPhone bundle ID, plus the web Services ID once it exists. */
export function allowedAudiences(env = process.env) {
  return [IOS_BUNDLE_ID, env.APPLE_SERVICES_ID].filter(Boolean);
}

/** The private key in APPLE_SIWA_KEY, tolerating "\n" escapes and a missing PEM header. */
function privateKeyFrom(raw) {
  let pem = String(raw || "").replace(/\\n/g, "\n").trim();
  if (!pem.includes("BEGIN")) pem = `-----BEGIN PRIVATE KEY-----\n${pem}\n-----END PRIVATE KEY-----`;
  return createPrivateKey(pem);
}

export function siwaConfigured(env = process.env) {
  return Boolean(env.APPLE_SIWA_KEY_ID && env.APPLE_SIWA_KEY && env.APPLE_TEAM_ID);
}

export function createAppleAuth({ env = process.env, fetchImpl = (...args) => fetch(...args), now = () => Date.now() } = {}) {
  let jwks = null; // { keys: Map(kid -> KeyObject), at }

  async function loadKeys(force = false) {
    if (!force && jwks && now() - jwks.at < JWKS_TTL_MS) return jwks.keys;
    let payload;
    try {
      const response = await fetchImpl(APPLE_KEYS_URL, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("jwks");
      payload = await response.json();
    } catch {
      throw new AppleTokenError("Apple's sign-in keys are unreachable", "unavailable");
    }
    const keys = new Map();
    for (const jwk of payload?.keys || []) {
      if (jwk?.kty !== "RSA" || !jwk.kid) continue;
      try {
        keys.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
      } catch { /* skip a malformed key */ }
    }
    jwks = { keys, at: now() };
    return keys;
  }

  /**
   * Verifies an Apple identity token. `nonce` is the raw nonce the client sent; the token must
   * carry sha256hex(nonce). Returns { sub, email, aud }.
   */
  async function verifyIdentityToken(token, { nonce, audiences = allowedAudiences(env) } = {}) {
    const parts = typeof token === "string" ? token.split(".") : [];
    if (parts.length !== 3 || token.length > 8192) throw new AppleTokenError("Malformed identity token");
    let header;
    let claims;
    try {
      header = b64urlJSON(parts[0]);
      claims = b64urlJSON(parts[1]);
    } catch {
      throw new AppleTokenError("Malformed identity token");
    }
    if (header?.alg !== "RS256" || typeof header.kid !== "string") throw new AppleTokenError("Unsupported token algorithm");
    let keys = await loadKeys();
    if (!keys.has(header.kid)) keys = await loadKeys(true); // Apple rotated keys
    const key = keys.get(header.kid);
    if (!key) throw new AppleTokenError("Unknown signing key");
    const signed = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"));
    if (!signed) throw new AppleTokenError("Bad token signature");

    const seconds = Math.floor(now() / 1000);
    if (claims.iss !== APPLE_ISSUER) throw new AppleTokenError("Wrong token issuer");
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const matched = aud.find((value) => audiences.includes(value));
    if (!matched) throw new AppleTokenError("Wrong token audience");
    if (!Number.isFinite(claims.exp) || claims.exp + SKEW_SECONDS < seconds) throw new AppleTokenError("Token expired");
    if (Number.isFinite(claims.iat) && claims.iat - SKEW_SECONDS > seconds) throw new AppleTokenError("Token from the future");
    if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255) throw new AppleTokenError("Token has no user");
    if (typeof nonce !== "string" || !nonce || claims.nonce !== sha256hex(nonce)) {
      throw new AppleTokenError("Nonce does not match", "invalid_nonce");
    }
    const email = typeof claims.email === "string" && claims.email.length <= 320 ? claims.email : null;
    return { sub: claims.sub, email, aud: matched };
  }

  /** The ES256 client secret Apple wants for /auth/token and /auth/revoke. */
  function clientSecret(clientId) {
    const issuedAt = Math.floor(now() / 1000);
    const header = { alg: "ES256", kid: env.APPLE_SIWA_KEY_ID };
    const payload = { iss: env.APPLE_TEAM_ID, iat: issuedAt, exp: issuedAt + 300, aud: APPLE_ISSUER, sub: clientId };
    const input = `${b64url(header)}.${b64url(payload)}`;
    const signature = sign("sha256", Buffer.from(input), { key: privateKeyFrom(env.APPLE_SIWA_KEY), dsaEncoding: "ieee-p1363" });
    return `${input}.${signature.toString("base64url")}`;
  }

  async function form(url, fields) {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(fields).toString(),
    });
    return response;
  }

  /** Exchanges an authorization code for a refresh token. Null when not configured or Apple refuses. */
  async function exchangeCode(code, clientId) {
    if (!siwaConfigured(env) || typeof code !== "string" || !code || code.length > 1024) return null;
    try {
      const response = await form(APPLE_TOKEN_URL, {
        client_id: clientId,
        client_secret: clientSecret(clientId),
        code,
        grant_type: "authorization_code",
      });
      if (!response.ok) return null;
      const data = await response.json();
      return typeof data?.refresh_token === "string" ? data.refresh_token : null;
    } catch {
      return null;
    }
  }

  /** Revokes a refresh token. False when not configured or Apple refuses. */
  async function revoke(refreshToken, clientId) {
    if (!siwaConfigured(env) || !refreshToken || !clientId) return false;
    try {
      const response = await form(APPLE_REVOKE_URL, {
        client_id: clientId,
        client_secret: clientSecret(clientId),
        token: refreshToken,
        token_type_hint: "refresh_token",
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  return { verifyIdentityToken, exchangeCode, revoke, clientSecret };
}
