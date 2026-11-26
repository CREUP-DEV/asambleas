import { describe, expect, it } from "vitest";
import type { MeWorkNewsDto } from "../types/api";
import {
  countNewNotices,
  dedupeNews,
  isNewNotice,
  newestNoticeAt,
  noticeMoment,
} from "./notices";

const news = (
  id: string,
  over: Partial<MeWorkNewsDto> = {},
): MeWorkNewsDto => ({
  id,
  assembly: { id: "s1", slug: "80-ago", label: "80.ª AGO" },
  document: { id: "d1", slug: "doc", title: "Doc" },
  amendment: { id: "t1", code: "T1", kind: "transactional" },
  ownAmendment: false,
  type: "amendment_validated",
  by: null,
  value: null,
  at: "2026-11-25T12:00:00.000Z",
  ...over,
});

describe("isNewNotice", () => {
  it("is new only after the mark, and always without one", () => {
    const seen = "2026-11-25T12:00:00.000Z";
    expect(isNewNotice("2026-11-25T12:00:00.001Z", seen)).toBe(true);
    expect(isNewNotice(seen, seen)).toBe(false);
    expect(isNewNotice("2026-11-24T12:00:00.000Z", seen)).toBe(false);
    expect(isNewNotice("2026-11-24T12:00:00.000Z", null)).toBe(true);
    expect(isNewNotice("not a date", null)).toBe(false);
  });
});

describe("countNewNotices", () => {
  it("counts the rows the list shows, after the repeats go", () => {
    const rows = dedupeNews([
      news("w", { type: "amendment_withdrawn" }),
      news("r", { type: "acceptance_recorded", value: "rejected" }),
      news("old", {
        amendment: { id: "a2", code: "UPV2", kind: "partial" },
        at: "2026-11-20T09:00:00.000Z",
      }),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["r", "old"]);
    expect(countNewNotices(rows, "2026-11-24T00:00:00.000Z")).toBe(1);
    expect(countNewNotices(rows, null)).toBe(2);
  });
});

describe("newestNoticeAt", () => {
  it("takes the newest moment listed, null for none", () => {
    expect(newestNoticeAt([])).toBeNull();
    expect(
      newestNoticeAt([
        { at: "2026-11-24T10:00:00.000Z" },
        { at: "2026-11-25T10:00:00.000Z" },
        { at: "2026-11-23T10:00:00.000Z" },
      ]),
    ).toBe("2026-11-25T10:00:00.000Z");
  });
});

describe("an answer that reaches the reader after it was recorded", () => {
  // Answered at T1, panel opened at T2 (the mark), answers published at T3.
  const answer = news("p", {
    type: "position_changed",
    value: "accept",
    at: "2026-11-20T09:00:00.000Z",
    visibleAt: "2026-11-25T10:00:00.000Z",
  });
  const mark = "2026-11-22T00:00:00.000Z";

  it("is new from when it reached the reader", () => {
    expect(noticeMoment(answer)).toBe("2026-11-25T10:00:00.000Z");
    expect(countNewNotices([answer], mark)).toBe(1);
  });

  it("is marked seen by the panel that shows it", () => {
    const seen = newestNoticeAt([
      answer,
      news("older", { at: "2026-11-24T10:00:00.000Z" }),
    ]);
    expect(seen).toBe("2026-11-25T10:00:00.000Z");
    expect(countNewNotices([answer], seen)).toBe(0);
  });
});
