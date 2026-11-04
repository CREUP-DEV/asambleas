<script setup lang="ts">
import { createId } from "@paralleldrive/cuid2";
import type { EditorToolbarItem } from "@nuxt/ui";
import type { JSONContent } from "@tiptap/core";
import type { Block } from "~~/shared/types/content";
import {
  blocksToEditor,
  editorToBlocks,
  type EditorNode,
} from "~~/shared/utils/content/editor";
import { isSafeHref } from "~~/shared/utils/content/render";
import { BlockIdExtension } from "~/utils/editor/blockIdExtension";

/**
 * Structured content editor (UEditor / TipTap). Works on blocks: the model is
 * `Block[]`, and every paragraph and heading keeps its block id through
 * edits thanks to `BlockIdExtension`.
 *
 * Toolbar headings: "H2" sets block level 1 and "H3" block level 2, which is
 * how `renderBlocks` shows them (pages keep their own h1).
 */
const props = withDefaults(
  defineProps<{
    modelValue: Block[];
    /** Smaller toolbar (marks, link, history) for inline amendment editing. */
    compact?: boolean;
    autofocus?: boolean;
    editable?: boolean;
    placeholder?: string;
    /** Accessible name of the editing area. */
    label?: string;
  }>(),
  {
    compact: false,
    autofocus: false,
    editable: true,
    placeholder: undefined,
    label: undefined,
  },
);

const emit = defineEmits<{
  "update:modelValue": [blocks: Block[]];
}>();

const { t } = useI18n();

const EMIT_DELAY_MS = 200;

const editorComponent = useTemplateRef("editorComponent");
const editor = computed(() => editorComponent.value?.editor);

// UEditor resets its content whenever v-model differs from the editor JSON,
// which would drop the cursor and the undo history. It is therefore bound to
// this local copy, and external blocks are pushed in only when they differ
// from what the editor last emitted.
const content = shallowRef<EditorNode>(blocksToEditor(props.modelValue ?? []));
let lastSerialized = JSON.stringify(props.modelValue ?? []);
let dirty = false;

function normalize(blocks: Block[]): Block[] {
  // An empty editor still holds one empty paragraph: that is no content.
  if (
    blocks.length === 1 &&
    blocks[0]!.type === "paragraph" &&
    blocks[0]!.text === ""
  ) {
    return [];
  }
  return blocks;
}

function flush(): void {
  if (!dirty) return;
  dirty = false;
  const blocks = normalize(editorToBlocks(content.value, createId));
  const serialized = JSON.stringify(blocks);
  if (serialized === lastSerialized) return;
  lastSerialized = serialized;
  emit("update:modelValue", blocks);
}

const scheduleFlush = useDebounceFn(flush, EMIT_DELAY_MS);

function onEditorUpdate(value: unknown): void {
  content.value = value as EditorNode;
  dirty = true;
  void scheduleFlush();
}

watch(
  () => props.modelValue,
  (blocks) => {
    const serialized = JSON.stringify(blocks ?? []);
    if (serialized === lastSerialized) return;
    lastSerialized = serialized;
    dirty = false;
    content.value = blocksToEditor(blocks ?? []);
  },
);

watch(
  () => props.editable,
  (editable) => editor.value?.setEditable(editable),
);

onBeforeUnmount(flush);

// Toolbar ------------------------------------------------------------------

const toolbarSize = computed(() => (props.compact ? "xs" : "sm"));

function action(
  item: EditorToolbarItem,
  labelKey: string,
  kbds?: string[],
): EditorToolbarItem {
  const label = t(labelKey);
  return {
    ...item,
    "aria-label": label,
    tooltip: kbds ? { text: label, kbds } : { text: label },
  } as EditorToolbarItem;
}

const toolbarItems = computed<EditorToolbarItem[][]>(() => {
  const marks = [
    action(
      { kind: "mark", mark: "bold", icon: "i-lucide-bold" },
      "common.editor.bold",
      ["meta", "b"],
    ),
    action(
      { kind: "mark", mark: "italic", icon: "i-lucide-italic" },
      "common.editor.italic",
      ["meta", "i"],
    ),
    action(
      { kind: "mark", mark: "underline", icon: "i-lucide-underline" },
      "common.editor.underline",
      ["meta", "u"],
    ),
    action(
      { kind: "mark", mark: "strike", icon: "i-lucide-strikethrough" },
      "common.editor.strike",
      ["meta", "shift", "s"],
    ),
  ];
  const link = [{ slot: "link" } as EditorToolbarItem];
  const history = [
    action({ kind: "undo", icon: "i-lucide-undo-2" }, "common.editor.undo", [
      "meta",
      "z",
    ]),
    action({ kind: "redo", icon: "i-lucide-redo-2" }, "common.editor.redo", [
      "meta",
      "shift",
      "z",
    ]),
  ];
  if (props.compact) return [marks, link, history];

  const structure = [
    action(
      { kind: "heading", level: 1, icon: "i-lucide-heading-2" },
      "common.editor.heading",
    ),
    action(
      { kind: "heading", level: 2, icon: "i-lucide-heading-3" },
      "common.editor.subheading",
    ),
    action(
      { kind: "bulletList", icon: "i-lucide-list" },
      "common.editor.bulletList",
    ),
    action(
      { kind: "orderedList", icon: "i-lucide-list-ordered" },
      "common.editor.orderedList",
    ),
    action(
      { kind: "blockquote", icon: "i-lucide-text-quote" },
      "common.editor.quote",
    ),
  ];
  return [structure, marks, link, history];
});

// Link popover ---------------------------------------------------------------

const linkOpen = ref(false);
const linkHref = ref("");
const linkInvalid = ref(false);

const linkActive = computed(() => editor.value?.isActive("link") ?? false);
const linkDisabled = computed(() => {
  const instance = editor.value;
  if (!instance || !instance.isEditable) return true;
  return instance.state.selection.empty && !instance.isActive("link");
});

watch(linkOpen, (open) => {
  if (!open) return;
  const current = editor.value?.getAttributes("link").href;
  linkHref.value = typeof current === "string" ? current : "";
  linkInvalid.value = false;
});

function normalizeHref(value: string): string {
  const href = value.trim();
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  if (/^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/.test(href)) return `mailto:${href}`;
  return `https://${href}`;
}

function applyLink(): void {
  const instance = editor.value;
  if (!instance) return;
  const href = normalizeHref(linkHref.value);
  if (!href) {
    removeLink();
    return;
  }
  if (!isSafeHref(href)) {
    linkInvalid.value = true;
    return;
  }
  instance.chain().focus().extendMarkRange("link").setLink({ href }).run();
  linkOpen.value = false;
}

function removeLink(): void {
  editor.value?.chain().focus().extendMarkRange("link").unsetLink().run();
  linkOpen.value = false;
}

const editorUi = computed(() => ({
  root: "flex min-w-0 flex-col",
  content: "min-w-0",
  base: [
    "content-font",
    props.compact ? "min-h-16 px-3 py-2 sm:px-3" : "min-h-48 px-4 py-4 sm:px-6",
    "[&_h1]:text-[1.75rem] [&_h2]:text-[1.375rem] [&_h3]:text-lg [&_h4]:text-base",
  ].join(" "),
}));

defineExpose({
  /** Emits pending changes right away (before saving, for instance). */
  flush,
  focus: () => editor.value?.commands.focus(),
  editor,
});
</script>

<template>
  <div
    class="border-default bg-default focus-within:ring-primary/60 rounded-md border focus-within:ring-2"
  >
    <UEditor
      ref="editorComponent"
      v-slot="{ editor: slotEditor }"
      :model-value="content as JSONContent"
      content-type="json"
      :extensions="[BlockIdExtension]"
      :starter-kit="{
        code: false,
        codeBlock: false,
        horizontalRule: false,
        heading: { levels: [1, 2, 3, 4] },
        link: { openOnClick: false, defaultProtocol: 'https' },
      }"
      :image="false"
      :mention="false"
      :enable-input-rules="[
        'heading',
        'bulletList',
        'orderedList',
        'blockquote',
        'bold',
        'italic',
        'strike',
        'underline',
      ]"
      :enable-paste-rules="['bold', 'italic', 'strike', 'underline', 'link']"
      :autofocus="autofocus ? 'end' : false"
      :editable="editable"
      :placeholder="placeholder ?? t('common.editor.placeholder')"
      :ui="editorUi"
      role="textbox"
      aria-multiline="true"
      :aria-label="label ?? t('common.editor.label')"
      @update:model-value="onEditorUpdate"
      @blur="flush"
    >
      <UEditorToolbar
        :editor="slotEditor"
        :items="toolbarItems"
        :size="toolbarSize"
        :aria-label="t('common.editor.toolbar')"
        :class="[
          'border-default flex-wrap gap-y-1 border-b',
          compact
            ? 'px-1 py-0.5'
            : 'bg-default/95 sticky top-0 z-10 px-2 py-1 backdrop-blur',
        ]"
      >
        <template #link>
          <UPopover
            v-model:open="linkOpen"
            :content="{ side: 'bottom', align: 'start' }"
          >
            <UTooltip :text="t('common.editor.link')">
              <UButton
                icon="i-lucide-link"
                color="neutral"
                variant="ghost"
                active-color="primary"
                active-variant="soft"
                :size="toolbarSize"
                :active="linkActive"
                :disabled="linkDisabled"
                :aria-label="t('common.editor.link')"
              />
            </UTooltip>

            <template #content>
              <form class="w-72 max-w-[90vw] p-2" @submit.prevent="applyLink">
                <div class="flex items-center gap-1">
                  <UInput
                    v-model="linkHref"
                    type="text"
                    inputmode="url"
                    autocomplete="off"
                    size="sm"
                    class="min-w-0 flex-1"
                    autofocus
                    :placeholder="t('common.editor.linkPlaceholder')"
                    :aria-label="t('common.editor.linkUrl')"
                    :aria-invalid="linkInvalid || undefined"
                    @update:model-value="linkInvalid = false"
                  />
                  <UButton
                    type="submit"
                    icon="i-lucide-check"
                    size="sm"
                    :aria-label="t('common.editor.applyLink')"
                  />
                  <UButton
                    v-if="linkActive"
                    icon="i-lucide-unlink"
                    size="sm"
                    color="neutral"
                    variant="ghost"
                    :aria-label="t('common.editor.removeLink')"
                    @click="removeLink"
                  />
                </div>
                <p
                  v-if="linkInvalid"
                  role="alert"
                  class="text-error mt-1 text-xs"
                >
                  {{ t("common.editor.invalidLink") }}
                </p>
              </form>
            </template>
          </UPopover>
        </template>
      </UEditorToolbar>
    </UEditor>
  </div>
</template>
