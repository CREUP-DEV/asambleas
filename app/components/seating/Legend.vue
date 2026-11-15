<script setup lang="ts">
import type { SeatingLegendEntry } from "~~/shared/utils/seating/groups";
import { SEATING_COLOUR_STYLES } from "./-model";

/**
 * The legend of the room's colours (docs/seating-plan.md, section 7): one
 * entry per kind with people in the room, each with its own count
 * («Asociados 48/52», «CAI 1/1»). Kinds that share a colour share its
 * swatch, never a count. The colour is on the swatch only.
 */

defineProps<{ entries: readonly SeatingLegendEntry[] }>();

const { t } = useI18n();
const { legendLabel } = useSeatingWords();
</script>

<template>
  <ul
    v-if="entries.length > 0"
    class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm"
    :aria-label="t('seating.legend.label')"
  >
    <li
      v-for="entry in entries"
      :key="entry.kind"
      class="flex items-center gap-1.5"
    >
      <span
        class="inline-block size-3.5 shrink-0 rounded-full border-2"
        :style="{
          background: SEATING_COLOUR_STYLES[entry.colour].tint,
          borderColor: SEATING_COLOUR_STYLES[entry.colour].ring,
        }"
        aria-hidden="true"
      />
      <span class="text-default">{{ legendLabel(entry.kind) }}</span>
      <span class="text-muted tabular-nums">
        {{
          t("seating.legend.count", {
            seated: entry.seated,
            total: entry.total,
          })
        }}
      </span>
    </li>
  </ul>
</template>
