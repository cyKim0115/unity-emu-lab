// Minimal Chrome DevTools Protocol client over Node's built-in WebSocket (no dependencies).
// Behavioural reference: scripts/cdp.ps1. JavaScript dialogs (alert/confirm) block the page and every later command,
// so they are accepted at once; the caller still sees the Page.javascriptDialogOpening event.

import { sleep } from "../proc.ts";

export interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
  error?: { message?: string };
}

export class CdpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CdpError";
  }
}

const LOST = "DevTools connection lost (browser exited or crashed)";

export class CdpClient {
  private readonly ws: WebSocket;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly listeners: ((m: CdpMessage) => void)[] = [];
  private closedReason: string | null = null;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => this.onMessage(ev.data));
    ws.addEventListener("close", () => this.fail(LOST));
    ws.addEventListener("error", () => this.fail(LOST));
  }

  /** Open a socket to a DevTools WebSocket URL. */
  static connect(wsUrl: string, timeoutMs = 20_000): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          // ignore
        }
        reject(new CdpError(`DevTools connect to ${wsUrl} timed out`));
      }, timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new CdpClient(ws));
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new CdpError(`DevTools connect to ${wsUrl} failed`));
      });
    });
  }

  /** null while open, else why it closed. */
  get closed(): string | null {
    return this.closedReason;
  }

  onEvent(fn: (m: CdpMessage) => void): void {
    this.listeners.push(fn);
  }

  /** Send a command without waiting for its reply. */
  sendNoWait(method: string, params?: Record<string, unknown>): void {
    if (this.closedReason) return;
    this.nextId += 1;
    this.ws.send(JSON.stringify(params ? { id: this.nextId, method, params } : { id: this.nextId, method }));
  }

  /** Send a command and wait for its result (throws on a protocol error, a timeout or a lost connection). */
  send(method: string, params?: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, any>> {
    if (this.closedReason) return Promise.reject(new CdpError(this.closedReason));
    this.nextId += 1;
    const id = this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`CDP ${method} timed out after ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify(params ? { id, method, params } : { id, method }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CdpError(LOST));
      }
    });
  }

  close(): void {
    this.fail("DevTools connection closed");
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }

  private onMessage(data: unknown): void {
    let m: CdpMessage;
    try {
      m = JSON.parse(typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8")) as CdpMessage;
    } catch {
      return;
    }
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new CdpError(`CDP failed: ${m.error.message ?? "error"}`));
      else p.resolve(m.result ?? {});
      return;
    }
    if (m.method === "Page.javascriptDialogOpening") this.sendNoWait("Page.handleJavaScriptDialog", { accept: true });
    for (const fn of this.listeners) {
      try {
        fn(m);
      } catch {
        // a listener's bug must not break the connection
      }
    }
  }

  private fail(reason: string): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new CdpError(reason));
      this.pending.delete(id);
    }
  }
}

/** The WebSocket URL of the first page target of a browser started with --remote-debugging-port. */
export async function findPageTarget(httpBase: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${httpBase}/json/list`, { signal: AbortSignal.timeout(2_000) });
      const targets = (await res.json()) as { type?: string; webSocketDebuggerUrl?: string }[];
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // not up yet
    }
    await sleep(300);
  }
  throw new CdpError(`No DevTools page target at ${httpBase}.`);
}

/** Runtime.evaluate by value (awaits promises); throws when the expression throws. */
export async function evaluate(cdp: CdpClient, expression: string, timeoutMs = 30_000): Promise<unknown> {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
  if (r.exceptionDetails) throw new CdpError(`evaluate failed: ${r.exceptionDetails.text ?? "exception"}`);
  return r.result?.value;
}

/** A click (mouse) or a tap (touch) at CSS pixel x, y. */
export async function clickAt(cdp: CdpClient, x: number, y: number, input: "mouse" | "touch" = "mouse"): Promise<void> {
  if (input === "touch") {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await sleep(80);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    return;
  }
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await sleep(80);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}
