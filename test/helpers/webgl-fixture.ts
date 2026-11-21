// A fake "Unity WebGL build" folder for the WebGL smoke tests: index.html with #unity-canvas and
// #unity-loading-bar like Unity's Default template, plus compressed build files (Build/app.data.br,
// Build/app.wasm.gz) the page fetches and checks, so the server's Content-Encoding is exercised in a real browser.
// It logs the bundled sample's lines: SMOKE_APP_READY when loaded, SMOKE_TAP count=<n> per click or touch.
//
// Kinds change one thing: alert (alert() after ready), missing (fetches a /Build/ file that is not there and stops),
// throw (an uncaught "analytics down" error after ready), blank (the canvas stays flat black), csharp (logs a C#
// exception line with console.error), stage (window.fixture.stage goes loading -> title -> playing on taps).
//
// Command line (CI uses it for scripts\smoke-webgl.ps1): node test/helpers/webgl-fixture.ts <dir> [kind]

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

export type FixtureKind = "pass" | "alert" | "missing" | "throw" | "blank" | "csharp" | "stage";

export const FIXTURE_DATA = "EMU_FIXTURE_DATA_0123456789";

/** A minimal valid wasm module (magic + version). */
const WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

export function makeWebglFixture(dir: string, kind: FixtureKind = "pass"): string {
  mkdirSync(path.join(dir, "Build"), { recursive: true });
  writeFileSync(path.join(dir, "Build", "app.data.br"), brotliCompressSync(Buffer.from(FIXTURE_DATA)));
  writeFileSync(path.join(dir, "Build", "app.wasm.gz"), gzipSync(WASM));
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>emu fixture</title>
<style>body{margin:0;background:#222}#unity-canvas{width:640px;height:360px;display:block;background:#000}
#unity-loading-bar{width:200px;height:10px;background:#0a0}</style></head>
<body>
<canvas id="unity-canvas" width="640" height="360"></canvas>
<div id="unity-loading-bar"></div>
<div id="unity-warning"></div>
<script>
const KIND = ${JSON.stringify(kind)};
window.fixture = { stage: 'loading', taps: 0 };
const canvas = document.getElementById('unity-canvas');
const g = canvas.getContext('2d');
function draw() {
  if (KIND === 'blank') { g.fillStyle = '#000'; g.fillRect(0, 0, 640, 360); return; }
  const grad = g.createLinearGradient(0, 0, 640, 360);
  grad.addColorStop(0, '#1e90ff'); grad.addColorStop(1, '#ff8c00');
  g.fillStyle = grad; g.fillRect(0, 0, 640, 360);
  g.fillStyle = '#fff'; g.font = '24px sans-serif'; g.fillText('taps ' + window.fixture.taps, 20, 40);
}
function tap() {
  window.fixture.taps++;
  if (window.fixture.stage === 'title') window.fixture.stage = 'playing';
  console.log('SMOKE_TAP count=' + window.fixture.taps);
  draw();
}
canvas.addEventListener('mousedown', tap);
canvas.addEventListener('touchstart', (e) => { e.preventDefault(); tap(); }, { passive: false });
async function load() {
  const data = await (await fetch('Build/app.data.br')).text();
  if (data !== ${JSON.stringify(FIXTURE_DATA)}) { console.error('Unable to parse Build/app.data.br: got ' + data.slice(0, 40)); return; }
  const res = await fetch('Build/app.wasm.gz');
  const wasm = new Uint8Array(await res.arrayBuffer());
  if (res.headers.get('content-type') !== 'application/wasm' || wasm.length !== 8 || wasm[0] !== 0) {
    console.error('failed to asynchronously prepare wasm: ' + res.headers.get('content-type') + ' ' + wasm.length);
    return;
  }
  if (KIND === 'missing') { await fetch('Build/missing.wasm'); return; }  // a loader stops here: never ready
  document.getElementById('unity-loading-bar').style.display = 'none';
  draw();
  window.fixture.stage = 'title';
  console.log('SMOKE_APP_READY');
  if (KIND === 'alert') setTimeout(() => alert('fatal from the loader'), 100);
  if (KIND === 'throw') setTimeout(() => { throw new Error('analytics down'); }, 100);
  if (KIND === 'csharp') console.error('NullReferenceException: Object reference not set to an instance of an object.');
}
setTimeout(load, 300);
</script>
</body></html>
`;
  writeFileSync(path.join(dir, "index.html"), html);
  return dir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, kind] = process.argv.slice(2);
  if (!dir) {
    process.stderr.write("usage: node test/helpers/webgl-fixture.ts <dir> [kind]\n");
    process.exit(2);
  }
  makeWebglFixture(path.resolve(dir), (kind as FixtureKind) ?? "pass");
  process.stdout.write(`FIXTURE ${path.resolve(dir)} ${kind ?? "pass"}\n`);
}
