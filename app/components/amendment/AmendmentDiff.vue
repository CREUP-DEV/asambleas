<script setup lang="ts">
import DiffMatchPatch from "diff-match-patch";
import { applyPatch } from "~~/shared/utils/diff";
import { getRichTextPlainText } from "~~/shared/utils/richText";

const props = defineProps<{
  baseContent: string | null;
  contentPatch: string;
}>();

const { t } = useI18n();
const { diffDisplayMode } = useAccessibilityPreferences();

const dmp = new DiffMatchPatch();

const proposedContent = computed(() => {
  const base = props.baseContent ?? "";
  return applyPatch(base, props.contentPatch) ?? base;
});

const diffParts = computed(() => {
  const diffs = dmp.diff_main(
    getRichTextPlainText(props.baseContent),
    getRichTextPlainText(proposedContent.value),
  );
  dmp.diff_cleanupSemantic(diffs);
  return diffs.map(([operation, text], index) => ({
    id: `${operation}-${index}`,
    operation,
    text,
  }));
});

const partClass = (operation: number) => {
  if (operation === 1) {
    return diffDisplayMode.value === "marks"
      ? "font-bold underline"
      : "bg-green-100 text-green-800";
  }
  if (operation === -1) {
    return diffDisplayMode.value === "marks"
      ? "line-through"
      : "text-red-700 line-through";
  }
  return "";
};
</script>

<template>
  <div class="rounded-lg border border-default bg-muted/20 p-3">
    <h4 class="mb-2 text-sm font-medium">{{ t("amendment.viewDiff") }}</h4>
    <p class="whitespace-pre-wrap text-sm leading-6">
      <span
        v-for="part in diffParts"
        :key="part.id"
        :class="partClass(part.operation)"
      >
        {{ part.text }}
      </span>
    </p>
  </div>
</template>
