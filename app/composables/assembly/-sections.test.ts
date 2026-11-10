import { describe, expect, it } from "vitest";
import {
  assemblyPath,
  assemblySectionPath,
  groupAssemblySections,
  projectionPath,
  visibleAssemblySections,
  type AssemblySectionAccess,
} from "./-sections";

const NONE: AssemblySectionAccess = {
  validateDocuments: false,
  reviewAmendments: false,
  manage: false,
  moderate: false,
};

const keys = (access: AssemblySectionAccess) =>
  visibleAssemblySections(access).map((section) => section.key);

describe("visibleAssemblySections", () => {
  it("gives a guest the public sections, calendar and projection included", () => {
    expect(keys(NONE)).toEqual([
      "overview",
      "live",
      "agenda",
      "documents",
      "calendar",
      "convocation",
      "projection",
    ]);
  });

  it("adds the validation inbox for whoever validates documents or amendments", () => {
    expect(keys({ ...NONE, reviewAmendments: true })).toContain("validation");
    expect(keys({ ...NONE, reviewAmendments: true })).not.toContain("tracking");
    expect(keys({ ...NONE, validateDocuments: true })).toEqual(
      expect.arrayContaining(["validation", "tracking"]),
    );
  });

  it("adds settings for managers and the session for the Mesa", () => {
    expect(keys({ ...NONE, manage: true })).toContain("settings");
    expect(keys({ ...NONE, manage: true })).not.toContain("session");
    expect(keys({ ...NONE, moderate: true })).toContain("session");
  });

  it("lists every section for the Secretaría, in menu order", () => {
    expect(
      keys({
        validateDocuments: true,
        reviewAmendments: true,
        manage: true,
        moderate: true,
      }),
    ).toEqual([
      "overview",
      "live",
      "agenda",
      "documents",
      "calendar",
      "convocation",
      "validation",
      "tracking",
      "settings",
      "session",
      "projection",
    ]);
  });
});

describe("groupAssemblySections", () => {
  const grouped = (access: AssemblySectionAccess) =>
    groupAssemblySections(visibleAssemblySections(access)).map((group) => [
      group.group,
      group.sections.map((section) => section.key),
    ]);

  it("keeps one list without titles for a guest", () => {
    expect(grouped(NONE)).toEqual([
      [
        null,
        [
          "overview",
          "live",
          "agenda",
          "documents",
          "calendar",
          "convocation",
          "projection",
        ],
      ],
    ]);
  });

  it("groups under Asamblea, Secretaría and Mesa for the Secretaría", () => {
    expect(
      grouped({
        validateDocuments: true,
        reviewAmendments: true,
        manage: true,
        moderate: true,
      }),
    ).toEqual([
      [
        "assembly",
        ["overview", "live", "agenda", "documents", "calendar", "convocation"],
      ],
      ["secretariat", ["validation", "tracking", "settings"]],
      ["mesa", ["session", "projection"]],
    ]);
  });

  it("leaves out the Secretaría group for a moderator", () => {
    expect(
      grouped({ ...NONE, moderate: true }).map(([group]) => group),
    ).toEqual(["assembly", "mesa"]);
  });

  it("returns nothing without sections", () => {
    expect(groupAssemblySections([])).toEqual([]);
  });
});

describe("paths", () => {
  it("builds the section paths", () => {
    expect(assemblyPath("80-ago")).toBe("/asambleas/80-ago");
    expect(assemblyPath("80-ago", "agenda")).toBe(
      "/asambleas/80-ago/orden-del-dia",
    );
    expect(projectionPath("80-ago")).toBe("/proyeccion/80-ago");
    expect(assemblySectionPath("80-ago", "projection")).toBe(
      "/proyeccion/80-ago",
    );
    expect(assemblySectionPath("80-ago", "session")).toBe(
      "/asambleas/80-ago/sesion",
    );
  });
});
