import { describe, expect, it } from "vitest";
import type { VoteDto } from "~~/shared/types/api";
import type { Block, ConsolidatedBlock } from "~~/shared/types/content";
import {
  screenApprovalFill,
  withFilledApprovalLine,
  withFilledApprovalLineAnnotated,
} from "./approvalFill";

const LINE =
  "Modificado parcialmente en la 80ª Asamblea General Ordinaria el XX de xxxxxxxxx de 202x.";

const p = (id: string, text: string): Block => ({
  id,
  type: "paragraph",
  text,
  marks: [],
});

const vote = {
  result: "approved",
  voidedAt: null,
  method: "assent",
  majority: "two_thirds",
  inFavor: 0,
  against: 0,
  abstentions: 0,
  unanimous: false,
  recordedAt: "2026-11-21T17:00:00Z",
} as unknown as VoteDto;
const assembly = { number: 80, type: "AGO" } as const;

describe("screenApprovalFill", () => {
  it("fills only from an approving final vote in force", () => {
    expect(screenApprovalFill(vote, assembly)).not.toBeNull();
    expect(
      screenApprovalFill({ ...vote, result: "rejected" } as VoteDto, assembly),
    ).toBeNull();
    expect(
      screenApprovalFill(
        { ...vote, voidedAt: "2026-11-22T10:00:00Z" } as VoteDto,
        assembly,
      ),
    ).toBeNull();
    expect(screenApprovalFill(null, assembly)).toBeNull();
    expect(screenApprovalFill(vote, null)).toBeNull();
  });
});

describe("withFilledApprovalLine", () => {
  const blocks = [
    p("t", "Reglamento de Funcionamiento del Comité de Garantías"),
    p("l", LINE),
    p("b", "Artículo 1."),
  ];

  it("writes the vote's data in the line, as the PDF does", () => {
    const shown = withFilledApprovalLine(
      blocks,
      screenApprovalFill(vote, assembly),
    );
    expect(shown[1]!.text).toBe(
      "Modificado parcialmente en la 80.ª Asamblea General Ordinaria el 21 de noviembre de 2026.",
    );
    expect(shown[0]).toBe(blocks[0]);
    expect(shown[2]).toBe(blocks[2]);
    // The stored blocks are not touched.
    expect(blocks[1]!.text).toBe(LINE);
  });

  it("shows the line as written before the approval", () => {
    expect(withFilledApprovalLine(blocks, null)).toBe(blocks);
  });
});

describe("withFilledApprovalLineAnnotated", () => {
  const annotated = (id: string, text: string): ConsolidatedBlock => ({
    id,
    type: "paragraph",
    segments: [{ text, source: null }],
    marks: [],
    status: "kept",
    source: null,
  });

  it("fills the line read on the kept text and leaves the rest", () => {
    const blocks = [
      annotated("t", "Reglamento"),
      annotated("l", LINE),
      annotated("b", "Artículo 1."),
    ];
    const shown = withFilledApprovalLineAnnotated(
      blocks,
      screenApprovalFill(vote, assembly),
    );
    expect(shown[1]!.segments).toEqual([
      {
        text: "Modificado parcialmente en la 80.ª Asamblea General Ordinaria el 21 de noviembre de 2026.",
        source: null,
      },
    ]);
    expect(shown[0]).toBe(blocks[0]);
    expect(shown[2]).toBe(blocks[2]);
  });

  it("returns the same blocks without a line or a fill", () => {
    const blocks = [annotated("a", "Texto.")];
    expect(
      withFilledApprovalLineAnnotated(
        blocks,
        screenApprovalFill(vote, assembly),
      ),
    ).toBe(blocks);
    expect(withFilledApprovalLineAnnotated(blocks, null)).toBe(blocks);
  });
});
