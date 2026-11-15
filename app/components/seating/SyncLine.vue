<script setup lang="ts">
import type { SeatingSyncDto } from "~~/shared/types/api";
import { formatRelative } from "~/utils/format";

/**
 * The header's line about the Intranet's attendees (docs/seating-plan.md,
 * section 5): «Intranet: 80.ª Asamblea General Ordinaria, hace 3 min» and
 * «Sincronizar» for editors. When no Intranet event carries the assembly it
 * says so and offers another assembly's attendees. When the Intranet does
 * not have the route yet it says nothing (the room works with groups made
 * by hand): editors keep only «Sincronizar», and the page tells whoever
 * presses it. Without an Intranet configured it shows nothing at all.
 */

const props = defineProps<{
  sync: SeatingSyncDto;
  syncing: boolean;
  canEdit: boolean;
  /** «79.ª AGO» when the attendees are read from another assembly. */
  sourceLabel: string | null;
}>();

const emit = defineEmits<{ sync: []; "read-other": [] }>();

const { t, locale } = useI18n();
const now = useAppNow();
const { syncStatusKey } = useSeatingWords();

const statusKey = computed(() => syncStatusKey(props.sync));
/** Editors may sync whenever an Intranet is configured. */
const canSync = computed(
  () => props.canEdit && props.sync.status !== "unconfigured",
);
const when = computed(() =>
  props.sync.at
    ? formatRelative(props.sync.at, { locale: locale.value, now: now.value })
    : "",
);

const icon = computed(() => {
  switch (props.sync.status) {
    case "ok":
      return "i-lucide-cloud-check";
    case "not_found":
      return "i-lucide-calendar-x";
    case "failed":
      return "i-lucide-cloud-alert";
    default:
      return "i-lucide-cloud";
  }
});
</script>

<template>
  <div
    v-if="statusKey || canSync"
    class="text-muted flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
  >
    <span v-if="statusKey" class="flex min-w-0 items-center gap-1.5">
      <UIcon :name="icon" class="size-4 shrink-0" aria-hidden="true" />
      <span class="min-w-0">
        {{ t(statusKey, { event: sync.eventName ?? "", when }) }}
        <template v-if="sourceLabel">
          · {{ t("seating.sync.source", { label: sourceLabel }) }}
        </template>
      </span>
    </span>
    <UButton
      v-if="canEdit && sync.status === 'not_found'"
      color="neutral"
      variant="link"
      size="sm"
      class="px-0"
      :label="t('seating.source.readOther')"
      @click="emit('read-other')"
    />
    <UButton
      v-if="canSync"
      color="neutral"
      variant="ghost"
      size="xs"
      icon="i-lucide-refresh-cw"
      :loading="syncing"
      :label="syncing ? t('seating.sync.syncing') : t('seating.sync.button')"
      @click="emit('sync')"
    />
  </div>
</template>
