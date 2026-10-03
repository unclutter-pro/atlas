import type { HarnessError, HarnessOperationError } from "../harness.ts";

export function harnessError(code: HarnessError["code"], message: string): HarnessOperationError {
  return Object.assign(new Error(message), { detail: { code, message } });
}

export function describeError(error: unknown): HarnessError {
  if (error instanceof Error && "detail" in error) return (error as HarnessOperationError).detail;
  return { code: "execution", message: error instanceof Error ? error.message : String(error) };
}
