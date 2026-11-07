// One-off commands, run inside the container:
//   docker exec hyphen-console node src/cli.ts test-email   # send a test alert with the current settings
//   docker exec hyphen-console node src/cli.ts check        # run every health check once and print the results
//   docker exec hyphen-console node src/cli.ts reviews      # fetch reviews from each store once and print a count (saves nothing)
import { loadApps } from "./config.ts";
import { runCheck } from "./health.ts";
import { mailerFromEnv } from "./mail.ts";
import { sourcesFromEnv } from "./reviews.ts";

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
} else {
  console.error("Usage: node src/cli.ts test-email | check | reviews");
  process.exit(2);
}
