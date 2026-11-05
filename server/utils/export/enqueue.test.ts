import { beforeEach, describe, expect, it, vi } from "vitest";
import type { H3Event } from "h3";
import { AUDIT_ACTIONS } from "~~/shared/constants/activity";

// enqueueExport and the download record with the queue, the storage and
// the database stubbed.
const recordAudit = vi.fn(async () => "audit-id");
const send = vi.fn(async () => "job-id" as string | null);
const writeExportMetadata = vi.fn(async () => undefined);
const deleteExportMetadata = vi.fn(async () => undefined);
const tx = { tx: true };
const transaction = vi.fn(async (run: (inner: unknown) => Promise<unknown>) =>
  run(tx),
);

vi.mock("../../db", () => ({ db: { transaction } }));
vi.mock("../domain/audit", () => ({ recordAudit }));
vi.mock("../core/logger", () => ({ logError: vi.fn() }));
vi.mock("./queue", () => ({ getExportQueue: async () => ({ send }) }));
vi.mock("./storage", () => ({
  buildExportFilename: (parts: string[]) => `${parts.join("-")}.pdf`,
  deleteExportMetadata,
  getExportPdfPath: (jobId: string) => `/exports/${jobId}.pdf`,
  writeExportMetadata,
}));

const { enqueueExport } = await import("./enqueue");
const { exportAuditTarget, recordExportDownload } = await import("./audit");
const { db } = await import("../../db");

const event = { context: {} } as H3Event;
const actor = { user: { id: "target" }, impersonation: { id: "imp1" } };

function documentExport() {
  return enqueueExport({
    queueName: "document-export",
    data: {
      assemblyId: "asm1",
      documentId: "doc1",
      requestedBy: "target",
      locale: "es",
      variant: "annotated",
    },
    filenameParts: ["80-ago", "doc"],
    event,
    actor,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  send.mockResolvedValue("job-id");
  recordAudit.mockResolvedValue("audit-id");
});

describe("exportAuditTarget", () => {
  it("names the document of a document export, else the assembly", () => {
    expect(exportAuditTarget({ assemblyId: "a", documentId: "d" })).toEqual({
      targetType: "document",
      targetId: "d",
    });
    expect(exportAuditTarget({ assemblyId: "a" })).toEqual({
      targetType: "assembly",
      targetId: "a",
    });
  });
});

describe("enqueueExport", () => {
  it("records the request with the job, in one transaction", async () => {
    const { jobId } = await documentExport();
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(recordAudit).toHaveBeenCalledWith(tx, {
      event,
      actor,
      action: AUDIT_ACTIONS.EXPORT_REQUEST,
      targetType: "document",
      targetId: "doc1",
      assemblyId: "asm1",
      after: {
        jobId,
        documentId: "doc1",
        variant: "annotated",
        locale: "es",
      },
    });
    // The impersonation travels with the job and its metadata.
    expect(send).toHaveBeenCalledWith(
      "document-export",
      expect.objectContaining({
        requestedBy: "target",
        impersonationId: "imp1",
      }),
      { id: jobId },
    );
    expect(writeExportMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ jobId, impersonationId: "imp1" }),
    );
  });

  it("records an assembly dossier against the assembly", async () => {
    await enqueueExport({
      queueName: "assembly-export",
      data: { assemblyId: "asm1", requestedBy: "u1", locale: "en" },
      filenameParts: ["80-ago"],
      event,
      actor: { user: { id: "u1" } },
    });
    expect(recordAudit).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        targetType: "assembly",
        targetId: "asm1",
        after: expect.objectContaining({ documentId: null, variant: null }),
      }),
    );
    expect(send).toHaveBeenCalledWith(
      "assembly-export",
      expect.objectContaining({ impersonationId: null }),
      expect.anything(),
    );
  });

  it("fails without a job when the queue refuses it", async () => {
    send.mockResolvedValueOnce(null);
    await expect(documentExport()).rejects.toMatchObject({ statusCode: 503 });
    expect(deleteExportMetadata).toHaveBeenCalledTimes(1);
  });

  it("queues nothing when the request cannot be recorded", async () => {
    recordAudit.mockRejectedValueOnce(new Error("db down"));
    await expect(documentExport()).rejects.toMatchObject({ statusCode: 503 });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("recordExportDownload", () => {
  it("records who downloaded whose export", async () => {
    await recordExportDownload(event, {
      jobId: "job1",
      assemblyId: "asm1",
      documentId: "doc1",
      variant: "clean",
      requestedBy: "u1",
    });
    expect(recordAudit).toHaveBeenCalledWith(db, {
      event,
      action: AUDIT_ACTIONS.EXPORT_DOWNLOAD,
      targetType: "document",
      targetId: "doc1",
      assemblyId: "asm1",
      after: { jobId: "job1", variant: "clean", requestedBy: "u1" },
    });
  });
});
