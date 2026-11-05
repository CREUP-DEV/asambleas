import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/logger", () => ({ logWarn: vi.fn() }));

const { fetchIntranetRoster, intranetAuthHeaders } = await import("./intranet");

const TOKEN_ENV = "NUXT_INTRANET_API_TOKEN";
const original = process.env[TOKEN_ENV];

function unsetToken(): void {
  Reflect.deleteProperty(process.env, TOKEN_ENV);
}

afterEach(() => {
  if (original === undefined) unsetToken();
  else process.env[TOKEN_ENV] = original;
  vi.unstubAllGlobals();
});

describe("intranetAuthHeaders", () => {
  it("sends the token as a bearer when it is configured", () => {
    process.env[TOKEN_ENV] = "  secret-token  ";
    expect(intranetAuthHeaders()).toEqual({
      Authorization: "Bearer secret-token",
    });
  });

  it("sends nothing when the token is unset or blank", () => {
    unsetToken();
    expect(intranetAuthHeaders()).toEqual({});
    process.env[TOKEN_ENV] = "   ";
    expect(intranetAuthHeaders()).toEqual({});
  });
});

describe("fetchIntranetRoster", () => {
  it("sends the token with the roster request", async () => {
    process.env[TOKEN_ENV] = "secret-token";
    const fetchMock = vi.fn(async () =>
      Response.json({ data: [], generated_at: "2026-11-05T10:00:00Z" }),
    );
    vi.stubGlobal("fetch", fetchMock);

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
