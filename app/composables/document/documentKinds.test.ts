import { describe, expect, it } from "vitest";
import { DOCUMENT_KINDS } from "~~/shared/constants/domain";
import {
  kindAcceptsFile,
  kindSelectItems,
  presenterKindGroups,
} from "./documentKinds";

const HEADINGS = { common: "Common", others: "Others" };

describe("kindSelectItems", () => {
  it("heads each group when there are two", () => {
    const items = kindSelectItems(
      { common: ["report"], others: ["minutes"] },
      (kind) => kind.toUpperCase(),
      HEADINGS,
    );
    expect(items).toEqual([
      [
        { type: "label", label: "Common" },
        { label: "REPORT", value: "report" },
      ],
      [
        { type: "label", label: "Others" },
        { label: "MINUTES", value: "minutes" },
      ],
    ]);
  });

  it("drops empty groups and the heading of a lone group", () => {
    const items = kindSelectItems(
      { common: [], others: ["minutes"] },
      (kind) => kind,
      HEADINGS,
    );
    expect(items).toEqual([[{ label: "minutes", value: "minutes" }]]);
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
});
