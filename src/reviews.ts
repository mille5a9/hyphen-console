// Pulls new reviews from both stores into SQLite, and says which ones are worth an email.
import { readFileSync } from "node:fs";
import type { AppConfig } from "./config.ts";
import type { Email } from "./mail.ts";
import { AppleClient } from "./stores/apple.ts";
import { GoogleClient, type ServiceAccount } from "./stores/google.ts";
import type { Review } from "./stores/review.ts";
import type { Store } from "./store.ts";

export interface ReviewSources {
  apple?: Pick<AppleClient, "reviews">;
  google?: Pick<GoogleClient, "reviews">;
}

export interface SyncResult {
  /** Reviews to tell someone about: new ones, and edits that changed the text or rating. */
  fresh: { review: Review; kind: "new" | "edited" }[];
  errors: string[];
}

/**
 * Syncs every app with each store it's set up for. The first successful sync of an app and store only fills the
 * history: those reviews aren't "fresh", so starting the console doesn't send an email for every old review.
 */
export async function syncReviews(apps: AppConfig[], store: Store, sources: ReviewSources, now = Date.now()): Promise<SyncResult> {
  const result: SyncResult = { fresh: [], errors: [] };
  const jobs: { app: AppConfig; name: "apple" | "google"; run: () => Promise<Review[]> }[] = [];
  for (const app of apps) {
    const ios = app.ios;
    if (sources.apple && (ios?.bundleId || ios?.appStoreId)) {
      const since = store.getSync(app.id, "apple")?.lastOk ?? 0;
      // Look back a day past the last good sync, in case a review showed up late.
      jobs.push({ app, name: "apple", run: () => sources.apple!.reviews(app.id, ios, since ? since - 86_400_000 : 0) });
    }
    const pkg = app.android?.package;
    if (sources.google && pkg) jobs.push({ app, name: "google", run: () => sources.google!.reviews(app.id, pkg) });
  }
  for (const job of jobs) {
    const firstSync = !store.getSync(job.app.id, job.name)?.lastOk;
    try {
      const reviews = await job.run();
      for (const r of reviews) {
        const kind = store.saveReview(r, now);
        if (!firstSync && kind !== "same") result.fresh.push({ review: r, kind });
      }
      store.setSync(job.app.id, job.name, now, null);
    } catch (e) {
      const msg = (e as Error).message;
      store.setSync(job.app.id, job.name, now, msg);
      result.errors.push(`${job.app.id} ${job.name}: ${msg}`);
    }
  }
  return result;
}

/** Store clients from secrets files; a store without credentials is skipped. */
export function sourcesFromEnv(env: NodeJS.ProcessEnv, log: (line: string) => void): ReviewSources {
  const sources: ReviewSources = {};
  const secrets = env.SECRETS_DIR ?? "/secrets";
  const read = (file: string) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  };

  const p8 = read(env.APP_STORE_CONNECT_KEY_FILE ?? `${secrets}/app-store-connect.p8`);
  if (p8 && env.APP_STORE_CONNECT_KEY_ID && env.APP_STORE_CONNECT_ISSUER_ID) {
    try {
      sources.apple = new AppleClient({ keyId: env.APP_STORE_CONNECT_KEY_ID, issuerId: env.APP_STORE_CONNECT_ISSUER_ID, privateKey: p8 });
    } catch (e) {
      log(`App Store Connect key unusable: ${(e as Error).message}`);
    }
  } else if (p8 || env.APP_STORE_CONNECT_KEY_ID) {
    log("App Store Connect needs the .p8 key file, APP_STORE_CONNECT_KEY_ID and APP_STORE_CONNECT_ISSUER_ID: skipping Apple reviews");
  }

  const sa = read(env.GOOGLE_SERVICE_ACCOUNT_FILE ?? `${secrets}/google-play-service-account.json`);
  if (sa) {
    try {
      sources.google = new GoogleClient({ account: JSON.parse(sa) as ServiceAccount });
    } catch (e) {
      log(`Google service account file unusable: ${(e as Error).message}`);
    }
  }
  return sources;
}

const stars = (n: number) => "★".repeat(n) + "☆".repeat(Math.max(0, 5 - n));
const storeName = (s: Review["store"]) => (s === "apple" ? "App Store" : "Google Play");

export type ReviewEmails = "all" | "low" | "off";

export function reviewEmail(fresh: SyncResult["fresh"], apps: AppConfig[], mode: ReviewEmails, consoleUrl?: string): Email | null {
  const picked = fresh.filter(({ review }) => mode === "all" || (mode === "low" && review.rating <= 2));
  if (!picked.length) return null;
  const names = new Map(apps.map((a) => [a.id, a.name]));
  const low = picked.filter(({ review }) => review.rating <= 2).length;
  const appNames = [...new Set(picked.map(({ review }) => names.get(review.appId) ?? review.appId))].join(", ");
  const count = picked.length === 1 ? `${stars(picked[0]!.review.rating)} review` : `${picked.length} reviews`;
  const subject = `${low ? "[low rating] " : ""}${appNames}: ${picked.length === 1 && picked[0]!.kind === "edited" ? "updated " : "new "}${count}`;
  const blocks = picked.map(({ review: r, kind }) => {
    const head = `${stars(r.rating)}  ${names.get(r.appId) ?? r.appId} · ${storeName(r.store)}${kind === "edited" ? " · edited" : ""}`;
    const meta = [r.author && `by ${r.author}`, r.locale, r.appVersion && `v${r.appVersion}`, r.device].filter(Boolean).join(" · ");
    return [head, meta, "", r.title, r.body].filter((x, i) => x || i === 2).join("\n").trim();
  });
  const links = consoleUrl ? `\n\nConsole: ${[...new Set(picked.map(({ review }) => `${consoleUrl.replace(/\/$/, "")}/apps/${review.appId}`))].join("  ")}` : "";
  const hint = "\n\nReply in App Store Connect (Ratings and Reviews) or Play Console (Ratings and reviews). Replies are public, and a reply often earns a better rating.";
  return { subject, text: blocks.join("\n\n———\n\n") + hint + links };
}
