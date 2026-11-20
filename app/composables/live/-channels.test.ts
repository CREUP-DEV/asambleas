import { describe, expect, it } from "vitest";
import { liveChannels } from "./-channels";

describe("liveChannels", () => {
  const handler = () => undefined;

  it("asks only for the pushes the page handles", () => {
    expect(liveChannels({})).toBe("");
    expect(liveChannels({ onScroll: handler })).toBe("scroll");
    expect(
      liveChannels({ onScroll: handler, onPointer: handler, onTally: handler }),
    ).toBe("scroll,pointer,tally");
  });
});
