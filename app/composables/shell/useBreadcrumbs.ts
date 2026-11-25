import type { MaybeRefOrGetter } from "vue";
import type { AssemblyDto } from "~~/shared/types/api";
import { ASSEMBLY_SECTION_SEGMENTS } from "../assembly/-sections";
import {
  breadcrumbTrail,
  documentItemCrumbs,
  pendingStep,
  stripLocalePrefix,
  truncateLabel,
  unloadedDocumentKey,
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
 * hydration both render that step as a skeleton (`pending`, the generic
 * "Document" only for screen readers), and the name replaces it right after,
 * with no jump from one word to another. Nothing is fetched for it.
 *
 * The page of an agenda item works the same way (useAgendaItemBreadcrumb):
 * the path only carries the item's id, so the page registers the items from
 * the root one down to itself ("3. Resoluciones"), and the row shows a
 * skeleton until then.
 *
 * A document hangs from an agenda item, and that is where its trail leads:
 * "Orden del día > 3. Resoluciones > Resolución sobre la financiación",
 * whatever page it was opened from, so the way back from a document is
 * always the item it belongs to. useDocumentBreadcrumb registers those items
 * too, from the agenda; until then the route's "Documentos" step is a
 * skeleton, and for a document whose item the viewer does not get
 * (registered empty) the trail is the route's ("Documentos > Informe de
 * gestión").
 */

export interface Breadcrumb {
  label: string;
  /** Localized path. */
  to: string;
  /** True for the page on show: it is not a link. */
  current: boolean;
  /**
   * Its name or its place in the trail is not registered yet: shown as a
   * skeleton, `label` (the generic one) only for screen readers.
   */
  pending?: boolean;
}

/**
 * Longest label of a document or an agenda item in the trail. The trail has
 * the navbar's width on large screens, so this only stops an endless title;
 * what does not fit is cut by the breadcrumb itself, as wide as it can.
 */
const CRUMB_MAX = 160;

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
 * down to itself (last), from the agenda it already loads. When that agenda
 * fails to load, the item's step is registered empty under the `[item]`
 * route param: it reads the generic "Item" instead of staying a skeleton.
 */
export function useAgendaItemBreadcrumb(
  chain: MaybeRefOrGetter<AgendaItemCrumb[] | null | undefined>,
): void {
  if (import.meta.server) return;
  const chains = useAgendaItemChains();
  const route = useRoute();
  const { status: agendaStatus } = useAssemblyAgenda();
  const mounted = ref(false);
  onMounted(() => {
    mounted.value = true;
  });
  watch(
    [
      mounted,
      () => toValue(chain) ?? null,
      () => agendaStatus.value === "error",
    ],
    ([isMounted, value, failed]) => {
      if (!isMounted) return;
      const own = value?.[value.length - 1];
      if (!value || !own) {
        const param = route.params.item;
        if (
          failed &&
          typeof param === "string" &&
          param &&
          !Object.hasOwn(chains.value, param)
        ) {
          chains.value = { ...chains.value, [param]: [] };
        }
        return;
      }
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
  agendaItemId: string;
}

/**
 * Called by the pages of a document with the DTO they already load and the
 * error of that load. The document's own step is always its title (cut by
 * the trail when long), never its reference. Its own automatic sub-item,
 * which repeats that title, reads as its number alone above it
 * ("3.12 > <title>"). When the document never loads (the page shows its
 * error inline), the route's `[document]` param is registered empty, so the
 * row reads "Documentos > Documento" instead of staying a skeleton.
 */
export function useDocumentBreadcrumb(
  document: MaybeRefOrGetter<BreadcrumbDocument | null | undefined>,
  error: MaybeRefOrGetter<unknown>,
): void {
  if (import.meta.server) return;
  const labels = useBreadcrumbLabels();
  const chains = useDocumentItemChains();
  const route = useRoute();
  const { t } = useI18n();
  const { data: agenda, status: agendaStatus } = useAssemblyAgenda();
  const mounted = ref(false);
  onMounted(() => {
    mounted.value = true;
  });
  watch(
    [
      mounted,
      () => Boolean(toValue(error)) && !toValue(document),
      () => route.params.document,
    ],
    ([isMounted, failed, param]) => {
      if (!isMounted) return;
      const key = unloadedDocumentKey(param, failed, {
        labels: labels.value,
        documentChains: chains.value,
      });
      if (!key) return;
      if (!Object.hasOwn(labels.value, key)) {
        labels.value = { ...labels.value, [key]: "" };
      }
      if (!Object.hasOwn(chains.value, key)) {
        chains.value = { ...chains.value, [key]: [] };
      }
    },
    { immediate: true },
  );
  watch(
    [
      mounted,
      () => {
        const value = toValue(document);
        if (!value) return null;
        return [value.id, value.slug, value.title] as const;
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

  // The items it hangs from, from the agenda the hub pages share. Registered
  // empty too, for a viewer who does not get its item (or when the agenda
  // fails to load), so the route's trail stops being pending.
  watch(
    [
      mounted,
      () => {
        const value = toValue(document);
        if (!value) return null;
        const items = agenda.value?.items;
        if (!items) {
          return agendaStatus.value === "error"
            ? { id: value.id, slug: value.slug, chain: [] }
            : null;
        }
        const chain = documentItemCrumbs(
          agendaNodePath(buildAgendaTree(items), value.agendaItemId),
          value.id,
          t("agenda.unlisted.inText"),
        );
        return { id: value.id, slug: value.slug, chain };
      },
    ],
    ([isMounted, entry]) => {
      if (!isMounted || !entry) return;
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
        return label
          ? truncateLabel(label, CRUMB_MAX)
          : t("shell.breadcrumb.document");
      }
      case "documentView":
        return t(`shell.breadcrumb.views.${step.view}`);
      case "agendaItem": {
        const chain = agendaChains.value[step.param];
        const own = chain?.[chain.length - 1];
        return own
          ? truncateLabel(own.label, CRUMB_MAX)
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
    const registry = {
      labels: labels.value,
      agendaChains: agendaChains.value,
      documentChains: documentChains.value,
    };
    // A document's trail goes through the agenda item it hangs from, once
    // its page has registered it.
    const documentStep = trail.steps.find((step) => step.kind === "document");
    const documentChain = documentStep
      ? (documentChains.value[`document:${documentStep.param}`] ?? [])
      : [];
    return trail.steps.flatMap((step, index) => {
      const crumb: Breadcrumb = {
        label: labelOf(step),
        to: localePath(step.path),
        current: trail.exact && index === last,
      };
      if (pendingStep(step, trail.steps, registry)) crumb.pending = true;
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
            label: truncateLabel(item.label, CRUMB_MAX),
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
          label: truncateLabel(item.label, CRUMB_MAX),
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
