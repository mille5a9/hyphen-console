// Crash and ANR rates from Google Play, crashes and sessions from the App Store, and alerts when an app crosses Play's
// bad-behavior thresholds.
import { readFileSync } from "node:fs";
import type { AppConfig } from "./config.ts";
import type { Email } from "./mail.ts";
import { AppleClient } from "./stores/apple.ts";
import { APPLE_REPORTS, AppleAnalytics, pickReport } from "./stores/apple-analytics.ts";
import type { GoogleClient } from "./stores/google.ts";
import { step } from "./health.ts";
import type { Store } from "./store.ts";

/**
 * Google Play's bad-behavior thresholds for user-perceived crash and ANR rates (28-day, user-weighted). Above them,
 * Play may show the app to fewer people. https://developer.android.com/topic/performance/vitals
 */
export const PLAY_THRESHOLDS = { crash: 0.0109, anr: 0.0047 };

const GOOGLE_CRASH = ["crashRate", "userPerceivedCrashRate", "userPerceivedCrashRate28dUserWeighted", "distinctUsers"];
const GOOGLE_ANR = ["anrRate", "userPerceivedAnrRate", "userPerceivedAnrRate28dUserWeighted", "distinctUsers"];

/** The API calls these rates percentages but sends fractions (0.0109 is 1.09%). Guard against a switch to 0-100. */
const asFraction = (metric: string, v: number) => (/Rate/.test(metric) && v > 1 ? v / 100 : v);

export interface VitalsSources {
  google?: Pick<GoogleClient, "vitals">;
  apple?: AppleAnalytics;
}

export interface VitalsAlert {
  kind: "over" | "back";
  app: AppConfig;
  which: "crash" | "anr";
  value: number;
  threshold: number;
  date: string;
}

export interface VitalsResult {
  alerts: VitalsAlert[];
  errors: string[];
}

export async function syncVitals(apps: AppConfig[], store: Store, sources: VitalsSources, now = Date.now()): Promise<VitalsResult> {
  const result: VitalsResult = { alerts: [], errors: [] };
  for (const app of apps) {
    const pkg = app.android?.package;
    if (sources.google && pkg) {
      try {
        const google = sources.google;
        const [crash, anr] = await Promise.all([google.vitals(pkg, "crashRateMetricSet", GOOGLE_CRASH), google.vitals(pkg, "anrRateMetricSet", GOOGLE_ANR)]);
        for (const row of [...crash, ...anr]) {
          for (const [metric, v] of Object.entries(row.values)) store.setMetric(app.id, "google", metric, row.date, asFraction(metric, v));
        }
        result.alerts.push(...thresholdAlerts(app, store, now));
        store.setSync(app.id, "google-vitals", now, null);
      } catch (e) {
        store.setSync(app.id, "google-vitals", now, (e as Error).message);
        result.errors.push(`${app.id} google vitals: ${(e as Error).message}`);
      }
    }
    const ios = app.ios;
    if (sources.apple && (ios?.bundleId || ios?.appStoreId)) {
      try {
        await syncApple(app, store, sources.apple, now);
        store.setSync(app.id, "apple-vitals", now, null);
      } catch (e) {
        store.setSync(app.id, "apple-vitals", now, (e as Error).message);
        result.errors.push(`${app.id} apple analytics: ${(e as Error).message}`);
      }
    }
  }
  return result;
}

async function syncApple(app: AppConfig, store: Store, analytics: AppleAnalytics, now: number) {
  const appleId = app.ios!.appStoreId ?? (await analytics.client.appId(app.ios!.bundleId!));
  const req = await analytics.ensureRequest(appleId);
  const metaKey = `apple-request:${app.id}`;
  const known = JSON.parse(store.getMeta(metaKey) ?? "null") as { id: string; createdAt: number } | null;
  if (known?.id !== req.id) store.setMeta(metaKey, JSON.stringify({ id: req.id, createdAt: req.created ? now : (known?.createdAt ?? null) }));
  const reports = await analytics.usageReports(req.id);
  for (const want of APPLE_REPORTS) {
    const report = pickReport(reports, want.name);
    if (!report) continue; // Apple hasn't generated it yet
    for (const inst of await analytics.dailyInstances(report.id)) {
      if (store.instanceDone(inst.id)) continue;
      store.addInstance(inst.id, app.id, want.metric, await analytics.instanceTotals(inst.id, want.column), now);
    }
  }
}

function thresholdAlerts(app: AppConfig, store: Store, now: number): VitalsAlert[] {
  const out: VitalsAlert[] = [];
  const checks = [
    { which: "crash" as const, metric: "userPerceivedCrashRate28dUserWeighted", threshold: PLAY_THRESHOLDS.crash },
    { which: "anr" as const, metric: "userPerceivedAnrRate28dUserWeighted", threshold: PLAY_THRESHOLDS.anr },
  ];
  for (const c of checks) {
    const latest = store.metricSeries(app.id, "google", [c.metric], "0000").filter((r) => c.metric in r.values).at(-1);
    if (!latest) continue;
    const value = latest.values[c.metric]!;
    const key = `vitals:${app.id}:${c.which}`;
    // Same up/down bookkeeping as health checks: "down" here means over the threshold, alerting on the first day over.
    const { state, transition } = step(store.getState(key), { key, at: now, ok: value < c.threshold, status: null, ms: 0, error: null }, 1);
    store.setState(state);
    if (transition) out.push({ kind: transition === "down" ? "over" : "back", app, which: c.which, value, threshold: c.threshold, date: latest.date });
  }
  return out;
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

export function vitalsEmail(a: VitalsAlert, consoleUrl?: string): Email {
  const what = a.which === "crash" ? "user-perceived crash rate" : "user-perceived ANR rate";
  const link = consoleUrl ? `\n\nConsole: ${consoleUrl.replace(/\/$/, "")}/apps/${a.app.id}` : "";
  if (a.kind === "over") {
    return {
      subject: `[vitals] ${a.app.name}: ${what} over Play's limit`,
      text:
        `${a.app.name}'s 28-day ${what} on Google Play is ${pct(a.value)} (data through ${a.date}). Play's bad-behavior threshold is ${pct(a.threshold)}.\n\n` +
        `Above it, Google Play may show the app to fewer people and warn users on its store listing. Android vitals in Play Console lists the clusters behind it.${link}`,
    };
  }
  return {
    subject: `[vitals] ${a.app.name}: ${what} back under Play's limit`,
    text: `${a.app.name}'s 28-day ${what} is ${pct(a.value)} (data through ${a.date}), under Play's ${pct(a.threshold)} threshold again.${link}`,
  };
}

/** What the page shows for one app. */
export function vitalsView(app: AppConfig, store: Store, sources: VitalsSources, now = Date.now()) {
  const from = new Date(now - 30 * 86_400_000).toISOString().slice(0, 10);
  const google = sources.google && app.android?.package
    ? (() => {
        const series = store.metricSeries(app.id, "google", [...new Set([...GOOGLE_CRASH, ...GOOGLE_ANR])], from);
        const latest = series.filter((r) => "userPerceivedCrashRate28dUserWeighted" in r.values).at(-1);
        return {
          sync: store.getSync(app.id, "google-vitals") ?? null,
          thresholds: PLAY_THRESHOLDS,
          latest: latest && {
            date: latest.date,
            crash28d: latest.values.userPerceivedCrashRate28dUserWeighted ?? null,
            anr28d: latest.values.userPerceivedAnrRate28dUserWeighted ?? null,
            users: latest.values.distinctUsers ?? null,
          },
          series: series.map((r) => ({ date: r.date, crash: r.values.userPerceivedCrashRate ?? null, anr: r.values.userPerceivedAnrRate ?? null, users: r.values.distinctUsers ?? null })),
        };
      })()
    : undefined;
  const apple = sources.apple && (app.ios?.bundleId || app.ios?.appStoreId)
    ? (() => {
        const series = store.metricSeries(app.id, "apple", ["crashes", "sessions"], from);
        const week = series.slice(-7);
        const crashes = week.reduce((n, r) => n + (r.values.crashes ?? 0), 0);
        const sessions = week.reduce((n, r) => n + (r.values.sessions ?? 0), 0);
        const req = JSON.parse(store.getMeta(`apple-request:${app.id}`) ?? "null") as { createdAt: number | null } | null;
        return {
          sync: store.getSync(app.id, "apple-vitals") ?? null,
          requestedAt: req?.createdAt ?? null,
          last7: series.length ? { crashes, sessions, per1k: sessions ? (crashes / sessions) * 1000 : null, through: series.at(-1)!.date } : null,
          series: series.map((r) => ({ date: r.date, crashes: r.values.crashes ?? 0, sessions: r.values.sessions ?? 0 })),
        };
      })()
    : undefined;
  return { google, apple };
}

/** Sources from the secrets folder. Apple analytics needs its own key (Finance role), separate from the reviews key. */
export function vitalsSourcesFromEnv(env: NodeJS.ProcessEnv, google: GoogleClient | undefined, log: (line: string) => void): VitalsSources {
  const sources: VitalsSources = { google };
  const file = env.APP_STORE_CONNECT_FINANCE_KEY_FILE ?? `${env.SECRETS_DIR ?? "/secrets"}/app-store-connect-finance.p8`;
  let p8: string | null = null;
  try {
    p8 = readFileSync(file, "utf8");
  } catch {}
  const keyId = env.APP_STORE_CONNECT_FINANCE_KEY_ID;
  const issuerId = env.APP_STORE_CONNECT_ISSUER_ID;
  if (p8 && keyId && issuerId) {
    try {
      sources.apple = new AppleAnalytics(new AppleClient({ keyId, issuerId, privateKey: p8 }));
    } catch (e) {
      log(`App Store Connect finance key unusable: ${(e as Error).message}`);
    }
  } else if (p8 || keyId) {
    log("Apple analytics needs the finance .p8 file, APP_STORE_CONNECT_FINANCE_KEY_ID and APP_STORE_CONNECT_ISSUER_ID: skipping");
  }
  return sources;
}
