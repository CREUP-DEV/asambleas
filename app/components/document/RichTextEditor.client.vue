<script setup lang="ts">
import type { EditorToolbarItem } from "@nuxt/ui";
import {
  RICH_TEXT_MAX_HTML_LENGTH,
  countRichTextWords,
  getRichTextPlainText,
} from "~~/shared/utils/richText";

const props = defineProps<{
  modelValue: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const { t, locale } = useI18n();

const model = computed({
  get: () => props.modelValue,
  set: (value: string) => emit("update:modelValue", value),
});

const plainText = computed(() => getRichTextPlainText(model.value));
const visibleCharacterCount = computed(() => plainText.value.length);
const wordCount = computed(() => countRichTextWords(model.value));
const htmlCharacterCount = computed(() => model.value.length);
const remainingHtmlCharacters = computed(
  () => RICH_TEXT_MAX_HTML_LENGTH - htmlCharacterCount.value,
);
const countFormatter = computed(() => new Intl.NumberFormat(locale.value));
const countStateClass = computed(() => {
  if (remainingHtmlCharacters.value < 0) return "text-error";
  if (remainingHtmlCharacters.value <= 10_000) return "text-warning";
  return "text-muted";
});

const editorToolbarItems: EditorToolbarItem[][] = [
  [
    { kind: "mark", mark: "bold", icon: "i-tabler-bold" },
    { kind: "mark", mark: "italic", icon: "i-tabler-italic" },
    { kind: "mark", mark: "underline", icon: "i-tabler-underline" },
  ],
  [
    { kind: "heading", level: 2, icon: "i-tabler-h-2" },
    { kind: "heading", level: 3, icon: "i-tabler-h-3" },
    { kind: "paragraph", icon: "i-tabler-pilcrow" },
  ],
  [
    { kind: "bulletList", icon: "i-tabler-list" },
    { kind: "orderedList", icon: "i-tabler-list-numbers" },
    { kind: "blockquote", icon: "i-tabler-blockquote" },
  ],
  [
    { kind: "undo", icon: "i-tabler-arrow-back-up" },
    { kind: "redo", icon: "i-tabler-arrow-forward-up" },
    { kind: "clearFormatting", icon: "i-tabler-clear-formatting" },
  ],
];
</script>

<template>
  <div class="overflow-hidden rounded-lg border border-default">
    <UEditor
      v-model="model"
      content-type="html"
      :disabled="disabled"
      :placeholder="{
        placeholder: t('document.editor.placeholder'),
        mode: 'firstLine',
      }"
      :image="false"
      :mention="false"
      :ui="{
        root: 'min-h-64',
        content: 'min-h-56',
        base: 'rich-text min-h-56 px-4 py-4 text-sm focus:outline-none',
      }"
    >
      <template #default="{ editor }">
        <UEditorToolbar :editor="editor" :items="editorToolbarItems" />
      </template>
    </UEditor>

    <div
      class="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/40 px-4 py-2 text-xs"
      :class="countStateClass"
    >
      <span>
        {{ countFormatter.format(visibleCharacterCount) }}
        {{ t("document.editor.visibleCharacters") }} ·
        {{ countFormatter.format(wordCount) }}
        {{ t("document.editor.words") }}
      </span>
      <span>
        HTML:
        {{ countFormatter.format(htmlCharacterCount) }} /
        {{ countFormatter.format(RICH_TEXT_MAX_HTML_LENGTH) }}
      </span>
    </div>
  </div>
</template>
