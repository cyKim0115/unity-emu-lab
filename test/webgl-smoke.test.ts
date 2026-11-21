// The WebGL smoke test (src/webgl/smoke.ts). Option checks run everywhere; the rest drives a real headless Chrome,
// Edge or Chromium against fake build folders (test/helpers/webgl-fixture.ts). Without a browser those tests are
// skipped, unless EMU_BROWSER_TESTS=1 (CI), where a missing browser fails them. Audio is muted, every run uses a
// throwaway profile in a temp folder, and nothing here touches an emulator or a Unity project.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isEmuError } from "../src/errors.ts";
import { findBrowser } from "../src/webgl/browser.ts";
import { runWebglSmoke, type WebglSmokeOptions } from "../src/webgl/smoke.ts";
import { tempLabHome } from "./helpers/fake.ts";
import { makeWebglFixture, type FixtureKind } from "./helpers/webgl-fixture.ts";

const home = tempLabHome();
const env: NodeJS.ProcessEnv = { ...process.env, EMU_LAB_HOME: home };
const browser = findBrowser({ env });
const required = process.env.EMU_BROWSER_TESTS === "1";
const skip = browser || required ? false : "no Chrome, Edge or Chromium on this machine (set EMU_BROWSER_TESTS=1 to require one)";

function fixture(kind: FixtureKind): string {
  return makeWebglFixture(path.join(tempLabHome(), "build"), kind);
}

async function smoke(kind: FixtureKind, o: Partial<WebglSmokeOptions> = {}): Promise<{ s: Record<string, any>; lines: string[] }> {
  const lines: string[] = [];
  const s = await runWebglSmoke({
    buildDir: fixture(kind),
    headless: true,
    settleSec: 0,
    readyTimeoutSec: 30,
    env,
    report: (l) => lines.push(l),
    ...o,
  });
  return { s, lines };
}

function rejectsWith(code: string, o: Partial<WebglSmokeOptions>): Promise<void> {
  return assert.rejects(
    runWebglSmoke({ buildDir: o.buildDir ?? fixture("pass"), env, report: () => {}, ...o }),
    (err: unknown) => isEmuError(err) && err.code === code,
  );
}

describe("options are checked before anything starts", () => {
  test("NO_BUILD without index.html, BAD_OPTION for bad values, NO_BROWSER for a missing executable", async () => {
    await rejectsWith("NO_BUILD", { buildDir: tempLabHome() });
    await rejectsWith("BAD_OPTION", { readyMode: "expression" });
    await rejectsWith("BAD_OPTION", { readyMode: "sometimes" as never });
    await rejectsWith("BAD_OPTION", { tapX: 1.5 });
    await rejectsWith("BAD_OPTION", { tapRetrySec: 3 });
    await rejectsWith("BAD_OPTION", { afterTapExpression: "true", noTap: true });
    await rejectsWith("BAD_OPTION", { ignoreErrors: "(unclosed" });
    await rejectsWith("BAD_OPTION", { width: 50 });
    await rejectsWith("BAD_OPTION", { tapInput: "pen" as never });
    await rejectsWith("BAD_OPTION", { gpu: "magic" as never });
    await rejectsWith("BAD_OPTION", { browserArgs: ["--no-sandbox", "--renderer-cmd-prefix=calc.exe"] });
    await rejectsWith("NO_BROWSER", { browser: path.join(tempLabHome(), "no-such-browser.exe") });
  });
});

describe("in a real browser", { concurrency: 4, skip }, () => {
  test("ready marker, tap marker, screenshots, summary.json; compressed build files decode; profile removed", async () => {
    const { s, lines } = await smoke("pass");
    assert.equal(s.pass, true, lines.join("\n"));
    assert.equal(s.ready, true);
    assert.equal(s.tap, true);
    assert.equal(s.tap_attempts, 1);
    assert.equal(s.cross_origin_isolated, true);
    assert.equal(s.canvas_blank, false);
    assert.equal(s.console_errors, 0);
    assert.match(String(s.browser_version), /\//);
    assert.match(String(s.webgl), /^(webgl[12] |none|error)/);
    for (const f of ["01-ready.png", "02-after-tap.png", "03-final.png", "summary.json", "console.txt", "server.log"]) {
      assert.ok(existsSync(path.join(s.run_dir, f)), f);
    }
    assert.ok(!existsSync(path.join(s.run_dir, "browser-profile")), "throwaway profile removed");
    const saved = JSON.parse(readFileSync(path.join(s.run_dir, "summary.json"), "utf8"));
    assert.equal(saved.pass, true);
    assert.match(readFileSync(path.join(s.run_dir, "console.txt"), "utf8"), /SMOKE_APP_READY/);
    assert.match(readFileSync(path.join(s.run_dir, "server.log"), "utf8"), / 200 \/Build\/app\.data\.br/);
    assert.match(lines[lines.length - 1], /^WEBGL_SMOKE PASS dir=/);
  });

  test("ready mode loaded, touch input, no isolation", async () => {
    const { s, lines } = await smoke("pass", { readyMode: "loaded", tapInput: "touch", noIsolation: true });
    assert.equal(s.pass, true, lines.join("\n"));
    assert.equal(s.ready_mode, "Loaded");
    assert.equal(s.tap, true);
    assert.equal(s.tap_input, "touch");
    assert.equal(s.cross_origin_isolated, false);
  });

  test("expressions: ready, tap retried until accepted, after-tap; page_info recorded", async () => {
    const { s, lines } = await smoke("pass", {
      readyMode: "expression",
      readyExpression: "window.fixture.stage === 'title'",
      tapExpression: "window.fixture.stage === 'playing'",
      tapRetrySec: 1,
      tapTimeoutSec: 10,
      afterTapExpression: "window.fixture.taps >= 1",
      infoExpression: "window.fixture",
    });
    assert.equal(s.pass, true, lines.join("\n"));
    assert.equal(s.after_tap, true);
    assert.match(String(s.page_info), /"stage":"playing"/);
  });

  test("an alert() fails the run as fatal", async () => {
    const { s } = await smoke("alert", { noTap: true });
    assert.equal(s.pass, false);
    assert.match(String(s.first_fatal), /^DIALOG alert: fatal from the loader/);
  });

  test("a missing /Build/ file stops the wait early and fails", async () => {
    const { s } = await smoke("missing");
    assert.equal(s.pass, false);
    assert.equal(s.ready, false);
    assert.match(String(s.first_fatal), /404.*\/Build\/missing\.wasm/);
    assert.ok(Number(s.ready_sec) < 25, `stopped early (${s.ready_sec} s)`);
  });

  test("an uncaught page error fails; ignore_errors lets a known third-party error through", async () => {
    const failed = await smoke("throw", { noTap: true, settleSec: 1 });
    assert.equal(failed.s.pass, false);
    assert.equal(failed.s.exceptions, 1);
    const ignored = await smoke("throw", { noTap: true, settleSec: 1, ignoreErrors: "analytics down" });
    assert.equal(ignored.s.pass, true, ignored.lines.join("\n"));
    assert.equal(ignored.s.exceptions, 0);
    assert.equal(ignored.s.ignored_errors, 1);
  });

  test("a flat canvas is reported, and fails only with fail_on_blank", async () => {
    const plain = await smoke("blank", { noTap: true });
    assert.equal(plain.s.canvas_blank, true);
    assert.equal(plain.s.pass, true, plain.lines.join("\n"));
    const strict = await smoke("blank", { noTap: true, failOnBlank: true });
    assert.equal(strict.s.pass, false);
  });

  test("a C# exception line is counted; fail_on_console_error makes it fail", async () => {
    const plain = await smoke("csharp", { noTap: true });
    assert.equal(plain.s.pass, true, plain.lines.join("\n"));
    assert.equal(plain.s.console_errors, 1);
    assert.equal(plain.s.managed_exceptions, 1);
    const strict = await smoke("csharp", { noTap: true, failOnConsoleError: true });
    assert.equal(strict.s.pass, false);
    assert.match(String(strict.s.first_fatal), /NullReferenceException/);
  });
});
