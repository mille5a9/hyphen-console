// The weekly digest: one email per week covering each app's uptime, reviews, vitals and new builds, with anything
// that needs attention listed first.
import { join } from "node:path";
import { listBuilds } from "./builds.ts";
import type { AppConfig } from "./config.ts";
import { fmtDuration, type Email } from "./mail.ts";
import type { Store } from "./store.ts";
import { PLAY_THRESHOLDS } from "./vitals.ts";

const DAY = 86_400_000;
const pct = (v: number | null | undefined, digits = 2) => (v === null || v === undefined ? "–" : `${(v * 100).toFixed(digits)}%`);
const stars = (n: number) => "★".repeat(n) + "☆".repeat(Math.max(0, 5 - n));
const storeName = (s: string) => (s === "apple" ? "App Store" : "Google Play");
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const num = (n: number) => n.toLocaleString("en-US");

export interface DigestOptions {
  apps: AppConfig[];
  store: Store;
  buildsRoot: string;
  now: number;
  timeZone?: string;
  consoleUrl?: string;
}

interface Section {
  lines: string[];
  attention: string[];
}

export async function buildDigest(opts: DigestOptions): Promise<Email> {
  const { apps, now } = opts;
  const from = now - 7 * DAY;
  const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: opts.timeZone || "UTC" });
  const sections: { app: AppConfig; body: Section }[] = [];
  for (const app of apps) sections.push({ app, body: await appSection(app, opts, from) });

  const attention = sections.flatMap(({ app, body }) => body.attention.map((a) => (apps.length > 1 ? `${app.name}: ${a}` : a)));
  const subject = `Weekly digest, ${day(from)}–${day(now - 1)}: ${attention.length ? `${attention.length} thing${attention.length > 1 ? "s" : ""} to look at` : "all good"}`;
  const head = attention.length ? `Needs a look\n${attention.map((a) => `  • ${a}`).join("\n")}` : "Nothing needs attention this week.";
  const body = sections.map(({ app, body: s }) => `${app.name.toUpperCase()}\n${s.lines.join("\n")}`).join("\n\n");
  const link = opts.consoleUrl ? `\n\nConsole: ${opts.consoleUrl.replace(/\/$/, "")}/` : "";
  return { subject, text: `${head}\n\n${body}${link}\n\nHyphen Console sends this every week. Set DIGEST=off to stop it.` };
}

async function appSection(app: AppConfig, opts: DigestOptions, from: number): Promise<Section> {
  const { store, now } = opts;
  const lines: string[] = [];
  const attention: string[] = [];
  const when = (ms: number) => new Date(ms).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: opts.timeZone || "UTC" });

  // Uptime
  if (app.health.length) {
    lines.push("Uptime");
    const events = store.events(app.id, from, now);
    for (const check of app.health) {
      const up = store.uptime(check.key, from);
      const outages = events.filter((e) => e.kind === "outage" && e.subject === check.name);
      const recovered = events.filter((e) => e.kind === "recovered" && e.subject === check.name).map((e) => Number(e.detail));
      const state = store.getState(check.key);
      let note = outages.length ? `${outages.length} outage${outages.length > 1 ? "s" : ""}` : "no outages";
      if (recovered.length) note += `, longest ${fmtDuration(Math.max(...recovered))}`;
      if (state && !state.up) {
        note += `, down now (since ${when(state.since)})`;
        attention.push(`${check.name} is down (since ${when(state.since)})`);
      } else if (outages.length) {
        attention.push(`${check.name} had ${outages.length} outage${outages.length > 1 ? "s" : ""}`);
      }
      lines.push(`  ${check.name}: ${up === null ? "no checks yet" : pct(up, 2)} up, ${note}`);
    }
  }

  // Reviews
  const synced = ["apple", "google"].map((s) => ({ s, sync: store.getSync(app.id, s) })).filter((x) => x.sync);
  if (synced.length) {
    lines.push("Reviews");
    const fresh = store.newReviews(app.id, from, now);
    if (fresh.length) {
      const byStore = ["apple", "google"].map((s) => [s, fresh.filter((r) => r.store === s).length] as const).filter(([, n]) => n);
      const avg = fresh.reduce((n, r) => n + r.rating, 0) / fresh.length;
      lines.push(`  ${fresh.length} new (${byStore.map(([s, n]) => `${storeName(s)} ${n}`).join(", ")}), averaging ${avg.toFixed(1)}★`);
      const low = fresh.filter((r) => r.rating <= 2);
      if (low.length) {
        attention.push(`${low.length} new review${low.length > 1 ? "s" : ""} with 1–2 stars`);
        lines.push("  Low ratings:");
        for (const r of low.slice(0, 5)) {
          const text = (r.title ? `${r.title}: ` : "") + r.body;
          lines.push(`    ${stars(r.rating)} ${storeName(r.store)}${r.author ? `, ${r.author}` : ""}: "${text.length > 140 ? `${text.slice(0, 137)}…` : text}"`);
        }
        const unanswered = low.filter((r) => !r.reply).length;
        if (unanswered) lines.push(`    ${unanswered} without a reply yet.`);
      }
    } else {
      lines.push("  No new reviews.");
    }
    const summary = store.reviewSummary(app.id, from);
    if (summary.length) lines.push(`  All time: ${summary.map((x) => `${storeName(x.store)} ${x.average.toFixed(1)}★ (${x.count})`).join(" · ")}`);
    for (const { s, sync } of synced) {
      if (sync?.lastError) attention.push(`${storeName(s)} reviews aren't fetching: ${sync.lastError}`);
    }
  }

  // Vitals
  const g = store.getSync(app.id, "google-vitals");
  const a = store.getSync(app.id, "apple-vitals");
  if (g || a) {
    lines.push("Vitals");
    if (g) {
      const series = store.metricSeries(app.id, "google", ["userPerceivedCrashRate28dUserWeighted", "userPerceivedAnrRate28dUserWeighted", "distinctUsers", "crashRate"], isoDay(now - 40 * DAY));
      const withRates = series.filter((r) => "userPerceivedCrashRate28dUserWeighted" in r.values);
      const latest = withRates.at(-1);
      if (latest) {
        const weekAgo = withRates.filter((r) => r.date <= isoDay(Date.parse(latest.date) - 7 * DAY)).at(-1);
        const c = latest.values.userPerceivedCrashRate28dUserWeighted ?? null;
        const n = latest.values.userPerceivedAnrRate28dUserWeighted ?? null;
        const delta = (now_: number | null, then: number | undefined) =>
          now_ === null || then === undefined ? "" : ` (${now_ >= then ? "+" : "−"}${(Math.abs(now_ - then) * 100).toFixed(2)} pts)`;
        lines.push(
          `  Google Play, 28 days through ${latest.date}: crashes ${pct(c)}${delta(c, weekAgo?.values.userPerceivedCrashRate28dUserWeighted)} of ${pct(PLAY_THRESHOLDS.crash)} limit, ` +
            `ANRs ${pct(n)}${delta(n, weekAgo?.values.userPerceivedAnrRate28dUserWeighted)} of ${pct(PLAY_THRESHOLDS.anr)}` +
            (latest.values.distinctUsers ? `, about ${num(latest.values.distinctUsers)} users a day` : ""),
        );
        if (c !== null && c >= PLAY_THRESHOLDS.crash) attention.push(`Play crash rate ${pct(c)} is over the ${pct(PLAY_THRESHOLDS.crash)} limit`);
        if (n !== null && n >= PLAY_THRESHOLDS.anr) attention.push(`Play ANR rate ${pct(n)} is over the ${pct(PLAY_THRESHOLDS.anr)} limit`);
      } else {
        lines.push("  Google Play: no data yet.");
      }
      if (g.lastError) attention.push(`Google Play vitals aren't fetching: ${g.lastError}`);
    }
    if (a) {
      const series = store.metricSeries(app.id, "apple", ["crashes", "sessions"], isoDay(now - 30 * DAY));
      if (series.length) {
        const last = series.at(-1)!.date;
        const sum = (rows: typeof series) => rows.reduce((t, r) => ({ c: t.c + (r.values.crashes ?? 0), s: t.s + (r.values.sessions ?? 0) }), { c: 0, s: 0 });
        const cut = isoDay(Date.parse(last) - 7 * DAY);
        const cut2 = isoDay(Date.parse(last) - 14 * DAY);
        const thisWeek = sum(series.filter((r) => r.date > cut));
        const prev = sum(series.filter((r) => r.date > cut2 && r.date <= cut));
        const per1k = (x: { c: number; s: number }) => (x.s ? ((x.c / x.s) * 1000).toFixed(1) : "–");
        lines.push(
          `  App Store, 7 days through ${last}: ${num(thisWeek.c)} crash${thisWeek.c === 1 ? "" : "es"} in ${num(thisWeek.s)} sessions (${per1k(thisWeek)} per 1,000)` +
            (prev.s ? `; week before ${per1k(prev)} per 1,000` : ""),
        );
      } else {
        lines.push("  App Store: no reports from Apple yet.");
      }
      if (a.lastError) attention.push(`App Store analytics aren't fetching: ${a.lastError}`);
    }
  }

  // Builds
  try {
    const list = await listBuilds(join(opts.buildsRoot, app.id), app.filePrefix, "");
    const fresh = [...list.android.map((b) => ({ ...b, os: "Android" })), ...list.ios.map((b) => ({ ...b, os: "iPhone" }))]
      .filter((b) => Date.parse(b.mtime) >= from)
      .sort((x, y) => x.mtime.localeCompare(y.mtime));
    lines.push("Builds");
    lines.push(fresh.length ? `  ${fresh.map((b) => `${b.version}${b.release ? "" : ` ${b.extra}`} (${b.os})`).join(", ")}` : "  No new builds.");
  } catch {
    // An unreadable builds folder already shows on the page; the digest skips the section.
  }

  return { lines, attention };
}

/** Parts of a moment in a time zone: weekday ("monday"), hour (0-23) and date (YYYY-MM-DD). */
export function localParts(ms: number, timeZone = "UTC") {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", hour: "numeric", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return { weekday: String(parts.weekday).toLowerCase(), hour: Number(parts.hour), date: `${parts.year}-${parts.month}-${parts.day}` };
}

/** Whether the digest is due: the right weekday, at or after the hour, and not yet sent that day. */
export function digestDue(now: number, opts: { day: string; hour: number; timeZone?: string; lastSent?: string }): string | null {
  const p = localParts(now, opts.timeZone);
  if (p.weekday !== opts.day || p.hour < opts.hour || opts.lastSent === p.date) return null;
  return p.date;
}
