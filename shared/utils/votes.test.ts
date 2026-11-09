import { describe, expect, it } from "vitest";
import {
  amendmentVoteMajority,
  DEFAULT_ASSEMBLY_SETTINGS,
  DOCUMENT_KIND_DEFAULTS,
  type DocumentKind,
} from "../constants/domain";
import { computeVoteOutcome, type VoteCounts } from "./votes";

/**
 * Votes recorded in the minutes of the 77.ª AGO (Sevilla, April 2025), with
 * the outcome the assembly declared. Each one must come out the same with
 * the default majority of its document kind and the default settings.
 */
const documentVotes: {
  name: string;
  kind: DocumentKind;
  counts: VoteCounts;
  result: "approved" | "rejected";
}[] = [
  {
    name: "Convenio con CANAE (point 24.2)",
    kind: "agreement",
    counts: { inFavor: 18, against: 2, abstentions: 10 },
    result: "rejected",
  },
  {
    name: "IEJ sobre dobles titulaciones (point 23.3), secret vote",
    kind: "executive_report",
    counts: { inFavor: 19, against: 12, abstentions: 0, blank: 3 },
    result: "rejected",
  },
  {
    name: "Posicionamiento de financiación (point 16), secret vote",
    kind: "positioning",
    counts: { inFavor: 28, against: 2, abstentions: 0, blank: 3 },
    result: "approved",
  },
  {
    name: "RES Reforma Normativa (point 22.1)",
    kind: "resolution",
    counts: { inFavor: 30, against: 2, abstentions: 2 },
    result: "approved",
  },
];

const amendmentVotes: typeof documentVotes = [
  {
    name: "RFCAS USC-3 (point 13), a 9-9 tie",
    kind: "regulation",
    counts: { inFavor: 9, against: 9, abstentions: 14 },
    result: "rejected",
  },
  {
    name: "RFCAS UPM-1 (point 13)",
    kind: "regulation",
    counts: { inFavor: 29, against: 1, abstentions: 2 },
    result: "approved",
  },
  {
    name: "RES Reforma Normativa UAM-1 (point 22.1)",
    kind: "resolution",
    counts: { inFavor: 14, against: 13, abstentions: 7 },
    result: "approved",
  },
  {
    name: "PO Financiación UCA-2 (point 16)",
    kind: "positioning",
    counts: { inFavor: 9, against: 16, abstentions: 9 },
    result: "rejected",
  },
];

describe("computeVoteOutcome against the 77.ª AGO minutes", () => {
  // The minutes counted majorities on the valid votes cast.
  const settings = {
    ...DEFAULT_ASSEMBLY_SETTINGS,
    denominator: "valid_votes" as const,
  };

  it.each(documentVotes)("final vote: $name", ({ kind, counts, result }) => {
    const outcome = computeVoteOutcome(
      counts,
      DOCUMENT_KIND_DEFAULTS[kind].majority,
      settings,
    );
    expect(outcome.result).toBe(result);
  });

  it.each(amendmentVotes)("amendment: $name", ({ kind, counts, result }) => {
    const outcome = computeVoteOutcome(
      counts,
      amendmentVoteMajority(kind),
      settings,
    );
    expect(outcome.result).toBe(result);
  });
});
