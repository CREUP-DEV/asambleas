<script lang="ts">
import { useState } from "#imports";
import type { AssemblyListDto, AssemblySummaryDto } from "~~/shared/types/api";
import { assemblyPath } from "./Navigation.vue";

const HEIGHT_STATE_KEY = "shell-session-pill-height";
/** Assemblies whose pill was closed, kept for the tab (sessionStorage). */
const DISMISSED_STORAGE_KEY = "shell-session-dismissed";

/**
 * The floating pill's measured height while it shows, "0px" otherwise.
 * The default layout pads the end of the panel bodies by it, so the pill
 * never covers the last thing on a page (a form's "Guardar", a list's
 * pagination). Client only: it is measured after mount, never seeded on
 * the server, where the layout renders before the pill.
 */
export function useSessionPillHeight() {
  return useState<string>(HEIGHT_STATE_KEY, () => "0px");
}
</script>

<script setup lang="ts">
/**
 * Slim floating banner shown while any assembly the user can see is in
 * session, linking to its live view ("En directo"; the list of those in
 * session when there are several). It floats out of the layout flow so it
 * never shrinks the dashboard panels, and the layout reserves its height
 * at the end of the panels (useSessionPillHeight). It is hidden inside
 * that assembly, whose menu leads to the live view, and on the home page,
 * whose "En sesión ahora" block already says it. Dismissing it hides it,
 * for the rest of the tab, until another assembly goes into session or
 * the same one goes into session again after leaving it.
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

/** The home page has its own "En sesión ahora" block: one notice per fact. */
const onHome = computed(() => route.path === localePath("/"));

const visible = computed(
  () =>
    visibleAssemblies.value.length > 0 &&
    !insideOne.value &&
    !insideLive.value &&
    !onHome.value,
);

const pill = useTemplateRef<HTMLElement>("pill");
const { height: pillHeight } = useElementSize(pill, undefined, {
  box: "border-box",
});
const reservedHeight = useSessionPillHeight();
watch(
  [visible, pillHeight],
  ([shown, measured]) => {
    reservedHeight.value =
      shown && measured > 0 ? `${Math.ceil(measured)}px` : "0px";
  },
  { immediate: true },
);
onScopeDispose(() => {
  reservedHeight.value = "0px";
});

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

function storeDismissed(): void {
  try {
    sessionStorage.setItem(
      DISMISSED_STORAGE_KEY,
      JSON.stringify(dismissed.value),
    );
  } catch {
    // No storage (private mode, blocked): it stays closed until a reload.
  }
}

function dismiss(): void {
  dismissed.value = [
    ...new Set([
      ...dismissed.value,
      ...visibleAssemblies.value.map((i) => i.id),
    ]),
  ];
  storeDismissed();
}

/**
 * Forgets the closed pills of assemblies no longer in session, so a later
 * sitting of the same assembly (adjourned and opened again another day)
 * shows the pill again. Only on a whole list: a partial page says nothing
 * of the assemblies left out.
 */
function pruneDismissed(): void {
  const list = data.value;
  if (!list || list.items.length < list.total) return;
  const live = new Set(inSession.value.map((item) => item.id));
  const kept = dismissed.value.filter((id) => live.has(id));
  if (kept.length === dismissed.value.length) return;
  dismissed.value = kept;
  storeDismissed();
}

/** A pill closed earlier in this tab stays closed after a reload. */
function restoreDismissed(): void {
  try {
    const stored: unknown = JSON.parse(
      sessionStorage.getItem(DISMISSED_STORAGE_KEY) ?? "[]",
    );
    if (!Array.isArray(stored)) return;
    const ids = stored.filter((id): id is string => typeof id === "string");
    if (ids.length > 0) {
      dismissed.value = [...new Set([...dismissed.value, ...ids])];
    }
  } catch {
    // Unreadable or blocked storage: nothing was kept.
  }
  pruneDismissed();
}

watch(data, () => {
  if (import.meta.client) pruneDismissed();
});

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
  restoreDismissed();
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
        ref="pill"
        class="bg-inverted text-inverted ring-default fixed inset-x-4 bottom-4 flex min-h-11 items-center gap-2 rounded-full py-1 ps-4 pe-1 shadow-lg ring sm:inset-x-auto sm:end-6 sm:bottom-6 sm:max-w-md"
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
          class="group flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-full text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        >
          <span class="min-w-0 flex-1 py-1 text-pretty wrap-anywhere">{{
            message
          }}</span>
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
          size="md"
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
