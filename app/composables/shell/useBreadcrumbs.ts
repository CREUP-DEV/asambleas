import type { MaybeRefOrGetter } from "vue";
import type { AssemblyDto } from "~~/shared/types/api";
import { ASSEMBLY_SECTION_SEGMENTS } from "../assembly/-sections";
import {
  breadcrumbTrail,
  stripLocalePrefix,
  truncateLabel,
  type TrailStep,
} from "./-trail";

/**
 * Breadcrumbs of the page on show (ShellBreadcrumbs). The trail comes from
 * the route (see `-trail.ts`); the assembly's label comes from the state the
 * hub's route middleware fills during SSR, so the first HTML has it.
 *
 * A document's name is only known to the page that loads the document, and
 * that page renders after the breadcrumb row. So it is registered on the
 * client only, once mounted (useDocumentBreadcrumb): the server and the
 * hydration both render the generic "Document", and the name replaces it
 * right after. Nothing is fetched for it.
 *
 * The page of an agenda item works the same way (useAgendaItemBreadcrumb):
 * the path only carries the item's id, so the page registers the items from
 * the root one down to itself ("3. Resoluciones"), and the row shows the
 * generic "Item" until then.
 *
 * A document hangs from an agenda item, and that is where its trail leads:
 * "Orden del día > 3. Resoluciones > RES 4", whatever page it was opened
 * from, so the way back from a document is always the item it belongs to.
 * useDocumentBreadcrumb registers those items too, from the agenda; until
 * then, and for a document whose item the viewer does not get, the trail is
 * the route's ("Documentos > RES 4").
 */

export interface Breadcrumb {
  label: string;
  /** Localized path. */
  to: string;
  /** True for the page on show: it is not a link. */
  current: boolean;
}

/** Names registered by pages, by `document:<slug or id>`. Client only. */
const LABELS_STATE_KEY = "breadcrumb-labels";

function useBreadcrumbLabels() {
  return useState<Record<string, string>>(LABELS_STATE_KEY, () => ({}));
}

/** One agenda item of a trail: its key in the URL and its numbered title. */
export interface AgendaItemCrumb {
  /** The item's slug (AgendaItemDto.slug), the `[item]` route param. */
  id: string;
  /** "3. Resoluciones" */
  label: string;
}

/**
 * The items above an agenda item and the item itself (last), by the id of
 * that item. Registered by its page. Client only.
 */
const AGENDA_CHAINS_STATE_KEY = "breadcrumb-agenda-items";

function useAgendaItemChains() {
  return useState<Record<string, AgendaItemCrumb[]>>(
    AGENDA_CHAINS_STATE_KEY,
    () => ({}),
  );
}

/**
 * Called by the page of an agenda item with the items from the root one
 * down to itself (last), from the agenda it already loads.
 */
export function useAgendaItemBreadcrumb(
  chain: MaybeRefOrGetter<AgendaItemCrumb[] | null | undefined>,
): void {
  if (import.meta.server) return;
  const chains = useAgendaItemChains();
  const mounted = ref(false);
  onMounted(() => {
    mounted.value = true;
  });
  watch(
    [mounted, () => toValue(chain) ?? null],
    ([isMounted, value]) => {
      const own = value?.[value.length - 1];
      if (!isMounted || !value || !own) return;
      const stored = chains.value[own.id];
      if (
        stored &&
        stored.length === value.length &&
        stored.every(
          (entry, index) =>
            entry.id === value[index]!.id &&
            entry.label === value[index]!.label,
        )
      ) {
        return;
      }
      chains.value = {
        ...chains.value,
        [own.id]: value.map(({ id, label }) => ({ id, label })),
      };
    },
    { immediate: true },
  );
}

/**
 * The agenda items a document hangs from, from the root one down to its
 * own (last), by `document:<slug or id>`. Client only.
 */
const DOCUMENT_CHAINS_STATE_KEY = "breadcrumb-document-items";

function useDocumentItemChains() {
  return useState<Record<string, AgendaItemCrumb[]>>(
    DOCUMENT_CHAINS_STATE_KEY,
    () => ({}),
  );
}

function sameChain(
  a: readonly AgendaItemCrumb[] | undefined,
  b: readonly AgendaItemCrumb[],
): boolean {
  return (
    a !== undefined &&
    a.length === b.length &&
    a.every(
      (entry, index) =>
        entry.id === b[index]!.id && entry.label === b[index]!.label,
    )
  );
}

/** The document slice of DocumentDto the breadcrumb needs. */
interface BreadcrumbDocument {
  id: string;
  slug: string;
  title: string;
  reference: string | null;
  agendaItemId: string;
}

/**
 * Called by the pages of a document with the DTO they already load. When it
 * is the only document of its agenda item (its own automatic sub-item, or a
 * point such as "15. Aprobación, si procede, del Posicionamiento…") that item
 * already names it, so its own step says just "Ver"; among several, the step
 * is its title. Never its reference.
 */
export function useDocumentBreadcrumb(
  document: MaybeRefOrGetter<BreadcrumbDocument | null | undefined>,
): void {
  if (import.meta.server) return;
  const labels = useBreadcrumbLabels();
  const { t } = useI18n();
  const { data: agenda } = useAssemblyAgenda();
  const mounted = ref(false);
  onMounted(() => {
    mounted.value = true;
  });
  watch(
    [
      mounted,
      () => {
        const value = toValue(document);
        if (!value) return null;
        const siblings = agenda.value?.documents.filter(
          (other) => other.agendaItemId === value.agendaItemId,
        );
        const alone = siblings?.length === 1 && siblings[0]!.id === value.id;
        return [
          value.id,
          value.slug,
          alone ? t("shell.breadcrumb.view") : value.title,
        ] as const;
      },
    ],
    ([isMounted, entry]) => {
      if (!isMounted || !entry) return;
      const [id, slug, label] = entry;
      if (
        labels.value[`document:${id}`] === label &&
        labels.value[`document:${slug}`] === label
      ) {
        return;
      }
      // The route names a document by slug or by id.
      labels.value = {
        ...labels.value,
        [`document:${id}`]: label,
        [`document:${slug}`]: label,
      };
    },
    { immediate: true },
  );

  // The items it hangs from, from the agenda the hub pages share.
  const chains = useDocumentItemChains();
  watch(
    [
      mounted,
      () => {
        const value = toValue(document);
        const items = agenda.value?.items;
        if (!value || !items) return null;
        const chain = agendaNodePath(
          buildAgendaTree(items),
          value.agendaItemId,
        ).map((node) => ({
          id: node.item.slug,
          label: numberedAgendaTitle(
            node.number,
            node.item.title,
            t("agenda.unlisted.inText"),
          ),
        }));
        return { id: value.id, slug: value.slug, chain };
      },
    ],
    ([isMounted, entry]) => {
      if (!isMounted || !entry || entry.chain.length === 0) return;
      const keys = [`document:${entry.id}`, `document:${entry.slug}`];
      if (keys.every((key) => sameChain(chains.value[key], entry.chain))) {
        return;
      }
      chains.value = {
        ...chains.value,
        ...Object.fromEntries(keys.map((key) => [key, entry.chain])),
      };
    },
    { immediate: true },
  );
}

export function useBreadcrumbs() {
  const { t, locales } = useI18n();
  const localePath = useLocalePath();
  const route = useRoute();
  const labels = useBreadcrumbLabels();
  const agendaChains = useAgendaItemChains();
  const documentChains = useDocumentItemChains();
  const currentAssembly = useState<AssemblyDto | null>(
    "current-assembly",
    () => null,
  );

  const localeCodes = computed(() =>
    locales.value.map((locale) =>
      typeof locale === "string" ? locale : locale.code,
    ),
  );

  function labelOf(step: TrailStep): string {
    switch (step.kind) {
      case "assemblies":
        return t("shell.nav.assemblies");
      case "assembly": {
        const stored = currentAssembly.value;
        return stored &&
          (stored.slug === step.param || stored.id === step.param)
          ? stored.label
          : t("shell.breadcrumb.assembly");
      }
      case "section":
        return t(`shell.assembly.${step.section}`);
      case "document": {
        const label = labels.value[`document:${step.param}`];
        return label ? truncateLabel(label) : t("shell.breadcrumb.document");
      }
      case "documentView":
        return t(`shell.breadcrumb.views.${step.view}`);
      case "agendaItem": {
        const chain = agendaChains.value[step.param];
        const own = chain?.[chain.length - 1];
        return own
          ? truncateLabel(own.label)
          : t("shell.breadcrumb.agendaItem");
      }
      case "myActivity":
        return t("shell.user.activity");
    }
  }

  /** From the top level down; empty on pages without a trail (home). */
  const crumbs = computed<Breadcrumb[]>(() => {
    const trail = breadcrumbTrail(
      stripLocalePrefix(route.path, localeCodes.value),
    );
    const last = trail.steps.length - 1;
    // A document's trail goes through the agenda item it hangs from, once
    // its page has registered it.
    const documentStep = trail.steps.find((step) => step.kind === "document");
    const documentChain = documentStep
      ? (documentChains.value[`document:${documentStep.param}`] ?? [])
      : [];
    return trail.steps.flatMap((step, index) => {
      const crumb = {
        label: labelOf(step),
        to: localePath(step.path),
        current: trail.exact && index === last,
      };
      if (
        step.kind === "section" &&
        step.section === "documents" &&
        documentChain.length > 0
      ) {
        const agenda = `${step.path.slice(0, step.path.lastIndexOf("/"))}/${ASSEMBLY_SECTION_SEGMENTS.agenda}`;
        return [
          {
            label: t("shell.assembly.agenda"),
            to: localePath(agenda),
            current: false,
          },
          ...documentChain.map((item) => ({
            label: truncateLabel(item.label, 32),
            to: localePath(`${agenda}/${encodeURIComponent(item.id)}`),
            current: false,
          })),
        ];
      }
      if (step.kind !== "agendaItem") return [crumb];
      // The items above it, once its page has registered them: their pages
      // are siblings of this one in the path.
      const section = step.path.slice(0, step.path.lastIndexOf("/"));
      const above = (agendaChains.value[step.param] ?? []).slice(0, -1);
      return [
        ...above.map((item) => ({
          label: truncateLabel(item.label, 32),
          to: localePath(`${section}/${encodeURIComponent(item.id)}`),
          current: false,
        })),
        crumb,
      ];
    });
  });

  /** The level above the page on show, for the single link on phones. */
  const parent = computed<Breadcrumb | null>(() => {
    const list = crumbs.value;
    const last = list[list.length - 1];
    if (!last) return null;
    if (!last.current) return last;
    return list[list.length - 2] ?? null;
  });

  return { crumbs, parent };
}
