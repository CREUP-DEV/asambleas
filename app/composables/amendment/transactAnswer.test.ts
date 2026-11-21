import { describe, expect, it } from "vitest";
import type { AcceptanceDto, AmendmentDto } from "~~/shared/types/api";
import type { AmendmentOp } from "~~/shared/types/content";
import {
  combinableOnTransact,
  composerTakes,
  pendingTransactionalsOver,
  transactAnswerLeads,
  transactComposerLocation,
  workspaceAmendmentLocation,
  type TransactOfferContext,
} from "./transactAnswer";

const OP = { op: "replace", blockId: "b1" } as unknown as AmendmentOp;

const author = (
  decision: AcceptanceDto["decision"],
  role: AcceptanceDto["role"] = "author",
): AcceptanceDto => ({
  member: { id: "m", acronym: "M", name: "Consejo M", kind: "asociado" },
  role,
  decision,
  decidedAt: null,
  recordedBy: "party",
});

function amendment(
  id: string,
  extra: Partial<AmendmentDto> = {},
): AmendmentDto {
  return {
    id,
    documentId: "doc",
    number: null,
    code: null,
    kind: "partial",
    status: "submitted",
    admission: "admitted",
    late: false,
    ops: [OP],
    globalReplace: null,
    justification: "",
    positionKey: 0,
    changeKinds: [],
    authors: [],
    mainAuthorId: null,
    submittedAt: null,
    validatedAt: "2026-11-01T10:00:00.000Z",
    publishedAt: "2026-11-01T10:00:00.000Z",
    reviewState: "published",
    correctionNote: null,
    decidedAt: null,
    approvalMethod: null,
    outcomeNote: null,
    outcomeVote: null,
    position: null,
    sourceIds: [],
    transactionalIds: [],
    acceptances: [],
    updatedAt: "2026-11-01T10:00:00.000Z",
    can: {
      edit: false,
      submit: false,
      withdraw: false,
      accept: false,
      position: true,
      moderate: false,
      review: false,
      validate: false,
      publish: false,
      unvalidate: false,
    },
    ...extra,
  } as AmendmentDto;
}

const OPEN: TransactOfferContext = {
  document: { format: "structured", status: "published", finalVoted: false },
  assemblyClosed: false,
  canDraft: true,
};

describe("combinableOnTransact", () => {
  it("takes a presented, undecided, published amendment", () => {
    expect(combinableOnTransact(amendment("a"))).toBe(true);
  });

  it("leaves out one not public yet, without changes or inadmissible", () => {
    expect(
      combinableOnTransact(amendment("a", { reviewState: "validated" })),
    ).toBe(false);
    expect(combinableOnTransact(amendment("a", { ops: [] }))).toBe(false);
    expect(
      combinableOnTransact(amendment("a", { admission: "inadmissible" })),
    ).toBe(false);
  });

  it("waits for a transactional's main authors", () => {
    expect(
      combinableOnTransact(
        amendment("t", {
          kind: "transactional",
          acceptances: [author("pending")],
        }),
      ),
    ).toBe(false);
    expect(
      combinableOnTransact(
        amendment("t", {
          kind: "transactional",
          acceptances: [author("accepted")],
        }),
      ),
    ).toBe(true);
  });

  it("takes one the presenter's acceptance incorporated: the answer reopens it", () => {
    expect(
      combinableOnTransact(
        amendment("a", {
          status: "approved",
          approvalMethod: "proponent",
          decidedAt: "2026-11-02T10:00:00.000Z",
        }),
      ),
    ).toBe(true);
  });

  it("takes a formal one the presenter's rejection closed", () => {
    expect(
      combinableOnTransact(
        amendment("a", {
          kind: "formal",
          status: "rejected",
          decidedAt: "2026-11-02T10:00:00.000Z",
        }),
      ),
    ).toBe(true);
  });

  it("never one the assembly decided: its answer changes nothing", () => {
    expect(
      combinableOnTransact(
        amendment("a", {
          status: "approved",
          approvalMethod: "vote",
          decidedAt: "2026-11-02T10:00:00.000Z",
        }),
      ),
    ).toBe(false);
    expect(
      combinableOnTransact(
        amendment("a", {
          status: "rejected",
          decidedAt: "2026-11-02T10:00:00.000Z",
        }),
      ),
    ).toBe(false);
  });
});

describe("transactAnswerLeads", () => {
  it("leads to the composer for whoever may write one", () => {
    expect(transactAnswerLeads(amendment("a"), OPEN)).toBe(true);
    expect(
      transactAnswerLeads(amendment("a"), { ...OPEN, canDraft: false }),
    ).toBe(false);
  });

  it("not once the text is voted, the assembly closed or the document plain", () => {
    expect(
      transactAnswerLeads(amendment("a"), {
        ...OPEN,
        document: { ...OPEN.document, finalVoted: true },
      }),
    ).toBe(false);
    expect(
      transactAnswerLeads(amendment("a"), { ...OPEN, assemblyClosed: true }),
    ).toBe(false);
    expect(
      transactAnswerLeads(amendment("a"), {
        ...OPEN,
        document: { ...OPEN.document, format: "file" },
      }),
    ).toBe(false);
    expect(
      transactAnswerLeads(amendment("a"), {
        ...OPEN,
        document: { ...OPEN.document, status: "draft" },
      }),
    ).toBe(false);
  });

  it("not over an amendment no transactional can combine", () => {
    expect(
      transactAnswerLeads(amendment("a", { reviewState: "validated" }), OPEN),
    ).toBe(false);
  });
});

describe("composerTakes and the transactionals on their way", () => {
  const transactional = amendment("t", {
    kind: "transactional",
    code: "T1",
    sourceIds: ["a"],
    acceptances: [author("pending")],
  });

  it("takes an eligible amendment, or the one that stands in for it", () => {
    const eligible = amendment("a");
    expect(composerTakes(eligible, new Map())).toBe(true);
    const accepted = amendment("t2", {
      kind: "transactional",
      sourceIds: ["b"],
      acceptances: [author("accepted")],
      validatedAt: "2026-11-02T10:00:00.000Z",
    });
    const replaced = amendment("b", {
      status: "transacted",
      transactionalIds: ["t2"],
    });
    const byId = new Map([
      ["b", replaced],
      ["t2", accepted],
    ]);
    expect(composerTakes(replaced, byId)).toBe(true);
    expect(composerTakes(replaced, new Map())).toBe(false);
  });

  it("lists the transactionals over it its authors have not settled", () => {
    const source = amendment("a", { transactionalIds: ["t"] });
    const byId = new Map([
      ["a", source],
      ["t", transactional],
    ]);
    expect(pendingTransactionalsOver(source, byId).map((x) => x.id)).toEqual([
      "t",
    ]);
    expect(pendingTransactionalsOver(amendment("a"), byId)).toEqual([]);
  });

  it("builds the workspace locations", () => {
    expect(transactComposerLocation("/a/documentos/d", ["x", "y"])).toEqual({
      path: "/a/documentos/d",
      query: { transaccional: "x,y" },
    });
    expect(workspaceAmendmentLocation("/a/documentos/d", "x")).toEqual({
      path: "/a/documentos/d",
      query: { enmienda: "x" },
    });
  });
});
