// Entry point. All settings come from the environment (see .env.example); nothing machine-specific is in the code.
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { DEFAULT_ALLOWED, makeAllowlist } from "./access.ts";
import { createHandler } from "./app.ts";
import { loadApps } from "./config.ts";

const env = process.env;
const port = Number(env.PORT ?? 8080);
const host = env.HOST ?? "::";
const configFile = env.CONFIG_FILE ?? "config/apps.json";
const buildsRoot = env.BUILDS_ROOT ?? "builds";
const cidrs = env.ALLOWED_CIDRS ? env.ALLOWED_CIDRS.split(",").filter(Boolean) : DEFAULT_ALLOWED;

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

const apps = loadApps(configFile);
const handler = createHandler({
  apps,
  buildsRoot,
  publicDir: fileURLToPath(new URL("../public/", import.meta.url)),
  isAllowed: makeAllowlist(cidrs),
  log,
});

const server = createServer(handler);
server.listen(port, host, () => log(`hyphen-console on ${host}:${port}, ${apps.length} app(s): ${apps.map((a) => a.id).join(", ")}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
