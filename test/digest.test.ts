import assert from "node:assert/strict";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseApps } from "../src/config.ts";
import { buildDigest, digestDue, localParts } from "../src/digest.ts";
import { Store } from "../src/store.ts";

const NY = "America/New_York";

test("digest is due Monday at 8 AM Eastern, once", () => {
  // Monday Nov 9 2026, 8:00 AM EST = 13:00 UTC.
  const monday8 = Date.parse("2026-11-09T13:00:00Z");
  assert.deepEqual(localParts(monday8, NY), { weekday: "monday", hour: 8, date: "2026-11-09" });
  const opts = { day: "monday", hour: 8, timeZone: NY };
  assert.equal(digestDue(monday8 - 60_000, opts), null); // 7:59
  assert.equal(digestDue(monday8, opts), "2026-11-09");
  assert.equal(digestDue(monday8 + 3 * 3_600_000, opts), "2026-11-09"); // came back up at 11: still sends
  assert.equal(digestDue(monday8 + 3_600_000, { ...opts, lastSent: "2026-11-09" }), null);
  assert.equal(digestDue(monday8 + 86_400_000, opts), null); // Tuesday
  // In summer (EDT), 8 AM is 12:00 UTC.
  assert.equal(digestDue(Date.parse("2026-06-01T12:00:00Z"), opts), "2026-06-01");
});

const apps = parseApps(JSON.stringify({
  apps: [{ id: "my-app", name: "My App", ios: { bundleId: "com.example" }, android: { package: "com.example" }, health: [{ name: "Proxy", url: "https://p.example/" }] }],
}));
const now = Date.parse("2026-11-09T13:00:00Z");
const DAY = 86_400_000;

test("a quiet week is 'all good'", async () => {
  const store = new Store(":memory:");
  store.addResult({ key: "my-app/proxy", at: now - DAY, ok: true, status: 200, ms: 50, error: null });
  const email = await buildDigest({ apps, store, buildsRoot: join(tmpdir(), "nope-digest"), now, timeZone: NY });
  assert.equal(email.subject, "Weekly digest, Nov 2–Nov 9: all good");
  assert.match(email.text, /Nothing needs attention this week\./);
  assert.match(email.text, /Proxy: 100\.00% up, no outages/);
  store.close();
});

test("a busy week lists what needs a look, then each section", async () => {
  const store = new Store(":memory:");
  // Uptime: one outage that lasted 14 minutes.
  for (let i = 0; i < 9; i++) store.addResult({ key: "my-app/proxy", at: now - i * 3_600_000, ok: i !== 3, status: i !== 3 ? 200 : 503, ms: 50, error: null });
  store.addEvent({ at: now - 3 * DAY, appId: "my-app", kind: "outage", subject: "Proxy", detail: "HTTP 503" });
  store.addEvent({ at: now - 3 * DAY + 14 * 60_000, appId: "my-app", kind: "recovered", subject: "Proxy", detail: String(14 * 60_000) });
  // Reviews: one old, two new this week (one low, unanswered).
  const base = { appId: "my-app", title: "", locale: "", appVersion: "", device: "", reply: null };
  store.saveReview({ ...base, store: "apple", id: "old", rating: 5, body: "Old", author: "x", updatedAt: now - 30 * DAY }, now - 30 * DAY);
  store.saveReview({ ...base, store: "apple", id: "n1", rating: 5, body: "Great", author: "a", updatedAt: now - DAY }, now - DAY);
  store.saveReview({ ...base, store: "google", id: "n2", rating: 1, body: "Map froze", author: "J.", updatedAt: now - DAY }, now - DAY);
  store.setSync("my-app", "apple", now, null);
  store.setSync("my-app", "google", now, "Google Play 403: forbidden");
  // Vitals: Play crash rate rose over the limit; Apple has two weeks of data.
  store.setMetric("my-app", "google", "userPerceivedCrashRate28dUserWeighted", "2026-10-31", 0.008);
  store.setMetric("my-app", "google", "userPerceivedAnrRate28dUserWeighted", "2026-10-31", 0.001);
  store.setMetric("my-app", "google", "userPerceivedCrashRate28dUserWeighted", "2026-11-07", 0.0125);
  store.setMetric("my-app", "google", "userPerceivedAnrRate28dUserWeighted", "2026-11-07", 0.001);
  store.setMetric("my-app", "google", "distinctUsers", "2026-11-07", 1200);
  store.setSync("my-app", "google-vitals", now, null);
  store.addInstance("i1", "my-app", "crashes", new Map([["2026-10-28", 2], ["2026-11-05", 3]]), now);
  store.addInstance("i2", "my-app", "sessions", new Map([["2026-10-28", 1000], ["2026-11-05", 1500]]), now);
  store.setSync("my-app", "apple-vitals", now, null);
  // Builds: one this week, one older.
  const root = await mkdtemp(join(tmpdir(), "digest-builds-"));
  await mkdir(join(root, "my-app"));
  for (const [name, age] of [["my-app-1.0.0-arm64.apk", 20], ["my-app-1.1.0-arm64.apk", 2], ["my-app-1.1.0.ipa", 1]] as const) {
    await writeFile(join(root, "my-app", name), "x");
    const t = new Date(now - age * DAY);
    await utimes(join(root, "my-app", name), t, t);
  }

  const email = await buildDigest({ apps, store, buildsRoot: root, now, timeZone: NY, consoleUrl: "http://console:8095" });
  assert.equal(email.subject, "Weekly digest, Nov 2–Nov 9: 4 things to look at");
  const t = email.text;
  assert.match(t, /• Proxy had 1 outage/);
  assert.match(t, /• 1 new review with 1–2 stars/);
  assert.match(t, /• Google Play reviews aren't fetching: Google Play 403: forbidden/);
  assert.match(t, /• Play crash rate 1\.25% is over the 1\.09% limit/);
  assert.match(t, /Proxy: 88\.89% up, 1 outage, longest 14 min/);
  assert.match(t, /2 new \(App Store 1, Google Play 1\), averaging 3\.0★/);
  assert.match(t, /★☆☆☆☆ Google Play, J\.: "Map froze"/);
  assert.match(t, /1 without a reply yet\./);
  assert.match(t, /crashes 1\.25% \(\+0\.45 pts\) of 1\.09% limit/);
  assert.match(t, /about 1,200 users a day/);
  assert.match(t, /App Store, 7 days through 2026-11-05: 3 crashes in 1,500 sessions \(2\.0 per 1,000\); week before 2\.0 per 1,000/);
  assert.match(t, /Builds\n {2}1\.1\.0 \(Android\), 1\.1\.0 \(iPhone\)/);
  assert.match(t, /Console: http:\/\/console:8095\//);
  store.close();
});
