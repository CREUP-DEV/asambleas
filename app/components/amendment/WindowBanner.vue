<script setup lang="ts">
import type { DocumentDto } from "~~/shared/types/api";

/**
 * State of a document's amendment window: open (with the countdown to its
 * close), not open yet, or closed. When it is closed but the actor can still
 * present amendments, it warns that they will be late and need admission.
 */
const props = defineProps<{
  document: Pick<
    DocumentDto,
    "window" | "amendable" | "format" | "status" | "finalVote" | "can"
  >;
}>();

const { t } = useI18n();

// Re-evaluated when a countdown expires, so the banner flips on its own.
const tick = ref(0);
function onExpired(): void {
  tick.value += 1;
}

type BannerState = "voted" | "upcoming" | "open" | "closed" | "unbounded";

const state = computed<BannerState | null>(() => {
  void tick.value;
  const { document } = props;
  if (
    document.format !== "structured" ||
    !document.amendable ||
    document.status !== "published"
  ) {
    return null;
  }
  if (document.finalVote) return "voted";
  const now = Date.now();
  const opensAt = toDate(document.window.opensAt);
  const closesAt = toDate(document.window.closesAt);
  if (opensAt && opensAt.getTime() > now) return "upcoming";
  if (closesAt && closesAt.getTime() <= now) return "closed";
  if (closesAt) return "open";
  return "unbounded";
});

const alert = computed(() => {
  switch (state.value) {
    case "voted":
      return {
        color: "neutral" as const,
        icon: "i-lucide-lock",
        title: t("workspace.window.voted"),
      };
    case "upcoming":
      return {
        color: "info" as const,
        icon: "i-lucide-calendar-clock",
        title: t("workspace.window.upcoming"),
      };
    case "open":
      return {
        color: "success" as const,
        icon: "i-lucide-pencil-line",
        title: t("workspace.window.open"),
      };
    case "unbounded":
      return {
        color: "success" as const,
        icon: "i-lucide-pencil-line",
        title: t("workspace.window.openUnbounded"),
      };
    case "closed":
      return props.document.can.amend
        ? {
            color: "warning" as const,
            icon: "i-lucide-clock-alert",
            title: t("workspace.window.closedLateTitle"),
          }
        : {
            color: "neutral" as const,
            icon: "i-lucide-clock",
            title: t("workspace.window.closed"),
          };
    default:
      return null;
  }
});
</script>

<template>
  <UAlert
    v-if="alert"
    :color="alert.color"
    variant="subtle"
    :icon="alert.icon"
    :title="alert.title"
    :ui="{ root: 'py-2.5', description: 'mt-0.5' }"
  >
    <template #description>
      <span v-if="state === 'upcoming' && document.window.opensAt">
        <CommonCountdown
          :to="document.window.opensAt"
          :label="t('workspace.window.opens')"
          @expired="onExpired"
        />
      </span>
      <span v-else-if="state === 'open' && document.window.closesAt">
        <CommonCountdown
          :to="document.window.closesAt"
          :label="t('workspace.window.closes')"
          :urgent-hours="24"
          @expired="onExpired"
        />
      </span>
      <span v-else-if="state === 'closed'" class="block">
        <template v-if="document.can.amend">
          {{ t("workspace.window.closedLate") }}
        </template>
        <template v-if="document.window.closesAt">
          {{ " " }}
          <CommonCountdown
            :to="document.window.closesAt"
            :label="t('workspace.window.closedSince')"
          />
        </template>
      </span>
      <span v-else-if="state === 'unbounded'">
        {{ t("workspace.window.openUnboundedDescription") }}
      </span>
    </template>
  </UAlert>
</template>
