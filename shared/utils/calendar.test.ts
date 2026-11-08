import { describe, expect, it } from "vitest";
import { INITIAL_CALENDAR_RULES } from "../constants/calendarRules";
import {
  checkCalendar,
  defaultMilestones,
  milestoneOffsetBefore,
  respectsNotice,
  wholeDaysBeforeStart,
  type CalendarDocument,
  type CalendarRules,
} from "./calendar";

const AGO = INITIAL_CALENDAR_RULES.AGO;
const AGET = INITIAL_CALENDAR_RULES.AGET;

const iso = (date: Date | undefined) => date?.toISOString();

describe("defaultMilestones", () => {
  it("keeps the start's wall-clock time across the autumn clock change", () => {
    // 12 Nov 2026, 10:00 CET; the clocks go back on 25 Oct.
    const start = new Date("2026-11-12T09:00:00.000Z");
    const milestones = defaultMilestones(AGO, start);
    // 12 Oct (a calendar month) and 22 Oct, 10:00 CEST.
    expect(iso(milestones.convocation)).toBe("2026-10-12T08:00:00.000Z");
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
    const milestones = defaultMilestones(AGO, start);
    // 15 Mar (a calendar month), 10:00 CET.
    expect(iso(milestones.convocation)).toBe("2027-03-15T09:00:00.000Z");
    // 3 Apr, 10:00 CEST, after the change.
    expect(iso(milestones.documents_publish)).toBe("2027-04-03T08:00:00.000Z");
  });

  it("leaves out the milestones the type has no default for", () => {
    const milestones = defaultMilestones(
      AGET,
      new Date("2026-12-15T09:00:00.000Z"),
    );
    expect(milestones.candidacies_close).toBeUndefined();
    expect(milestones.agenda_requests_close).toBeUndefined();
  });
});

describe("checkCalendar short notice", () => {
  it.each([
    ["autumn", "2026-11-12T09:00:00.000Z"],
    ["spring", "2027-04-15T08:00:00.000Z"],
  ])("accepts the default convocation (%s)", (_season, startIso) => {
    const start = new Date(startIso);
    const milestones = defaultMilestones(AGO, start);
    const codes = checkCalendar(AGO, start, milestones).map(
      (warning) => warning.code,
    );
    expect(codes).not.toContain("short_notice");
  });

  it.each([
    ["autumn", "2026-11-12T09:00:00.000Z"],
    ["spring", "2027-04-15T08:00:00.000Z"],
  ])(
    "accepts a convocation later on the same day (%s)",
    (_season, startIso) => {
      const start = new Date(startIso);
      const milestones = defaultMilestones(AGO, start);
      const later = new Date(milestones.convocation!.getTime() + 5 * 3_600_000);
      const codes = checkCalendar(AGO, start, {
        ...milestones,
        convocation: later,
      }).map((warning) => warning.code);
      expect(codes).not.toContain("short_notice");
    },
  );

  it.each([
    ["autumn", "2026-11-12T09:00:00.000Z"],
    ["spring", "2027-04-15T08:00:00.000Z"],
  ])("warns when the convocation is a day late (%s)", (_season, startIso) => {
    const start = new Date(startIso);
    const milestones = defaultMilestones(AGO, start);
    const late = new Date(milestones.convocation!.getTime() + 24 * 3_600_000);
    const codes = checkCalendar(AGO, start, {
      ...milestones,
      convocation: late,
    }).map((warning) => warning.code);
    expect(codes).toContain("short_notice");
  });

  it("counts the day in Madrid, not in UTC", () => {
    // Start 18 Nov 2026, 00:30 in Madrid (17 Nov in UTC). A convocation on
    // 18 Oct at 01:30 Madrid (17 Oct 23:30 UTC) gives a month's notice.
    const start = new Date("2026-11-17T23:30:00.000Z");
    const codes = checkCalendar(AGO, start, {
      convocation: new Date("2026-10-17T23:30:00.000Z"),
    }).map((warning) => warning.code);
    expect(codes).not.toContain("short_notice");
    const lateCodes = checkCalendar(AGO, start, {
      convocation: new Date("2026-10-18T22:30:00.000Z"),
    }).map((warning) => warning.code);
    expect(lateCodes).toContain("short_notice");
  });
});

describe("checkCalendar counts days and months by calendar day", () => {
  // The 80.ª AGO: starts Wednesday 18 Nov 2026 at 9:00 in Madrid.
  const start = new Date("2026-11-18T08:00:00.000Z");
  const rules = {
    ...AGO,
    minimums: {
      convocation: { months: 1 },
      documents_close: { days: 8 },
      candidacies_close: { hours: 96 },
    },
  };

  it("accepts a convocation on 18 Oct and a close on 10 Nov at any hour", () => {
    const warnings = checkCalendar(rules, start, {
      convocation: new Date("2026-10-18T09:47:03.000Z"), // 11:47 CEST
      documents_close: new Date("2026-11-10T22:59:00.000Z"), // 23:59 CET
    });
    expect(warnings).toEqual([]);
  });

  it("keeps hours exact: 72 hours is short of 96", () => {
    const warnings = checkCalendar(rules, start, {
      candidacies_close: new Date("2026-11-15T08:00:00.000Z"),
    });
    expect(warnings).toMatchObject([
      { code: "below_minimum", keys: ["candidacies_close"] },
    ]);
    expect(
      checkCalendar(rules, start, {
        candidacies_close: new Date("2026-11-14T08:00:00.000Z"),
      }),
    ).toEqual([]);
  });
});

describe("respectsNotice", () => {
  const start = new Date("2026-11-18T08:00:00.000Z");

  it("moves the limit a day only when the date changes", () => {
    const eightDays = { days: 8 };
    expect(
      respectsNotice(new Date("2026-11-10T22:59:00.000Z"), start, eightDays),
    ).toBe(true);
    expect(
      respectsNotice(new Date("2026-11-11T00:00:00.000Z"), start, eightDays),
    ).toBe(false);
  });

  it("is false for an invalid date", () => {
    expect(respectsNotice(new Date(Number.NaN), start, { days: 1 })).toBe(
      false,
    );
  });
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

describe("milestoneOffsetBefore with months", () => {
  it("subtracts a calendar month at the same wall-clock time", () => {
    // 12 Nov 2026, 10:00 CET -> 12 Oct, 10:00 CEST.
    const start = new Date("2026-11-12T09:00:00.000Z");
    expect(iso(milestoneOffsetBefore(start, { months: 1 }))).toBe(
      "2026-10-12T08:00:00.000Z",
    );
  });

  it("clamps a month back from the 31st to the end of February, so the notice is never under a month", () => {
    // 31 Mar 2027, 10:00 CEST -> 28 Feb, 10:00 CET.
    const start = new Date("2027-03-31T08:00:00.000Z");
    expect(iso(milestoneOffsetBefore(start, { months: 1 }))).toBe(
      "2027-02-28T09:00:00.000Z",
    );
  });
});

describe("checkCalendar with configurable rules", () => {
  const start = new Date("2027-04-15T08:00:00.000Z");
  const rules: CalendarRules = {
    defaults: {},
    minimums: {
      convocation: { days: 15 },
      documents_publish: { days: 5 },
      amendments_close: { hours: 72 },
      candidacies_close: { hours: 96 },
    },
    documentsWithConvocationBelow: null,
    regulationWindowDays: null,
  };
  const codes = (warnings: ReturnType<typeof checkCalendar>) =>
    warnings.map((warning) => warning.code);

  it("reads the notice from the rules, not from the assembly type", () => {
    const convocation = milestoneOffsetBefore(start, { days: 14 });
    const warnings = checkCalendar(rules, start, { convocation });
    expect(warnings).toEqual([
      {
        code: "short_notice",
        keys: ["convocation"],
        limit: { days: 15 },
      },
    ]);
    expect(
      codes(checkCalendar({ ...rules, minimums: {} }, start, { convocation })),
    ).toEqual([]);
  });

  it("accepts the amendments close extended to exactly 72 hours", () => {
    const close = new Date(start.getTime() - 72 * 3_600_000);
    expect(
      codes(checkCalendar(rules, start, { amendments_close: close })),
    ).toEqual([]);
  });

  it("warns when the amendments close later than 72 hours before", () => {
    const close = new Date(start.getTime() - 71 * 3_600_000);
    expect(checkCalendar(rules, start, { amendments_close: close })).toEqual([
      {
        code: "below_minimum",
        keys: ["amendments_close"],
        limit: { hours: 72 },
      },
    ]);
  });

  it("warns when documents are published after their minimum", () => {
    const publish = milestoneOffsetBefore(start, { days: 4 });
    expect(
      codes(checkCalendar(rules, start, { documents_publish: publish })),
    ).toEqual(["below_minimum"]);
  });

  it("checks the candidacies against 96 hours", () => {
    const close = new Date(start.getTime() - 48 * 3_600_000);
    const warnings = checkCalendar(rules, start, { candidacies_close: close });
    expect(warnings.map((warning) => warning.keys)).toEqual([
      ["candidacies_close"],
    ]);
  });

  it("ignores minimums of milestones the calendar does not have", () => {
    expect(checkCalendar(rules, start, {})).toEqual([]);
  });

  it.each(["AGO", "AGE", "AGET"] as const)(
    "the initial %s defaults meet the initial minimums",
    (type) => {
      const initial = INITIAL_CALENDAR_RULES[type];
      for (const startIso of [
        "2026-11-12T09:00:00.000Z",
        "2027-03-31T08:00:00.000Z",
      ]) {
        const at = new Date(startIso);
        expect(
          checkCalendar(initial, at, defaultMilestones(initial, at)),
        ).toEqual([]);
      }
    },
  );
});

describe("checkCalendar reform window", () => {
  const start = new Date("2027-04-15T08:00:00.000Z");
  const rules: CalendarRules = {
    defaults: {},
    minimums: {},
    documentsWithConvocationBelow: null,
    regulationWindowDays: 12,
  };
  const milestones = {
    amendments_open: milestoneOffsetBefore(start, { days: 12 }),
    amendments_close: milestoneOffsetBefore(start, { days: 4 }),
  };
  const regulation: CalendarDocument = {
    id: "doc1",
    title: "Reglamento de Becas",
    kind: "regulation",
    amendable: true,
    amendmentsOpenAt: null,
    amendmentsCloseAt: null,
  };

  it("warns when a regulation follows a window shorter than the minimum", () => {
    expect(checkCalendar(rules, start, milestones, [regulation])).toEqual([
      {
        code: "regulation_window_short",
        keys: ["amendments_open", "amendments_close"],
        days: 12,
        document: { id: "doc1", title: "Reglamento de Becas" },
      },
    ]);
  });

  it("accepts a document window of exactly the minimum", () => {
    const own = {
      ...regulation,
      amendmentsOpenAt: milestoneOffsetBefore(start, { days: 16 }),
    };
    expect(checkCalendar(rules, start, milestones, [own])).toEqual([]);
  });

  it("ignores other kinds, non-amendable documents and a null minimum", () => {
    expect(
      checkCalendar(rules, start, milestones, [
        { ...regulation, kind: "resolution" },
        { ...regulation, amendable: false },
      ]),
    ).toEqual([]);
    expect(
      checkCalendar(
        { ...rules, regulationWindowDays: null },
        start,
        milestones,
        [regulation],
      ),
    ).toEqual([]);
  });

  it("applies to statutes too", () => {
    expect(
      checkCalendar(rules, start, milestones, [
        { ...regulation, kind: "statutes" },
      ]).map((warning) => warning.code),
    ).toEqual(["regulation_window_short"]);
  });
});

describe("checkCalendar documents with a short convocation", () => {
  const start = new Date("2027-04-15T08:00:00.000Z");
  const rules: CalendarRules = {
    defaults: {},
    minimums: {},
    documentsWithConvocationBelow: { days: 5 },
    regulationWindowDays: null,
  };
  const convocation = milestoneOffsetBefore(start, { days: 4 });

  it("warns when an assembly convened at 4 days publishes its documents later", () => {
    expect(
      checkCalendar(rules, start, {
        convocation,
        documents_publish: milestoneOffsetBefore(start, { days: 3 }),
      }),
    ).toEqual([
      {
        code: "documents_not_with_convocation",
        keys: ["convocation", "documents_publish"],
        limit: { days: 5 },
      },
    ]);
  });

  it("warns when it has no publication date at all", () => {
    expect(
      checkCalendar(rules, start, { convocation }).map(
        (warning) => warning.code,
      ),
    ).toEqual(["documents_not_with_convocation"]);
  });

  it("accepts documents published with the convocation", () => {
    expect(
      checkCalendar(rules, start, {
        convocation,
        documents_publish: convocation,
      }),
    ).toEqual([]);
  });

  it("does not apply with 5 days of notice or more, or without the rule", () => {
    const onTime = milestoneOffsetBefore(start, { days: 5 });
    expect(checkCalendar(rules, start, { convocation: onTime })).toEqual([]);
    expect(
      checkCalendar({ ...rules, documentsWithConvocationBelow: null }, start, {
        convocation,
      }),
    ).toEqual([]);
  });

  it("the initial AGET rules accept the exceptional 4-day notice only with the documents attached", () => {
    const aget = INITIAL_CALENDAR_RULES.AGET;
    const codes = checkCalendar(aget, start, {
      convocation,
      documents_publish: milestoneOffsetBefore(start, { days: 3 }),
    }).map((warning) => warning.code);
    expect(codes).not.toContain("short_notice");
    expect(codes).toContain("documents_not_with_convocation");
  });
});
