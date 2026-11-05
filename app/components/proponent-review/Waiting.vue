<script setup lang="ts">
import type { PositionWaitCounts } from "./-review";

/**
 * What is still on its way to the main presenter, one calm sentence per
 * reason (positionWaitCounts): late amendments the assembly has not decided
 * to treat, transactionals their main authors have not accepted, and, for
 * the Mesa and the Secretaría (the only ones who see them), amendments the
 * Secretaría has not validated or published yet. Nothing renders when
 * nothing waits. `reader` words it for a co-presenter, who never answers:
 * the lines that promise an answer ("podrás responderla") say instead that
 * it can be answered afterwards.
 */
const props = withDefaults(
  defineProps<{
    counts: PositionWaitCounts;
    reader?: boolean;
  }>(),
  { reader: false },
);

const { t } = useI18n();

const lines = computed(() => {
  const { admission, authors, publication, validation } = props.counts;
  return [
    {
      key: "admission",
      count: admission,
      icon: "i-lucide-clock-alert",
      text: t(
        props.reader
          ? "proponentReview.coPresenter.awaitingAdmission"
          : "proponentReview.progress.awaitingAdmission",
        { count: admission },
        admission,
      ),
    },
    {
      key: "authors",
      count: authors,
      icon: "i-lucide-handshake",
      text: t("proponentReview.waiting.authors", { count: authors }, authors),
    },
    {
      key: "publication",
      count: publication,
      icon: "i-lucide-eye-off",
      text: t(
        props.reader
          ? "proponentReview.coPresenter.awaitingPublication"
          : "proponentReview.waiting.publication",
        { count: publication },
        publication,
      ),
    },
    {
      key: "validation",
      count: validation,
      icon: "i-lucide-file-search",
      text: t(
        "proponentReview.waiting.validation",
        { count: validation },
        validation,
      ),
    },
  ].filter((line) => line.count > 0);
});
</script>

<template>
  <ul v-if="lines.length > 0" class="space-y-1">
    <li
      v-for="line in lines"
      :key="line.key"
      class="text-muted flex items-start gap-1.5 text-sm"
    >
      <UIcon
        :name="line.icon"
        class="mt-0.5 size-4 shrink-0"
        aria-hidden="true"
      />
      <span>{{ line.text }}</span>
    </li>
  </ul>
</template>
