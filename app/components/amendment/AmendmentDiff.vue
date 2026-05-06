<script setup lang="ts">
import {
  computeRichTextPatchDiff,
  type DiffSegment,
} from "~/utils/diffRenderer";

const props = defineProps<{
  baseContent: string | null;
  contentPatch: string;
}>();

const { t } = useI18n();
const { diffDisplayMode } = useAccessibilityPreferences();
const viewMode = ref<"inline" | "sideBySide">("inline");

const diffParts = computed(() => {
  const result = computeRichTextPatchDiff(
    props.baseContent,
    props.contentPatch,
  );
  return {
    originalText: result.originalText,
    modifiedText: result.modifiedText,
    segments: result.segments.map((segment, index) => ({
      ...segment,
      id: `${segment.type}-${index}`,
    })),
  };
});

const partClass = (type: DiffSegment["type"]) => {
  if (type === "insert") {
    return diffDisplayMode.value === "marks"
      ? "font-bold underline"
      : "bg-green-100 text-green-800";
  }
  if (type === "delete") {
    return diffDisplayMode.value === "marks"
      ? "line-through"
      : "text-red-700 line-through";
  }
  return "";
};
</script>

<template>
  <div class="rounded-lg border border-default bg-muted/20 p-3">
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h4 class="text-sm font-medium">{{ t("amendment.viewDiff") }}</h4>
      <UButtonGroup size="xs">
        <UButton
          :variant="viewMode === 'inline' ? 'solid' : 'soft'"
          color="neutral"
          @click="viewMode = 'inline'"
        >
          {{ t("amendment.diff.inline") }}
        </UButton>
        <UButton
          :variant="viewMode === 'sideBySide' ? 'solid' : 'soft'"
          color="neutral"
          @click="viewMode = 'sideBySide'"
        >
          {{ t("amendment.diff.sideBySide") }}
        </UButton>
      </UButtonGroup>
    </div>

    <p
      v-if="viewMode === 'inline'"
      class="whitespace-pre-wrap text-sm leading-6"
    >
      <span
        v-for="part in diffParts.segments"
        :key="part.id"
        :class="partClass(part.type)"
      >
        {{ part.text }}
      </span>
    </p>

    <div v-else class="grid gap-3 md:grid-cols-2">
      <section class="rounded border border-default bg-background p-3">
        <h5 class="mb-2 text-xs font-semibold uppercase text-muted">
          {{ t("amendment.diff.original") }}
        </h5>
        <p class="whitespace-pre-wrap text-sm leading-6">
          {{ diffParts.originalText }}
        </p>
      </section>
      <section class="rounded border border-default bg-background p-3">
        <h5 class="mb-2 text-xs font-semibold uppercase text-muted">
          {{ t("amendment.diff.proposed") }}
        </h5>
        <p class="whitespace-pre-wrap text-sm leading-6">
          {{ diffParts.modifiedText }}
        </p>
      </section>
    </div>
  </div>
</template>
