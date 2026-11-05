<script setup lang="ts">
import {
  ANSWER_STATUS_ICONS,
  answerStatus,
  type ProponentReviewItem,
} from "./-review";

/**
 * Every step of the review in one clean list, in text order, to jump to any
 * of them, each with its answer ("Sin responder", "Aceptada",
 * "Incorporada"...). The one on screen is marked, and so are those with a
 * comment typed and not saved.
 */
const props = withDefaults(
  defineProps<{
    items: ProponentReviewItem[];
    currentId: string | null;
    /** Steps whose comment was typed and not saved. */
    unsavedIds?: ReadonlySet<string>;
  }>(),
  { unsavedIds: () => new Set<string>() },
);

const emit = defineEmits<{ select: [id: string] }>();

const { t } = useI18n();

function labelOf(item: ProponentReviewItem): string {
  return amendmentDisplayLabel(item.amendment) ?? t("proponentReview.noCode");
}

const rows = computed(() =>
  props.items.map((item) => {
    const status = answerStatus(item.amendment);
    return {
      id: item.id,
      label: labelOf(item),
      status: t(`proponentReview.answers.${status}`),
      icon: ANSWER_STATUS_ICONS[status],
    };
  }),
);
</script>

<template>
  <nav :aria-label="t('proponentReview.list.title')">
    <ul class="space-y-0.5">
      <li v-for="row in rows" :key="row.id">
        <button
          type="button"
          class="hover:bg-elevated focus-visible:ring-primary flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm focus-visible:ring-2 focus-visible:outline-none"
          :class="
            row.id === currentId
              ? 'bg-elevated text-highlighted font-medium'
              : 'text-default'
          "
          :aria-current="row.id === currentId ? 'step' : undefined"
          @click="emit('select', row.id)"
        >
          <UIcon
            :name="row.icon.name"
            class="size-4 shrink-0"
            :class="row.icon.color"
            aria-hidden="true"
          />
          <span class="min-w-0 flex-1 truncate tabular-nums">
            {{ row.label }}
          </span>
          <span
            v-if="unsavedIds.has(row.id)"
            class="text-warning flex shrink-0 items-center gap-1 text-xs font-medium"
          >
            <UIcon
              name="i-lucide-message-square-warning"
              class="size-3.5"
              aria-hidden="true"
            />
            {{ t("proponentReview.list.unsaved") }}
          </span>
          <span v-else class="text-muted shrink-0 text-xs">
            {{ row.status }}
          </span>
        </button>
      </li>
    </ul>
  </nav>
</template>
