/**
 * The sections of an assembly, in one list: the sidebar block, the phone
 * toolbar of the hub and the breadcrumb all read it, so they show the same
 * sections to the same people.
 */

/**
 * Route segment of each section under `/asambleas/<slug>`. Pages under
 * app/pages/asambleas/[assembly]/ must live at these paths.
 */
export const ASSEMBLY_SECTION_SEGMENTS = {
  overview: "",
  live: "directo",
  agenda: "orden-del-dia",
  documents: "documentos",
  validation: "validacion",
  tracking: "seguimiento",
  agreements: "acta-de-acuerdos",
  calendar: "calendario",
  convocation: "convocatoria",
  session: "sesion",
  controlSheet: "hoja-de-control",
  seating: "sala",
  settings: "ajustes",
} as const;

/** A section with a page inside the hub. */
export type AssemblySection = keyof typeof ASSEMBLY_SECTION_SEGMENTS;

/** Every entry of the menu: the projection opens outside the hub. */
export type AssemblySectionKey = AssemblySection | "projection";

export type AssemblySectionGroup = "assembly" | "secretariat" | "mesa";

export interface AssemblySectionDef {
  key: AssemblySectionKey;
  group: AssemblySectionGroup;
  icon: string;
}

/** In menu order: the assembly, then the Secretaría, then the Mesa. */
export const ASSEMBLY_SECTION_DEFS: readonly AssemblySectionDef[] = [
  { key: "overview", group: "assembly", icon: "i-lucide-layout-dashboard" },
  // The attendees' live view, for everyone at any time: before and after
  // the session the page says so, so links to it never break.
  { key: "live", group: "assembly", icon: "i-lucide-radio" },
  { key: "agenda", group: "assembly", icon: "i-lucide-list-tree" },
  { key: "documents", group: "assembly", icon: "i-lucide-files" },
  { key: "calendar", group: "assembly", icon: "i-lucide-calendar-days" },
  { key: "convocation", group: "assembly", icon: "i-lucide-scroll-text" },
  { key: "validation", group: "secretariat", icon: "i-lucide-inbox" },
  { key: "tracking", group: "secretariat", icon: "i-lucide-list-checks" },
  // The acta de acuerdos, worded from the votes (user's decision of
  // 2026-11-21): the Secretaría creates and corrects it.
  { key: "agreements", group: "secretariat", icon: "i-lucide-file-check-2" },
  { key: "settings", group: "secretariat", icon: "i-lucide-settings" },
  { key: "session", group: "mesa", icon: "i-lucide-gavel" },
  // Everyone reads it (user's decision of 2026-11-19): whoever has no
  // Secretaría or Mesa section sees it in its single list, since it is not
  // one of the STAFF_SECTIONS that turn groups on; its notes, turns and
  // history only whoever holds a sheet key (ControlSheetDto.can.internal).
  { key: "controlSheet", group: "mesa", icon: "i-lucide-sheet" },
  // The room and who sits where: the CEA lays it out with the Mesa, so like
  // the control sheet it is not a staff section.
  { key: "seating", group: "mesa", icon: "i-lucide-armchair" },
  // Opens on its own window, typically on the projector. Everyone may open
  // it, so without the Mesa's console it sits in the single list.
  { key: "projection", group: "mesa", icon: "i-lucide-presentation" },
];

/** What the viewer may do in the assembly. */
export interface AssemblySectionAccess {
  /** `document:manage`: validates documents and follows their tracking. */
  validateDocuments: boolean;
  /** reviewsAmendments: amendment:review, or amendment:manage, which holds it. */
  reviewAmendments: boolean;
  /** `AssemblyDto.can.manage`. */
  manage: boolean;
  /** `AssemblyDto.can.moderate`. */
  moderate: boolean;
  /** viewsSeating: seating:view, or seating:edit, which holds it (Sala). */
  seating: boolean;
  /** The assembly is held online (an AGET): it has no room. */
  online: boolean;
}

function isVisible(
  key: AssemblySectionKey,
  access: AssemblySectionAccess,
): boolean {
  switch (key) {
    case "validation":
      return access.validateDocuments || access.reviewAmendments;
    case "tracking":
    case "agreements":
      return access.validateDocuments;
    case "settings":
      return access.manage;
    case "session":
      return access.moderate;
    case "seating":
      return access.seating && !access.online;
    default:
      return true;
  }
}

/** The sections the viewer sees, in menu order. */
export function visibleAssemblySections(
  access: AssemblySectionAccess,
): AssemblySectionDef[] {
  return ASSEMBLY_SECTION_DEFS.filter((section) =>
    isVisible(section.key, access),
  );
}

/** Sections only the Secretaría or the Mesa get: they turn the groups on. */
const STAFF_SECTIONS: ReadonlySet<AssemblySectionKey> = new Set([
  "validation",
  "tracking",
  "agreements",
  "settings",
  "session",
]);

export interface AssemblySectionGroupDef {
  /** Null for the single list of someone with no Secretaría or Mesa section. */
  group: AssemblySectionGroup | null;
  sections: AssemblySectionDef[];
}

/**
 * The visible sections under their group titles. Whoever has none of the
 * Secretaría's or the Mesa's sections gets one list without titles.
 */
export function groupAssemblySections(
  sections: readonly AssemblySectionDef[],
): AssemblySectionGroupDef[] {
  if (sections.length === 0) return [];
  if (!sections.some((section) => STAFF_SECTIONS.has(section.key))) {
    return [{ group: null, sections: [...sections] }];
  }
  const groups: AssemblySectionGroupDef[] = [];
  for (const section of sections) {
    const last = groups[groups.length - 1];
    if (last && last.group === section.group) last.sections.push(section);
    else groups.push({ group: section.group, sections: [section] });
  }
  return groups;
}

/** Unlocalized path of an assembly section: `/asambleas/80-ago/sesion`. */
export function assemblyPath(
  slug: string,
  section: AssemblySection = "overview",
): string {
  const segment = ASSEMBLY_SECTION_SEGMENTS[section];
  const base = `/asambleas/${encodeURIComponent(slug)}`;
  return segment ? `${base}/${segment}` : base;
}

/** Unlocalized path of the chrome-free projection view. */
export function projectionPath(slug: string): string {
  return `/proyeccion/${encodeURIComponent(slug)}`;
}

/** Unlocalized path of any menu entry, the projection included. */
export function assemblySectionPath(
  slug: string,
  key: AssemblySectionKey,
): string {
  return key === "projection" ? projectionPath(slug) : assemblyPath(slug, key);
}
