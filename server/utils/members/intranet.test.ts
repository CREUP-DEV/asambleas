import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/logger", () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

const { logError, logWarn } = await import("../core/logger");
const {
  emailFingerprint,
  fetchIntranetRoster,
  getIntranetApiBaseUrl,
  getRoleApiUrl,
  intranetAuthHeaders,
  isIntranetAuthenticated,
  isIntranetUrlAllowed,
  isRoleLookupAuthenticated,
  lookupIntranetRole,
  resetIntranetConfigLogForTests,
} = await import("./intranet");

const BASE = "https://intranet.example/api/asambleas/v1";
const ROLE_URL = `${BASE}/user/role`;
const EMAIL = "cdeub@ub.edu";

function unsetEnv(name: string): void {
  vi.stubEnv(name, undefined);
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  unsetEnv("NUXT_INTRANET_API_URL");
  unsetEnv("NUXT_ROLE_API_URL");
  unsetEnv("NUXT_INTRANET_API_TOKEN");
  unsetEnv("BETTER_AUTH_SECRET");
  vi.stubEnv("APP_SECRET", "test-secret");
  resetIntranetConfigLogForTests();
  vi.mocked(logWarn).mockClear();
  vi.mocked(logError).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function stubFetch(response: () => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    response(),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("intranetAuthHeaders", () => {
  it("sends the token as a bearer when it is configured", () => {
    vi.stubEnv("NUXT_INTRANET_API_TOKEN", "  secret-token  ");
    expect(intranetAuthHeaders()).toEqual({
      Authorization: "Bearer secret-token",
    });
    expect(isIntranetAuthenticated()).toBe(true);
  });

  it("sends nothing when the token is unset or blank", () => {
    expect(intranetAuthHeaders()).toEqual({});
    expect(isIntranetAuthenticated()).toBe(false);
    vi.stubEnv("NUXT_INTRANET_API_TOKEN", "   ");
    expect(intranetAuthHeaders()).toEqual({});
    expect(isIntranetAuthenticated()).toBe(false);
  });
});

describe("isIntranetUrlAllowed", () => {
  const allowed = (url: string, production: boolean) =>
    isIntranetUrlAllowed(new URL(url), production);

  it("always allows https", () => {
    expect(allowed("https://intranet.creup.es/api", true)).toBe(true);
    expect(allowed("https://intranet.creup.es/api", false)).toBe(true);
  });

  it("allows http outside production", () => {
    expect(allowed("http://localhost:8000/api", false)).toBe(true);
    expect(allowed("http://intranet.creup.es/api", false)).toBe(true);
  });

  it("allows http in production only toward a host without dots", () => {
    expect(allowed("http://intranet/api/asambleas/v1", true)).toBe(true);
    expect(allowed("http://intranet:8080/api", true)).toBe(true);
    expect(allowed("http://intranet.creup.es/api", true)).toBe(false);
    expect(allowed("http://10.0.0.5/api", true)).toBe(false);
    // The WHATWG parser turns a bare number into an IPv4 address.
    expect(allowed("http://167772165/api", true)).toBe(false);
    expect(allowed("http://[2001:db8::1]/api", true)).toBe(false);
    expect(allowed("http://[::1]/api", true)).toBe(false);
  });

  it("never allows other schemes", () => {
    expect(allowed("ftp://intranet/api", false)).toBe(false);
    expect(allowed("file:///etc/passwd", false)).toBe(false);
  });
});

describe("getIntranetApiBaseUrl", () => {
  it("trims trailing slashes and accepts http outside production", () => {
    vi.stubEnv("NUXT_INTRANET_API_URL", ` ${BASE}// `);
    expect(getIntranetApiBaseUrl()).toBe(BASE);
    vi.stubEnv("NUXT_INTRANET_API_URL", "http://localhost:8000/api/");
    expect(getIntranetApiBaseUrl()).toBe("http://localhost:8000/api");
  });

  it("is null when unset, blank, invalid or another scheme", () => {
    expect(getIntranetApiBaseUrl()).toBeNull();
    vi.stubEnv("NUXT_INTRANET_API_URL", "  ");
    expect(getIntranetApiBaseUrl()).toBeNull();
    vi.stubEnv("NUXT_INTRANET_API_URL", "not a url");
    expect(getIntranetApiBaseUrl()).toBeNull();
    vi.stubEnv("NUXT_INTRANET_API_URL", "ftp://intranet/api");
    expect(getIntranetApiBaseUrl()).toBeNull();
  });

  it("rejects http to a public host in production and logs it once", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NUXT_INTRANET_API_URL", "http://intranet.creup.es/api");
    expect(getIntranetApiBaseUrl()).toBeNull();
    expect(getIntranetApiBaseUrl()).toBeNull();
    expect(logError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logError).mock.calls[0]?.[2]).toEqual({
      variable: "NUXT_INTRANET_API_URL",
    });
  });

  it("keeps the Docker service name exception in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NUXT_INTRANET_API_URL", "http://intranet/api/asambleas/v1/");
    expect(getIntranetApiBaseUrl()).toBe("http://intranet/api/asambleas/v1");
    expect(logError).not.toHaveBeenCalled();
  });
});

describe("getRoleApiUrl", () => {
  it("prefers NUXT_ROLE_API_URL over the base", () => {
    vi.stubEnv("NUXT_INTRANET_API_URL", BASE);
    vi.stubEnv("NUXT_ROLE_API_URL", "https://other.example/api/user/role");
    expect(getRoleApiUrl()).toBe("https://other.example/api/user/role");
  });

  it("falls back to the base", () => {
    vi.stubEnv("NUXT_INTRANET_API_URL", `${BASE}/`);
    expect(getRoleApiUrl()).toBe(ROLE_URL);
  });

  it("is null without any usable URL", () => {
    expect(getRoleApiUrl()).toBeNull();
  });

  it("treats a rejected NUXT_ROLE_API_URL as unset in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NUXT_ROLE_API_URL", "http://intranet.creup.es/api/user/role");
    expect(getRoleApiUrl()).toBeNull();
    vi.stubEnv("NUXT_INTRANET_API_URL", BASE);
    expect(getRoleApiUrl()).toBe(ROLE_URL);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logError).mock.calls[0]?.[2]).toEqual({
      variable: "NUXT_ROLE_API_URL",
    });
  });
});

describe("isRoleLookupAuthenticated", () => {
  it("needs a token and a role URL", () => {
    vi.stubEnv("NUXT_INTRANET_API_URL", BASE);
    expect(isRoleLookupAuthenticated()).toBe(false);
    vi.stubEnv("NUXT_INTRANET_API_TOKEN", "secret-token");
    expect(isRoleLookupAuthenticated()).toBe(true);
    unsetEnv("NUXT_INTRANET_API_URL");
    expect(isRoleLookupAuthenticated()).toBe(false);
  });

  it("trusts NUXT_ROLE_API_URL on the base origin, or alone", () => {
    vi.stubEnv("NUXT_INTRANET_API_TOKEN", "secret-token");
    vi.stubEnv("NUXT_ROLE_API_URL", "https://intranet.example/api/user/role");
    expect(isRoleLookupAuthenticated()).toBe(true);
    vi.stubEnv("NUXT_INTRANET_API_URL", BASE);
    expect(isRoleLookupAuthenticated()).toBe(true);
    expect(logError).not.toHaveBeenCalled();
  });

  it("never sends the token to a NUXT_ROLE_API_URL on another origin", () => {
    vi.stubEnv("NUXT_INTRANET_API_TOKEN", "secret-token");
    vi.stubEnv("NUXT_INTRANET_API_URL", BASE);
    vi.stubEnv("NUXT_ROLE_API_URL", "https://example.com/api/user/role");
    expect(isRoleLookupAuthenticated()).toBe(false);
    expect(isRoleLookupAuthenticated()).toBe(false);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logError).mock.calls[0]?.[2]).toEqual({
      variable: "NUXT_ROLE_API_URL",
    });
  });
});

describe("emailFingerprint", () => {
  it("is 12 hex characters, the same for the same address", () => {
    const ref = emailFingerprint(EMAIL);
    expect(ref).toMatch(/^[0-9a-f]{12}$/);
    expect(emailFingerprint(`  ${EMAIL.toUpperCase()} `)).toBe(ref);
    expect(emailFingerprint("other@ub.edu")).not.toBe(ref);
  });

  it("depends on the secret and prefers BETTER_AUTH_SECRET", () => {
    const withAppSecret = emailFingerprint(EMAIL);
    vi.stubEnv("BETTER_AUTH_SECRET", "another-secret");
    const withAuthSecret = emailFingerprint(EMAIL);
    expect(withAuthSecret).not.toBe(withAppSecret);
    unsetEnv("APP_SECRET");
    expect(emailFingerprint(EMAIL)).toBe(withAuthSecret);
  });

  it("is null without a secret", () => {
    unsetEnv("APP_SECRET");
    expect(emailFingerprint(EMAIL)).toBeNull();
    vi.stubEnv("APP_SECRET", "   ");
    expect(emailFingerprint(EMAIL)).toBeNull();
  });
});

describe("lookupIntranetRole", () => {
  const account = {
    id: 412,
    role: "Asociado",
    name: "Consell de l'Estudiantat UB",
    initials: "CdEUB",
    university: "Universitat de Barcelona",
  };

  beforeEach(() => {
    vi.stubEnv("NUXT_INTRANET_API_URL", BASE);
    vi.stubEnv("NUXT_INTRANET_API_TOKEN", "secret-token");
  });

  it("is unconfigured without a role URL and calls nothing", async () => {
    unsetEnv("NUXT_INTRANET_API_URL");
    const fetchMock = stubFetch(() => Response.json(account));
    expect(await lookupIntranetRole(EMAIL)).toEqual({
      outcome: "unconfigured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the email with Accept, Content-Type and the token", async () => {
    const fetchMock = stubFetch(() => Response.json(account));
    await lookupIntranetRole(EMAIL);
    expect(fetchMock).toHaveBeenCalledWith(
      ROLE_URL,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: EMAIL }),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: "Bearer secret-token",
        },
      }),
    );
  });

  it("returns the account with its id", async () => {
    stubFetch(() => Response.json({ ...account, extra: "ignored" }));
    expect(await lookupIntranetRole(EMAIL)).toEqual({
      outcome: "ok",
      account,
    });
  });

  it("accepts the legacy answer without id and with empty fields", async () => {
    stubFetch(() =>
      Response.json({
        role: " CEA ",
        name: "",
        initials: null,
        university: "  ",
      }),
    );
    expect(await lookupIntranetRole(EMAIL)).toEqual({
      outcome: "ok",
      account: {
        id: null,
        role: "CEA",
        name: null,
        initials: null,
        university: null,
      },
    });
  });

  it("is notFound only for the authenticated 404 not_found body", async () => {
    stubFetch(() => Response.json({ error: "not_found" }, { status: 404 }));
    expect(await lookupIntranetRole(EMAIL)).toEqual({ outcome: "notFound" });
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("sends no token to a role URL on another origin, so it cannot be notFound", async () => {
    vi.stubEnv("NUXT_ROLE_API_URL", "https://example.com/api/user/role");
    const fetchMock = stubFetch(() =>
      Response.json({ error: "not_found" }, { status: 404 }),
    );
    expect(await lookupIntranetRole(EMAIL)).toEqual({
      outcome: "failed",
      reason: "status",
      status: 404,
    });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
  });

  it("fails on a 404 without a token", async () => {
    unsetEnv("NUXT_INTRANET_API_TOKEN");
    stubFetch(() => Response.json({ error: "not_found" }, { status: 404 }));
    expect(await lookupIntranetRole(EMAIL)).toEqual({
      outcome: "failed",
      reason: "status",
      status: 404,
    });
  });

  it.each([
    [
      "the legacy body",
      () => Response.json({ error: "Usuario no encontrado" }, { status: 404 }),
    ],
    [
      "a missing route",
      () => Response.json({ message: "Not Found." }, { status: 404 }),
    ],
    [
      "an HTML page",
      () =>
        new Response("<!doctype html><h1>404</h1>", {
          status: 404,
          headers: { "Content-Type": "text/html" },
        }),
    ],
    [
      "extra keys",
      () =>
        Response.json({ error: "not_found", message: "x" }, { status: 404 }),
    ],
    ["an empty body", () => new Response(null, { status: 404 })],
  ])("fails on a 404 with %s", async (_label, response) => {
    stubFetch(response);
    expect(await lookupIntranetRole(EMAIL)).toEqual({
      outcome: "failed",
      reason: "status",
      status: 404,
    });
  });

  it("fails on a 404 reached through a redirect", async () => {
    stubFetch(() => {
      const response = Response.json({ error: "not_found" }, { status: 404 });
      Object.defineProperty(response, "redirected", { value: true });
      return response;
    });
    expect((await lookupIntranetRole(EMAIL)).outcome).toBe("failed");
  });

  it.each([401, 403, 422, 429, 500, 503])(
    "fails on status %i",
    async (status) => {
      stubFetch(() => Response.json({ error: "x" }, { status }));
      expect(await lookupIntranetRole(EMAIL)).toEqual({
        outcome: "failed",
        reason: "status",
        status,
      });
    },
  );

  it("fails on invalid JSON or payload", async () => {
    stubFetch(() => new Response("<html></html>", { status: 200 }));
    expect(await lookupIntranetRole(EMAIL)).toEqual({
      outcome: "failed",
      reason: "invalid_json",
      status: 200,
    });
    for (const payload of [
      { ...account, role: "  " },
      { ...account, id: "412" },
      { ...account, id: 0 },
      { ...account, id: 2 ** 31 },
      { ...account, name: 12 },
      [account],
    ]) {
      stubFetch(() => Response.json(payload));
      expect(await lookupIntranetRole(EMAIL)).toEqual({
        outcome: "failed",
        reason: "invalid_payload",
        status: 200,
      });
    }
  });

  it("fails on network errors and timeouts, logging only a fingerprint", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    expect(await lookupIntranetRole(EMAIL)).toEqual({
      outcome: "failed",
      reason: "network",
      status: null,
    });
    stubFetch(() => {
      throw new DOMException("timed out", "TimeoutError");
    });
    expect(await lookupIntranetRole(EMAIL)).toEqual({
      outcome: "failed",
      reason: "timeout",
      status: null,
    });

    const meta = vi.mocked(logWarn).mock.calls.map((call) => call[1]);
    expect(meta).toHaveLength(2);
    for (const entry of meta) {
      expect(entry).toMatchObject({ accountRef: emailFingerprint(EMAIL) });
      expect(JSON.stringify(entry)).not.toContain(EMAIL);
    }
  });
});

describe("fetchIntranetRoster", () => {
  it("sends the token with the roster request", async () => {
    vi.stubEnv("NUXT_INTRANET_API_TOKEN", "secret-token");
    const fetchMock = stubFetch(() =>
      Response.json({ data: [], generated_at: "2026-11-05T10:00:00Z" }),
    );

    await fetchIntranetRoster("https://intranet.example", "asociado");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://intranet.example/usuarios/asociados",
      expect.objectContaining({
        headers: {
          Accept: "application/json",
          Authorization: "Bearer secret-token",
        },
      }),
    );
  });
});
