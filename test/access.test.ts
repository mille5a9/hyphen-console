import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ALLOWED, makeAllowlist, parseCidr } from "../src/access.ts";

test("default allowlist admits home network, docker, loopback and tailnet", () => {
  const ok = makeAllowlist(DEFAULT_ALLOWED);
  for (const ip of ["192.168.1.20", "10.1.2.3", "172.17.0.1", "127.0.0.1", "100.101.102.103", "::1", "::ffff:192.168.1.5", "fd7a:115c:a1e0::1234", "fe80::1%eth0"]) {
    assert.ok(ok(ip), ip);
  }
});

test("default allowlist refuses public addresses", () => {
  const ok = makeAllowlist(DEFAULT_ALLOWED);
  for (const ip of ["8.8.8.8", "100.128.0.1", "172.32.0.1", "::ffff:1.1.1.1", "2001:4860:4860::8888", undefined, "", "garbage"]) {
    assert.equal(ok(ip), false, String(ip));
  }
});

test("a narrowed list only admits its ranges", () => {
  const ok = makeAllowlist(["192.168.1.0/24"]);
  assert.ok(ok("192.168.1.200"));
  assert.equal(ok("192.168.2.1"), false);
  assert.equal(ok("::1"), false);
});

test("bad CIDRs are rejected", () => {
  assert.throws(() => parseCidr("192.168.1.0/33"));
  assert.throws(() => parseCidr("not-an-ip/8"));
});
