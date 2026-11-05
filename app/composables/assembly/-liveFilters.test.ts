import { describe, expect, it } from "vitest";
import {
  mayChangeAssemblyData,
  shouldRefetchAgenda,
  shouldRefetchAssembly,
} from "./-liveFilters";

const event = (entityType: string, type = "updated") => ({ entityType, type });

describe("mayChangeAssemblyData", () => {
  it("skips speaking turns and the live state", () => {
    expect(mayChangeAssemblyData(event("speakers", "speaker_added"))).toBe(
      false,
    );
    expect(mayChangeAssemblyData(event("assembly", "live_changed"))).toBe(
      false,
    );
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

  it("refetches on anything else", () => {
    expect(shouldRefetchAgenda([event("live", "poll")])).toBe(true);
    expect(shouldRefetchAgenda([event("document")])).toBe(true);
    expect(shouldRefetchAgenda([event("amendment")])).toBe(true);
    expect(shouldRefetchAgenda([event("agenda_item")])).toBe(true);
  });

  it("refetches when one event of a mixed batch calls for it", () => {
    expect(shouldRefetchAgenda([event("speakers"), event("amendment")])).toBe(
      true,
    );
  });
});
