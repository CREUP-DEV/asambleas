import { describe, expect, it, vi } from "vitest";
import {
  memberSpokenName,
  spokenNameNeedsDirectory,
  useTouchTapGuard,
} from "./-memberBadge";

describe("memberSpokenName", () => {
  const council = {
    acronym: "CEUEx",
    name: "Consejo de Estudiantes",
    kind: "asociado" as const,
  };

  it("says a council's denomination with its university", () => {
    expect(memberSpokenName(council, " Universidad de Extremadura ")).toBe(
      "Consejo de Estudiantes · Universidad de Extremadura",
    );
  });

  it("says the denomination alone until the university is known", () => {
    expect(memberSpokenName(council)).toBe("Consejo de Estudiantes");
    expect(memberSpokenName(council, null)).toBe("Consejo de Estudiantes");
  });

  it("never gives an office of the CEA a university", () => {
    expect(
      memberSpokenName(
        { acronym: "PRES", name: "Presidencia", kind: "executive" },
        "Universidad de Granada",
      ),
    ).toBe("Presidencia");
  });

  it("says nothing more when the name only repeats the acronym", () => {
    expect(
      memberSpokenName({ acronym: "VDT", name: "VDT", kind: "executive" }),
    ).toBeUndefined();
  });
});

describe("spokenNameNeedsDirectory", () => {
  it("asks for the directory only for a council with an id", () => {
    expect(spokenNameNeedsDirectory({ id: "m1", kind: "asociado" })).toBe(true);
    expect(spokenNameNeedsDirectory({ kind: "asociado" })).toBe(false);
    expect(spokenNameNeedsDirectory({ id: "m1", kind: "sectorial" })).toBe(
      false,
    );
    expect(spokenNameNeedsDirectory({ id: "m1", kind: "executive" })).toBe(
      false,
    );
  });
});

describe("useTouchTapGuard", () => {
  function event(pointerType?: string) {
    return {
      pointerType,
      stopPropagation: vi.fn(),
      preventDefault: vi.fn(),
    };
  }

  it("keeps the click after a tap from reaching the row", () => {
    const guard = useTouchTapGuard();
    guard.pointerdown(event("touch"));
    const click = event();
    guard.click(click);
    expect(click.stopPropagation).toHaveBeenCalled();
    expect(click.preventDefault).toHaveBeenCalled();
  });

  it("lets a mouse click through", () => {
    const guard = useTouchTapGuard();
    guard.pointerdown(event("mouse"));
    const click = event();
    guard.click(click);
    expect(click.stopPropagation).not.toHaveBeenCalled();
    expect(click.preventDefault).not.toHaveBeenCalled();
  });

  it("lets a keyboard click through after a tap was handled", () => {
    const guard = useTouchTapGuard();
    guard.pointerdown(event("touch"));
    guard.click(event());
    const keyboard = event();
    guard.click(keyboard);
    expect(keyboard.stopPropagation).not.toHaveBeenCalled();
  });
});
