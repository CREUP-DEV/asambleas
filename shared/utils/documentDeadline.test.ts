import { describe, expect, it } from "vitest";
import type { MilestoneKey } from "../constants/domain";
import {
  closesForMembers,
  closingPresentationSchedule,
  documentDeadlineKey,
  lateAfterAt,
  lateNeedsAssembly,
  presentationDeadlineAt,
  presentationDeadlinePassed,
  presentationSchedule,
  sentAfterDeadline,
} from "./documentDeadline";

const MILESTONES: Partial<Record<MilestoneKey, string>> = {
  documents_close: "2026-11-10T22:59:00.000Z",
  candidacies_close: "2026-11-15T10:00:00.000Z",
};
const at = (milestones: Partial<Record<MilestoneKey, string>>) => {
  return (key: MilestoneKey) => milestones[key];
};

describe("documentDeadlineKey", () => {
  it("gives each kind its milestone", () => {
    expect(documentDeadlineKey("resolution")).toBe("documents_close");
    expect(documentDeadlineKey("report")).toBe("reports_close");
    expect(documentDeadlineKey("executive_report")).toBe("documents_close");
    expect(documentDeadlineKey("candidacy")).toBe("candidacies_close");
    expect(documentDeadlineKey("venue")).toBe("candidacies_close");
  });
});

describe("sentAfterDeadline", () => {
  const afterDocuments = "2026-11-12T10:00:00.000Z";

  it("marks a document sent after documents_close", () => {
    expect(
      sentAfterDeadline(
        { kind: "resolution", submittedAt: afterDocuments },
        at(MILESTONES),
      ),
    ).toBe(true);
    expect(
      sentAfterDeadline(
        { kind: "resolution", submittedAt: "2026-11-09T10:00:00.000Z" },
        at(MILESTONES),
      ),
    ).toBe(false);
  });

  it("never marks a report by documents_close", () => {
    expect(
      sentAfterDeadline(
        { kind: "report", submittedAt: afterDocuments },
        at(MILESTONES),
      ),
    ).toBe(false);
  });

  it("marks a report sent after its own deadline", () => {
    const milestones = {
      ...MILESTONES,
      reports_close: "2026-11-11T22:59:00.000Z",
    };
    expect(
      sentAfterDeadline(
        { kind: "report", submittedAt: afterDocuments },
        at(milestones),
      ),
    ).toBe(true);
    expect(
      sentAfterDeadline(
        { kind: "report", submittedAt: "2026-11-11T10:00:00.000Z" },
        at(milestones),
      ),
    ).toBe(false);
  });

  it("never marks a document not sent yet", () => {
    expect(
      sentAfterDeadline(
        { kind: "resolution", submittedAt: null },
        at(MILESTONES),
      ),
    ).toBe(false);
  });
});

describe("presentationDeadlinePassed", () => {
  // Between documents_close (T-8) and candidacies_close (T-96 h).
  const between = "2026-11-12T10:00:00.000Z";

  it("closes a resolution at documents_close", () => {
    expect(
      presentationDeadlinePassed("resolution", at(MILESTONES), between),
    ).toBe(true);
    expect(
      presentationDeadlinePassed(
        "resolution",
        at(MILESTONES),
        "2026-11-09T10:00:00.000Z",
      ),
    ).toBe(false);
  });

  it("keeps candidacies and venues open until candidacies_close", () => {
    expect(
      presentationDeadlinePassed("candidacy", at(MILESTONES), between),
    ).toBe(false);
    expect(presentationDeadlinePassed("venue", at(MILESTONES), between)).toBe(
      false,
    );
    expect(
      presentationDeadlinePassed(
        "candidacy",
        at(MILESTONES),
        "2026-11-15T10:01:00.000Z",
      ),
    ).toBe(true);
  });

  it("takes the deadline's own minute as on time", () => {
    // After DEADLINE_MINUTE_COUNTS_SINCE, when that rule applies.
    const close = { documents_close: "2026-12-10T22:59:00.000Z" };
    expect(
      presentationDeadlinePassed(
        "resolution",
        at(close),
        "2026-12-10T22:59:59.000Z",
      ),
    ).toBe(false);
    expect(
      presentationDeadlinePassed(
        "resolution",
        at(close),
        "2026-12-10T23:00:00.000Z",
      ),
    ).toBe(true);
  });

  it("falls back on documents_close without the kind's own deadline", () => {
    // An AGET has no candidacies_close.
    const aget = { documents_close: MILESTONES.documents_close };
    expect(presentationDeadlinePassed("candidacy", at(aget), between)).toBe(
      true,
    );
    expect(presentationDeadlinePassed("resolution", at({}), between)).toBe(
      false,
    );
  });

  it("never closes a report, past reports_close or documents_close", () => {
    const milestones = {
      ...MILESTONES,
      reports_close: "2026-11-11T22:59:00.000Z",
    };
    const afterAll = "2026-11-20T10:00:00.000Z";
    expect(presentationDeadlinePassed("report", at(milestones), afterAll)).toBe(
      false,
    );
    // Without reports_close it does not fall back on documents_close.
    expect(presentationDeadlinePassed("report", at(MILESTONES), afterAll)).toBe(
      false,
    );
    expect(presentationDeadlineAt("report", at(milestones))).toBeNull();
  });
});

describe("closesForMembers", () => {
  it("leaves only reports open for good", () => {
    expect(closesForMembers("report")).toBe(false);
    expect(closesForMembers("executive_report")).toBe(true);
    expect(closesForMembers("resolution")).toBe(true);
    expect(closesForMembers("candidacy")).toBe(true);
  });
});

describe("lateAfterAt", () => {
  it("reads the kind's own deadline, with no fallback", () => {
    const milestones = {
      ...MILESTONES,
      reports_close: "2026-11-11T22:59:00.000Z",
    };
    expect(lateAfterAt("report", at(milestones))).toBe(
      milestones.reports_close,
    );
    expect(lateAfterAt("report", at(MILESTONES))).toBeNull();
    expect(lateAfterAt("resolution", at(MILESTONES))).toBe(
      MILESTONES.documents_close,
    );
    expect(lateAfterAt("candidacy", at({ documents_close: "x" }))).toBeNull();
  });
});

describe("presentationSchedule", () => {
  const between = "2026-11-12T10:00:00.000Z";

  it("counts down to the nearest deadline still ahead", () => {
    expect(
      presentationSchedule(at(MILESTONES), "2026-11-09T10:00:00.000Z"),
    ).toEqual({
      open: true,
      next: MILESTONES.documents_close,
      last: MILESTONES.candidacies_close,
    });
    // Past documents_close, candidacies still go: open until theirs.
    expect(presentationSchedule(at(MILESTONES), between)).toEqual({
      open: true,
      next: MILESTONES.candidacies_close,
      last: MILESTONES.candidacies_close,
    });
  });

  it("closes once every kind is past its deadline", () => {
    expect(
      presentationSchedule(at(MILESTONES), "2026-11-15T10:01:00.000Z", [
        "resolution",
        "candidacy",
      ]),
    ).toEqual({ open: false, next: null, last: MILESTONES.candidacies_close });
  });

  it("never closes with reports among the kinds", () => {
    const milestones = {
      ...MILESTONES,
      reports_close: "2026-11-11T22:59:00.000Z",
    };
    // Every kind: reports keep it open, and reports_close is no deadline.
    expect(
      presentationSchedule(at(milestones), "2026-11-15T10:01:00.000Z"),
    ).toEqual({ open: true, next: null, last: MILESTONES.candidacies_close });
    expect(
      presentationSchedule(at(milestones), "2026-11-09T10:00:00.000Z", [
        "report",
      ]),
    ).toEqual({ open: true, next: null, last: null });
  });

  it("reads only the kinds that close in closingPresentationSchedule", () => {
    const milestones = {
      ...MILESTONES,
      reports_close: "2026-11-11T22:59:00.000Z",
    };
    // Every kind, as a manager reads it: closed past candidacies_close,
    // though reports still go in.
    expect(
      closingPresentationSchedule(at(milestones), "2026-11-15T10:01:00.000Z"),
    ).toEqual({ open: false, next: null, last: MILESTONES.candidacies_close });
    // Open until then, counting down to the nearest deadline ahead.
    expect(
      closingPresentationSchedule(at(milestones), "2026-11-09T10:00:00.000Z"),
    ).toEqual({
      open: true,
      next: MILESTONES.documents_close,
      last: MILESTONES.candidacies_close,
    });
    // A member presenting resolutions and reports: closed past
    // documents_close.
    expect(
      closingPresentationSchedule(at(milestones), "2026-11-12T10:00:00.000Z", [
        "resolution",
        "report",
      ]),
    ).toEqual({ open: false, next: null, last: MILESTONES.documents_close });
    // Only reports: no deadline to state, never closed.
    expect(
      closingPresentationSchedule(at(milestones), "2026-11-15T10:01:00.000Z", [
        "report",
      ]),
    ).toEqual({ open: true, next: null, last: null });
  });

  it("reads only the kinds given, as a member's own", () => {
    // A member presenting only resolutions: past documents_close it is
    // closed, though candidacies still go.
    expect(
      presentationSchedule(at(MILESTONES), "2026-11-09T10:00:00.000Z", [
        "resolution",
      ]),
    ).toEqual({
      open: true,
      next: MILESTONES.documents_close,
      last: MILESTONES.documents_close,
    });
    expect(
      presentationSchedule(at(MILESTONES), between, ["resolution"]),
    ).toEqual({ open: false, next: null, last: MILESTONES.documents_close });
    // A member presenting only candidacies counts down to theirs.
    expect(
      presentationSchedule(at(MILESTONES), "2026-11-09T10:00:00.000Z", [
        "candidacy",
      ]),
    ).toEqual({
      open: true,
      next: MILESTONES.candidacies_close,
      last: MILESTONES.candidacies_close,
    });
  });

  it("stays open without any deadline", () => {
    expect(presentationSchedule(at({}), between)).toEqual({
      open: true,
      next: null,
      last: null,
    });
  });
});

describe("lateNeedsAssembly", () => {
  it("never asks the assembly about a report", () => {
    expect(lateNeedsAssembly("report")).toBe(false);
    expect(lateNeedsAssembly("resolution")).toBe(true);
    expect(lateNeedsAssembly("internal_motion")).toBe(true);
  });
});
