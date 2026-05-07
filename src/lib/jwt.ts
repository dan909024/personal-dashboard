/**
 * Minimal HS256 JWT sign/verify, no external deps. Kept tiny on purpose —
 * if requirements grow (asymmetric keys, JWKs, kid rotation) replace with
 * `jose` rather than expanding this.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function b64urlDecode(s: string): Buffer {
  const padded =
    s.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice(0, (4 - (s.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

export type JWTPayload = Record<string, unknown> & { iat?: number; exp?: number };

export function signJWT(
  payload: JWTPayload,
  secret: string,
  expiresInSeconds: number
): string {
  if (!secret) throw new Error("signJWT: empty secret");
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body: JWTPayload = { ...payload, iat: now, exp: now + expiresInSeconds };
  const headerEnc = b64url(JSON.stringify(header));
  const bodyEnc = b64url(JSON.stringify(body));
  const signing = `${headerEnc}.${bodyEnc}`;
  const sig = createHmac("sha256", secret).update(signing).digest();
  return `${signing}.${b64url(sig)}`;
}

export type VerifyResult =
  | { ok: true; payload: JWTPayload }
  | { ok: false; reason: "format" | "signature" | "expired" | "payload" };

export function verifyJWT(token: string, secret: string): VerifyResult {
  if (!secret) return { ok: false, reason: "signature" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "format" };
  const [h, p, s] = parts;
  const expected = b64url(createHmac("sha256", secret).update(`${h}.${p}`).digest());
  if (s.length !== expected.length) return { ok: false, reason: "signature" };
  // timingSafeEqual on equal-length Buffers
  const provided = Buffer.from(s);
  const expectedBuf = Buffer.from(expected);
  if (!timingSafeEqual(provided, expectedBuf)) {
    return { ok: false, reason: "signature" };
  }
  let payload: JWTPayload;
  try {
    payload = JSON.parse(b64urlDecode(p).toString("utf8")) as JWTPayload;
  } catch {
    return { ok: false, reason: "payload" };
  }
  if (typeof payload.exp === "number") {
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) return { ok: false, reason: "expired" };
  }
  return { ok: true, payload };
}
