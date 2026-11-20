import { describe, expect, it, vi } from "vitest";
import {
  LIVE_PUSH_CHANNELS,
  liveHeartbeat,
  livePushChannels,
  serializeOnce,
} from "./sse";

describe("liveHeartbeat", () => {
  it("is a named ping event, never a comment the client cannot see", () => {
    expect(liveHeartbeat(1_234)).toEqual({ event: "ping", data: "1234" });
  });

  it("always carries data, since EventSource drops an event without it", () => {
    expect(String(liveHeartbeat().data).length).toBeGreaterThan(0);
  });
});

describe("serializeOnce", () => {
  it("serializes a value once, whatever the number of streams", () => {
    const value = { documentId: "d1", anchor: { blockId: "b1" } };
    const serialize = vi.fn((item: typeof value) => ({ id: item.documentId }));
    const first = serializeOnce(value, serialize);
    expect(serializeOnce(value, serialize)).toBe(first);
    expect(first).toBe('{"id":"d1"}');
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(serializeOnce({ a: 1 })).toBe('{"a":1}');
  });
});

describe("livePushChannels", () => {
  it("sends every push to a page that names none (older code)", () => {
    expect([...livePushChannels(undefined)]).toEqual([...LIVE_PUSH_CHANNELS]);
  });

  it("sends only what the page asked for", () => {
    expect([...livePushChannels("")]).toEqual([]);
    expect([...livePushChannels("scroll")]).toEqual(["scroll"]);
    expect([...livePushChannels("tally,pointer,bogus")]).toEqual([
      "pointer",
      "tally",
    ]);
  });
});
