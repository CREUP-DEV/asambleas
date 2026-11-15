import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/logger", () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

const { logWarn } = await import("../core/logger");
const { IntranetUnavailableError, resetIntranetConfigLogForTests } =
  await import("../members/intranet");
const { attendeesPath, fetchAssemblyAttendees, fetchSeatingImage, imagePath } =
  await import("./intranet");

// Every answer here is invented: the real Intranet is never called.

const BASE = "https://intranet.example/api/asambleas/v1";

const LIST = {
  event: {
    id: 900,
    name: "999.ª Asamblea General Ordinaria",
    start_date: "2026-11-18",
    end_date: "2026-11-22",
  },
  accounts: [
    {
      id: 41,
      type: "Asociado",
      category: "Multiusuario",
      initials: "CEX",
      designation: "Consejo de Estudiantes X",
      university_acronym: "UX",
      order: null,
      logo_version: "3f2a",
    },
  ],
  attendees: [
    {
      id: 501,
      account_id: 41,
      name: "Lucía",
      surname: "Inventada Pérez",
      status: "Confirmada",
      modality: "Regular",
      photo_version: null,
    },
  ],
  generated_at: "2026-11-15T10:15:00+01:00",
};

function json(body: unknown, status = 200, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function stubFetch(answer: () => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    answer(),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Everything the logger was given, as text. */
const logged = () => JSON.stringify(vi.mocked(logWarn).mock.calls);

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("NUXT_INTRANET_API_URL", BASE);
  vi.stubEnv("NUXT_INTRANET_API_TOKEN", "test-token");
  resetIntranetConfigLogForTests();
  vi.mocked(logWarn).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("attendeesPath and imagePath", () => {
  it("read the assembly by type and number", () => {
    expect(attendeesPath("AGO", 80)).toBe("asambleas/AGO/80/asistentes");
    expect(attendeesPath("AGE", 34)).toBe("asambleas/AGE/34/asistentes");
    expect(imagePath("logo", 41)).toBe("cuentas/41/logo");
    expect(imagePath("photo", 501)).toBe("asistentes/501/foto");
  });
});

describe("fetchAssemblyAttendees", () => {
  it("is unconfigured without an Intranet URL, and calls nothing", async () => {
    vi.stubEnv("NUXT_INTRANET_API_URL", "");
    const fetchMock = stubFetch(() => json(LIST));
    expect(await fetchAssemblyAttendees("AGO", 80)).toEqual({
      outcome: "unconfigured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the list with the token and drops what it must not keep", async () => {
    const fetchMock = stubFetch(() => json(LIST));
    const result = await fetchAssemblyAttendees("AGO", 80);
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/asambleas/AGO/80/asistentes`,
      expect.objectContaining({
        headers: {
          Accept: "application/json",
          Authorization: "Bearer test-token",
        },
      }),
    );
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.data.accounts[0]).toMatchObject({ id: 41, initials: "CEX" });
    expect(result.data.attendees[0]).toEqual({
      id: 501,
      account_id: 41,
      name: "Lucía",
      surname: "Inventada Pérez",
      status: "Confirmada",
      photo_version: null,
    });
  });

  it("says there is no event only for the exact not_found body", async () => {
    stubFetch(() => json({ error: "not_found" }, 404));
    expect(await fetchAssemblyAttendees("AGO", 80)).toEqual({
      outcome: "notFound",
    });
  });

  it("reads any other 404 as an Intranet without the route", async () => {
    stubFetch(() => json({ message: "Not Found." }, 404));
    expect(await fetchAssemblyAttendees("AGO", 80)).toEqual({
      outcome: "unavailable",
      status: 404,
    });
    stubFetch(
      () =>
        new Response("<html>Not Found</html>", {
          status: 404,
          headers: { "Content-Type": "text/html" },
        }),
    );
    expect(await fetchAssemblyAttendees("AGO", 80)).toEqual({
      outcome: "unavailable",
      status: 404,
    });
  });

  it("never takes a redirected not_found as the Intranet's", async () => {
    stubFetch(() => {
      const response = json({ error: "not_found" }, 404);
      Object.defineProperty(response, "redirected", { value: true });
      return response;
    });
    expect((await fetchAssemblyAttendees("AGO", 80)).outcome).toBe(
      "unavailable",
    );
  });

  it.each([
    [401, "status"],
    [429, "status"],
    [500, "status"],
    [503, "status"],
  ])("fails on a %i", async (status, reason) => {
    stubFetch(() => json({ error: "x" }, status));
    expect(await fetchAssemblyAttendees("AGO", 80)).toEqual({
      outcome: "failed",
      reason,
      status,
    });
  });

  it("fails on a timeout or a network error", async () => {
    stubFetch(() => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    expect(await fetchAssemblyAttendees("AGO", 80)).toEqual({
      outcome: "failed",
      reason: "timeout",
      status: null,
    });
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    expect(await fetchAssemblyAttendees("AGO", 80)).toEqual({
      outcome: "failed",
      reason: "network",
      status: null,
    });
  });

  it("fails on invalid JSON and on a payload that does not parse", async () => {
    stubFetch(() => new Response("{nope", { status: 200 }));
    expect(await fetchAssemblyAttendees("AGO", 80)).toMatchObject({
      outcome: "failed",
      reason: "invalid_json",
    });
    stubFetch(() =>
      json({
        ...LIST,
        attendees: [{ ...LIST.attendees[0], status: "Rechazada" }],
      }),
    );
    expect(await fetchAssemblyAttendees("AGO", 80)).toMatchObject({
      outcome: "failed",
      reason: "invalid_payload",
    });
  });

  it("refuses an answer larger than its cap", async () => {
    stubFetch(
      () =>
        new Response("{}", {
          status: 200,
          headers: { "Content-Length": String(64 * 1024 * 1024) },
        }),
    );
    expect(await fetchAssemblyAttendees("AGO", 80)).toMatchObject({
      outcome: "failed",
      reason: "too_large",
    });
  });

  it("never logs a name, even when the payload does not parse", async () => {
    stubFetch(() =>
      json({
        ...LIST,
        attendees: [{ ...LIST.attendees[0], account_id: 99 }],
      }),
    );
    await fetchAssemblyAttendees("AGO", 80);
    stubFetch(() => json({ error: "not_found" }, 404));
    await fetchAssemblyAttendees("AGO", 80);
    expect(vi.mocked(logWarn)).toHaveBeenCalled();
    expect(logged()).not.toContain("Lucía");
    expect(logged()).not.toContain("Inventada");
    expect(logged()).not.toContain("test-token");
  });
});

describe("fetchSeatingImage", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it("fetches the bytes with the token", async () => {
    const fetchMock = stubFetch(
      () => new Response(png, { status: 200, headers: { "X-Test": "1" } }),
    );
    const result = await fetchSeatingImage("photo", 501);
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/asistentes/501/foto`,
      expect.objectContaining({
        headers: { Accept: "image/*", Authorization: "Bearer test-token" },
      }),
    );
    expect(result).toEqual({ outcome: "ok", data: png });
  });

  it("reads a 404 as an image that is not there, with no retry", async () => {
    stubFetch(() => json({ error: "not_found" }, 404));
    expect(await fetchSeatingImage("logo", 41)).toEqual({
      outcome: "missing",
      reason: "not_found",
    });
  });

  it("gives up an image over 5 MB, declared or streamed", async () => {
    stubFetch(
      () =>
        new Response(png, {
          status: 200,
          headers: { "Content-Length": String(6 * 1024 * 1024) },
        }),
    );
    expect(await fetchSeatingImage("logo", 41)).toEqual({
      outcome: "missing",
      reason: "too_large",
    });
    stubFetch(() => new Response(Buffer.alloc(5 * 1024 * 1024 + 1)));
    expect(await fetchSeatingImage("logo", 41)).toEqual({
      outcome: "missing",
      reason: "too_large",
    });
  });

  it("throws what a retry may mend", async () => {
    stubFetch(() => json({}, 500));
    await expect(fetchSeatingImage("photo", 501)).rejects.toBeInstanceOf(
      IntranetUnavailableError,
    );
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(fetchSeatingImage("photo", 501)).rejects.toBeInstanceOf(
      IntranetUnavailableError,
    );
    vi.stubEnv("NUXT_INTRANET_API_URL", "");
    await expect(fetchSeatingImage("photo", 501)).rejects.toBeInstanceOf(
      IntranetUnavailableError,
    );
  });
});
