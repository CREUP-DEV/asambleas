import { beforeEach, describe, expect, it } from "vitest";
import {
  CONTROL_GRACE_MS,
  CONTROL_TTL_MS,
  beatConsole,
  isController,
  leaveConsole,
  resetProjectionControl,
  takeControl,
} from "./projectionControl";

const tab = (userId: string, tabId: string) => ({
  userId,
  tabId,
  name: `Name ${userId}`,
});

describe("projection control", () => {
  beforeEach(() => resetProjectionControl());

  it("gives control to the first console that beats", () => {
    const first = beatConsole("a", tab("ana", "t1"), 1_000);
    expect(first.change).toBe("first");
    expect(first.holder?.tabId).toBe("t1");

    const second = beatConsole("a", tab("luis", "t2"), 2_000);
    expect(second.change).toBeNull();
    expect(second.holder?.tabId).toBe("t1");
    expect(second.consoles).toBe(2);
    expect(isController("a", tab("ana", "t1"), 2_000)).toBe(true);
    expect(isController("a", tab("luis", "t2"), 2_000)).toBe(false);
  });

  it("tells apart two tabs of the same account", () => {
    beatConsole("a", tab("mesa", "one"), 1_000);
    beatConsole("a", tab("mesa", "two"), 2_000);
    expect(isController("a", tab("mesa", "one"), 2_000)).toBe(true);
    expect(isController("a", tab("mesa", "two"), 2_000)).toBe(false);
  });

  it("lets a console that came later take control at any time", () => {
    beatConsole("a", tab("ana", "t1"), 1_000);
    beatConsole("a", tab("luis", "t2"), 2_000);
    const taken = takeControl("a", tab("luis", "t2"), 3_000);
    expect(taken.change).toBe("taken");
    expect(taken.previous?.tabId).toBe("t1");
    expect(taken.holder?.tabId).toBe("t2");
    expect(isController("a", tab("ana", "t1"), 3_000)).toBe(false);
    // Taking it again changes nothing.
    expect(takeControl("a", tab("luis", "t2"), 4_000).change).toBeNull();
  });

  it("hands control to the console open longest when the holder goes silent", () => {
    beatConsole("a", tab("ana", "t1"), 0);
    beatConsole("a", tab("luis", "t2"), 1_000);
    beatConsole("a", tab("eva", "t3"), 2_000);
    const half = CONTROL_TTL_MS / 2;
    beatConsole("a", tab("luis", "t2"), half);
    beatConsole("a", tab("eva", "t3"), half);
    const late = CONTROL_TTL_MS + 5_000;
    // The holder stops controlling as soon as it is stale, before any beat.
    expect(isController("a", tab("ana", "t1"), late)).toBe(false);
    // Whichever console beats next, the one open longest gets it.
    const handed = beatConsole("a", tab("eva", "t3"), late);
    expect(handed.change).toBe("handed");
    expect(handed.previous?.tabId).toBe("t1");
    expect(handed.holder?.tabId).toBe("t2");
  });

  it("keeps control through a reload of the holder's tab", () => {
    beatConsole("a", tab("ana", "t1"), 1_000);
    beatConsole("a", tab("luis", "t2"), 2_000);
    const left = leaveConsole("a", tab("ana", "t1"), 3_000);
    expect(left.change).toBeNull();
    expect(left.holder?.tabId).toBe("t1");
    // The same tab beats again within the grace: nothing changed.
    const back = beatConsole("a", tab("ana", "t1"), 3_000 + CONTROL_GRACE_MS);
    expect(back.change).toBeNull();
    expect(isController("a", tab("ana", "t1"), 3_000 + CONTROL_GRACE_MS)).toBe(
      true,
    );
  });

  it("passes control on once a holder that left is past its grace", () => {
    beatConsole("a", tab("ana", "t1"), 1_000);
    beatConsole("a", tab("luis", "t2"), 2_000);
    leaveConsole("a", tab("ana", "t1"), 3_000);
    const after = beatConsole(
      "a",
      tab("luis", "t2"),
      3_000 + CONTROL_GRACE_MS + 1,
    );
    expect(after.change).toBe("handed");
    expect(after.holder?.tabId).toBe("t2");
    expect(after.consoles).toBe(1);
  });

  it("drops any other console that leaves at once", () => {
    beatConsole("a", tab("ana", "t1"), 1_000);
    beatConsole("a", tab("luis", "t2"), 2_000);
    const left = leaveConsole("a", tab("luis", "t2"), 3_000);
    expect(left.consoles).toBe(1);
    expect(left.holder?.tabId).toBe("t1");
  });

  it("hands control to the next console to open when every one had gone", () => {
    beatConsole("a", tab("ana", "t1"), 1_000);
    leaveConsole("a", tab("ana", "t1"), 2_000);
    const later = 2_000 + CONTROL_GRACE_MS + 1;
    expect(isController("a", tab("ana", "t1"), later)).toBe(false);
    const next = beatConsole("a", tab("luis", "t2"), later);
    expect(next.change).toBe("handed");
    expect(next.holder?.tabId).toBe("t2");
  });

  it("lets the console that receives control record it, once", () => {
    const first = beatConsole("a", tab("ana", "t1"), 1_000);
    expect(first.announce).toBe("first");
    expect(beatConsole("a", tab("ana", "t1"), 2_000).announce).toBeNull();
    beatConsole("a", tab("luis", "t2"), 2_000);
    beatConsole("a", tab("eva", "t3"), 3_000);
    leaveConsole("a", tab("ana", "t1"), 4_000);
    // Eva's beat hands control to Luis (open longer), but Luis records it.
    const after = 4_000 + CONTROL_GRACE_MS + 1;
    const byEva = beatConsole("a", tab("eva", "t3"), after);
    expect(byEva.change).toBe("handed");
    expect(byEva.announce).toBeNull();
    expect(beatConsole("a", tab("luis", "t2"), after + 1).announce).toBe(
      "handed",
    );
    expect(takeControl("a", tab("eva", "t3"), after + 2).announce).toBe(
      "taken",
    );
  });

  it("keeps each assembly apart", () => {
    beatConsole("a", tab("ana", "t1"), 1_000);
    beatConsole("b", tab("ana", "t9"), 1_000);
    expect(isController("a", tab("ana", "t9"), 1_000)).toBe(false);
    expect(isController("b", tab("ana", "t9"), 1_000)).toBe(true);
  });
});
