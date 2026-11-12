import { describe, expect, it } from "vitest";
import { composerRouteUpdateLeaves } from "./composerLeave";

describe("composerRouteUpdateLeaves", () => {
  const doc = "/asambleas/80-ago/documentos/res-3";

  it("asks when another document of the assembly opens", () => {
    expect(
      composerRouteUpdateLeaves(
        { path: "/asambleas/80-ago/documentos/res-4" },
        { path: doc },
      ),
    ).toBe(true);
  });

  it("never asks when only the query changes", () => {
    // `?enmienda=` replaced as an amendment opens: route.path has no query.
    expect(composerRouteUpdateLeaves({ path: doc }, { path: doc })).toBe(false);
  });

  it("asks when another assembly's document opens", () => {
    expect(
      composerRouteUpdateLeaves(
        { path: "/asambleas/81-ago/documentos/res-3" },
        { path: doc },
      ),
    ).toBe(true);
  });
});
