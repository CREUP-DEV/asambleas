import { describe, expect, it } from "vitest";
import { liveHeartbeat } from "./sse";

describe("liveHeartbeat", () => {
  it("is a named ping event, never a comment the client cannot see", () => {
    expect(liveHeartbeat(1_234)).toEqual({ event: "ping", data: "1234" });
  });

  it("always carries data, since EventSource drops an event without it", () => {
    expect(String(liveHeartbeat().data).length).toBeGreaterThan(0);
  });
});
