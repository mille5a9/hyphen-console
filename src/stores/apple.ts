// App Store Connect API: customer reviews. Auth is a short-lived ES256 JWT signed with a team API key.
import { createPrivateKey, type KeyObject } from "node:crypto";
import { signJwt, TokenCache } from "../jwt.ts";
import { type Review, StoreApiError } from "./review.ts";

const API = "https://api.appstoreconnect.apple.com";

export interface AppleOptions {
  keyId: string;
  issuerId: string;
  /** Contents of the .p8 private key. */
  privateKey: string;
  fetch?: typeof fetch;
  now?: () => number;
}

interface ReviewResource {
  id: string;
  attributes: { rating: number; title?: string; body?: string; reviewerNickname?: string; createdDate: string; territory?: string };
  relationships?: { response?: { data?: { id: string } | null } };
}
interface ResponseResource {
  id: string;
  type: string;
  attributes: { responseBody?: string; lastModifiedDate?: string; state?: string };
}

export class AppleClient {
  opts: Required<AppleOptions>;
  key: KeyObject;
  tokens = new TokenCache();
  appIds = new Map<string, string>();

  constructor(opts: AppleOptions) {
    this.opts = { fetch: globalThis.fetch, now: Date.now, ...opts };
    this.key = createPrivateKey(opts.privateKey);
  }

  async token(): Promise<string> {
    const now = this.opts.now();
    return this.tokens.get(now, async () => {
      const iat = Math.floor(now / 1000);
      const exp = iat + 15 * 60; // Apple refuses tokens that live longer than 20 minutes
      const token = signJwt({ alg: "ES256", kid: this.opts.keyId, typ: "JWT" }, { iss: this.opts.issuerId, iat, exp, aud: "appstoreconnect-v1" }, this.key);
      return { token, expiresAt: exp * 1000 };
    });
  }

  async get<T>(pathOrUrl: string): Promise<T> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : API + pathOrUrl;
    const res = await this.opts.fetch(url, { headers: { Authorization: `Bearer ${await this.token()}` }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { errors?: { title?: string; detail?: string }[] } | null;
      const why = data?.errors?.map((e) => e.detail || e.title).join("; ") || res.statusText;
      throw new StoreApiError(`App Store Connect ${res.status}: ${why}`, res.status);
    }
    return (await res.json()) as T;
  }

  /** The App Store Connect id for a bundle id (looked up once). */
  async appId(bundleId: string): Promise<string> {
    const known = this.appIds.get(bundleId);
    if (known) return known;
    const data = await this.get<{ data: { id: string }[] }>(`/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&fields[apps]=bundleId&limit=2`);
    const id = data.data[0]?.id;
    if (!id) throw new StoreApiError(`No app with bundle id ${bundleId} is visible to this API key`, 404);
    this.appIds.set(bundleId, id);
    return id;
  }

  /** Newest reviews first, stopping at `since` (epoch ms) or after `maxPages` pages of 200. */
  async reviews(consoleAppId: string, ios: { bundleId?: string; appStoreId?: string }, since = 0, maxPages = 10): Promise<Review[]> {
    const id = ios.appStoreId ?? (await this.appId(ios.bundleId ?? ""));
    let next: string | undefined = `/v1/apps/${id}/customerReviews?sort=-createdDate&limit=200&include=response`;
    const out: Review[] = [];
    for (let page = 0; next && page < maxPages; page++) {
      const data: { data: ReviewResource[]; included?: ResponseResource[]; links?: { next?: string } } = await this.get(next);
      const replies = new Map((data.included ?? []).filter((r) => r.type === "customerReviewResponses").map((r) => [r.id, r]));
      let reachedOld = false;
      for (const r of data.data) {
        const at = Date.parse(r.attributes.createdDate);
        if (at < since) reachedOld = true;
        const reply = replies.get(r.relationships?.response?.data?.id ?? "");
        out.push({
          store: "apple",
          appId: consoleAppId,
          id: r.id,
          rating: r.attributes.rating,
          title: r.attributes.title ?? "",
          body: r.attributes.body ?? "",
          author: r.attributes.reviewerNickname ?? "",
          locale: r.attributes.territory ?? "",
          appVersion: "",
          device: "",
          updatedAt: at,
          reply: reply?.attributes.responseBody
            ? { text: reply.attributes.responseBody, at: Date.parse(reply.attributes.lastModifiedDate ?? "") || 0 }
            : null,
        });
      }
      next = reachedOld ? undefined : data.links?.next;
    }
    return out;
  }
}
