<script setup lang="ts">
import type { ProponentPosition } from "~~/shared/constants/domain";

/**
 * End of the review: how many amendments got each answer, the
 * transactionals the presenter approved or rejected (from the data, so a
 * reload keeps them) and those still waiting, and the next step. With answers left, "Responder las que
 * faltan" is the one primary action; with none, going back to the document.
 */
const props = withDefaults(
  defineProps<{
    counts: Record<ProponentPosition, number>;
    transactionals: { approved: number; rejected: number; left: number };
    /** Where "Volver al documento" goes. */
    documentTo: string;
    /** The document was voted: answers can no longer change. */
    readOnly?: boolean;
  }>(),
  { readOnly: false },
);

const emit = defineEmits<{ answerLeft: []; reviewAll: [] }>();

const { t } = useI18n();
const titleId = useId();
const heading = useTemplateRef<HTMLElement>("heading");

const left = computed(() => props.counts.pending + props.transactionals.left);
const answeredTotal = computed(
  () => props.counts.accept + props.counts.reject + props.counts.transact,
);

const title = computed(() => {
  if (props.readOnly) return t("proponentReview.summary.readOnly");
  if (left.value === 0) return t("proponentReview.summary.done");
  return t("proponentReview.summary.left", { count: left.value }, left.value);
});

const rows = computed(() =>
  [
    { key: "accept", value: props.counts.accept, always: true },
    { key: "reject", value: props.counts.reject, always: true },
    { key: "transact", value: props.counts.transact, always: true },
    { key: "pending", value: props.counts.pending, always: false },
    {
      key: "transactionalsApproved",
      value: props.transactionals.approved,
      always: false,
    },
    {
      key: "transactionalsRejected",
      value: props.transactionals.rejected,
      always: false,
    },
    {
      key: "transactionalsLeft",
      value: props.transactionals.left,
      always: false,
    },
  ].filter((row) => row.always || row.value > 0),
);

defineExpose({
  focus: () => heading.value?.focus(),
});
</script>

<template>
  <section
    class="border-default space-y-5 rounded-lg border p-5 sm:p-6"
    :aria-labelledby="titleId"
  >
    <div class="flex items-start gap-3">
      <UIcon
        :name="
          readOnly
            ? 'i-lucide-lock'
            : left === 0
              ? 'i-lucide-circle-check-big'
              : 'i-lucide-list-todo'
        "
        class="mt-0.5 size-7 shrink-0"
        :class="left === 0 && !readOnly ? 'text-success' : 'text-muted'"
        aria-hidden="true"
      />
      <div class="space-y-1">
        <h3
          :id="titleId"
          ref="heading"
          tabindex="-1"
          class="text-highlighted text-xl font-bold outline-none"
        >
          {{ title }}
        </h3>
        <p class="text-muted text-sm">
          {{
            readOnly
              ? t("proponentReview.summary.readOnlyDescription")
              : t("proponentReview.summary.description")
          }}
        </p>
      </div>
    </div>

    <dl
      v-if="answeredTotal > 0 || left > 0"
      class="divide-default border-default divide-y rounded-md border"
    >
      <div
        v-for="row in rows"
        :key="row.key"
        class="flex items-center justify-between gap-3 px-3 py-2 text-sm"
      >
        <dt class="text-default">
          {{ t(`proponentReview.summary.counts.${row.key}`) }}
        </dt>
        <dd class="text-highlighted font-semibold tabular-nums">
          {{ row.value }}
        </dd>
      </div>
    </dl>

    <div class="flex flex-wrap gap-2">
      <template v-if="readOnly">
        <UButton
          :to="documentTo"
          icon="i-lucide-arrow-left"
          :label="t('proponentReview.back')"
        />
      </template>
      <template v-else-if="left > 0">
        <UButton
          icon="i-lucide-list-todo"
          :label="t('proponentReview.summary.answerLeft')"
          @click="emit('answerLeft')"
        />
        <UButton
          :to="documentTo"
          color="neutral"
          variant="outline"
          icon="i-lucide-arrow-left"
          :label="t('proponentReview.back')"
        />
      </template>
      <template v-else>
        <UButton
          :to="documentTo"
          icon="i-lucide-arrow-left"
          :label="t('proponentReview.back')"
        />
        <UButton
          v-if="answeredTotal > 0"
          color="neutral"
          variant="outline"
          icon="i-lucide-rotate-ccw"
          :label="t('proponentReview.summary.reviewAll')"
          @click="emit('reviewAll')"
        />
      </template>
    </div>
  </section>
</template>
