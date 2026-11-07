// Reads an app's builds folder and groups the files the way the page shows them.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export type Kind = "apk" | "aab" | "ipa";

export interface ParsedName {
  kind: Kind;
  version: string;
  /** What follows the version, like "dev.a1b2c3d" or "alpha". Empty for a release build. */
  extra: string;
  /** CPU architecture in an APK's name, like "arm64". */
  abi: string;
}

const ABIS = ["arm64-v8a", "armeabi-v7a", "x86_64", "x86", "arm64", "universal"];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Release:   my-app-1.2.0-arm64.apk, its Play bundle my-app-1.2.0.aab, my-app-1.2.0.ipa
 * Dev build: my-app-1.2.0-dev.a1b2c3d-arm64.apk, my-app-1.2.0-dev.a1b2c3d.ipa
 * Returns null for a file that isn't a build of this app.
 */
export function parseBuildName(name: string, prefix: string): ParsedName | null {
  const m = new RegExp(`^${escapeRe(prefix)}-(\\d+\\.\\d+\\.\\d+)(?:-(.+?))?\\.(apk|aab|ipa)$`).exec(name);
  if (!m) return null;
  const [, version = "", rest = "", kind] = m;
  let extra = rest;
  let abi = "";
  for (const a of ABIS) {
    if (extra === a) { abi = a; extra = ""; break; }
    if (extra.endsWith(`-${a}`)) { abi = a; extra = extra.slice(0, -a.length - 1); break; }
  }
  return { kind: kind as Kind, version, extra, abi };
}

export interface FileInfo {
  name: string;
  size: number;
  mtime: string;
  url: string;
  /** Link to the build's .sha256 file, when one was published beside it. */
  sha256Url?: string;
}

export interface Build extends FileInfo {
  version: string;
  extra: string;
  abi: string;
  release: boolean;
  /** For a release APK, the Play bundle of the same version. */
  aab?: FileInfo;
}

export interface BuildList {
  android: Build[];
  ios: Build[];
}

export async function listBuilds(dir: string, prefix: string, urlBase: string): Promise<BuildList> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { android: [], ios: [] };
    throw e;
  }
  const visible = names.filter((n) => !n.startsWith(".")); // dot files are copies still in progress
  const present = new Set(visible);
  const info = async (name: string): Promise<FileInfo | null> => {
    const s = await stat(join(dir, name)).catch(() => null);
    if (!s?.isFile()) return null;
    const f: FileInfo = { name, size: s.size, mtime: s.mtime.toISOString(), url: urlBase + encodeURIComponent(name) };
    if (present.has(`${name}.sha256`)) f.sha256Url = urlBase + encodeURIComponent(`${name}.sha256`);
    return f;
  };

  const builds: Build[] = [];
  const aabs = new Map<string, FileInfo>();
  await Promise.all(
    visible.map(async (name) => {
      const p = parseBuildName(name, prefix);
      if (!p) return;
      const f = await info(name);
      if (!f) return;
      if (p.kind === "aab") {
        if (!p.extra) aabs.set(p.version, f);
        return;
      }
      builds.push({ ...f, version: p.version, extra: p.extra, abi: p.abi, release: !p.extra });
    }),
  );

  const newestFirst = (a: Build, b: Build) => b.mtime.localeCompare(a.mtime) || b.name.localeCompare(a.name);
  const android = builds.filter((b) => b.name.endsWith(".apk")).sort(newestFirst);
  for (const b of android) {
    const aab = b.release ? aabs.get(b.version) : undefined;
    if (aab) b.aab = aab;
  }
  const ios = builds.filter((b) => b.name.endsWith(".ipa")).sort(newestFirst);
  return { android, ios };
}
