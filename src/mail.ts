// Alert email, sent through Cloudflare Email Sending's REST API. Without settings, alerts are only logged.
import { readFileSync } from "node:fs";
import type { Transition } from "./health.ts";

export interface Email {
  subject: string;
  text: string;
}

export interface Mailer {
  /** Where mail goes, for logs (or "log only"). */
  describe(): string;
  send(email: Email): Promise<void>;
}

export class LogMailer implements Mailer {
  log: (line: string) => void;
  constructor(log: (line: string) => void) {
    this.log = log;
  }
  describe() {
    return "log only (email not configured)";
  }
  async send(email: Email) {
    this.log(`alert (not emailed): ${email.subject}`);
  }
}

export interface CloudflareMailerOptions {
  accountId: string;
  token: string;
  from: string;
  to: string;
  fetch?: typeof fetch;
  /** Wait before the one retry of a throttled or failed send. */
  retryDelayMs?: number;
}

export class CloudflareMailer implements Mailer {
  opts: Required<CloudflareMailerOptions>;
  constructor(opts: CloudflareMailerOptions) {
    this.opts = { fetch: globalThis.fetch, retryDelayMs: 5_000, ...opts };
  }
  describe() {
    return `email to ${this.opts.to} via Cloudflare`;
  }
  async send(email: Email) {
    const { accountId, token, from, to, fetch, retryDelayMs } = this.opts;
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/email/sending/send`;
    const body = JSON.stringify({ from, to, subject: email.subject, text: email.text });
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(20_000),
      });
      const data = (await res.json().catch(() => null)) as {
        success?: boolean;
        errors?: { code: number; message: string }[];
        result?: { permanent_bounces?: string[] };
      } | null;
      if (res.ok && data?.success) {
        if (data.result?.permanent_bounces?.length) throw new Error(`bounced: ${data.result.permanent_bounces.join(", ")}`);
        return;
      }
      const why = data?.errors?.map((e) => `${e.code} ${e.message}`).join("; ") || `HTTP ${res.status}`;
      // Throttling and server errors may pass on a second try; anything else needs a settings fix.
      if (attempt < 2 && (res.status === 429 || res.status >= 500)) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
        continue;
      }
      throw new Error(`Cloudflare Email Sending refused the message: ${why}`);
    }
  }
}

/** Builds the mailer from the environment. The API token comes from a file, so it never sits in .env or compose. */
export function mailerFromEnv(env: NodeJS.ProcessEnv, log: (line: string) => void): Mailer {
  const { ALERT_EMAIL_TO: to, ALERT_EMAIL_FROM: from, CLOUDFLARE_ACCOUNT_ID: accountId } = env;
  const tokenFile = env.CLOUDFLARE_EMAIL_TOKEN_FILE ?? "/secrets/cloudflare-email-token";
  if (!to) return new LogMailer(log);
  const missing = [!from && "ALERT_EMAIL_FROM", !accountId && "CLOUDFLARE_ACCOUNT_ID"].filter(Boolean);
  let token = "";
  try {
    token = readFileSync(tokenFile, "utf8").trim();
  } catch {
    missing.push(`a token in ${tokenFile}`);
  }
  if (missing.length) {
    log(`ALERT_EMAIL_TO is set but ${missing.join(", ")} is missing: alerts will only be logged`);
    return new LogMailer(log);
  }
  return new CloudflareMailer({ accountId: accountId!, token, from: from!, to });
}

const fmtTime = (ms: number) => new Date(ms).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
    timeZone: process.env.TZ || "UTC", timeZoneName: "short",
  });

export function fmtDuration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} days ${h % 24} h`;
}

export function alertEmail(t: Transition, consoleUrl?: string): Email {
  const where = `${t.app.name}: ${t.check.name}`;
  const link = consoleUrl ? `\n\nConsole: ${consoleUrl.replace(/\/$/, "")}/apps/${t.app.id}` : "";
  if (t.kind === "down") {
    return {
      subject: `[down] ${where}`,
      text: `${where} is not answering as expected.\n\nURL: ${t.check.url}\nProblem: ${t.result.error}\nFirst failure noticed: ${fmtTime(t.downSince)}\n\nYou'll get another email when it recovers.${link}`,
    };
  }
  return {
    subject: `[recovered] ${where}`,
    text: `${where} is answering again.\n\nURL: ${t.check.url}\nDown for about ${fmtDuration(t.result.at - t.downSince)} (since ${fmtTime(t.downSince)}).${link}`,
  };
}
