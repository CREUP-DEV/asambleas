import { describe, expect, it } from "vitest";
import { DOCUMENT_KINDS } from "~~/shared/constants/domain";
import {
  cardKindGroups,
  containerKindGroups,
  kindAcceptsFile,
  kindCardChoice,
  kindCardValues,
  memberSubmissionKinds,
  OTHER_KIND_CHOICE,
  presenterKindGroups,
} from "./documentKinds";

describe("cardKindGroups", () => {
  it("moves the catch-all type to the end of the rest", () => {
    expect(
      cardKindGroups({ common: ["report", "other"], others: ["minutes"] }),
    ).toEqual({ common: ["report"], others: ["minutes", "other"] });
  });

  it("leaves groups without it as they are", () => {
    const groups = { common: ["report" as const], others: ["other" as const] };
    expect(cardKindGroups(groups)).toBe(groups);
  });

  it("still offers every kind exactly once", () => {
    const { common, others } = cardKindGroups(
      presenterKindGroups({ memberKind: "asociado" }),
    );
    expect([...common, ...others].sort()).toEqual([...DOCUMENT_KINDS].sort());
    expect(common).not.toContain("other");
  });
});

describe("kindCardValues", () => {
  it("ends with the other types' card when there are more types", () => {
    expect(
      kindCardValues({ common: ["report", "other"], others: ["minutes"] }),
    ).toEqual(["report", "other", OTHER_KIND_CHOICE]);
  });

  it("has no such card when every type is a usual one", () => {
    expect(kindCardValues({ common: ["report"], others: [] })).toEqual([
      "report",
    ]);
  });
});

describe("kindCardChoice", () => {
  const groups = presenterKindGroups({ memberKind: "asociado" });

  it("chooses nothing before the user does", () => {
    expect(kindCardChoice(groups, undefined, false)).toBeUndefined();
  });

  it("chooses the card of a usual kind", () => {
    expect(kindCardChoice(groups, "positioning", false)).toBe("positioning");
  });

  it("chooses the other types' card once the user opens it", () => {
    expect(kindCardChoice(groups, "positioning", true)).toBe(OTHER_KIND_CHOICE);
  });

  it("never chooses a card that is not there", () => {
    const usualOnly = { common: ["report" as const], others: [] };
    expect(kindCardChoice(usualOnly, "report", true)).toBe("report");
    expect(kindCardChoice(usualOnly, "minutes", false)).toBeUndefined();
  });

  it("chooses the other types' card for a kind of the rest", () => {
    expect(kindCardChoice(groups, "minutes", false)).toBe(OTHER_KIND_CHOICE);
  });

  it("keeps the other types' card while the user has not chosen one", () => {
    expect(kindCardChoice(groups, undefined, true)).toBe(OTHER_KIND_CHOICE);
  });
});

describe("presenterKindGroups", () => {
  it("puts what councils and sectorials present first", () => {
    const groups = presenterKindGroups({ memberKind: "asociado" });
    expect(groups.common).toEqual([
      "positioning",
      "resolution",
      "internal_motion",
      "report",
      "other",
    ]);
    expect(groups.others).not.toContain("positioning");
    expect(groups.others).toContain("executive_report");
  });

  it("never offers a sectorial an internal motion", () => {
    const groups = presenterKindGroups({ memberKind: "sectorial" });
    expect(groups.common).toEqual([
      "positioning",
      "resolution",
      "report",
      "other",
    ]);
    expect(groups.others).not.toContain("internal_motion");
  });

  it("keeps the current kind of a sectorial's document", () => {
    const groups = presenterKindGroups({
      memberKind: "sectorial",
      current: "internal_motion",
    });
    expect(groups.common).toContain("internal_motion");
  });

  it("puts what CEA areas present first", () => {
    const groups = presenterKindGroups({ memberKind: "executive" });
    expect(groups.common[0]).toBe("executive_report");
    expect(groups.common).toContain("work_plan");
    expect(groups.others).toContain("positioning");
  });

  it("offers every kind exactly once for a structured text", () => {
    for (const memberKind of ["asociado", "executive", null] as const) {
      const { common, others } = presenterKindGroups({ memberKind });
      expect([...common, ...others].sort()).toEqual([...DOCUMENT_KINDS].sort());
    }
  });

  it("offers a PDF only the kinds that take no amendments", () => {
    const { common, others } = presenterKindGroups({
      memberKind: "asociado",
      format: "file",
    });
    const all = [...common, ...others];
    expect(all.every(kindAcceptsFile)).toBe(true);
    expect(all).not.toContain("resolution");
    expect(common).toEqual(["report", "other"]);
  });

  it("keeps the current kind of a PDF even if it takes amendments", () => {
    const { common, others } = presenterKindGroups({
      memberKind: "asociado",
      format: "file",
      current: "resolution",
    });
    expect(common).toContain("resolution");
    expect(others).not.toContain("positioning");
  });

  it("offers only the kinds the agenda item takes", () => {
    const groups = presenterKindGroups({
      memberKind: "asociado",
      accepted: ["resolution", "internal_motion", "minutes"],
    });
    expect(groups.common).toEqual(["resolution", "internal_motion"]);
    expect(groups.others).toEqual(["minutes"]);
  });

  it("never offers a sectorial a motion, even where the item takes it", () => {
    const groups = presenterKindGroups({
      memberKind: "sectorial",
      accepted: ["resolution", "internal_motion"],
    });
    expect(groups).toEqual({ common: ["resolution"], others: [] });
  });

  it("offers every kind where the item names none", () => {
    expect(
      presenterKindGroups({ memberKind: "asociado", accepted: [] }),
    ).toEqual(presenterKindGroups({ memberKind: "asociado" }));
  });
});

describe("memberSubmissionKinds", () => {
  it("is empty for an item that takes no documents", () => {
    expect(
      memberSubmissionKinds(
        { acceptsSubmissions: false, submissionKinds: [] },
        "asociado",
      ),
    ).toEqual([]);
  });

  it("is every kind the member may present where the item names none", () => {
    const item = { acceptsSubmissions: true, submissionKinds: [] };
    expect(memberSubmissionKinds(item, "asociado")).toEqual([
      ...DOCUMENT_KINDS,
    ]);
    expect(memberSubmissionKinds(item, "sectorial")).not.toContain(
      "internal_motion",
    );
  });

  it("leaves a sectorial nothing under an item for motions only", () => {
    const item = {
      acceptsSubmissions: true,
      submissionKinds: ["internal_motion" as const],
    };
    expect(memberSubmissionKinds(item, "sectorial")).toEqual([]);
    expect(memberSubmissionKinds(item, "asociado")).toEqual([
      "internal_motion",
    ]);
  });
});

describe("containerKindGroups", () => {
  it("puts what members present in series first", () => {
    const groups = containerKindGroups();
    expect(groups.common).toEqual([
      "resolution",
      "internal_motion",
      "positioning",
    ]);
    expect([...groups.common, ...groups.others].sort()).toEqual(
      [...DOCUMENT_KINDS].sort(),
    );
  });

  it("shows a chosen kind of the rest with the usual ones", () => {
    const groups = containerKindGroups(["minutes"]);
    expect(groups.common).toEqual([
      "resolution",
      "internal_motion",
      "positioning",
      "minutes",
    ]);
    expect(groups.others).not.toContain("minutes");
  });
});
