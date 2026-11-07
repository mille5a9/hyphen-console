// Runs each app's health checks and decides when an outage (or its end) is worth an email.
import type { AppConfig, HealthCheck } from "./config.ts";
import type { CheckResult, CheckState, Store } from "./store.ts";

export interface Transition {
  kind: "down" | "up";
  app: AppConfig;
  check: HealthCheck;
  result: CheckResult;
  /** When the outage began (for "up", how long it lasted). */
  downSince: number;
}

export interface MonitorOptions {
  apps: AppConfig[];
  store: Store;
  /** Failures in a row before a check counts as down. One miss is often a blip. */
  failThreshold?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export async function runCheck(check: HealthCheck, opts: { fetch: typeof fetch; timeoutMs: number; now: () => number }): Promise<CheckResult> {
  const start = opts.now();
  try {
    const res = await opts.fetch(check.url, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": "hyphen-console-health/1" },
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    await res.body?.cancel();
    const ok = check.expectStatus !== undefined ? res.status === check.expectStatus : res.status >= 200 && res.status < 300;
    const want = check.expectStatus ?? "2xx";
    return { key: check.key, at: start, ok, status: res.status, ms: opts.now() - start, error: ok ? null : `HTTP ${res.status}, expected ${want}` };
  } catch (e) {
    // fetch() wraps the real reason (DNS failure, refused connection, TLS error) in `cause`.
    const err = e as Error & { cause?: { code?: string; message?: string } };
    const error = err.name === "TimeoutError" ? `no answer in ${opts.timeoutMs / 1000}s` : (err.cause?.code ?? err.cause?.message ?? err.message);
    return { key: check.key, at: start, ok: false, status: null, ms: opts.now() - start, error };
  }
}

/** The next alert state after one result, and whether that crosses into "down" or back to "up". */
export function step(prev: CheckState | undefined, result: CheckResult, failThreshold: number): { state: CheckState; transition?: "down" | "up" } {
  const s: CheckState = prev ?? { key: result.key, up: true, since: result.at, fails: 0, alerted: false };
  if (result.ok) {
    const state = { ...s, fails: 0, up: true, since: s.up ? s.since : result.at, alerted: false };
    return { state, transition: !s.up && s.alerted ? "up" : undefined };
  }
  const fails = s.fails + 1;
  if (s.up && fails >= failThreshold) {
    return { state: { ...s, fails, up: false, since: result.at, alerted: true }, transition: "down" };
  }
  return { state: { ...s, fails } };
}

export class Monitor {
  opts: Required<MonitorOptions>;

  constructor(opts: MonitorOptions) {
    this.opts = { failThreshold: 2, timeoutMs: 10_000, fetch: globalThis.fetch, now: Date.now, ...opts };
  }

  /** Runs every check once and returns the transitions to alert on. */
  async tick(): Promise<Transition[]> {
    const { apps, store, failThreshold, timeoutMs, fetch, now } = this.opts;
    const jobs = apps.flatMap((app) => app.health.map((check) => ({ app, check })));
    const results = await Promise.all(jobs.map(({ check }) => runCheck(check, { fetch, timeoutMs, now })));
    const out: Transition[] = [];
    jobs.forEach(({ app, check }, i) => {
      const result = results[i]!;
      store.addResult(result);
      const prev = store.getState(check.key);
      const { state, transition } = step(prev, result, failThreshold);
      store.setState(state);
      if (transition) out.push({ kind: transition, app, check, result, downSince: transition === "up" ? prev!.since : state.since });
    });
    store.prune(now());
    return out;
  }

  status(now = this.opts.now()) {
    const { apps, store } = this.opts;
    return apps.flatMap((app) =>
      app.health.map((check) => {
        const state = store.getState(check.key);
        const last = store.lastResult(check.key);
        return {
          key: check.key,
          appId: app.id,
          name: check.name,
          url: check.url,
          up: last ? (state?.up ?? true) : null,
          since: state?.since ?? null,
          last: last ? { at: last.at, ok: last.ok, status: last.status, ms: last.ms, error: last.error } : null,
          uptime24h: store.uptime(check.key, now - 86_400_000),
          uptime7d: store.uptime(check.key, now - 7 * 86_400_000),
        };
      }),
    );
  }
}
