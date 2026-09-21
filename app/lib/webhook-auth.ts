import { createHash, createHmac, timingSafeEqual } from "node:crypto";

function equalSecret(actual: string, expected: string): boolean {
  // Hash to fixed size before the constant-time comparison.
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(actual), digest(expected));
}

/** GitHub signs the original bytes. A relay's parsed body cannot substitute for them. */
export function authenticateWebhook(
  secret: string | null | undefined,
  input: { header?: string; query?: string; githubSignature?: string; rawBody?: Uint8Array },
): boolean {
  if (!secret) return true;
  if (input.githubSignature !== undefined) {
    if (!input.rawBody || !/^sha256=[a-f0-9]{64}$/.test(input.githubSignature)) return false;
    const expected = `sha256=${createHmac("sha256", secret).update(input.rawBody).digest("hex")}`;
    return equalSecret(input.githubSignature, expected);
  }
  const provided = input.header ?? input.query;
  return provided !== undefined && equalSecret(provided, secret);
}
