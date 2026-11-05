<script setup lang="ts">
import {
  positionAnswer,
  type ProponentAnswer,
  type ProponentReviewItem,
} from "./-review";

/**
 * Every step of the review in one clean list, to jump to any of them: the
 * transactionals waiting for approval, then the amendments with their
 * answer ("Sin responder", "Aceptada"...). The one on screen is marked,
 * and so are those with a comment typed and not saved.
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

const groups = computed(() =>
  (
    [
      {
        key: "transactionals",
        items: props.items.filter((item) => item.kind === "transactional"),
      },
      {
        key: "amendments",
        items: props.items.filter((item) => item.kind === "position"),
      },
    ] as const
  ).filter((group) => group.items.length > 0),
);

const ANSWER_ICONS: Record<
  ProponentAnswer | "pending",
  { name: string; color: string }
> = {
  pending: { name: "i-lucide-circle-dashed", color: "text-dimmed" },
  accept: { name: "i-lucide-check", color: "text-success" },
  reject: { name: "i-lucide-x", color: "text-error" },
  transact: { name: "i-lucide-handshake", color: "text-info" },
};

function answerOf(item: ProponentReviewItem): ProponentAnswer | "pending" {
  return item.kind === "position"
    ? (positionAnswer(item.amendment) ?? "pending")
    : "pending";
}

function statusOf(item: ProponentReviewItem): string {
  if (item.kind === "transactional") {
    return t("proponentReview.list.toApprove");
  }
  return t(`proponentReview.answers.${answerOf(item)}`);
}

function labelOf(item: ProponentReviewItem): string {
  return amendmentDisplayLabel(item.amendment) ?? t("proponentReview.noCode");
}

function iconOf(item: ProponentReviewItem): { name: string; color: string } {
  return item.kind === "transactional"
    ? { name: "i-lucide-hourglass", color: "text-warning" }
    : ANSWER_ICONS[answerOf(item)];
}
</script>

<template>
  <nav class="space-y-4" :aria-label="t('proponentReview.list.title')">
    <section v-for="group in groups" :key="group.key" class="space-y-1.5">
      <h4 class="text-muted px-2 text-xs font-semibold tracking-wide uppercase">
        {{ t(`proponentReview.list.${group.key}`) }}
      </h4>
      <ul class="space-y-0.5">
        <li v-for="item in group.items" :key="item.id">
          <button
            type="button"
            class="hover:bg-elevated focus-visible:ring-primary flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm focus-visible:ring-2 focus-visible:outline-none"
            :class="
              item.id === currentId
                ? 'bg-elevated text-highlighted font-medium'
                : 'text-default'
            "
            :aria-current="item.id === currentId ? 'step' : undefined"
            @click="emit('select', item.id)"
          >
            <UIcon
              :name="iconOf(item).name"
              class="size-4 shrink-0"
              :class="iconOf(item).color"
              aria-hidden="true"
            />
            <span class="min-w-0 flex-1 truncate tabular-nums">
              {{ labelOf(item) }}
            </span>
            <span
              v-if="unsavedIds.has(item.id)"
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
              {{ statusOf(item) }}
            </span>
          </button>
        </li>
      </ul>
    </section>
  </nav>
</template>
