<script setup lang="ts">
import type {
  DocumentDto,
  LivePoint,
  LivePointerEvent,
} from "~~/shared/types/api";
import { useApi } from "~/composables/api/useApi";
import {
  EMPTY_POINTER_STATE,
  applyPointerEvents,
  type PointerState,
} from "~/composables/session/pointerState";
import { usePointerFade } from "~/composables/session/usePointerFade";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";
import {
  pointAt,
  readViewAnchor,
  scrollParentOf,
  type AnchorKind,
} from "~/utils/scrollAnchor";
import { spanOfRange } from "~/utils/textSpan";

/**
 * The text of the document the console shows, for the Mesa to follow what
 * the room reads when it takes no amendments: its uploaded PDF drawn page
 * by page (DocumentPdfPages), else its text as voted or, before, as
 * published. An amendable text is read in «Texto consolidado», with its
 * amendments applied.
 *
 * It has no scroll of its own: the debate column scrolls, one scroll for
 * everything (user's decision of 2026-11-18). While it is the document on
 * screen and the session is open:
 * - where the Mesa has it in view is where the projection shows it: each
 *   scroll of the column sends the block or page at the top of the view
 *   (below the debate bar stuck over it, `[data-sticky-now]`) to POST
 *   .../live-scroll, at most every SEND_MS, the last one always;
 * - «Puntero» turns the mouse into a pointer the projection shows: moves,
 *   clicks (ripples) and strokes drawn by dragging, each placed on its
 *   block or page (pointAt), sent to POST .../live-pointer in batches.
 *   Strokes fade a few seconds after they end unless «Fijar trazos» is on;
 *   «Borrar» clears them. This preview draws the same (SessionPointerLayer).
 *   On a text, «Seleccionar texto» instead lets the Mesa select words as
 *   usual: the projection highlights the same ones (spanOfRange, block and
 *   character offsets), until the selection goes.
 */
const props = defineProps<{ document: DocumentDto }>();

const { t } = useI18n();
const api = useApi();
const session = useSessionConsoleContext();

const SEND_MS = 120;
const POINTER_SEND_MS = 40;
/** Less than this many pixels and this long is a click, not a stroke. */
const CLICK_MOVE_PX = 5;
const CLICK_MS = 350;

const blocks = computed(
  () =>
    props.document.consolidatedVersion?.blocks ??
    props.document.baseVersion?.blocks ??
    [],
);

const root = ref<HTMLElement | null>(null);
const content = ref<HTMLElement | null>(null);
const isFile = computed(() => props.document.format === "file");
const kind = computed<AnchorKind>(() => (isFile.value ? "page" : "block"));
/** The projection follows only the document the room debates. */
const follows = computed(
  () =>
    session.inSession.value &&
    session.liveState.value?.documentId === props.document.id,
);
const assemblyUrl = computed(() => {
  const id = session.assembly.value?.id;
  return id ? `/api/assemblies/${encodeURIComponent(id)}` : null;
});

// Scroll ---------------------------------------------------------------------

let scroller: HTMLElement | null = null;
let scrollTimer: ReturnType<typeof setTimeout> | undefined;
let lastScrollSent = 0;

/** The top of what the Mesa sees: the column's, below the debate bar. */
function viewTop(): number {
  const top = scroller ? scroller.getBoundingClientRect().top : 0;
  const bar = (scroller ?? window.document).querySelector<HTMLElement>(
    "[data-sticky-now]",
  );
  const barBottom =
    bar && bar.offsetHeight > 0 ? bar.getBoundingClientRect().bottom : top;
  return Math.max(top, barBottom);
}

function sendScroll(): void {
  scrollTimer = undefined;
  const scope = content.value;
  const url = assemblyUrl.value;
  if (!scope || !url || !follows.value) return;
  const anchor = readViewAnchor(scope, kind.value, viewTop());
  if (!anchor) return;
  lastScrollSent = Date.now();
  void api
    .send(`${url}/live-scroll`, {
      method: "POST",
      body: { documentId: props.document.id, anchor },
    })
    .catch(() => undefined);
}
function onScroll(): void {
  if (!follows.value || scrollTimer) return;
  const wait = Math.max(0, SEND_MS - (Date.now() - lastScrollSent));
  scrollTimer = setTimeout(sendScroll, wait);
}

onMounted(() => {
  if (!root.value) return;
  scroller = scrollParentOf(root.value);
  (scroller ?? window).addEventListener("scroll", onScroll, { passive: true });
});
onBeforeUnmount(() => {
  (scroller ?? window).removeEventListener("scroll", onScroll);
  clearTimeout(scrollTimer);
});
// The document goes on screen: the projection starts where the Mesa is.
watch(follows, (now) => {
  if (now) onScroll();
});

// Pointer ----------------------------------------------------------------------

// The controls live in the console (session.pointerTools), so the bar
// stuck on top offers them too.
const tools = session.pointerTools;
const pointerOn = computed({
  get: () => tools.on,
  set: (value: boolean) => {
    tools.on = value;
  },
});
/** Drawing with the mouse; on a text, selecting words instead. */
const drawMode = computed(() => isFile.value || tools.mode === "draw");
const pinned = computed({
  get: () => tools.pinned,
  set: (value: boolean) => {
    tools.pinned = value;
  },
});
const pointerState = shallowRef<PointerState>(EMPTY_POINTER_STATE);

let queue: LivePointerEvent[] = [];
let pointerTimer: ReturnType<typeof setTimeout> | undefined;
function flushPointer(): void {
  pointerTimer = undefined;
  const url = assemblyUrl.value;
  const events = queue;
  queue = [];
  if (!url || events.length === 0 || !follows.value) return;
  void api
    .send(`${url}/live-pointer`, {
      method: "POST",
      body: { documentId: props.document.id, events: events.slice(0, 60) },
    })
    .catch(() => undefined);
}

/** Shows an event here and queues it for the projection. */
function emitPointer(event: LivePointerEvent): void {
  pointerState.value = applyPointerEvents(
    pointerState.value,
    [event],
    Date.now(),
  );
  // Moves only keep the latest; stroke pieces of one stroke merge.
  const last = queue.at(-1);
  if (event.type === "move" && last?.type === "move")
    queue[queue.length - 1] = event;
  else if (
    event.type === "stroke" &&
    last?.type === "stroke" &&
    last.id === event.id &&
    !last.end
  ) {
    queue[queue.length - 1] = {
      ...event,
      points: [...last.points, ...event.points].slice(-400),
    };
  } else queue.push(event);
  if (!pointerTimer) pointerTimer = setTimeout(flushPointer, POINTER_SEND_MS);
}

// Fading on this screen too.
usePointerFade(pointerState);
onBeforeUnmount(() => clearTimeout(pointerTimer));

let strokeSeq = 0;
let drawing: {
  id: string;
  startX: number;
  startY: number;
  at: number;
  moved: boolean;
  points: LivePoint[];
} | null = null;

function pointOf(event: PointerEvent): LivePoint | null {
  return content.value
    ? pointAt(content.value, kind.value, event.clientX, event.clientY)
    : null;
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  const point = pointOf(event);
  if (!point) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  drawing = {
    id: `${Date.now().toString(36)}-${++strokeSeq}`,
    startX: event.clientX,
    startY: event.clientY,
    at: Date.now(),
    moved: false,
    points: [point],
  };
  event.preventDefault();
}

function onPointerMove(event: PointerEvent): void {
  const point = pointOf(event);
  if (!point) return;
  if (!drawing) {
    emitPointer({ type: "move", point });
    return;
  }
  const distance = Math.hypot(
    event.clientX - drawing.startX,
    event.clientY - drawing.startY,
  );
  if (!drawing.moved && distance < CLICK_MOVE_PX) return;
  if (!drawing.moved) {
    drawing.moved = true;
    emitPointer({
      type: "stroke",
      id: drawing.id,
      points: drawing.points,
      end: false,
      pinned: pinned.value,
    });
  }
  emitPointer({
    type: "stroke",
    id: drawing.id,
    points: [point],
    end: false,
    pinned: pinned.value,
  });
}

function onPointerUp(event: PointerEvent): void {
  const current = drawing;
  drawing = null;
  if (!current) return;
  if (!current.moved && Date.now() - current.at < CLICK_MS) {
    emitPointer({ type: "click", point: current.points[0]! });
    return;
  }
  if (!current.moved) return;
  const point = pointOf(event);
  emitPointer({
    type: "stroke",
    id: current.id,
    points: point ? [point] : [],
    end: true,
    pinned: pinned.value,
  });
}

function onPointerLeave(): void {
  if (drawing) return;
  emitPointer({ type: "move", point: null });
}

function clearStrokes(): void {
  tools.clears++;
}
watch(
  () => tools.clears,
  () => emitPointer({ type: "clear" }),
);

watch(pointerOn, (on) => {
  if (!on) emitPointer({ type: "move", point: null });
});

// Selecting text --------------------------------------------------------------

/** The span last sent, to send only what changes. */
let sentSelection = "null";
function sendSelection(): void {
  const scope = content.value;
  const selection = window.getSelection();
  let span = null;
  if (
    scope &&
    pointerOn.value &&
    !drawMode.value &&
    selection &&
    selection.rangeCount > 0
  ) {
    const range = selection.getRangeAt(0);
    if (scope.contains(range.commonAncestorContainer)) {
      span = spanOfRange(scope, range);
    }
  }
  const key = JSON.stringify(span);
  if (key === sentSelection) return;
  sentSelection = key;
  emitPointer({ type: "select", span });
}
let selectionTimer: ReturnType<typeof setTimeout> | undefined;
function onSelectionChange(): void {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(sendSelection, 80);
}
onMounted(() => {
  window.document.addEventListener("selectionchange", onSelectionChange);
});
onBeforeUnmount(() => {
  window.document.removeEventListener("selectionchange", onSelectionChange);
  clearTimeout(selectionTimer);
});
// Leaving selection (or the pointer) drops what the projection highlights.
watch([pointerOn, drawMode], () => sendSelection());
watch(follows, (now) => {
  if (!now) {
    pointerOn.value = false;
    pointerState.value = EMPTY_POINTER_STATE;
  }
});
const hasContent = computed(() =>
  isFile.value ? Boolean(props.document.fileUrl) : blocks.value.length > 0,
);
watch(
  () => follows.value && hasContent.value,
  (available) => {
    tools.available = available;
  },
  { immediate: true },
);
watch(
  isFile,
  (file) => {
    tools.text = !file;
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  tools.available = false;
  tools.on = false;
});
</script>

<template>
  <section
    ref="root"
    class="space-y-2"
    :aria-label="t('session.queue.documentText', { title: document.title })"
  >
    <!-- The pointer, only for the document the room sees. -->
    <div
      v-if="follows && (blocks.length > 0 || document.fileUrl)"
      class="flex flex-wrap items-center gap-2"
    >
      <UButton
        size="sm"
        :color="pointerOn ? 'primary' : 'neutral'"
        :variant="pointerOn ? 'soft' : 'outline'"
        icon="i-lucide-mouse-pointer-click"
        :label="t('session.pointer.toggle')"
        :aria-pressed="pointerOn"
        @click="pointerOn = !pointerOn"
      />
      <template v-if="pointerOn">
        <SessionPointerMode v-if="!isFile" />
        <USwitch v-model="pinned" size="sm" :label="t('session.pointer.pin')" />
        <UButton
          size="sm"
          color="neutral"
          variant="ghost"
          icon="i-lucide-eraser"
          :label="t('session.pointer.clear')"
          @click="clearStrokes"
        />
        <p class="text-muted w-full text-xs">
          {{ t("session.pointer.hint") }}
        </p>
      </template>
    </div>

    <template v-if="isFile">
      <div
        v-if="document.fileUrl"
        class="border-default bg-elevated rounded-lg border p-3"
      >
        <div ref="content" class="relative">
          <DocumentPdfPages
            :key="document.id"
            :url="document.fileUrl"
            :title="document.title"
          />
          <SessionPointerLayer :state="pointerState" :scope="content" />
          <div
            v-if="pointerOn"
            class="absolute inset-0 z-20 cursor-crosshair touch-none"
            @pointerdown="onPointerDown"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
            @pointerleave="onPointerLeave"
          />
        </div>
      </div>
      <p v-else class="text-muted text-sm">
        {{ t("session.queue.pdfPending") }}
      </p>
    </template>
    <div
      v-else-if="blocks.length > 0"
      class="border-default bg-default rounded-lg border p-4"
    >
      <div ref="content" class="relative">
        <ContentView :key="document.id" :blocks="blocks" />
        <SessionPointerLayer
          :state="pointerState"
          :scope="content"
          :show-selection="false"
        />
        <div
          v-if="pointerOn && drawMode"
          class="absolute inset-0 z-20 cursor-crosshair touch-none"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
          @pointerleave="onPointerLeave"
        />
      </div>
    </div>
    <p v-else class="text-muted text-sm">{{ t("session.preview.empty") }}</p>
  </section>
</template>
