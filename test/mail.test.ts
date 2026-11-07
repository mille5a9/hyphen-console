import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseApps } from "../src/config.ts";
import { alertEmail, CloudflareMailer, fmtDuration, LogMailer, mailerFromEnv } from "../src/mail.ts";

const ok = () => Response.json({ success: true, errors: [], messages: [], result: { delivered: ["me@example.com"], permanent_bounces: [], queued: [] } });
const fail = (status: number, code: number, message: string) => Response.json({ success: false, errors: [{ code, message }], messages: [], result: null }, { status });

test("sends through the Cloudflare REST API", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const mailer = new CloudflareMailer({
    accountId: "acc",
    token: "tok",
    from: "alerts@example.com",
    to: "me@example.com",
    fetch: (async (url: string, init: RequestInit) => (calls.push({ url, init }), ok())) as unknown as typeof fetch,
  });
  await mailer.send({ subject: "s", text: "t" });
  assert.equal(calls[0]?.url, "https://api.cloudflare.com/client/v4/accounts/acc/email/sending/send");
  assert.equal((calls[0]?.init.headers as Record<string, string>).Authorization, "Bearer tok");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { from: "alerts@example.com", to: "me@example.com", subject: "s", text: "t" });
});

test("retries once when throttled, never on a settings error", async () => {
  let n = 0;
  const throttledThenOk = new CloudflareMailer({ accountId: "a", token: "t", from: "f@x", to: "t@x", retryDelayMs: 1,
    fetch: (async () => (n++ ? ok() : fail(429, 10004, "email.sending.error.throttled"))) as unknown as typeof fetch });
  await throttledThenOk.send({ subject: "s", text: "t" });
  assert.equal(n, 2);

  n = 0;
  const forbidden = new CloudflareMailer({ accountId: "a", token: "t", from: "f@x", to: "t@x", retryDelayMs: 1,
    fetch: (async () => (n++, fail(403, 10102, "email.sending.error.authentication.forbidden"))) as unknown as typeof fetch });
  await assert.rejects(forbidden.send({ subject: "s", text: "t" }), /10102/);
  assert.equal(n, 1);
});

test("falls back to logging until email is fully configured", async () => {
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  assert.ok(mailerFromEnv({}, log) instanceof LogMailer);
  assert.ok(mailerFromEnv({ ALERT_EMAIL_TO: "me@x", ALERT_EMAIL_FROM: "a@x", CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_EMAIL_TOKEN_FILE: "/nope" }, log) instanceof LogMailer);
  assert.match(lines.join("\n"), /a token in \/nope/);

  const dir = await mkdtemp(join(tmpdir(), "console-mail-"));
  await writeFile(join(dir, "token"), "secret\n");
  const m = mailerFromEnv({ ALERT_EMAIL_TO: "me@x", ALERT_EMAIL_FROM: "a@x", CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_EMAIL_TOKEN_FILE: join(dir, "token") }, log);
  assert.ok(m instanceof CloudflareMailer);
  assert.equal(m.opts.token, "secret");
});

test("alert emails say what broke and for how long", () => {
  const app = parseApps(JSON.stringify({ apps: [{ id: "my-app", name: "My App", health: [{ name: "Proxy", url: "https://p.example.com/" }] }] }))[0]!;
  const check = app.health[0]!;
  const down = alertEmail({ kind: "down", app, check, downSince: 0, result: { key: check.key, at: 0, ok: false, status: 503, ms: 1, error: "HTTP 503, expected 2xx" } }, "http://console:8095/");
  assert.equal(down.subject, "[down] My App: Proxy");
  assert.match(down.text, /HTTP 503/);
  assert.match(down.text, /http:\/\/console:8095\/apps\/my-app/);
  const up = alertEmail({ kind: "up", app, check, downSince: 0, result: { key: check.key, at: 95 * 60_000, ok: true, status: 200, ms: 1, error: null } });
  assert.equal(up.subject, "[recovered] My App: Proxy");
  assert.match(up.text, /about 1 h 35 min/);
  assert.equal(fmtDuration(10_000), "1 min");
  assert.equal(fmtDuration(3 * 86_400_000), "3 days 0 h");
});
