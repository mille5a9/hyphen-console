// Entry point. All settings come from the environment (see .env.example); nothing machine-specific is in the code.
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ALLOWED, makeAllowlist } from "./access.ts";
import { createHandler } from "./app.ts";
import { loadApps } from "./config.ts";
import { Monitor } from "./health.ts";
import { alertEmail, mailerFromEnv } from "./mail.ts";
import { Store } from "./store.ts";

const env = process.env;
const port = Number(env.PORT ?? 8080);
const host = env.HOST ?? "::";
const configFile = env.CONFIG_FILE ?? "config/apps.json";
const buildsRoot = env.BUILDS_ROOT ?? "builds";
const dataDir = env.DATA_DIR ?? "data";
const cidrs = env.ALLOWED_CIDRS ? env.ALLOWED_CIDRS.split(",").filter(Boolean) : DEFAULT_ALLOWED;
const intervalMs = Math.max(30, Number(env.CHECK_INTERVAL_SECONDS || 120)) * 1000;
const failThreshold = Math.max(1, Number(env.CHECK_FAIL_THRESHOLD || 2));

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

const apps = loadApps(configFile);
const store = new Store(join(dataDir, "console.db"));
const monitor = new Monitor({ apps, store, failThreshold });
const mailer = mailerFromEnv(env, log);

const handler = createHandler({
  apps,
  buildsRoot,
  publicDir: fileURLToPath(new URL("../public/", import.meta.url)),
  isAllowed: makeAllowlist(cidrs),
  status: () => monitor.status(),
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

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearTimeout(timer);
    server.close(() => {
      store.close();
      process.exit(0);
    });
    server.closeAllConnections();
  });
}
