// App Store Connect Analytics Reports API: daily crashes and sessions.
//
// Apple doesn't answer queries. Instead, an ongoing "report request" makes Apple generate reports every day; each
// report has instances (one per processing date), and each instance has gzipped CSV segments behind links that expire
// after 5 minutes. Late events arrive in later instances, so values are summed into the day they belong to, and each
// instance is processed once.
import { gunzipSync } from "node:zlib";
import type { AppleClient } from "./apple.ts";
import { StoreApiError } from "./review.ts";

/**
 * The reports used (matched by name prefix, preferring a "Standard" variant over "Detailed"), and the column summed
 * from each, by event date.
 */
export const APPLE_REPORTS = [
  { metric: "crashes", name: "App Crashes", column: "Crashes" },
  { metric: "sessions", name: "App Sessions", column: "Sessions" },
] as const;

export function pickReport(reports: { id: string; name: string }[], prefix: string): { id: string; name: string } | null {
  const matches = reports.filter((r) => r.name === prefix || r.name.startsWith(`${prefix} `));
  return matches.find((r) => r.name === prefix) ?? matches.find((r) => /standard/i.test(r.name)) ?? matches.find((r) => !/detailed/i.test(r.name)) ?? matches[0] ?? null;
}

export interface Instance {
  id: string;
  processingDate: string;
}

export class AppleAnalytics {
  client: Pick<AppleClient, "get" | "post" | "appId">;
  fetch: typeof fetch;

  constructor(client: Pick<AppleClient, "get" | "post" | "appId">, fetchImpl: typeof fetch = globalThis.fetch) {
    this.client = client;
    this.fetch = fetchImpl;
  }

  /** The app's ongoing report request, created on first use. `created` is true when this call made it. */
  async ensureRequest(appleAppId: string): Promise<{ id: string; created: boolean }> {
    const existing = await this.client.get<{ data: { id: string; attributes: { stoppedDueToInactivity?: boolean } }[] }>(
      `/v1/apps/${appleAppId}/analyticsReportRequests?filter[accessType]=ONGOING&limit=10`,
    );
    // Apple stops a request nobody downloads from for a while; a stopped one gets no new data, so make a fresh one.
    const live = existing.data.find((r) => !r.attributes.stoppedDueToInactivity);
    if (live) return { id: live.id, created: false };
    try {
      return { id: await createReportRequest(this.client, appleAppId), created: true };
    } catch (e) {
      if ((e as StoreApiError).status === 403) {
        throw new StoreApiError(
          "this key can read analytics reports but not start them. Start them once with an Admin key: node src/cli.ts apple-report-request <admin key id> <admin .p8 file>",
          403,
        );
      }
      throw e;
    }
  }

  /** The request's App Usage reports (crashes and sessions live there). Empty until Apple generates the first ones. */
  async usageReports(requestId: string): Promise<{ id: string; name: string }[]> {
    const out: { id: string; name: string }[] = [];
    let next: string | undefined = `/v1/analyticsReportRequests/${requestId}/reports?filter[category]=APP_USAGE&limit=200`;
    for (let page = 0; next && page < 5; page++) {
      const data: { data: { id: string; attributes: { name: string } }[]; links?: { next?: string } } = await this.client.get(next);
      out.push(...data.data.map((r) => ({ id: r.id, name: r.attributes.name })));
      next = data.links?.next;
    }
    return out;
  }

  async dailyInstances(reportId: string): Promise<Instance[]> {
    const out: Instance[] = [];
    let next: string | undefined = `/v1/analyticsReports/${reportId}/instances?filter[granularity]=DAILY&limit=200`;
    for (let page = 0; next && page < 10; page++) {
      const data: { data: { id: string; attributes: { processingDate: string } }[]; links?: { next?: string } } = await this.client.get(next);
      out.push(...data.data.map((d) => ({ id: d.id, processingDate: d.attributes.processingDate })));
      next = data.links?.next;
    }
    return out.sort((a, b) => a.processingDate.localeCompare(b.processingDate));
  }

  /** Downloads an instance's segments and sums `column` per event date. */
  async instanceTotals(instanceId: string, column: string): Promise<Map<string, number>> {
    const segs = await this.client.get<{ data: { attributes: { url: string } }[] }>(`/v1/analyticsReportInstances/${instanceId}/segments?limit=200`);
    const totals = new Map<string, number>();
    for (const seg of segs.data) {
      const res = await this.fetch(seg.attributes.url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new StoreApiError(`Report download ${res.status}`, res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      const text = (buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString("utf8");
      for (const [date, n] of sumByDate(text, column)) totals.set(date, (totals.get(date) ?? 0) + n);
    }
    return totals;
  }
}

/**
 * Starts Apple's daily analytics reports for an app. Only an Admin key may do this (a Finance or Sales key can then
 * list and download them), so the console does it once, from the CLI, with a key that needn't stay around.
 */
export async function createReportRequest(client: Pick<AppleClient, "post">, appleAppId: string): Promise<string> {
  const made = await client.post<{ data: { id: string } }>("/v1/analyticsReportRequests", {
    data: {
      type: "analyticsReportRequests",
      attributes: { accessType: "ONGOING" },
      relationships: { app: { data: { type: "apps", id: appleAppId } } },
    },
  });
  return made.data.id;
}

/** Sums a numeric column per Date from a report file (tab- or comma-separated, with a header row). */
export function sumByDate(text: string, column: string): Map<string, number> {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  const totals = new Map<string, number>();
  const header = lines.shift();
  if (!header) return totals;
  const sep = header.includes("\t") ? "\t" : ",";
  const split = (l: string) => (sep === "\t" ? l.split("\t") : splitCsv(l)).map((c) => c.trim());
  const cols = split(header);
  const di = cols.indexOf("Date");
  const vi = cols.indexOf(column);
  if (di < 0 || vi < 0) throw new Error(`report has no "Date" and "${column}" columns (has: ${cols.join(", ")})`);
  for (const line of lines) {
    const cells = split(line);
    const date = cells[di] ?? "";
    const n = Number(cells[vi]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(n)) totals.set(date, (totals.get(date) ?? 0) + n);
  }
  return totals;
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
