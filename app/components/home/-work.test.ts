import { describe, expect, it } from "vitest";
import type {
  DocumentSummaryDto,
  MeWorkAmendmentDto,
  MeWorkAssemblyRef,
  MeWorkDocumentDto,
  MeWorkDto,
  MeWorkReviewDto,
} from "~~/shared/types/api";
import {
  homeWorkAmendmentTask,
  homeWorkDocumentTask,
  homeWorkAmendmentQuery,
  homeWorkForAssembly,
  homeWorkReviewPending,
  homeWorkReviewTotal,
  homeWorkTasks,
  homeWorkUpdates,
} from "./-work";

const ago: MeWorkAssemblyRef = { id: "s1", slug: "80-ago", label: "80.ª AGO" };
const age: MeWorkAssemblyRef = { id: "s2", slug: "12-age", label: "12.ª AGE" };
const NOW = new Date("2026-11-05T12:00:00Z").getTime();

const doc = (
  id: string,
  over: Partial<DocumentSummaryDto> = {},
  assembly = ago,
): MeWorkDocumentDto => ({
  assembly,
  document: {
    id,
    slug: id,
    agendaItemId: "i1",
    kind: "executive_report",
    format: "structured",
    title: id.toUpperCase(),
    reference: null,
    status: "draft",
    proponent: null,
    amendable: false,
    voted: false,
    majority: "simple",
    amendmentCount: 0,
    window: { opensAt: null, closesAt: null, open: false },
    publishedAt: null,
    submittedAt: null,
    dueAt: null,
    hasContent: true,
    correctionNote: null,
    correctionRequestedAt: null,
    consolidated: false,
    updatedAt: "2026-11-01T00:00:00Z",
    ...over,
  },
});

const amend = (
  id: string,
  over: Partial<MeWorkAmendmentDto["amendment"]> = {},
  assembly = ago,
): MeWorkAmendmentDto => ({
  assembly,
  document: { id: "d1", slug: "d1", title: "Resolución" },
  amendment: {
    id,
    code: id.toUpperCase(),
    status: "submitted",
    reviewState: "published",
    correctionNote: null,
    updatedAt: "2026-11-01T00:00:00Z",
    ...over,
  },
});

const review = (over: Partial<MeWorkReviewDto> = {}): MeWorkReviewDto => ({
  assembly: ago,
  documentsToValidate: 0,
  amendmentsToValidate: 0,
  amendmentsToPublish: 0,
  documentsOverdue: 0,
  ...over,
});

describe("home work", () => {
  it("classifies documents", () => {
    expect(homeWorkDocumentTask(doc("a", { hasContent: false }))).toBe(
      "document_prepare",
    );
    expect(homeWorkDocumentTask(doc("a"))).toBe("document_send");
    expect(
      homeWorkDocumentTask(
        doc("a", {
          correctionNote: "Falta el anexo",
          correctionRequestedAt: "2026-11-02T00:00:00Z",
        }),
      ),
    ).toBe("document_correction");
    // A correction without a note still counts as one.
    expect(
      homeWorkDocumentTask(
        doc("a", { correctionRequestedAt: "2026-11-02T00:00:00Z" }),
      ),
    ).toBe("document_correction");
    expect(homeWorkDocumentTask(doc("a", { status: "submitted" }))).toBe(null);
    expect(homeWorkDocumentTask(doc("a", { status: "published" }))).toBe(null);
  });

  it("classifies amendments", () => {
    expect(
      homeWorkAmendmentTask(
        amend("e", { status: "draft", reviewState: null, code: null }),
      ),
    ).toBe("amendment_draft");
    expect(
      homeWorkAmendmentTask(
        amend("e", {
          status: "draft",
          reviewState: "correction_requested",
          correctionNote: "Revisa el apartado 2",
        }),
      ),
    ).toBe("amendment_correction");
    expect(homeWorkAmendmentTask(amend("e"))).toBe(null);
  });

  it("orders tasks by urgency", () => {
    const work: MeWorkDto = {
      documents: [
        doc("later", { hasContent: false, dueAt: "2026-11-20T00:00:00Z" }),
        doc("nodue", { hasContent: true }),
        doc("soon", { hasContent: false, dueAt: "2026-11-08T00:00:00Z" }),
        doc("late", { hasContent: true, dueAt: "2026-11-01T00:00:00Z" }),
        doc("fix", {
          correctionNote: "Falta el anexo",
          correctionRequestedAt: "2026-11-02T00:00:00Z",
        }),
        doc("sent", { status: "submitted" }),
      ],
      amendments: [
        amend("draft", { status: "draft", reviewState: null }),
        amend("fixme", {
          status: "draft",
          reviewState: "correction_requested",
          correctionNote: "Revisa el apartado 2",
        }),
        amend("waiting", { reviewState: "pending_validation" }),
      ],
      review: [],
    };
    const tasks = homeWorkTasks(work, NOW);
    expect(tasks.map((task) => task.key)).toEqual([
      "document-fix",
      "amendment-fixme",
      "document-late",
      "document-soon",
      "document-later",
      "document-nodue",
      "amendment-draft",
    ]);
    const byKey = new Map(tasks.map((task) => [task.key, task]));
    expect(byKey.get("document-late")).toMatchObject({
      kind: "document_send",
      overdue: true,
      target: "edit",
    });
    expect(byKey.get("document-soon")).toMatchObject({
      kind: "document_prepare",
      overdue: false,
    });
    expect(byKey.get("document-fix")?.note).toBe("Falta el anexo");
    expect(byKey.get("amendment-fixme")).toMatchObject({
      kind: "amendment_correction",
      note: "Revisa el apartado 2",
      target: "document",
      amendment: { id: "fixme", code: "FIXME" },
    });
    // Notes are only carried by corrections.
    expect(byKey.get("document-nodue")?.note).toBe(null);
  });

  it("says where the rest stands", () => {
    const work: MeWorkDto = {
      documents: [
        doc("pub", { status: "published" }),
        doc("sent", { status: "submitted" }),
        doc("gone", { status: "withdrawn" }),
        doc("todo", { hasContent: false }),
      ],
      amendments: [
        amend("e3", { reviewState: "published" }),
        amend("e1", { reviewState: "pending_validation" }),
        amend("e2", { reviewState: "validated" }),
        amend("e4", { status: "draft", reviewState: null }),
        amend("e5", { status: "inadmissible", reviewState: "published" }),
      ],
      review: [],
    };
    expect(
      homeWorkUpdates(work).map((update) => [update.key, update.kind]),
    ).toEqual([
      // Same step: by document title ("Resolución" before "SENT").
      ["amendment-e1", "amendment_review"],
      ["document-sent", "document_review"],
      ["amendment-e2", "amendment_validated"],
      ["document-pub", "document_published"],
      ["amendment-e3", "amendment_published"],
      ["amendment-e5", "amendment_other"],
    ]);
  });

  it("summarises the Secretaría's pending review", () => {
    const busy = review({ documentsToValidate: 2, documentsOverdue: 1 });
    const quiet = review({ assembly: age });
    expect(homeWorkReviewTotal(busy)).toBe(3);
    expect(homeWorkReviewTotal(quiet)).toBe(0);
    expect(homeWorkReviewPending([busy, quiet])).toEqual([busy]);
  });

  it("filters by assembly", () => {
    const work: MeWorkDto = {
      documents: [doc("a"), doc("b", {}, age)],
      amendments: [amend("e", {}, age)],
      review: [review(), review({ assembly: age, amendmentsToPublish: 1 })],
    };
    const ours = homeWorkForAssembly(work, "s1");
    expect(ours.documents.map((entry) => entry.document.id)).toEqual(["a"]);
    expect(ours.amendments).toEqual([]);
    expect(ours.review.map((entry) => entry.assembly.id)).toEqual(["s1"]);
  });

  it("opens the amendment a task or update is about", () => {
    expect(homeWorkAmendmentQuery(null)).toBe("");
    expect(homeWorkAmendmentQuery({ id: "abc123" })).toBe("?enmienda=abc123");
    expect(homeWorkAmendmentQuery({ id: "a b&c" })).toBe("?enmienda=a%20b%26c");
  });
});
