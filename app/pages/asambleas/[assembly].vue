<script setup lang="ts">
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { AssemblyDto, ReviewQueueDto } from "~~/shared/types/api";
import { errorStatus } from "~/composables/api/useApi";
import {
  REVIEW_BADGE_STATE_KEY,
  pendingReviewCount,
  reviewQueueKey,
  type ReviewBadgeState,
} from "~/components/review/-queue";
import { affectsReviewQueue } from "~/components/review/-live";

/**
 * Assembly hub: loads the assembly by slug (or id), shares it with the
 * section pages through useCurrentAssembly, and renders its dashboard panel
 * (navbar with label, status and, from lg, the breadcrumb; toolbar with the
 * section navigation below lg) around <NuxtPage />. Status changes live in
 * their sections (AssemblyStatusActions). From lg the breadcrumb sits in
 * the navbar, so the panel has no breadcrumb row to take off there.
 *
 * Section pages with `definePageMeta({ print: true })` (the convocatoria,
 * projection views) are rendered alone, without the hub chrome; they also
 * set `layout: false` to leave the app shell.
 */

definePageMeta({
  middleware: [
    // On a full load the layout's sidebar renders on the server before this
    // page, so the assembly is stored first for it to list the sections.
    // Client navigations need nothing: the fetch below stores it before the
    // new page shows. Errors are left to that fetch (404, load error).
    async (to) => {
      if (import.meta.client) return;
      const param = to.params.assembly;
      if (typeof param !== "string" || !param) return;
      // CURRENT_ASSEMBLY_STATE_KEY, written out so that module stays out of
      // the routes chunk.
      const stored = useState<AssemblyDto | null>(
        "current-assembly",
        () => null,
      );
      if (stored.value?.slug === param || stored.value?.id === param) return;
      try {
        stored.value = await useRequestFetch()<AssemblyDto>(
          `/api/assemblies/${encodeURIComponent(param)}`,
        );
      } catch {
        // The page fetches it again and shows what went wrong.
      }
    },
  ],
});

const route = useRoute();
const routeBaseName = useRouteBaseName();
const { t } = useI18n();
const localePath = useLocalePath();
const toast = useToast();

const routeParam = () => String(route.params.assembly ?? "");

const sharedAssembly = useState<AssemblyDto | null>(
  CURRENT_ASSEMBLY_STATE_KEY,
  () => null,
);

const { data, error, status, pending, refresh } = await useFetch<AssemblyDto>(
  () => `/api/assemblies/${encodeURIComponent(routeParam())}`,
  {
    key: computed(() => `assembly-${routeParam()}`),
    // The first load on the server reuses what the route middleware stored.
    // Refreshes (live events, retry, conflicts) always ask the server again.
    getCachedData: (key, nuxtApp, ctx) => {
      if (nuxtApp.isHydrating) return nuxtApp.payload.data[key];
      if (import.meta.server && ctx.cause === "initial") {
        const stored = sharedAssembly.value;
        const param = routeParam();
        if (stored && (stored.slug === param || stored.id === param)) {
          return stored;
        }
      }
      return undefined;
    },
  },
);

function notFound() {
  return createError({
    statusCode: 404,
    data: { messageKey: "assembly.notFound" },
    fatal: true,
  });
}

if (!data.value && errorStatus(error.value) === 404) {
  throw notFound();
}

// A refetch that ends in 404 (deleted or hidden meanwhile) shows the error page.
watch(error, (value) => {
  if (value && errorStatus(value) === 404) showError(notFound());
});

// A failed refresh keeps the last good assembly on screen (the context
// handles it): only the first load can end in the error state below.
const current = provideCurrentAssembly({
  data,
  status,
  error,
  pending,
  refresh: async () => {
    await refresh();
  },
  routeParam,
  onDeleted: () => {
    toast.add({
      id: "assembly-deleted",
      title: t("assembly.hub.deletedElsewhere"),
      color: "warning",
      icon: "i-lucide-trash-2",
    });
    void navigateTo(localePath("/asambleas"));
  },
});
const { assembly, live, stale } = current;

// The account's read marks, once for every page and row of the assembly.
provideReadMarks(current);

const retrying = ref(false);
async function retryRefresh() {
  retrying.value = true;
  try {
    await refresh();
  } finally {
    retrying.value = false;
  }
}

const isPrintView = computed(() => Boolean(route.meta.print));
/** A page of one document (its text, its review, its editor). */
const onDocumentPage = computed(() => Boolean(route.params.document));
/** The overview, which has its own block with the next deadline. */
const onOverview = computed(
  () => routeBaseName(route) === "asambleas-assembly",
);

// Validation inbox --------------------------------------------------------------
//
// The Secretaría's pending count for the "Validación" section and the
// sidebar. The queue is fetched under the key the inbox page uses too, so
// both share one request and one state; it follows the live stream here,
// for every section. Client only: the count is not worth delaying the page.
//
// The count shows only once mounted. The inbox page fetches the same key
// during SSR, after this toolbar has rendered without it; the client finds
// that data in the payload, so showing it during hydration would mismatch.

const { can } = useMe();
const canValidateDocuments = computed(() =>
  can(PERMISSION_KEYS.DOCUMENT_MANAGE),
);
const canReviewAmendments = computed(() =>
  can(PERMISSION_KEYS.AMENDMENT_REVIEW),
);
const canReview = computed(
  () => canValidateDocuments.value || canReviewAmendments.value,
);

const reviewFetch = useFetch<ReviewQueueDto>(
  () => `${current.apiBase.value}/review`,
  {
    key: computed(() => reviewQueueKey(assembly.value?.id ?? "none")),
    server: false,
    lazy: true,
    immediate: canReview.value && Boolean(assembly.value),
    dedupe: "defer",
  },
);
const { data: reviewQueue } = keepLastGoodData(reviewFetch, {
  resetOn: () => assembly.value?.id,
});

// `immediate` is read once: start the fetch when the assembly or the
// permission arrive later (a first load that failed, then a retry).
watch([() => assembly.value?.id, canReview], ([id, allowed]) => {
  if (id && allowed && reviewFetch.status.value === "idle") {
    void reviewFetch.execute();
  }
});

const mounted = ref(false);
onMounted(() => {
  mounted.value = true;
});

const reviewCount = computed(() =>
  mounted.value && canReview.value
    ? pendingReviewCount(reviewQueue.value, {
        documents: canValidateDocuments.value,
        amendments: canReviewAmendments.value,
      })
    : 0,
);

current.onLive((events) => {
  if (canReview.value && affectsReviewQueue(events)) {
    void reviewFetch.refresh({ dedupe: "defer" });
  }
});

const reviewBadge = useState<ReviewBadgeState | null>(
  REVIEW_BADGE_STATE_KEY,
  () => null,
);
watch(
  [() => assembly.value?.id, reviewCount, canReview],
  ([id, count, allowed]) => {
    reviewBadge.value = id && allowed ? { assemblyId: id, count } : null;
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  if (reviewBadge.value?.assemblyId === assembly.value?.id) {
    reviewBadge.value = null;
  }
});

useHead({
  title: () => assembly.value?.label ?? t("assembly.hub.loading"),
});

// Sections ------------------------------------------------------------------

// The same list the sidebar shows (useAssemblySections), without its group
// titles: the bar is a single row.
const { items: sectionItems } = useAssemblySections(assembly);

/**
 * On phones the section bar scrolls: keep the open section in view. The ref
 * is on the toolbar, since the menu has several root nodes and so no $el.
 */
const sectionToolbar = useTemplateRef<{ $el?: unknown }>("sectionToolbar");
function revealActiveSection() {
  void nextTick(() => {
    const root = sectionToolbar.value?.$el;
    if (!(root instanceof Element)) return;
    root
      .querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
}
onMounted(revealActiveSection);
watch(() => route.path, revealActiveSection);
</script>

<template>
  <NuxtPage v-if="isPrintView && assembly" />

  <UDashboardPanel
    v-else
    id="assembly-hub"
    class="lg:[--shell-breadcrumb-height:0px]"
  >
    <template #header>
      <!-- The label never truncates: the centre line gives way instead. -->
      <UDashboardNavbar
        :title="assembly?.label ?? t('assembly.hub.loading')"
        :ui="{ left: 'shrink-0', title: 'shrink-0', center: 'min-w-0' }"
      >
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #trailing>
          <template v-if="assembly">
            <!-- "Convocada" is the usual state and says nothing new: only
                 the others (draft, in session, closed) are shown. -->
            <CommonStatusBadge
              v-if="assembly.status !== 'convened'"
              kind="assembly"
              :value="assembly.status"
            />
            <UTooltip v-if="stale" :text="t('assembly.hub.staleDescription')">
              <UButton
                color="warning"
                variant="soft"
                size="xs"
                icon="i-lucide-refresh-ccw"
                :loading="retrying"
                :aria-label="t('assembly.hub.staleDescription')"
                @click="retryRefresh"
              >
                <span class="hidden sm:inline">{{
                  t("assembly.hub.stale")
                }}</span>
              </UButton>
            </UTooltip>
            <UTooltip
              v-else-if="live.polling.value"
              :text="t('assembly.hub.livePolling')"
            >
              <UBadge
                color="warning"
                variant="soft"
                size="sm"
                icon="i-lucide-wifi-off"
              >
                <span class="hidden sm:inline">{{
                  t("assembly.hub.liveOffline")
                }}</span>
                <span class="sr-only sm:hidden">{{
                  t("assembly.hub.livePolling")
                }}</span>
              </UBadge>
            </UTooltip>
            <UBadge
              v-else-if="
                live.connected.value && assembly.status === 'in_session'
              "
              color="success"
              variant="soft"
              size="sm"
              icon="i-lucide-radio"
              class="hidden sm:inline-flex"
              :label="t('assembly.hub.liveOn')"
            />
          </template>
        </template>

        <!-- Centre (large screens): where this page is. -->
        <div v-if="assembly" class="hidden min-w-0 lg:flex">
          <ShellBreadcrumbs placement="inline" />
        </div>
      </UDashboardNavbar>

      <!-- Where this page is, below lg (the navbar shows it from lg).
           Section pages register nothing: the trail comes from the route,
           and a document page adds its own name. -->
      <ShellBreadcrumbs placement="compact" />

      <!-- On large screens the sidebar lists these same sections; repeating
           them here only crowded the header. Phones keep them, since the
           sidebar is a drawer there. Child pages that size themselves to the
           viewport (session console, document workspace) assume this, and
           take the breadcrumb row off with `--shell-breadcrumb-height`. -->
      <UDashboardToolbar v-if="assembly" ref="sectionToolbar" class="lg:hidden">
        <UNavigationMenu
          :items="sectionItems"
          orientation="horizontal"
          highlight
          class="-mx-1 w-max min-w-full shrink-0"
          :aria-label="t('assembly.sections.label')"
        />
      </UDashboardToolbar>
    </template>

    <template #body>
      <!-- Loading -->
      <div v-if="!assembly && pending" class="space-y-4" role="status">
        <span class="sr-only">{{ t("assembly.hub.loading") }}</span>
        <USkeleton aria-hidden="true" class="h-5 w-72 max-w-full" />
        <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <USkeleton
            v-for="index in 4"
            :key="index"
            aria-hidden="true"
            class="h-20"
          />
        </div>
        <USkeleton aria-hidden="true" class="h-72 w-full" />
      </div>

      <!-- Error (only when it never loaded: later failures keep the data) -->
      <UAlert
        v-else-if="!assembly"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="t('assembly.hub.loadError')"
        :description="t('assembly.hub.loadErrorDescription')"
        :actions="[
          {
            label: t('assembly.hub.retry'),
            icon: 'i-lucide-refresh-ccw',
            color: 'neutral',
            variant: 'outline',
            onClick: () => {
              void refresh();
            },
          },
        ]"
        role="alert"
      />

      <template v-else>
        <!-- The next deadline on small screens. Not on a document's pages
             (they show that document's own deadline) nor on the overview
             (it has its own block). -->
        <p
          v-if="assembly.nextMilestone && !onDocumentPage && !onOverview"
          class="text-muted flex flex-wrap items-center gap-1.5 text-sm lg:hidden"
        >
          <UIcon
            name="i-lucide-hourglass"
            class="size-4 shrink-0"
            aria-hidden="true"
          />
          <span class="sr-only">{{ t("assembly.hub.nextMilestone") }}</span>
          <span>{{
            t(`calendar.milestones.${assembly.nextMilestone.key}`)
          }}</span>
          <CommonCountdown :to="assembly.nextMilestone.at" dated />
        </p>

        <NuxtPage />
      </template>
    </template>
  </UDashboardPanel>
</template>
