// One-off commands, run inside the container:
//   docker exec hyphen-console node src/cli.ts test-email   # send a test alert with the current settings
//   docker exec hyphen-console node src/cli.ts check        # run every health check once and print the results
import { loadApps } from "./config.ts";
import { runCheck } from "./health.ts";
import { mailerFromEnv } from "./mail.ts";

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
} else {
  console.error("Usage: node src/cli.ts test-email | check");
  process.exit(2);
}
