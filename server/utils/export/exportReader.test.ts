import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEvent, type H3Event } from "h3";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import type { Actor } from "../domain/actor";
import { testActor } from "../../testing/actor";
import { EXPORT_QUEUE_NAMES } from "./queue";

// Who polls and downloads an export (requireExportReader): its requester or
// whoever manages its queue, and the two routes that read it refuse
// everyone else before anything else happens.
const requireActor = vi.hoisted(() => vi.fn());
const readExportMetadata = vi.hoisted(() => vi.fn());
const getExportQueue = vi.hoisted(() => vi.fn());
const recordExportDownload = vi.hoisted(() => vi.fn());

vi.mock("../../db", () => ({ db: {} }));
vi.mock("../auth/requireAuth", () => ({
  getAuthUserWithRole: vi.fn(),
  requireAuth: vi.fn(),
}));
vi.mock("../auth/rbac", () => ({
  getEffectivePermissions: vi.fn(),
  isAdmin: (name: string | null | undefined) => name === "Admin",
}));
vi.mock("../domain/actor", async (original) => ({
  ...(await original<typeof import("../domain/actor")>()),
  requireActor,
}));
vi.mock("./storage", async (original) => ({
  ...(await original<typeof import("./storage")>()),
  readExportMetadata,
}));
vi.mock("./queue", async (original) => ({
  ...(await original<typeof import("./queue")>()),
  getExportQueue,
}));
vi.mock("./audit", () => ({ recordExportDownload }));

const { requireExportReader } = await import("./storage");
const { default: statusHandler } =
  await import("../../api/exports/[jobId]/status.get");
const { default: downloadHandler } =
  await import("../../api/exports/[jobId]/download.get");

const REQUESTER = "r".repeat(32);
const JOB_ID = "job-0123456789";

const documentExport = {
  jobId: JOB_ID,
  queueName: EXPORT_QUEUE_NAMES.DOCUMENT_EXPORT,
  requestedBy: REQUESTER,
  status: "done",
};
const assemblyExport = {
  ...documentExport,
  queueName: EXPORT_QUEUE_NAMES.ASSEMBLY_EXPORT,
};

function jobEvent(): H3Event {
  const req = new IncomingMessage(new Socket());
  req.method = "GET";
  req.url = `/api/exports/${JOB_ID}/status`;
  const event = createEvent(req, new ServerResponse(req));
  event.context.params = { jobId: JOB_ID };
  return event;
}

const requester = testActor({ id: REQUESTER });
const stranger = testActor();
const documentManager = testActor({
  permissions: [PERMISSION_KEYS.DOCUMENT_MANAGE],
});
const assemblyManager = testActor({
  permissions: [PERMISSION_KEYS.ASSEMBLY_MANAGE],
});
const admin = testActor({ role: SYSTEM_ROLES.ADMIN });

describe("requireExportReader", () => {
  it("lets the requester through without any key", () => {
    expect(() => requireExportReader(requester, documentExport)).not.toThrow();
  });

  it("lets through whoever manages the export's queue, and an Admin", () => {
    expect(() =>
      requireExportReader(documentManager, documentExport),
    ).not.toThrow();
    expect(() =>
      requireExportReader(assemblyManager, assemblyExport),
    ).not.toThrow();
    expect(() => requireExportReader(admin, documentExport)).not.toThrow();
  });

  it("refuses anyone else, a manager of the other queue included", () => {
    for (const [actor, metadata] of [
      [stranger, documentExport],
      [assemblyManager, documentExport],
      [documentManager, assemblyExport],
    ] as const) {
      expect(() => requireExportReader(actor, metadata)).toThrow(
        expect.objectContaining({ statusCode: 403 }),
      );
    }
  });
});

describe.each([
  ["status", statusHandler],
  ["download", downloadHandler],
])("GET /api/exports/[jobId]/%s", (_name, handler) => {
  beforeEach(() => {
    requireActor.mockReset();
    readExportMetadata.mockReset();
    getExportQueue.mockReset();
    recordExportDownload.mockReset();
    readExportMetadata.mockResolvedValue(documentExport);
  });

  function as(actor: Actor) {
    requireActor.mockResolvedValue(actor);
  }

  it("refuses a caller who neither asked for it nor manages its queue", async () => {
    as(assemblyManager);
    await expect(handler(jobEvent())).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(readExportMetadata).toHaveBeenCalledWith(JOB_ID);
    expect(getExportQueue).not.toHaveBeenCalled();
    expect(recordExportDownload).not.toHaveBeenCalled();
  });

  it("refuses an id that is not a job's before reading anything", async () => {
    as(requester);
    const event = jobEvent();
    event.context.params = { jobId: "../x" };
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 400 });
    expect(readExportMetadata).not.toHaveBeenCalled();
  });
});

describe("GET /api/exports/[jobId]/status", () => {
  it("answers the requester", async () => {
    requireActor.mockResolvedValue(requester);
    readExportMetadata.mockResolvedValue(documentExport);
    await expect(statusHandler(jobEvent())).resolves.toEqual({
      jobId: JOB_ID,
      status: "done",
    });
  });
});
