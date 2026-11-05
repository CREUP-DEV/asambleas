import { describe, expect, it } from "vitest";
import { selectMenuLabel } from "./selectMenu";

const items = [
  { label: "PRES · Presidencia", value: "pres" },
  { label: "VDT", value: "vdt" },
];

describe("selectMenuLabel", () => {
  it("names the field and the chosen item", () => {
    expect(selectMenuLabel("Quién lo presenta", items, "pres")).toBe(
      "Quién lo presenta: PRES · Presidencia",
    );
  });

  it("joins every chosen item of a multiple menu", () => {
    expect(selectMenuLabel("Autoría", items, ["pres", "vdt"])).toBe(
      "Autoría: PRES · Presidencia, VDT",
    );
  });

  it("says the placeholder when nothing is chosen", () => {
    expect(selectMenuLabel("Estado", items, [], "Cualquiera")).toBe(
      "Estado: Cualquiera",
    );
    expect(selectMenuLabel("Estado", items, undefined, "Cualquiera")).toBe(
      "Estado: Cualquiera",
    );
    expect(selectMenuLabel("Estado", items, null)).toBe("Estado");
  });

  it("finds items inside groups and skips group labels", () => {
    const grouped = [
      [
        { type: "label", label: "Áreas ejecutivas", value: "group:executive" },
        { label: "VDT", value: "vdt" },
      ],
      [{ label: "PRES · Presidencia", value: "pres" }],
    ];
    expect(selectMenuLabel("Quién lo presenta", grouped, "pres")).toBe(
      "Quién lo presenta: PRES · Presidencia",
    );
    expect(
      selectMenuLabel("Quién lo presenta", grouped, "group:executive"),
    ).toBe("Quién lo presenta");
  });

  it("keeps only the field when the chosen value is not listed yet", () => {
    expect(selectMenuLabel("Quién lo presenta", [], "pres", "Elige")).toBe(
      "Quién lo presenta",
    );
  });
});
