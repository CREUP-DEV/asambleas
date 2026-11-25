import type {
  AdmissionStatus,
  AmendmentKind,
  AmendmentStatus,
  ApprovalMethod,
  DocumentKind,
  ProponentPosition,
} from "../../../shared/constants/domain";
import type {
  AmendmentInput,
  AmendmentOp,
  ConsolidationConflict,
} from "../../../shared/types/content";
import {
  agendaChildGroups,
  numberAgendaItems,
} from "../../../shared/utils/agendaNumbering";
import {
  compareAmendmentAnswers,
  compareAmendmentCodes,
} from "../../../shared/utils/amendmentOrder";
import { inApprovalOrder } from "../../../shared/utils/approvalOrder";
import type {
  Passage,
  SupersededChange,
} from "../../../shared/utils/content/passages";
import type {
  ExportAgendaNode,
  ExportAnnexRow,
  ExportVote,
} from "./pdfBuilder";

/**
 * Pure mapping from loaded rows to export data: agenda numbering, document
 * order, amendment codes and the annex. buildData.ts does the I/O.
 */

// Agenda --------------------------------------------------------------------

export interface AgendaRow {
  id: string;
  parentId: string | null;
  title: string;
  description: string | null;
  order: number;
  /**
   * The item carries the title of a document that is not published: the
   * PDF prints a neutral label in its place.
   */
  titleHidden?: boolean;
  /**
   * Someone who sees only what is public does not receive the item
   * (unlistedAgendaItemIds): it has no number.
   */
  unlisted?: boolean;
}

export interface AgendaDocumentRow {
  id: string;
  agendaItemId: string;
  title: string;
  reference: string | null;
  kind: DocumentKind;
}

export interface AgendaTree {
  nodes: ExportAgendaNode[];
  /** Hierarchical number of every item, e.g. "3.1"; null for an unlisted one. */
  numbering: Map<string, string | null>;
  /** Document ids in agenda order (depth first). */
  documentOrder: string[];
}

/**
 * Builds the agenda tree with its numbers, the ones every screen shows
 * (numberAgendaItems): an item marked `unlisted` has none. Items whose
 * parent is missing or caught in a parent cycle are roots, each placed
 * once. Documents keep the order they are given in within an item.
 */
export function buildAgendaTree(
  items: AgendaRow[],
  documents: AgendaDocumentRow[] = [],
): AgendaTree {
  const children = agendaChildGroups(items);
  const numbering = numberAgendaItems(items);

  const documentsByItem = new Map<string, AgendaDocumentRow[]>();
  for (const document of documents) {
    const list = documentsByItem.get(document.agendaItemId) ?? [];
    list.push(document);
    documentsByItem.set(document.agendaItemId, list);
  }

  const documentOrder: string[] = [];
  const walk = (parentId: string | null): ExportAgendaNode[] =>
    (children.get(parentId) ?? []).map((item) => {
      const itemDocuments = documentsByItem.get(item.id) ?? [];
      documentOrder.push(...itemDocuments.map((document) => document.id));
      return {
        numbering: numbering.get(item.id) ?? null,
        title: item.titleHidden ? "" : item.title,
        ...(item.titleHidden ? { titleHidden: true } : {}),
        description: item.description,
        documents: itemDocuments.map((document) => ({
          title: document.title,
          reference: document.reference,
          kind: document.kind,
        })),
        children: walk(item.id),
      };
    });
  const nodes = walk(null);

  const known = new Set(documentOrder);
  for (const document of documents) {
    if (!known.has(document.id)) documentOrder.push(document.id);
  }
  return { nodes, numbering, documentOrder };
}

// Amendments ----------------------------------------------------------------

export interface AnnexAmendment {
  id: string;
  number: number | null;
  code: string | null;
  kind: AmendmentKind;
  status: AmendmentStatus;
  admission: AdmissionStatus;
  late: boolean;
  approvalMethod: ApprovalMethod | null;
  decidedAt: Date | null;
  positionKey: number;
  /**
   * The main presenter's answer. Never printed: it only orders the annex
   * once the document's answers are public (shared/utils/amendmentOrder.ts).
   */
  answer?: ProponentPosition | null;
  /** Acronyms of the presenting members, first author first. */
  authors: string[];
  /** Parents of a transactional. */
  sourceIds: string[];
  /** Transactionals built on this amendment. */
  derivedIds: string[];
  vote:
    | (Pick<
        ExportVote,
        "inFavor" | "against" | "abstentions" | "blank" | "method"
      > & {
        /**
         * Decided in a vote between alternatives: its option («A») and that
         * option's votes, instead of in favour and against.
         */
        alternative?: { option: string; count: number };
      })
    | null;
}

/** Short code shown in superscript in the text: "CEUM 4", "T1" or "12". */
export function amendmentCode(
  amendment: Pick<AnnexAmendment, "code" | "number">,
): string {
  if (amendment.code) return amendment.code;
  return amendment.number !== null ? String(amendment.number) : "?";
}

/** Code in the annex: running number and member code, "12 · CEUM 4". */
export function annexDisplayCode(
  amendment: Pick<AnnexAmendment, "code" | "number">,
): string {
  const parts = [
    amendment.number !== null ? String(amendment.number) : null,
    amendment.code,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : "?";
}

/**
 * Presentation order, as on screen (compareAmendments): the number, then
 * the code (a transactional's "T2" before "T10", compareAmendmentCodes),
 * then the id. The annex has no presentation time; codes are unique per
 * document, so only amendments without a code reach the id.
 */
function byNumber(a: AnnexAmendment, b: AnnexAmendment): number {
  const an = a.number ?? Number.POSITIVE_INFINITY;
  const bn = b.number ?? Number.POSITIVE_INFINITY;
  if (an !== bn) return an - bn;
  if (a.code !== b.code) {
    if (a.code === null) return 1;
    if (b.code === null) return -1;
    const codes = compareAmendmentCodes(a.code, b.code);
    if (codes !== 0) return codes;
  }
  return (
    a.positionKey - b.positionKey || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * The order amendments are shown and debated in (user's decision of
 * 2026-11-19 and 2026-11-20): by answer once the answers are public
 * (shared/utils/amendmentOrder.ts: accepted, transactions, rejected, the
 * rest, rejected formal ones last), then where they act in the text, then
 * presentation order. The annex has no parties: a transactional ranks by
 * the main presenter's own answer.
 */
function inDebateOrder(byAnswer: boolean) {
  return (a: AnnexAmendment, b: AnnexAmendment): number =>
    compareAmendmentAnswers(
      {
        kind: a.kind,
        status: a.status,
        position: a.answer ? { position: a.answer } : null,
      },
      {
        kind: b.kind,
        status: b.status,
        position: b.answer ? { position: b.answer } : null,
      },
      { byAnswer },
    ) ||
    a.positionKey - b.positionKey ||
    byNumber(a, b);
}

/**
 * Approved amendments in the order they were decided, as the final vote
 * applies them (inApprovalOrder).
 */
export function approvalOrder<T extends AnnexAmendment>(amendments: T[]): T[] {
  return inApprovalOrder(
    amendments.filter((amendment) => amendment.status === "approved"),
  );
}

/** What consolidateApproved applies: approved amendments in decision order. */
export function consolidationInput(
  amendments: (AnnexAmendment & { ops: AmendmentOp[] })[],
): AmendmentInput[] {
  return approvalOrder(amendments)
    .filter((amendment) => amendment.ops.length > 0)
    .map(({ id, ops }) => ({ id, ops }));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** Superscript codes by amendment id. */
export function amendmentCodes(
  amendments: AnnexAmendment[],
): Record<string, string> {
  return Object.fromEntries(
    amendments.map((amendment) => [amendment.id, amendmentCode(amendment)]),
  );
}

/**
 * Annex rows for the amendments the requester can see, past draft, in the
 * order they are debated (inDebateOrder; by answer only with
 * `byAnswer`). Codes of related amendments are only listed when those
 * are visible too.
 */
export function buildAnnexRows(input: {
  amendments: AnnexAmendment[];
  visibleIds: Set<string>;
  conflicts: ConsolidationConflict[];
  /** Where approved amendments collide (consolidateApproved). */
  passages?: Passage[];
  /** Approved changes a deletion wins over. */
  superseded?: SupersededChange[];
  /** The document's answers are public (positionsArePublic). */
  byAnswer?: boolean;
}): ExportAnnexRow[] {
  const byId = new Map(
    input.amendments.map((amendment) => [amendment.id, amendment]),
  );
  const visible = (id: string) => input.visibleIds.has(id) && byId.has(id);
  const codeOf = (id: string) => amendmentCode(byId.get(id)!);
  const conflicts = new Map(
    input.conflicts.map((conflict) => [
      conflict.amendmentId,
      conflict.conflictsWith,
    ]),
  );

  return input.amendments
    .filter(
      (amendment) => amendment.status !== "draft" && visible(amendment.id),
    )
    .sort(inDebateOrder(input.byAnswer ?? false))
    .map((amendment) => {
      const derived = amendment.derivedIds.filter(visible);
      const approvedDerived = derived.filter(
        (id) => byId.get(id)!.status === "approved",
      );
      const collisions = conflicts.get(amendment.id);
      const passage = input.passages?.find(
        (item) =>
          item.status !== "automatic" &&
          item.status !== "merged" &&
          item.amendmentIds.includes(amendment.id),
      );
      return {
        id: amendment.id,
        displayCode: annexDisplayCode(amendment),
        authors: amendment.authors,
        kind: amendment.kind,
        status: amendment.status,
        admission: amendment.admission,
        late: amendment.late,
        approvalMethod: amendment.approvalMethod,
        vote: amendment.vote,
        sourceCodes: amendment.sourceIds.filter(visible).map(codeOf),
        transactedInto: (approvedDerived.length > 0
          ? approvedDerived
          : derived
        ).map(codeOf),
        conflict: collisions
          ? collisions.filter((id) => byId.has(id)).map(codeOf)
          : null,
        supersededBy: unique(
          (input.superseded ?? [])
            .filter((item) => item.amendmentId === amendment.id)
            .map((item) => item.by)
            .filter(visible),
        ).map(codeOf),
        passage: passage
          ? {
              status: passage.status === "worded" ? "worded" : "pending",
              with: passage.amendmentIds
                .filter((id) => id !== amendment.id && visible(id))
                .map(codeOf),
            }
          : null,
      };
    });
}

/**
 * Who presents the document, as the PDF names it: the main presenter, then
 * its co-presenters (already in acronym order). Null when nobody does.
 */
export function presentersLabel(
  mainAcronym: string | null | undefined,
  coAcronyms: readonly string[],
): string | null {
  const acronyms = [
    ...new Set(
      [mainAcronym, ...coAcronyms].filter((acronym): acronym is string =>
        Boolean(acronym),
      ),
    ),
  ];
  return acronyms.length > 0 ? acronyms.join(", ") : null;
}
