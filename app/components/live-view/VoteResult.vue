<script setup lang="ts">
import type { VoteDto } from "~~/shared/types/api";
import { liveVoteCounts } from "~/components/live-view/-model";

/**
 * The last vote the Mesa recorded, for the live view: what was voted, the
 * result in large type and the counts (or "por asentimiento").
 */
const props = defineProps<{
  vote: VoteDto;
  /** What was voted, already localized ("Votación de la enmienda T1"). */
  subject: string;
}>();

const { t } = useI18n();

const approved = computed(() => props.vote.result === "approved");
const counts = computed(() => liveVoteCounts(props.vote));
</script>

<template>
  <div
    class="rounded-lg border-s-4 p-4"
    :class="
      approved ? 'border-success bg-success/10' : 'border-error bg-error/10'
    "
  >
    <p class="text-muted text-sm">{{ subject }}</p>
    <p
      class="text-2xl font-bold"
      :class="
        approved
          ? 'text-(--ui-color-success-800) dark:text-(--ui-color-success-300)'
          : 'text-(--ui-color-error-700) dark:text-(--ui-color-error-300)'
      "
    >
      {{
        approved ? t("projection.vote.approved") : t("projection.vote.rejected")
      }}
    </p>
    <p v-if="vote.method === 'assent'" class="text-default mt-1">
      {{ t("session.enums.approvalMethod.assent") }}
    </p>
    <dl v-else class="mt-2 flex flex-wrap gap-x-6 gap-y-2">
      <div v-for="count in counts" :key="count.key">
        <dt class="text-muted text-xs">
          {{ t(`projection.vote.${count.key}`) }}
        </dt>
        <dd class="text-highlighted text-lg font-semibold tabular-nums">
          {{ count.value }}
        </dd>
      </div>
      <div>
        <dt class="text-muted text-xs">{{ t("projection.vote.majority") }}</dt>
        <dd class="text-default text-sm font-medium">
          {{ t(`session.enums.majority.${vote.majority}`) }}
        </dd>
      </div>
    </dl>
  </div>
</template>
