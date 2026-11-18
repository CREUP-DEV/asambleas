import { describe, expect, it } from "vitest";
import type { MilestoneKey } from "../constants/domain";
import {
  documentDeadlineKey,
  lateNeedsAssembly,
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

describe("lateNeedsAssembly", () => {
  it("never asks the assembly about a report", () => {
    expect(lateNeedsAssembly("report")).toBe(false);
    expect(lateNeedsAssembly("resolution")).toBe(true);
    expect(lateNeedsAssembly("internal_motion")).toBe(true);
  });
});
