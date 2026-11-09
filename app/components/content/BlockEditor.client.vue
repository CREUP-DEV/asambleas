<script setup lang="ts">
import { createId } from "@paralleldrive/cuid2";
import type { ContextMenuItem, EditorToolbarItem } from "@nuxt/ui";
import type { ChainedCommands, Editor, JSONContent } from "@tiptap/core";
import { LIST_MARKERS, IMAGE_URL_PREFIX } from "~~/shared/types/content";
import type { Block, ListMarker } from "~~/shared/types/content";
import { formatListNumber } from "~~/shared/utils/content/lists";
import {
  blocksToEditor,
  editorToBlocks,
  type EditorNode,
} from "~~/shared/utils/content/editor";
import { isSafeHref } from "~~/shared/utils/content/render";
import { BlockIdExtension } from "~/utils/editor/blockIdExtension";
import { ListMarkerExtension } from "~/utils/editor/listMarkerExtension";
import { TableIdsExtension } from "~/utils/editor/tableIdsExtension";
import {
  BlockImageExtension,
  type BlockImageAttrs,
} from "~/utils/editor/blockImageExtension";
import { NodeSelection } from "@tiptap/pm/state";
import { IMAGE_ALT_MAX_LENGTH } from "~~/shared/utils/schemas/content";
import { headingAtReadingLine } from "~/utils/outline";
import type { OutlineEntry } from "./ContentView.vue";
import {
  CellFillExtension,
  cellFillOf,
  type CellFill,
} from "~/utils/editor/cellFillExtension";
import { TableKit } from "@tiptap/extension-table";
import { TextAlign } from "@tiptap/extension-text-align";

/**
 * Structured content editor (UEditor / TipTap). Works on blocks: the model is
 * `Block[]`, and every paragraph and heading keeps its block id through
 * edits thanks to `BlockIdExtension`.
 *
 * Toolbar headings: "H2" to "H5" set block levels 1 to 4, which is how
 * `renderBlocks` shows them (pages keep their own h1).
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
    /** The text's index as marks in the editor's left margin. */
    outline?: boolean;
    /**
     * Stores an image for the text and gives back its picture, or null when
     * it could not (the caller says why). Without it, no image can be added.
     */
    uploadImage?: (file: File) => Promise<Omit<BlockImageAttrs, "alt"> | null>;
  }>(),
  {
    compact: false,
    outline: false,
    uploadImage: undefined,
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

// Typed by hand: inferring it from the template is circular for vue-tsc.
const editorComponent = useTemplateRef<{ editor?: Editor }>("editorComponent");
const editor = computed<Editor | undefined>(
  () => editorComponent.value?.editor,
);

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

// Tables -------------------------------------------------------------------

/** Tables without column resizing: blocks keep no widths. */
const extensions = [
  BlockIdExtension,
  ListMarkerExtension,
  // The wrapper scrolls a wide table sideways, as in the view (main.css).
  TableKit.configure({ table: { resizable: false, renderWrapper: true } }),
  TableIdsExtension,
  CellFillExtension,
  BlockImageExtension,
  // Blocks keep centred and right-aligned text (BLOCK_ALIGNMENTS); left is
  // the default and stores nothing.
  TextAlign.configure({
    types: ["heading", "paragraph"],
    alignments: ["left", "center", "right"],
  }),
];

/** Whether the cursor is in a table, and its cell's fill, for the table menu. */
const inTable = ref(false);
const cellFill = ref<CellFill | null>(null);

function updateInTable(): void {
  inTable.value = editor.value?.isActive("table") ?? false;
  cellFill.value = cellFillOf(editor.value);
}

const CELL_FILLS: { fill: CellFill; icon: string }[] = [
  { fill: "none", icon: "i-lucide-square" },
  { fill: "light", icon: "i-lucide-paint-bucket" },
  { fill: "dark", icon: "i-lucide-square-dot" },
];

/**
 * The cell fill choice: none, light or burgundy (a header cell), checked on
 * the current one.
 */
function cellFillItems(
  current: CellFill | null,
  apply: (fill: CellFill) => void,
) {
  return CELL_FILLS.map(({ fill, icon }) => ({
    label: t(`common.editor.table.fill.${fill}`),
    icon,
    type: "checkbox" as const,
    checked: current === fill,
    disabled: current === null,
    onSelect: () => apply(fill),
  }));
}

watch(
  editor,
  (instance, previous) => {
    previous?.off("transaction", updateInTable);
    instance?.on("transaction", updateInTable);
    updateInTable();
  },
  { immediate: true },
);

function runInTable(command: (chain: ChainedCommands) => ChainedCommands) {
  const instance = editor.value;
  if (!instance) return;
  command(instance.chain().focus()).run();
}

/** One entry of the table menu, available only with the cursor in a table. */
function tableAction(
  labelKey: string,
  icon: string,
  command: (chain: ChainedCommands) => ChainedCommands,
) {
  return {
    label: t(`common.editor.table.${labelKey}`),
    icon,
    disabled: !inTable.value,
    onSelect: () => runInTable(command),
  };
}

/** Inserting tables, rows and columns, and removing them. */
const tableMenu = computed(
  () =>
    ({
      icon: "i-lucide-table",
      trailingIcon: "i-lucide-chevron-down",
      "aria-label": t("common.editor.table.menu"),
      tooltip: { text: t("common.editor.table.menu") },
      items: [
        [
          {
            label: t("common.editor.table.insert"),
            icon: "i-lucide-table",
            // A table inside a cell would join that cell's text.
            disabled: inTable.value,
            onSelect: () =>
              runInTable((chain) =>
                chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }),
              ),
          },
        ],
        [
          tableAction(
            "addRowBefore",
            "i-lucide-between-horizontal-start",
            (c) => c.addRowBefore(),
          ),
          tableAction("addRowAfter", "i-lucide-between-horizontal-end", (c) =>
            c.addRowAfter(),
          ),
          tableAction("deleteRow", "i-lucide-trash-2", (c) => c.deleteRow()),
        ],
        [
          tableAction(
            "addColumnBefore",
            "i-lucide-between-vertical-start",
            (c) => c.addColumnBefore(),
          ),
          tableAction("addColumnAfter", "i-lucide-between-vertical-end", (c) =>
            c.addColumnAfter(),
          ),
          tableAction("deleteColumn", "i-lucide-trash-2", (c) =>
            c.deleteColumn(),
          ),
        ],
        [
          // The fill of the cell: burgundy is a header cell.
          { type: "label", label: t("common.editor.table.fill.label") },
          ...cellFillItems(cellFill.value, (fill) =>
            runInTable((c) => c.setCellFill(fill)),
          ),
        ],
        [
          tableAction("toggleHeaderRow", "i-lucide-panel-top", (c) =>
            c.toggleHeaderRow(),
          ),
          tableAction("toggleHeaderColumn", "i-lucide-panel-left", (c) =>
            c.toggleHeaderColumn(),
          ),
          tableAction("mergeCells", "i-lucide-table-cells-merge", (c) =>
            c.mergeCells(),
          ),
          tableAction("splitCell", "i-lucide-table-cells-split", (c) =>
            c.splitCell(),
          ),
        ],
        [tableAction("deleteTable", "i-lucide-trash", (c) => c.deleteTable())],
      ],
    }) as EditorToolbarItem,
);

const slots = useSlots();

// The toolbar stays at the top as the text scrolls; while it does, it floats
// as wide as its buttons, centred, opaque, framed and shadowed so it stands
// out over the text.
const frame = useTemplateRef<HTMLElement>("frame");
const toolbarEl = useTemplateRef<{ $el: HTMLElement }>("toolbar");
const stuck = ref(false);
let stuckFrame = 0;
function checkStuck(): void {
  if (stuckFrame || props.compact) return;
  stuckFrame = requestAnimationFrame(() => {
    stuckFrame = 0;
    const box = frame.value?.getBoundingClientRect();
    const bar = toolbarEl.value?.$el?.getBoundingClientRect?.();
    stuck.value = Boolean(box && bar && bar.top > box.top + 1);
  });
}
useEventListener(window, "scroll", checkStuck, {
  capture: true,
  passive: true,
});
// The index (`outline`): the top-level headings as the editor shows them,
// read again a moment after each change.
const outlineItems = shallowRef<OutlineEntry[]>([]);
function readOutline(): void {
  const dom = props.outline ? editor.value?.view.dom : undefined;
  const entries: OutlineEntry[] = [];
  dom
    ?.querySelectorAll<HTMLElement>(
      ":scope > h1, :scope > h2, :scope > h3, :scope > h4",
    )
    .forEach((element) => {
      const id = element.getAttribute("data-block-id");
      const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
      if (id && text) {
        entries.push({ id, level: Number(element.tagName.slice(1)), text });
      }
    });
  const previous = outlineItems.value;
  const same =
    previous.length === entries.length &&
    previous.every(
      (entry, i) =>
        entry.id === entries[i]!.id &&
        entry.level === entries[i]!.level &&
        entry.text === entries[i]!.text,
    );
  if (!same) outlineItems.value = entries;
}
const readOutlineSoon = useDebounceFn(readOutline, 300);
watch(
  editor,
  (instance, previous) => {
    previous?.off("update", readOutlineSoon);
    instance?.on("update", readOutlineSoon);
    void nextTick(readOutline);
  },
  { immediate: true },
);

function currentHeading(): string | null {
  const dom = editor.value?.view.dom;
  if (!dom) return null;
  return headingAtReadingLine(
    dom,
    outlineItems.value.map((entry) => entry.id),
  );
}

/** Takes the reader, and the cursor, to the start of a heading. */
function goToHeading(id: string): void {
  const instance = editor.value;
  const element = instance?.view.dom.querySelector<HTMLElement>(
    `[data-block-id="${CSS.escape(id)}"]`,
  );
  if (!instance || !element) return;
  const position = instance.view.posAtDOM(element, 0);
  instance
    .chain()
    .setTextSelection(position)
    .focus(undefined, { scrollIntoView: false })
    .run();
  const reduceMotion = window.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  element.scrollIntoView({
    block: "start",
    behavior: reduceMotion ? "auto" : "smooth",
  });
}

onBeforeUnmount(() => {
  editor.value?.off("update", readOutlineSoon);
  if (stuckFrame) cancelAnimationFrame(stuckFrame);
});

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
  const tables: EditorToolbarItem[] = [tableMenu.value];
  if (props.uploadImage && !props.compact) {
    tables.push({
      icon: "i-lucide-image-plus",
      color: "neutral",
      variant: "ghost",
      loading: imageUploading.value,
      // Images sit on a line of their own, never in a table.
      disabled: inTable.value || imageUploading.value,
      tooltip: { text: t("common.editor.image.insert") },
      "aria-label": t("common.editor.image.insert"),
      onClick: pickImage,
    } as EditorToolbarItem);
  }
  // Shows the icon of the current alignment.
  const alignment = {
    icon: "i-lucide-align-left",
    trailingIcon: "i-lucide-chevron-down",
    "aria-label": t("common.editor.align.menu"),
    tooltip: { text: t("common.editor.align.menu") },
    items: (["left", "center", "right"] as const).map((align) => ({
      kind: "textAlign",
      align,
      icon: `i-lucide-align-${align}`,
      label: t(`common.editor.align.${align}`),
    })),
  } as EditorToolbarItem;
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
  // Amendments may change a table's text, rows and columns too.
  if (props.compact) return [marks, link, tables, history];

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
      { kind: "heading", level: 3, icon: "i-lucide-heading-4" },
      "common.editor.heading3",
    ),
    action(
      { kind: "heading", level: 4, icon: "i-lucide-heading-5" },
      "common.editor.heading4",
    ),
    action(
      { kind: "bulletList", icon: "i-lucide-list" },
      "common.editor.bulletList",
    ),
    action(
      { kind: "orderedList", icon: "i-lucide-list-ordered" },
      "common.editor.orderedList",
    ),
    // How the list numbers its items; makes the paragraph a numbered list
    // when it is not one yet.
    {
      icon: "i-lucide-list-ordered",
      trailingIcon: "i-lucide-chevron-down",
      "aria-label": t("common.editor.listMarker"),
      tooltip: { text: t("common.editor.listMarker") },
      items: LIST_MARKERS.map((marker) => ({
        label: [1, 2, 3].map((n) => formatListNumber(n, marker)).join(" "),
        onSelect: () => setListMarker(marker),
      })),
    } as EditorToolbarItem,
    action(
      { kind: "blockquote", icon: "i-lucide-text-quote" },
      "common.editor.quote",
    ),
  ];
  const groups = [structure, [alignment], tables, marks, link, history];
  // What the page adds at the toolbar's end (saving the text, say).
  if (slots["toolbar-end"]) {
    groups.push([{ slot: "toolbar-end" } as EditorToolbarItem]);
  }
  return groups;
});

function setListMarker(marker: ListMarker): void {
  const instance = editor.value;
  if (!instance) return;
  const chain = instance.chain().focus();
  if (!instance.isActive("orderedList")) chain.toggleOrderedList();
  chain.setListMarker(marker).run();
}

// Context menu --------------------------------------------------------------

/**
 * Right-click menu over the text, built when it opens from where the cursor
 * is: cut, copy and the marks with text selected; what the block is, its
 * alignment and, in a numbered list, its numbering; table rows, columns and
 * cells inside a table, or inserting one outside. Shift + right-click, and
 * right-click outside the text, leave the browser's own menu (spelling).
 */
const contextItems = ref<ContextMenuItem[][]>([]);

function run(command: (chain: ChainedCommands) => ChainedCommands): void {
  const instance = editor.value;
  if (instance) command(instance.chain().focus()).run();
}

/** Cut and copy through the browser, with the editor's selection back. */
function clipboard(action: "cut" | "copy"): void {
  editor.value?.commands.focus();
  // Deprecated but the only way to keep the formatting; paste stays Ctrl+V.
  document.execCommand(action);
}

function buildContextItems(): void {
  const instance = editor.value;
  if (!instance) return;
  const selected = !instance.state.selection.empty;
  const editable = instance.isEditable;
  const groups: ContextMenuItem[][] = [];

  const clip: ContextMenuItem[] = [
    {
      label: t("common.editor.contextMenu.copy"),
      icon: "i-lucide-copy",
      kbds: ["meta", "c"],
      disabled: !selected,
      onSelect: () => clipboard("copy"),
    },
  ];
  if (editable) {
    clip.unshift({
      label: t("common.editor.contextMenu.cut"),
      icon: "i-lucide-scissors",
      kbds: ["meta", "x"],
      disabled: !selected,
      onSelect: () => clipboard("cut"),
    });
  }
  groups.push(clip);
  if (!editable) {
    contextItems.value = groups;
    return;
  }

  // An image takes no marks, block type or alignment: only its own items.
  const onImage = instance.isActive("blockImage");

  if (selected && !onImage) {
    const mark = (
      name: "bold" | "italic" | "underline" | "strike",
      icon: string,
      kbds: string[],
      toggle: (chain: ChainedCommands) => ChainedCommands,
    ): ContextMenuItem => ({
      label: t(`common.editor.${name}`),
      icon,
      kbds,
      type: "checkbox",
      checked: instance.isActive(name),
      onSelect: (event: Event) => {
        event.preventDefault();
        run(toggle);
      },
    });
    groups.push([
      mark("bold", "i-lucide-bold", ["meta", "b"], (c) => c.toggleBold()),
      mark("italic", "i-lucide-italic", ["meta", "i"], (c) => c.toggleItalic()),
      mark("underline", "i-lucide-underline", ["meta", "u"], (c) =>
        c.toggleUnderline(),
      ),
      mark("strike", "i-lucide-strikethrough", ["meta", "shift", "s"], (c) =>
        c.toggleStrike(),
      ),
      {
        label: t("common.editor.link"),
        icon: "i-lucide-link",
        onSelect: () => {
          linkOpen.value = true;
        },
      },
      {
        label: t("common.editor.contextMenu.clearFormatting"),
        icon: "i-lucide-remove-formatting",
        onSelect: () => run((c) => c.unsetAllMarks()),
      },
    ]);
  }

  if (!props.compact && !onImage) {
    const heading = (level: 1 | 2 | 3 | 4, key: string, icon: string) => ({
      label: t(`common.editor.${key}`),
      icon,
      onSelect: () => run((c) => c.setHeading({ level })),
    });
    const block: ContextMenuItem[] = [
      {
        label: t("common.editor.contextMenu.turnInto"),
        icon: "i-lucide-pilcrow",
        children: [
          [
            {
              label: t("common.editor.contextMenu.paragraph"),
              icon: "i-lucide-pilcrow",
              onSelect: () => run((c) => c.setParagraph()),
            },
            heading(1, "heading", "i-lucide-heading-2"),
            heading(2, "subheading", "i-lucide-heading-3"),
            heading(3, "heading3", "i-lucide-heading-4"),
            heading(4, "heading4", "i-lucide-heading-5"),
          ],
          [
            {
              label: t("common.editor.bulletList"),
              icon: "i-lucide-list",
              onSelect: () => run((c) => c.toggleBulletList()),
            },
            {
              label: t("common.editor.orderedList"),
              icon: "i-lucide-list-ordered",
              onSelect: () => run((c) => c.toggleOrderedList()),
            },
            {
              label: t("common.editor.quote"),
              icon: "i-lucide-text-quote",
              onSelect: () => run((c) => c.toggleBlockquote()),
            },
          ],
        ],
      },
      {
        label: t("common.editor.align.menu"),
        icon: "i-lucide-align-left",
        children: (["left", "center", "right"] as const).map((align) => ({
          label: t(`common.editor.align.${align}`),
          icon: `i-lucide-align-${align}`,
          type: "checkbox" as const,
          checked:
            align === "left"
              ? !instance.isActive({ textAlign: "center" }) &&
                !instance.isActive({ textAlign: "right" })
              : instance.isActive({ textAlign: align }),
          onSelect: () => run((c) => c.setTextAlign(align)),
        })),
      },
    ];
    if (instance.isActive("orderedList")) {
      block.push({
        label: t("common.editor.listMarker"),
        icon: "i-lucide-list-ordered",
        children: LIST_MARKERS.map((marker) => ({
          label: [1, 2, 3].map((n) => formatListNumber(n, marker)).join(" "),
          onSelect: () => setListMarker(marker),
        })),
      });
    }
    groups.push(block);
  }

  if (onImage) {
    groups.push([
      {
        label: t("common.editor.image.editAlt"),
        icon: "i-lucide-text-quote",
        disabled: !editable,
        onSelect: () => openAltDialog(),
      },
      {
        label: t("common.editor.image.remove"),
        icon: "i-lucide-trash-2",
        color: "error",
        disabled: !editable,
        onSelect: () => run((c) => c.deleteSelection()),
      },
    ]);
  }

  if (instance.isActive("table")) {
    const action = (
      key: string,
      icon: string,
      command: (chain: ChainedCommands) => ChainedCommands,
      color?: "error",
    ): ContextMenuItem => ({
      label: t(`common.editor.table.${key}`),
      icon,
      color,
      disabled: !command(instance.can().chain().focus()).run(),
      onSelect: () => run(command),
    });
    groups.push([
      {
        label: t("common.editor.table.menu"),
        icon: "i-lucide-table",
        children: [
          [
            action("addRowBefore", "i-lucide-between-horizontal-start", (c) =>
              c.addRowBefore(),
            ),
            action("addRowAfter", "i-lucide-between-horizontal-end", (c) =>
              c.addRowAfter(),
            ),
            action("addColumnBefore", "i-lucide-between-vertical-start", (c) =>
              c.addColumnBefore(),
            ),
            action("addColumnAfter", "i-lucide-between-vertical-end", (c) =>
              c.addColumnAfter(),
            ),
          ],
          [
            {
              label: t("common.editor.table.fill.label"),
              icon: "i-lucide-paint-bucket",
              children: cellFillItems(cellFillOf(instance), (fill) =>
                run((c) => c.setCellFill(fill)),
              ),
            },
            action("toggleHeaderRow", "i-lucide-panel-top", (c) =>
              c.toggleHeaderRow(),
            ),
            action("toggleHeaderColumn", "i-lucide-panel-left", (c) =>
              c.toggleHeaderColumn(),
            ),
            action("mergeCells", "i-lucide-table-cells-merge", (c) =>
              c.mergeCells(),
            ),
            action("splitCell", "i-lucide-table-cells-split", (c) =>
              c.splitCell(),
            ),
          ],
          [
            action(
              "deleteRow",
              "i-lucide-trash-2",
              (c) => c.deleteRow(),
              "error",
            ),
            action(
              "deleteColumn",
              "i-lucide-trash-2",
              (c) => c.deleteColumn(),
              "error",
            ),
            action(
              "deleteTable",
              "i-lucide-trash",
              (c) => c.deleteTable(),
              "error",
            ),
          ],
        ],
      },
    ]);
  } else if (!onImage) {
    groups.push([
      {
        label: t("common.editor.table.insert"),
        icon: "i-lucide-table",
        onSelect: () =>
          run((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true })),
      },
    ]);
  }

  groups.push([
    { type: "label", label: t("common.editor.contextMenu.browserMenu") },
  ]);
  contextItems.value = groups;
}

/**
 * Runs before the context menu opens. Shift + right-click, or right-click
 * off the text (the toolbar), keeps the browser's menu: the event stops
 * before the context menu sees it. Otherwise the cursor goes where the click
 * was, unless it falls inside the selection: the browser moves its caret
 * there, but the editor would not read it before the menu takes the focus,
 * and the menu would offer what fits the old position.
 */
function onContextMenu(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  if (event.shiftKey || !target?.closest(".ProseMirror")) {
    event.stopPropagation();
    return;
  }
  const instance = editor.value;
  if (!instance) return;
  // An image is chosen whole, so the menu offers what fits it.
  const picture = target.closest<HTMLElement>("img.cx-editor-image");
  if (picture && instance.view.dom.contains(picture)) {
    const position = instance.view.posAtDOM(picture, 0);
    const { state } = instance.view;
    if (state.doc.nodeAt(position)?.type.name === "blockImage") {
      instance.view.dispatch(
        state.tr.setSelection(NodeSelection.create(state.doc, position)),
      );
      instance.view.focus();
      return;
    }
  }
  const hit = instance.view.posAtCoords({
    left: event.clientX,
    top: event.clientY,
  });
  if (!hit) return;
  const { from, to, empty } = instance.state.selection;
  if (!empty && hit.pos >= from && hit.pos <= to) return;
  instance.chain().focus().setTextSelection(hit.pos).run();
}

// Images -------------------------------------------------------------------
// The toolbar button picks a file, which is stored for the document; the
// image goes in once it has a description (alt text), which the dialog asks
// for. Its menu (right-click) changes that description later.

const imageInput = useTemplateRef<HTMLInputElement>("imageInput");
const imageUploading = ref(false);
const altOpen = ref(false);
const altMode = ref<"insert" | "edit">("insert");
const altText = ref("");
const altMissing = ref(false);
const altImage = shallowRef<Omit<BlockImageAttrs, "alt"> | null>(null);

function pickImage(): void {
  imageInput.value?.click();
}

async function onImagePicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || !props.uploadImage) return;
  imageUploading.value = true;
  try {
    const stored = await props.uploadImage(file);
    if (stored) {
      altImage.value = stored;
      altMode.value = "insert";
      altText.value = "";
      altMissing.value = false;
      altOpen.value = true;
    }
  } finally {
    imageUploading.value = false;
  }
}

function openAltDialog(): void {
  const attrs = editor.value?.getAttributes("blockImage");
  if (!attrs?.asset) return;
  altImage.value = {
    asset: attrs.asset,
    width: attrs.width,
    height: attrs.height,
  };
  altMode.value = "edit";
  altText.value = attrs.alt ?? "";
  altMissing.value = false;
  altOpen.value = true;
}

function confirmAlt(): void {
  const alt = altText.value.replace(/\s+/g, " ").trim();
  if (!alt) {
    altMissing.value = true;
    return;
  }
  const image = altImage.value;
  altOpen.value = false;
  if (!image) return;
  if (altMode.value === "insert") {
    run((c) => c.insertBlockImage({ ...image, alt }));
  } else {
    run((c) => c.updateAttributes("blockImage", { alt }));
  }
}

// Link popover ---------------------------------------------------------------

const linkOpen = ref(false);
const linkHref = ref("");
const linkInvalid = ref(false);

const linkActive = computed<boolean>(
  () => editor.value?.isActive("link") ?? false,
);
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
    "[&_h1]:text-[1.75rem] [&_h2]:text-[1.375rem] [&_h3]:text-lg [&_h4]:text-[1.0625rem] [&_h4]:font-bold",
    "content-editor",
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
    ref="frame"
    class="border-default bg-default focus-within:ring-primary/60 rounded-md border focus-within:ring-2"
    @contextmenu.capture="onContextMenu"
  >
    <UContextMenu
      :items="contextItems"
      :modal="false"
      @update:open="(open: boolean) => open && buildContextItems()"
    >
      <!-- The menu's trigger: UEditor would not pass its listener on -->
      <div>
        <UEditor
          ref="editorComponent"
          v-slot="{ editor: slotEditor }"
          :model-value="content as JSONContent"
          content-type="json"
          :extensions="extensions"
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
          :enable-paste-rules="[
            'bold',
            'italic',
            'strike',
            'underline',
            'link',
          ]"
          :autofocus="autofocus ? 'end' : false"
          :editable="editable"
          :placeholder="{
            placeholder: placeholder ?? t('common.editor.placeholder'),
            mode: 'firstLine',
          }"
          :ui="editorUi"
          role="textbox"
          aria-multiline="true"
          :aria-label="label ?? t('common.editor.label')"
          @update:model-value="onEditorUpdate"
          @blur="flush"
        >
          <UEditorToolbar
            ref="toolbar"
            :editor="slotEditor"
            :items="toolbarItems"
            :size="toolbarSize"
            :aria-label="t('common.editor.toolbar')"
            :class="[
              'border-default flex-wrap gap-y-1',
              compact
                ? 'border-b px-1 py-0.5'
                : 'sticky top-2 z-10 px-2 py-1 transition-shadow',
              !compact &&
                (stuck
                  ? 'bg-default mx-auto w-fit max-w-full rounded-lg shadow-xl ring ring-(--ui-border-accented)'
                  : 'bg-default/95 border-b backdrop-blur'),
              $slots['toolbar-end'] && !stuck
                ? '[&>[data-slot=group]:last-child]:ms-auto'
                : '',
            ]"
          >
            <template v-if="$slots['toolbar-end']" #toolbar-end>
              <slot name="toolbar-end" />
            </template>
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
                  <form
                    class="w-72 max-w-[90vw] p-2"
                    @submit.prevent="applyLink"
                  >
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

          <!-- The index in the left margin, kept in view below the toolbar;
               no room of its own. -->
          <div
            v-if="outline && outlineItems.length > 1"
            class="sticky top-16 z-20 h-0 max-sm:hidden"
          >
            <div class="absolute start-1.5 top-3">
              <ContentOutlineRail
                :items="outlineItems"
                :current="currentHeading"
                @select="goToHeading"
              />
            </div>
          </div>
        </UEditor>
      </div>
    </UContextMenu>

    <input
      v-if="uploadImage"
      ref="imageInput"
      type="file"
      accept="image/png,image/jpeg"
      class="sr-only"
      tabindex="-1"
      aria-hidden="true"
      @change="onImagePicked"
    />

    <UModal
      v-model:open="altOpen"
      :title="t('common.editor.image.altTitle')"
      :description="t('common.editor.image.altHelp')"
    >
      <template #body>
        <form
          id="block-image-alt"
          class="space-y-4"
          @submit.prevent="confirmAlt"
        >
          <img
            v-if="altImage"
            :src="IMAGE_URL_PREFIX + altImage.asset"
            alt=""
            class="border-default mx-auto max-h-60 rounded-md border object-contain"
          />
          <UFormField
            :label="t('common.editor.image.altLabel')"
            :error="altMissing ? t('common.editor.image.altRequired') : false"
            required
          >
            <UTextarea
              v-model="altText"
              autofocus
              :rows="3"
              :maxlength="IMAGE_ALT_MAX_LENGTH"
              class="w-full"
              @update:model-value="altMissing = false"
            />
          </UFormField>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            :label="t('common.editor.image.cancel')"
            @click="altOpen = false"
          />
          <UButton
            type="submit"
            form="block-image-alt"
            :label="
              altMode === 'insert'
                ? t('common.editor.image.insertAction')
                : t('common.editor.image.save')
            "
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
