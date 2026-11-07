// Signed tokens for the store APIs, with node:crypto alone: ES256 for App Store Connect, RS256 for Google.
import { createPrivateKey, sign, type KeyObject } from "node:crypto";

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

export function signJwt(header: Record<string, unknown>, payload: Record<string, unknown>, key: KeyObject | string): string {
  const k = typeof key === "string" ? createPrivateKey(key) : key;
  const alg = header.alg;
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  let sig: Buffer;
  if (alg === "ES256") {
    // JWT wants the raw r||s form, not DER.
    sig = sign("sha256", Buffer.from(input), { key: k, dsaEncoding: "ieee-p1363" });
  } else if (alg === "RS256") {
    sig = sign("sha256", Buffer.from(input), k);
  } else {
    throw new Error(`Unsupported JWT alg ${String(alg)}`);
  }
  return `${input}.${b64url(sig)}`;
}

/** Caches a token until shortly before it expires. */
export class TokenCache {
  token = "";
  until = 0;
  async get(now: number, make: () => Promise<{ token: string; expiresAt: number }>): Promise<string> {
    if (this.token && now < this.until - 60_000) return this.token;
    const t = await make();
    this.token = t.token;
    this.until = t.expiresAt;
    return t.token;
  }
}
