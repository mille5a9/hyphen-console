import assert from "node:assert/strict";
import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listBuilds, parseBuildName } from "../src/builds.ts";

test("parses release, dev and iOS build names", () => {
  assert.deepEqual(parseBuildName("my-app-1.2.0-arm64.apk", "my-app"), { kind: "apk", version: "1.2.0", extra: "", abi: "arm64" });
  assert.deepEqual(parseBuildName("my-app-1.2.0-dev.a1b2c3d-dirty-arm64.apk", "my-app"), { kind: "apk", version: "1.2.0", extra: "dev.a1b2c3d-dirty", abi: "arm64" });
  assert.deepEqual(parseBuildName("my-app-0.2.0-alpha-arm64.apk", "my-app"), { kind: "apk", version: "0.2.0", extra: "alpha", abi: "arm64" });
  assert.deepEqual(parseBuildName("my-app-1.2.0.aab", "my-app"), { kind: "aab", version: "1.2.0", extra: "", abi: "" });
  assert.deepEqual(parseBuildName("my-app-1.2.0-dev.a1b2c3d.ipa", "my-app"), { kind: "ipa", version: "1.2.0", extra: "dev.a1b2c3d", abi: "" });
});

test("ignores other apps and other files", () => {
  assert.equal(parseBuildName("other-1.2.0-arm64.apk", "my-app"), null);
  assert.equal(parseBuildName("my-app-1.2.0-arm64.apk.sha256", "my-app"), null);
  assert.equal(parseBuildName("my-app-demo.mp4", "my-app"), null);
  assert.equal(parseBuildName("my-app.x-1.2.0.apk", "my-app"), null);
});

test("lists builds newest first, pairs release APKs with their AAB, skips dot files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "console-builds-"));
  const files: [string, number][] = [
    ["my-app-1.0.0-arm64.apk", 1],
    ["my-app-1.0.0.aab", 1],
    ["my-app-1.1.0-dev.abc1234-arm64.apk", 2],
    ["my-app-1.1.0-arm64.apk", 3],
    ["my-app-1.1.0-arm64.apk.sha256", 3],
    ["my-app-1.1.0.ipa", 4],
    [".my-app-1.2.0-arm64.apk.part", 5],
    ["notes.txt", 6],
  ];
  for (const [name, day] of files) {
    const p = join(dir, name);
    await writeFile(p, name);
    const t = new Date(Date.UTC(2026, 0, day));
    await utimes(p, t, t);
  }
  const list = await listBuilds(dir, "my-app", "/files/my-app/");
  assert.deepEqual(list.android.map((b) => b.name), ["my-app-1.1.0-arm64.apk", "my-app-1.1.0-dev.abc1234-arm64.apk", "my-app-1.0.0-arm64.apk"]);
  assert.deepEqual(list.ios.map((b) => b.name), ["my-app-1.1.0.ipa"]);
  assert.equal(list.android[2]?.aab?.name, "my-app-1.0.0.aab");
  assert.equal(list.android[0]?.aab, undefined);
  assert.equal(list.android[0]?.sha256Url, "/files/my-app/my-app-1.1.0-arm64.apk.sha256");
  assert.equal(list.android[1]?.release, false);
});

test("a missing folder is an empty list", async () => {
  assert.deepEqual(await listBuilds(join(tmpdir(), "does-not-exist-console"), "x", "/"), { android: [], ios: [] });
});
