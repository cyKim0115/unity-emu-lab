// Static file server for a Unity WebGL build folder, on 127.0.0.1 only (no firewall prompt, nothing on the LAN).
// Behavioural reference: scripts/serve-static.ps1.
// - Unity build files (*.data|js|wasm|symbols.json + .br/.gz) go out with Content-Encoding and the inner file's
//   Content-Type, as Unity's loader expects; any other .br/.gz (e.g. StreamingAssets the game unpacks itself) is
//   sent as the raw compressed bytes.
// - COOP/COEP/CORP headers like Unity's own Build And Run server, so multithreaded builds get SharedArrayBuffer
//   (isolation false turns them off for templates that load cross-origin files without CORP/CORS).
// - Plain files answer single byte ranges (a <video> element stops reading once it has enough data).
// - Paths outside the root (../, encoded or not) are 404.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

export const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".data": "application/octet-stream",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".gz": "application/gzip",
};

/** Unity build files that the loader expects with Content-Encoding (Unity names them <name>.<ext>.br / .gz). */
const ENCODED_BUILD_FILE = /\.(data|js|wasm|symbols\.json)\.(br|gz)$/i;

/** Ports Chrome/Edge refuse to load (net::ERR_UNSAFE_PORT) that an ephemeral range could hand out. */
export const BROWSER_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

export interface StaticServer {
  /** http://localhost:<port>/ (Unity's loader and the browser treat localhost as a secure context). */
  url: string;
  port: number;
  root: string;
  close(): Promise<void>;
}

export interface StaticServerOptions {
  root: string;
  /** COOP/COEP/CORP on every response (default true). */
  isolation?: boolean;
  /** One line per request ("HH:mm:ss 200 /Build/x.wasm.br"). */
  log?: (line: string) => void;
}

/** Headers and body range for one file; exported for tests. */
export function contentHeaders(file: string, isolation: boolean): { headers: Record<string, string>; encoded: boolean } {
  let ext = path.extname(file).toLowerCase();
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  let encoded = false;
  if (ENCODED_BUILD_FILE.test(file)) {
    headers["Content-Encoding"] = ext === ".br" ? "br" : "gzip";
    ext = path.extname(file.slice(0, -ext.length)).toLowerCase();
    encoded = true;
  }
  headers["Content-Type"] = MIME_TYPES[ext] ?? "application/octet-stream";
  if (isolation) {
    // Browsers define SharedArrayBuffer only on cross-origin isolated pages, and Unity's loader rejects multithreaded
    // builds without it. Sent on every response (pthread workers need it too).
    headers["Cross-Origin-Opener-Policy"] = "same-origin";
    headers["Cross-Origin-Embedder-Policy"] = "require-corp";
    headers["Cross-Origin-Resource-Policy"] = "cross-origin";
  }
  return { headers, encoded };
}

/** A single "bytes=a-b" / "bytes=a-" / "bytes=-n" range; null = whole file, "unsatisfiable" = 416. */
export function parseRange(header: string | undefined, length: number): { start: number; end: number } | "unsatisfiable" | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? "").trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start: number;
  let end: number;
  if (m[1]) {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), length - 1) : length - 1;
  } else {
    start = Math.max(0, length - Number(m[2]));
    end = length - 1;
  }
  if (start >= length || end < start) return "unsatisfiable";
  return { start, end };
}

/** The file a URL path names inside root, or null when it leaves root or cannot be decoded. */
export function resolveRequestPath(root: string, urlPath: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (rel.includes("\0")) return null;
  rel = rel.replace(/^\/+/, "");
  if (!rel || rel.endsWith("/")) rel += "index.html";
  const full = path.resolve(root, rel);
  const base = root.endsWith(path.sep) ? root : root + path.sep;
  const inside = process.platform === "win32" ? full.toLowerCase().startsWith(base.toLowerCase()) : full.startsWith(base);
  return inside ? full : null;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function handle(req: IncomingMessage, res: ServerResponse, root: string, isolation: boolean, log: (line: string) => void): Promise<void> {
  const urlPath = new URL(req.url ?? "/", "http://localhost").pathname;
  let status = 200;
  let note = "";
  try {
    const file = resolveRequestPath(root, urlPath);
    const st = file ? await stat(file).catch(() => null) : null;
    if (!file || !st || !st.isFile()) {
      status = 404;
      res.writeHead(404, { "Content-Length": "0", "Cache-Control": "no-store" }).end();
      return;
    }
    const { headers, encoded } = contentHeaders(file, isolation);
    const length = st.size;
    let start = 0;
    let end = length - 1;
    if (!encoded) {
      headers["Accept-Ranges"] = "bytes";
      const range = parseRange(req.headers.range, length);
      if (range === "unsatisfiable") {
        status = 416;
        res.writeHead(416, { ...headers, "Content-Range": `bytes */${length}`, "Content-Length": "0" }).end();
        return;
      }
      if (range) {
        status = 206;
        start = range.start;
        end = range.end;
        headers["Content-Range"] = `bytes ${start}-${end}/${length}`;
      }
    }
    const count = length === 0 ? 0 : end - start + 1;
    headers["Content-Length"] = String(count);
    res.writeHead(status, headers);
    if (req.method === "HEAD" || count === 0) {
      res.end();
      return;
    }
    await new Promise<void>((resolve) => {
      const stream = createReadStream(file, { start, end });
      stream.on("error", (err) => {
        note = ` (stopped: ${err.message})`;
        res.destroy();
        resolve();
      });
      res.on("close", () => {
        if (!res.writableFinished && !note) note = " (stopped: client closed)";
        stream.destroy();
        resolve();
      });
      stream.pipe(res);
    });
  } catch (err) {
    status = 500;
    note = ` ERROR ${(err as Error).message}`;
    if (!res.headersSent) res.writeHead(500, { "Content-Length": "0" });
    res.end();
  } finally {
    log(`${stamp()} ${status} ${urlPath}${note}`);
  }
}

async function listenOnce(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

/** Start the server on a free loopback port the browser will load. */
export async function startStaticServer(o: StaticServerOptions): Promise<StaticServer> {
  const root = path.resolve(o.root);
  const isolation = o.isolation ?? true;
  const log = o.log ?? (() => {});
  const make = () => createServer((req, res) => void handle(req, res, root, isolation, log));
  const held: Server[] = [];
  try {
    for (let i = 0; i < 50; i++) {
      const server = make();
      const port = await listenOnce(server);
      if (BROWSER_BLOCKED_PORTS.has(port)) {
        // Keep it bound while retrying so the next pick is a different port.
        held.push(server);
        continue;
      }
      return {
        url: `http://localhost:${port}/`,
        port,
        root,
        close: () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      };
    }
    throw new Error("No free port that the browser will load.");
  } finally {
    for (const s of held) s.close();
  }
}
