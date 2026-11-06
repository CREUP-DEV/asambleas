import type { H3Event } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The endpoint with the actor and the sync stubbed: how it reads the body
// and how a refused sync reaches the client.

const actor = { user: { id: "secretaria" }, impersonation: null };
const readBody = vi.fn(async (): Promise<unknown> => undefined);
const syncIntranetRoster = vi.fn();

vi.mock("h3", async (importOriginal) => ({
  ...(await importOriginal<typeof import("h3")>()),
  readBody,
}));
vi.mock("../../utils/domain/actor", () => ({
  requireActor: vi.fn(async () => actor),
  requireCan: vi.fn(),
}));
vi.mock("../../utils/members/sync", () => ({ syncIntranetRoster }));
vi.mock("../../utils/core/logger", () => ({ logError: vi.fn() }));

const { default: handler } = await import("./sync.post");
const event = {} as H3Event;

async function failure(): Promise<{
  statusCode?: number;
  data?: unknown;
}> {
  try {
    await handler(event);
  } catch (error) {
    return error as { statusCode?: number; data?: unknown };
  }
  throw new Error("the handler did not fail");
}

beforeEach(() => {
  readBody.mockReset();
  readBody.mockResolvedValue(undefined);
  syncIntranetRoster.mockReset();
});

describe("POST /api/members/sync", () => {
  it("runs a manual sync without confirmation when there is no body", async () => {
    const result = { created: 1, updated: 2, deactivated: 0 };
    syncIntranetRoster.mockResolvedValue({ status: "applied", result });
    await expect(handler(event)).resolves.toEqual(result);
    expect(syncIntranetRoster).toHaveBeenCalledWith({
      event,
      actor,
      trigger: "manual",
      confirmDeactivation: false,
      confirmedKinds: [],
    });
  });

  it("passes the confirmation and its counts on", async () => {
    const confirmedKinds = [{ kind: "asociado", toDeactivate: 40 }];
    readBody.mockResolvedValue({ confirmDeactivation: true, confirmedKinds });
    syncIntranetRoster.mockResolvedValue({
      status: "applied",
      result: { created: 0, updated: 0, deactivated: 40 },
    });
    await handler(event);
    expect(syncIntranetRoster).toHaveBeenCalledWith(
      expect.objectContaining({ confirmDeactivation: true, confirmedKinds }),
    );
  });

  it("answers 409 large_deactivation with the counts of a refused sync", async () => {
    const kinds = [{ kind: "asociado", active: 40, toDeactivate: 40 }];
    syncIntranetRoster.mockResolvedValue({ status: "blocked", kinds });
    const error = await failure();
    expect(error.statusCode).toBe(409);
    expect(error.data).toEqual({ reason: "large_deactivation", kinds });
  });

  it("rejects a body that is not MemberSyncBody", async () => {
    readBody.mockResolvedValue({ confirmDeactivation: "yes" });
    const error = await failure();
    expect(error.statusCode).toBe(400);
    expect(syncIntranetRoster).not.toHaveBeenCalled();
  });

  it("lets the 502 of an unreachable intranet through", async () => {
    syncIntranetRoster.mockRejectedValue(
      Object.assign(new Error("bad gateway"), { statusCode: 502 }),
    );
    expect((await failure()).statusCode).toBe(502);
  });
});
