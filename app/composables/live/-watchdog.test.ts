import { describe, expect, it } from "vitest";
import {
  LIVE_RESTORE_FRESH_MS,
  LIVE_RESUME_AFTER_HIDDEN_MS,
  LIVE_SHOW_SILENCE_MS,
  LIVE_STALE_AFTER_MS,
  isLiveStreamStale,
  shouldReopenOnRestore,
  shouldReopenOnShow,
} from "./-watchdog";

const NOW = 1_800_000_000_000;
/** The server's heartbeat period (server/utils/live/sse.ts). */
const HEARTBEAT_MS = 25_000;

describe("isLiveStreamStale", () => {
  const stale = (overrides: Partial<Parameters<typeof isLiveStreamStale>[0]>) =>
    isLiveStreamStale({
      now: NOW,
      lastMessageAt: NOW - LIVE_STALE_AFTER_MS - 1,
      visible: true,
      streaming: true,
      ...overrides,
    });

  it("gives up on a visible stream silent for over a minute", () => {
    expect(stale({})).toBe(true);
  });

  it("leaves a stream that keeps receiving heartbeats", () => {
    expect(stale({ lastMessageAt: NOW - HEARTBEAT_MS })).toBe(false);
    expect(stale({ lastMessageAt: NOW - LIVE_STALE_AFTER_MS })).toBe(false);
  });

  it("never acts on a hidden page nor while waiting to reconnect", () => {
    expect(stale({ visible: false })).toBe(false);
    expect(stale({ streaming: false })).toBe(false);
  });

  it("tolerates two missed heartbeats before giving up", () => {
    expect(LIVE_STALE_AFTER_MS).toBeGreaterThan(2 * HEARTBEAT_MS);
  });
});

describe("shouldReopenOnShow", () => {
  const reopen = (
    overrides: Partial<Parameters<typeof shouldReopenOnShow>[0]>,
  ) =>
    shouldReopenOnShow({
      now: NOW,
      hiddenAt: NOW - 5 * 60_000,
      lastMessageAt: NOW - 5 * 60_000,
      streaming: true,
      ...overrides,
    });

  it("reopens a stream that went silent while the page was hidden", () => {
    expect(reopen({})).toBe(true);
    expect(reopen({ lastMessageAt: NOW - LIVE_SHOW_SILENCE_MS - 1 })).toBe(
      true,
    );
  });

  it("leaves a stream that kept receiving heartbeats while hidden", () => {
    expect(reopen({ lastMessageAt: NOW - HEARTBEAT_MS })).toBe(false);
    expect(reopen({ lastMessageAt: NOW - LIVE_SHOW_SILENCE_MS })).toBe(false);
  });

  it("ignores short hides and pages that were never hidden", () => {
    expect(reopen({ hiddenAt: NOW - LIVE_RESUME_AFTER_HIDDEN_MS })).toBe(false);
    expect(reopen({ hiddenAt: null })).toBe(false);
  });

  it("retries at once when it was waiting to reconnect", () => {
    expect(reopen({ streaming: false, lastMessageAt: NOW - 1_000 })).toBe(true);
  });
});

describe("shouldReopenOnRestore", () => {
  const restore = (
    overrides: Partial<Parameters<typeof shouldReopenOnRestore>[0]>,
  ) =>
    shouldReopenOnRestore({
      persisted: true,
      now: NOW,
      openedAt: NOW - 5 * 60_000,
      ...overrides,
    });

  it("reopens a stream when the page comes back from the browser's cache", () => {
    expect(restore({})).toBe(true);
    expect(restore({ openedAt: null })).toBe(true);
  });

  it("ignores an ordinary page load", () => {
    expect(restore({ persisted: false })).toBe(false);
  });

  it("leaves a stream the visibility handler has just reopened", () => {
    expect(restore({ openedAt: NOW })).toBe(false);
    expect(restore({ openedAt: NOW - LIVE_RESTORE_FRESH_MS })).toBe(false);
    expect(restore({ openedAt: NOW - LIVE_RESTORE_FRESH_MS - 1 })).toBe(true);
  });
});
