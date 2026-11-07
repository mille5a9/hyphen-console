// Client allowlist: the console only answers addresses on the home network or the tailnet.
import { isIPv4, isIPv6 } from "node:net";

export const DEFAULT_ALLOWED = [
  "10.0.0.0/8",
  "172.16.0.0/12", // includes Docker's bridge networks
  "192.168.0.0/16",
  "127.0.0.0/8",
  "100.64.0.0/10", // Tailscale (CGNAT range)
  "::1/128",
  "fd7a:115c:a1e0::/48", // Tailscale IPv6
  "fc00::/7", // other unique-local IPv6
  "fe80::/10", // link-local
];

interface Cidr {
  v6: boolean;
  base: bigint;
  mask: bigint;
}

function ipv4ToBig(ip: string): bigint {
  return ip.split(".").reduce((n, part) => (n << 8n) | BigInt(Number(part)), 0n);
}

function ipv6ToBig(ip: string): bigint {
  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two hex groups first.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (v4?.[1]) {
    const n = ipv4ToBig(v4[1]);
    ip = ip.slice(0, -v4[1].length) + `${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`;
  }
  const [head = "", tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(8 - h.length - t.length).fill("0"), ...t];
  return groups.reduce((n, g) => (n << 16n) | BigInt(parseInt(g || "0", 16)), 0n);
}

export function parseCidr(text: string): Cidr {
  const [addr = "", bitsText] = text.trim().split("/");
  const v6 = isIPv6(addr);
  if (!v6 && !isIPv4(addr)) throw new Error(`Not a CIDR: ${text}`);
  const width = v6 ? 128 : 32;
  const bits = bitsText === undefined ? width : Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) throw new Error(`Bad prefix length: ${text}`);
  const all = (1n << BigInt(width)) - 1n;
  const mask = (all << BigInt(width - bits)) & all;
  const base = (v6 ? ipv6ToBig(addr) : ipv4ToBig(addr)) & mask;
  return { v6, base, mask };
}

export function makeAllowlist(cidrs: string[]): (address: string | undefined) => boolean {
  const ranges = cidrs.map(parseCidr);
  return (address) => {
    if (!address) return false;
    let ip = address.replace(/%.*$/, ""); // drop an IPv6 zone id
    // IPv4 clients on a dual-stack socket show up as ::ffff:a.b.c.d.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped?.[1]) ip = mapped[1];
    const v6 = isIPv6(ip);
    if (!v6 && !isIPv4(ip)) return false;
    const n = v6 ? ipv6ToBig(ip) : ipv4ToBig(ip);
    return ranges.some((r) => r.v6 === v6 && (n & r.mask) === r.base);
  };
}
