import type {
  AdmissionStatus,
  AmendmentKind,
  AmendmentStatus,
  ApprovalMethod,
  DocumentKind,
} from "../../../shared/constants/domain";
import type {
  AmendmentInput,
  AmendmentOp,
  ConsolidationConflict,
} from "../../../shared/types/content";
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
  /** Hierarchical number of every item, e.g. "3.1". */
  numbering: Map<string, string>;
  /** Document ids in agenda order (depth first). */
  documentOrder: string[];
}

/**
 * Builds the agenda tree with hierarchical numbering. Items whose parent is
 * missing are treated as roots, and a cycle never loops: every item is
 * placed once. Documents keep the order they are given in within an item.
 */
export function buildAgendaTree(
  items: AgendaRow[],
  documents: AgendaDocumentRow[] = [],
): AgendaTree {
  const ids = new Set(items.map((item) => item.id));
  const children = new Map<string | null, AgendaRow[]>();
  for (const item of items) {
    const parent =
      item.parentId && ids.has(item.parentId) ? item.parentId : null;
    const list = children.get(parent) ?? [];
    list.push(item);
    children.set(parent, list);
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }

  const documentsByItem = new Map<string, AgendaDocumentRow[]>();
  for (const document of documents) {
    const list = documentsByItem.get(document.agendaItemId) ?? [];
    list.push(document);
    documentsByItem.set(document.agendaItemId, list);
  }

  const numbering = new Map<string, string>();
  const documentOrder: string[] = [];
  const placed = new Set<string>();

  const place = (item: AgendaRow, number: string): ExportAgendaNode => {
    placed.add(item.id);
    numbering.set(item.id, number);
    const itemDocuments = documentsByItem.get(item.id) ?? [];
    documentOrder.push(...itemDocuments.map((document) => document.id));
    return {
      numbering: number,
      title: item.title,
      description: item.description,
      documents: itemDocuments.map((document) => ({
        title: document.title,
        reference: document.reference,
        kind: document.kind,
      })),
      children: walk(item.id, number),
    };
  };

  function walk(parentId: string | null, prefix: string): ExportAgendaNode[] {
    const nodes: ExportAgendaNode[] = [];
    for (const item of children.get(parentId) ?? []) {
      if (placed.has(item.id)) continue;
      const position = String(nodes.length + 1);
      nodes.push(place(item, prefix ? `${prefix}.${position}` : position));
    }
    return nodes;
  }

  const nodes = walk(null, "");
  // Items caught in a parent cycle never hang from a root: they become roots.
  for (const item of [...items].sort((a, b) => a.order - b.order)) {
    if (!placed.has(item.id)) nodes.push(place(item, String(nodes.length + 1)));
  }

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
  /** Acronyms of the presenting members, first author first. */
  authors: string[];
  /** Parents of a transactional. */
  sourceIds: string[];
  /** Transactionals built on this amendment. */
  derivedIds: string[];
  vote: Pick<ExportVote, "inFavor" | "against" | "abstentions"> | null;
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

function byNumber(a: AnnexAmendment, b: AnnexAmendment): number {
  const an = a.number ?? Number.POSITIVE_INFINITY;
  const bn = b.number ?? Number.POSITIVE_INFINITY;
  if (an !== bn) return an - bn;
  return a.positionKey - b.positionKey || a.id.localeCompare(b.id);
}

/** Approved amendments in the order they were decided, as consolidate expects. */
export function approvalOrder<T extends AnnexAmendment>(amendments: T[]): T[] {
  return amendments
    .filter((amendment) => amendment.status === "approved")
    .sort((a, b) => {
      const at = a.decidedAt?.getTime() ?? Number.POSITIVE_INFINITY;
      const bt = b.decidedAt?.getTime() ?? Number.POSITIVE_INFINITY;
      return at - bt || byNumber(a, b);
    });
}

/**
 * What consolidate applies: approved amendments in decision order. An
 * approved totality return has no operations and changes no text, so it is
 * left out rather than reported as no longer fitting the base.
 */
export function consolidationInput(
  amendments: (AnnexAmendment & { ops: AmendmentOp[] })[],
): AmendmentInput[] {
  return approvalOrder(amendments)
    .filter((amendment) => amendment.ops.length > 0)
    .map(({ id, ops }) => ({ id, ops }));
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
 * Annex rows for the amendments the requester can see, past draft, by
 * running number. Codes of related amendments are only listed when those
 * are visible too.
 */
export function buildAnnexRows(input: {
  amendments: AnnexAmendment[];
  visibleIds: Set<string>;
  conflicts: ConsolidationConflict[];
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
    .sort(byNumber)
    .map((amendment) => {
      const derived = amendment.derivedIds.filter(visible);
      const approvedDerived = derived.filter(
        (id) => byId.get(id)!.status === "approved",
      );
      const collisions = conflicts.get(amendment.id);
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
      };
    });
}
