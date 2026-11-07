import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createHandler } from "../src/app.ts";
import { parseApps } from "../src/config.ts";

let server: Server;
let base = "";
let allow = true;

before(async () => {
  const root = await mkdtemp(join(tmpdir(), "console-app-"));
  await mkdir(join(root, "my-app"));
  await writeFile(join(root, "my-app", "my-app-1.0.0-arm64.apk"), "0123456789");
  await writeFile(join(root, "my-app", "secret.txt"), "nope");
  await writeFile(join(root, "outside.txt"), "nope");
  const handler = createHandler({
    apps: parseApps(JSON.stringify({ apps: [{ id: "my-app", name: "My App" }] })),
    buildsRoot: root,
    publicDir: fileURLToPath(new URL("../public/", import.meta.url)),
    isAllowed: () => allow,
  });
  server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

test("lists apps and builds", async () => {
  assert.deepEqual(await (await fetch(`${base}/api/apps`)).json(), [{ id: "my-app", name: "My App" }]);
  const builds = await (await fetch(`${base}/api/apps/my-app/builds`)).json();
  assert.equal(builds.android[0].url, "/files/my-app/my-app-1.0.0-arm64.apk");
  assert.equal((await fetch(`${base}/api/apps/nope/builds`)).status, 404);
});

test("serves the page at / and /apps/<id>", async () => {
  for (const p of ["/", "/apps/my-app"]) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
    assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  }
});

test("downloads a build, with ranges", async () => {
  const r = await fetch(`${base}/files/my-app/my-app-1.0.0-arm64.apk`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/vnd.android.package-archive");
  assert.match(r.headers.get("content-disposition") ?? "", /attachment/);
  assert.equal(await r.text(), "0123456789");

  const part = await fetch(`${base}/files/my-app/my-app-1.0.0-arm64.apk`, { headers: { Range: "bytes=2-4" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 2-4/10");
  assert.equal(await part.text(), "234");

  const tail = await fetch(`${base}/files/my-app/my-app-1.0.0-arm64.apk`, { headers: { Range: "bytes=-3" } });
  assert.equal(await tail.text(), "789");

  assert.equal((await fetch(`${base}/files/my-app/my-app-1.0.0-arm64.apk`, { headers: { Range: "bytes=50-" } })).status, 416);
});

test("serves nothing but build files", async () => {
  for (const p of ["/files/my-app/secret.txt", "/files/my-app/..%2Foutside.txt", "/files/my-app/%2e%2e%2Foutside.txt", "/files/other/x-1.0.0.apk", "/files/my-app/my-app-9.9.9-arm64.apk"]) {
    assert.equal((await fetch(base + p)).status, 404, p);
  }
});

test("refuses clients outside the allowlist and non-GET methods", async () => {
  allow = false;
  try {
    assert.equal((await fetch(`${base}/api/apps`)).status, 403);
  } finally {
    allow = true;
  }
  assert.equal((await fetch(`${base}/api/apps`, { method: "POST" })).status, 405);
});

test("config rejects bad entries", () => {
  assert.throws(() => parseApps(JSON.stringify({ apps: [{ id: "Bad Id", name: "x" }] })));
  assert.throws(() => parseApps(JSON.stringify({ apps: [{ id: "a", name: "x" }, { id: "a", name: "y" }] })));
  assert.throws(() => parseApps(JSON.stringify({ apps: [{ id: "a", name: "x", filePrefix: "../a" }] })));
  assert.equal(parseApps(JSON.stringify({ apps: [{ id: "a", name: "x" }] }))[0]?.filePrefix, "a");
});
