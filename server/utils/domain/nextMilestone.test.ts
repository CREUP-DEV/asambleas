import { describe, expect, it } from "vitest";
import type { MilestoneDto } from "~~/shared/types/api";
import { nextMilestone } from "./assemblies";

const now = new Date("2026-11-09T01:00:00Z");
const list: MilestoneDto[] = [
  { key: "convocation", at: "2026-12-20T09:00:00.000Z", note: null },
  { key: "agenda_final", at: "2027-01-06T09:00:00.000Z", note: null },
  { key: "documents_close", at: "2027-01-12T09:00:00.000Z", note: null },
];

describe("nextMilestone", () => {
  it("is the first date still to come", () => {
    expect(nextMilestone(list, now)?.key).toBe("convocation");
  });

  it("skips the convocation once the assembly is convened", () => {
    expect(nextMilestone(list, now, { convened: true })?.key).toBe(
      "agenda_final",
    );
  });

  it("skips the planned final agenda once it is final", () => {
    expect(
      nextMilestone(list, now, { convened: true, agendaFinal: true })?.key,
    ).toBe("documents_close");
  });
});
