<script setup lang="ts">
import type { ElectionRecord } from "~~/shared/utils/election";

/**
 * An election's result (user's decisions of 2026-11-21): who was elected or
 * goes to a second round, then every candidate with their votes, most voted
 * first. `size` follows where it sits: the projection reads it from afar.
 */
const props = withDefaults(
  defineProps<{ election: ElectionRecord; size?: "sm" | "lg" }>(),
  { size: "sm" },
);

const { t } = useI18n();
const text = useElectionText();
const rows = computed(() => text.rows(props.election));
</script>

<template>
  <div :class="size === 'lg' ? 'space-y-2' : 'space-y-1'">
    <p :class="['text-muted', size === 'lg' ? 'text-lg' : 'text-xs']">
      {{ text.rule(election) }}
    </p>
    <ol
      :class="[
        'grid gap-x-6 gap-y-1',
        size === 'lg' ? 'text-2xl sm:grid-cols-2' : 'text-sm',
      ]"
    >
      <li
        v-for="row in rows"
        :key="row.index"
        class="flex items-baseline justify-between gap-3"
      >
        <span
          :class="[
            'min-w-0 break-words',
            row.elected ? 'text-highlighted font-semibold' : 'text-default',
          ]"
        >
          <UIcon
            v-if="row.elected"
            name="i-lucide-check"
            class="text-success me-1 align-[-0.125em]"
            :aria-label="t('amendment.vote.election.electedMark')"
          />
          {{ row.name }}
          <UBadge
            v-if="row.runoff"
            color="warning"
            variant="subtle"
            :size="size === 'lg' ? 'lg' : 'md'"
            :label="t('amendment.vote.election.runoffMark')"
            class="ms-1 align-middle"
          />
        </span>
        <span class="text-highlighted font-semibold tabular-nums">{{
          row.count
        }}</span>
      </li>
    </ol>
  </div>
</template>
