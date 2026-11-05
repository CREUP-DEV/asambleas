import { describe, expect, it } from "vitest";
import { affectsReviewQueue } from "./-live";

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

  it("reacts to the polling fallback, when anything may have changed", () => {
    expect(affectsReviewQueue([{ type: "poll" }])).toBe(true);
  });

  it("ignores votes, outcomes, positions and draft edits", () => {
    expect(
      affectsReviewQueue([
        { type: "live_changed" },
        { type: "vote_recorded" },
        { type: "amendment_approved" },
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
