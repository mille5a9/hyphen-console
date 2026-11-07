// Entry point. All settings come from the environment (see .env.example); nothing machine-specific is in the code.
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ALLOWED, makeAllowlist } from "./access.ts";
import { createHandler } from "./app.ts";
import { loadApps } from "./config.ts";
import { Monitor } from "./health.ts";
import { alertEmail, mailerFromEnv } from "./mail.ts";
import type { GoogleClient } from "./stores/google.ts";
import { reviewEmail, type ReviewEmails, sourcesFromEnv, syncReviews } from "./reviews.ts";
import { Store } from "./store.ts";
import { syncVitals, vitalsEmail, vitalsSourcesFromEnv, vitalsView } from "./vitals.ts";

const env = process.env;
const port = Number(env.PORT ?? 8080);
const host = env.HOST ?? "::";
const configFile = env.CONFIG_FILE ?? "config/apps.json";
const buildsRoot = env.BUILDS_ROOT ?? "builds";
const dataDir = env.DATA_DIR ?? "data";
const cidrs = env.ALLOWED_CIDRS ? env.ALLOWED_CIDRS.split(",").filter(Boolean) : DEFAULT_ALLOWED;
const intervalMs = Math.max(30, Number(env.CHECK_INTERVAL_SECONDS || 120)) * 1000;
const failThreshold = Math.max(1, Number(env.CHECK_FAIL_THRESHOLD || 2));
const reviewEveryMs = Math.max(15, Number(env.REVIEW_SYNC_MINUTES || 60)) * 60_000;
const vitalsEveryMs = Math.max(1, Number(env.VITALS_SYNC_HOURS || 6)) * 3_600_000;
const reviewEmails = (["all", "low", "off"].includes(env.REVIEW_EMAILS ?? "") ? env.REVIEW_EMAILS : "all") as ReviewEmails;

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

const apps = loadApps(configFile);
const store = new Store(join(dataDir, "console.db"));
const monitor = new Monitor({ apps, store, failThreshold });
const mailer = mailerFromEnv(env, log);
const sources = sourcesFromEnv(env, log);
const vitalsSources = vitalsSourcesFromEnv(env, sources.google as GoogleClient | undefined, log);

const handler = createHandler({
  apps,
  buildsRoot,
  publicDir: fileURLToPath(new URL("../public/", import.meta.url)),
  isAllowed: makeAllowlist(cidrs),
  status: () => monitor.status(),
  reviews: (appId) => ({
    summary: store.reviewSummary(appId, Date.now() - 7 * 86_400_000),
    sync: { apple: sources.apple ? (store.getSync(appId, "apple") ?? null) : undefined, google: sources.google ? (store.getSync(appId, "google") ?? null) : undefined },
    reviews: store.reviews(appId, 50),
  }),
  vitals: (appId) => vitalsView(apps.find((a) => a.id === appId)!, store, vitalsSources),
  log,
});

const server = createServer(handler);
server.listen(port, host, () => log(`hyphen-console on ${host}:${port}, ${apps.length} app(s): ${apps.map((a) => a.id).join(", ")}`));

// Health checks. One run at a time: a slow round never overlaps the next.
const checkCount = apps.reduce((n, a) => n + a.health.length, 0);
let timer: NodeJS.Timeout | undefined;
async function round() {
  try {
    for (const t of await monitor.tick()) {
      log(`${t.kind}: ${t.check.key} (${t.result.error ?? `HTTP ${t.result.status}`})`);
      await mailer.send(alertEmail(t, env.CONSOLE_URL)).catch((e) => log(`alert email failed: ${(e as Error).message}`));
    }
  } catch (e) {
    log(`health round failed: ${(e as Error).stack ?? e}`);
  }
  timer = setTimeout(round, intervalMs);
}
if (checkCount) {
  log(`${checkCount} health check(s) every ${intervalMs / 1000}s, down after ${failThreshold} failure(s) in a row; alerts: ${mailer.describe()}`);
  void round();
}

// Reviews from both stores.
let reviewTimer: NodeJS.Timeout | undefined;
async function reviewRound() {
  try {
    const { fresh, errors } = await syncReviews(apps, store, sources);
    for (const e of errors) log(`review sync: ${e}`);
    if (fresh.length) log(`${fresh.length} new or edited review(s)`);
    const email = reviewEmail(fresh, apps, reviewEmails, env.CONSOLE_URL);
    if (email) await mailer.send(email).catch((e) => log(`review email failed: ${(e as Error).message}`));
  } catch (e) {
    log(`review round failed: ${(e as Error).stack ?? e}`);
  }
  reviewTimer = setTimeout(reviewRound, reviewEveryMs);
}
const reviewStores = [sources.apple && "App Store", sources.google && "Google Play"].filter(Boolean);
if (reviewStores.length) {
  log(`reviews from ${reviewStores.join(" and ")} every ${reviewEveryMs / 60_000} min; review emails: ${reviewEmails}`);
  void reviewRound();
}

// Vitals: Play's crash and ANR rates, App Store crashes and sessions. Both stores update daily.
let vitalsTimer: NodeJS.Timeout | undefined;
async function vitalsRound() {
  try {
    const { alerts, errors } = await syncVitals(apps, store, vitalsSources);
    for (const e of errors) log(`vitals sync: ${e}`);
    for (const a of alerts) {
      log(`vitals ${a.kind}: ${a.app.id} ${a.which} ${a.value}`);
      await mailer.send(vitalsEmail(a, env.CONSOLE_URL)).catch((e) => log(`vitals email failed: ${(e as Error).message}`));
    }
  } catch (e) {
    log(`vitals round failed: ${(e as Error).stack ?? e}`);
  }
  vitalsTimer = setTimeout(vitalsRound, vitalsEveryMs);
}
const vitalsStores = [vitalsSources.google && "Google Play", vitalsSources.apple && "App Store"].filter(Boolean);
if (vitalsStores.length) {
  log(`vitals from ${vitalsStores.join(" and ")} every ${vitalsEveryMs / 3_600_000} h`);
  void vitalsRound();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearTimeout(timer);
    clearTimeout(reviewTimer);
    clearTimeout(vitalsTimer);
    server.close(() => {
      store.close();
      process.exit(0);
    });
    server.closeAllConnections();
  });
}
