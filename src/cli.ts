// One-off commands, run inside the container:
//   docker exec hyphen-console node src/cli.ts test-email   # send a test alert with the current settings
//   docker exec hyphen-console node src/cli.ts check        # run every health check once and print the results
//   docker exec hyphen-console node src/cli.ts reviews      # fetch reviews from each store once and print a count (saves nothing)
//   docker exec hyphen-console node src/cli.ts vitals       # read Play vitals and list Apple's analytics reports (saves nothing)
//   docker exec hyphen-console node src/cli.ts digest [--send] # print this week's digest, or email it now
//   docker exec hyphen-console node src/cli.ts apple-report-request <key id> <.p8 file>
//       start Apple's daily analytics reports for every app, with a one-time Admin key (revoke it afterwards)
import { loadApps } from "./config.ts";
import { runCheck } from "./health.ts";
import { mailerFromEnv } from "./mail.ts";
import { sourcesFromEnv } from "./reviews.ts";
import type { GoogleClient } from "./stores/google.ts";
import { vitalsSourcesFromEnv } from "./vitals.ts";
import { buildDigest } from "./digest.ts";
import { Store } from "./store.ts";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { AppleClient } from "./stores/apple.ts";
import { AppleAnalytics, createReportRequest } from "./stores/apple-analytics.ts";

const log = (line: string) => console.log(line);
const [command] = process.argv.slice(2);

if (command === "test-email") {
  const mailer = mailerFromEnv(process.env, log);
  console.log(`Sending a test message: ${mailer.describe()}`);
  await mailer.send({
    subject: "[test] Hyphen Console alerts work",
    text: "This is a test from Hyphen Console. Down and recovery alerts for your apps will arrive like this one.",
  });
  console.log("Sent.");
} else if (command === "check") {
  const apps = loadApps(process.env.CONFIG_FILE ?? "config/apps.json");
  for (const app of apps) {
    for (const check of app.health) {
      const r = await runCheck(check, { fetch, timeoutMs: 10_000, now: Date.now });
      console.log(`${r.ok ? "up  " : "DOWN"} ${check.key} ${r.status ?? "-"} ${r.ms} ms${r.error ? `  ${r.error}` : ""}`);
    }
  }
} else if (command === "reviews") {
  const apps = loadApps(process.env.CONFIG_FILE ?? "config/apps.json");
  const sources = sourcesFromEnv(process.env, log);
  if (!sources.apple && !sources.google) console.log("No store credentials found in the secrets folder.");
  let failed = false;
  for (const app of apps) {
    const runs: [string, (() => Promise<{ rating: number }[]>) | null][] = [
      ["App Store", sources.apple && (app.ios?.bundleId || app.ios?.appStoreId) ? () => sources.apple!.reviews(app.id, app.ios!, 0, 1) : null],
      ["Google Play", sources.google && app.android?.package ? () => sources.google!.reviews(app.id, app.android!.package!, 1) : null],
    ];
    for (const [name, run] of runs) {
      if (!run) continue;
      try {
        const list = await run();
        const avg = list.length ? (list.reduce((n, r) => n + r.rating, 0) / list.length).toFixed(1) : "-";
        console.log(`ok   ${app.id} ${name}: ${list.length} review(s) on the first page, average ${avg}`);
      } catch (e) {
        failed = true;
        console.log(`FAIL ${app.id} ${name}: ${(e as Error).message}`);
      }
    }
  }
  if (failed) process.exitCode = 1;
} else if (command === "vitals") {
  const apps = loadApps(process.env.CONFIG_FILE ?? "config/apps.json");
  const v = vitalsSourcesFromEnv(process.env, sourcesFromEnv(process.env, log).google as GoogleClient | undefined, log);
  for (const app of apps) {
    if (v.google && app.android?.package) {
      try {
        const rows = await v.google.vitals(app.android.package, "crashRateMetricSet", ["crashRate", "userPerceivedCrashRate28dUserWeighted", "distinctUsers"]);
        const last = rows.at(-1);
        console.log(`ok   ${app.id} Google Play: ${rows.length} day(s)${last ? `, latest ${last.date} ${JSON.stringify(last.values)}` : ""}`);
      } catch (e) {
        process.exitCode = 1;
        console.log(`FAIL ${app.id} Google Play: ${(e as Error).message}`);
      }
    }
    if (v.apple && (app.ios?.bundleId || app.ios?.appStoreId)) {
      try {
        const id = app.ios.appStoreId ?? (await v.apple.client.appId(app.ios.bundleId!));
        const reqs = await v.apple.client.get<{ data: { id: string; attributes: { stoppedDueToInactivity?: boolean } }[] }>(`/v1/apps/${id}/analyticsReportRequests?filter[accessType]=ONGOING`);
        const live = reqs.data.find((r) => !r.attributes.stoppedDueToInactivity);
        const reports = live ? await v.apple.usageReports(live.id) : [];
        console.log(`ok   ${app.id} App Store: ${live ? `report request ${live.id}, ${reports.length} usage report(s)${reports.length ? `: ${reports.map((r) => r.name).join(", ")}` : ""}` : "no ongoing report request yet (the console makes one on its next sync)"}`);
      } catch (e) {
        process.exitCode = 1;
        console.log(`FAIL ${app.id} App Store: ${(e as Error).message}`);
      }
    }
  }
} else if (command === "digest") {
  // Reads the live database (read-only use): run it inside the container, next to the server.
  const store = new Store(join(process.env.DATA_DIR ?? "data", "console.db"));
  const email = await buildDigest({
    apps: loadApps(process.env.CONFIG_FILE ?? "config/apps.json"),
    store,
    buildsRoot: process.env.BUILDS_ROOT ?? "builds",
    now: Date.now(),
    timeZone: process.env.TZ || "UTC",
    consoleUrl: process.env.CONSOLE_URL,
  });
  store.close();
  if (process.argv.includes("--send")) {
    const mailer = mailerFromEnv(process.env, log);
    await mailer.send(email);
    console.log(`Sent "${email.subject}" (${mailer.describe()}).`);
  } else {
    console.log(`Subject: ${email.subject}\n\n${email.text}`);
  }
} else if (command === "apple-report-request") {
  const [keyId, keyFile] = process.argv.slice(3);
  const issuerId = process.env.APP_STORE_CONNECT_ISSUER_ID;
  if (!keyId || !keyFile || !issuerId) {
    console.error("Usage: node src/cli.ts apple-report-request <admin key id> <admin .p8 file>   (APP_STORE_CONNECT_ISSUER_ID must be set)");
    process.exit(2);
  }
  const client = new AppleClient({ keyId, issuerId, privateKey: readFileSync(keyFile, "utf8") });
  const analytics = new AppleAnalytics(client);
  for (const app of loadApps(process.env.CONFIG_FILE ?? "config/apps.json")) {
    if (!app.ios?.bundleId && !app.ios?.appStoreId) continue;
    const id = app.ios.appStoreId ?? (await client.appId(app.ios.bundleId!));
    const existing = await client.get<{ data: { id: string; attributes: { stoppedDueToInactivity?: boolean } }[] }>(`/v1/apps/${id}/analyticsReportRequests?filter[accessType]=ONGOING`);
    const live = existing.data.find((r) => !r.attributes.stoppedDueToInactivity);
    if (live) console.log(`${app.id}: already has report request ${live.id}`);
    else console.log(`${app.id}: started report request ${await createReportRequest(analytics.client, id)}. Apple makes the first reports in 1–2 days.`);
  }
  console.log("Done. You can revoke the Admin key now.");
} else {
  console.error("Usage: node src/cli.ts test-email | check | reviews | vitals | digest [--send] | apple-report-request");
  process.exit(2);
}
