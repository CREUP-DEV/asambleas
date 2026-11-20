import { describe, expect, it, vi } from "vitest";
import { effectScope, ref } from "vue";
import type {
  AmendmentDto,
  DocumentAmendmentsDto,
  DocumentDto,
} from "~~/shared/types/api";
import {
  addSource,
  amendmentsBelongTo,
  canSeed,
  findDocumentHandover,
  followingLive,
  seedFetch,
  seedOrRead,
  settledForHandover,
  type DocumentHandoverSource,
} from "./documentHandover";

/** Only the fields the handover reads; the rest is carried as is. */
function document(id: string, extra: Partial<DocumentDto> = {}): DocumentDto {
  return {
    id,
    slug: `slug-${id}`,
    baseVersion: { id: `base-${id}` },
    ...extra,
  } as DocumentDto;
}

function list(
  documentId: string,
  extra: Partial<DocumentAmendmentsDto> = {},
): DocumentAmendmentsDto {
  return {
    amendments: [
      { id: `${documentId}-a1`, documentId } as AmendmentDto,
      { id: `${documentId}-a2`, documentId } as AmendmentDto,
    ],
    relations: [],
    wordings: [],
    baseVersionId: `base-${documentId}`,
    ...extra,
  } as DocumentAmendmentsDto;
}

function source(
  assemblyId: string | null,
  doc: DocumentDto | null,
  amendments: DocumentAmendmentsDto | null = null,
): DocumentHandoverSource {
  return {
    assemblyId: () => assemblyId,
    document: () => doc,
    amendments: () => amendments,
  };
}

describe("settledForHandover", () => {
  it("hands over data read successfully, not failed, nothing on its way", () => {
    expect(settledForHandover({ status: "success", failed: false })).toBe(true);
    expect(
      settledForHandover({ status: "success", failed: false, busy: false }),
    ).toBe(true);
  });

  it("keeps data being read, never read, failed or about to change", () => {
    expect(settledForHandover({ status: "pending", failed: false })).toBe(
      false,
    );
    expect(settledForHandover({ status: "idle", failed: false })).toBe(false);
    expect(settledForHandover({ status: "error", failed: true })).toBe(false);
    // Kept on screen after a failed read: not up to date.
    expect(settledForHandover({ status: "success", failed: true })).toBe(false);
    // A partial read or a live read on its way.
    expect(
      settledForHandover({ status: "success", failed: false, busy: true }),
    ).toBe(false);
  });
});

describe("followingLive", () => {
  it("hands over while the stream is connected", () => {
    expect(
      followingLive({ connected: true, polling: false, expired: false }),
    ).toBe(true);
  });

  it("never while it is down, polling or expired", () => {
    expect(
      followingLive({ connected: false, polling: false, expired: false }),
    ).toBe(false);
    expect(
      followingLive({ connected: false, polling: true, expired: false }),
    ).toBe(false);
    expect(
      followingLive({ connected: true, polling: true, expired: false }),
    ).toBe(false);
    expect(
      followingLive({ connected: true, polling: false, expired: true }),
    ).toBe(false);
  });
});

describe("addSource", () => {
  it("offers a source until its scope is disposed", () => {
    const sources = new Set<DocumentHandoverSource>();
    const offered = source("as1", document("d1"));
    const scope = effectScope();
    expect(scope.run(() => addSource(sources, offered))).toBe(true);
    expect(sources.has(offered)).toBe(true);
    scope.stop();
    expect(sources.size).toBe(0);
  });

  it("adds nothing in a scope already stopped (a page left mid-setup)", () => {
    const sources = new Set<DocumentHandoverSource>();
    const scope = effectScope();
    scope.stop();
    // What a setup resumed after an await does (withAsyncContext): back in
    // its scope, stopped meanwhile. `on`/`off` are internal to Vue.
    const internal = scope as unknown as { on(): void; off(): void };
    internal.on();
    try {
      expect(addSource(sources, source("as1", document("d1")))).toBe(false);
    } finally {
      internal.off();
    }
    expect(sources.size).toBe(0);
  });

  it("adds nothing outside any scope", () => {
    const sources = new Set<DocumentHandoverSource>();
    expect(addSource(sources, source("as1", document("d1")))).toBe(false);
    expect(sources.size).toBe(0);
  });
});

describe("amendmentsBelongTo", () => {
  it("accepts the list of the document's base text", () => {
    expect(amendmentsBelongTo(list("d1"), document("d1"))).toBe(true);
    // Not published yet: no base text on either side, no amendments.
    expect(
      amendmentsBelongTo(
        list("d1", { amendments: [], baseVersionId: null }),
        document("d1", { baseVersion: null }),
      ),
    ).toBe(true);
  });

  it("rejects another base text or another document's amendments", () => {
    expect(
      amendmentsBelongTo(
        list("d1", { baseVersionId: "base-old" }),
        document("d1"),
      ),
    ).toBe(false);
    expect(
      amendmentsBelongTo(
        list("d1", { amendments: [{ id: "x", documentId: "d2" } as never] }),
        document("d1"),
      ),
    ).toBe(false);
  });
});

describe("findDocumentHandover", () => {
  const d1 = document("d1");
  const d2 = document("d2");

  it("finds the document by id or by slug, with its amendments", () => {
    const sources = [source("as1", d1, list("d1"))];
    expect(findDocumentHandover(sources, "as1", "d1")).toEqual({
      document: d1,
      amendments: list("d1"),
    });
    expect(findDocumentHandover(sources, "as1", "slug-d1")?.document).toBe(d1);
  });

  it("hands over the document alone when its amendments are not ready", () => {
    expect(
      findDocumentHandover([source("as1", d1, null)], "as1", "d1"),
    ).toEqual({ document: d1, amendments: null });
  });

  it("drops amendments that are not this document's", () => {
    expect(
      findDocumentHandover([source("as1", d1, list("d2"))], "as1", "d1"),
    ).toEqual({ document: d1, amendments: null });
    expect(
      findDocumentHandover(
        [source("as1", d1, list("d1", { baseVersionId: "base-old" }))],
        "as1",
        "d1",
      ),
    ).toEqual({ document: d1, amendments: null });
  });

  it("never finds another document or another assembly's", () => {
    const sources = [source("as1", d1, list("d1"))];
    expect(findDocumentHandover(sources, "as1", "d2")).toBeNull();
    expect(findDocumentHandover(sources, "as2", "d1")).toBeNull();
    expect(findDocumentHandover(sources, null, "d1")).toBeNull();
    expect(findDocumentHandover(sources, "as1", null)).toBeNull();
    expect(findDocumentHandover(sources, "as1", "")).toBeNull();
  });

  it("finds nothing in a source with nothing up to date", () => {
    expect(
      findDocumentHandover([source("as1", null, list("d1"))], "as1", "d1"),
    ).toBeNull();
    expect(findDocumentHandover([], "as1", "d1")).toBeNull();
  });

  it("takes the newest source that holds it", () => {
    const older = document("d1", { title: "old" } as Partial<DocumentDto>);
    const newer = document("d1", { title: "new" } as Partial<DocumentDto>);
    const found = findDocumentHandover(
      [source("as1", older), source("as1", d2), source("as1", newer)],
      "as1",
      "d1",
    );
    expect(found?.document).toBe(newer);
  });
});

describe("canSeed", () => {
  it("only a fresh entry, never read", () => {
    expect(canSeed("idle", undefined)).toBe(true);
    expect(canSeed("idle", null)).toBe(true);
    expect(canSeed("idle", { some: "data" })).toBe(false);
    expect(canSeed("success", undefined)).toBe(false);
    expect(canSeed("pending", undefined)).toBe(false);
    expect(canSeed("error", null)).toBe(false);
  });
});

describe("seedFetch", () => {
  it("puts the value in a fresh entry as if just read", () => {
    const fetch = { data: ref<DocumentDto | undefined>(), status: ref("idle") };
    expect(seedFetch(fetch, document("d1"))).toBe(true);
    expect(fetch.data.value?.id).toBe("d1");
    expect(fetch.status.value).toBe("success");
  });

  it("leaves an entry another component already holds", () => {
    const held = document("d1", { slug: "held" });
    const read = {
      data: ref<DocumentDto | undefined>(held),
      status: ref("success"),
    };
    expect(seedFetch(read, document("d1"))).toBe(false);
    expect(read.data.value?.slug).toBe("held");
    const reading = {
      data: ref<DocumentDto | undefined>(),
      status: ref("pending"),
    };
    expect(seedFetch(reading, document("d1"))).toBe(false);
    expect(reading.status.value).toBe("pending");
  });

  it("seeds nothing without a value", () => {
    const fetch = { data: ref<DocumentDto | null>(null), status: ref("idle") };
    expect(seedFetch(fetch, null)).toBe(false);
    expect(seedFetch(fetch, undefined)).toBe(false);
    expect(fetch.status.value).toBe("idle");
  });
});

describe("seedOrRead", () => {
  it("seeds a fresh entry without reading it", () => {
    const refresh = vi.fn(() => Promise.resolve());
    const fetch = {
      data: ref<DocumentDto | undefined>(),
      status: ref("idle"),
      refresh,
    };
    expect(seedOrRead(fetch, document("d1"))).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("reads an entry never read that cannot take the value", () => {
    const refresh = vi.fn(() => Promise.resolve());
    const fetch = {
      data: ref<DocumentDto | null>(null),
      status: ref("idle"),
      refresh,
    };
    expect(seedOrRead(fetch, null)).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("leaves an entry already read or on its way", () => {
    const refresh = vi.fn(() => Promise.resolve());
    const read = {
      data: ref<DocumentDto | undefined>(document("d1")),
      status: ref("success"),
      refresh,
    };
    expect(seedOrRead(read, document("d1"))).toBe(false);
    const reading = {
      data: ref<DocumentDto | undefined>(),
      status: ref("pending"),
      refresh,
    };
    expect(seedOrRead(reading, document("d1"))).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });
});
