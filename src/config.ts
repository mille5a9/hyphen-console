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
    return { id: a.id, name: a.name, filePrefix, ios: a.ios, android: a.android };
  });
}

export function loadApps(path: string): AppConfig[] {
  return parseApps(readFileSync(path, "utf8"));
}
