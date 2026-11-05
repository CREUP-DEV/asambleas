<script setup lang="ts">
import type { AmendmentDto } from "~~/shared/types/api";
import type { Block } from "~~/shared/types/content";
import { touchedBlockIds } from "~~/shared/utils/content/ops";
import { blockLabels } from "~~/shared/utils/content/render";

/**
 * The change an amendment makes, in large type, over the document's
 * published text: where it acts ("3. Devolución · párrafo 2"), the global
 * replacement it stands for, and the diff of the touched paragraphs. A
 * toggle adds the paragraph before and after, for context. A return to the
 * proponent has no text to compare and says so.
 */
const props = withDefaults(
  defineProps<{
    amendment: Pick<AmendmentDto, "id" | "kind" | "ops" | "globalReplace">;
    base: Block[];
    /** Heading of the section; "Cambios propuestos" by default. */
    title?: string;
    /** Smaller type, for the amendments a transactional groups. */
    compact?: boolean;
  }>(),
  { title: undefined, compact: false },
);

const { t } = useI18n();
const titleId = useId();

const withContext = ref(false);

const hasText = computed(
  () =>
    props.amendment.ops.length > 0 &&
    props.amendment.kind !== "totality_return",
);

/** "3. Devolución · párrafo 2", from the first paragraph it touches. */
const place = computed(() => {
  const first = touchedBlockIds(props.amendment.ops)[0];
  if (!first) return null;
  const label = blockLabels(props.base).get(first);
  if (!label) return null;
  const paragraph =
    label.paragraph > 0
      ? t("amendment.detail.paragraph", { n: label.paragraph })
      : null;
  return [label.heading, paragraph].filter(Boolean).join(" · ") || null;
});
</script>

<template>
  <section class="space-y-3" :aria-labelledby="titleId">
    <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <h4 :id="titleId" class="text-highlighted text-sm font-semibold">
        {{ title ?? t("amendment.detail.changes") }}
      </h4>
      <UButton
        v-if="hasText"
        color="neutral"
        variant="ghost"
        size="xs"
        :icon="
          withContext ? 'i-lucide-fold-vertical' : 'i-lucide-unfold-vertical'
        "
        :aria-pressed="withContext"
        :label="
          withContext
            ? t('proponentReview.change.hideContext')
            : t('proponentReview.change.showContext')
        "
        @click="withContext = !withContext"
      />
    </div>

    <p v-if="place" class="text-muted flex items-start gap-1.5 text-sm">
      <UIcon
        name="i-lucide-map-pin"
        class="mt-0.5 size-4 shrink-0"
        aria-hidden="true"
      />
      <span>{{ t("proponentReview.change.where", { place }) }}</span>
    </p>

    <p v-if="amendment.globalReplace" class="text-sm">
      <UIcon
        name="i-lucide-replace-all"
        class="text-muted me-1 size-4 align-text-bottom"
        aria-hidden="true"
      />{{
        t("amendment.detail.globalReplace", {
          find: amendment.globalReplace.find,
          replace: amendment.globalReplace.replace,
        })
      }}
    </p>

    <div
      class="border-default rounded-lg border"
      :class="compact ? 'p-3' : 'review-text p-4 sm:p-6'"
    >
      <ContentAmendmentDiff
        :id="amendment.id"
        :base="base"
        :ops="amendment.ops"
        :focus="amendment.id"
        :context="withContext ? 1 : 0"
      >
        <template v-if="amendment.kind === 'totality_return'" #note>
          <UAlert
            color="neutral"
            variant="subtle"
            icon="i-lucide-file-x"
            :title="t('amendment.kinds.totality_return')"
            :description="t('amendment.detail.returnNote')"
          />
        </template>
      </ContentAmendmentDiff>
    </div>
  </section>
</template>

<style scoped>
/* Large type: the change is what the presenter decides on. */
.review-text :deep(.rich-text) {
  font-size: clamp(1.125rem, 1rem + 0.5vw, 1.375rem);
  line-height: 1.7;
}

.review-text :deep(.rich-text p + p),
.review-text :deep(.rich-text > * + *) {
  margin-top: 1em;
}

.review-text :deep(.rich-text h2),
.review-text :deep(.rich-text .cx-heading-2) {
  font-size: 1.3em;
}

.review-text :deep(.rich-text h3),
.review-text :deep(.rich-text h4),
.review-text :deep(.rich-text .cx-heading-3),
.review-text :deep(.rich-text .cx-heading-4) {
  font-size: 1.15em;
}
</style>
