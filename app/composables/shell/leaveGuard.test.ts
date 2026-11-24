import { describe, expect, it } from "vitest";
import { routeUpdateLeavesPage } from "./leaveGuard";

describe("routeUpdateLeavesPage", () => {
  const doc = "/asambleas/80-ago/documentos/res-3";

  it("asks when another document of the assembly opens", () => {
    expect(
      routeUpdateLeavesPage(
        { path: "/asambleas/80-ago/documentos/res-4" },
        { path: doc },
      ),
    ).toBe(true);
  });

  it("never asks when only the query changes", () => {
    // `?enmienda=` replaced as an amendment opens: route.path has no query.
    expect(routeUpdateLeavesPage({ path: doc }, { path: doc })).toBe(false);
  });

  it("asks when another assembly's document opens", () => {
    expect(
      routeUpdateLeavesPage(
        { path: "/asambleas/81-ago/documentos/res-3" },
        { path: doc },
      ),
    ).toBe(true);
  });
});
