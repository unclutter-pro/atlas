import { describe, expect, test } from "bun:test";
import { hostnameOf, isAllowedHost } from "./host";
import { handler, json } from "./http";

describe("DNS-rebinding host guard", () => {
  test("parses Host headers", () => {
    expect(hostnameOf("Atlas.Local:8080")).toBe("atlas.local");
    expect(hostnameOf("[::1]:3000")).toBe("::1");
    expect(hostnameOf("127.0.0.1")).toBe("127.0.0.1");
  });

  test("allows localhost, IP literals, LAN names and configured hosts", () => {
    for (const h of ["localhost", "app.localhost", "127.0.0.1", "192.168.1.20", "::1", "fd7a:115c::1", "atlas", "nas.local"]) expect(isAllowedHost(h, [])).toBe(true);
    expect(isAllowedHost("atlas.tailnet.ts.net", ["atlas.tailnet.ts.net"])).toBe(true);
    expect(isAllowedHost("box.tailnet.ts.net", ["*.tailnet.ts.net"])).toBe(true);
    expect(isAllowedHost("anything.example", ["*"])).toBe(true);
  });

  test("refuses unknown domain names", () => {
    expect(isAllowedHost("rebind.attacker.example", [])).toBe(false);
    expect(isAllowedHost("atlas.local.attacker.example", [])).toBe(false);
    expect(isAllowedHost("tailnet.ts.net.attacker.example", ["*.tailnet.ts.net"])).toBe(false);
    expect(isAllowedHost("", [])).toBe(false);
  });

  test("handler() answers 421 for a rebinding request, even when it looks same-origin", async () => {
    const h = handler(() => json({ ok: true }));
    const req = new Request("http://rebind.attacker.example/ui/api/x", {
      method: "POST",
      headers: {
        host: "rebind.attacker.example",
        origin: "http://rebind.attacker.example",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect((await h(req as any)).status).toBe(421);
    const get = new Request("http://rebind.attacker.example/ui/api/x", { headers: { host: "rebind.attacker.example" } });
    expect((await h(get as any)).status).toBe(421);
  });
});
