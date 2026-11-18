import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/logger", () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
}));
// Only answers that never reach the database are read here.
vi.mock("../../db", () => ({ db: {} }));

const { logWarn } = await import("../core/logger");
const { resetIntranetConfigLogForTests } = await import("../members/intranet");
const {
  EXPECTED_TTL_MS,
  clearExpectedCache,
  fetchRegisteredAccounts,
  loadExpectedAttendance,
  registeredPath,
} = await import("./headcountExpected");

// Every answer here is invented: the real Intranet is never called.

const BASE = "https://intranet.example/api/asambleas/v1";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(answer: () => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    answer(),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("NUXT_INTRANET_API_URL", BASE);
  vi.stubEnv("NUXT_INTRANET_API_TOKEN", "test-token");
  resetIntranetConfigLogForTests();
  vi.mocked(logWarn).mockClear();
  clearExpectedCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("fetchRegisteredAccounts", () => {
  it("asks for the assembly by type and number, with the token", async () => {
    const fetchMock = stubFetch(() =>
      json({
        event: { id: 9, name: "Asamblea", start_date: null, end_date: null },
        account_ids: [41, 7, 41],
        generated_at: "2026-11-18T10:00:00+01:00",
      }),
    );

    await expect(fetchRegisteredAccounts("AGO", 80)).resolves.toEqual({
      status: "ok",
      accountIds: [41, 7],
    });
    expect(registeredPath("AGO", 80)).toBe("asambleas/AGO/80/inscritos");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/asambleas/AGO/80/inscritos`);
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer test-token",
    );
  });

  it("tells an assembly without event from an Intranet without the route", async () => {
    stubFetch(() => json({ error: "not_found" }, 404));
    await expect(fetchRegisteredAccounts("AGO", 80)).resolves.toEqual({
      status: "not_found",
    });

    stubFetch(() => new Response("<html>Not Found</html>", { status: 404 }));
    await expect(fetchRegisteredAccounts("AGO", 80)).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("fails on any other status, a bad payload or the network", async () => {
    stubFetch(() => json({ error: "unauthorized" }, 401));
    await expect(fetchRegisteredAccounts("AGO", 80)).resolves.toEqual({
      status: "failed",
    });

    stubFetch(() => json({ account_ids: ["41"] }));
    await expect(fetchRegisteredAccounts("AGO", 80)).resolves.toEqual({
      status: "failed",
    });

    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    await expect(fetchRegisteredAccounts("AGO", 80)).resolves.toEqual({
      status: "failed",
    });
    expect(JSON.stringify(vi.mocked(logWarn).mock.calls)).not.toContain(
      "test-token",
    );
  });

  it("is unconfigured without an Intranet URL", async () => {
    vi.stubEnv("NUXT_INTRANET_API_URL", "");
    const fetchMock = stubFetch(() => json({ account_ids: [] }));
    await expect(fetchRegisteredAccounts("AGO", 80)).resolves.toEqual({
      status: "unconfigured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("loadExpectedAttendance", () => {
  const assembly = { id: "a1", type: "AGO" as const, number: 80 };

  it("asks the Intranet at most once a minute per assembly", async () => {
    const fetchMock = stubFetch(() => json({ error: "not_found" }, 404));
    const start = Date.parse("2026-11-18T10:00:00Z");

    const first = await loadExpectedAttendance(assembly, start);
    await loadExpectedAttendance(assembly, start + EXPECTED_TTL_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toEqual({
      status: "not_found",
      memberIds: [],
      guestIds: [],
      checkedAt: new Date(start).toISOString(),
    });

    await loadExpectedAttendance(assembly, start + EXPECTED_TTL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await loadExpectedAttendance({ ...assembly, number: 81 }, start);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("maps nothing when nobody registered", async () => {
    stubFetch(() => json({ account_ids: [] }));
    await expect(loadExpectedAttendance(assembly, 0)).resolves.toMatchObject({
      status: "ok",
      memberIds: [],
      guestIds: [],
    });
  });
});
