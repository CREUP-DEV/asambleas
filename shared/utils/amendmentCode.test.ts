import { describe, expect, it } from "vitest";
import {
  amendmentCodePrefix,
  amendmentCodeSeq,
  formatAmendmentCode,
  planAmendmentCodes,
  type CodedAmendment,
} from "./amendmentCode";

describe("amendmentCodePrefix", () => {
  it("names a council by its university, as its avatar", () => {
    expect(
      amendmentCodePrefix({
        acronym: "CGEUGR",
        kind: "asociado",
        universityAcronym: "UGR",
      }),
    ).toBe("UGR");
    expect(
      amendmentCodePrefix({
        acronym: "CEUVA",
        kind: "asociado",
        universityAcronym: " UVa ",
      }),
    ).toBe("UVa");
  });

  it("falls back to the council's acronym without a university", () => {
    expect(
      amendmentCodePrefix({
        acronym: "CGEUGR",
        kind: "asociado",
        universityAcronym: null,
      }),
    ).toBe("CGEUGR");
    expect(
      amendmentCodePrefix({
        acronym: "CGEUGR",
        kind: "asociado",
        universityAcronym: "  ",
      }),
    ).toBe("CGEUGR");
  });

  it("keeps the acronym of sectorials and other members", () => {
    expect(
      amendmentCodePrefix({
        acronym: "ANEM",
        kind: "sectorial",
        universityAcronym: "UGR",
      }),
    ).toBe("ANEM");
    expect(amendmentCodePrefix({ acronym: "CAS", kind: "other" })).toBe("CAS");
  });

  it("never names a CEA office", () => {
    expect(amendmentCodePrefix({ acronym: "SE", kind: "executive" })).toBe(
      "CEA",
    );
  });
});

describe("formatAmendmentCode", () => {
  it("writes the number right after the prefix", () => {
    expect(formatAmendmentCode("UGR", 1)).toBe("UGR1");
    expect(formatAmendmentCode("T", 12)).toBe("T12");
  });
});

describe("amendmentCodeSeq", () => {
  it("reads the number of a code of the sequence, old form included", () => {
    expect(amendmentCodeSeq("UGR3", "UGR")).toBe(3);
    expect(amendmentCodeSeq("CEUM 2", "CEUM")).toBe(2);
    expect(amendmentCodeSeq("UC3M12", "UC3M")).toBe(12);
  });

  it("is null for codes of another sequence or malformed", () => {
    expect(amendmentCodeSeq("UGR3", "UG")).toBeNull();
    expect(amendmentCodeSeq("UGR0", "UGR")).toBeNull();
    expect(amendmentCodeSeq("UGR", "UGR")).toBeNull();
    expect(amendmentCodeSeq("UGR 3b", "UGR")).toBeNull();
    expect(amendmentCodeSeq(null, "UGR")).toBeNull();
    expect(amendmentCodeSeq("T1", "")).toBeNull();
  });
});

describe("planAmendmentCodes", () => {
  const row = (
    id: string,
    minute: number,
    fields: Partial<CodedAmendment> = {},
  ): CodedAmendment => ({
    id,
    transactional: false,
    status: "submitted",
    number: null,
    memberSeq: null,
    code: null,
    submittedAt: new Date(Date.UTC(2026, 10, 12, 10, minute)),
    createdAt: new Date(Date.UTC(2026, 10, 12, 9, minute)),
    prefix: "UGR",
    ...fields,
  });

  it("recodes in the order they were presented, per prefix", () => {
    const changes = planAmendmentCodes([
      row("b", 2, { number: 2, memberSeq: 1, code: "CGEUGR 1" }),
      row("a", 1, {
        number: 1,
        memberSeq: 1,
        code: "SIUEH 1",
        prefix: "SIUEH",
      }),
      row("c", 3, { number: 3, memberSeq: 2, code: "CGEUGR 2" }),
    ]);
    expect(changes).toEqual([
      {
        id: "a",
        number: 1,
        memberSeq: 1,
        code: "SIUEH1",
        previousCode: "SIUEH 1",
      },
      {
        id: "b",
        number: 2,
        memberSeq: 1,
        code: "UGR1",
        previousCode: "CGEUGR 1",
      },
      {
        id: "c",
        number: 3,
        memberSeq: 2,
        code: "UGR2",
        previousCode: "CGEUGR 2",
      },
    ]);
  });

  it("keeps the order of the numbers they have, not of presentation", () => {
    // Numbered on publication: "SIUEH 2" was presented first.
    const changes = planAmendmentCodes([
      row("a", 2, { number: 1, memberSeq: 1, code: "SIUEH 1" }),
      row("b", 1, { number: 2, memberSeq: 2, code: "SIUEH 2" }),
    ]).map((change) => [change.id, change.code]);
    expect(changes).toEqual([
      ["a", "UGR1"],
      ["b", "UGR2"],
    ]);
  });

  it("numbers the ones presented without a number, after the highest", () => {
    const changes = planAmendmentCodes([
      row("a", 1, { number: 4, memberSeq: 1, code: "UGR1" }),
      row("b", 2),
    ]);
    expect(changes).toEqual([
      { id: "b", number: 5, memberSeq: 2, code: "UGR2", previousCode: null },
    ]);
  });

  it("leaves drafts without a code and amendments without a main author", () => {
    expect(
      planAmendmentCodes([
        row("a", 1, { status: "draft", submittedAt: null }),
        row("b", 2, { prefix: null, code: "X 1", number: 1, memberSeq: 1 }),
      ]),
    ).toEqual([]);
  });

  it("keeps a corrected draft's place: it still holds its code", () => {
    const changes = planAmendmentCodes([
      row("a", 1, {
        status: "draft",
        number: 1,
        memberSeq: 1,
        code: "CGEUGR 1",
      }),
    ]);
    expect(changes.map((change) => change.code)).toEqual(["UGR1"]);
  });

  it("keeps transactional codes and numbers the ones without", () => {
    const changes = planAmendmentCodes([
      row("t1", 1, { transactional: true, code: "T1", prefix: null }),
      row("t2", 2, { transactional: true, prefix: null }),
    ]);
    expect(changes).toEqual([
      {
        id: "t2",
        number: null,
        memberSeq: null,
        code: "T2",
        previousCode: null,
      },
    ]);
  });

  it("changes nothing on its own result", () => {
    const rows = [
      row("a", 1, { number: 1, memberSeq: 1, code: "CGEUGR 1" }),
      row("b", 2),
    ];
    const applied = rows.map((current) => {
      const change = planAmendmentCodes(rows).find((c) => c.id === current.id);
      return change ? { ...current, ...change } : current;
    });
    expect(planAmendmentCodes(applied)).toEqual([]);
  });
});
