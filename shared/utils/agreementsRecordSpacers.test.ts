import { describe, expect, it } from "vitest";
import {
  agreementsRecordBlocks,
  dropSignatureSpacers,
  type AgreementsRecord,
} from "./agreementsRecord";
import { hashContent } from "./diff";
import { blocksSchema } from "./schemas/content";

const record = {
  title: "Acta de Acuerdos 80.ª AGO",
  header: [
    { key: "secretary_name", proposed: "", corrected: null, text: "Nombre" },
    {
      key: "secretary_title",
      proposed: "",
      corrected: null,
      text: "Secretaría Ejecutiva",
    },
    { key: "city", proposed: "", corrected: null, text: "Murcia" },
  ],
  agreements: [],
} as unknown as AgreementsRecord;
const assembly = {
  number: 80,
  type: "AGO" as const,
  startDate: new Date("2026-11-20T09:00:00Z"),
  location: "Universidad de Murcia",
};
/** As the server hashes a version (hashBlocks). */
const hash = (blocks: unknown[]) => hashContent(JSON.stringify(blocks));

describe("an approved record written before 2026-11-23", () => {
  it("reads as the record now without its empty signature paragraphs", async () => {
    const now = blocksSchema.parse(agreementsRecordBlocks(record, assembly));
    // As it was stored then: three empty paragraphs before the name, with
    // its keys in the order jsonb hands them back.
    const signer = now.findIndex((block) => block.id === "ar-signer");
    const stored = [
      ...now.slice(0, signer),
      ...[1, 2, 3].map((n) => ({
        id: `ar-signature-${n}`,
        type: "paragraph" as const,
        text: "",
        marks: [],
      })),
      ...now.slice(signer),
    ].map((block) =>
      Object.fromEntries(Object.entries(block).reverse()),
    ) as typeof now;
    const kept = dropSignatureSpacers(stored);
    expect(kept).toHaveLength(now.length);
    expect(await hash(blocksSchema.parse(kept))).toBe(await hash(now));
  });

  it("leaves a version without them alone", () => {
    const now = blocksSchema.parse(agreementsRecordBlocks(record, assembly));
    expect(dropSignatureSpacers(now)).toBeNull();
  });
});
