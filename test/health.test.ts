import assert from "node:assert/strict";
import { test } from "node:test";
import { parseApps } from "../src/config.ts";
import { Monitor, runCheck, step } from "../src/health.ts";
import { Store } from "../src/store.ts";

const apps = parseApps(
  JSON.stringify({
    apps: [{ id: "my-app", name: "My App", health: [{ name: "API proxy", url: "https://api.example.com/", expectStatus: 401 }] }],
  }),
);

/** A fake fetch that answers each call from a script: a status code, or "error" for a network failure. */
function scripted(answers: (number | "error")[]) {
  let i = 0;
  return (async () => {
    const a = answers[Math.min(i++, answers.length - 1)]!;
    if (a === "error") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    return new Response([204, 205, 304].includes(a) ? null : "x", { status: a });
  }) as unknown as typeof fetch;
}

test("config gives checks stable keys and validates them", () => {
  assert.equal(apps[0]?.health[0]?.key, "my-app/api-proxy");
  assert.throws(() => parseApps(JSON.stringify({ apps: [{ id: "a", name: "A", health: [{ name: "x", url: "ftp://x" }] }] })));
  assert.throws(() => parseApps(JSON.stringify({ apps: [{ id: "a", name: "A", health: [{ name: "x", url: "https://x", expectStatus: 99 }] }] })));
  assert.throws(() => parseApps(JSON.stringify({ apps: [{ id: "a", name: "A", health: [{ name: "X", url: "https://x" }, { name: "x", url: "https://y" }] }] })));
  assert.deepEqual(parseApps(JSON.stringify({ apps: [{ id: "a", name: "A" }] }))[0]?.health, []);
});

test("a check passes on its expected status, or any 2xx by default", async () => {
  const check = apps[0]!.health[0]!;
  const opts = { timeoutMs: 1000, now: Date.now };
  assert.equal((await runCheck(check, { ...opts, fetch: scripted([401]) })).ok, true);
  const r = await runCheck(check, { ...opts, fetch: scripted([200]) });
  assert.equal(r.ok, false);
  assert.equal(r.error, "HTTP 200, expected 401");
  const plain = { key: "k", name: "n", url: "https://x/" };
  assert.equal((await runCheck(plain, { ...opts, fetch: scripted([204]) })).ok, true);
  const down = await runCheck(plain, { ...opts, fetch: scripted(["error"]) });
  assert.deepEqual([down.ok, down.status, down.error], [false, null, "ECONNREFUSED"]);
});

test("one miss is a blip; two in a row is down; recovery only after an alert", () => {
  const r = (ok: boolean, at: number) => ({ key: "k", at, ok, status: ok ? 200 : 500, ms: 5, error: ok ? null : "HTTP 500" });
  let s = step(undefined, r(true, 1), 2);
  assert.equal(s.transition, undefined);
  s = step(s.state, r(false, 2), 2);
  assert.equal(s.transition, undefined);
  assert.equal(s.state.up, true);
  s = step(s.state, r(true, 3), 2); // blip over, no emails
  assert.equal(s.transition, undefined);
  s = step(s.state, r(false, 4), 2);
  s = step(s.state, r(false, 5), 2);
  assert.equal(s.transition, "down");
  assert.equal(s.state.since, 5);
  s = step(s.state, r(false, 6), 2); // still down: no repeat email
  assert.equal(s.transition, undefined);
  s = step(s.state, r(true, 7), 2);
  assert.equal(s.transition, "up");
  assert.deepEqual([s.state.up, s.state.since, s.state.alerted], [true, 7, false]);
});

test("monitor stores results, reports transitions and status", async () => {
  const store = new Store(":memory:");
  let t = 1_000_000;
  const monitor = new Monitor({ apps, store, fetch: scripted([401, 500, 500, 401]), now: () => t });
  const kinds: string[] = [];
  for (let i = 0; i < 4; i++) {
    t += 60_000;
    const out = await monitor.tick();
    kinds.push(out.map((x) => x.kind).join(",") || "-");
    if (out[0]?.kind === "up") assert.equal(out[0].downSince, 1_000_000 + 3 * 60_000);
  }
  assert.deepEqual(kinds, ["-", "-", "down", "up"]);
  const [st] = monitor.status();
  assert.equal(st?.up, true);
  assert.equal(st?.uptime24h, 0.5);
  assert.equal(st?.last?.status, 401);
  store.close();
});
