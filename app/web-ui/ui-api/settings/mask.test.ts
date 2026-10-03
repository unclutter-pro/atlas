import { describe, expect, test } from "bun:test";
import { SECRET_PLACEHOLDER, maskSecrets, unmaskSecrets } from "./mask";

const CONFIG = `# Atlas config
telegram:
  bot_token: "123:abc"   # from BotFather
usage_reporting:
  enabled: true
  webhook_url: https://example.com/hook
  webhook_secret: s3cr3t
email:
  password_file: ~/secrets/email
  imap_host: imap.example.com
`;

describe("config.yml secret masking", () => {
  test("masks inline secrets and keeps everything else", () => {
    const masked = maskSecrets(CONFIG);
    expect(masked).not.toContain("123:abc");
    expect(masked).not.toContain("s3cr3t");
    expect(masked).toContain(`bot_token: ${SECRET_PLACEHOLDER}`);
    expect(masked).toContain("password_file: ~/secrets/email");
    expect(masked).toContain("webhook_url: https://example.com/hook");
    expect(masked).toContain("# Atlas config");
  });

  test("round trip restores the original file", () => {
    expect(unmaskSecrets(maskSecrets(CONFIG), CONFIG)).toBe(CONFIG);
  });

  test("keeps edits to other keys and new secret values", () => {
    const edited = maskSecrets(CONFIG).replace("enabled: true", "enabled: false").replace(`webhook_secret: ${SECRET_PLACEHOLDER}`, "webhook_secret: fresh");
    const out = unmaskSecrets(edited, CONFIG);
    expect(out).toContain("enabled: false");
    expect(out).toContain("webhook_secret: fresh");
    expect(out).toContain('bot_token: "123:abc"');
  });

  test("placeholder without a stored secret is rejected", () => {
    expect(() => unmaskSecrets(`signal:\n  api_token: ${SECRET_PLACEHOLDER}\n`, CONFIG)).toThrow();
  });
});
