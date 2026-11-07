// Google Play APIs: reviews (Developer API) and vitals (Reporting API). Auth is a service account exchanging a
// signed RS256 JWT for an access token, one per scope.
import { signJwt, TokenCache } from "../jwt.ts";
import { type Review, StoreApiError } from "./review.ts";

const API = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const REPORTING = "https://playdeveloperreporting.googleapis.com/v1beta1";
export const SCOPES = {
  publisher: "https://www.googleapis.com/auth/androidpublisher",
  reporting: "https://www.googleapis.com/auth/playdeveloperreporting",
};

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

/** A Play Reporting API date: midnight in Los Angeles, the only time zone its daily metrics support. */
export interface PlayDate {
  year: number;
  month: number;
  day: number;
}
const LA = { id: "America/Los_Angeles" };
const playDate = (d: PlayDate) => ({ year: d.year, month: d.month, day: d.day, timeZone: LA });
export const isoDate = (d: PlayDate) => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
function addDays(d: PlayDate, n: number): PlayDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

export interface VitalsRow {
  date: string;
  values: Record<string, number>;
}

export class GoogleClient {
  opts: Required<GoogleOptions>;
  tokens = new Map<string, TokenCache>();

  constructor(opts: GoogleOptions) {
    if (!opts.account.client_email || !opts.account.private_key) throw new Error("service account JSON needs client_email and private_key");
    this.opts = { fetch: globalThis.fetch, now: Date.now, ...opts };
  }

  async token(scope = SCOPES.publisher): Promise<string> {
    const now = this.opts.now();
    let cache = this.tokens.get(scope);
    if (!cache) this.tokens.set(scope, (cache = new TokenCache()));
    return cache.get(now, async () => {
      const { client_email, private_key, token_uri = "https://oauth2.googleapis.com/token" } = this.opts.account;
      const iat = Math.floor(now / 1000);
      const assertion = signJwt({ alg: "RS256", typ: "JWT" }, { iss: client_email, scope, aud: token_uri, iat, exp: iat + 3600 }, private_key);
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
      const res = await this.opts.fetch(url, { headers: { Authorization: `Bearer ${await this.token(SCOPES.publisher)}` }, signal: AbortSignal.timeout(30_000) });
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

  async reporting<T>(path: string, body?: unknown): Promise<T> {
    const res = await this.opts.fetch(`${REPORTING}/${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${await this.token(SCOPES.reporting)}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
    if (!res.ok || !data) throw new StoreApiError(`Play Reporting ${res.status}: ${data?.error?.message ?? res.statusText}`, res.status);
    return data;
  }

  /**
   * Daily values of a vitals metric set (crashRateMetricSet or anrRateMetricSet) for the last `days` days that have
   * data. Returns nothing while Play has no data yet (a new app, or one not in production).
   * Ask for at least one daily metric (crashRate, anrRate...): a query for rolling metrics alone comes back empty.
   */
  async vitals(packageName: string, metricSet: "crashRateMetricSet" | "anrRateMetricSet", metrics: string[], days = 30): Promise<VitalsRow[]> {
    const base = `apps/${encodeURIComponent(packageName)}/${metricSet}`;
    const info = await this.reporting<{ freshnessInfo?: { freshnesses?: { aggregationPeriod?: string; latestEndTime?: PlayDate }[] } }>(base);
    const end = info.freshnessInfo?.freshnesses?.find((f) => f.aggregationPeriod === "DAILY")?.latestEndTime;
    if (!end?.year) return [];
    const rows: VitalsRow[] = [];
    let pageToken: string | undefined;
    do {
      const data: {
        rows?: { startTime?: PlayDate; metrics?: { metric?: string; decimalValue?: { value?: string } }[] }[];
        nextPageToken?: string;
      } = await this.reporting(`${base}:query`, {
        timelineSpec: { aggregationPeriod: "DAILY", startTime: playDate(addDays(end, -days)), endTime: playDate(end) },
        metrics,
        pageSize: 1000,
        ...(pageToken && { pageToken }),
      });
      for (const r of data.rows ?? []) {
        if (!r.startTime?.year) continue;
        const values: Record<string, number> = {};
        for (const m of r.metrics ?? []) {
          const v = Number(m.decimalValue?.value);
          if (m.metric && Number.isFinite(v)) values[m.metric] = v;
        }
        rows.push({ date: isoDate(r.startTime), values });
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    return rows;
  }
}
