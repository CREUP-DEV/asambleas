import { describe, expect, it } from "vitest";
import {
  mayChangeAssemblyData,
  shouldRefetchAgenda,
  shouldRefetchAssembly,
  shouldRefetchReadMarks,
} from "./-liveFilters";

const event = (entityType: string, type = "updated") => ({ entityType, type });

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

  it("refetches on anything else", () => {
    expect(shouldRefetchAgenda([event("live", "poll")])).toBe(true);
    expect(shouldRefetchAgenda([event("document")])).toBe(true);
    expect(shouldRefetchAgenda([event("agenda_item")])).toBe(true);
  });

  it("refetches for the amendments only when which ones are seen changes", () => {
    for (const type of [
      "amendment_submitted",
      "amendment_published",
      "amendment_validated",
      "amendment_validation_undone",
      "amendment_withdrawn",
      "amendment_deleted",
    ]) {
      expect(shouldRefetchAgenda([event("amendment", type)]), type).toBe(true);
    }
    for (const type of [
      "amendment_approved",
      "amendment_rejected",
      "amendment_lapsed",
      "amendment_reopened",
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
