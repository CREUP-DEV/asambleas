import { describe, expect, it, vi } from "vitest";
import type {
  AmendmentDto,
  DocumentAmendmentsDto,
  LiveEventDto,
  PartialDocumentAmendmentsDto,
} from "~~/shared/types/api";
import { PARTIAL_AMENDMENTS_MAX } from "~~/shared/utils/partialAmendments";
import { amendmentsRefetchPlan } from "../assembly/-liveFilters";
import {
  mergePartialAmendments,
  partialAmendmentsRefetch,
  type PartialAmendmentsRefetchOptions,
} from "./partialAmendments";

/** Only the fields the merge reads; the rest is carried as is. */
function amendment(
  id: string,
  extra: Partial<AmendmentDto> = {},
): AmendmentDto {
  return {
    id,
    documentId: "doc",
    positionKey: 0,
    number: null,
    status: "submitted",
    ...extra,
  } as AmendmentDto;
}

function list(
  amendments: AmendmentDto[],
  extra: Partial<DocumentAmendmentsDto> = {},
): DocumentAmendmentsDto {
  return {
    amendments,
    relations: [],
    wordings: [],
    baseVersionId: "v1",
    ...extra,
  };
}

function partial(
  amendments: AmendmentDto[],
  gone: string[] = [],
  baseVersionId: string | null = "v1",
): PartialDocumentAmendmentsDto {
  return { amendments, gone, baseVersionId };
}

const ev = (
  entityType: string,
  type: string,
  entityId: string,
  documentId?: string,
): LiveEventDto => ({
  entityType,
  type,
  entityId,
  ...(documentId ? { documentId } : {}),
});

describe("mergePartialAmendments", () => {
  // Text order, as listDocumentAmendments sends it.
  const a = amendment("a", { positionKey: 1, number: 1 });
  const b = amendment("b", { positionKey: 2, number: 2 });
  const c = amendment("c", { positionKey: 3, number: 3 });
  const current = list([a, b, c], {
    relations: [
      {
        id: "r1",
        fromId: "a",
        toId: "c",
        kind: "incompatible",
        note: null,
        createdAt: "2026-11-01T10:00:00.000Z",
      },
    ],
  });

  it("replaces each amendment where it stands, keeping the rest", () => {
    const approved = { ...b, status: "approved" as const };
    const lapsed = { ...c, status: "lapsed" as const };
    const merged = mergePartialAmendments(current, partial([lapsed, approved]));
    expect(merged?.amendments).toEqual([a, approved, lapsed]);
    expect(merged?.relations).toBe(current.relations);
    expect(merged?.wordings).toBe(current.wordings);
    expect(merged?.baseVersionId).toBe("v1");
  });

  it("is what a fresh full list would be", () => {
    const approved = { ...a, status: "approved" as const };
    const fresh = list([approved, b, c], { relations: current.relations });
    expect(mergePartialAmendments(current, partial([approved]))).toEqual(fresh);
  });

  it("never touches the list it merges into", () => {
    const before = [...current.amendments];
    mergePartialAmendments(current, partial([{ ...a, status: "rejected" }]));
    expect(current.amendments).toEqual(before);
  });

  it("asks for the whole list when an asked one it never had is gone", () => {
    // What reads it (a transactional over it) may not have been sent.
    expect(
      mergePartialAmendments(current, partial([b], ["hidden"])),
    ).toBeNull();
  });

  it("asks for the whole list when one it shows left", () => {
    expect(mergePartialAmendments(current, partial([], ["b"]))).toBeNull();
  });

  it("asks for the whole list for an amendment it did not have", () => {
    expect(
      mergePartialAmendments(current, partial([amendment("d")])),
    ).toBeNull();
  });

  it("asks for the whole list when the base text differs", () => {
    expect(mergePartialAmendments(current, partial([a], [], "v2"))).toBeNull();
  });

  it("asks for the whole list when an amendment moved in text order", () => {
    expect(
      mergePartialAmendments(current, partial([{ ...a, positionKey: 5 }])),
    ).toBeNull();
    expect(
      mergePartialAmendments(current, partial([{ ...b, number: 9 }])),
    ).toBeNull();
  });
});

describe("amendmentsRefetchPlan", () => {
  const plan = (events: LiveEventDto[]) =>
    amendmentsRefetchPlan(events, "doc", PARTIAL_AMENDMENTS_MAX);

  it("reads only the amendments a vote decided", () => {
    expect(
      plan([
        ev("vote", "vote_recorded", "v1", "doc"),
        ev("amendment", "amendment_approved", "a", "doc"),
        ev("amendment", "amendment_transacted", "s1", "doc"),
        ev("amendment", "amendment_lapsed", "t2", "doc"),
        ev("live", "live_changed", "asm"),
      ]),
    ).toEqual({ full: false, ids: ["a", "s1", "t2"] });
  });

  it("reads only the amendment of an answer or an acceptance", () => {
    expect(plan([ev("amendment", "position_changed", "a", "doc")])).toEqual({
      full: false,
      ids: ["a"],
    });
    expect(
      plan([
        ev("amendment", "acceptance_recorded", "t", "doc"),
        ev("amendment", "acceptance_recorded", "t", "doc"),
      ]),
    ).toEqual({ full: false, ids: ["t"] });
    expect(plan([ev("amendment", "amendment_rejected", "a", "doc")])).toEqual({
      full: false,
      ids: ["a"],
    });
  });

  it("ignores batches of other documents and of nothing", () => {
    expect(plan([ev("amendment", "amendment_approved", "x", "other")])).toBe(
      null,
    );
    expect(plan([ev("speakers", "speaker_added", "s")])).toBe(null);
    expect(plan([])).toBe(null);
    expect(
      amendmentsRefetchPlan(
        [ev("amendment", "amendment_approved", "a", "doc")],
        null,
        PARTIAL_AMENDMENTS_MAX,
      ),
    ).toBe(null);
  });

  it("ignores another document's events beside this one's", () => {
    expect(
      plan([
        ev("amendment", "amendment_approved", "a", "doc"),
        ev("document", "document_updated", "other", "other"),
      ]),
    ).toEqual({ full: false, ids: ["a"] });
  });

  it("reads the whole list on a poll, even with no document", () => {
    expect(plan([ev("poll", "poll", "")])).toEqual({ full: true });
    expect(
      amendmentsRefetchPlan(
        [ev("poll", "poll", "")],
        null,
        PARTIAL_AMENDMENTS_MAX,
      ),
    ).toEqual({ full: true });
  });

  it("reads the whole list on any event of the document itself", () => {
    for (const type of [
      "document_updated",
      "document_voted",
      "passage_worded",
      "passage_wording_removed",
      "document_positions_published",
    ]) {
      expect(
        plan([
          ev("amendment", "amendment_approved", "a", "doc"),
          ev("document", type, "doc", "doc"),
        ]),
      ).toEqual({ full: true });
    }
    // Without its documentId too.
    expect(plan([ev("document", "document_updated", "doc")])).toEqual({
      full: true,
    });
  });

  it("reads the whole list on what changes which amendments are seen", () => {
    for (const type of [
      "amendment_created",
      "amendment_published",
      "amendment_withdrawn",
      "amendment_reopened",
      "amendment_validated",
      "amendment_deleted",
      "amendment_authors_changed",
      "transactional_source_dropped",
      "transactional_revision_applied",
    ]) {
      expect(plan([ev("amendment", type, "a", "doc")])).toEqual({
        full: true,
      });
    }
  });

  it("reads the whole list when a decision closes a transactional", () => {
    expect(
      plan([
        ev("amendment", "amendment_approved", "a", "doc"),
        ev("amendment", "amendment_withdrawn", "t", "doc"),
      ]),
    ).toEqual({ full: true });
  });

  it("reads the whole list on relations, inclusions and unchecked types", () => {
    for (const type of [
      "relation_created",
      "relation_deleted",
      "transactional_revision_proposed",
      "amendment_reclassified",
      "amendment_updated",
      "amendment_vote_without_effect",
      "something_new",
    ]) {
      expect(plan([ev("amendment", type, "a", "doc")])).toEqual({
        full: true,
      });
    }
  });

  it("reads the whole list on a vote between alternatives", () => {
    expect(
      plan([
        ev("vote", "vote_recorded", "v", "doc"),
        ev("decision", "decision_recorded", "d", "doc"),
        ev("amendment", "amendment_approved", "a", "doc"),
        ev("amendment", "amendment_rejected", "b", "doc"),
      ]),
    ).toEqual({ full: true });
  });

  it("reads the whole list on a vote with no amendment decided beside it", () => {
    expect(plan([ev("vote", "vote_recorded", "v", "doc")])).toEqual({
      full: true,
    });
    expect(
      plan([
        ev("vote", "vote_recorded", "v", "doc"),
        ev("amendment", "position_changed", "a", "doc"),
      ]),
    ).toEqual({ full: true });
    expect(
      plan([
        ev("vote", "vote_unanimity_changed", "v", "doc"),
        ev("amendment", "amendment_approved", "a", "doc"),
      ]),
    ).toEqual({ full: true });
  });

  it("reads the whole list over the cap", () => {
    const many = Array.from({ length: PARTIAL_AMENDMENTS_MAX + 1 }, (_, i) =>
      ev("amendment", "amendment_approved", `a${i}`, "doc"),
    );
    expect(plan(many)).toEqual({ full: true });
    expect(plan(many.slice(1))).toEqual({
      full: false,
      ids: many.slice(1).map((event) => event.entityId),
    });
  });
});

describe("partialAmendmentsRefetch", () => {
  const decided = [ev("amendment", "amendment_approved", "a", "doc")];
  const a = amendment("a");
  const b = amendment("b");

  function setup(overrides: Partial<PartialAmendmentsRefetchOptions> = {}) {
    let data: DocumentAmendmentsDto | null = list([a, b]);
    let readingAll = false;
    const options: PartialAmendmentsRefetchOptions = {
      documentId: () => "doc",
      current: () => data,
      write: vi.fn((dto: DocumentAmendmentsDto) => {
        data = dto;
      }),
      refreshAll: vi.fn(() => Promise.resolve()),
      readSome: vi.fn((ids: string[]) =>
        Promise.resolve(
          partial(
            ids.map((id) => amendment(id, { status: "approved" })),
            [],
          ),
        ),
      ),
      readingAll: () => readingAll,
      ...overrides,
    };
    const refetch = partialAmendmentsRefetch(options);
    return {
      options,
      refetch,
      data: () => data,
      setData: (value: DocumentAmendmentsDto | null) => {
        data = value;
      },
      setReadingAll: (value: boolean) => {
        readingAll = value;
      },
    };
  }

  it("merges a partial read into the list", async () => {
    const { options, refetch, data } = setup();
    await refetch.handle(decided);
    expect(options.readSome).toHaveBeenCalledWith(["a"]);
    expect(options.refreshAll).not.toHaveBeenCalled();
    expect(data()?.amendments.map((item) => item.status)).toEqual([
      "approved",
      "submitted",
    ]);
  });

  it("does nothing for a batch of another document", () => {
    const { options, refetch } = setup();
    expect(
      refetch.handle([ev("amendment", "amendment_approved", "x", "other")]),
    ).toBeNull();
    expect(options.readSome).not.toHaveBeenCalled();
    expect(options.refreshAll).not.toHaveBeenCalled();
  });

  it("reads the whole list when there is no list yet", async () => {
    const { options, refetch, setData } = setup();
    setData(null);
    await refetch.handle(decided);
    expect(options.refreshAll).toHaveBeenCalledOnce();
    expect(options.readSome).not.toHaveBeenCalled();
  });

  it("replaces a read of the whole list on its way, never merges into it", async () => {
    const { options, refetch, setReadingAll } = setup();
    setReadingAll(true);
    await refetch.handle(decided);
    expect(options.refreshAll).toHaveBeenCalledOnce();
    expect(options.readSome).not.toHaveBeenCalled();
  });

  it("reads the whole list when the plan says so", async () => {
    const { options, refetch } = setup();
    await refetch.handle([ev("amendment", "amendment_published", "a", "doc")]);
    expect(options.refreshAll).toHaveBeenCalledOnce();
    expect(options.readSome).not.toHaveBeenCalled();
  });

  it("reads the whole list when the partial read fails", async () => {
    const { options, refetch } = setup({
      readSome: vi.fn(() => Promise.reject(new Error("502"))),
    });
    await refetch.handle(decided);
    expect(options.refreshAll).toHaveBeenCalledOnce();
    expect(options.write).not.toHaveBeenCalled();
  });

  it("reads the whole list when the answer cannot be merged", async () => {
    const { options, refetch } = setup({
      readSome: vi.fn(() => Promise.resolve(partial([], ["a"]))),
    });
    await refetch.handle(decided);
    expect(options.refreshAll).toHaveBeenCalledOnce();
    expect(options.write).not.toHaveBeenCalled();
  });

  it("drops an answer once a read of the whole list started after it", async () => {
    let answer!: (value: PartialDocumentAmendmentsDto) => void;
    const { options, refetch } = setup({
      readSome: vi.fn(
        () =>
          new Promise<PartialDocumentAmendmentsDto>((resolve) => {
            answer = resolve;
          }),
      ),
    });
    const done = refetch.handle(decided);
    refetch.readAllStarted();
    answer(partial([{ ...a, status: "approved" }]));
    await done;
    expect(options.write).not.toHaveBeenCalled();
    expect(options.readSome).toHaveBeenCalledOnce();
  });

  it("drops an answer once it read the whole list itself, with no status change", async () => {
    // Replacing a read on its way leaves the fetch pending: no watcher.
    let answer!: (value: PartialDocumentAmendmentsDto) => void;
    const { options, refetch } = setup({
      readSome: vi.fn(
        () =>
          new Promise<PartialDocumentAmendmentsDto>((resolve) => {
            answer = resolve;
          }),
      ),
    });
    const done = refetch.handle(decided);
    await refetch.handle([ev("amendment", "amendment_reopened", "b", "doc")]);
    expect(options.refreshAll).toHaveBeenCalledOnce();
    answer(partial([{ ...a, status: "approved" }]));
    await done;
    expect(options.write).not.toHaveBeenCalled();
  });

  it("leaves the queued ids to a read of the whole list on its way", async () => {
    const answers: ((value: PartialDocumentAmendmentsDto) => void)[] = [];
    const { options, refetch, setReadingAll } = setup({
      readSome: vi.fn(
        () =>
          new Promise<PartialDocumentAmendmentsDto>((resolve) => {
            answers.push(resolve);
          }),
      ),
    });
    const first = refetch.handle(decided);
    void refetch.handle([ev("amendment", "position_changed", "b", "doc")]);
    // A read of the whole list starts from outside (another watcher).
    refetch.readAllStarted();
    setReadingAll(true);
    answers[0]!(partial([{ ...a, status: "approved" }]));
    await first;
    // No partial read of "b" leaves to land after that read or its
    // replacement.
    expect(options.readSome).toHaveBeenCalledOnce();
    expect(options.write).not.toHaveBeenCalled();
    // A reopen while it is on its way replaces it.
    await refetch.handle([ev("amendment", "amendment_reopened", "b", "doc")]);
    expect(options.refreshAll).toHaveBeenCalledOnce();
    expect(options.readSome).toHaveBeenCalledOnce();
    // Once it landed, the next decision reads only its amendment again.
    setReadingAll(false);
    const next = refetch.handle(decided);
    answers[1]!(partial([{ ...a, status: "approved" }]));
    await next;
    expect(vi.mocked(options.readSome).mock.calls).toEqual([[["a"]], [["a"]]]);
    expect(options.write).toHaveBeenCalledOnce();
  });

  it("reads again an answer that left before a mutation's answer (CON-10)", async () => {
    const answers: ((value: PartialDocumentAmendmentsDto) => void)[] = [];
    const { options, refetch, data } = setup({
      readSome: vi.fn(
        () =>
          new Promise<PartialDocumentAmendmentsDto>((resolve) => {
            answers.push(resolve);
          }),
      ),
    });
    const done = refetch.handle(decided);
    // The mutation's answer lands while the read is on its way.
    refetch.wrote();
    answers[0]!(partial([{ ...a, status: "rejected" }]));
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    answers[1]!(partial([{ ...a, status: "approved" }]));
    await done;
    expect(options.write).toHaveBeenCalledOnce();
    expect(data()?.amendments[0]?.status).toBe("approved");
  });

  it("gathers the batches that come during a read into the next one", async () => {
    const answers: ((value: PartialDocumentAmendmentsDto) => void)[] = [];
    const { options, refetch, data } = setup({
      readSome: vi.fn(
        (ids: string[]) =>
          new Promise<PartialDocumentAmendmentsDto>((resolve) => {
            answers.push(() =>
              resolve(
                partial(ids.map((id) => amendment(id, { status: "lapsed" }))),
              ),
            );
          }),
      ),
    });
    const first = refetch.handle(decided);
    const second = refetch.handle([
      ev("amendment", "position_changed", "b", "doc"),
    ]);
    const third = refetch.handle([
      ev("amendment", "position_changed", "a", "doc"),
    ]);
    expect(second).toBe(first);
    expect(third).toBe(first);
    answers[0]!({} as PartialDocumentAmendmentsDto);
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    answers[1]!({} as PartialDocumentAmendmentsDto);
    await first;
    expect(vi.mocked(options.readSome).mock.calls).toEqual([
      [["a"]],
      [["b", "a"]],
    ]);
    expect(data()?.amendments.map((item) => item.status)).toEqual([
      "lapsed",
      "lapsed",
    ]);
  });

  it("reads the whole list when the gathered ids pass the cap", async () => {
    let answer!: (value: PartialDocumentAmendmentsDto) => void;
    const { options, refetch } = setup({
      readSome: vi.fn(
        () =>
          new Promise<PartialDocumentAmendmentsDto>((resolve) => {
            answer = resolve;
          }),
      ),
    });
    const done = refetch.handle(decided);
    const batch = (prefix: string) =>
      Array.from({ length: PARTIAL_AMENDMENTS_MAX / 2 + 1 }, (_, i) =>
        ev("amendment", "position_changed", `${prefix}${i}`, "doc"),
      );
    // Each batch fits on its own; together they do not.
    void refetch.handle(batch("p"));
    expect(options.refreshAll).not.toHaveBeenCalled();
    await refetch.handle(batch("q"));
    expect(options.refreshAll).toHaveBeenCalledOnce();
    answer(partial([{ ...a, status: "approved" }]));
    await done;
    expect(options.readSome).toHaveBeenCalledOnce();
  });

  it("drops an answer for a document no longer on screen", async () => {
    let documentId = "doc";
    let answer!: (value: PartialDocumentAmendmentsDto) => void;
    const { options, refetch } = setup({
      documentId: () => documentId,
      readSome: vi.fn(
        () =>
          new Promise<PartialDocumentAmendmentsDto>((resolve) => {
            answer = resolve;
          }),
      ),
    });
    const done = refetch.handle(decided);
    documentId = "next";
    answer(partial([{ ...a, status: "approved" }]));
    await done;
    expect(options.write).not.toHaveBeenCalled();
  });

  it("is busy only while a partial read is on its way (documentHandover)", async () => {
    let answer!: (value: PartialDocumentAmendmentsDto) => void;
    const { refetch, data } = setup({
      readSome: vi.fn(
        () =>
          new Promise<PartialDocumentAmendmentsDto>((resolve) => {
            answer = resolve;
          }),
      ),
    });
    expect(refetch.busy()).toBe(false);
    const done = refetch.handle(decided);
    expect(refetch.busy()).toBe(true);
    answer(partial([{ ...a, status: "approved" }]));
    await done;
    expect(refetch.busy()).toBe(false);
    expect(data()?.amendments[0]?.status).toBe("approved");
  });

  it("is not busy for a read of the whole list (the fetch shows that)", async () => {
    const { refetch } = setup();
    const done = refetch.handle([ev("poll", "poll", "")]);
    expect(refetch.busy()).toBe(false);
    await done;
  });
});
