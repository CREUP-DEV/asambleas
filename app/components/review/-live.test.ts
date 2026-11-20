import { describe, expect, it } from "vitest";
import { affectsReviewQueue, refetchesAfterWrite } from "./-live";

describe("refetchesAfterWrite", () => {
  it("replaces a read on its way, which may have left before the write", () => {
    expect(refetchesAfterWrite({ status: "pending", connected: true })).toBe(
      true,
    );
    expect(refetchesAfterWrite({ status: "pending", connected: false })).toBe(
      true,
    );
  });

  it("leaves the refetch to the write's live event otherwise", () => {
    expect(refetchesAfterWrite({ status: "success", connected: true })).toBe(
      false,
    );
    expect(refetchesAfterWrite({ status: "error", connected: true })).toBe(
      false,
    );
    expect(refetchesAfterWrite({ status: "idle", connected: true })).toBe(
      false,
    );
  });

  it("refetches at once without the live stream, which may bring no event", () => {
    expect(refetchesAfterWrite({ status: "success", connected: false })).toBe(
      true,
    );
    expect(refetchesAfterWrite({ status: "error", connected: false })).toBe(
      true,
    );
  });
});

describe("affectsReviewQueue", () => {
  it("reacts to documents and amendments entering or leaving the inbox", () => {
    expect(affectsReviewQueue([{ type: "document_submitted" }])).toBe(true);
    expect(affectsReviewQueue([{ type: "amendment_validated" }])).toBe(true);
    expect(affectsReviewQueue([{ type: "amendment_admitted" }])).toBe(true);
  });

  it("reacts to the Mesa settling a late one waiting for the assembly", () => {
    expect(affectsReviewQueue([{ type: "amendment_inadmissible" }])).toBe(true);
    expect(affectsReviewQueue([{ type: "amendment_lapsed" }])).toBe(true);
    expect(affectsReviewQueue([{ type: "amendment_withdrawn" }])).toBe(true);
  });

  it("reacts to the main authors answering a transactional", () => {
    expect(affectsReviewQueue([{ type: "acceptance_recorded" }])).toBe(true);
  });

  it("reacts to an amendment replaced by a transactional", () => {
    expect(affectsReviewQueue([{ type: "amendment_transacted" }])).toBe(true);
  });

  it("reacts to outcomes, which close transactionals still waiting", () => {
    expect(affectsReviewQueue([{ type: "amendment_approved" }])).toBe(true);
    expect(affectsReviewQueue([{ type: "amendment_rejected" }])).toBe(true);
    expect(affectsReviewQueue([{ type: "document_voted" }])).toBe(true);
    expect(affectsReviewQueue([{ type: "final_vote_annulled" }])).toBe(true);
  });

  it("reacts to the polling fallback, when anything may have changed", () => {
    expect(affectsReviewQueue([{ type: "poll" }])).toBe(true);
  });

  it("ignores vote tallies, positions and draft edits", () => {
    expect(
      affectsReviewQueue([
        { type: "live_changed" },
        { type: "vote_recorded" },
        { type: "position_changed" },
        { type: "amendment_updated" },
        { type: "document_content_updated" },
      ]),
    ).toBe(false);
  });

  it("reacts when any event of the batch matters", () => {
    expect(
      affectsReviewQueue([
        { type: "vote_recorded" },
        { type: "document_published" },
      ]),
    ).toBe(true);
    expect(affectsReviewQueue([])).toBe(false);
  });
});
