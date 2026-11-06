import { afterEach, describe, expect, it, vi } from "vitest";
import { logWarn } from "../core/logger";
import { emailFingerprint } from "./intranet";

/**
 * With the real logger: the account reference survives its redaction of
 * emails and secrets, so role sync logs can be correlated.
 */
describe("accountRef in logs", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("is written as is, while the email is redacted", () => {
    vi.stubEnv("APP_SECRET", "test-secret");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const accountRef = emailFingerprint("cdeub@ub.edu");
    expect(accountRef).not.toBeNull();

    logWarn("intranet.role", { accountRef, email: "cdeub@ub.edu" });

    const line = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<
      string,
      unknown
    >;
    expect(line.accountRef).toBe(accountRef);
    expect(line.email).toBe("[REDACTED]");
  });
});
