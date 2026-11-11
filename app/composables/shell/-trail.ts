import {
  ASSEMBLY_SECTION_SEGMENTS,
  type AssemblySection,
} from "../assembly/-sections";

/**
 * The breadcrumb trail of a page, worked out from its path alone. Labels
 * are added by useBreadcrumbs; this part is pure.
 */

export type DocumentView = "edit" | "answers" | "consolidated";

export type TrailStep =
  | { kind: "assemblies"; path: string }
  /** `param` is the decoded `[assembly]` route param (slug or id). */
  | { kind: "assembly"; path: string; param: string }
  | { kind: "section"; path: string; section: AssemblySection }
  /** `param` is the decoded `[document]` route param (slug or id). */
  | { kind: "document"; path: string; param: string }
  | { kind: "documentView"; path: string; view: DocumentView }
  /**
   * The page of one agenda item; `param` is the decoded `[item]` route param
   * (the item's slug, or its id from an older link). The items above it are not in the path: useBreadcrumbs
   * adds them from what the page registers.
   */
  | { kind: "agendaItem"; path: string; param: string }
  | { kind: "myActivity"; path: string };

export interface Trail {
  /** From the top level down. Paths are unlocalized. */
  steps: TrailStep[];
  /**
   * True when the last step is the page itself. False when the path goes
   * deeper than the steps known here: the last step is then an ancestor
   * and stays a link.
   */
  exact: boolean;
}

const DOCUMENT_VIEWS: Record<string, DocumentView> = {
  editar: "edit",
  revisar: "answers",
  consolidado: "consolidated",
};

const SECTION_BY_SEGMENT = new Map<string, AssemblySection>(
  (
    Object.entries(ASSEMBLY_SECTION_SEGMENTS) as [AssemblySection, string][]
  ).flatMap(([section, segment]) =>
    segment ? [[segment, section] as const] : [],
  ),
);

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** `/en/asambleas` to `/asambleas`: the path without its locale prefix. */
export function stripLocalePrefix(
  path: string,
  localeCodes: readonly string[],
): string {
  const [, first, ...rest] = path.split("/");
  if (first && localeCodes.includes(first)) return `/${rest.join("/")}`;
  return path;
}

/** The trail of an unlocalized path. The home page and unknown pages have none. */
export function breadcrumbTrail(path: string): Trail {
  const segments = path.split(/[?#]/)[0]!.split("/").filter(Boolean);
  const steps: TrailStep[] = [];
  const pathTo = (count: number) => `/${segments.slice(0, count).join("/")}`;
  const done = (consumed: number): Trail => ({
    steps,
    exact: consumed === segments.length,
  });

  const [root, second, third, fourth, fifth] = segments;

  if (root === "actividad") {
    steps.push({ kind: "myActivity", path: pathTo(1) });
    return done(1);
  }

  // The administration pages have no trail: they hang straight from the
  // sidebar, which names the section, and their navbar names the page.
  if (root !== "asambleas") return { steps: [], exact: false };

  steps.push({ kind: "assemblies", path: pathTo(1) });
  if (!second) return done(1);

  steps.push({ kind: "assembly", path: pathTo(2), param: decode(second) });
  const section = third ? SECTION_BY_SEGMENT.get(third) : undefined;
  if (!section) return done(2);

  steps.push({ kind: "section", path: pathTo(3), section });
  if (section === "agenda" && fourth) {
    steps.push({ kind: "agendaItem", path: pathTo(4), param: decode(fourth) });
    return done(4);
  }
  if (section !== "documents" || !fourth) return done(3);

  steps.push({ kind: "document", path: pathTo(4), param: decode(fourth) });
  const view = fifth ? DOCUMENT_VIEWS[fifth] : undefined;
  if (!view) return done(4);

  steps.push({ kind: "documentView", path: pathTo(5), view });
  return done(5);
}

/** Cuts a long label at a word when it can: "Resolución sobre la…". */
export function truncateLabel(label: string, max = 48): string {
  const text = label.trim().replace(/\s+/g, " ");
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const head = lastSpace >= max / 2 ? cut.slice(0, lastSpace) : cut;
  return `${head.replace(/[\s.,;:]+$/, "")}…`;
}
