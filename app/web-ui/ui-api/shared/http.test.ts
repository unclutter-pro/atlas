import { describe, expect, test } from "bun:test";
import { handler, json, readJson } from "./http";

const echo = handler(async (req) => json(await readJson(req)));
const post = (headers: Record<string, string>) =>
  echo(new Request("http://atlas.localhost:3000/ui/api/x", { method: "POST", headers: { host: "atlas.localhost:3000", ...headers }, body: "{}" }) as any);

describe("UI API mutation guard", () => {
  test("accepts same-origin JSON", async () => {
    expect((await post({ "content-type": "application/json", origin: "http://atlas.localhost:3000", "sec-fetch-site": "same-origin" })).status).toBe(200);
  });

  test("accepts the public port behind nginx (Host without port)", async () => {
    const res = await echo(
      new Request("http://atlas.localhost/ui/api/x", {
        method: "POST",
        headers: { host: "atlas.localhost", origin: "http://atlas.localhost:8080", "content-type": "application/json; charset=utf-8" },
        body: "{}",
      }) as any,
    );
    expect(res.status).toBe(200);
  });

  test("rejects a CORS-safelisted content type that merely mentions JSON", async () => {
    expect((await post({ "content-type": "text/plain; application/json" })).status).toBe(415);
  });

  test("rejects cross-site requests", async () => {
    expect((await post({ "content-type": "application/json", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post({ "content-type": "application/json", origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ "content-type": "application/json", origin: "null" })).status).toBe(403);
  });

  test("GET is not guarded", async () => {
    const get = handler(() => json({ ok: true }));
    expect((await get(new Request("http://atlas.localhost/ui/api/x", { headers: { "sec-fetch-site": "cross-site" } }) as any)).status).toBe(200);
  });
});

describe("multipart opt-in (voice uploads)", () => {
  const upload = handler(() => json({ ok: true }), { multipart: true });
  const send = (headers: Record<string, string>, body: BodyInit = "--x--") =>
    upload(new Request("http://atlas.localhost/ui/api/x", { method: "POST", headers: { host: "atlas.localhost", ...headers }, body }) as any);
  const mp = "multipart/form-data; boundary=x";

  test("needs the X-Atlas-UI header", async () => {
    const res = await send({ "content-type": mp });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Missing X-Atlas-UI header" });
    expect((await send({ "content-type": mp, "x-atlas-ui": "1", "sec-fetch-site": "same-origin" })).status).toBe(200);
  });

  test("is still refused cross-site, header or not", async () => {
    expect((await send({ "content-type": mp, "x-atlas-ui": "1", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await send({ "content-type": mp, "x-atlas-ui": "1", origin: "https://evil.example" })).status).toBe(403);
  });

  test("other content types fall back to the JSON rule", async () => {
    expect((await send({ "content-type": "text/plain", "x-atlas-ui": "1" })).status).toBe(415);
    expect((await send({ "content-type": "application/json" }, "{}")).status).toBe(200);
  });

  test("without the opt-in, multipart is refused like any non-JSON body", async () => {
    const plain = handler(() => json({ ok: true }));
    const res = await plain(new Request("http://atlas.localhost/ui/api/x", { method: "POST", headers: { "content-type": mp, "x-atlas-ui": "1" }, body: "--x--" }) as any);
    expect(res.status).toBe(415);
  });
});
