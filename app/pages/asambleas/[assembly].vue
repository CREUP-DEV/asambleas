<script setup lang="ts">
import {
  ASSEMBLY_STATUSES,
  ASSEMBLY_STATUS_TRANSITIONS,
  type AssemblyStatus,
} from "~~/shared/constants/domain";
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
 * (navbar with label, status and status actions; toolbar with the section
 * navigation) around <NuxtPage />.
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
const { t, locale } = useI18n();
const localePath = useLocalePath();
const toast = useToast();
const api = useApi();

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

// Header ------------------------------------------------------------------

const typeName = computed(() =>
  assembly.value ? t(`assembly.types.${assembly.value.type}`) : "",
);
const dateRange = computed(() =>
  assembly.value
    ? formatAssemblyDateRange(
        assembly.value.startDate,
        assembly.value.endDate,
        locale.value,
      )
    : "",
);

// Status transitions ----------------------------------------------------------

interface TransitionAction {
  to: AssemblyStatus;
  key: string;
  forward: boolean;
}

const transitions = computed<TransitionAction[]>(() => {
  const value = assembly.value;
  if (!value?.can.manage) return [];
  const rank = (status: AssemblyStatus) => ASSEMBLY_STATUSES.indexOf(status);
  return ASSEMBLY_STATUS_TRANSITIONS[value.status].map((to) => ({
    to,
    key: `${value.status}_${to}`,
    forward: rank(to) > rank(value.status),
  }));
});

const forwardTransitions = computed(() =>
  transitions.value.filter((transition) => transition.forward),
);

/**
 * Tinted, not solid, so they never compete with the section's own main
 * action; closing the assembly is never the most prominent button.
 */
function transitionButtonStyle(transition: TransitionAction) {
  return transition.key === "in_session_closed"
    ? { color: "neutral" as const, variant: "outline" as const }
    : { color: "primary" as const, variant: "soft" as const };
}

const backwardItems = computed(() =>
  transitions.value
    .filter((transition) => !transition.forward)
    .map((transition) => ({
      label: t(`assembly.transitions.${transition.key}.label`),
      icon: "i-lucide-undo-2",
      onSelect: () => askTransition(transition),
    })),
);

const pendingTransition = ref<TransitionAction | null>(null);
const confirmOpen = ref(false);
const transitionBusy = ref(false);
const statusMessage = ref("");

function askTransition(transition: TransitionAction) {
  pendingTransition.value = transition;
  confirmOpen.value = true;
}

async function confirmTransition() {
  const transition = pendingTransition.value;
  const value = assembly.value;
  if (!transition || !value) return;
  transitionBusy.value = true;
  try {
    const updated = await api.send<AssemblyDto>(
      `/api/assemblies/${value.id}/status`,
      {
        method: "PUT",
        body: { status: transition.to, updatedAt: value.updatedAt },
      },
    );
    current.setAssembly(updated);
    confirmOpen.value = false;
    statusMessage.value = t(`assembly.transitions.${transition.key}.done`);
    toast.add({
      title: statusMessage.value,
      color: "success",
      icon: "i-lucide-check",
    });
  } catch (failure) {
    api.notifyError(failure, "assembly.hub.statusError");
    if (api.isConflict(failure)) {
      confirmOpen.value = false;
      await refresh();
    }
  } finally {
    transitionBusy.value = false;
  }
}

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

  <UDashboardPanel v-else id="assembly-hub">
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
            <CommonStatusBadge kind="assembly" :value="assembly.status" />
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

        <!-- Centre (large screens): what, when and where. -->
        <p
          v-if="assembly"
          class="text-muted flex min-w-0 items-center gap-x-3 text-sm"
        >
          <span class="truncate">{{ typeName }}</span>
          <span class="inline-flex items-center gap-1 whitespace-nowrap">
            <UIcon
              name="i-lucide-calendar-days"
              class="size-4"
              aria-hidden="true"
            />
            <span class="sr-only">{{ t("assembly.hub.dates") }}</span>
            {{ dateRange }}
          </span>
          <span class="inline-flex min-w-0 items-center gap-1">
            <UIcon name="i-lucide-map-pin" class="size-4" aria-hidden="true" />
            <span class="sr-only">{{ t("assembly.hub.location") }}</span>
            <span class="truncate">{{ assembly.location }}</span>
          </span>
        </p>

        <template #right>
          <div v-if="transitions.length > 0" class="flex items-center gap-1.5">
            <!-- Phones show these with their text in the body instead. -->
            <UButton
              v-for="transition in forwardTransitions"
              :key="transition.key"
              v-bind="transitionButtonStyle(transition)"
              icon="i-lucide-arrow-right-circle"
              class="hidden sm:inline-flex"
              :aria-label="t(`assembly.transitions.${transition.key}.label`)"
              @click="askTransition(transition)"
            >
              <span class="hidden sm:inline">{{
                t(`assembly.transitions.${transition.key}.label`)
              }}</span>
            </UButton>
            <UDropdownMenu
              v-if="backwardItems.length > 0"
              :items="backwardItems"
              :content="{ align: 'end' }"
            >
              <UButton
                color="neutral"
                variant="ghost"
                icon="i-lucide-ellipsis-vertical"
                :aria-label="t('assembly.hub.moreStatusActions')"
              />
            </UDropdownMenu>
          </div>
        </template>
      </UDashboardNavbar>

      <!-- Where this page is. Section pages register nothing: the trail
           comes from the route, and a document page adds its own name. -->
      <ShellBreadcrumbs />

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
        <!-- What, when and where on small screens (the navbar shows it on large ones). -->
        <dl
          class="text-muted flex flex-wrap items-center gap-x-4 gap-y-1 text-sm lg:hidden"
        >
          <div class="flex items-center gap-1.5">
            <dt class="sr-only">{{ t("assembly.hub.type") }}</dt>
            <dd>{{ typeName }}</dd>
          </div>
          <div class="flex items-center gap-1.5">
            <dt class="flex">
              <UIcon
                name="i-lucide-calendar-days"
                class="size-4"
                aria-hidden="true"
              />
              <span class="sr-only">{{ t("assembly.hub.dates") }}</span>
            </dt>
            <dd>{{ dateRange }}</dd>
          </div>
          <div class="flex min-w-0 items-center gap-1.5">
            <dt class="flex">
              <UIcon
                name="i-lucide-map-pin"
                class="size-4"
                aria-hidden="true"
              />
              <span class="sr-only">{{ t("assembly.hub.location") }}</span>
            </dt>
            <dd class="truncate">{{ assembly.location }}</dd>
          </div>
          <!-- Not on a document's pages (they show that document's own
               deadline) nor on the overview (it has its own block). -->
          <div
            v-if="assembly.nextMilestone && !onDocumentPage && !onOverview"
            class="flex items-center gap-1.5"
          >
            <dt class="flex">
              <UIcon
                name="i-lucide-hourglass"
                class="size-4"
                aria-hidden="true"
              />
              <span class="sr-only">{{ t("assembly.hub.nextMilestone") }}</span>
            </dt>
            <dd class="flex flex-wrap items-center gap-1">
              <span>{{
                t(`calendar.milestones.${assembly.nextMilestone.key}`)
              }}</span>
              <CommonCountdown :to="assembly.nextMilestone.at" />
            </dd>
          </div>
        </dl>

        <!-- The status actions on phones, where the header has no room for
             their text. Only on the overview: the other sections keep to
             their own subject. -->
        <div
          v-if="forwardTransitions.length > 0 && onOverview"
          class="flex flex-wrap gap-2 sm:hidden"
        >
          <UButton
            v-for="transition in forwardTransitions"
            :key="transition.key"
            v-bind="transitionButtonStyle(transition)"
            icon="i-lucide-arrow-right-circle"
            :label="t(`assembly.transitions.${transition.key}.label`)"
            @click="askTransition(transition)"
          />
        </div>

        <p class="sr-only" aria-live="polite" role="status">
          {{ statusMessage }}
        </p>

        <NuxtPage />

        <UModal
          v-model:open="confirmOpen"
          :title="
            pendingTransition
              ? t(`assembly.transitions.${pendingTransition.key}.title`)
              : ''
          "
          :description="
            pendingTransition
              ? t(`assembly.transitions.${pendingTransition.key}.description`, {
                  label: assembly.label,
                })
              : ''
          "
          :dismissible="!transitionBusy"
        >
          <template #footer>
            <div class="flex w-full flex-wrap justify-end gap-2">
              <UButton
                color="neutral"
                variant="outline"
                :label="t('common.cancel')"
                :disabled="transitionBusy"
                @click="confirmOpen = false"
              />
              <UButton
                v-if="pendingTransition"
                :color="pendingTransition.forward ? 'primary' : 'warning'"
                :label="
                  t(`assembly.transitions.${pendingTransition.key}.label`)
                "
                :loading="transitionBusy"
                @click="confirmTransition"
              />
            </div>
          </template>
        </UModal>
      </template>
    </template>
  </UDashboardPanel>
</template>
