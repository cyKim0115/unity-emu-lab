// Pure parsers for adb / dumpsys / uiautomator / logcat text. No I/O here: everything is unit-tested with
// fixtures under test/fixtures/. Reference: scripts/common.ps1, scripts/smoke-test.ps1,
// scripts/check-notification.ps1. Every parser tolerates "\r\n" line ends.

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `adb devices` → serial/state pairs (header, daemon notices and blank lines skipped). */
export function parseDevices(text: string): { serial: string; state: string }[] {
  const list: { serial: string; state: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("*") || /^List of devices/i.test(line)) continue;
    const m = /^(\S+)\s+(\S+)/.exec(line);
    if (!m) continue;
    list.push({ serial: m[1], state: m[2] });
  }
  return list;
}

/** `dumpsys window displays` → current size (`cur=1080x2400`). */
export function parseDisplaySize(text: string): { w: number; h: number } | null {
  const m = /\bcur=(\d+)x(\d+)/.exec(text);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

/** `am start -W` output → launch status and TotalTime. */
export function parseLaunch(amStartOutput: string): { ok: boolean; totalTimeMs: number | null } {
  const t = /TotalTime: (\d+)/.exec(amStartOutput);
  return { ok: /Status: ok/.test(amStartOutput), totalTimeMs: t ? Number(t[1]) : null };
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decode the XML entities uiautomator writes (named five plus numeric). Unknown entities stay as they are. */
export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (whole, ent: string) => {
    if (ent.startsWith("#x") || ent.startsWith("#X")) {
      const cp = parseInt(ent.slice(2), 16);
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    if (ent.startsWith("#")) {
      const cp = parseInt(ent.slice(1), 10);
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return NAMED_ENTITIES[ent] ?? whole;
  });
}

export interface UiNode {
  text: string;
  pkg: string;
  bounds: [number, number, number, number];
}

function parseAttrs(attrText: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([\w:.-]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrText)) !== null) attrs.set(m[1], m[2]);
  return attrs;
}

/** Every `<node ...>` of a uiautomator dump that has text, package and parseable bounds (values entity-decoded). */
export function parseUiNodes(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  const re = /<node\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = parseAttrs(m[1]);
    const text = attrs.get("text");
    const pkg = attrs.get("package");
    const b = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(attrs.get("bounds") ?? "");
    if (text === undefined || pkg === undefined || !b) continue;
    nodes.push({
      text: decodeXmlEntities(text),
      pkg: decodeXmlEntities(pkg),
      bounds: [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])],
    });
  }
  return nodes;
}

/** First node whose (decoded) text contains `part`. */
export function findUiNodeByText(xml: string, part: string): UiNode | null {
  if (!part) return null;
  return parseUiNodes(xml).find((n) => n.text.includes(part)) ?? null;
}

/** Centre of `[x1,y1][x2,y2]` bounds. Like the PowerShell scripts, halves are kept (input tap accepts them). */
export function centre(b: [number, number, number, number]): { x: number; y: number } {
  return { x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2 };
}

/**
 * The first system button to tap: labels are tried in order; a node matches when its text equals the label
 * and it does not belong to the app under test (the app's own "OK" is the app's business).
 */
export function findDialogButton(
  xml: string,
  labels: string[],
  appPackage: string,
): { label: string; pkg: string; x: number; y: number } | null {
  const nodes = parseUiNodes(xml);
  for (const label of labels) {
    const n = nodes.find((node) => node.text === label && node.pkg !== appPackage);
    if (n) return { label, pkg: n.pkg, ...centre(n.bounds) };
  }
  return null;
}

/**
 * The NotificationRecord of `pkg` whose text contains `title`, posted at or after `sinceMs`
 * (mirrors check-notification.ps1). Records are split at "NotificationRecord("; the package must be on the
 * record's header line. Time = mUpdateTimeMs, else mCreationTimeMs; a record without either is accepted.
 */
export function findNotificationRecord(
  dump: string,
  pkg: string,
  title: string,
  sinceMs: number,
): { record: string; timeMs: number | null } | null {
  const marker = "NotificationRecord(";
  const parts = dump.split(marker);
  const pkgRe = new RegExp(`pkg=${escapeRegex(pkg)}(?![\\w.])`);
  for (let i = 1; i < parts.length; i++) {
    const record = marker + parts[i];
    const header = record.split(/\r?\n/, 1)[0];
    if (!pkgRe.test(header)) continue;
    if (!record.includes(title)) continue;
    const t = /mUpdateTimeMs=(\d+)/.exec(record) ?? /mCreationTimeMs=(\d+)/.exec(record);
    const timeMs = t ? Number(t[1]) : null;
    if (timeMs !== null && timeMs < sinceMs) continue;
    return { record, timeMs };
  }
  return null;
}

/**
 * Crash / ANR lines of this package only (other processes may log fatal lines too):
 * Java crash (FATAL EXCEPTION, then "Process: <pkg>" on the next line), native signal "(<pkg>)",
 * tombstone ">>> <pkg> <<<", and "ANR in <pkg>". Not global (safe for repeated .test()).
 */
export function crashRegex(pkg: string): RegExp {
  const p = escapeRegex(pkg);
  return new RegExp(
    `FATAL EXCEPTION[^\\n]*\\r?\\n[^\\n]*Process: ${p}(?![\\w.])` +
      `|Fatal signal \\d+[^\\n]*\\(${p}\\)` +
      `|>>> ${p} <<<` +
      `|ANR in ${p}(?![\\w.])`,
  );
}

const UNITY_LINE = /\/(Unity|AndroidRuntime|DEBUG|libc)\s*\(/;

/** Logcat lines from Unity, the Java runtime and native crash reporting (unity.txt). */
export function unityLines(log: string): string[] {
  return log.split(/\r?\n/).filter((l) => UNITY_LINE.test(l));
}
