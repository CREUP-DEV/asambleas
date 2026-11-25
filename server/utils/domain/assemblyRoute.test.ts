import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createError, createEvent } from "h3";

// resolveAssemblyRoute: the actor first (requireActor, or requireViewer for
// a read the projection makes), then the assembly as that actor sees it.
const calls = vi.hoisted(() => [] as string[]);
const requireActor = vi.hoisted(() => vi.fn());
const requireViewer = vi.hoisted(() => vi.fn());
const resolveAssembly = vi.hoisted(() => vi.fn());

vi.mock("./actor", () => ({ requireActor }));
vi.mock("./roomView", () => ({ requireViewer }));
vi.mock("./resolvers", () => ({ resolveAssembly }));

const { resolveAssemblyRoute } = await import("./assemblyRoute");

const ACTOR = { user: { id: "actor" } };
const VIEWER = { user: { id: "room-view" } };
const ASSEMBLY = { id: "asm" };

function event() {
  const req = new IncomingMessage(new Socket());
  req.method = "GET";
  req.url = "/api/assemblies/80-ago/agenda";
  const created = createEvent(req, new ServerResponse(req));
  created.context.params = { assembly: "80-ago" };
  return created;
}

describe("resolveAssemblyRoute", () => {
  beforeEach(() => {
    calls.length = 0;
    requireActor.mockReset().mockImplementation(async () => {
      calls.push("requireActor");
      return ACTOR;
    });
    requireViewer.mockReset().mockImplementation(async () => {
      calls.push("requireViewer");
      return VIEWER;
    });
    resolveAssembly.mockReset().mockImplementation(async () => {
      calls.push("resolveAssembly");
      return ASSEMBLY;
    });
  });

  it("takes the signed-in actor, then the assembly of the param as it sees it", async () => {
    await expect(resolveAssemblyRoute(event())).resolves.toEqual({
      actor: ACTOR,
      assembly: ASSEMBLY,
    });
    expect(calls).toEqual(["requireActor", "resolveAssembly"]);
    expect(resolveAssembly).toHaveBeenCalledWith(ACTOR, "80-ago");
  });

  it("answers as the room for a viewer read", async () => {
    await expect(
      resolveAssemblyRoute(event(), { viewer: true }),
    ).resolves.toEqual({ actor: VIEWER, assembly: ASSEMBLY });
    expect(calls).toEqual(["requireViewer", "resolveAssembly"]);
    expect(resolveAssembly).toHaveBeenCalledWith(VIEWER, "80-ago");
  });

  it("loads nothing when the actor is refused", async () => {
    requireViewer.mockRejectedValue(createError({ statusCode: 403 }));
    await expect(
      resolveAssemblyRoute(event(), { viewer: true }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(resolveAssembly).not.toHaveBeenCalled();
  });
});
