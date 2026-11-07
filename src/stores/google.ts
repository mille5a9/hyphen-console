// Google Play Developer API: reviews. Auth is a service account exchanging a signed RS256 JWT for an access token.
import { signJwt, TokenCache } from "../jwt.ts";
import { type Review, StoreApiError } from "./review.ts";

const API = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface GoogleOptions {
  account: ServiceAccount;
  fetch?: typeof fetch;
  now?: () => number;
}

interface PlayReview {
  reviewId: string;
  authorName?: string;
  comments?: {
    userComment?: {
      text?: string;
      lastModified?: { seconds?: string };
      starRating?: number;
      reviewerLanguage?: string;
      device?: string;
      appVersionName?: string;
    };
    developerComment?: { text?: string; lastModified?: { seconds?: string } };
  }[];
}

export class GoogleClient {
  opts: Required<GoogleOptions>;
  tokens = new TokenCache();

  constructor(opts: GoogleOptions) {
    if (!opts.account.client_email || !opts.account.private_key) throw new Error("service account JSON needs client_email and private_key");
    this.opts = { fetch: globalThis.fetch, now: Date.now, ...opts };
  }

  async token(): Promise<string> {
    const now = this.opts.now();
    return this.tokens.get(now, async () => {
      const { client_email, private_key, token_uri = "https://oauth2.googleapis.com/token" } = this.opts.account;
      const iat = Math.floor(now / 1000);
      const assertion = signJwt({ alg: "RS256", typ: "JWT" }, { iss: client_email, scope: SCOPE, aud: token_uri, iat, exp: iat + 3600 }, private_key);
      const res = await this.opts.fetch(token_uri, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
        signal: AbortSignal.timeout(30_000),
      });
      const data = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number; error_description?: string; error?: string } | null;
      if (!res.ok || !data?.access_token) {
        throw new StoreApiError(`Google sign-in ${res.status}: ${data?.error_description ?? data?.error ?? res.statusText}`, res.status);
      }
      return { token: data.access_token, expiresAt: now + (data.expires_in ?? 3600) * 1000 };
    });
  }

  /** Reviews with text, written or edited in the last week (all Google's API offers). */
  async reviews(consoleAppId: string, packageName: string, maxPages = 20): Promise<Review[]> {
    const out: Review[] = [];
    let token: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const url = new URL(`${API}/applications/${encodeURIComponent(packageName)}/reviews`);
      url.searchParams.set("maxResults", "100");
      if (token) url.searchParams.set("token", token);
      const res = await this.opts.fetch(url, { headers: { Authorization: `Bearer ${await this.token()}` }, signal: AbortSignal.timeout(30_000) });
      const data = (await res.json().catch(() => null)) as {
        reviews?: PlayReview[];
        tokenPagination?: { nextPageToken?: string };
        error?: { message?: string };
      } | null;
      if (!res.ok) throw new StoreApiError(`Google Play ${res.status}: ${data?.error?.message ?? res.statusText}`, res.status);
      for (const r of data?.reviews ?? []) {
        const user = r.comments?.find((c) => c.userComment)?.userComment;
        if (!user) continue;
        const dev = r.comments?.find((c) => c.developerComment)?.developerComment;
        // Google puts the title and body in one field, split by a tab.
        const [first = "", ...rest] = (user.text ?? "").split("\t");
        const [title, body] = rest.length ? [first.trim(), rest.join("\t").trim()] : ["", first.trim()];
        out.push({
          store: "google",
          appId: consoleAppId,
          id: r.reviewId,
          rating: user.starRating ?? 0,
          title,
          body,
          author: r.authorName ?? "",
          locale: user.reviewerLanguage ?? "",
          appVersion: user.appVersionName ?? "",
          device: user.device ?? "",
          updatedAt: Number(user.lastModified?.seconds ?? 0) * 1000,
          reply: dev?.text ? { text: dev.text, at: Number(dev.lastModified?.seconds ?? 0) * 1000 } : null,
        });
      }
      token = data?.tokenPagination?.nextPageToken;
      if (!token) break;
    }
    return out;
  }
}
