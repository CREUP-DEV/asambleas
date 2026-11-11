<script setup lang="ts">
import type { TextSpan } from "~/composables/document/documentLinks";
import type {
  DocumentNoteAnchor,
  DocumentNoteCreateBody,
  DocumentNoteDto,
  DocumentNotesDto,
  DocumentNoteUpdateBody,
} from "~~/shared/types/api";
import type { Block } from "~~/shared/types/content";
import {
  DOCUMENT_NOTE_MAX_LENGTH,
  DOCUMENT_NOTE_QUOTE_MAX_LENGTH,
  locateNote,
  placeNotes,
} from "~~/shared/utils/documentNotes";

/**
 * The account's private notes on a published document: the button that
 * opens them ("Notas", with how many there are), the list in a side panel,
 * the dialog to write or change one, and their marks on the text.
 *
 * - A note is about the whole document, or on a stretch of one paragraph
 *   (`annotate`, called from the text's right-click menu).
 * - On the text (`root`, the rendered published text) a note shows as a
 *   soft highlight with a dotted line, drawn with the CSS Custom Highlight
 *   API: the text's own HTML is never touched. Pointing at one, or pressing
 *   it, shows the note with the ways to change or delete it. A browser
 *   without that API shows no marks; the notes stay in the panel.
 * - The panel lists them in the order of the text, each with the text it
 *   is on and the way to it (`locate`). One whose text is gone (the document
 *   was published again) stays listed, with the text it was on.
 *
 * Nobody else reads them. The server answers `available: false` while the
 * document is not published: nothing shows here then.
 */
const props = withDefaults(
  defineProps<{
    /** `.../documents/<id>/notes`. */
    notesUrl: string;
    /** The published text; none for a PDF, which takes general notes only. */
    blocks?: Block[];
    /** The rendered published text, for the marks; null when not on show. */
    root?: () => HTMLElement | null;
  }>(),
  { blocks: () => [], root: undefined },
);

const emit = defineEmits<{
  /** Show this block of the text. */
  locate: [blockId: string];
}>();

const { t } = useI18n();
const api = useApi();
const toast = useToast();

// Data -------------------------------------------------------------------------------

const data = ref<DocumentNotesDto | null>(null);
const failed = ref(false);

async function load(): Promise<void> {
  const url = props.notesUrl;
  try {
    const dto = await api.get<DocumentNotesDto>(url);
    if (props.notesUrl !== url) return;
    data.value = dto;
    failed.value = false;
  } catch {
    if (props.notesUrl === url) failed.value = true;
  }
}

onMounted(() => {
  watch(
    () => props.notesUrl,
    () => {
      data.value = null;
      void load();
    },
    { immediate: true },
  );
});

const available = computed(() => data.value?.available === true);
const notes = computed(() => data.value?.notes ?? []);
const listed = computed(() => placeNotes(notes.value, props.blocks));
const total = computed(() => notes.value.length);

function replace(list: DocumentNoteDto[]): void {
  if (data.value) data.value = { ...data.value, notes: list };
}

// Writing ----------------------------------------------------------------------------

const drawerOpen = ref(false);

interface Draft {
  /** The note being changed; null for a new one. */
  note: DocumentNoteDto | null;
  anchor: DocumentNoteAnchor | null;
  body: string;
}
const draft = ref<Draft | null>(null);
const saving = ref(false);
const dialogOpen = computed({
  get: () => draft.value !== null,
  set: (open: boolean) => {
    if (!open && !saving.value) draft.value = null;
  },
});
const dialogTitle = computed(() => {
  if (draft.value?.note) return t("notes.dialog.editTitle");
  return draft.value?.anchor
    ? t("notes.dialog.newTitle")
    : t("notes.dialog.generalTitle");
});

function writeGeneral(): void {
  draft.value = { note: null, anchor: null, body: "" };
}

function editNote(note: DocumentNoteDto): void {
  card.value = null;
  draft.value = { note, anchor: note.anchor, body: note.body };
}

/** The block's text as it shows: what the offsets of a selection count. */
function shownText(blockId: string): string | null {
  const element = props
    .root?.()
    ?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(blockId)}"]`);
  return element
    ? (element.textContent ?? "")
    : (props.blocks.find((block) => block.id === blockId)?.text ?? null);
}

/**
 * A new note on the text: on the selection (the part of it in the block it
 * starts in), or on the whole paragraph without one.
 */
function annotate(blockId: string, span: TextSpan | null): void {
  const text = shownText(blockId);
  if (text === null || text.length === 0) return;
  const from = span ? Math.min(span.start.offset, text.length) : 0;
  const end =
    span && span.end.blockId === blockId ? span.end.offset : text.length;
  const to = Math.min(
    Math.max(end, from),
    text.length,
    from + DOCUMENT_NOTE_QUOTE_MAX_LENGTH,
  );
  if (to <= from) return;
  draft.value = {
    note: null,
    anchor: { blockId, from, to, quote: text.slice(from, to) },
    body: "",
  };
}

async function save(): Promise<void> {
  const current = draft.value;
  const body = current?.body.trim();
  if (!current || !body || saving.value) return;
  saving.value = true;
  try {
    if (current.note) {
      const saved = await api.send<DocumentNoteDto>(
        `${props.notesUrl}/${current.note.id}`,
        {
          method: "PUT",
          body: {
            body,
            updatedAt: current.note.updatedAt,
          } satisfies DocumentNoteUpdateBody,
        },
      );
      replace(notes.value.map((note) => (note.id === saved.id ? saved : note)));
    } else {
      const saved = await api.send<DocumentNoteDto>(props.notesUrl, {
        method: "POST",
        body: { anchor: current.anchor, body } satisfies DocumentNoteCreateBody,
      });
      replace([...notes.value, saved]);
    }
    draft.value = null;
    toast.add({ title: t("notes.saved"), color: "success" });
  } catch (error) {
    api.notifyError(error, "notes.saveError");
    // Changed or deleted elsewhere (the account may be shared): read again.
    if (api.isConflict(error) || api.errorStatus(error) === 404) void load();
  } finally {
    saving.value = false;
  }
}

/** The note whose "Borrar" was pressed once: the next press deletes it. */
const confirming = ref<string | null>(null);
const removing = ref<string | null>(null);

async function remove(note: DocumentNoteDto): Promise<void> {
  if (confirming.value !== note.id) {
    confirming.value = note.id;
    return;
  }
  if (removing.value) return;
  removing.value = note.id;
  try {
    await api.send(`${props.notesUrl}/${note.id}`, { method: "DELETE" });
    replace(notes.value.filter((item) => item.id !== note.id));
    card.value = null;
    toast.add({ title: t("notes.deleted"), color: "success" });
  } catch (error) {
    api.notifyError(error, "notes.deleteError");
    if (api.errorStatus(error) === 404) void load();
  } finally {
    removing.value = null;
    confirming.value = null;
  }
}

function locate(note: DocumentNoteDto): void {
  if (!note.anchor) return;
  drawerOpen.value = false;
  emit("locate", note.anchor.blockId);
}

// Marks on the text ----------------------------------------------------------------------

/** Name of the highlight (`::highlight(cx-note)` in main.css). */
const HIGHLIGHT = "cx-note";

interface Mark {
  note: DocumentNoteDto;
  range: Range;
}
let marks: Mark[] = [];

function highlights(): Map<string, unknown> | null {
  const registry = (globalThis.CSS as { highlights?: Map<string, unknown> })
    ?.highlights;
  return registry && typeof globalThis.Highlight === "function"
    ? registry
    : null;
}

/** The range of a stretch of a block's text, by character offsets. */
function rangeIn(block: HTMLElement, from: number, to: number): Range | null {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let seen = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    const end = seen + text.length;
    if (!started && from < end) {
      range.setStart(text, from - seen);
      started = true;
    }
    if (started && to <= end) {
      range.setEnd(text, to - seen);
      return range;
    }
    seen = end;
  }
  return null;
}

function drawMarks(): void {
  const registry = highlights();
  if (!registry) return;
  const root = props.root?.() ?? null;
  marks = [];
  if (root && available.value) {
    for (const note of notes.value) {
      if (!note.anchor) continue;
      const block = root.querySelector<HTMLElement>(
        `[data-block-id="${CSS.escape(note.anchor.blockId)}"]`,
      );
      if (!block) continue;
      const at = locateNote(note.anchor, block.textContent ?? "");
      const range = at ? rangeIn(block, at.from, at.to) : null;
      if (range) marks.push({ note, range });
    }
  }
  if (marks.length === 0) {
    registry.delete(HIGHLIGHT);
    return;
  }
  registry.set(HIGHLIGHT, new Highlight(...marks.map((mark) => mark.range)));
}

// The text is rendered by ContentView, which replaces its nodes whenever it
// changes: the marks are drawn again then, and when the notes change.
const rootElement = computed(() => props.root?.() ?? null);
useMutationObserver(rootElement, () => void scheduleMarks(), {
  childList: true,
  subtree: true,
  characterData: true,
});
const scheduleMarks = useDebounceFn(drawMarks, 60);
watch([rootElement, notes, available], () => void scheduleMarks(), {
  flush: "post",
});
onMounted(() => void scheduleMarks());
onBeforeUnmount(() => {
  highlights()?.delete(HIGHLIGHT);
});

// The note under the pointer -------------------------------------------------------------

interface Card {
  note: DocumentNoteDto;
  top: number;
  left: number;
}
const card = ref<Card | null>(null);
const CARD_WIDTH = 320;

function markAt(x: number, y: number): { mark: Mark; box: DOMRect } | null {
  for (const mark of marks) {
    for (const box of mark.range.getClientRects()) {
      if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) {
        return { mark, box };
      }
    }
  }
  return null;
}

let hideTimer: ReturnType<typeof setTimeout> | null = null;
function keepCard(): void {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
}
/** After a moment, so the pointer can reach the card. */
function leaveCard(): void {
  keepCard();
  hideTimer = setTimeout(() => {
    card.value = null;
    confirming.value = null;
  }, 300);
}
onBeforeUnmount(keepCard);

function showAt(event: MouseEvent): boolean {
  const hit = markAt(event.clientX, event.clientY);
  if (!hit) return false;
  keepCard();
  if (card.value?.note.id !== hit.mark.note.id) {
    confirming.value = null;
    card.value = {
      note: hit.mark.note,
      top: hit.box.bottom + 6,
      left: Math.min(
        Math.max(hit.box.left, 8),
        window.innerWidth - CARD_WIDTH - 8,
      ),
    };
  }
  return true;
}

useEventListener(
  rootElement,
  "mousemove",
  (event: MouseEvent) => {
    if (marks.length === 0) return;
    if (!showAt(event) && card.value && !hideTimer) leaveCard();
  },
  { passive: true },
);
useEventListener(rootElement, "mouseleave", () => card.value && leaveCard(), {
  passive: true,
});
// A press shows it too: there is no pointer to rest on a phone.
useEventListener(rootElement, "click", (event: MouseEvent) => {
  if (marks.length > 0) showAt(event);
});
useEventListener(
  window,
  "scroll",
  () => {
    card.value = null;
  },
  { capture: true, passive: true },
);

defineExpose({ annotate, available });
</script>

<template>
  <span v-if="available" class="inline-flex" data-testid="document-notes">
    <UButton
      size="sm"
      color="neutral"
      variant="outline"
      icon="i-lucide-sticky-note"
      :label="t('notes.button')"
      :aria-label="
        total > 0 ? t('notes.buttonCount', { count: total }, total) : undefined
      "
      data-testid="document-notes-open"
      @click="drawerOpen = true"
    >
      <template v-if="total > 0" #trailing>
        <UBadge
          :label="String(total)"
          color="neutral"
          variant="subtle"
          size="sm"
          class="tabular-nums"
          aria-hidden="true"
        />
      </template>
    </UButton>

    <!-- The list -->
    <USlideover
      v-model:open="drawerOpen"
      side="right"
      :title="t('notes.title')"
      :description="t('notes.private')"
      :ui="{ content: 'max-w-full sm:max-w-md', body: 'p-4 sm:p-5' }"
    >
      <template #body>
        <div class="flex flex-col gap-5" data-testid="document-notes-list">
          <UButton
            icon="i-lucide-plus"
            color="neutral"
            variant="outline"
            class="self-start"
            :label="t('notes.addGeneral')"
            data-testid="document-notes-add"
            @click="writeGeneral"
          />

          <CommonEmptyState
            v-if="total === 0"
            icon="i-lucide-sticky-note"
            size="sm"
            :title="t('notes.empty')"
            :description="blocks.length > 0 ? t('notes.emptyHint') : undefined"
          />

          <template
            v-for="section in [
              { key: 'general', notes: listed.general },
              { key: 'placed', notes: listed.placed },
              { key: 'orphaned', notes: listed.orphaned },
            ]"
            :key="section.key"
          >
            <section
              v-if="section.notes.length > 0"
              class="flex flex-col gap-2"
              :aria-labelledby="`notes-${section.key}`"
            >
              <h3
                :id="`notes-${section.key}`"
                class="text-muted text-xs font-semibold tracking-wide uppercase"
              >
                {{ t(`notes.sections.${section.key}`) }}
              </h3>
              <p v-if="section.key === 'orphaned'" class="text-muted text-sm">
                {{ t("notes.orphanedHint") }}
              </p>
              <ul class="flex flex-col gap-2">
                <li
                  v-for="note in section.notes"
                  :key="note.id"
                  class="border-default flex flex-col gap-2 rounded-lg border p-3"
                  data-testid="document-note"
                >
                  <blockquote
                    v-if="note.anchor"
                    class="border-accented text-muted line-clamp-3 border-s-2 ps-2 text-sm break-words"
                  >
                    {{ note.anchor.quote }}
                  </blockquote>
                  <p
                    class="text-default text-sm break-words whitespace-pre-line"
                  >
                    {{ note.body }}
                  </p>
                  <div class="flex flex-wrap items-center gap-1">
                    <UButton
                      v-if="section.key === 'placed'"
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      icon="i-lucide-locate"
                      :label="t('notes.locate')"
                      @click="locate(note)"
                    />
                    <UButton
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      icon="i-lucide-pencil"
                      :label="t('common.edit')"
                      @click="editNote(note)"
                    />
                    <UButton
                      size="xs"
                      :color="confirming === note.id ? 'error' : 'neutral'"
                      :variant="confirming === note.id ? 'soft' : 'ghost'"
                      icon="i-lucide-trash-2"
                      :loading="removing === note.id"
                      :label="
                        confirming === note.id
                          ? t('notes.deleteConfirm')
                          : t('common.delete')
                      "
                      @click="remove(note)"
                    />
                  </div>
                </li>
              </ul>
            </section>
          </template>
        </div>
      </template>
    </USlideover>

    <!-- Writing or changing one -->
    <UModal
      v-model:open="dialogOpen"
      :title="dialogTitle"
      :description="t('notes.private')"
      :dismissible="!saving"
    >
      <template #body>
        <form
          v-if="draft"
          class="flex flex-col gap-3"
          data-testid="document-note-form"
          @submit.prevent="save"
        >
          <blockquote
            v-if="draft.anchor"
            class="border-accented text-muted line-clamp-4 border-s-2 ps-2 text-sm break-words"
          >
            {{ draft.anchor.quote }}
          </blockquote>
          <UFormField :label="t('notes.dialog.label')" required>
            <UTextarea
              v-model="draft.body"
              class="w-full"
              autofocus
              autoresize
              :rows="4"
              :maxrows="12"
              :maxlength="DOCUMENT_NOTE_MAX_LENGTH"
              :placeholder="t('notes.dialog.placeholder')"
            />
          </UFormField>
          <div class="flex flex-wrap justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              :disabled="saving"
              :label="t('common.cancel')"
              @click="draft = null"
            />
            <UButton
              type="submit"
              icon="i-lucide-check"
              :loading="saving"
              :disabled="!draft.body.trim()"
              :label="t('notes.dialog.save')"
            />
          </div>
        </form>
      </template>
    </UModal>

    <!-- The note under the pointer, over the text -->
    <div
      v-if="card"
      class="border-default bg-default fixed z-40 flex flex-col gap-2 rounded-lg border p-3 shadow-lg"
      :style="{
        top: `${card.top}px`,
        left: `${card.left}px`,
        width: `${CARD_WIDTH}px`,
      }"
      role="note"
      data-testid="document-note-card"
      @mouseenter="keepCard"
      @mouseleave="leaveCard"
    >
      <p
        class="text-default max-h-48 overflow-y-auto text-sm break-words whitespace-pre-line"
      >
        {{ card.note.body }}
      </p>
      <div class="flex flex-wrap items-center gap-1">
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-pencil"
          :label="t('common.edit')"
          @click="editNote(card.note)"
        />
        <UButton
          size="xs"
          :color="confirming === card.note.id ? 'error' : 'neutral'"
          :variant="confirming === card.note.id ? 'soft' : 'ghost'"
          icon="i-lucide-trash-2"
          :loading="removing === card.note.id"
          :label="
            confirming === card.note.id
              ? t('notes.deleteConfirm')
              : t('common.delete')
          "
          @click="remove(card.note)"
        />
      </div>
    </div>
  </span>
</template>
