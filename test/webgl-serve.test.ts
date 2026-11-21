// The WebGL static server (src/webgl/serve.ts): headers Unity's loader needs, byte ranges, isolation on/off and
// paths that try to leave the build folder. Runs a real server on 127.0.0.1; no browser.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import path from "node:path";
import { BROWSER_BLOCKED_PORTS, contentHeaders, parseRange, resolveRequestPath, startStaticServer } from "../src/webgl/serve.ts";
import { tempLabHome } from "./helpers/fake.ts";

/** A raw GET/HEAD (fetch would normalise "../" away before sending it). */
function raw(port: number, rawPath: string, o: { method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: rawPath, method: o.method ?? "GET", headers: o.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("contentHeaders", () => {
  test("Unity build files get Content-Encoding and the inner type", () => {
    const wasm = contentHeaders("/b/Build/x.wasm.br", true);
    assert.equal(wasm.encoded, true);
    assert.equal(wasm.headers["Content-Encoding"], "br");
    assert.equal(wasm.headers["Content-Type"], "application/wasm");
    const js = contentHeaders("/b/Build/x.framework.js.gz", true);
    assert.equal(js.headers["Content-Encoding"], "gzip");
    assert.equal(js.headers["Content-Type"], "application/javascript");
    const data = contentHeaders("/b/Build/x.data.gz", true);
    assert.equal(data.headers["Content-Type"], "application/octet-stream");
    const sym = contentHeaders("/b/Build/x.symbols.json.br", true);
    assert.equal(sym.headers["Content-Encoding"], "br");
    assert.equal(sym.headers["Content-Type"], "application/json");
  });

  test("other .br/.gz files go out as raw bytes; isolation headers only when asked", () => {
    const other = contentHeaders("/b/StreamingAssets/level.bin.br", true);
    assert.equal(other.encoded, false);
    assert.equal(other.headers["Content-Encoding"], undefined);
    assert.equal(contentHeaders("/b/StreamingAssets/a.gz", false).headers["Content-Type"], "application/gzip");
    assert.equal(contentHeaders("/b/index.html", true).headers["Cross-Origin-Embedder-Policy"], "require-corp");
    assert.equal(contentHeaders("/b/index.html", true).headers["Cross-Origin-Opener-Policy"], "same-origin");
    assert.equal(contentHeaders("/b/index.html", false).headers["Cross-Origin-Embedder-Policy"], undefined);
    assert.equal(contentHeaders("/b/index.html", false).headers["Content-Type"], "text/html; charset=utf-8");
  });
});

describe("parseRange", () => {
  test("single ranges, open ends, suffixes and the unsatisfiable ones", () => {
    assert.deepEqual(parseRange("bytes=0-9", 100), { start: 0, end: 9 });
    assert.deepEqual(parseRange("bytes=90-", 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange("bytes=50-500", 100), { start: 50, end: 99 });
    assert.equal(parseRange("bytes=100-", 100), "unsatisfiable");
    assert.equal(parseRange("bytes=9-3", 100), "unsatisfiable");
    assert.equal(parseRange(undefined, 100), null);
    assert.equal(parseRange("bytes=0-1,5-6", 100), null);
    assert.equal(parseRange("bytes=-", 100), null);
  });
});

describe("resolveRequestPath", () => {
  const root = path.resolve(tempLabHome());
  test("index.html for folders, files inside the root", () => {
    assert.equal(resolveRequestPath(root, "/"), path.join(root, "index.html"));
    assert.equal(resolveRequestPath(root, "/sub/"), path.join(root, "sub", "index.html"));
    assert.equal(resolveRequestPath(root, "/Build/a%20b.wasm"), path.join(root, "Build", "a b.wasm"));
  });
  test("anything that leaves the root, or cannot be decoded, is refused", () => {
    assert.equal(resolveRequestPath(root, "/../secret.txt"), null);
    assert.equal(resolveRequestPath(root, "/%2e%2e/secret.txt"), null);
    assert.equal(resolveRequestPath(root, "/Build/../../secret.txt"), null);
    assert.equal(resolveRequestPath(root, "/%E0%A4%A"), null);
    assert.equal(resolveRequestPath(root, "/a%00b"), null);
    if (process.platform === "win32") assert.equal(resolveRequestPath(root, "/..%5csecret.txt"), null);
  });
});

describe("startStaticServer", () => {
  const dir = tempLabHome();
  const build = path.join(dir, "build");
  mkdirSync(path.join(build, "Build"), { recursive: true });
  writeFileSync(path.join(build, "index.html"), "<!doctype html><p>hi</p>");
  writeFileSync(path.join(build, "Build", "x.wasm.br"), Buffer.from([1, 2, 3, 4]));
  writeFileSync(path.join(build, "movie.mp4"), Buffer.from("0123456789"));
  writeFileSync(path.join(dir, "secret.txt"), "secret");

  test("serves index.html with isolation headers on a port the browser loads, and logs requests", async () => {
    const lines: string[] = [];
    const s = await startStaticServer({ root: build, log: (l) => lines.push(l) });
    try {
      assert.ok(!BROWSER_BLOCKED_PORTS.has(s.port));
      assert.equal(s.url, `http://localhost:${s.port}/`);
      const r = await raw(s.port, "/");
      assert.equal(r.status, 200);
      assert.equal(r.body.toString(), "<!doctype html><p>hi</p>");
      assert.equal(r.headers["cross-origin-opener-policy"], "same-origin");
      assert.equal(r.headers["cross-origin-embedder-policy"], "require-corp");
      assert.equal(r.headers["cache-control"], "no-store");
      const w = await raw(s.port, "/Build/x.wasm.br");
      assert.equal(w.headers["content-encoding"], "br");
      assert.equal(w.headers["content-type"], "application/wasm");
      assert.equal(w.headers["accept-ranges"], undefined, "no ranges on encoded files");
      assert.deepEqual([...w.body], [1, 2, 3, 4]);
      assert.ok(lines.some((l) => / 200 \/Build\/x\.wasm\.br$/.test(l)), lines.join("\n"));
    } finally {
      await s.close();
    }
  });

  test("ranges, HEAD, 404 and 416; nothing outside the root", async () => {
    const s = await startStaticServer({ root: build, isolation: false });
    try {
      const part = await raw(s.port, "/movie.mp4", { headers: { Range: "bytes=2-5" } });
      assert.equal(part.status, 206);
      assert.equal(part.body.toString(), "2345");
      assert.equal(part.headers["content-range"], "bytes 2-5/10");
      assert.equal(part.headers["cross-origin-embedder-policy"], undefined);
      const head = await raw(s.port, "/movie.mp4", { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(head.headers["content-length"], "10");
      assert.equal(head.body.length, 0);
      assert.equal((await raw(s.port, "/movie.mp4", { headers: { Range: "bytes=20-" } })).status, 416);
      assert.equal((await raw(s.port, "/nope.js")).status, 404);
      assert.equal((await raw(s.port, "/Build")).status, 404, "a folder without a trailing slash");
      for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/Build/%2e%2e/%2e%2e/secret.txt"]) {
        const r = await raw(s.port, p);
        assert.equal(r.status, 404, p);
        assert.ok(!r.body.toString().includes("secret"), p);
      }
    } finally {
      await s.close();
    }
  });
});
