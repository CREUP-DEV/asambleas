<script setup lang="ts">
import type { NavigationMenuItem } from "@nuxt/ui";
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

const route = useRoute();
const router = useRouter();
const { t, locale } = useI18n();
const localePath = useLocalePath();
const toast = useToast();
const api = useApi();

const routeParam = () => String(route.params.assembly ?? "");

const { data, error, status, pending, refresh } = await useFetch<AssemblyDto>(
  () => `/api/assemblies/${encodeURIComponent(routeParam())}`,
  { key: computed(() => `assembly-${routeParam()}`) },
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
const { assembly, sectionPath, live, stale } = current;

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

interface Section {
  key: string;
  path: string;
  icon: string;
  visible: (value: AssemblyDto) => boolean;
}

// Settings must stay last: the projection link is inserted before it.

const SECTIONS: Section[] = [
  {
    key: "overview",
    path: "",
    icon: "i-lucide-layout-dashboard",
    visible: () => true,
  },
  // The attendees' live view, for everyone at any time: before and after
  // the session it says so (see the page), so links to it never break.
  {
    key: "live",
    path: "directo",
    icon: "i-lucide-radio",
    visible: () => true,
  },
  {
    key: "agenda",
    path: "orden-del-dia",
    icon: "i-lucide-list-tree",
    visible: () => true,
  },
  {
    key: "documents",
    path: "documentos",
    icon: "i-lucide-files",
    visible: () => true,
  },
  {
    key: "validation",
    path: "validacion",
    icon: "i-lucide-inbox",
    visible: () => canReview.value,
  },
  {
    key: "tracking",
    path: "seguimiento",
    icon: "i-lucide-list-checks",
    visible: () => canValidateDocuments.value,
  },
  {
    key: "calendar",
    path: "calendario",
    icon: "i-lucide-calendar-clock",
    visible: (value) => value.can.manage,
  },
  {
    key: "convocation",
    path: "convocatoria",
    icon: "i-lucide-scroll-text",
    visible: () => true,
  },
  {
    key: "session",
    path: "sesion",
    icon: "i-lucide-gavel",
    visible: (value) => value.can.moderate,
  },
  {
    key: "settings",
    path: "ajustes",
    icon: "i-lucide-settings",
    visible: (value) => value.can.manage,
  },
];

/** Child route paths of this hub, so sections without a page are skipped. */
const childPaths = computed(() => {
  const record = route.matched.find((candidate) =>
    candidate.children?.some((child) => child.path === "orden-del-dia"),
  );
  const paths = new Set<string>();
  for (const child of record?.children ?? []) {
    paths.add(child.path.replace(/\/$/, ""));
  }
  return paths;
});

/** The projection lives outside the hub (/proyeccion/<slug>), chrome-free. */
const hasProjectionPage = router
  .getRoutes()
  .some((record) => /\/proyeccion\/:assembly/.test(record.path));

const sectionItems = computed<NavigationMenuItem[]>(() => {
  const value = assembly.value;
  if (!value) return [];
  const items: NavigationMenuItem[] = SECTIONS.filter(
    (section) =>
      section.visible(value) &&
      (section.path === "" ||
        childPaths.value.size === 0 ||
        childPaths.value.has(section.path)),
  ).map((section) => {
    const to = sectionPath(section.path);
    const pendingCount =
      section.key === "validation" && reviewCount.value > 0
        ? reviewCount.value
        : 0;
    const liveNow = section.key === "live" && value.status === "in_session";
    return {
      label: t(`assembly.sections.${section.key}`),
      icon: section.icon,
      to,
      ...(liveNow
        ? {
            badge: {
              label: t("assembly.sections.liveNow"),
              color: "error" as const,
              variant: "soft" as const,
            },
            "aria-label": t("assembly.sections.liveInSession"),
          }
        : {}),
      ...(pendingCount > 0
        ? {
            badge: {
              label: String(pendingCount),
              color: "warning" as const,
              variant: "solid" as const,
            },
            "aria-label": t(
              "assembly.sections.validationPending",
              { count: pendingCount },
              pendingCount,
            ),
          }
        : {}),
      exact: section.path === "",
      // A document (documentos/<slug>/...) is a sibling route of the list,
      // not a child, so the router alone would not mark Documents active.
      active:
        section.path === ""
          ? route.path === to
          : route.path === to || route.path.startsWith(`${to}/`),
    };
  });
  if (hasProjectionPage && value.can.moderate) {
    // Opens on its own window, typically on the projector.
    items.splice(items.length - (value.can.manage ? 1 : 0), 0, {
      label: t("assembly.sections.projection"),
      icon: "i-lucide-presentation",
      to: localePath(`/proyeccion/${encodeURIComponent(value.slug)}`),
      target: "_blank",
      trailingIcon: "i-lucide-external-link",
      "aria-label": t("assembly.sections.projectionNewWindow"),
    });
  }
  return items;
});
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
            <UButton
              v-for="transition in forwardTransitions"
              :key="transition.key"
              icon="i-lucide-arrow-right-circle"
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

      <!-- On large screens the sidebar lists these same sections; repeating
           them here only crowded the header. Phones keep them, since the
           sidebar is a drawer there. Child pages that size themselves to the
           viewport (session console, document workspace) assume this. -->
      <UDashboardToolbar v-if="assembly" class="lg:hidden">
        <UNavigationMenu
          :items="sectionItems"
          orientation="horizontal"
          highlight
          class="-mx-1 w-max min-w-full"
          :aria-label="t('assembly.sections.label')"
        />
      </UDashboardToolbar>
    </template>

    <template #body>
      <!-- Loading -->
      <div
        v-if="!assembly && pending"
        class="space-y-4"
        aria-busy="true"
        :aria-label="t('assembly.hub.loading')"
      >
        <USkeleton class="h-5 w-72 max-w-full" />
        <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <USkeleton v-for="index in 4" :key="index" class="h-20" />
        </div>
        <USkeleton class="h-72 w-full" />
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
            <dt>
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
            <dt>
              <UIcon
                name="i-lucide-map-pin"
                class="size-4"
                aria-hidden="true"
              />
              <span class="sr-only">{{ t("assembly.hub.location") }}</span>
            </dt>
            <dd class="truncate">{{ assembly.location }}</dd>
          </div>
          <div v-if="assembly.nextMilestone" class="flex items-center gap-1.5">
            <dt>
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
