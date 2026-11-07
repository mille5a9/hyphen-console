// The apps the console knows about, read from a JSON file that stays out of git (see config/apps.example.json).
import { readFileSync } from "node:fs";

export interface AppConfig {
  /** Lowercase slug: the URL path and the app's builds subfolder. */
  id: string;
  name: string;
  /** Build files are named <filePrefix>-<version>...; defaults to the id. */
  filePrefix: string;
  ios?: { bundleId?: string; appStoreId?: string };
  android?: { package?: string };
  /** URLs to check on a schedule, like the app's backend. */
  health: HealthCheck[];
}

export interface HealthCheck {
  /** "<app id>/<slug of name>": stable key for stored history. */
  key: string;
  name: string;
  url: string;
  /**
   * The HTTP status that means "up". Leave it out to accept any 2xx. An API that needs a key can be checked without
   * one by expecting its 401: that still proves it answers, and costs nothing upstream.
   */
  expectStatus?: number;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "check";

function parseHealth(raw: unknown, appId: string, where: string): HealthCheck[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${where}.health must be an array`);
  const keys = new Set<string>();
  return raw.map((c: Partial<HealthCheck>, j) => {
    const at = `${where}.health[${j}]`;
    if (typeof c.name !== "string" || !c.name.trim()) throw new Error(`${at}.name is required`);
    let url: URL;
    try {
      url = new URL(String(c.url));
    } catch {
      throw new Error(`${at}.url must be a full URL`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${at}.url must be http(s)`);
    if (c.expectStatus !== undefined && !(Number.isInteger(c.expectStatus) && c.expectStatus >= 100 && c.expectStatus <= 599)) {
      throw new Error(`${at}.expectStatus must be an HTTP status code`);
    }
    const key = `${appId}/${slug(c.name)}`;
    if (keys.has(key)) throw new Error(`${at}.name repeats another check's name`);
    keys.add(key);
    return { key, name: c.name, url: url.href, ...(c.expectStatus !== undefined && { expectStatus: c.expectStatus }) };
  });
}

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function parseApps(json: string): AppConfig[] {
  const data: unknown = JSON.parse(json);
  const list = (data as { apps?: unknown })?.apps;
  if (!Array.isArray(list)) throw new Error('apps config needs an "apps" array');
  const seen = new Set<string>();
  return list.map((raw, i) => {
    const a = raw as Partial<AppConfig>;
    if (typeof a.id !== "string" || !ID.test(a.id)) throw new Error(`apps[${i}].id must be a lowercase slug`);
    if (seen.has(a.id)) throw new Error(`apps[${i}].id "${a.id}" is listed twice`);
    seen.add(a.id);
    if (typeof a.name !== "string" || !a.name.trim()) throw new Error(`apps[${i}].name is required`);
    const filePrefix = a.filePrefix ?? a.id;
    if (typeof filePrefix !== "string" || !/^[A-Za-z0-9._-]+$/.test(filePrefix)) {
      throw new Error(`apps[${i}].filePrefix may only hold letters, digits, dots, dashes and underscores`);
    }
    const health = parseHealth(a.health, a.id, `apps[${i}]`);
    return { id: a.id, name: a.name, filePrefix, ios: a.ios, android: a.android, health };
  });
}

export function loadApps(path: string): AppConfig[] {
  return parseApps(readFileSync(path, "utf8"));
}
