import { describe, expect, it } from "vitest";
import {
  documentAudience,
  documentProgress,
  isPendingProgress,
  PROGRESS_LABEL_ORDER,
} from "./documentProgress";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const FUTURE = "2026-11-10T10:00:00Z";
const PAST = "2026-11-01T10:00:00Z";

type Input = Parameters<typeof documentProgress>[0];

function doc(overrides: Partial<Input> = {}): Input {
  return {
    status: "draft",
    dueAt: null,
    hasContent: true,
    correctionNote: null,
    correctionRequestedAt: null,
    ...overrides,
  };
}

describe("documentProgress", () => {
  it("reads an empty draft as expected, with its deadline", () => {
    const progress = documentProgress(
      doc({ hasContent: false, dueAt: FUTURE }),
      "presenter",
      NOW,
    );
    expect(progress.state).toBe("expected");
    expect(progress.overdue).toBe(false);
    expect(progress.dueAt).toBe(FUTURE);
    expect(progress.sentenceKey).toBe(
      "document.progress.presenter.expectedDue",
    );
    expect(progress.labelKey).toBe("document.progress.label.expected");
    expect(progress.action).toBe("prepare");
  });

  it("flags an expected document past its deadline", () => {
    const progress = documentProgress(
      doc({ hasContent: false, dueAt: PAST }),
      "manager",
      NOW,
    );
    expect(progress.overdue).toBe(true);
    expect(progress.color).toBe("error");
    expect(progress.labelKey).toBe("document.progress.label.overdue");
    expect(progress.sentenceKey).toBe(
      "document.progress.manager.expectedOverdue",
    );
    expect(progress.action).toBeNull();
  });

  it("treats a missing hasContent (older server) as content present", () => {
    const progress = documentProgress(
      doc({ hasContent: undefined as unknown as boolean }),
      "presenter",
      NOW,
    );
    expect(progress.state).toBe("preparing");
    expect(progress.sentenceKey).toBe("document.progress.presenter.preparing");
    expect(progress.action).toBe("continue");
  });

  it("keeps a draft with content in preparation, with or without deadline", () => {
    expect(
      documentProgress(doc({ dueAt: FUTURE }), "presenter", NOW).sentenceKey,
    ).toBe("document.progress.presenter.preparingDue");
    const late = documentProgress(doc({ dueAt: PAST }), "presenter", NOW);
    expect(late.sentenceKey).toBe(
      "document.progress.presenter.preparingOverdue",
    );
    expect(late.color).toBe("warning");
  });

  it("puts a requested correction before an empty text", () => {
    const progress = documentProgress(
      doc({
        hasContent: false,
        correctionNote: "Falta el anexo",
        correctionRequestedAt: PAST,
      }),
      "presenter",
      NOW,
    );
    expect(progress.state).toBe("correction");
    expect(progress.note).toBe("Falta el anexo");
    expect(progress.sentenceKey).toBe("document.progress.presenter.correction");
    expect(progress.action).toBe("fix");
  });

  it("has a sentence for a correction whose note is hidden", () => {
    const progress = documentProgress(
      doc({ correctionRequestedAt: PAST }),
      "other",
      NOW,
    );
    expect(progress.state).toBe("correction");
    expect(progress.sentenceKey).toBe(
      "document.progress.manager.correctionNoNote",
    );
  });

  it("reads a submitted document as sent, even with an old note", () => {
    const progress = documentProgress(
      doc({
        status: "submitted",
        correctionNote: "Falta el anexo",
        dueAt: PAST,
      }),
      "presenter",
      NOW,
    );
    expect(progress.state).toBe("submitted");
    expect(progress.overdue).toBe(false);
    expect(progress.note).toBeNull();
    expect(progress.sentenceKey).toBe("document.progress.presenter.submitted");
    expect(progress.action).toBeNull();
  });

  it("words the submitted state per audience", () => {
    const submitted = doc({ status: "submitted" });
    expect(documentProgress(submitted, "manager", NOW).sentenceKey).toBe(
      "document.progress.manager.submitted",
    );
    expect(documentProgress(submitted, "other", NOW).sentenceKey).toBe(
      "document.progress.other.submitted",
    );
  });

  it("maps the final statuses to their badges", () => {
    for (const status of ["published", "withdrawn", "postponed"] as const) {
      const progress = documentProgress(doc({ status }), "presenter", NOW);
      expect(progress.state).toBe(status);
      expect(progress.labelKey).toBe(`common.status.document.${status}`);
      expect(progress.sentenceKey).toBe(`document.progress.all.${status}`);
      expect(isPendingProgress(progress.state)).toBe(false);
    }
  });

  it("ignores an invalid deadline", () => {
    const progress = documentProgress(
      doc({ dueAt: "not a date" }),
      "presenter",
      NOW,
    );
    expect(progress.dueAt).toBeNull();
    expect(progress.overdue).toBe(false);
    expect(progress.sentenceKey).toBe("document.progress.presenter.preparing");
  });
});

describe("documentAudience", () => {
  const document = {
    proponent: { id: "m1", acronym: "CEUM", name: "CEUM", kind: "asociado" },
  } as const;

  it("puts the Secretaría first", () => {
    expect(documentAudience(document, { memberId: "m1", manager: true })).toBe(
      "manager",
    );
  });

  it("recognises the presenting member", () => {
    expect(documentAudience(document, { memberId: "m1", manager: false })).toBe(
      "presenter",
    );
  });

  it("treats anyone else as other", () => {
    expect(documentAudience(document, { memberId: "m2", manager: false })).toBe(
      "other",
    );
    expect(
      documentAudience({ proponent: null }, { memberId: null, manager: false }),
    ).toBe("other");
  });
});

describe("isPendingProgress", () => {
  it("covers drafts and submissions", () => {
    expect(isPendingProgress("expected")).toBe(true);
    expect(isPendingProgress("preparing")).toBe(true);
    expect(isPendingProgress("correction")).toBe(true);
    expect(isPendingProgress("submitted")).toBe(true);
  });
});

describe("PROGRESS_LABEL_ORDER", () => {
  it("lists every badge label exactly once", () => {
    const keys = new Set<string>();
    const statuses = [
      "draft",
      "submitted",
      "published",
      "withdrawn",
      "postponed",
    ] as const;
    for (const status of statuses) {
      for (const hasContent of [true, false]) {
        for (const dueAt of [null, FUTURE, PAST]) {
          for (const correctionNote of [null, "Falta el anexo"]) {
            keys.add(
              documentProgress(
                doc({ status, hasContent, dueAt, correctionNote }),
                "other",
                NOW,
              ).labelKey,
            );
          }
        }
      }
    }
    expect(new Set(PROGRESS_LABEL_ORDER).size).toBe(
      PROGRESS_LABEL_ORDER.length,
    );
    expect([...keys].sort()).toEqual([...PROGRESS_LABEL_ORDER].sort());
  });
});
