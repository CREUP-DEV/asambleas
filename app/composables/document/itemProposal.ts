import type { DocumentKind } from "~~/shared/constants/domain";

/**
 * What a new document under an agenda item probably is, read from the item's
 * title, so the Secretaría only corrects what is off:
 *
 * - "Aprobación, si procede, del Posicionamiento sobre el Sistema de Becas."
 *   → a positioning titled "Posicionamiento sobre el Sistema de Becas";
 * - "Aprobación, si procede, de Resoluciones." → resolutions, no title (the
 *   item gathers several, each with its own);
 * - "Informe de la Presidencia" → a report with that title.
 *
 * The approval formula ("Aprobación, si procede, de...", "Lectura y
 * aprobación del...") and the final full stop are dropped. A title is only
 * proposed for an item without documents yet (one document is usually named
 * after its item) and when the item does not name several of a kind.
 */
export interface ItemProposal {
  kind: DocumentKind | null;
  title: string | null;
}

interface KindRule {
  kind: DocumentKind;
  /** Matches the item title, normalized (lower case, no accents). */
  pattern: RegExp;
  /** The item gathers several documents of the kind (no title then). */
  several?: RegExp | true;
}

/** In order: the first rule that matches decides. */
const KIND_RULES: KindRule[] = [
  // "Seguimiento de Mociones Internas" is one report, not motions.
  { kind: "report", pattern: /^seguimiento\b/ },
  {
    kind: "positioning",
    pattern: /\bposicionamientos?\b/,
    several: /\bposicionamientos\b/,
  },
  {
    kind: "resolution",
    pattern: /\bresolucion(es)?\b/,
    several: /\bresoluciones\b/,
  },
  {
    kind: "internal_motion",
    pattern: /\bmocion(es)?\b/,
    several: /\bmociones\b/,
  },
  {
    kind: "executive_report",
    pattern: /\binformes? ejecutivos?\b/,
    several: /\binformes ejecutivos\b/,
  },
  { kind: "statutes", pattern: /\bestatutos\b/ },
  {
    kind: "regulation",
    pattern: /\breglamentos?\b/,
    several: /\breglamentos\b/,
  },
  // "Presupuestos 2027" is one document.
  { kind: "budget", pattern: /\bpresupuestos?\b/ },
  { kind: "accounts", pattern: /\bcuentas anuales\b/ },
  {
    kind: "work_plan",
    pattern: /\bplan(es)? de trabajo\b/,
    several: /\bplanes de trabajo\b/,
  },
  {
    kind: "agreement",
    pattern: /\bconvenios?\b/,
    several: /\bconvenios\b/,
  },
  { kind: "minutes", pattern: /\bactas?\b/, several: /\bactas\b/ },
  // Elections gather the candidacies, each a document of its own.
  { kind: "venue", pattern: /\bsede\b/, several: true },
  { kind: "candidacy", pattern: /\b(eleccion|candidatura)/, several: true },
  {
    kind: "report",
    pattern: /\binformes?\b/,
    several: /\binformes\b/,
  },
];

const APPROVAL_FORMULA =
  /^(lectura y )?aprobaci[oó]n,?\s*(si procede,?\s*)?(de la |de las |de los |del |de )?/i;

const TITLE_MAX = 300;

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("es");
}

/** The item title without the approval formula and the final full stop. */
export function titleFromItemTitle(itemTitle: string): string | null {
  const stripped = itemTitle
    .trim()
    .replace(/\.+$/, "")
    .replace(APPROVAL_FORMULA, "")
    .trim();
  if (!stripped || stripped.length > TITLE_MAX) return null;
  return stripped.charAt(0).toLocaleUpperCase("es") + stripped.slice(1);
}

export function proposeFromItem(item: {
  title: string;
  hasDocuments?: boolean;
}): ItemProposal {
  const text = normalize(item.title.trim());
  const rule = KIND_RULES.find((candidate) => candidate.pattern.test(text));
  const several =
    rule?.several === true || (rule?.several?.test(text) ?? false);
  return {
    kind: rule?.kind ?? null,
    title: item.hasDocuments || several ? null : titleFromItemTitle(item.title),
  };
}
