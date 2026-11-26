<script setup lang="ts">
import { createId } from "@paralleldrive/cuid2";
import type {
  ContextMenuItem,
  DropdownMenuItem,
  EditorToolbarItem,
} from "@nuxt/ui";
import type { ChainedCommands, Editor, JSONContent } from "@tiptap/core";
import {
  CELL_SIDES,
  LIST_MARKERS,
  IMAGE_URL_PREFIX,
  type Block,
  type ListMarker,
} from "~~/shared/types/content";
import { formatListNumber } from "~~/shared/utils/content/lists";
import {
  blocksToEditor,
  editorToBlocks,
  type EditorNode,
} from "~~/shared/utils/content/editor";
import { isSafeHref } from "~~/shared/utils/content/render";
import {
  isEditorLinkAllowed,
  normalizeHref,
  stripUnsafeLinks,
} from "~/utils/editor/links";
import { BlockIdExtension } from "~/utils/editor/blockIdExtension";
import {
  FormulaBlockExtension,
  FormulaExtension,
} from "~/utils/editor/formulaExtension";
import { ListMarkerExtension } from "~/utils/editor/listMarkerExtension";
import { TableIdsExtension } from "~/utils/editor/tableIdsExtension";
import { SpanishQuotesExtension } from "~/utils/editor/spanishQuotesExtension";
import {
  PageBreakExtension,
  pageBreakAtCursor,
} from "~/utils/editor/pageBreakExtension";
import {
  BlockImageExtension,
  type BlockImageAttrs,
} from "~/utils/editor/blockImageExtension";
import { NodeSelection } from "@tiptap/pm/state";
import { IMAGE_ALT_MAX_LENGTH } from "~~/shared/utils/schemas/content";
import { headingAtReadingLine, scrollParent } from "~/utils/outline";
import type { ContentPages, OutlineEntry } from "./ContentView.vue";
import {
  CellFillExtension,
  cellFillOf,
  type CellFill,
} from "~/utils/editor/cellFillExtension";
import {
  TableLayoutExtension,
  cellBorderColorOf,
  cellSidesOf,
  tableLayoutAt,
} from "~/utils/editor/tableLayoutExtension";
import type { CellEdge } from "~~/shared/utils/content/tables";
import {
  CELL_FILLS,
  CELL_FILL_NAMES,
  cellFillTextColour,
} from "~~/shared/constants/cellFills";
import { TableKit } from "@tiptap/extension-table";
import { wholeTableCells } from "./-tableSelection";
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
    /**
     * Editing a published text to amend it: the full toolbar, without what
     * an amendment cannot change on a table that is already there (the
     * colour of a cell, header cells, merged cells).
     */
    amend?: boolean;
    /**
     * With `amend`, still offers how a table looks: its cells' colour and
     * sides, and its width and place. A correction of form replaces the
     * whole text, so it may change them (user's decision of 2026-11-24).
     */
    tableLook?: boolean;
    /**
     * The pages of the text's PDF, shown beside it as the readers show them
     * («pág. N» and the bubble beside the scrollbar, ContentPageGutter).
     */
    pages?: ContentPages | null;
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
    amend: false,
    tableLook: false,
    pages: null,
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
  TableLayoutExtension,
  BlockImageExtension,
  // Formulas, kept as their LaTeX source (formulaExtension.ts).
  FormulaBlockExtension,
  FormulaExtension,
  // Blocks keep centred and right-aligned text (BLOCK_ALIGNMENTS); left is
  // the default and stores nothing.
  TextAlign.configure({
    types: ["heading", "paragraph"],
    alignments: ["left", "center", "right"],
  }),
  // A typed " becomes « or » (“ ” inside), and wraps a selection.
  SpanishQuotesExtension,
  // «Empezar en una página nueva» on a heading or paragraph.
  PageBreakExtension,
];

/** Whether the cursor is in a table, and its cells' fill, for the swatches. */
const inTable = ref(false);
const cellFill = ref<CellFill | "mixed" | null>(null);
/** Whether the block at the cursor starts a new page; null where none may. */
const pageBreak = ref<boolean | null>(null);

function updateInTable(): void {
  inTable.value = editor.value?.isActive("table") ?? false;
  pageBreak.value = pageBreakAtCursor(editor.value);
  cellFill.value = cellFillOf(editor.value);
  cellSides.value = cellSidesOf(editor.value);
  cellBorder.value = cellBorderColorOf(editor.value);
  tableLayout.value = tableLayoutAt(editor.value);
}

/** The sides of the cells at the cursor and the table's width and place. */
const cellSides = ref<ReturnType<typeof cellSidesOf>>(null);
const cellBorder = ref<ReturnType<typeof cellBorderColorOf>>(null);
const tableLayout = ref<ReturnType<typeof tableLayoutAt>>(null);

/** The fills on offer: the palette's colours, then none. */
const FILL_OPTIONS: CellFill[] = [...CELL_FILL_NAMES, "none"];

/**
 * Amendments compare no cell, so its colour stays: neither the text of an
 * amendment (`amend`, unless a correction of form, `tableLook`) nor the
 * short editor of one passage (`compact`) offers it, nor a table's sides,
 * width and place.
 */
const offersFill = computed(
  () => (!props.amend || props.tableLook) && !props.compact,
);

/** A swatch's own colours, from the palette; none keeps the page's. */
function swatchStyle(fill: CellFill): Record<string, string> {
  if (fill === "none") return {};
  return {
    backgroundColor: CELL_FILLS[fill].hex,
    color: cellFillTextColour(fill),
  };
}

/**
 * The colour choice in the right-click menu: each colour by name, with its
 * swatch (the `fill` slot), checked on the current one.
 */
function cellFillItems(
  current: CellFill | "mixed" | null,
  apply: (fill: CellFill) => void,
): ContextMenuItem[] {
  return FILL_OPTIONS.map((fill) => ({
    label: t(`common.editor.table.fill.${fill}`),
    slot: "fill" as const,
    fill,
    type: "checkbox" as const,
    checked: current === fill,
    disabled: current === null,
    onSelect: () => apply(fill),
  }));
}

/** The widths a table may take from the menu, in percent of the text's. */
const TABLE_WIDTHS = [100, 75, 66, 50, 33, 25];

/**
 * Selects every cell of the table at the cursor, so «Bordes» and the
 * colour reach them all: a touch screen cannot drag across cells (M-141).
 * Without moving the focus, which would close the menu it is chosen from;
 * the next command's `focus()` keeps the cell selection.
 */
function selectWholeTable(): void {
  const instance = editor.value;
  const range = instance ? wholeTableCells(instance.state) : null;
  if (range) instance!.commands.setCellSelection(range);
}

/**
 * How a table looks, for the table menu and the right-click menu: the
 * cells' colour, each side of the cells at the cursor shown or hidden, all
 * or none, their colour and thick rules, and the table's width and place.
 * Checked as the cells and the table are; nothing outside a table.
 * `keepOpen`: the menu is rebuilt on every change (the toolbar's), so it
 * may stay open after a side or the whole table is chosen; the right-click
 * menu is built once, and closes rather than act on what it read.
 */
function tableLayoutItems(
  fill: CellFill | "mixed" | null,
  sides: ReturnType<typeof cellSidesOf>,
  borderColor: ReturnType<typeof cellBorderColorOf>,
  layout: ReturnType<typeof tableLayoutAt>,
  apply: (command: (chain: ChainedCommands) => ChainedCommands) => void,
  keepOpen: boolean,
): ContextMenuItem[] {
  const stayOpen = (event: Event) => {
    if (keepOpen) event.preventDefault();
  };
  const disabled = sides === null || layout === null;
  const shown = (side: (typeof CELL_SIDES)[number]) =>
    sides !== null && sides[side] !== "none" && sides[side] !== "mixed";
  // Thick when every side shown is thick, and one is.
  const visible = CELL_SIDES.filter(shown);
  const thick =
    visible.length > 0 && visible.every((side) => sides![side] === "thick");
  const allTo = (edge: CellEdge) =>
    Object.fromEntries(CELL_SIDES.map((side) => [side, edge]));
  const widths = [...TABLE_WIDTHS];
  if (layout && !widths.includes(layout.width)) widths.push(layout.width);
  // The colour and the sides act on the cells selected, or the cursor's.
  const target = t("common.editor.table.cellsTarget");
  return [
    {
      label: t("common.editor.table.selectTable"),
      icon: "i-lucide-grid-2x2-check",
      disabled,
      // In the toolbar the menu stays open to choose what to change next.
      onSelect: (event: Event) => {
        stayOpen(event);
        selectWholeTable();
      },
    },
    {
      label: t("common.editor.table.fill.label"),
      description: target,
      icon: "i-lucide-paint-bucket",
      disabled: fill === null,
      children: cellFillItems(fill, (choice) =>
        apply((c) => c.setCellFill(choice)),
      ),
    },
    {
      label: t("common.editor.table.borders.label"),
      description: target,
      icon: "i-lucide-square-dashed",
      disabled,
      children: [
        CELL_SIDES.map((side) => ({
          label: t(`common.editor.table.borders.${side}`),
          type: "checkbox" as const,
          checked: shown(side),
          onSelect: (event: Event) => {
            stayOpen(event);
            apply((c) =>
              c.setCellSides({
                [side]: shown(side) ? "none" : thick ? "thick" : "thin",
              }),
            );
          },
        })),
        [
          {
            label: t("common.editor.table.borders.all"),
            onSelect: () =>
              apply((c) => c.setCellSides(allTo(thick ? "thick" : "thin"))),
          },
          {
            label: t("common.editor.table.borders.none"),
            onSelect: () => apply((c) => c.setCellSides(allTo("none"))),
          },
        ],
        [
          {
            label: t("common.editor.table.borders.color"),
            icon: "i-lucide-palette",
            // The palette's colours; burgundy is the template's own.
            children: CELL_FILL_NAMES.map((fill) => ({
              label: t(`common.editor.table.fill.${fill}`),
              slot: "fill" as const,
              fill,
              type: "checkbox" as const,
              checked: borderColor === fill,
              onSelect: () => apply((c) => c.setCellBorderColor(fill)),
            })),
          },
          {
            label: t("common.editor.table.borders.thick"),
            type: "checkbox" as const,
            checked: thick,
            disabled: visible.length === 0,
            onSelect: (event: Event) => {
              stayOpen(event);
              apply((c) =>
                c.setCellSides(
                  Object.fromEntries(
                    visible.map((side) => [side, thick ? "thin" : "thick"]),
                  ),
                ),
              );
            },
          },
        ],
      ],
    },
    {
      label: t("common.editor.table.layout.width"),
      icon: "i-lucide-move-horizontal",
      disabled,
      children: widths.map((width) => ({
        label:
          width === 100
            ? t("common.editor.table.layout.full")
            : t("common.editor.table.layout.percent", { n: width }),
        type: "checkbox" as const,
        checked: layout?.width === width,
        onSelect: () =>
          apply((c) =>
            c.setTableLayout({
              width,
              // A table made narrower is centred unless it has a place.
              align: layout?.align ?? (width < 100 ? "center" : null),
            }),
          ),
      })),
    },
    {
      label: t("common.editor.table.layout.place"),
      // A table as wide as the text has no place to choose.
      description:
        layout && layout.width >= 100
          ? t("common.editor.table.layout.placeNeedsWidth")
          : undefined,
      icon: "i-lucide-align-center-horizontal",
      disabled: disabled || layout!.width >= 100,
      children: (["start", "center", "right"] as const).map((place) => ({
        label: t(`common.editor.table.layout.${place}`),
        type: "checkbox" as const,
        checked: (layout?.align ?? "start") === place,
        onSelect: () =>
          apply((c) =>
            c.setTableLayout({
              width: layout?.width ?? 100,
              align: place === "start" ? null : place,
            }),
          ),
      })),
    },
  ];
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
      // Drawn in the toolbar's `tableMenu` slot: its colours need swatches.
      slot: "tableMenu",
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
        // Amendments compare no cell: its colour, header and span stay.
        ...(props.amend
          ? []
          : [
              [
                tableAction("toggleHeaderRow", "i-lucide-panel-top", (c) =>
                  c.toggleHeaderRow(),
                ),
                tableAction("toggleHeaderColumn", "i-lucide-panel-left", (c) =>
                  c.toggleHeaderColumn(),
                ),
                // The first row and column have their own; this one reaches
                // any other cell (a subtotal row brought from Word).
                tableAction("toggleHeaderCell", "i-lucide-heading", (c) =>
                  c.toggleHeaderCell(),
                ),
                tableAction("mergeCells", "i-lucide-table-cells-merge", (c) =>
                  c.mergeCells(),
                ),
                tableAction("splitCell", "i-lucide-table-cells-split", (c) =>
                  c.splitCell(),
                ),
              ],
            ]),
        // The sides, width and place, where the colour is offered too.
        ...(offersFill.value && inTable.value
          ? [
              tableLayoutItems(
                cellFill.value,
                cellSides.value,
                cellBorder.value,
                tableLayout.value,
                runInTable,
                true,
              ),
            ]
          : []),
        [tableAction("deleteTable", "i-lucide-trash", (c) => c.deleteTable())],
      ],
    }) as EditorToolbarItem,
);

/** The table menu's entries, for its dropdown in the toolbar's slot. */
const tableMenuItems = computed(
  () => (tableMenu.value as { items: ContextMenuItem[][] }).items,
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
// On a narrow screen the index floats just below the toolbar, whose height
// changes as its buttons wrap: measured, so the two never overlap.
const { height: toolbarHeight } = useElementSize(
  computed(() => toolbarEl.value?.$el ?? null),
  undefined,
  { box: "border-box" },
);
/** The toolbar sits `top-2` (8 px) from the top of what scrolls the text. */
const outlineTop = computed(() => `${8 + Math.round(toolbarHeight.value)}px`);
/**
 * Room the toolbar takes over the text once it floats: its height, read
 * now, and its gaps. On a phone its buttons wrap to several rows.
 */
function toolbarRoom(): number {
  const height = toolbarEl.value?.$el?.getBoundingClientRect?.().height ?? 0;
  return Math.round(height) + 16;
}
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
// The page marks (`pages`) are placed again a moment after each change.
const pagesRevision = ref(0);
const bumpPages = useDebounceFn(() => {
  pagesRevision.value += 1;
}, 200);
const editorDom = computed(() =>
  props.pages ? (editor.value?.view.dom ?? null) : null,
);
watch(
  editor,
  (instance, previous) => {
    previous?.off("update", readOutlineSoon);
    previous?.off("update", bumpPages);
    instance?.on("update", readOutlineSoon);
    instance?.on("update", bumpPages);
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

/**
 * Takes the reader, and the cursor, to the start of a heading or of any
 * other block; false when the text holds no such block.
 */
function goToHeading(id: string): boolean {
  const instance = editor.value;
  const element = instance?.view.dom.querySelector<HTMLElement>(
    `[data-block-id="${CSS.escape(id)}"]`,
  );
  if (!instance || !element) return false;
  const position = instance.view.posAtDOM(element, 0);
  instance
    .chain()
    .setTextSelection(position)
    .focus(undefined, { scrollIntoView: false })
    .run();
  const reduceMotion = window.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  // Just below the floating toolbar, however many rows it wraps to (never
  // closer than the headings' own 5rem `scroll-margin-top`).
  const room = Math.max(80, toolbarRoom());
  const parent = scrollParent(element);
  const top =
    element.getBoundingClientRect().top -
    Math.max(parent ? parent.getBoundingClientRect().top : 0, 0) -
    room;
  (parent ?? window).scrollBy({
    top,
    behavior: reduceMotion ? "auto" : "smooth",
  });
  return true;
}

onBeforeUnmount(() => {
  editor.value?.off("update", readOutlineSoon);
  if (stuckFrame) cancelAnimationFrame(stuckFrame);
});

/**
 * Below this width of the editor the full toolbar folds its secondary
 * controls into «Más», so it keeps to one row (E-059, M-062): at 1280 the
 * composer's editor is about 600 px and its 17 buttons took two rows. What
 * the page adds at the end (saving) needs room of its own.
 */
const FULL_TOOLBAR_MIN_WIDTH = 800;
const TOOLBAR_END_ROOM = 120;
const { width: frameWidth } = useElementSize(frame);
// 0 is a width not measured yet (before mounting, or hidden): the full
// toolbar stays until a real one arrives.
const foldToolbar = computed(
  () =>
    frameWidth.value > 0 &&
    frameWidth.value <
      FULL_TOOLBAR_MIN_WIDTH + (slots["toolbar-end"] ? TOOLBAR_END_ROOM : 0),
);

/**
 * A toolbar control as an entry of «Más»: its name shown, its shortcut
 * beside it, and its own menu (alignment, list marker, formulas) as a
 * submenu. Its `kind` handlers and active state stay the toolbar's
 * (moreMenuItems).
 */
function menuEntry(item: EditorToolbarItem): EditorToolbarItem {
  const {
    tooltip,
    items,
    trailingIcon: _trailing,
    "aria-label": ariaLabel,
    ...rest
  } = item as unknown as Record<string, unknown> & {
    tooltip?: { text?: string; kbds?: string[] };
    items?: unknown[];
    trailingIcon?: string;
    "aria-label"?: string;
  };
  return {
    ...rest,
    label: tooltip?.text ?? ariaLabel,
    ...(tooltip?.kbds ? { kbds: tooltip.kbds } : {}),
    ...(items ? { children: items } : {}),
  } as unknown as EditorToolbarItem;
}

/** The toolbar's own checks and runner, which its slots receive. */
interface ToolbarSlotHandlers {
  isActive: (item: EditorToolbarItem) => boolean;
  isDisabled: (item: EditorToolbarItem) => boolean;
  onClick: (e: MouseEvent, item: EditorToolbarItem) => void;
}

/** «Más»'s groups, as the toolbar's `more` slot receives them. */
function moreGroups(item: EditorToolbarItem): EditorToolbarItem[][] {
  return (item as { items?: EditorToolbarItem[][] }).items ?? [];
}

/**
 * «Más»'s entries with what the toolbar's own dropdown would give them: each
 * `kind` entry marked active or disabled and run by the toolbar's handlers,
 * its submenu (alignment) too.
 */
function moreMenuItems(
  item: EditorToolbarItem,
  handlers: ToolbarSlotHandlers,
): DropdownMenuItem[][] {
  const wire = (entry: EditorToolbarItem): DropdownMenuItem => {
    const { children } = entry as { children?: EditorToolbarItem[] };
    const mapped = children ? { children: children.map(wire) } : {};
    if (!("kind" in entry)) {
      return { ...entry, ...mapped } as DropdownMenuItem;
    }
    return {
      ...entry,
      ...mapped,
      active: handlers.isActive(entry),
      disabled: handlers.isDisabled(entry),
      onSelect: (e: Event) => handlers.onClick(e as MouseEvent, entry),
    } as DropdownMenuItem;
  };
  return moreGroups(item).map((group) => group.map(wire));
}

/**
 * «Más» reads as pressed while something it holds applies where the cursor
 * is (a heading, a list, underlined text); its submenus, such as the
 * alignment, which always has one active, do not count.
 */
function moreActive(
  item: EditorToolbarItem,
  handlers: ToolbarSlotHandlers,
): boolean {
  return moreGroups(item)
    .flat()
    .some((entry) => "kind" in entry && handlers.isActive(entry));
}

/** «Más» is disabled only when every entry is (the editor read-only). */
function moreDisabled(
  item: EditorToolbarItem,
  handlers: ToolbarSlotHandlers,
): boolean {
  return moreGroups(item)
    .flat()
    .every((entry) => handlers.isDisabled(entry));
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
  // Formulas, written in LaTeX with the formula drawn below while editing
  // (formulaExtension.ts).
  const formula = {
    icon: "i-lucide-sigma",
    trailingIcon: "i-lucide-chevron-down",
    "aria-label": t("common.editor.formula.menu"),
    tooltip: { text: t("common.editor.formula.menu") },
    items: [
      {
        icon: "i-lucide-square-sigma",
        label: t("common.editor.formula.block"),
        description: t("common.editor.formula.blockHint"),
        onSelect: () => run((chain) => chain.insertFormulaBlock()),
      },
      {
        icon: "i-lucide-sigma",
        label: t("common.editor.formula.inline"),
        description: t("common.editor.formula.inlineHint"),
        onSelect: () => run((chain) => chain.toggleFormula()),
      },
    ],
  } as EditorToolbarItem;
  const tables: EditorToolbarItem[] = [tableMenu.value];
  if (props.uploadImage && !props.compact && !props.amend) {
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
  // «Empezar en una página nueva» (PageBreakExtension): a heading or a
  // paragraph of the text itself, never in a list, a quote or a table.
  const newPage = {
    icon: "i-lucide-separator-horizontal",
    "aria-label": t("common.editor.pageBreak"),
    "aria-pressed": pageBreak.value === true,
    tooltip: { text: t("common.editor.pageBreak"), kbds: ["meta", "enter"] },
    active: pageBreak.value === true,
    disabled: pageBreak.value === null,
    onClick: () => run((chain) => chain.togglePageBreak()),
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
  if (props.compact) return [marks, link, [formula], tables, history];

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
  const groups = foldToolbar.value
    ? [
        [
          {
            // Drawn in the toolbar's `more` slot: the toolbar's own dropdown
            // would show the icon of whichever entry is active.
            slot: "more",
            items: [
              structure.slice(0, 4),
              structure.slice(4),
              [alignment, newPage],
              marks.slice(2),
              [formula],
            ].map((group) => group.map(menuEntry)),
          } as EditorToolbarItem,
        ],
        tables,
        marks.slice(0, 2),
        link,
        history,
      ]
    : [
        structure,
        [alignment, newPage],
        tables,
        marks,
        link,
        [formula],
        history,
      ];
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
    const breaks = pageBreakAtCursor(instance);
    if (breaks !== null) {
      block.push({
        label: t("common.editor.pageBreak"),
        icon: "i-lucide-separator-horizontal",
        type: "checkbox" as const,
        checked: breaks,
        onSelect: () => run((c) => c.togglePageBreak()),
      });
    }
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
          // Amendments compare no cell: its header and span stay.
          props.amend
            ? []
            : [
                action("toggleHeaderRow", "i-lucide-panel-top", (c) =>
                  c.toggleHeaderRow(),
                ),
                action("toggleHeaderColumn", "i-lucide-panel-left", (c) =>
                  c.toggleHeaderColumn(),
                ),
                action("toggleHeaderCell", "i-lucide-heading", (c) =>
                  c.toggleHeaderCell(),
                ),
                action("mergeCells", "i-lucide-table-cells-merge", (c) =>
                  c.mergeCells(),
                ),
                action("splitCell", "i-lucide-table-cells-split", (c) =>
                  c.splitCell(),
                ),
              ],
          offersFill.value
            ? tableLayoutItems(
                cellFillOf(instance),
                cellSidesOf(instance),
                cellBorderColorOf(instance),
                tableLayoutAt(instance),
                run,
                false,
              )
            : [],
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
        ].filter((group) => group.length > 0),
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
  const files = imageFiles(input.files);
  input.value = "";
  await uploadImages(files);
}

/** The PNG and JPEG files among those given (picked, pasted, dropped). */
function imageFiles(list: FileList | null | undefined): File[] {
  return Array.from(list ?? []).filter(
    (file) => file.type === "image/png" || file.type === "image/jpeg",
  );
}

// Images waiting for their description, one dialog after another.
const waitingImages: Omit<BlockImageAttrs, "alt">[] = [];

/** Stores the files one at a time; each goes in once described. */
async function uploadImages(files: File[]): Promise<void> {
  if (!props.uploadImage || files.length === 0) return;
  imageUploading.value = true;
  try {
    for (const file of files) {
      const stored = await props.uploadImage(file);
      if (stored) describeNext(stored);
    }
  } finally {
    imageUploading.value = false;
  }
}

function describeNext(image: Omit<BlockImageAttrs, "alt">): void {
  if (altOpen.value) {
    waitingImages.push(image);
    return;
  }
  altImage.value = image;
  altMode.value = "insert";
  altText.value = "";
  altMissing.value = false;
  altOpen.value = true;
}

watch(altOpen, (open) => {
  const next = open ? undefined : waitingImages.shift();
  if (next) void nextTick(() => describeNext(next));
});

const toast = useToast();
let pastedImagesTold = false;

/**
 * Pasting: a picture alone (a screenshot, an image copied from a page) is
 * stored and described like a chosen one. A copy that holds text keeps
 * being pasted as text, even when it brings a picture along: Word puts an
 * image of the copied passage next to its text. Pictures in pasted HTML
 * that are not the platform's own are left out, which is said once.
 */
function hasText(html: string): boolean {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  return Boolean(parsed.body.textContent?.trim());
}

/** Whether this editor takes new pictures (amendments never do). */
const takesImages = computed(
  () => Boolean(props.uploadImage) && !props.compact && !props.amend,
);

/** Said once per editor: where no picture can be added. */
let imagesRefusedTold = false;
function tellImagesRefused(): void {
  if (imagesRefusedTold) return;
  imagesRefusedTold = true;
  toast.add({
    title: t("common.editor.image.notHere"),
    icon: "i-lucide-image-off",
    color: "warning",
  });
}

function handlePaste(_view: unknown, event: ClipboardEvent): boolean {
  const files = imageFiles(event.clipboardData?.files);
  if (files.length === 0) return false;
  const html = event.clipboardData?.getData("text/html") ?? "";
  if (html && hasText(html)) return false;
  event.preventDefault();
  if (takesImages.value) void uploadImages(files);
  else tellImagesRefused();
  return true;
}

function handleDrop(
  view: {
    posAtCoords: (coords: {
      left: number;
      top: number;
    }) => { pos: number } | null;
  },
  event: DragEvent,
  _slice: unknown,
  moved: boolean,
): boolean {
  if (moved) return false;
  const files = imageFiles(event.dataTransfer?.files);
  if (files.length === 0) return false;
  event.preventDefault();
  if (!takesImages.value) {
    tellImagesRefused();
    return true;
  }
  // They go in where they were dropped.
  const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (hit) editor.value?.commands.setTextSelection(hit.pos);
  void uploadImages(files);
  return true;
}

/** Said once per editor: pasted links content would not keep. */
let linksRefusedTold = false;

function transformPastedHTML(pasted: string): string {
  // Links to anything but a web page or an email paste as plain text.
  const html = stripUnsafeLinks(pasted);
  if (html !== pasted && !linksRefusedTold) {
    linksRefusedTold = true;
    toast.add({
      title: t("common.editor.pastedLinksSkipped"),
      description: t("common.editor.pastedLinksSkippedDescription"),
      icon: "i-lucide-unlink",
      color: "warning",
    });
  }
  // The platform's own pictures (data-asset) paste as they are; others are
  // left out by the schema, which is said once.
  if (!/<img\b(?![^>]*\bdata-asset=)/i.test(html)) return html;
  if (!takesImages.value) {
    tellImagesRefused();
    return html;
  }
  if (!pastedImagesTold) {
    pastedImagesTold = true;
    toast.add({
      title: t("common.editor.image.pastedSkipped"),
      icon: "i-lucide-image-off",
      color: "warning",
    });
  }
  return html;
}

// Documents and amendments are written in Spanish, whatever the interface's
// language: the browser checks their spelling in Spanish (user's decision
// of 2026-11-20; it underlined every word otherwise).
const editorProps = {
  handlePaste,
  handleDrop,
  transformPastedHTML,
  attributes: { lang: "es", spellcheck: "true" },
};

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

/**
 * Only what content keeps (http, https, mailto) ever becomes a link: typed,
 * pasted or set in the dialog (`isEditorLinkAllowed`).
 */
const linkOptions = {
  openOnClick: false,
  defaultProtocol: "https",
  isAllowedUri: (url: string) => isEditorLinkAllowed(url),
};

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
    // The index's marks sit in the left margin: the text keeps clear of
    // them, as in the reading view.
    !props.compact && props.outline && outlineItems.value.length > 1
      ? "sm:ps-12"
      : "",
    "[&_h1]:text-[1.75rem] [&_h2]:text-[1.375rem] [&_h3]:text-lg [&_h4]:text-[1.0625rem] [&_h4]:font-bold",
    "content-editor",
  ].join(" "),
}));

defineExpose({
  /** Emits pending changes right away (before saving, for instance). */
  flush,
  focus: () => editor.value?.commands.focus(),
  /** The cursor and the view to a block by its id (false: no such block). */
  goToBlock: goToHeading,
  editor,
  /** Room the floating toolbar takes over the text, in px. */
  toolbarRoom,
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
      <template #fill-leading="{ item }">
        <span
          aria-hidden="true"
          class="cx-fill-swatch size-4"
          :style="swatchStyle((item as { fill: CellFill }).fill)"
        />
      </template>
      <!-- The menu's trigger: UEditor would not pass its listener on -->
      <div :class="pages ? 'cx-has-pages relative' : undefined">
        <ContentPageGutter
          v-if="pages"
          :pages="pages"
          :root="editorDom"
          :revision="pagesRevision"
        />
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
            link: linkOptions,
          }"
          :image="false"
          :editor-props="editorProps"
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
            'spanishQuotes',
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
              'border-default',
              // The full toolbar keeps to one row (its secondary controls
              // fold into «Más» in a narrow editor) that scrolls sideways if
              // it still does not fit, so it does not eat the text's height
              // (M-062, E-059).
              compact
                ? 'flex-wrap gap-y-1 border-b px-1 py-0.5'
                : 'sticky top-2 z-10 flex-nowrap overflow-x-auto px-2 py-1 transition-shadow [&>*]:shrink-0',
              !compact &&
                (stuck
                  ? 'bg-default mx-auto w-fit max-w-full rounded-lg shadow-xl ring ring-(--ui-border-accented)'
                  : 'bg-default/95 border-b backdrop-blur'),
              $slots['toolbar-end'] && !stuck
                ? '[&>[data-slot=group]:last-child]:ms-auto'
                : '',
              // When the row scrolls sideways, what the page adds (saving)
              // stays in view at its end (M-143).
              $slots['toolbar-end'] && !compact
                ? '[&>[data-slot=group]:last-child]:bg-default [&>[data-slot=group]:last-child]:sticky [&>[data-slot=group]:last-child]:end-0 [&>[data-slot=group]:last-child]:z-[1] [&>[data-slot=group]:last-child]:ps-1'
                : '',
            ]"
          >
            <template v-if="$slots['toolbar-end']" #toolbar-end>
              <slot name="toolbar-end" />
            </template>
            <template #more="{ item, isActive, isDisabled, onClick }">
              <UDropdownMenu
                :items="moreMenuItems(item, { isActive, isDisabled, onClick })"
                :content="{ align: 'start' }"
                :modal="false"
              >
                <UTooltip :text="t('common.editor.more')">
                  <UButton
                    icon="i-lucide-ellipsis"
                    trailing-icon="i-lucide-chevron-down"
                    color="neutral"
                    variant="ghost"
                    active-color="primary"
                    active-variant="soft"
                    :size="toolbarSize"
                    :active="
                      moreActive(item, { isActive, isDisabled, onClick })
                    "
                    :disabled="
                      moreDisabled(item, { isActive, isDisabled, onClick })
                    "
                    :aria-label="t('common.editor.more')"
                  />
                </UTooltip>
              </UDropdownMenu>
            </template>
            <template #tableMenu>
              <UDropdownMenu
                :items="tableMenuItems"
                :content="{ align: 'start' }"
                :modal="false"
              >
                <UTooltip :text="t('common.editor.table.menu')">
                  <UButton
                    icon="i-lucide-table"
                    trailing-icon="i-lucide-chevron-down"
                    color="neutral"
                    variant="ghost"
                    :size="toolbarSize"
                    :aria-label="t('common.editor.table.menu')"
                  />
                </UTooltip>
                <template #fill-leading="{ item }">
                  <span
                    aria-hidden="true"
                    class="cx-fill-swatch size-4"
                    :style="swatchStyle((item as { fill: CellFill }).fill)"
                  />
                </template>
              </UDropdownMenu>
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
          <!-- No margin for them on a narrow screen: the index as a
               floating button at the end of the line, kept in view just
               below the toolbar. -->
          <div
            v-if="!compact && outline && outlineItems.length > 1"
            class="sticky z-20 h-0 sm:hidden"
            :style="{ top: outlineTop }"
          >
            <div class="absolute end-2 top-2">
              <ContentOutline
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
      multiple
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
