<script setup lang="ts">
import type { AssemblyDto, ReviewQueueDto } from "~~/shared/types/api";
import type { RouteLocationNormalized } from "vue-router";
import {
  reviewsAmendments,
  usesReviewQueue,
  validatesDocuments,
} from "~~/shared/utils/permissionRules";
import { errorStatus } from "~/composables/api/useApi";
import {
  REVIEW_BADGE_STATE_KEY,
  pendingReviewCount,
  reviewQueueKey,
  type ReviewBadgeState,
} from "~/components/review/-queue";
import { affectsReviewQueue } from "~/components/review/-live";
import {
  hubScrollTarget,
  rememberOffset,
} from "~/composables/assembly/-hubScroll";

/**
 * Assembly hub: loads the assembly by slug (or id), shares it with the
 * section pages through useCurrentAssembly, and renders its dashboard panel
 * (navbar with label and status, the label giving way from lg to the
 * breadcrumb, which starts with the assembly and takes the navbar's width;
 * toolbar with the section navigation below lg) around <NuxtPage />. Status
 * changes live in their sections (AssemblyStatusActions). From lg the
 * breadcrumb sits in the navbar, so the panel has no breadcrumb row to take
 * off there.
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
/**
 * Where to sign in again once the session is gone (live.expired), back to
 * this page afterwards. A full load: the page's data was read as nobody.
 */
const signInAgainPath = computed(() =>
  localePath({ path: "/login", query: { redirect: route.fullPath } }),
);

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
const canValidateDocuments = computed(() => validatesDocuments(can));
const canReviewAmendments = computed(() => reviewsAmendments(can));
const canReview = computed(() => usesReviewQueue(can));

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

// Never joining a read that may have left before the batch (an amendment
// just validated would come back as pending); with the inbox page open,
// its own subscriber and this one share one run (liveRefresh).
current.onLive((events) => {
  if (canReview.value && affectsReviewQueue(events)) {
    void current.liveRefresh(reviewQueueKey(assembly.value?.id ?? "none"), () =>
      reviewFetch.refresh({ dedupe: "cancel" }),
    );
  }
});

// The notices («Avisos») read again on an event about a document they come
// from (watchDocumentIds), or about any for the Mesa (watchAssemblyIds),
// at most every 30 s (useNotices): only the few accounts concerned, never
// the whole room on every event.
const { followLive: followNoticesLive } = useNotices();
current.onLive((events) =>
  followNoticesLive(events, assembly.value?.id ?? null),
);

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

// Scroll between pages ------------------------------------------------------
// A new page opens at the top, Back or Forward where its entry was left, a
// page that places itself stays put (-hubScroll.ts).

if (import.meta.client) {
  const router = useRouter();
  const hubBody = () =>
    window.document
      .getElementById("dashboard-panel-assembly-hub")
      ?.querySelector<HTMLElement>('[data-slot="body"]') ?? null;
  const saved = new Map<number, number>();
  let leaving: { left: number; popped: boolean } | null = null;
  const historyPosition = (): number | null => {
    const position = (window.history.state as { position?: unknown } | null)
      ?.position;
    return typeof position === "number" ? position : null;
  };

  // The entry on show. On Back or Forward the browser has already moved to
  // the next one when the router asks (and before its own popstate
  // listeners run), so the one being left is kept here, and an entry that
  // is not it means the browser moved.
  let current = historyPosition();

  // Each change of page's turn: a later one drops what an earlier one
  // waits for.
  let turn = 0;

  /**
   * Once the new page is in the hub (its component's element inside the
   * panel's body: Suspense keeps the old one on show while it loads), the
   * scroll goes where hubScrollTarget says.
   */
  function settle(
    to: RouteLocationNormalized,
    pending: { left: number; popped: boolean },
    mine: number,
  ): void {
    let tries = 300;
    const step = () => {
      if (mine !== turn) return;
      const body = hubBody();
      const element = to.matched.at(-1)?.instances.default?.$el as
        Node | undefined;
      if (!body || !element || !body.contains(element)) {
        if (tries-- > 0) window.setTimeout(step, 16);
        return;
      }
      const position = historyPosition();
      const target = hubScrollTarget({
        left: pending.left,
        now: body.scrollTop,
        max: body.scrollHeight - body.clientHeight,
        popped: pending.popped,
        saved: position === null ? null : (saved.get(position) ?? null),
      });
      if (target === null) return;
      body.scrollTo({ top: target });
      if (target === 0) return;
      keepAt(body, target, mine);
    };
    window.setTimeout(step, 0);
  }

  /**
   * A page coming back may still load, or reload its data and shrink for a
   * moment, which cuts the offset short: it is set again for a while, until
   * the reader moves the page or goes elsewhere.
   */
  function keepAt(body: HTMLElement, target: number, mine: number): void {
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
    };
    const inputs = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    for (const name of inputs) {
      body.addEventListener(name, cancel, { once: true, passive: true });
    }
    let tries = 30;
    const retry = () => {
      if (cancelled || mine !== turn || tries-- <= 0) {
        for (const name of inputs) body.removeEventListener(name, cancel);
        return;
      }
      if (Math.abs(body.scrollTop - target) > 1) {
        body.scrollTo({ top: target });
      }
      window.setTimeout(retry, 50);
    };
    window.setTimeout(retry, 50);
  }

  const stopBefore = router.beforeEach((to, from) => {
    // A page rewriting its own query (filters, tabs) is no new page.
    if (to.path === from.path) return;
    turn++;
    const body = hubBody();
    const left = body?.scrollTop ?? 0;
    if (current !== null) rememberOffset(saved, current, left);
    const position = historyPosition();
    leaving = { left, popped: position !== null && position !== current };
  });
  const stopAfter = router.afterEach((to, _from, failure) => {
    current = historyPosition();
    const pending = leaving;
    leaving = null;
    if (pending && !failure) settle(to, pending, turn);
  });
  onBeforeUnmount(() => {
    stopBefore();
    stopAfter();
  });
}
</script>

<template>
  <NuxtPage v-if="isPrintView && assembly" />

  <UDashboardPanel
    v-else
    id="assembly-hub"
    class="[--shell-breadcrumb-height:0px]"
  >
    <template #header>
      <!-- Where the page is goes in the navbar, never in a row of its own
           (user's decision of 2026-11-20). From md the label gives way to
           the whole breadcrumb, which names the assembly as its second step
           and takes the whole width; the label stays the page's heading for
           screen readers. On phones the label stays, followed by the link
           to the level above. -->
      <UDashboardNavbar
        :ui="{
          left: 'min-w-0 flex-1',
          title: assembly ? 'shrink-0 md:sr-only' : 'shrink-0',
        }"
      >
        <template #toggle>
          <ShellNavbarToggle />
        </template>
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #title>
          {{ assembly?.label ?? t("assembly.hub.loading") }}
        </template>
        <template #trailing>
          <div v-if="assembly" class="hidden min-w-0 flex-1 md:flex">
            <ShellBreadcrumbs placement="inline" />
          </div>
          <div v-if="assembly" class="flex min-w-0 flex-1 md:hidden">
            <ShellBreadcrumbs placement="back" />
          </div>
          <template v-if="assembly">
            <!-- Only a draft says so (user's decision of 2026-11-20): the
                 session's own state shows in the live badge beside it, and
                 the others say nothing new here. -->
            <CommonStatusBadge
              v-if="assembly.status === 'draft'"
              kind="assembly"
              :value="assembly.status"
            />
            <!-- The session is gone: nothing updates until signing in
                 again, so it says so before anything else. -->
            <UButton
              v-if="live.expired.value"
              color="warning"
              variant="soft"
              size="xs"
              icon="i-lucide-log-in"
              :to="signInAgainPath"
              external
              :aria-label="t('assembly.hub.sessionExpiredDescription')"
            >
              <span class="hidden sm:inline">{{
                t("assembly.hub.sessionExpired")
              }}</span>
            </UButton>
            <UTooltip
              v-else-if="stale"
              :text="t('assembly.hub.staleDescription')"
            >
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
                size="md"
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
              size="md"
              icon="i-lucide-radio"
              class="hidden sm:inline-flex"
              :label="t('assembly.hub.liveOn')"
            />
          </template>
        </template>
      </UDashboardNavbar>

      <!-- On large screens the sidebar lists these same sections; repeating
           them here only crowded the header. Phones keep them, since the
           sidebar is a drawer there. Child pages that size themselves to the
           viewport (session console, document workspace) assume this; the
           hub has no breadcrumb row (`--shell-breadcrumb-height` is 0). -->
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

      <template v-else-if="!assembly">
        <!-- Error (only when it never loaded: later failures keep the data) -->
        <UAlert
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
      </template>

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
