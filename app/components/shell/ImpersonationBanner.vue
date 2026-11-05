<script lang="ts">
import { useState } from "#imports";

const OFFSET_STATE_KEY = "shell-impersonation-banner-offset";
/** Before the banner is measured (server render): one line of it. */
const ESTIMATED_OFFSET = "2.75rem";

/**
 * How far the banner pushes the fixed dashboard down: its measured height
 * while it shows, "0px" otherwise. The default layout offsets the
 * dashboard group by it, so the banner never covers the navbars.
 */
export function useImpersonationBannerOffset() {
  return useState<string>(OFFSET_STATE_KEY, () => "0px");
}
</script>

<script setup lang="ts">
/**
 * Shown on every page (app.vue mounts it, so pages without the dashboard
 * get it too) while an Admin acts as another account: whose account it is,
 * that everything is recorded, when it ends by itself, and "Volver a mi
 * cuenta". It cannot be dismissed.
 *
 * Accessibility: a status region with no landmark, so it is announced once
 * and does not add to the page's landmarks; an icon and the wording say
 * what it is, not only its colour; the end time is fixed text, never a
 * ticking countdown, so the region does not chatter; the button is a real,
 * keyboard-reachable button.
 *
 * At the end time it asks the server again (GET /api/me) and reloads the
 * page once the server no longer runs it as this very account under this
 * very impersonation (ended, or replaced by another one in another tab), so
 * a skewed clock cannot loop and a stale tab never adopts another account.
 */

/** Wait this long before asking again when the end time has passed. */
const RECHECK_MS = 15_000;
/** Margin after the end time before asking. */
const EXPIRY_MARGIN_MS = 1_000;

const { t, locale } = useI18n();
const { me, member, impersonation, refresh } = useMe();
const { stopImpersonating } = useAuth();
const { notifyError } = useApi();

const offset = useImpersonationBannerOffset();
const banner = useTemplateRef<HTMLElement>("banner");
const { height } = useElementSize(banner, undefined, { box: "border-box" });

const stopping = ref(false);

const name = computed(() => me.value?.name || me.value?.email || "");
const endsAt = computed(() =>
  impersonation.value
    ? formatTime(impersonation.value.expiresAt, { locale: locale.value })
    : "",
);

// The server render has no size yet: assume one line, then measure.
if (impersonation.value && offset.value === "0px") {
  offset.value = ESTIMATED_OFFSET;
}
watch([height, impersonation], ([value, current]) => {
  if (!current) offset.value = "0px";
  else if (value > 0) offset.value = `${Math.ceil(value)}px`;
});

async function stop(): Promise<void> {
  if (stopping.value) return;
  stopping.value = true;
  try {
    // Reloads the page as the Admin; the button stays busy until then.
    await stopImpersonating();
  } catch (error) {
    stopping.value = false;
    notifyError(error, "shell.impersonation.stopFailed");
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;

function clearTimer(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

/**
 * Reloads once the server no longer runs this page as the same account
 * under the same impersonation; otherwise waits again. useMe.refresh never
 * stores another identity (it reloads too), and this compares both ids
 * itself rather than only checking that some impersonation goes on.
 */
async function checkEnded(): Promise<void> {
  clearTimer();
  const expectedUser = me.value?.id ?? null;
  const expectedImpersonation = impersonation.value?.id ?? null;
  const fresh = await refresh();
  if (
    expectedImpersonation !== null &&
    fresh?.id === expectedUser &&
    fresh?.impersonation?.id === expectedImpersonation
  ) {
    schedule();
    return;
  }
  reloadNuxtApp({ force: true });
}

function schedule(): void {
  clearTimer();
  const current = impersonation.value;
  if (!current) return;
  const left = Date.parse(current.expiresAt) - Date.now();
  timer = setTimeout(
    () => void checkEnded(),
    left > 0 ? left + EXPIRY_MARGIN_MS : RECHECK_MS,
  );
}

onMounted(() => {
  watch(() => impersonation.value?.expiresAt, schedule, { immediate: true });
});
onBeforeUnmount(clearTimer);

// Timers wait in background tabs: check again when the tab comes back.
const visibility = useDocumentVisibility();
watch(visibility, (state) => {
  const current = impersonation.value;
  if (
    state === "visible" &&
    current &&
    Date.parse(current.expiresAt) <= Date.now()
  ) {
    void checkEnded();
  }
});
</script>

<template>
  <div
    v-if="impersonation"
    ref="banner"
    role="status"
    class="sticky top-0 border-b border-(--ui-color-warning-400) bg-(--ui-color-warning-100) text-(--ui-color-warning-950) print:hidden dark:border-(--ui-color-warning-700) dark:bg-(--ui-color-warning-950) dark:text-(--ui-color-warning-50)"
  >
    <div
      class="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-1.5 text-sm"
    >
      <UIcon
        name="i-lucide-venetian-mask"
        class="size-5 shrink-0"
        aria-hidden="true"
      />
      <p class="min-w-0 flex-1">
        <strong class="font-semibold">
          {{
            member
              ? t("shell.impersonation.actingAsMember", {
                  name,
                  member: member.acronym,
                })
              : t("shell.impersonation.actingAs", { name })
          }}
        </strong>
        <span class="ms-1">
          {{ t("shell.impersonation.details", { time: endsAt }) }}
        </span>
      </p>
      <UButton
        color="neutral"
        variant="solid"
        size="sm"
        icon="i-lucide-undo-2"
        :loading="stopping"
        class="shrink-0"
        @click="stop"
      >
        {{ t("shell.impersonation.stop") }}
      </UButton>
    </div>
  </div>
</template>
