<script setup lang="ts">
import type { TimelineItem } from "@nuxt/ui";
import type { EventDto } from "~~/shared/types/api";

/**
 * Immutable history of one amendment (GET .../amendments/{id}/history) as a
 * timeline. It reloads when `version` (the amendment's updatedAt) changes.
 */
const props = defineProps<{
  /** URL of the amendment: .../amendments/{id}. */
  url: string;
  version?: string;
}>();

const { t, te, locale } = useI18n();
const api = useApi();
const titleId = useId();

const events = ref<EventDto[]>([]);
const loading = ref(false);
const failed = ref(false);
let request = 0;

async function load(): Promise<void> {
  const current = ++request;
  loading.value = true;
  failed.value = false;
  try {
    const result = await api.get<EventDto[]>(`${props.url}/history`);
    if (current === request) events.value = result;
  } catch {
    if (current === request) failed.value = true;
  } finally {
    if (current === request) loading.value = false;
  }
}

onMounted(load);
watch(() => [props.url, props.version], load);

const ICONS: Record<string, string> = {
  amendment_created: "i-lucide-file-plus",
  amendment_updated: "i-lucide-pencil",
  amendment_submitted: "i-lucide-send",
  amendment_admitted: "i-lucide-badge-check",
  amendment_inadmissible: "i-lucide-ban",
  amendment_withdrawn: "i-lucide-undo-2",
  amendment_lapsed: "i-lucide-hourglass",
  amendment_transacted: "i-lucide-git-merge",
  amendment_approved: "i-lucide-circle-check",
  amendment_rejected: "i-lucide-circle-x",
  amendment_reopened: "i-lucide-rotate-ccw",
  position_changed: "i-lucide-message-square",
  acceptance_recorded: "i-lucide-handshake",
  relation_created: "i-lucide-link-2",
  relation_deleted: "i-lucide-unlink",
};

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function detailOf(event: EventDto): string | null {
  const payload = event.payload ?? {};
  switch (event.type) {
    case "position_changed": {
      const position = text(payload.position);
      return position ? t(`amendment.position.options.${position}`) : null;
    }
    case "acceptance_recorded": {
      const decision = text(payload.decision);
      return decision ? t(`common.status.acceptance.${decision}`) : null;
    }
    case "amendment_approved": {
      const method = text(payload.method);
      return method ? t(`amendment.approvalMethods.${method}`) : null;
    }
    case "amendment_submitted":
      return payload.late === true ? t("amendment.late") : null;
    case "relation_created":
    case "relation_deleted": {
      const kind = text(payload.kind);
      return kind ? t(`amendment.relations.kinds.${kind}`) : null;
    }
    default:
      return null;
  }
}

function actorOf(event: EventDto): string | null {
  if (event.actorMember && event.actorName) {
    return `${event.actorMember.acronym} · ${event.actorName}`;
  }
  return event.actorMember?.acronym ?? event.actorName ?? null;
}

const items = computed<TimelineItem[]>(() =>
  events.value.map((event) => {
    const key = `amendment.history.events.${event.type}`;
    const detail = detailOf(event);
    const actor = actorOf(event);
    return {
      value: event.id,
      date: formatDateTime(event.createdAt, { locale: locale.value }),
      title: te(key) ? t(key) : t("amendment.history.events.other"),
      description: [detail, actor ? t("amendment.history.by", { actor }) : null]
        .filter(Boolean)
        .join(" · "),
      icon: ICONS[event.type] ?? "i-lucide-circle-dot",
    };
  }),
);
</script>

<template>
  <section class="flex flex-col gap-3" :aria-labelledby="titleId">
    <h3 :id="titleId" class="text-highlighted text-sm font-semibold">
      {{ t("amendment.history.title") }}
    </h3>

    <div v-if="loading && events.length === 0" class="flex flex-col gap-3">
      <USkeleton v-for="i in 3" :key="i" class="h-10 w-full" />
    </div>

    <UAlert
      v-else-if="failed"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :title="t('amendment.history.error')"
      :actions="[
        {
          label: t('amendment.actions.retry'),
          color: 'neutral',
          variant: 'outline',
          onClick: load,
        },
      ]"
    />

    <p v-else-if="events.length === 0" class="text-muted text-sm">
      {{ t("amendment.history.empty") }}
    </p>

    <UTimeline
      v-else
      :items="items"
      :default-value="items.length - 1"
      size="xs"
      color="neutral"
      :ui="{ description: 'text-xs' }"
    />
  </section>
</template>
