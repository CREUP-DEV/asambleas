import { describe, expect, it } from "vitest";
import type { NavigationMenuItem } from "@nuxt/ui";
import { namedWhenCollapsed } from "./-navigation";

const items: NavigationMenuItem[] = [
  { type: "label", label: "80.ª AGO" },
  { label: "Resumen", icon: "i-lucide-house", to: "/asambleas/80-ago" },
  {
    label: "En directo",
    to: "/asambleas/80-ago/en-directo",
    "aria-label": "En directo, en sesión ahora",
  },
];

describe("namedWhenCollapsed", () => {
  it("names every link by its label when the sidebar is folded", () => {
    const named = namedWhenCollapsed(items, true);
    expect(named[1]).toMatchObject({
      label: "Resumen",
      "aria-label": "Resumen",
    });
  });

  it("keeps a name the item already carries", () => {
    const named = namedWhenCollapsed(items, true);
    expect(named[2]!["aria-label"]).toBe("En directo, en sesión ahora");
  });

  it("leaves the group titles alone", () => {
    const named = namedWhenCollapsed(items, true);
    expect(named[0]).toBe(items[0]);
    expect(named[0]).not.toHaveProperty("aria-label");
  });

  it("changes nothing when the sidebar is unfolded", () => {
    expect(namedWhenCollapsed(items, false)).toBe(items);
  });

  it("does not change the items it is given", () => {
    namedWhenCollapsed(items, true);
    expect(items[1]).not.toHaveProperty("aria-label");
  });
});
