import { describe, expect, it } from "vitest";
import {
  SESSION_RECHECK_INTERVAL_MS,
  isLoginPath,
  localeOfPath,
  safeRedirectPath,
  sessionFailureAction,
  shouldCheckSession,
} from "./-session";

const NOW = 1_800_000_000_000;

function check(overrides: Partial<Parameters<typeof shouldCheckSession>[0]>) {
  return shouldCheckSession({
    client: true,
    verified: true,
    lastCheckedAt: NOW - 1_000,
    now: NOW,
    toPath: "/asambleas/80-ago",
    fromPath: "/asambleas",
    ...overrides,
  });
}

describe("isLoginPath", () => {
  it("matches the login page in every language", () => {
    expect(isLoginPath("/login")).toBe(true);
    expect(isLoginPath("/en/login")).toBe(true);
    expect(isLoginPath("/login/")).toBe(true);
    expect(isLoginPath("/asambleas/login")).toBe(false);
    expect(isLoginPath("/loginx")).toBe(false);
  });
});

describe("shouldCheckSession", () => {
  it("always checks on the server and before a first verdict", () => {
    expect(check({ client: false })).toBe(true);
    expect(check({ verified: false })).toBe(true);
    expect(check({ verified: false, fromPath: "/asambleas/80-ago" })).toBe(
      true,
    );
  });

  it("skips a verified session within the interval", () => {
    expect(check({})).toBe(false);
  });

  it("checks again once the interval is over", () => {
    expect(check({ lastCheckedAt: NOW - SESSION_RECHECK_INTERVAL_MS })).toBe(
      true,
    );
  });

  it("skips when only the query or the hash changes", () => {
    expect(
      check({
        lastCheckedAt: NOW - 10 * SESSION_RECHECK_INTERVAL_MS,
        fromPath: "/asambleas/80-ago",
      }),
    ).toBe(false);
  });
});

describe("sessionFailureAction", () => {
  it("sends to the login page only when the session is gone", () => {
    expect(sessionFailureAction({ statusCode: 401 })).toBe("redirect");
    expect(sessionFailureAction({ response: { status: 403 } })).toBe(
      "redirect",
    );
  });

  it("keeps the navigation on network errors, 429 and 5xx", () => {
    expect(sessionFailureAction(new TypeError("Failed to fetch"))).toBe("keep");
    expect(sessionFailureAction(null)).toBe("keep");
    expect(sessionFailureAction({ statusCode: 429 })).toBe("keep");
    expect(sessionFailureAction({ status: 500 })).toBe("keep");
    expect(sessionFailureAction({ response: { status: 502 } })).toBe("keep");
    expect(sessionFailureAction({ statusCode: 503 })).toBe("keep");
  });
});

describe("localeOfPath", () => {
  const codes = ["es", "en"];

  it("reads the locale prefix", () => {
    expect(localeOfPath("/en/asambleas", codes, "es")).toBe("en");
    expect(localeOfPath("/en", codes, "es")).toBe("en");
    expect(localeOfPath("/en?x=1", codes, "es")).toBe("en");
  });

  it("falls back to the default locale without a prefix", () => {
    expect(localeOfPath("/asambleas", codes, "es")).toBe("es");
    expect(localeOfPath("/", codes, "es")).toBe("es");
    expect(localeOfPath("/enmiendas", codes, "es")).toBe("es");
  });
});

describe("safeRedirectPath", () => {
  it("keeps paths of this site", () => {
    expect(safeRedirectPath("/asambleas/80-ago?enmienda=x")).toBe(
      "/asambleas/80-ago?enmienda=x",
    );
    expect(safeRedirectPath("/en/asambleas")).toBe("/en/asambleas");
    expect(safeRedirectPath(["/asambleas", "/otra"])).toBe("/asambleas");
  });

  it("refuses other hosts and anything that is not a path", () => {
    expect(safeRedirectPath("//evil.example")).toBeNull();
    expect(safeRedirectPath("/\\evil.example")).toBeNull();
    expect(safeRedirectPath("/\t/evil.example")).toBeNull();
    expect(safeRedirectPath("https://evil.example")).toBeNull();
    expect(safeRedirectPath("asambleas")).toBeNull();
    expect(safeRedirectPath(undefined)).toBeNull();
    expect(safeRedirectPath(null)).toBeNull();
  });

  it("refuses the login page itself", () => {
    expect(safeRedirectPath("/login")).toBeNull();
    expect(safeRedirectPath("/en/login?error=x")).toBeNull();
  });
});
