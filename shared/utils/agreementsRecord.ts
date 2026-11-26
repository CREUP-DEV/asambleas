/**
 * The acta de acuerdos (agreements record, user's decisions of 2026-11-21):
 * what the assembly agreed, worded from the platform's votes as CREUP's
 * record of the 79.ª AGO words it, for the Secretaría to read out and have
 * approved in its own agenda item, then sign outside the platform.
 *
 * Pure, so the document the server keeps in step, the Secretaría's panel of
 * corrections and the tests word everything the same way. Results come from
 * the control sheet's rules (isItemVotedDocument, latestItemVote,
 * isUnanimousVote), so the record never disagrees with the sheet nor with
 * the approval line of the PDFs.
 *
 * - Agreements are numbered 1 to N over the agenda items with a result,
 *   never with the agenda's numbers; reports, items still to be voted and
 *   the Mesa's decisions on amendments give none.
 * - A vote reads «, por asentimiento» or «, por unanimidad»; a counted
 *   majority adds nothing, as in the 79.ª (user's decision: its format, with
 *   no counts).
 * - Resolutions, internal motions and executive reports of an item go under
 *   one agreement, «Se aprueban las siguientes resoluciones:» and a), b)…;
 *   the previous minutes, in one sentence; every other document, one each.
 * - A rejection reads «No se aprueba(n) …» in its place.
 * - An election names only the candidacy elected.
 * - The last agreement approves the record itself, once its own final vote
 *   does.
 *
 * The Secretaría corrects any line (`texts`, by key): its words replace the
 * proposed ones, while the suffix still follows the vote, or it leaves the
 * line out. Corrections are data the text is built from again, never edits
 * to it, so they survive every regeneration. The record is document
 * content: always in Spanish.
 */

import type { AssemblyType } from "../constants/assemblyTypes";
import type { DocumentKind, DocumentStatus } from "../constants/domain";
import type { Block, Mark } from "../types/content";
import { ASSEMBLY_NAMES } from "./content/approvalLine";
import { formatLongDate } from "./dates";
import { ENTITY_ID_SOURCE } from "./schemas/primitives";
import {
  isItemVotedDocument,
  isUnanimousVote,
  latestItemVote,
  type SheetItemVote,
  type SheetVote,
} from "./controlSheet";

/** CREUP's legal details, as its records certify them. */
export const CREUP_LEGAL = {
  name: "Coordinadora de Representantes de Estudiantes de Universidades Públicas",
  acronym: "CREUP",
  nif: "G-695324281",
  registry: "171330",
} as const;

/** The office that certifies, until the Secretaría corrects it. */
export const DEFAULT_SECRETARY_TITLE = "Secretaría Ejecutiva";

/** Keys of the header's corrections. */
export const RECORD_HEADER_KEYS = [
  "secretary_name",
  "secretary_title",
  "city",
] as const;
export type RecordHeaderKey = (typeof RECORD_HEADER_KEYS)[number];

/** Keys a correction may name: the header's, or a line's. */
export const RECORD_KEY_PATTERN = new RegExp(
  `^(?:secretary_name|secretary_title|city|self|(?:item|doc|group|minutes):${ENTITY_ID_SOURCE}(?::[a-z_]{1,24}:(?:approved|rejected))?)$`,
);

/** Longest correction. */
export const RECORD_TEXT_MAX_LENGTH = 2000;

/** A correction of the Secretaría. */
export interface RecordText {
  /** Its words for the line, the suffix left out; null keeps the proposal. */
  text: string | null;
  /** The line is left out of the record. */
  omitted: boolean;
}

/** An agenda item as the record reads it, in reading order. */
export interface RecordItem {
  id: string;
  parentId: string | null;
  /** Its title as the public reads it; empty when withheld. */
  title: string;
  /** It carries a number for the public (never an unlisted item). */
  listed: boolean;
}

/** A published document as the record reads it. */
export interface RecordDocument {
  id: string;
  agendaItemId: string;
  kind: DocumentKind;
  title: string;
  status: DocumentStatus;
  voted: boolean;
  finalVote: SheetVote | null;
}

/** A vote on an item itself; an election names its candidates. */
export interface RecordItemVote extends SheetItemVote {
  subjectId: string;
  election: { candidates: string[]; elected: number[] } | null;
}

export interface AgreementsRecordInput {
  assembly: {
    number: number;
    type: AssemblyType;
    startDate: Date | string;
    location: string;
  };
  /** The agenda in reading order (depth first). */
  items: readonly RecordItem[];
  /** Published documents, in the order they were created. */
  documents: readonly RecordDocument[];
  /** Votes on items, voided ones included. */
  itemVotes: readonly RecordItemVote[];
  /** The record's own document: never an agreement of its item. */
  selfDocumentId: string | null;
  /** The record's own final vote. */
  selfVote: SheetVote | null;
  /** Who holds the Secretaría Ejecutiva, as the roster names them. */
  secretaryName: string | null;
  texts: ReadonlyMap<string, RecordText>;
}

/** One line of the record: an agreement, or a lettered line under one. */
export interface RecordLine {
  key: string;
  /** The words proposed, without suffix nor final stop. */
  proposed: string;
  /** «, por asentimiento», «, por unanimidad» or nothing. */
  suffix: string;
  /** What it ends with: «.», or «:» before lettered lines. */
  end: "." | ":";
  /** The Secretaría's words, when it corrected them. */
  corrected: string | null;
  omitted: boolean;
  /** The sentence as the record prints it. */
  text: string;
}

export interface RecordAgreement extends RecordLine {
  /** The agenda item it comes from; null for the record's own approval. */
  itemId: string | null;
  /** Its number in the record; null when it is left out. */
  number: number | null;
  /** Lettered lines (a), b)…), for an agreement over several documents. */
  lines: RecordLine[];
}

export interface RecordHeaderField {
  key: RecordHeaderKey;
  proposed: string;
  corrected: string | null;
  text: string;
}

export interface AgreementsRecord {
  /** «Acta de Acuerdos 80.ª AGO». */
  title: string;
  header: RecordHeaderField[];
  agreements: RecordAgreement[];
}

// Words -----------------------------------------------------------------------

/** «a», «a y b», «a, b y c». */
export function joinWithAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}`;
}

/** «, por asentimiento», «, por unanimidad» or nothing. */
export function voteSuffix(vote: SheetVote): string {
  if (vote.result !== "approved") return "";
  if (vote.method === "assent") {
    return vote.unanimous ? ", por unanimidad" : ", por asentimiento";
  }
  return isUnanimousVote(vote) ? ", por unanimidad" : "";
}

/** The verb of an item's title: «Ratificación…» ratifies, «Elección…» elects. */
const NOMINALIZATIONS: readonly {
  pattern: RegExp;
  singular: string;
  plural: string;
}[] = [
  { pattern: /^ratificaci[oó]n\b/i, singular: "ratifica", plural: "ratifican" },
  { pattern: /^aprobaci[oó]n\b/i, singular: "aprueba", plural: "aprueban" },
  { pattern: /^elecci[oó]n\b/i, singular: "elige", plural: "eligen" },
  { pattern: /^designaci[oó]n\b/i, singular: "designa", plural: "designan" },
];

const DEFAULT_VERB = { singular: "aprueba", plural: "aprueban" };

/** «, si procede,» and what joins the noun to its object. */
const OBJECT_PATTERN =
  /^\S+(?:\s*,\s*si\s+procede\s*,?)?\s*(?:(de\s+(?:la|el|los|las)\s|del\s|de\s)|$)/i;

/**
 * The verb and object of an item's title: «Ratificación de la Mesa de
 * Moderación» → ratifica + «la Mesa de Moderación»; «Aprobación, si
 * procede, del Esquema…» → aprueba + «el Esquema…». Null when the title is
 * not one of those nouns.
 */
export function itemAction(
  title: string,
): { verb: typeof DEFAULT_VERB; object: string } | null {
  const trimmed = title.trim();
  const verb = NOMINALIZATIONS.find((entry) => entry.pattern.test(trimmed));
  if (!verb) return null;
  const match = trimmed.match(OBJECT_PATTERN);
  if (!match) return null;
  let object = trimmed.slice(match[0].length).trim();
  const joint = (match[1] ?? "").trim().toLowerCase();
  if (joint === "del") object = `el ${object}`;
  else if (joint.startsWith("de ")) object = `${joint.slice(3)} ${object}`;
  return {
    verb: { singular: verb.singular, plural: verb.plural },
    object: object.trim(),
  };
}

/** The article a document's title takes, by its first word. */
const ARTICLES: readonly { pattern: RegExp; article: string }[] = [
  {
    pattern:
      /^(?:posicionamiento|informe|convenio|reglamento|esquema|plan|presupuesto|acuerdo|programa|protocolo|estatuto|acta|documento|manifiesto|código|calendario)\b/i,
    article: "el",
  },
  {
    pattern:
      /^(?:resolución|moción|modificación|memoria|liquidación|propuesta|normativa|política|carta|declaración|adenda|reforma|guía|estrategia)\b/i,
    article: "la",
  },
  { pattern: /^(?:cuentas|bases|normas|líneas)\b/i, article: "las" },
  {
    pattern: /^(?:presupuestos|estatutos|informes|acuerdos|estados)\b/i,
    article: "los",
  },
];

/** What only titles a document and is no part of what is agreed. */
const TITLE_WRAPPER = /^certificados?\s+(?:de\s+los|de\s+la|del|de)\s+/i;

/**
 * A document's title as the object of the sentence, with its article:
 * «el Posicionamiento sobre…», «las Cuentas Anuales 2025»; a certificate
 * names what it certifies («el acuerdo de la Comisión Ejecutiva de…»).
 */
export function documentObject(title: string): {
  object: string;
  plural: boolean;
} {
  const bare = title.trim().replace(TITLE_WRAPPER, "");
  const found = ARTICLES.find((entry) => entry.pattern.test(bare));
  if (!found) return { object: bare, plural: false };
  return {
    object: `${found.article} ${bare}`,
    plural: found.article === "las" || found.article === "los",
  };
}

/** An assembly named in a minutes' title: «78.ª AGO», «la 33.ª Asamblea…». */
const ASSEMBLY_REFERENCE =
  /(\d+)\s*\.?\s*[ªº]?\s*(AGET|AGE|AGO|Asamblea\s+General\s+Extraordinaria\s+Telem[aá]tica|Asamblea\s+General\s+Extraordinaria|Asamblea\s+General\s+Ordinaria)\b/i;

function assemblyTypeOf(word: string): AssemblyType {
  const normalized = word
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  if (normalized === "aget" || normalized.includes("telematica")) return "AGET";
  if (normalized === "age" || normalized.includes("extraordinaria")) {
    return "AGE";
  }
  return "AGO";
}

/** The assembly whose minutes a title names, or null. */
export function minutesAssembly(
  title: string,
): { number: number; type: AssemblyType } | null {
  const match = title.match(ASSEMBLY_REFERENCE);
  if (!match) return null;
  return { number: Number(match[1]), type: assemblyTypeOf(match[2]!) };
}

/**
 * The assemblies of several minutes, grouped by type in the order they come:
 * «la 29.ª, 30.ª y 31.ª Asamblea General Extraordinaria Telemática y la
 * 77.ª Asamblea General Ordinaria».
 */
export function minutesAssemblies(
  assemblies: readonly { number: number; type: AssemblyType }[],
): string {
  const byType = new Map<AssemblyType, number[]>();
  for (const assembly of assemblies) {
    const numbers = byType.get(assembly.type) ?? [];
    if (!numbers.includes(assembly.number)) numbers.push(assembly.number);
    byType.set(assembly.type, numbers);
  }
  return joinWithAnd(
    [...byType].map(
      ([type, numbers]) =>
        `la ${joinWithAnd(
          [...numbers].sort((a, b) => a - b).map((number) => `${number}.ª`),
        )} ${ASSEMBLY_NAMES[type]}`,
    ),
  );
}

/** Kinds whose documents an item lists under one agreement, with letters. */
const LISTED_KINDS: Partial<
  Record<DocumentKind, { singular: string; plural: string }>
> = {
  resolution: {
    singular: "la siguiente resolución",
    plural: "las siguientes resoluciones",
  },
  internal_motion: {
    singular: "la siguiente moción interna",
    plural: "las siguientes mociones internas",
  },
  executive_report: {
    singular: "el siguiente informe ejecutivo",
    plural: "los siguientes informes ejecutivos",
  },
};

/** «la candidatura «X»», «las candidaturas «A» y «B»». */
function candidacies(names: readonly string[]): string {
  const quoted = names.map((name) => `«${name.trim()}»`);
  return names.length === 1
    ? `la candidatura ${quoted[0]}`
    : `las candidaturas ${joinWithAnd(quoted)}`;
}

/** «Elección de la Comisión Ejecutiva» → «Comisión Ejecutiva». */
function electedAs(title: string): string | null {
  const match = title
    .trim()
    .match(/^elecci[oó]n\s+(?:(?:de\s+(?:la|el|los|las)|del|de)\s+)?(.+)$/i);
  return match?.[1]?.trim() || null;
}

function sentence(negative: boolean, verb: string, object: string): string {
  return `${negative ? "No se" : "Se"} ${verb} ${object}`.trim();
}

/** The city of «Universidad de León (León)», or the place as written. */
export function locationCity(location: string): string {
  const inside = location.match(/\(([^()]+)\)\s*$/)?.[1]?.trim();
  return inside || location.trim();
}

// Building ------------------------------------------------------------------

interface DraftLine {
  key: string;
  proposed: string;
  suffix: string;
  end: "." | ":";
}

interface DraftAgreement extends DraftLine {
  itemId: string | null;
  lines: DraftLine[];
}

/** A sentence's words, the stop it ends with left out. */
function withoutStop(text: string): string {
  return text.trim().replace(/[.:;,\s]+$/u, "");
}

function finish(
  draft: DraftLine,
  texts: ReadonlyMap<string, RecordText>,
): RecordLine {
  const correction = texts.get(draft.key);
  const corrected = correction?.text?.trim() ? correction.text.trim() : null;
  const words = withoutStop(corrected ?? draft.proposed);
  return {
    ...draft,
    corrected,
    omitted: correction?.omitted ?? false,
    text: `${words}${draft.suffix}${draft.end}`,
  };
}

/** One document of an item as a sentence of its own. */
function documentAgreement(
  document: RecordDocument,
  vote: SheetVote,
  verb: typeof DEFAULT_VERB,
  itemId: string,
): DraftAgreement {
  const { object, plural } = documentObject(document.title);
  return {
    key: `doc:${document.id}`,
    itemId,
    proposed: sentence(
      vote.result !== "approved",
      plural ? verb.plural : verb.singular,
      object,
    ),
    suffix: voteSuffix(vote),
    end: ".",
    lines: [],
  };
}

/** The minutes of an item as one sentence, when they read as one. */
function minutesAgreement(
  rootId: string,
  documents: readonly { document: RecordDocument; vote: SheetVote }[],
): DraftAgreement[] {
  const assemblies = documents.map(({ document }) =>
    minutesAssembly(document.title),
  );
  const suffixes = new Set(documents.map(({ vote }) => voteSuffix(vote)));
  const results = new Set(documents.map(({ vote }) => vote.result));
  const named = assemblies.every((assembly) => assembly !== null);
  if (named && suffixes.size === 1 && results.size === 1) {
    const many = documents.length > 1;
    const negative = !results.has("approved");
    const result = negative ? "rejected" : "approved";
    return [
      {
        key: `minutes:${rootId}:minutes:${result}`,
        itemId: rootId,
        proposed: sentence(
          negative,
          many ? "aprueban las actas de" : "aprueba el acta de",
          minutesAssemblies(
            assemblies as { number: number; type: AssemblyType }[],
          ),
        ),
        suffix: [...suffixes][0]!,
        end: ".",
        lines: [],
      },
    ];
  }
  return documents.map(({ document, vote }, index) => {
    const assembly = assemblies[index];
    const negative = vote.result !== "approved";
    return {
      key: `doc:${document.id}`,
      itemId: rootId,
      proposed: assembly
        ? sentence(
            negative,
            "aprueba el acta de",
            minutesAssemblies([assembly]),
          )
        : sentence(negative, "aprueba", documentObject(document.title).object),
      suffix: voteSuffix(vote),
      end: ".",
      lines: [],
    };
  });
}

/** The agreement of a vote on an item itself, or null while it gives none. */
/** A candidate that is the answer of a yes-or-no vote, not a name. */
const YES_NO_CANDIDATE = /^(?:s[ií]|no|a\s+favor|en\s+contra)$/i;

/** «Candidatura: X» as the candidacy's name, X. */
const CANDIDACY_TITLE_PREFIX = /^\s*candidaturas?\s*[:.\-–—]\s*/i;

/**
 * The candidacies of an election item: its sub-items holding a candidacy,
 * by their titles without «Candidatura:», as the Mesa's console names them.
 */
function itemCandidacies(
  item: RecordItem,
  subtree: readonly RecordItem[],
  documentsByItem: ReadonlyMap<string, RecordDocument[]>,
): string[] {
  return subtree
    .filter(
      (child) =>
        child.parentId === item.id &&
        (documentsByItem.get(child.id) ?? []).some(
          (document) => document.kind === "candidacy",
        ),
    )
    .map((child) => child.title.replace(CANDIDACY_TITLE_PREFIX, "").trim())
    .filter(Boolean);
}

function itemVoteAgreement(
  item: RecordItem,
  vote: RecordItemVote,
  candidacyNames: readonly string[] = [],
): DraftAgreement | null {
  if (vote.election) {
    let names = vote.election.elected
      .map((index) => vote.election!.candidates[index])
      .filter((name): name is string => Boolean(name?.trim()));
    // A single candidacy voted «Sí» or «No»: «Sí» elects that candidacy.
    if (names.some((name) => YES_NO_CANDIDATE.test(name.trim()))) {
      const yes = names.length === 1 && /^s[ií]$/i.test(names[0]!.trim());
      names = yes && candidacyNames.length === 1 ? [candidacyNames[0]!] : [];
    }
    if (names.length === 0) return null;
    const as = electedAs(item.title);
    return {
      key: `item:${item.id}`,
      itemId: item.id,
      proposed: `Se elige${as ? ` como ${as}` : ""} a ${candidacies(names)}`,
      suffix: vote.method === "assent" ? voteSuffix(vote) : "",
      end: ".",
      lines: [],
    };
  }
  const action = itemAction(item.title);
  const negative = vote.result !== "approved";
  return {
    key: `item:${item.id}`,
    itemId: item.id,
    proposed: action
      ? sentence(negative, action.verb.singular, action.object)
      : sentence(negative, "aprueba", `el punto «${item.title.trim()}»`),
    suffix: voteSuffix(vote),
    end: ".",
    lines: [],
  };
}

/** What one root item of the agenda agreed, in reading order. */
function rootAgreements(
  root: RecordItem,
  subtree: readonly RecordItem[],
  documentsByItem: ReadonlyMap<string, RecordDocument[]>,
  votesByItem: ReadonlyMap<string, RecordItemVote[]>,
): DraftAgreement[] {
  const verb = itemAction(root.title)?.verb ?? DEFAULT_VERB;
  const out: DraftAgreement[] = [];
  const minutes: { document: RecordDocument; vote: SheetVote }[] = [];
  let minutesAt = -1;
  const groups = new Map<string, DraftAgreement>();

  for (const item of subtree) {
    const documents = documentsByItem.get(item.id) ?? [];
    const voted = documents.filter(isItemVotedDocument);
    if (voted.length === 0) {
      const vote = latestItemVote(votesByItem.get(item.id) ?? []);
      const agreement = vote
        ? itemVoteAgreement(
            item,
            vote,
            itemCandidacies(item, subtree, documentsByItem),
          )
        : null;
      if (agreement) out.push(agreement);
      continue;
    }
    for (const document of voted) {
      const vote = document.finalVote;
      if (!vote) continue;
      if (document.kind === "minutes") {
        if (minutesAt < 0) minutesAt = out.length;
        minutes.push({ document, vote });
        continue;
      }
      const listed = LISTED_KINDS[document.kind];
      if (!listed) {
        out.push(documentAgreement(document, vote, verb, root.id));
        continue;
      }
      const negative = vote.result !== "approved";
      const result = negative ? "rejected" : "approved";
      const key = `group:${root.id}:${document.kind}:${result}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          itemId: root.id,
          proposed: "",
          suffix: "",
          end: ":",
          lines: [],
        };
        groups.set(key, group);
        out.push(group);
      }
      group.lines.push({
        key: `doc:${document.id}`,
        proposed: document.title.trim(),
        suffix: voteSuffix(vote),
        end: ".",
      });
    }
  }

  for (const group of groups.values()) {
    const [, , kind, result] = group.key.split(":") as [
      string,
      string,
      DocumentKind,
      string,
    ];
    const words = LISTED_KINDS[kind]!;
    const many = group.lines.length > 1;
    group.proposed = sentence(
      result === "rejected",
      many ? DEFAULT_VERB.plural : DEFAULT_VERB.singular,
      many ? words.plural : words.singular,
    );
  }
  if (minutes.length > 0) {
    out.splice(minutesAt, 0, ...minutesAgreement(root.id, minutes));
  }
  return out;
}

/** The record, worded from the assembly's data and the corrections. */
export function agreementsRecord(
  input: AgreementsRecordInput,
): AgreementsRecord {
  const { assembly, texts } = input;
  const listed = input.items.filter((item) => item.listed && item.title.trim());
  const listedIds = new Set(listed.map((item) => item.id));

  const documentsByItem = new Map<string, RecordDocument[]>();
  for (const document of input.documents) {
    if (document.id === input.selfDocumentId) continue;
    if (!listedIds.has(document.agendaItemId)) continue;
    const list = documentsByItem.get(document.agendaItemId) ?? [];
    list.push(document);
    documentsByItem.set(document.agendaItemId, list);
  }
  const votesByItem = new Map<string, RecordItemVote[]>();
  for (const vote of input.itemVotes) {
    if (!listedIds.has(vote.subjectId)) continue;
    const list = votesByItem.get(vote.subjectId) ?? [];
    list.push(vote);
    votesByItem.set(vote.subjectId, list);
  }

  // Each root item with the items under it, in reading order.
  const byId = new Map(input.items.map((item) => [item.id, item]));
  const rootOf = (item: RecordItem): string => {
    let current = item;
    const seen = new Set<string>([current.id]);
    while (current.parentId) {
      const parent = byId.get(current.parentId);
      if (!parent || seen.has(parent.id)) break;
      seen.add(parent.id);
      current = parent;
    }
    return current.id;
  };
  const subtrees = new Map<string, RecordItem[]>();
  for (const item of listed) {
    const root = rootOf(item);
    const list = subtrees.get(root) ?? [];
    list.push(item);
    subtrees.set(root, list);
  }

  const drafts: DraftAgreement[] = [];
  for (const [rootId, subtree] of subtrees) {
    const root = byId.get(rootId);
    if (!root || !listedIds.has(rootId)) continue;
    drafts.push(...rootAgreements(root, subtree, documentsByItem, votesByItem));
  }
  if (input.selfVote?.result === "approved") {
    drafts.push({
      key: "self",
      itemId: null,
      proposed: "Se aprueba el acta de acuerdos",
      suffix: voteSuffix(input.selfVote),
      end: ".",
      lines: [],
    });
  }

  let number = 0;
  const agreements = drafts.map((draft): RecordAgreement => {
    const line = finish(draft, texts);
    const lines = draft.lines.map((sub) => finish(sub, texts));
    const empty = lines.length > 0 && lines.every((sub) => sub.omitted);
    const omitted = line.omitted || empty;
    return {
      ...line,
      omitted,
      itemId: draft.itemId,
      number: omitted ? null : ++number,
      lines,
    };
  });

  const header = (
    key: RecordHeaderKey,
    proposed: string,
  ): RecordHeaderField => {
    const corrected = texts.get(key)?.text?.trim() || null;
    return { key, proposed, corrected, text: corrected ?? proposed };
  };
  return {
    title: `Acta de Acuerdos ${assembly.number}.ª ${assembly.type}`,
    header: [
      header("secretary_name", input.secretaryName?.trim() || "[Nombre]"),
      header("secretary_title", DEFAULT_SECRETARY_TITLE),
      header("city", locationCity(assembly.location)),
    ],
    agreements,
  };
}

// Blocks --------------------------------------------------------------------

function headerText(record: AgreementsRecord, key: RecordHeaderKey): string {
  return record.header.find((field) => field.key === key)?.text ?? "";
}

/** Marks over each of `parts` where it first appears in `text`. */
function marksOver(
  text: string,
  type: Mark["type"],
  parts: readonly string[],
): Mark[] {
  return parts.flatMap((part) => {
    const from = text.indexOf(part);
    return from < 0 ? [] : [{ type, from, to: from + part.length }];
  });
}

function paragraph(
  id: string,
  text: string,
  marks: Mark[] = [],
  align?: Block["align"],
): Block {
  return { id, type: "paragraph", text, marks, ...(align ? { align } : {}) };
}

/** A short, stable hash of a key (djb2), for ids that would run too long. */
function keyHash(key: string): string {
  let hash = 5381;
  for (let index = 0; index < key.length; index++) {
    hash = ((hash << 5) + hash + key.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

/** Ids stay the same from one regeneration to the next. */
function blockId(key: string): string {
  const id = `ar-${key.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
  return id.length <= 40
    ? id
    : `${id.slice(0, 32)}-${keyHash(key)}`.slice(0, 40);
}

/**
 * The blocks that close the record, in order: the closing formula, the name
 * and the office of whoever certifies, these two in the signature's box
 * since 2026-11-24 (SIGNATURE_CELL). The PDF keeps them together on one
 * page with the signature between the formula and the name (pdfBuilder.ts);
 * versions written before 2026-11-23 also hold empty `ar-signature-*`
 * paragraphs there, and later ones the room's blank lines
 * (RECORD_SIGNATURE_ROOM_IDS), which it drops.
 */
export const RECORD_CLOSING_BLOCK_IDS = [
  "ar-closing",
  "ar-signer",
  "ar-signer-office",
] as const;

/** The empty paragraphs older versions kept for the signature. */
export const RECORD_SIGNATURE_SPACER = /^ar-signature-\d+$/;

/**
 * The blank lines above the signature's box since 2026-11-24, the room the
 * web text leaves for it. The PDF leaves its own (the signature's height)
 * and skips them; unlike the older spacers, they are part of the record.
 */
export const RECORD_SIGNATURE_ROOM_IDS = ["ar-room-1", "ar-room-2"] as const;

/**
 * A stored version's blocks without those empty paragraphs, to compare it
 * with the record as it reads now; null when it has none.
 */
export function dropSignatureSpacers<T extends { id: string }>(
  blocks: readonly T[],
): T[] | null {
  if (!blocks.some((block) => RECORD_SIGNATURE_SPACER.test(block.id))) {
    return null;
  }
  return blocks.filter((block) => !RECORD_SIGNATURE_SPACER.test(block.id));
}

/**
 * The record as the document's text, after CREUP's template: the
 * certification, the agreements as a numbered list (lettered lines under
 * theirs), the closing formula and the name and office of whoever signs;
 * the PDF puts the signature above the name. The title is the document's
 * own.
 */
export function agreementsRecordBlocks(
  record: AgreementsRecord,
  assembly: AgreementsRecordInput["assembly"],
): Block[] {
  const name = headerText(record, "secretary_name");
  const office = headerText(record, "secretary_title");
  const city = headerText(record, "city");
  const association = `${CREUP_LEGAL.name}-${CREUP_LEGAL.acronym}`;
  const registry = `${CREUP_LEGAL.registry},`;
  const opening = `Por medio de la presente, ${name}, en calidad de ${office} de la ${association}, NIF ${CREUP_LEGAL.nif} e inscrita en el Registro nacional de Asociaciones con el número ${registry} certifica:`;
  const convened = `Que conforme a la normativa interna de la Asociación fue convocada para el ${formatLongDate(assembly.startDate, "es-ES")} la ${assembly.number}.ª ${ASSEMBLY_NAMES[assembly.type]} en ${city}.`;
  const quorum =
    "Que, habiendo quorum, se tomaron los acuerdos que constan a continuación:";

  const blocks: Block[] = [
    paragraph(
      "ar-opening",
      opening,
      marksOver(opening, "bold", [association, CREUP_LEGAL.nif, registry]),
    ),
    paragraph("ar-convened", convened),
    paragraph("ar-quorum", quorum, marksOver(quorum, "italic", ["quorum"])),
  ];

  for (const agreement of record.agreements) {
    if (agreement.omitted) continue;
    blocks.push({
      id: blockId(agreement.key),
      type: "list_item",
      list: "ordered",
      level: 0,
      text: agreement.text,
      marks: [],
    });
    let first = true;
    for (const line of agreement.lines) {
      if (line.omitted) continue;
      blocks.push({
        id: blockId(line.key),
        type: "list_item",
        list: "ordered",
        marker: "a)",
        level: 1,
        ...(first ? { start: 1 } : {}),
        text: line.text,
        marks: [],
      });
      first = false;
    }
  }

  blocks.push(...signatureClosingBlocks(name, office));
  return blocks;
}

/**
 * The closing of a text Secretaría signs: the formula, the room for the
 * signature, then the name and office of whoever certifies in the
 * signature's box (RECORD_CLOSING_BLOCK_IDS). The acta de acuerdos ends its
 * own text with it; an approved acta gets it only in the PDF made to be
 * signed (documentSigning.ts, user's decision of 2026-11-26).
 */
export function signatureClosingBlocks(name: string, office: string): Block[] {
  const signatureOffice = `${office} de la ${CREUP_LEGAL.name}`;
  return [
    paragraph(
      "ar-closing",
      "Para que conste a los efectos oportunos, a fecha de la firma digital.",
    ),
    ...RECORD_SIGNATURE_ROOM_IDS.map((id) => paragraph(id, "")),
    {
      ...paragraph(
        "ar-signer",
        name,
        [{ type: "bold", from: 0, to: name.length }],
        "center",
      ),
      cell: { ...SIGNATURE_CELL },
    },
    {
      ...paragraph(
        "ar-signer-office",
        signatureOffice,
        [{ type: "italic", from: 0, to: signatureOffice.length }],
        "center",
      ),
      cell: { ...SIGNATURE_CELL },
    },
  ];
}

/**
 * The box the name and office sit in, as a Word signature is (user's
 * decision of 2026-11-24): half the text's width, centred, its only rule a
 * thick line above the name, where the signature goes.
 */
const SIGNATURE_CELL: NonNullable<Block["cell"]> = {
  table: "ar-signature-box",
  row: "ar-signature-row",
  cell: "ar-signature-cell",
  borders: { top: "thick", right: "none", bottom: "none", left: "none" },
  tableWidth: 50,
  tableAlign: "center",
};
