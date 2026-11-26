import { describe, expect, it, vi } from "vitest";
import type { LiveEventDto, MeNoticesDto } from "~~/shared/types/api";
import {
  NOTICES_REFRESH_MS,
  createNoticeRefresher,
  laterNoticeMark,
  liveEventDocumentId,
  liveEventsTouchNotices,
  noticesAnnouncement,
  splitNotices,
  withNoticeMark,
} from "./-notices";

const amendmentEvent = (documentId?: string): LiveEventDto => ({
  entityType: "amendment",
  entityId: "am1",
  type: "amendment_published",
  ...(documentId ? { documentId } : {}),
});

describe("liveEventDocumentId", () => {
  it("reads documentId, or a document event's own id", () => {
    expect(liveEventDocumentId(amendmentEvent("d1"))).toBe("d1");
    expect(
      liveEventDocumentId({
        entityType: "document",
        entityId: "d2",
        type: "document_published",
      }),
    ).toBe("d2");
    expect(liveEventDocumentId(amendmentEvent())).toBeNull();
    expect(
      liveEventDocumentId({
        entityType: "assembly",
        entityId: "s1",
        type: "assembly_status_changed",
      }),
    ).toBeNull();
  });
});

describe("liveEventsTouchNotices", () => {
  const docs = { documentIds: ["d1"], assemblyIds: [] };
  const none = { documentIds: [], assemblyIds: [] };
  const mesa = { documentIds: [], assemblyIds: ["s1"] };

  it("lets through only the documents the notices come from", () => {
    expect(liveEventsTouchNotices([amendmentEvent("d1")], docs)).toBe(true);
    expect(liveEventsTouchNotices([amendmentEvent("d9")], docs)).toBe(false);
    expect(
      liveEventsTouchNotices(
        [{ entityType: "document", entityId: "d1", type: "document_voted" }],
        docs,
      ),
    ).toBe(true);
  });

  it("never reads on the room's other events", () => {
    expect(
      liveEventsTouchNotices(
        [
          { entityType: "assembly", entityId: "s1", type: "live_changed" },
          { entityType: "vote", entityId: "v1", type: "vote_recorded" },
        ],
        docs,
      ),
    ).toBe(false);
    expect(liveEventsTouchNotices([], docs)).toBe(false);
  });

  it("reads on a poll and on an amendment event that names no document", () => {
    expect(
      liveEventsTouchNotices(
        [{ entityType: "assembly", entityId: "s1", type: "poll" }],
        docs,
      ),
    ).toBe(true);
    expect(liveEventsTouchNotices([amendmentEvent()], docs)).toBe(true);
  });

  it("never reads with nothing watched", () => {
    expect(
      liveEventsTouchNotices(
        [
          { entityType: "assembly", entityId: "s1", type: "poll" },
          amendmentEvent(),
          amendmentEvent("d1"),
        ],
        none,
      ),
    ).toBe(false);
  });

  it("reads on any document or amendment event of an assembly the Mesa's notices cover", () => {
    expect(liveEventsTouchNotices([amendmentEvent("d9")], mesa, "s1")).toBe(
      true,
    );
    expect(
      liveEventsTouchNotices(
        [{ entityType: "document", entityId: "d9", type: "document_voted" }],
        mesa,
        "s1",
      ),
    ).toBe(true);
    // Not the room's other events, and not another assembly's hub.
    expect(
      liveEventsTouchNotices(
        [{ entityType: "vote", entityId: "v1", type: "vote_recorded" }],
        mesa,
        "s1",
      ),
    ).toBe(false);
    expect(liveEventsTouchNotices([amendmentEvent("d9")], mesa, "s2")).toBe(
      false,
    );
    expect(liveEventsTouchNotices([amendmentEvent("d9")], mesa)).toBe(false);
  });
});

/** A refresher on a hand-moved clock and hand-run timers. */
function harness(
  options: { hasData?: boolean; watch?: string[]; assemblies?: string[] } = {},
) {
  let clock = 1_000_000;
  let data = options.hasData ?? false;
  const timers: { run: () => void; at: number }[] = [];
  const run = vi.fn(async () => {
    data = true;
  });
  const refresher = createNoticeRefresher({
    run,
    hasData: () => data,
    watch: () => ({
      documentIds: options.watch ?? ["d1"],
      assemblyIds: options.assemblies ?? [],
    }),
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer = { run: fn, at: clock + ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer as (typeof timers)[number]);
      if (index !== -1) timers.splice(index, 1);
    },
  });
  return {
    refresher,
    run,
    timers,
    advance(ms: number) {
      clock += ms;
      for (const timer of [...timers]) {
        if (timer.at <= clock) {
          timers.splice(timers.indexOf(timer), 1);
          timer.run();
        }
      }
    },
  };
}

describe("createNoticeRefresher", () => {
  it("reads at once without a list, then at most every 30 s", async () => {
    const { refresher, run, advance } = harness();
    await refresher.request();
    expect(run).toHaveBeenCalledTimes(1);
    advance(NOTICES_REFRESH_MS - 1);
    await refresher.request();
    expect(run).toHaveBeenCalledTimes(1);
    advance(1);
    await refresher.request();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("joins a read on its way", async () => {
    const { refresher, run } = harness();
    const first = refresher.request();
    const second = refresher.request();
    await Promise.all([first, second]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("ignores live events about documents it does not watch", async () => {
    const { refresher, run, timers } = harness({ hasData: true });
    refresher.live([amendmentEvent("d9")]);
    expect(run).not.toHaveBeenCalled();
    expect(timers).toEqual([]);
  });

  it("still waits for the interval on the Mesa's live events", async () => {
    const { refresher, run, timers, advance } = harness({
      watch: [],
      assemblies: ["s1"],
    });
    await refresher.request();
    advance(10_000);
    // Any amendment of the assembly, but one read per interval.
    refresher.live([amendmentEvent("d7")], "s1");
    refresher.live([amendmentEvent("d8")], "s1");
    expect(run).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(1);
    advance(NOTICES_REFRESH_MS - 10_000);
    expect(run).toHaveBeenCalledTimes(2);
    // Another assembly's hub: nothing.
    advance(NOTICES_REFRESH_MS);
    refresher.live([amendmentEvent("d7")], "s2");
    expect(run).toHaveBeenCalledTimes(2);
    expect(timers).toEqual([]);
  });

  it("reads once at the end of the interval for a live event inside it", async () => {
    const { refresher, run, timers, advance } = harness();
    await refresher.request();
    advance(10_000);
    refresher.live([amendmentEvent("d1")]);
    refresher.live([amendmentEvent("d1")]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(1);
    advance(NOTICES_REFRESH_MS - 10_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(timers).toEqual([]);
  });

  it("reads at once on a live event past the interval", async () => {
    const { refresher, run, timers, advance } = harness();
    await refresher.request();
    advance(NOTICES_REFRESH_MS);
    refresher.live([amendmentEvent("d1")]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(timers).toEqual([]);
  });

  it("drops the waiting read when another starts or on dispose", async () => {
    const { refresher, run, timers, advance } = harness();
    await refresher.request();
    advance(1_000);
    refresher.live([amendmentEvent("d1")]);
    expect(timers).toHaveLength(1);
    await refresher.force();
    expect(run).toHaveBeenCalledTimes(2);
    expect(timers).toEqual([]);
    advance(1_000);
    refresher.live([amendmentEvent("d1")]);
    expect(timers).toHaveLength(1);
    refresher.dispose();
    expect(timers).toEqual([]);
  });

  it("swallows a failed read and allows the next after the interval", async () => {
    const { refresher, run, advance } = harness();
    run.mockRejectedValueOnce(new Error("offline"));
    await expect(refresher.request()).resolves.toBeUndefined();
    advance(NOTICES_REFRESH_MS);
    await refresher.request();
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("noticesAnnouncement", () => {
  it("speaks only when the count rises with the page open", () => {
    // The first read is no news.
    expect(noticesAnnouncement(null, 3)).toBeNull();
    expect(noticesAnnouncement(1, 3)).toBe(3);
    expect(noticesAnnouncement(3, 3)).toBeNull();
    // Opening the panel, or another tab, lowered it.
    expect(noticesAnnouncement(3, 0)).toBeNull();
    expect(noticesAnnouncement(0, 1)).toBe(1);
  });
});

describe("splitNotices", () => {
  const items = [
    { key: "c", at: "2026-11-25T12:00:00Z" },
    { key: "b", at: "2026-11-25T10:00:00Z" },
    { key: "a", at: "2026-11-24T10:00:00Z" },
  ];

  it("keeps as new what came after the mark the panel opened with", () => {
    const { fresh, earlier } = splitNotices(items, "2026-11-25T10:00:00Z");
    expect(fresh.map((item) => item.key)).toEqual(["c"]);
    expect(earlier.map((item) => item.key)).toEqual(["b", "a"]);
  });

  it("calls everything new without a mark", () => {
    expect(splitNotices(items, null).fresh).toHaveLength(3);
  });

  it("puts an answer under «Nuevos» by when it reached the reader", () => {
    const answer = {
      key: "p",
      at: "2026-11-20T09:00:00Z",
      visibleAt: "2026-11-25T11:00:00Z",
    };
    const { fresh } = splitNotices([answer], "2026-11-25T10:00:00Z");
    expect(fresh.map((item) => item.key)).toEqual(["p"]);
  });
});

describe("withNoticeMark", () => {
  const list = (seenAt: string | null): MeNoticesDto => {
    const items = [
      { at: "2026-11-25T12:00:00.000Z" },
      { at: "2026-11-25T10:00:00.000Z" },
    ] as MeNoticesDto["items"];
    return {
      items,
      seenAt,
      unread: 2,
      watchDocumentIds: [],
      watchAssemblyIds: [],
    };
  };

  it("keeps the mark this tab wrote over an older one a read brings back", () => {
    const merged = withNoticeMark(
      list("2026-11-24T00:00:00.000Z"),
      "2026-11-25T12:00:00.000Z",
    );
    expect(merged.seenAt).toBe("2026-11-25T12:00:00.000Z");
    expect(merged.unread).toBe(0);
  });

  it("still counts a notice later than that mark", () => {
    const merged = withNoticeMark(list(null), "2026-11-25T11:00:00.000Z");
    expect(merged.unread).toBe(1);
  });

  it("leaves a list whose mark is as late or later as it is", () => {
    const fresh = list("2026-11-25T12:00:00.000Z");
    expect(withNoticeMark(fresh, "2026-11-25T10:00:00.000Z")).toBe(fresh);
    expect(withNoticeMark(fresh, null)).toBe(fresh);
  });
});

describe("laterNoticeMark", () => {
  it("takes the later mark, either when the other is missing", () => {
    const early = "2026-11-24T00:00:00.000Z";
    const late = "2026-11-25T00:00:00.000Z";
    expect(laterNoticeMark(early, late)).toBe(late);
    expect(laterNoticeMark(late, early)).toBe(late);
    expect(laterNoticeMark(null, early)).toBe(early);
    expect(laterNoticeMark(early, null)).toBe(early);
    expect(laterNoticeMark(null, null)).toBeNull();
  });
});
