import { describe, expect, it } from "vitest";
import {
  affectsDocumentDto,
  mayChangeAssemblyData,
  SESSION_DOCUMENT_TYPES,
  shouldRefetchAgenda,
  shouldRefetchAssembly,
  shouldRefetchReadMarks,
} from "./-liveFilters";

const event = (entityType: string, type = "updated") => ({ entityType, type });

/** An event with ids, as the stream sends it. */
const scoped = (
  entityType: string,
  type: string,
  entityId: string,
  documentId?: string,
) => ({ entityType, type, entityId, ...(documentId ? { documentId } : {}) });

describe("mayChangeAssemblyData", () => {
  it("skips speaking turns, the control sheet, the room and the live state", () => {
    expect(mayChangeAssemblyData(event("speakers", "speaker_added"))).toBe(
      false,
    );
    expect(
      mayChangeAssemblyData(
        event("control_sheet", "control_sheet_observations_updated"),
      ),
    ).toBe(false);
    expect(mayChangeAssemblyData(event("assembly", "live_changed"))).toBe(
      false,
    );
    expect(
      mayChangeAssemblyData(event("seating", "seating_assignments_changed")),
    ).toBe(false);
    expect(
      mayChangeAssemblyData(event("seating", "seating_images_ready")),
    ).toBe(false);
  });

  it("keeps everything else", () => {
    expect(mayChangeAssemblyData(event("amendment"))).toBe(true);
    expect(mayChangeAssemblyData(event("document"))).toBe(true);
    expect(mayChangeAssemblyData(event("assembly", "poll"))).toBe(true);
  });
});

describe("shouldRefetchAssembly", () => {
  it("ignores speaking turns, even on the assembly", () => {
    expect(shouldRefetchAssembly([event("speakers")])).toBe(false);
    expect(shouldRefetchAssembly([event("assembly", "live_changed")])).toBe(
      false,
    );
  });

  it("refetches on a poll, the assembly or a document", () => {
    expect(shouldRefetchAssembly([event("live", "poll")])).toBe(true);
    expect(shouldRefetchAssembly([event("assembly")])).toBe(true);
    expect(shouldRefetchAssembly([event("document")])).toBe(true);
  });

  it("keeps following document changes, new kinds too", () => {
    for (const type of [
      "document_voted",
      "final_vote_annulled",
      "document_status_changed",
      "document_published",
      "document_deleted",
      "document_content_updated",
      "document_file_uploaded",
      "document_updated",
      "document_something_new",
    ]) {
      expect(shouldRefetchAssembly([event("document", type)]), type).toBe(true);
    }
  });

  it("ignores the session's own document events", () => {
    for (const type of SESSION_DOCUMENT_TYPES) {
      expect(shouldRefetchAssembly([event("document", type)]), type).toBe(
        false,
      );
    }
    expect(
      shouldRefetchAssembly([
        event("document", "document_positions_debate_started"),
        event("assembly", "poll"),
      ]),
    ).toBe(true);
  });

  it("leaves the assembly alone for amendments and agenda items", () => {
    expect(shouldRefetchAssembly([event("amendment")])).toBe(false);
    expect(shouldRefetchAssembly([event("agenda_item")])).toBe(false);
  });

  it("refetches when one event of a mixed batch calls for it", () => {
    expect(shouldRefetchAssembly([event("speakers"), event("document")])).toBe(
      true,
    );
  });

  it("does nothing for an empty batch", () => {
    expect(shouldRefetchAssembly([])).toBe(false);
  });
});

describe("shouldRefetchAgenda", () => {
  it("ignores speaking turns and the live state", () => {
    expect(
      shouldRefetchAgenda([
        event("speakers", "speaker_added"),
        event("speakers", "floor_given"),
        event("assembly", "live_changed"),
      ]),
    ).toBe(false);
  });

  it("ignores the room, however many seats move", () => {
    expect(
      shouldRefetchAgenda([
        event("seating", "seating_assignments_changed"),
        event("seating", "seating_synced"),
      ]),
    ).toBe(false);
    expect(shouldRefetchAssembly([event("seating", "seating_synced")])).toBe(
      false,
    );
  });

  it("refetches on a poll, a document or an agenda item", () => {
    expect(shouldRefetchAgenda([event("live", "poll")])).toBe(true);
    expect(shouldRefetchAgenda([event("document")])).toBe(true);
    expect(shouldRefetchAgenda([event("agenda_item")])).toBe(true);
  });

  it("keeps following the assembly's own events", () => {
    for (const type of [
      "assembly_updated",
      "assembly_status_changed",
      "calendar_updated",
      "agenda_reordered",
    ]) {
      expect(shouldRefetchAgenda([event("assembly", type)]), type).toBe(true);
    }
    for (const type of [
      "agenda_item_created",
      "agenda_item_updated",
      "agenda_item_deleted",
    ]) {
      expect(shouldRefetchAgenda([event("agenda_item", type)]), type).toBe(
        true,
      );
    }
  });

  it("follows every document event, the answers' too", () => {
    // DocumentSummaryDto carries positionsPublishedAt and
    // positionsDebateStartedAt.
    for (const type of [
      "document_voted",
      "final_vote_annulled",
      "document_status_changed",
      "document_published",
      ...SESSION_DOCUMENT_TYPES,
    ]) {
      expect(shouldRefetchAgenda([event("document", type)]), type).toBe(true);
    }
  });

  it("ignores votes, decisions, headcounts and the projection's control", () => {
    expect(shouldRefetchAgenda([event("vote", "vote_recorded")])).toBe(false);
    expect(
      shouldRefetchAgenda([
        scoped("vote", "vote_recorded", "v1", "d1"),
        scoped("vote", "vote_unanimity_changed", "v1", "d1"),
      ]),
    ).toBe(false);
    // An agenda item's vote («Se vota el punto» is the item's own flag).
    expect(
      shouldRefetchAgenda([
        scoped("vote", "vote_recorded", "v2"),
        scoped("vote", "vote_voided", "v2"),
      ]),
    ).toBe(false);
    expect(shouldRefetchAgenda([event("decision", "decision_recorded")])).toBe(
      false,
    );
    expect(
      shouldRefetchAgenda([
        event("headcount", "headcount_recorded"),
        event("headcount", "headcount_corrected"),
      ]),
    ).toBe(false);
    expect(
      shouldRefetchAgenda([event("projection", "projection_control_changed")]),
    ).toBe(false);
    expect(shouldRefetchAgenda([event("live", "live_changed")])).toBe(false);
  });

  it("refetches with a decision that publishes or counts an amendment", () => {
    // Admitting a late amendment publishes it; declaring a returned draft
    // inadmissible makes it count as presented. Both come with a decision.
    for (const type of ["amendment_admitted", "amendment_inadmissible"]) {
      expect(
        shouldRefetchAgenda([
          event("decision", "decision_recorded"),
          event("amendment", type),
        ]),
        type,
      ).toBe(true);
    }
  });

  it("refetches for the amendments only when which ones are seen changes", () => {
    for (const type of [
      "amendment_created",
      "amendment_submitted",
      "amendment_published",
      "amendment_validated",
      "amendment_validation_undone",
      "amendment_correction_requested",
      "amendment_withdrawn",
      "amendment_deleted",
      "amendment_admitted",
      "amendment_inadmissible",
      "amendment_reopened",
    ]) {
      expect(shouldRefetchAgenda([event("amendment", type)]), type).toBe(true);
    }
    for (const type of [
      "amendment_approved",
      "amendment_rejected",
      "amendment_lapsed",
      "amendment_transacted",
      "position_changed",
      "acceptance_recorded",
    ]) {
      expect(shouldRefetchAgenda([event("amendment", type)]), type).toBe(false);
    }
  });

  it("refetches when one event of a mixed batch calls for it", () => {
    expect(
      shouldRefetchAgenda([
        event("speakers"),
        event("amendment", "amendment_approved"),
        event("amendment", "amendment_published"),
      ]),
    ).toBe(true);
  });
});

describe("shouldRefetchReadMarks", () => {
  it("follows the documents, a poll and what changes what is to read", () => {
    expect(shouldRefetchReadMarks([event("live", "poll")])).toBe(true);
    expect(shouldRefetchReadMarks([event("document")])).toBe(true);
    expect(
      shouldRefetchReadMarks([event("amendment", "amendment_published")]),
    ).toBe(true);
    expect(
      shouldRefetchReadMarks([event("amendment", "amendment_updated")]),
    ).toBe(true);
    expect(
      shouldRefetchReadMarks([event("amendment", "amendment_admitted")]),
    ).toBe(true);
  });

  it("keeps following document changes", () => {
    for (const type of [
      "document_voted",
      "final_vote_annulled",
      "document_status_changed",
      "document_published",
      "document_deleted",
      "document_content_updated",
      "document_file_uploaded",
      "document_updated",
      // A document event nobody checked yet keeps refetching.
      "document_something_new",
    ]) {
      expect(shouldRefetchReadMarks([event("document", type)]), type).toBe(
        true,
      );
    }
  });

  it("ignores the session's own document events", () => {
    for (const type of [
      "document_positions_debate_started",
      "document_positions_published",
      "document_positions_unpublished",
      "passage_worded",
      "passage_wording_removed",
    ]) {
      expect(shouldRefetchReadMarks([event("document", type)]), type).toBe(
        false,
      );
    }
  });

  it("ignores decisions, answers and everything else", () => {
    expect(
      shouldRefetchReadMarks([
        event("amendment", "amendment_approved"),
        event("amendment", "position_changed"),
        event("control_sheet", "control_sheet_treated_changed"),
        event("speakers", "floor_given"),
      ]),
    ).toBe(false);
  });
});

describe("affectsDocumentDto", () => {
  const doc = "d1";
  const finalVote = "fv";

  it("refetches on a poll, even before the document is known", () => {
    expect(affectsDocumentDto([scoped("assembly", "poll", "as1")], doc)).toBe(
      true,
    );
    expect(
      affectsDocumentDto([scoped("assembly", "poll", "as1")], undefined),
    ).toBe(true);
  });

  it("ignores votes, decisions and answers on its amendments", () => {
    expect(
      affectsDocumentDto(
        [
          scoped("vote", "vote_recorded", "v1", doc),
          scoped("decision", "decision_recorded", "dec1", doc),
          scoped("amendment", "amendment_approved", "a1", doc),
          scoped("amendment", "amendment_rejected", "a2", doc),
          scoped("amendment", "amendment_lapsed", "a3", doc),
          scoped("amendment", "amendment_transacted", "a4", doc),
          scoped("amendment", "amendment_vote_without_effect", "a5", doc),
          scoped("amendment", "position_changed", "a1", doc),
          scoped("amendment", "acceptance_recorded", "a1", doc),
          scoped("amendment", "amendment_updated", "a1", doc),
          scoped("amendment", "relation_created", "a1", doc),
          scoped("amendment", "transactional_revision_proposed", "a1", doc),
        ],
        doc,
        finalVote,
      ),
    ).toBe(false);
  });

  it("ignores the live state, the speakers, the sheet and headcounts", () => {
    expect(
      affectsDocumentDto(
        [
          scoped("live", "live_changed", "as1"),
          scoped("speakers", "speaking_turn_started", "as1"),
          scoped("control_sheet", "control_sheet_treated_changed", "i1"),
          scoped("headcount", "headcount_recorded", "h1"),
          scoped("projection", "projection_control_changed", "as1"),
          scoped("agenda_item", "agenda_item_updated", "i1"),
        ],
        doc,
        finalVote,
      ),
    ).toBe(false);
  });

  it("follows the document's own events, its answers included", () => {
    for (const type of [
      "document_updated",
      "document_content_updated",
      "document_published",
      "document_voted",
      "final_vote_annulled",
      "document_deleted",
      "document_positions_debate_started",
      "document_positions_published",
      "document_positions_unpublished",
    ]) {
      expect(
        affectsDocumentDto([scoped("document", type, doc, doc)], doc),
        type,
      ).toBe(true);
    }
  });

  it("ignores another document and the Mesa's wording of a passage", () => {
    expect(
      affectsDocumentDto(
        [
          scoped("document", "document_updated", "d2", "d2"),
          scoped("amendment", "amendment_published", "a9", "d2"),
          scoped("document", "passage_worded", doc, doc),
          scoped("document", "passage_wording_removed", doc, doc),
        ],
        doc,
      ),
    ).toBe(false);
  });

  it("follows what changes how many of its amendments are seen", () => {
    for (const type of [
      "amendment_created",
      "amendment_deleted",
      "amendment_submitted",
      "amendment_published",
      "amendment_validated",
      "amendment_validation_undone",
      "amendment_correction_requested",
      "amendment_withdrawn",
      "amendment_admitted",
      "amendment_inadmissible",
      "amendment_reopened",
      "amendment_authors_changed",
      "transactional_source_dropped",
      "transactional_revision_applied",
    ]) {
      expect(
        affectsDocumentDto([scoped("amendment", type, "a1", doc)], doc),
        type,
      ).toBe(true);
    }
  });

  it("follows its final vote, not the others", () => {
    expect(
      affectsDocumentDto(
        [scoped("vote", "vote_unanimity_changed", finalVote, doc)],
        doc,
        finalVote,
      ),
    ).toBe(true);
    expect(
      affectsDocumentDto(
        [scoped("vote", "vote_unanimity_changed", "other", doc)],
        doc,
        finalVote,
      ),
    ).toBe(false);
    expect(
      affectsDocumentDto(
        [scoped("vote", "vote_unanimity_changed", finalVote, doc)],
        doc,
        null,
      ),
    ).toBe(false);
  });

  it("follows the assembly (its status and calendar set `can`)", () => {
    for (const type of [
      "assembly_status_changed",
      "assembly_updated",
      "calendar_updated",
    ]) {
      expect(
        affectsDocumentDto([scoped("assembly", type, "as1")], doc),
        type,
      ).toBe(true);
    }
    expect(
      affectsDocumentDto(
        [scoped("assembly", "assembly_status_changed", "as1")],
        undefined,
      ),
    ).toBe(false);
  });

  it("refetches when one event of a vote's batch calls for it", () => {
    expect(
      affectsDocumentDto(
        [
          scoped("vote", "vote_recorded", "fv2", doc),
          scoped("document", "document_voted", doc, doc),
        ],
        doc,
        null,
      ),
    ).toBe(true);
  });
});
