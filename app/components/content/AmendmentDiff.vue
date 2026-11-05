<script setup lang="ts">
import type { AmendmentOp, Block } from "~~/shared/types/content";
import { previewAmendment } from "~~/shared/utils/content/consolidate";
import { validateOps } from "~~/shared/utils/content/ops";

/**
 * The changes of one amendment over the base version, in diff mode: the
 * touched blocks (plus `context` blocks around them) with insertions and
 * removals marked as the user's diff preference says.
 *
 * Totality amendments without operations have no text to compare: the `note`
 * slot is shown instead (with a generic note by default). Operations that no
 * longer apply to `base` show a warning instead of a broken preview.
 * Headings in the excerpt are styled text, not page headings.
 */
const props = withDefaults(
  defineProps<{
    base: Block[];
    ops: AmendmentOp[];
    /** Amendment id, used to attribute the changes. */
    id: string;
    /** Unchanged blocks shown before and after each change. */
    context?: number;
    /** Highlights the fragments of this amendment (when several are shown). */
    focus?: string | null;
    interactive?: boolean;
  }>(),
  { context: 0, focus: null, interactive: false },
);

const emit = defineEmits<{
  "block-click": [blockId: string, event: MouseEvent | KeyboardEvent];
  "amendment-click": [amendmentId: string];
}>();

const { t } = useI18n();

const hasOps = computed(() => props.ops.length > 0);
const invalid = computed(
  () => hasOps.value && validateOps(props.base, props.ops).length > 0,
);
const annotated = computed(() =>
  hasOps.value && !invalid.value
    ? previewAmendment(
        props.base,
        { id: props.id, ops: props.ops },
        Math.max(0, props.context),
      )
    : [],
);
</script>

<template>
  <div class="min-w-0">
    <slot v-if="!hasOps" name="note">
      <UAlert
        color="neutral"
        variant="subtle"
        icon="i-lucide-file-text"
        :title="t('common.content.totalityTitle')"
        :description="t('common.content.totalityNote')"
      />
    </slot>

    <UAlert
      v-else-if="invalid"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t('common.content.previewUnavailable')"
      :description="t('common.content.previewUnavailableDescription')"
    />

    <ContentView
      v-else
      :annotated="annotated"
      mode="diff"
      :focus="focus"
      :interactive="interactive"
      :headings="false"
      @block-click="(blockId, event) => emit('block-click', blockId, event)"
      @amendment-click="(amendmentId) => emit('amendment-click', amendmentId)"
    />
  </div>
</template>
