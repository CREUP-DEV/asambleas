import type { MaybeRefOrGetter } from "vue";
import type { AssemblyDto } from "~~/shared/types/api";
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

/** One agenda item of a trail: its id and its numbered title. */
export interface AgendaItemCrumb {
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

/** The document slice of DocumentDto the breadcrumb needs. */
interface BreadcrumbDocument {
  id: string;
  slug: string;
  title: string;
  reference: string | null;
}

/**
 * Called by the pages of a document with the DTO they already load: names
 * the document in the breadcrumb by its reference, or by its title.
 */
export function useDocumentBreadcrumb(
  document: MaybeRefOrGetter<BreadcrumbDocument | null | undefined>,
): void {
  if (import.meta.server) return;
  const labels = useBreadcrumbLabels();
  const mounted = ref(false);
  onMounted(() => {
    mounted.value = true;
  });
  watch(
    [
      mounted,
      () => {
        const value = toValue(document);
        return value
          ? ([
              value.id,
              value.slug,
              value.reference?.trim() || value.title,
            ] as const)
          : null;
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
}

export function useBreadcrumbs() {
  const { t, locales } = useI18n();
  const localePath = useLocalePath();
  const route = useRoute();
  const labels = useBreadcrumbLabels();
  const agendaChains = useAgendaItemChains();
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
      case "admin":
        return t("shell.nav.admin");
      case "adminPage":
        return t(`shell.nav.${step.page}`);
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
    return trail.steps.flatMap((step, index) => {
      const crumb = {
        label: labelOf(step),
        to: localePath(step.path),
        current: trail.exact && index === last,
      };
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
