import { describe, expect, it } from "vitest";
import {
  checkCalendar,
  defaultMilestones,
  milestoneOffsetBefore,
  wholeDaysBeforeStart,
} from "./calendar";

const iso = (date: Date | undefined) => date?.toISOString();

describe("defaultMilestones", () => {
  it("keeps the start's wall-clock time across the autumn clock change", () => {
    // 12 Nov 2026, 10:00 CET; the clocks go back on 25 Oct.
    const start = new Date("2026-11-12T09:00:00.000Z");
    const milestones = defaultMilestones("AGO", start);
    // 13 Oct and 22 Oct, 10:00 CEST.
    expect(iso(milestones.convocation)).toBe("2026-10-13T08:00:00.000Z");
    expect(iso(milestones.agenda_requests_close)).toBe(
      "2026-10-22T08:00:00.000Z",
    );
    // 29 Oct, 10:00 CET, after the change.
    expect(iso(milestones.agenda_final)).toBe("2026-10-29T09:00:00.000Z");
    // Hour offsets stay exact.
    expect(
      start.getTime() - (milestones.candidacies_close?.getTime() ?? 0),
    ).toBe(96 * 3_600_000);
  });

  it("keeps the start's wall-clock time across the spring clock change", () => {
    // 15 Apr 2027, 10:00 CEST; the clocks go forward on 28 Mar.
    const start = new Date("2027-04-15T08:00:00.000Z");
    const milestones = defaultMilestones("AGO", start);
    // 16 Mar, 10:00 CET.
    expect(iso(milestones.convocation)).toBe("2027-03-16T09:00:00.000Z");
    // 3 Apr, 10:00 CEST, after the change.
    expect(iso(milestones.documents_publish)).toBe("2027-04-03T08:00:00.000Z");
  });

  it("leaves out the milestones the type has no default for", () => {
    const milestones = defaultMilestones(
      "AGET",
      new Date("2026-12-15T09:00:00.000Z"),
    );
    expect(milestones.candidacies_close).toBeUndefined();
    expect(milestones.agenda_requests_close).toBeUndefined();
  });
});

describe("checkCalendar short notice", () => {
  const MINUTE = 60_000;

  it.each([
    ["autumn", "2026-11-12T09:00:00.000Z"],
    ["spring", "2027-04-15T08:00:00.000Z"],
  ])("accepts the default convocation (%s)", (_season, startIso) => {
    const start = new Date(startIso);
    const milestones = defaultMilestones("AGO", start);
    const codes = checkCalendar("AGO", start, milestones).map(
      (warning) => warning.code,
    );
    expect(codes).not.toContain("short_notice");
  });

  it.each([
    ["autumn", "2026-11-12T09:00:00.000Z"],
    ["spring", "2027-04-15T08:00:00.000Z"],
  ])(
    "warns when the convocation is a minute late (%s)",
    (_season, startIso) => {
      const start = new Date(startIso);
      const milestones = defaultMilestones("AGO", start);
      const late = new Date(milestones.convocation!.getTime() + MINUTE);
      const codes = checkCalendar("AGO", start, {
        ...milestones,
        convocation: late,
      }).map((warning) => warning.code);
      expect(codes).toContain("short_notice");
    },
  );
});

describe("milestoneOffsetBefore", () => {
  it("subtracts exact hours", () => {
    const start = new Date("2026-10-26T09:00:00.000Z");
    expect(iso(milestoneOffsetBefore(start, { hours: 48 }))).toBe(
      "2026-10-24T09:00:00.000Z",
    );
  });

  it("subtracts calendar days at the same wall-clock time", () => {
    // Monday 26 Oct 2026, 10:00 CET -> Saturday 24 Oct, 10:00 CEST.
    const start = new Date("2026-10-26T09:00:00.000Z");
    expect(iso(milestoneOffsetBefore(start, { days: 2 }))).toBe(
      "2026-10-24T08:00:00.000Z",
    );
  });
});

describe("wholeDaysBeforeStart", () => {
  const start = new Date("2026-10-26T09:00:00.000Z");

  it("counts calendar days across a clock change (49 hours)", () => {
    expect(
      wholeDaysBeforeStart(start, new Date("2026-10-24T08:00:00.000Z")),
    ).toBe(2);
  });

  it("is null when the wall-clock time differs", () => {
    expect(
      wholeDaysBeforeStart(start, new Date("2026-10-24T09:00:00.000Z")),
    ).toBeNull();
  });

  it("is zero at the start itself", () => {
    expect(wholeDaysBeforeStart(start, start)).toBe(0);
  });
});
