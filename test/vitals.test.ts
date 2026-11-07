import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { parseApps } from "../src/config.ts";
import { AppleAnalytics, pickReport, sumByDate } from "../src/stores/apple-analytics.ts";
import { GoogleClient, type VitalsRow } from "../src/stores/google.ts";
import { Store } from "../src/store.ts";
import { PLAY_THRESHOLDS, syncVitals, vitalsEmail, vitalsView } from "../src/vitals.ts";

const apps = parseApps(JSON.stringify({ apps: [{ id: "my-app", name: "My App", ios: { bundleId: "com.example" }, android: { package: "com.example" } }] }));

test("sums a report column per date, tab or comma separated", () => {
  const tsv = "Date\tApp Name\tCrashes\tUnique Devices\n2026-01-01\tA\t3\t2\n2026-01-01\tA\t2\t1\n2026-01-02\tA\t1\t1\n";
  assert.deepEqual([...sumByDate(tsv, "Crashes")], [["2026-01-01", 5], ["2026-01-02", 1]]);
  const csv = '﻿Date,App Name,Sessions\r\n2026-01-01,"Name, with comma",7\r\n';
  assert.deepEqual([...sumByDate(csv, "Sessions")], [["2026-01-01", 7]]);
  assert.throws(() => sumByDate("Date\tOther\n", "Crashes"), /no "Date" and "Crashes"/);
});

test("picks the standard report by name prefix", () => {
  const reports = [{ id: "1", name: "App Sessions Detailed" }, { id: "2", name: "App Sessions Standard" }, { id: "3", name: "App Crashes" }, { id: "4", name: "App Crashes Expanded" }];
  assert.equal(pickReport(reports, "App Sessions")?.id, "2");
  assert.equal(pickReport(reports, "App Crashes")?.id, "3");
  assert.equal(pickReport(reports, "App Downloads"), null);
});

/** A fake App Store Connect: one app, report requests, two reports, instances with gzipped segments. */
function fakeApple() {
  const state = { requests: [] as { id: string; stopped: boolean }[], posts: 0, instances: [{ id: "i1", date: "2026-01-02" }] };
  const files: Record<string, string> = {
    "i1-App Crashes": "Date\tCrashes\n2026-01-01\t2\n2026-01-02\t1\n",
    "i1-App Sessions Standard": "Date\tSessions\n2026-01-01\t100\n2026-01-02\t50\n",
    "i2-App Crashes": "Date\tCrashes\n2026-01-02\t3\n", // a late crash for Jan 2, and nothing else
    "i2-App Sessions Standard": "Date\tSessions\n2026-01-03\t40\n",
  };
  const client = {
    appId: async () => "999",
    get: async <T>(path: string): Promise<T> => {
      if (path.includes("/analyticsReportRequests?")) return { data: state.requests.map((r) => ({ id: r.id, attributes: { stoppedDueToInactivity: r.stopped } })) } as T;
      if (path.includes("/reports?")) return { data: [{ id: "rc", attributes: { name: "App Crashes" } }, { id: "rs", attributes: { name: "App Sessions Standard" } }, { id: "rd", attributes: { name: "App Sessions Detailed" } }] } as T;
      if (path.includes("/instances?")) return { data: state.instances.map((i) => ({ id: `${path.includes("/rc/") ? "c" : "s"}-${i.id}`, attributes: { processingDate: i.date } })) } as T;
      const m = /analyticsReportInstances\/(c|s)-(i\d)\/segments/.exec(path);
      if (m) return { data: [{ attributes: { url: `https://dl/${m[2]}-${m[1] === "c" ? "App Crashes" : "App Sessions Standard"}` } }] } as T;
      throw new Error(`unexpected GET ${path}`);
    },
    post: async <T>(): Promise<T> => {
      state.posts++;
      state.requests.push({ id: `req${state.posts}`, stopped: false });
      return { data: { id: `req${state.posts}` } } as T;
    },
  };
  const download = (async (url: string) => new Response(gzipSync(files[decodeURIComponent(url.slice("https://dl/".length))] ?? ""))) as unknown as typeof fetch;
  return { state, analytics: new AppleAnalytics(client, download) };
}

test("Apple: makes the report request once, counts each instance once, folds late data into its day", async () => {
  const store = new Store(":memory:");
  const { state, analytics } = fakeApple();
  await syncVitals(apps, store, { apple: analytics }, 1000);
  assert.equal(state.posts, 1);
  await syncVitals(apps, store, { apple: analytics }, 2000); // same instances again: nothing added twice
  assert.equal(state.posts, 1);
  state.instances.push({ id: "i2", date: "2026-01-03" });
  await syncVitals(apps, store, { apple: analytics }, 3000);
  const series = store.metricSeries("my-app", "apple", ["crashes", "sessions"], "2026-01-01");
  assert.deepEqual(series, [
    { date: "2026-01-01", values: { crashes: 2, sessions: 100 } },
    { date: "2026-01-02", values: { crashes: 4, sessions: 50 } },
    { date: "2026-01-03", values: { sessions: 40 } },
  ]);
  const view = vitalsView(apps[0]!, store, { apple: analytics }, Date.parse("2026-01-04"));
  assert.deepEqual(view.apple?.last7 && { ...view.apple.last7, per1k: Math.round(view.apple.last7.per1k!) }, { crashes: 6, sessions: 190, per1k: 32, through: "2026-01-03" });
  assert.equal(view.apple?.requestedAt, 1000);

  state.requests[0]!.stopped = true; // Apple stopped it for inactivity: a new one is made
  await syncVitals(apps, store, { apple: analytics }, 4000);
  assert.equal(state.posts, 2);
  store.close();
});

test("Google client asks for daily data up to Play's freshest day", async () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const bodies: Record<string, unknown>[] = [];
  let fresh = true;
  const fake = (async (url: string | URL, init: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/token")) return Response.json({ access_token: "AT", expires_in: 3600 });
    if (u.endsWith("crashRateMetricSet")) {
      return Response.json({ freshnessInfo: { freshnesses: fresh ? [{ aggregationPeriod: "DAILY", latestEndTime: { year: 2026, month: 3, day: 1, timeZone: { id: "America/Los_Angeles" } } }] : [] } });
    }
    bodies.push(JSON.parse(String(init.body)));
    return Response.json({ rows: [{ startTime: { year: 2026, month: 2, day: 28 }, metrics: [{ metric: "crashRate", decimalValue: { value: "0.012" } }] }] });
  }) as unknown as typeof fetch;
  const g = new GoogleClient({ account: { client_email: "sa@x", private_key: String(rsa.privateKey.export({ type: "pkcs8", format: "pem" })) }, fetch: fake });
  const rows = await g.vitals("com.example", "crashRateMetricSet", ["crashRate"]);
  assert.deepEqual(rows, [{ date: "2026-02-28", values: { crashRate: 0.012 } }]);
  const spec = (bodies[0] as { timelineSpec: { startTime: object; endTime: object; aggregationPeriod: string } }).timelineSpec;
  assert.equal(spec.aggregationPeriod, "DAILY");
  assert.deepEqual(spec.endTime, { year: 2026, month: 3, day: 1, timeZone: { id: "America/Los_Angeles" } });
  assert.deepEqual(spec.startTime, { year: 2026, month: 1, day: 30, timeZone: { id: "America/Los_Angeles" } });
  fresh = false;
  assert.deepEqual(await g.vitals("com.example", "crashRateMetricSet", ["crashRate"]), []);
});

test("Google: alerts once when a 28-day rate crosses Play's threshold, and once when it's back", async () => {
  const store = new Store(":memory:");
  let crash28 = 0.005;
  const google = {
    vitals: async (_pkg: string, set: string): Promise<VitalsRow[]> =>
      set === "crashRateMetricSet"
        ? [{ date: "2026-01-01", values: { userPerceivedCrashRate28dUserWeighted: crash28, userPerceivedCrashRate: crash28, distinctUsers: 1000 } }]
        : [{ date: "2026-01-01", values: { userPerceivedAnrRate28dUserWeighted: 0.001 } }],
  };
  const kinds = async () => (await syncVitals(apps, store, { google })).alerts.map((a) => `${a.which}:${a.kind}`);
  assert.deepEqual(await kinds(), []);
  crash28 = 0.02;
  assert.deepEqual(await kinds(), ["crash:over"]);
  assert.deepEqual(await kinds(), []); // still over: no repeat
  crash28 = 1.5; // a value over 1 is read as a percentage: 1.5% is still over
  assert.deepEqual(await kinds(), []);
  crash28 = 0.004;
  assert.deepEqual(await kinds(), ["crash:back"]);
  const view = vitalsView(apps[0]!, store, { google }, Date.parse("2026-01-05"));
  assert.equal(view.google?.latest?.crash28d, 0.004);
  assert.equal(view.google?.latest?.users, 1000);
  store.close();
});

test("vitals email explains the threshold", () => {
  const e = vitalsEmail({ kind: "over", app: apps[0]!, which: "anr", value: 0.0061, threshold: PLAY_THRESHOLDS.anr, date: "2026-01-01" }, "http://c");
  assert.equal(e.subject, "[vitals] My App: user-perceived ANR rate over Play's limit");
  assert.match(e.text, /0\.61%/);
  assert.match(e.text, /0\.47%/);
});

test("Apple: a key that can't start reports gets told how to start them", async () => {
  const store = new Store(":memory:");
  const { analytics } = fakeApple();
  const { StoreApiError } = await import("../src/stores/review.ts");
  analytics.client.post = async () => { throw new StoreApiError("App Store Connect 403: The API key in use does not allow this request", 403); };
  const r = await syncVitals(apps, store, { apple: analytics });
  assert.match(r.errors[0] ?? "", /Admin key: node src\/cli\.ts apple-report-request/);
  assert.match(store.getSync("my-app", "apple-vitals")?.lastError ?? "", /Admin key/);
  store.close();
});
