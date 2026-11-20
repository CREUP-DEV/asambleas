<script setup lang="ts">
import type { AssemblyListDto, AssemblySummaryDto } from "~~/shared/types/api";
import { assemblyPath } from "./Navigation.vue";

/**
 * Slim floating banner shown while any assembly the user can see is in
 * session, linking to its live view ("En directo"; the list of those in
 * session when there are several). It floats out of the layout flow so it
 * never shrinks the dashboard panels, and it is hidden inside that
 * assembly, whose menu leads to the live view. Dismissing it hides it until
 * another assembly goes into session.
 *
 * Inside an assembly that is itself in session it would stay hidden, so it
 * asks nothing there (NAV-12 of the performance report of 2026-11): on
 * pages of an assembly the list is fetched on the client once the hub has
 * said which assembly it shows and that it is not in session, and again on
 * leaving it; elsewhere it comes with the page, as before.
 */
const REFRESH_THROTTLE_MS = 30_000;

const { t } = useI18n();
const localePath = useLocalePath();
const route = useRoute();
const { assembly: current } = useCurrentAssembly();

const routeAssembly = computed(() => {
  const param = route.params.assembly;
  return typeof param === "string" ? param : null;
});

/** On a page of the assembly in session the hub shows: hidden, no fetch. */
const insideLive = computed(() => {
  const shown = current.value;
  return (
    routeAssembly.value !== null &&
    shown?.status === "in_session" &&
    (routeAssembly.value === shown.slug || routeAssembly.value === shown.id)
  );
});

const { data, refresh } = useFetch<AssemblyListDto>("/api/assemblies", {
  key: "shell-in-session",
  query: { status: "in_session" },
  dedupe: "defer",
  // Inside an assembly, wait for the hub to say whether it is in session.
  immediate: routeAssembly.value === null,
});

const dismissed = useState<string[]>("shell-session-dismissed", () => []);
const announcement = ref("");

const inSession = computed<AssemblySummaryDto[]>(() =>
  (data.value?.items ?? []).filter((item) => item.status === "in_session"),
);

const visibleAssemblies = computed(() =>
  inSession.value.filter((item) => !dismissed.value.includes(item.id)),
);

const insideOne = computed(() =>
  inSession.value.some(
    (item) =>
      routeAssembly.value === item.slug || routeAssembly.value === item.id,
  ),
);

const visible = computed(
  () =>
    visibleAssemblies.value.length > 0 && !insideOne.value && !insideLive.value,
);

const single = computed(() =>
  visibleAssemblies.value.length === 1 ? visibleAssemblies.value[0] : null,
);

const target = computed(() =>
  single.value
    ? localePath(assemblyPath(single.value.slug, "live"))
    : localePath({
        path: "/asambleas",
        query: { status: "in_session" },
      }),
);

const message = computed(() =>
  single.value
    ? t("shell.live.single", { assembly: single.value.label })
    : t("shell.live.multiple", { count: visibleAssemblies.value.length }),
);

function dismiss(): void {
  dismissed.value = [
    ...new Set([
      ...dismissed.value,
      ...visibleAssemblies.value.map((i) => i.id),
    ]),
  ];
}

// Announce sessions that start while the page is open, not on first load
// (nor on the first list a page of an assembly fetches on the client).
watch(
  () => (data.value ? inSession.value.map((item) => item.id) : null),
  (ids, previous) => {
    if (!import.meta.client || !ids || !previous) return;
    const started = inSession.value.filter(
      (item) => !previous.includes(item.id),
    );
    if (started.length > 0) {
      announcement.value = t("shell.live.started", {
        assembly: started.map((item) => item.label).join(", "),
      });
    }
  },
);

/**
 * On a page of an assembly whose hub has not loaded it yet: whether it is
 * in session (insideLive) is not known.
 */
const awaitingHub = computed(() => {
  if (routeAssembly.value === null) return false;
  const shown = current.value;
  return (
    !shown ||
    (routeAssembly.value !== shown.slug && routeAssembly.value !== shown.id)
  );
});

let lastRefresh = 0;
/**
 * Refetches at most every REFRESH_THROTTLE_MS, at once when there is no
 * list yet; never where the banner stays hidden (insideLive) or before
 * the hub says whether it does (awaitingHub).
 */
function refreshThrottled(): void {
  if (insideLive.value || awaitingHub.value) return;
  const now = Date.now();
  if (data.value && now - lastRefresh < REFRESH_THROTTLE_MS) return;
  lastRefresh = now;
  void refresh();
}

onMounted(() => {
  // The list came with the page; otherwise (a page of an assembly) fetch
  // it now if the banner may show.
  if (data.value) lastRefresh = Date.now();
  else refreshThrottled();
});

watch(() => route.path, refreshThrottled);
// The hub loaded an assembly not in session, or the page left one.
watch([insideLive, awaitingHub], ([inside, awaiting]) => {
  if (import.meta.client && !inside && !awaiting) refreshThrottled();
});

const visibility = useDocumentVisibility();
watch(visibility, (state) => {
  if (state === "visible") refreshThrottled();
});
</script>

<template>
  <div>
    <p class="sr-only" aria-live="polite" aria-atomic="true">
      {{ announcement }}
    </p>

    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="translate-y-2 opacity-0"
      leave-active-class="transition duration-150 ease-in"
      leave-to-class="translate-y-2 opacity-0"
    >
      <aside
        v-if="visible"
        class="bg-inverted text-inverted ring-default fixed inset-x-4 bottom-4 flex items-center gap-2 rounded-full py-1.5 ps-4 pe-1.5 shadow-lg ring sm:inset-x-auto sm:end-6 sm:bottom-6 sm:max-w-md"
        :aria-label="t('shell.live.region')"
      >
        <span class="relative flex size-2.5 shrink-0" aria-hidden="true">
          <span
            class="bg-error absolute inline-flex size-full animate-ping rounded-full opacity-75 motion-reduce:animate-none"
          />
          <span class="bg-error relative inline-flex size-2.5 rounded-full" />
        </span>

        <NuxtLink
          :to="target"
          class="group flex min-w-0 flex-1 items-center gap-2 rounded-full text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        >
          <span class="min-w-0 flex-1 truncate">{{ message }}</span>
          <span
            class="bg-primary text-inverted hidden shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold group-hover:opacity-90 sm:inline-flex"
          >
            {{ t("shell.live.follow") }}
            <UIcon
              name="i-lucide-arrow-right"
              class="size-3.5"
              aria-hidden="true"
            />
          </span>
        </NuxtLink>

        <UButton
          icon="i-lucide-x"
          size="xs"
          color="neutral"
          variant="ghost"
          class="text-inverted hover:bg-default/10 focus-visible:bg-default/10 shrink-0 rounded-full"
          :aria-label="t('shell.live.dismiss')"
          @click="dismiss"
        />
      </aside>
    </Transition>
  </div>
</template>
