import { describe, expect, it } from "vitest";
import type { AmendmentDto } from "~~/shared/types/api";
import {
  admissionDecisionOf,
  admissionPurposeOf,
  isSessionProposalMismatch,
  isSessionProposalOnScreen,
  sessionAdmissionProposal,
  sessionAdmissionProposalPlan,
  sessionAdmissionTarget,
  sessionApprovalBloc,
} from "./admissionProposal";

const amendment = (
  id: string,
  over: Partial<AmendmentDto> = {},
): AmendmentDto => ({
  id,
  documentId: "d1",
  number: 1,
  code: id.toUpperCase(),
  kind: "partial",
  status: "submitted",
  admission: "pending",
  late: true,
  ops: [],
  globalReplace: null,
  justification: "",
  positionKey: 0,
  changeKinds: [],
  authors: [],
  mainAuthorId: null,
  submittedAt: "2026-11-01T00:00:00Z",
  validatedAt: "2026-11-02T00:00:00Z",
  publishedAt: "2026-11-02T00:00:00Z",
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
  updatedAt: "2026-11-02T00:00:00Z",
  can: {
    edit: false,
    submit: false,
    withdraw: false,
    accept: false,
    position: false,
    moderate: false,
    review: false,
    validate: false,
    publish: false,
    unvalidate: false,
  },
  ...over,
});

const screen = (
  over: Partial<{
    documentId: string | null;
    amendmentBloc: string[];
    amendmentBlocPurpose: "admit" | "inadmit" | null;
  }> = {},
) => ({
  documentId: "d1",
  amendmentBloc: ["a", "b"],
  amendmentBlocPurpose: null,
  ...over,
});

describe("the bloc on screen and a proposal on admission (2026-11-21)", () => {
  it("feeds approval only with a bloc proposed for approval", () => {
    expect(sessionApprovalBloc(screen(), "d1")).toEqual(["a", "b"]);
    expect(
      sessionApprovalBloc(screen({ amendmentBlocPurpose: "admit" }), "d1"),
    ).toEqual([]);
    expect(
      sessionApprovalBloc(screen({ amendmentBlocPurpose: "inadmit" }), "d1"),
    ).toEqual([]);
    expect(sessionApprovalBloc(screen(), "d2")).toEqual([]);
    expect(sessionApprovalBloc(null, "d1")).toEqual([]);
  });

  it("reads a proposal on admission only with its purpose", () => {
    expect(
      sessionAdmissionProposal(screen({ amendmentBlocPurpose: "admit" }), "d1"),
    ).toEqual({ ids: ["a", "b"], purpose: "admit" });
    expect(sessionAdmissionProposal(screen(), "d1")).toBeNull();
    expect(
      sessionAdmissionProposal(screen({ amendmentBlocPurpose: "admit" }), "d2"),
    ).toBeNull();
    expect(
      sessionAdmissionProposal(
        screen({ amendmentBloc: [], amendmentBlocPurpose: "admit" }),
        "d1",
      ),
    ).toBeNull();
  });

  it("maps a decision to a purpose and back", () => {
    expect(admissionPurposeOf("admitted")).toBe("admit");
    expect(admissionPurposeOf("inadmissible")).toBe("inadmit");
    expect(admissionDecisionOf("admit")).toBe("admitted");
    expect(admissionDecisionOf("inadmit")).toBe("inadmissible");
  });

  it("offers the late ones pending and published, and counts the rest", () => {
    const list = [
      amendment("u3", { positionKey: 3 }),
      amendment("u1", { positionKey: 1 }),
      amendment("u2", { positionKey: 2, publishedAt: null }),
      amendment("u4", {
        positionKey: 4,
        publishedAt: null,
        validatedAt: null,
        reviewState: "pending_validation",
      }),
      amendment("u5", { positionKey: 5, admission: "admitted" }),
      amendment("o1", { positionKey: 6, late: false }),
    ];
    expect(sessionAdmissionProposalPlan(list)).toEqual({
      ids: ["u1", "u3"],
      unpublished: 2,
    });
    expect(sessionAdmissionProposalPlan(list, ["u3", "u2", "u5"])).toEqual({
      ids: ["u3"],
      unpublished: 2,
    });
  });

  it("knows when exactly this proposal is on screen", () => {
    const proposal = { ids: ["a", "b"], purpose: "admit" as const };
    expect(isSessionProposalOnScreen(proposal, ["b", "a"], "admit")).toBe(true);
    expect(isSessionProposalOnScreen(proposal, ["a"], "admit")).toBe(false);
    expect(isSessionProposalOnScreen(proposal, ["a", "b"], "inadmit")).toBe(
      false,
    );
    expect(isSessionProposalOnScreen(null, ["a"], "admit")).toBe(false);
  });

  it("holds a decision on other amendments than the room reads", () => {
    const list = [
      amendment("a"),
      amendment("b"),
      amendment("c", { publishedAt: null }),
      amendment("d", { admission: "admitted" }),
      amendment("x", { late: false }),
    ];
    const byId = new Map(list.map((item) => [item.id, item]));
    const proposal = { ids: ["a", "b", "d"], purpose: "admit" as const };
    // Exactly the ones still pending on screen.
    expect(
      isSessionProposalMismatch(["b", "a"], "admitted", proposal, byId),
    ).toBe(false);
    // An unpublished one ticked beside them, or one of them left out.
    expect(
      isSessionProposalMismatch(["a", "b", "c"], "admitted", proposal, byId),
    ).toBe(true);
    expect(isSessionProposalMismatch(["a"], "admitted", proposal, byId)).toBe(
      true,
    );
    // Something else entirely, or nothing on screen.
    expect(isSessionProposalMismatch(["x"], "admitted", proposal, byId)).toBe(
      false,
    );
    expect(isSessionProposalMismatch(["a"], "admitted", null, byId)).toBe(
      false,
    );
    // All of it decided already.
    expect(
      isSessionProposalMismatch(
        ["a"],
        "admitted",
        { ids: ["d"], purpose: "admit" },
        byId,
      ),
    ).toBe(false);
  });

  it("holds the opposite decision to the one the room reads", () => {
    const list = [amendment("a"), amendment("b"), amendment("x")];
    const byId = new Map(list.map((item) => [item.id, item]));
    const admit = { ids: ["a", "b"], purpose: "admit" as const };
    const inadmit = { ids: ["a", "b"], purpose: "inadmit" as const };
    // The same amendments, decided the other way round.
    expect(
      isSessionProposalMismatch(["a", "b"], "inadmissible", admit, byId),
    ).toBe(true);
    expect(
      isSessionProposalMismatch(["b", "a"], "admitted", inadmit, byId),
    ).toBe(true);
    // As proposed.
    expect(
      isSessionProposalMismatch(["a", "b"], "inadmissible", inadmit, byId),
    ).toBe(false);
    // Amendments off the proposal: the direction is the Mesa's.
    expect(isSessionProposalMismatch(["x"], "inadmissible", admit, byId)).toBe(
      false,
    );
  });

  it("opens the dialog on the proposal the room reads", () => {
    const list = [
      amendment("a"),
      amendment("b"),
      amendment("c", { admission: "admitted" }),
      amendment("x", { late: false, admission: "admitted" }),
    ];
    const byId = new Map(list.map((item) => [item.id, item]));
    const proposal = { ids: ["a", "b", "c"], purpose: "inadmit" as const };
    // Opened on any of them: the pending ones on screen, as proposed.
    expect(sessionAdmissionTarget(["a"], "admitted", proposal, byId)).toEqual({
      ids: ["a", "b"],
      decision: "inadmissible",
    });
    // Opened on something else: what it was opened for.
    expect(
      sessionAdmissionTarget(["x"], "inadmissible", proposal, byId),
    ).toEqual({ ids: ["x"], decision: "inadmissible" });
    // Nothing left pending on screen, or no proposal.
    expect(
      sessionAdmissionTarget(
        ["c"],
        "admitted",
        { ids: ["c"], purpose: "admit" },
        byId,
      ),
    ).toEqual({ ids: ["c"], decision: "admitted" });
    expect(sessionAdmissionTarget(["a"], "admitted", null, byId)).toEqual({
      ids: ["a"],
      decision: "admitted",
    });
  });
});
