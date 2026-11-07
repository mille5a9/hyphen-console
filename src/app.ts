// The request handler: the page, a small JSON API, and the build files themselves.
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { listBuilds, parseBuildName } from "./builds.ts";
import type { AppConfig } from "./config.ts";

export interface Options {
  apps: AppConfig[];
  /** Folder with one subfolder of builds per app id. */
  buildsRoot: string;
  /** Folder with index.html, app.js and app.css. */
  publicDir: string;
  isAllowed: (address: string | undefined) => boolean;
  log?: (line: string) => void;
}

const STATIC: Record<string, string> = {
  "/app.js": "text/javascript; charset=utf-8",
  "/app.css": "text/css; charset=utf-8",
};

const FILE_TYPES: Record<string, string> = {
  apk: "application/vnd.android.package-archive",
  aab: "application/octet-stream",
  ipa: "application/octet-stream",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

export function createHandler(opts: Options) {
  const byId = new Map(opts.apps.map((a) => [a.id, a]));
  const log = opts.log ?? (() => {});

  const send = (res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8") => {
    res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
    res.end(res.req.method === "HEAD" ? undefined : body);
  };
  const json = (res: ServerResponse, status: number, data: unknown) =>
    send(res, status, JSON.stringify(data), "application/json; charset=utf-8");

  async function sendStatic(res: ServerResponse, file: string, type: string) {
    const body = await readFile(join(opts.publicDir, file));
    res.writeHead(200, { "Content-Type": type, "Content-Length": body.length, "Cache-Control": "no-cache" });
    res.end(res.req.method === "HEAD" ? undefined : body);
  }

  async function sendBuildFile(req: IncomingMessage, res: ServerResponse, app: AppConfig, rawName: string) {
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      return send(res, 400, "Bad file name");
    }
    // Only build files (and their checksums) by name: no paths, no dot files, nothing else in the folder.
    const isChecksum = name.endsWith(".sha256");
    const parsed = parseBuildName(isChecksum ? name.slice(0, -7) : name, app.filePrefix);
    if (!parsed || /[/\\]/.test(name) || name.startsWith(".")) return send(res, 404, "Not found");

    const path = join(opts.buildsRoot, app.id, name);
    const s = await stat(path).catch(() => null);
    if (!s?.isFile()) return send(res, 404, "Not found");

    const headers: Record<string, string | number> = {
      "Content-Type": isChecksum ? "text/plain; charset=utf-8" : (FILE_TYPES[parsed.kind] ?? "application/octet-stream"),
      "Accept-Ranges": "bytes",
      "Last-Modified": s.mtime.toUTCString(),
      "Cache-Control": "no-cache",
    };
    if (!isChecksum) headers["Content-Disposition"] = `attachment; filename="${name}"`;

    // A single byte range, so a phone can resume a big download.
    let start = 0;
    let end = s.size - 1;
    let status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(Number(range[2]), end);
      } else {
        start = Math.max(0, s.size - Number(range[2]));
      }
      if (start > end || start >= s.size) {
        res.writeHead(416, { "Content-Range": `bytes */${s.size}` });
        return res.end();
      }
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${s.size}`;
    }
    headers["Content-Length"] = s.size === 0 ? 0 : end - start + 1;
    res.writeHead(status, headers);
    if (req.method === "HEAD" || s.size === 0) return res.end();
    const stream = createReadStream(path, { start, end });
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://console");
    const path = url.pathname;

    if (path === "/healthz") return send(res, 200, "ok\n");
    if (path === "/" || /^\/apps\/[a-z0-9-]+\/?$/.test(path)) {
      return sendStatic(res, "index.html", "text/html; charset=utf-8");
    }
    const staticType = STATIC[path];
    if (staticType) return sendStatic(res, path.slice(1), staticType);

    if (path === "/api/apps") return json(res, 200, opts.apps.map(({ id, name }) => ({ id, name })));

    let m = /^\/api\/apps\/([a-z0-9-]+)\/builds$/.exec(path);
    if (m) {
      const app = byId.get(m[1] ?? "");
      if (!app) return json(res, 404, { error: "No such app" });
      const builds = await listBuilds(join(opts.buildsRoot, app.id), app.filePrefix, `/files/${app.id}/`);
      return json(res, 200, { app: { id: app.id, name: app.name }, ...builds });
    }

    m = /^\/files\/([a-z0-9-]+)\/([^/]+)$/.exec(path);
    if (m) {
      const app = byId.get(m[1] ?? "");
      if (!app) return send(res, 404, "Not found");
      return sendBuildFile(req, res, app, m[2] ?? "");
    }

    return send(res, 404, "Not found");
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const address = req.socket.remoteAddress;
    if (!opts.isAllowed(address)) {
      log(`refused ${address} ${req.method} ${req.url}`);
      return send(res, 403, "Forbidden");
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      return send(res, 405, "Method not allowed");
    }
    try {
      await route(req, res);
    } catch (e) {
      log(`error ${req.method} ${req.url}: ${(e as Error).stack ?? e}`);
      if (!res.headersSent) send(res, 500, "Something went wrong");
      else res.destroy();
    }
  };
}
