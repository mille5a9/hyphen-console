import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject, verify } from "node:crypto";
import { test } from "node:test";
import { parseApps } from "../src/config.ts";
import { signJwt } from "../src/jwt.ts";
import { reviewEmail, syncReviews } from "../src/reviews.ts";
import { AppleClient } from "../src/stores/apple.ts";
import { GoogleClient } from "../src/stores/google.ts";
import type { Review } from "../src/stores/review.ts";
import { Store } from "../src/store.ts";

const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = (k: KeyObject) => String(k.export({ type: "pkcs8", format: "pem" }));

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());

test("signs ES256 and RS256 tokens that verify", () => {
  const es = signJwt({ alg: "ES256", kid: "K" }, { a: 1 }, pem(ec.privateKey)).split(".");
  assert.ok(verify("sha256", Buffer.from(`${es[0]}.${es[1]}`), { key: ec.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(es[2]!, "base64url")));
  assert.equal(Buffer.from(es[2]!, "base64url").length, 64); // raw r||s, as JWT requires
  const rs = signJwt({ alg: "RS256" }, { a: 1 }, pem(rsa.privateKey)).split(".");
  assert.ok(verify("sha256", Buffer.from(`${rs[0]}.${rs[1]}`), rsa.publicKey, Buffer.from(rs[2]!, "base64url")));
});

test("Apple client: JWT claims, app lookup, reviews with replies, stops at old reviews", async () => {
  const calls: { url: string; auth: string }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: (init.headers as Record<string, string>).Authorization ?? "" });
    if (url.includes("/v1/apps?")) return Response.json({ data: [{ id: "123" }] });
    if (url.includes("page2")) {
      return Response.json({ data: [{ id: "r3", attributes: { rating: 3, createdDate: "2026-01-01T00:00:00Z" } }] });
    }
    return Response.json({
      data: [
        { id: "r1", attributes: { rating: 5, title: "Great", body: "Love it", reviewerNickname: "kid", createdDate: "2026-03-02T00:00:00Z", territory: "USA" }, relationships: { response: { data: { id: "resp1" } } } },
        { id: "r2", attributes: { rating: 1, body: "Crashes", createdDate: "2026-02-01T00:00:00Z" } },
      ],
      included: [{ id: "resp1", type: "customerReviewResponses", attributes: { responseBody: "Thanks!", lastModifiedDate: "2026-03-03T00:00:00Z" } }],
      links: { next: "https://api.appstoreconnect.apple.com/v1/apps/123/customerReviews?page2" },
    });
  }) as unknown as typeof fetch;
  const now = Date.parse("2026-03-10T00:00:00Z");
  const client = new AppleClient({ keyId: "KEY1", issuerId: "ISS", privateKey: pem(ec.privateKey), fetch: fake, now: () => now });
  const list = await client.reviews("my-app", { bundleId: "com.example" }, Date.parse("2026-02-15T00:00:00Z"));
  assert.deepEqual(list.map((r) => r.id), ["r1", "r2"]); // r2 is older than `since`, so page 2 is never fetched
  assert.deepEqual(list[0]?.reply, { text: "Thanks!", at: Date.parse("2026-03-03T00:00:00Z") });
  assert.equal(list[1]?.reply, null);
  assert.match(calls[1]!.url, /\/v1\/apps\/123\/customerReviews\?sort=-createdDate&limit=200&include=response/);
  const [h, p] = calls[0]!.auth.replace("Bearer ", "").split(".");
  assert.deepEqual(decode(h!), { alg: "ES256", kid: "KEY1", typ: "JWT" });
  const claims = decode(p!);
  assert.equal(claims.iss, "ISS");
  assert.equal(claims.aud, "appstoreconnect-v1");
  assert.ok(claims.exp - claims.iat <= 20 * 60);
});

test("Google client: token exchange, title/body split, pagination", async () => {
  let tokenCalls = 0;
  const pages: string[] = [];
  const fake = (async (url: string | URL, init: RequestInit) => {
    const u = String(url);
    if (u === "https://oauth2.googleapis.com/token") {
      tokenCalls++;
      const assertion = new URLSearchParams(String(init.body)).get("assertion")!;
      const claims = decode(assertion.split(".")[1]!);
      assert.equal(claims.scope, "https://www.googleapis.com/auth/androidpublisher");
      assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
      return Response.json({ access_token: "AT", expires_in: 3600 });
    }
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer AT");
    pages.push(u);
    const comment = (text: string, stars: number, sec: string) => ({ userComment: { text, starRating: stars, lastModified: { seconds: sec }, appVersionName: "1.2.0", reviewerLanguage: "en_US", device: "pixel" } });
    if (!u.includes("token=")) {
      return Response.json({
        reviews: [{ reviewId: "g1", authorName: "Sam", comments: [comment("Nice\tWorks well", 4, "1700000000"), { developerComment: { text: "Thank you", lastModified: { seconds: "1700000100" } } }] }],
        tokenPagination: { nextPageToken: "NEXT" },
      });
    }
    return Response.json({ reviews: [{ reviewId: "g2", comments: [comment("No tab here", 2, "1700000200")] }] });
  }) as unknown as typeof fetch;
  const client = new GoogleClient({ account: { client_email: "sa@x.iam.gserviceaccount.com", private_key: pem(rsa.privateKey) }, fetch: fake });
  const list = await client.reviews("my-app", "com.example");
  assert.equal(tokenCalls, 1);
  assert.equal(pages.length, 2);
  assert.match(pages[1]!, /token=NEXT/);
  assert.deepEqual([list[0]?.title, list[0]?.body, list[0]?.reply?.text, list[0]?.updatedAt], ["Nice", "Works well", "Thank you", 1_700_000_000_000]);
  assert.deepEqual([list[1]?.title, list[1]?.body], ["", "No tab here"]);
});

const apps = parseApps(JSON.stringify({ apps: [{ id: "my-app", name: "My App", ios: { bundleId: "com.example" }, android: { package: "com.example" } }] }));
const review = (id: string, rating: number, updatedAt: number, store: Review["store"] = "apple"): Review => ({
  store, appId: "my-app", id, rating, title: "", body: `body ${id} ${rating}`, author: "a", locale: "USA", appVersion: "", device: "", updatedAt, reply: null,
});

test("first sync fills history quietly; later syncs report new and edited reviews", async () => {
  const store = new Store(":memory:");
  let appleList = [review("a1", 5, 1), review("a2", 4, 2)];
  let googleFails = true;
  const sources = {
    apple: { reviews: async () => appleList },
    google: { reviews: async () => { if (googleFails) throw new Error("403 not yet"); return [review("g1", 1, 5, "google")]; } },
  };
  let r = await syncReviews(apps, store, sources, 1000);
  assert.deepEqual(r.fresh, []);
  assert.deepEqual(r.errors, ["my-app google: 403 not yet"]);
  assert.equal(store.getSync("my-app", "google")?.lastError, "403 not yet");

  appleList = [review("a3", 2, 3), review("a1", 3, 4), review("a2", 4, 2)];
  googleFails = false;
  r = await syncReviews(apps, store, sources, 2000);
  // Google's first good sync is quiet too, even though an earlier attempt failed.
  assert.deepEqual(r.fresh.map((f) => `${f.review.id}:${f.kind}`), ["a3:new", "a1:edited"]);
  assert.equal(store.getSync("my-app", "google")?.lastError, null);
  assert.equal(store.reviews("my-app").length, 4);
  const summary = store.reviewSummary("my-app", 1500);
  assert.deepEqual(summary.map((s) => [s.store, s.count, s.recent]), [["apple", 3, 1], ["google", 1, 1]]);
  store.close();
});

test("review email lists reviews and flags low ratings", () => {
  const fresh = [{ review: review("a", 5, 1), kind: "new" as const }, { review: review("b", 1, 2, "google"), kind: "new" as const }];
  const all = reviewEmail(fresh, apps, "all", "http://console/")!;
  assert.equal(all.subject, "[low rating] My App: new 2 reviews");
  assert.match(all.text, /★★★★★ {2}My App · App Store/);
  assert.match(all.text, /★☆☆☆☆ {2}My App · Google Play/);
  assert.match(all.text, /http:\/\/console\/apps\/my-app/);
  const low = reviewEmail(fresh, apps, "low")!;
  assert.equal(low.subject, "[low rating] My App: new ★☆☆☆☆ review");
  assert.equal(reviewEmail(fresh.slice(0, 1), apps, "low"), null);
  assert.equal(reviewEmail(fresh, apps, "off"), null);
});
