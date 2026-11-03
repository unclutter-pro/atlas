import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TalkLedger } from "./ledger.ts";
import { talkAddressSkipReason } from "./continuation-guard.ts";

test("Talk receive eligibility requires a known active room and matches the validated account", () => {
  const home = mkdtempSync(join(tmpdir(), "atlas-talk-address-"));
  const input = { payload: JSON.stringify({ type: "talk_message", address: { instance: "account", room: "room1" } }) };
  let ledger: TalkLedger | undefined;
  try {
    expect(talkAddressSkipReason({ payload: "plain legacy input" }, home)).toBeNull();
    expect(talkAddressSkipReason(input, home)).toContain("unavailable");
    ledger = new TalkLedger(join(home, ".index/talk/talk.db"));
    expect(talkAddressSkipReason(input, home)).toContain("no longer enabled");
    ledger.upsertRooms("account", [{ token: "room1", type: 1, name: "Max", displayName: "Max",
      readOnly: false, lastMessageId: 0, lastReadMessage: 0, isFederated: false }]);
    expect(talkAddressSkipReason(input, home)).toBeNull();
    ledger.setMeta("active-instance", "different-account");
    expect(talkAddressSkipReason(input, home)).toContain("account is no longer active");
    ledger.setMeta("active-instance", "account");
    expect(talkAddressSkipReason(input, home)).toBeNull();
    ledger.revokeRoom("account", "room1");
    expect(talkAddressSkipReason(input, home)).toContain("room is no longer enabled");
    expect(talkAddressSkipReason({ payload: JSON.stringify({ type: "talk_handoff", address: { instance: "account", room: "room1" } }) }, home))
      .toContain("room is no longer enabled");
  } finally { ledger?.close(); rmSync(home, { recursive: true, force: true }); }
});
