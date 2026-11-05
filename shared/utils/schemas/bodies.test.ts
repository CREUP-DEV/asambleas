import { describe, expect, it } from "vitest";
import {
  amendmentDraftBodySchema,
  amendmentUpdateBodySchema,
  positionBodySchema,
  transactionalBodySchema,
} from "./amendment";
import { documentCreateSchema, documentUpdateSchema } from "./document";

/**
 * z.object drops keys it does not know, so a field missing from a schema
 * vanishes silently. These parse tests keep the fields of the main presenter
 * and main author contract (shared/types/api.ts) in the schemas.
 */

const id = (n: number) => `m${String(n).padStart(23, "0")}`;
const at = "2026-11-05T10:00:00.000Z";

describe("document bodies", () => {
  const create = {
    agendaItemId: id(1),
    kind: "regulation",
    format: "structured",
    title: "Reglamento",
  };

  it("keeps the co-presenters and the accepted amendments rule", () => {
    const parsed = documentCreateSchema.parse({
      ...create,
      proponentMemberId: id(2),
      coProponentMemberIds: [id(3), id(4)],
      acceptedAmendments: "incorporate",
    });
    expect(parsed.coProponentMemberIds).toEqual([id(3), id(4)]);
    expect(parsed.acceptedAmendments).toBe("incorporate");

    const update = documentUpdateSchema.parse({
      coProponentMemberIds: [],
      acceptedAmendments: "vote",
      updatedAt: at,
    });
    expect(update.coProponentMemberIds).toEqual([]);
    expect(update.acceptedAmendments).toBe("vote");
  });

  it("refuses repeated co-presenters and unknown rules", () => {
    expect(
      documentCreateSchema.safeParse({
        ...create,
        coProponentMemberIds: [id(3), id(3)],
      }).success,
    ).toBe(false);
    expect(
      documentCreateSchema.safeParse({
        ...create,
        acceptedAmendments: "assent",
      }).success,
    ).toBe(false);
  });
});

describe("amendment bodies", () => {
  it("keeps the main author", () => {
    const draft = amendmentDraftBodySchema.parse({
      kind: "partial",
      ops: [{ op: "delete", blockIds: ["block1"] }],
      justification: "",
      authorMemberIds: [id(2)],
      mainAuthorMemberId: id(2),
    });
    expect(draft.mainAuthorMemberId).toBe(id(2));

    const update = amendmentUpdateBodySchema.parse({
      mainAuthorMemberId: id(3),
      updatedAt: at,
    });
    expect(update.mainAuthorMemberId).toBe(id(3));

    const transactional = transactionalBodySchema.parse({
      sourceIds: [id(5)],
      ops: [{ op: "delete", blockIds: ["block1"] }],
      justification: "",
      mainAuthorMemberId: null,
    });
    expect(transactional.mainAuthorMemberId).toBeNull();
  });

  it("keeps the position the client saw", () => {
    expect(
      positionBodySchema.parse({ position: "accept", positionUpdatedAt: at })
        .positionUpdatedAt,
    ).toBe(at);
    expect(
      positionBodySchema.parse({ position: "reject", positionUpdatedAt: null })
        .positionUpdatedAt,
    ).toBeNull();
    expect(
      positionBodySchema.safeParse({
        position: "accept",
        positionUpdatedAt: "yesterday",
      }).success,
    ).toBe(false);
  });
});
