<script setup lang="ts">
import {
  SEATING_SEAT_DIAMETER,
  layoutBounds,
  type SeatingFixture,
  type SeatingLayout,
  type SeatingTable,
} from "~~/shared/utils/seating/layout";
import {
  jumpRun,
  stepSeat,
  type SeatingWalk,
} from "~~/shared/utils/seating/runs";
import {
  pointsBounds,
  snapToGrid,
  viewMatrix,
  type ViewPoint,
} from "~/composables/seating/-viewport";
import type { SvgViewportDrag } from "~/composables/seating/useSvgViewport";
import {
  SEATING_COLOUR_STYLES,
  accountBlocks,
  fitFontSize,
  labelPlacement,
  personInitials,
  stadiumPath,
  type AccountBlock,
  type SeatView,
  type SeatingPlanMode,
  type SeatingPlanPreview,
  type SeatingPlanView,
} from "./-model";

/**
 * The room drawn as one SVG (docs/seating-plan.md, section 7): tables,
 * landmarks, seats and who sits there, as account blocks («Cuentas») or one
 * bubble per seat («Asistentes»), in the room's centimetres under a pan and
 * zoom layer (useSvgViewport).
 *
 * One tab stop: a roving focus walks the seats. Left and right follow the
 * run, up and down jump to the nearest seat of the run before or after,
 * Home and End go to its ends; Enter or Space activates a seat, the context
 * menu key or Shift+F10 asks for its menu, Delete and Escape are passed on.
 * In Editar sala, Enter on a loose chair takes it, the arrows move it 10 cm
 * at a time (50 with Shift) and Enter or Escape lets it go; a chair can also
 * be dragged, on the 10 cm grid.
 *
 * «Colocar» builds on `mode`, `preview` (the seats a pick would take,
 * green or red, and the people it would move, dashed), `selectedSeatIds`,
 * the `seat-activate`, `seat-hover`, `seat-menu` and `delete` events and
 * the default slot, drawn in room coordinates above the seats (the ghost
 * of Proponer reparto).
 */

const props = withDefaults(
  defineProps<{
    layout: SeatingLayout;
    walk: SeatingWalk;
    /** Every seat in walk order with its occupant (seatViews). */
    seats: readonly SeatView[];
    /** The SVG's accessible name. */
    label: string;
    /** Each seat's accessible name; the thumbnail passes none. */
    seatLabel?: (seat: SeatView) => string;
    view?: SeatingPlanView;
    mode?: SeatingPlanMode;
    /** Seats to point out (a search match): the rest dims. */
    highlightedSeatIds?: readonly string[];
    /** Seats chosen (Editar sala: the seat or chair being edited). */
    selectedSeatIds?: readonly string[];
    /** The seats a placing would take, green or red (stage 4). */
    preview?: SeatingPlanPreview | null;
    /** Off for a thumbnail: no focus, no gestures, always fitted. */
    interactive?: boolean;
  }>(),
  {
    seatLabel: undefined,
    view: "accounts",
    mode: "view",
    highlightedSeatIds: () => [],
    selectedSeatIds: () => [],
    preview: null,
    interactive: true,
  },
);

/** The seat the roving focus is on. */
const focusedSeatId = defineModel<string | null>("focusedSeatId", {
  default: null,
});

const emit = defineEmits<{
  /** A click, a tap, Enter or Space on a seat. */
  "seat-activate": [seatId: string, element: Element];
  /** The pointer came onto a seat, or left them all (null). */
  "seat-hover": [seatId: string | null];
  /** The context menu, Shift+F10 or a long press on a seat. */
  "seat-menu": [seatId: string, element: Element];
  /** Delete or Backspace on a seat. */
  delete: [seatId: string];
  /** A loose chair dropped or nudged (Editar sala), on the 10 cm grid. */
  "chair-move": [chairId: string, point: ViewPoint];
  /** Escape, with nothing taken. */
  cancel: [];
  /** A tap on the floor, away from the seats. */
  "floor-tap": [];
  /** The view started to move: popovers anchored to a seat close. */
  "view-change": [];
}>();

const { t } = useI18n();
const { enabled: singleKeys } = useSingleKeyShortcuts();

const R = SEATING_SEAT_DIAMETER / 2;
const uid = useId();
const clipId = `seating-clip-${uid}`;
const helpId = `seating-help-${uid}`;

const svg = useTemplateRef<SVGSVGElement>("svg");
const layer = useTemplateRef<SVGGElement>("layer");

// Chairs dragged in Editar sala ------------------------------------------------

const chairIds = computed(() => new Set(props.layout.chairs.map((c) => c.id)));
/** Where the chair being dragged would land; only it moves per frame. */
const ghost = ref<{ id: string; x: number; y: number } | null>(null);

function chairDrag(event: PointerEvent): SvgViewportDrag | null {
  if (!props.interactive || props.mode !== "edit") return null;
  const target = (event.target as Element | null)?.closest("[data-seat-id]");
  const id = target?.getAttribute("data-seat-id");
  if (!id || !chairIds.value.has(id)) return null;
  const chair = props.layout.chairs.find((entry) => entry.id === id);
  if (!chair) return null;
  const start = viewport.clientToRoom(event.clientX, event.clientY);
  const offset = { x: chair.x - start.x, y: chair.y - start.y };
  const at = (point: ViewPoint) => ({
    x: snapToGrid(point.x + offset.x),
    y: snapToGrid(point.y + offset.y),
  });
  return {
    move: (point) => {
      ghost.value = { id, ...at(point) };
    },
    end: (point) => {
      ghost.value = null;
      const target = at(point);
      if (target.x !== chair.x || target.y !== chair.y) {
        emit("chair-move", id, target);
      }
    },
    cancel: () => {
      ghost.value = null;
    },
  };
}

const viewport = useSvgViewport({
  svg,
  layer,
  claimDrag: (event) => chairDrag(event),
  wantsLongPress: (event) =>
    props.interactive &&
    hasSeatMenu() &&
    Boolean((event.target as Element | null)?.closest("[data-seat-id]")),
  onLongPress: (event) => {
    const element = (event.target as Element | null)?.closest("[data-seat-id]");
    const id = element?.getAttribute("data-seat-id");
    if (props.interactive && element && id && hasSeatMenu()) {
      emit("seat-menu", id, element);
    }
  },
  onViewChange: () => emit("view-change"),
});

// Fitting ---------------------------------------------------------------------

const bounds = computed(() => layoutBounds(props.layout));
let fitted = false;
/** Seats asked to be shown before the plan had a size (just mounted). */
let pendingShow: ReturnType<typeof pointsBounds> = null;

/** «Ajustar»: the whole room in view. */
function fit(): void {
  viewport.fit(bounds.value);
}

// Fit when the plan first has a size; a thumbnail follows every change.
watch(
  () => viewport.size.value,
  (size) => {
    if (size.width <= 0 || size.height <= 0) return;
    if (!fitted || !props.interactive) {
      fitted = true;
      if (pendingShow && props.interactive) viewport.show(pendingShow);
      else fit();
      pendingShow = null;
    }
  },
);
watch(bounds, () => {
  if (!props.interactive && fitted) fit();
});

// Seats -------------------------------------------------------------------------

const seatById = computed(
  () => new Map(props.seats.map((seat) => [seat.id, seat])),
);
const highlighted = computed(() => new Set(props.highlightedSeatIds));
const selected = computed(() => new Set(props.selectedSeatIds));
const previewIds = computed(() => new Set(props.preview?.seatIds ?? []));
const displacedIds = computed(
  () => new Set(props.preview?.displacedSeatIds ?? []),
);
const dimming = computed(() => highlighted.value.size > 0);

/** Disabled seats take the focus only in Editar sala (to enable them). */
const includeDisabled = computed(() => props.mode === "edit");
const focusable = (seat: SeatView) => includeDisabled.value || !seat.disabled;

/** The one seat with tabindex 0. */
const rovingId = computed(() => {
  const wanted = focusedSeatId.value
    ? seatById.value.get(focusedSeatId.value)
    : null;
  if (wanted && focusable(wanted)) return wanted.id;
  return props.seats.find(focusable)?.id ?? null;
});

function seatPoint(seat: SeatView): ViewPoint {
  return ghost.value?.id === seat.id ? ghost.value : seat;
}

const isChair = (seat: SeatView) => seat.tableId === null;

// Blocks («Cuentas») ---------------------------------------------------------------

const blocks = computed<AccountBlock[]>(() =>
  props.view === "accounts" ? accountBlocks(props.walk, props.seats) : [],
);

/** The account whose blocks light up: hovered, or on the focused seat. */
const hoveredGroupId = ref<string | null>(null);
const hasFocus = ref(false);
const litGroupId = computed(() => {
  if (hoveredGroupId.value) return hoveredGroupId.value;
  if (!hasFocus.value || !focusedSeatId.value) return null;
  return seatById.value.get(focusedSeatId.value)?.occupant?.group?.id ?? null;
});

function blockDimmed(block: AccountBlock): boolean {
  return (
    dimming.value && !block.seatIds.some((id) => highlighted.value.has(id))
  );
}

function blockImage(block: AccountBlock): string | null {
  const seat = seatById.value.get(block.seatIds[0]!);
  return seat?.occupant?.group?.imageUrl ?? null;
}

function blockAcronym(block: AccountBlock): string {
  return seatById.value.get(block.seatIds[0]!)?.occupant?.group?.acronym ?? "";
}

/** The width inside a block, for its acronym when it has no image. */
function blockInnerWidth(block: AccountBlock): number {
  const from = block.points[0]!;
  const to = block.points[block.points.length - 1]!;
  return Math.hypot(to.x - from.x, to.y - from.y) + SEATING_SEAT_DIAMETER - 10;
}

/** On the table side: «UGR ×3» with an image, «×3» without one. */
function blockLabel(block: AccountBlock): string {
  const count = block.seatIds.length;
  // «×3»: a figure and a sign, the same in every language.
  const times = count > 1 ? `×${count}` : "";
  if (!blockImage(block)) return times;
  return times ? `${blockAcronym(block)} ${times}` : blockAcronym(block);
}

function colourStyle(seat: SeatView) {
  return SEATING_COLOUR_STYLES[seat.occupant?.colour ?? "neutral"];
}

// Seat visuals («Asistentes») ---------------------------------------------------------

function seatInitials(seat: SeatView): string | null {
  return seat.occupant ? personInitials(seat.occupant.person) : null;
}

function seatGone(seat: SeatView): boolean {
  const occupant = seat.occupant;
  return Boolean(occupant?.person.goneAt || occupant?.group?.goneAt);
}

function seatPending(seat: SeatView): boolean {
  return seat.occupant?.person.status === "pending";
}

/** The acronym of each seat's account on the table side («Asistentes»). */
const seatTags = computed(() => {
  const tags = new Map<
    string,
    { text: string; x: number; y: number; angle: number }
  >();
  if (props.view !== "people") return tags;
  for (const seat of props.seats) {
    const acronym = seat.occupant?.group?.acronym;
    if (!acronym) continue;
    tags.set(seat.id, {
      text: acronym,
      ...labelPlacement(seat, !isChair(seat)),
    });
  }
  return tags;
});

function seatDimmed(seat: SeatView): boolean {
  return dimming.value && !highlighted.value.has(seat.id);
}

// Tables and landmarks ---------------------------------------------------------------

function boxTransform(box: Pick<SeatingTable, "x" | "y" | "rotation">) {
  return box.rotation ? `rotate(${box.rotation} ${box.x} ${box.y})` : undefined;
}

function fixtureLabel(fixture: SeatingFixture): string {
  return fixture.label ?? t(`seating.fixtures.${fixture.kind}`);
}

// Focus and keyboard -------------------------------------------------------------------

/** The focus ring shows only after a key: a click or a tap shows none. */
const keyboardFocus = ref(false);

/**
 * Whether the last input anywhere on the page was a key. A Tab from the
 * search field, or Enter in the tray that hands the focus to a seat, is
 * pressed outside the plan: its keydown never reaches onKeydown, yet the
 * seat it focuses needs its ring (WCAG 2.4.7).
 */
let lastInputWasKey = false;
const pageEvents = import.meta.client ? document : undefined;
useEventListener(pageEvents, "keydown", () => (lastInputWasKey = true), {
  capture: true,
  passive: true,
});
useEventListener(pageEvents, "pointerdown", () => (lastInputWasKey = false), {
  capture: true,
  passive: true,
});
const grabbedChairId = ref<string | null>(null);
const announcement = ref("");

function seatElement(id: string): SVGGElement | null {
  return (
    svg.value?.querySelector<SVGGElement>(
      `[data-seat-id="${CSS.escape(id)}"]`,
    ) ?? null
  );
}

/** Moves the roving focus to a seat and brings it into view. */
function focusSeat(id: string): void {
  focusedSeatId.value = id;
  const seat = seatById.value.get(id);
  if (seat) viewport.reveal(seat);
  void nextTick(() => seatElement(id)?.focus({ preventScroll: true }));
}

function onFocusIn(event: FocusEvent): void {
  hasFocus.value = true;
  const target = event.target as Element | null;
  let focusVisible = false;
  try {
    focusVisible = target?.matches?.(":focus-visible") ?? false;
  } catch {
    // A browser without :focus-visible: the last input decides.
  }
  keyboardFocus.value = lastInputWasKey || focusVisible;
  const id = target?.getAttribute?.("data-seat-id");
  if (id) focusedSeatId.value = id;
}

function onFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget as Node | null;
  if (next && svg.value?.contains(next)) return;
  hasFocus.value = false;
  if (grabbedChairId.value) dropChair();
}

function runEdge(id: string, end: "first" | "last"): string | null {
  const seat = props.walk.seats.get(id);
  if (!seat) return null;
  const run = props.walk.runs[seat.runIndex]!.seats.filter(
    (entry) => includeDisabled.value || !entry.disabled,
  );
  return (end === "first" ? run[0] : run[run.length - 1])?.id ?? null;
}

const NUDGE = 10;
const NUDGE_FAR = 50;

function nudgeChair(id: string, dx: number, dy: number): void {
  const chair = props.layout.chairs.find((entry) => entry.id === id);
  if (!chair) return;
  emit("chair-move", id, {
    x: snapToGrid(chair.x + dx),
    y: snapToGrid(chair.y + dy),
  });
}

function grabChair(id: string): void {
  grabbedChairId.value = id;
  announcement.value = t("seating.plan.chairGrabbed");
}

function dropChair(): void {
  grabbedChairId.value = null;
  announcement.value = t("seating.plan.chairDropped");
}

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

function onKeydown(event: KeyboardEvent): void {
  if (!props.interactive) return;
  keyboardFocus.value = true;
  const id =
    (event.target as Element | null)?.getAttribute?.("data-seat-id") ??
    focusedSeatId.value ??
    rovingId.value;

  // Zoom keys, single keys: only while the browser allows them.
  if (!event.ctrlKey && !event.metaKey && !event.altKey && singleKeys.value) {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      viewport.zoomIn();
      return;
    }
    if (event.key === "-") {
      event.preventDefault();
      viewport.zoomOut();
      return;
    }
    if (event.key === "0") {
      event.preventDefault();
      fit();
      return;
    }
  }
  if (!id) return;
  const element = seatElement(id);

  // A loose chair taken in Editar sala moves with the arrows.
  if (grabbedChairId.value === id) {
    const arrow = ARROWS[event.key];
    if (arrow) {
      event.preventDefault();
      const step = event.shiftKey ? NUDGE_FAR : NUDGE;
      nudgeChair(id, arrow[0] * step, arrow[1] * step);
      return;
    }
    if (event.key === "Enter" || event.key === " " || event.key === "Escape") {
      event.preventDefault();
      dropChair();
      return;
    }
  }

  let next: string | null = null;
  const options = { includeDisabled: includeDisabled.value };
  switch (event.key) {
    case "ArrowRight":
      next = stepSeat(props.walk, id, 1, options);
      break;
    case "ArrowLeft":
      next = stepSeat(props.walk, id, -1, options);
      break;
    case "ArrowDown":
      next = jumpRun(props.walk, pointsMap.value, id, 1, options);
      break;
    case "ArrowUp":
      next = jumpRun(props.walk, pointsMap.value, id, -1, options);
      break;
    case "Home":
      next = runEdge(id, "first");
      break;
    case "End":
      next = runEdge(id, "last");
      break;
    case "Enter":
    case " ":
      event.preventDefault();
      if (element) emit("seat-activate", id, element);
      if (props.mode === "edit" && chairIds.value.has(id)) grabChair(id);
      return;
    case "Escape":
      emit("cancel");
      return;
    case "Delete":
    case "Backspace":
      event.preventDefault();
      emit("delete", id);
      return;
    case "ContextMenu":
      if (!hasSeatMenu()) return;
      event.preventDefault();
      if (element) emit("seat-menu", id, element);
      return;
    case "F10":
      if (event.shiftKey && hasSeatMenu()) {
        event.preventDefault();
        if (element) emit("seat-menu", id, element);
      }
      return;
    default:
      return;
  }
  event.preventDefault();
  if (next) focusSeat(next);
}

const pointsMap = computed(
  () => new Map(props.seats.map((seat) => [seat.id, { x: seat.x, y: seat.y }])),
);

function onSeatClick(seat: SeatView, event: MouseEvent): void {
  if (!props.interactive) return;
  keyboardFocus.value = false;
  focusedSeatId.value = seat.id;
  emit("seat-activate", seat.id, event.currentTarget as Element);
}

/**
 * Whether the page listens for `seat-menu` (editors in «Colocar»): when it
 * does not, a right click, the menu key and Shift+F10 keep the browser's
 * own menu.
 */
const instance = getCurrentInstance();
const hasSeatMenu = () => Boolean(instance?.vnode.props?.onSeatMenu);

function onSeatContextMenu(seat: SeatView, event: MouseEvent): void {
  if (!props.interactive || !hasSeatMenu()) return;
  event.preventDefault();
  focusedSeatId.value = seat.id;
  emit("seat-menu", seat.id, event.currentTarget as Element);
}

function onPointerDown(): void {
  keyboardFocus.value = false;
}

function onSeatEnter(seat: SeatView): void {
  hoveredGroupId.value = seat.occupant?.group?.id ?? hoveredGroupId.value;
  if (props.interactive) emit("seat-hover", seat.id);
}

function onSeatLeave(): void {
  hoveredGroupId.value = null;
  if (props.interactive) emit("seat-hover", null);
}

// Rings ----------------------------------------------------------------------------------

const showFocusRing = computed(
  () => props.interactive && hasFocus.value && keyboardFocus.value,
);

const focusedSeat = computed(() =>
  focusedSeatId.value
    ? (seatById.value.get(focusedSeatId.value) ?? null)
    : null,
);

// Exposed ----------------------------------------------------------------------------------

/**
 * Centres the given seats (a search match), zooming in to read them. Asked
 * before the plan has a size (it was just mounted), it waits for it and
 * shows them instead of fitting the room.
 */
function show(seatIds: readonly string[]): void {
  const points = seatIds
    .map((id) => seatById.value.get(id))
    .filter((seat): seat is SeatView => Boolean(seat));
  const box = pointsBounds(points, R + 10);
  if (!box) return;
  const size = viewport.size.value;
  if (!fitted || size.width <= 0 || size.height <= 0) {
    pendingShow = box;
    return;
  }
  viewport.show(box);
}

defineExpose({
  fit,
  zoomIn: () => viewport.zoomIn(),
  zoomOut: () => viewport.zoomOut(),
  actualSize: () => viewport.actualSize(),
  show,
  focusSeat,
  seatElement,
  /** The room point at the middle of the view (where a new chair goes). */
  middleOfView: () => viewport.middleOfView(),
});

const transform = computed(() => viewMatrix(viewport.view.value));
</script>

<template>
  <div class="seating-plan absolute inset-0 overflow-hidden">
    <!-- It fills its container, which must be positioned (relative). -->
    <svg
      ref="svg"
      class="block h-full w-full touch-none select-none"
      :class="[
        interactive ? 'cursor-grab' : 'pointer-events-none',
        { 'cursor-grabbing': viewport.moving.value },
      ]"
      :role="interactive ? 'application' : 'img'"
      :aria-label="label"
      :aria-describedby="interactive ? helpId : undefined"
      @keydown="onKeydown"
      @focusin="onFocusIn"
      @focusout="onFocusOut"
      @pointerdown="onPointerDown"
    >
      <defs>
        <clipPath :id="clipId" clipPathUnits="objectBoundingBox">
          <circle cx="0.5" cy="0.5" r="0.5" />
        </clipPath>
      </defs>

      <g ref="layer" :transform="transform">
        <!-- The floor: a drag on it pans, a tap on it lets go. -->
        <rect
          class="floor"
          x="-100000"
          y="-100000"
          width="200000"
          height="200000"
          @click="emit('floor-tap')"
        />

        <!-- Landmarks -->
        <g
          v-for="fixture in layout.fixtures"
          :key="fixture.id"
          :transform="boxTransform(fixture)"
          aria-hidden="true"
        >
          <rect
            class="fixture"
            :x="fixture.x - fixture.w / 2"
            :y="fixture.y - fixture.h / 2"
            :width="fixture.w"
            :height="fixture.h"
            rx="6"
          />
          <text
            class="plan-text"
            :x="fixture.x"
            :y="fixture.y"
            font-size="16"
            text-anchor="middle"
            dominant-baseline="central"
          >
            {{ fixtureLabel(fixture) }}
          </text>
        </g>

        <!-- Tables -->
        <g aria-hidden="true">
          <template v-for="table in layout.tables" :key="table.id">
            <circle
              v-if="table.shape === 'round'"
              class="table"
              :class="`table-${table.zone}`"
              :cx="table.x"
              :cy="table.y"
              :r="Math.max(table.w, table.h) / 2"
            />
            <rect
              v-else
              class="table"
              :class="`table-${table.zone}`"
              :x="table.x - table.w / 2"
              :y="table.y - table.h / 2"
              :width="table.w"
              :height="table.h"
              rx="4"
              :transform="boxTransform(table)"
            />
          </template>
        </g>

        <!-- «Cuentas»: one capsule per block of an account -->
        <g v-if="view === 'accounts'" aria-hidden="true">
          <g
            v-for="block in blocks"
            :key="block.key"
            class="block"
            :class="{
              'is-dimmed': blockDimmed(block),
              'is-lit': litGroupId === block.groupId,
              'is-pending': block.pending,
            }"
            @pointerenter="hoveredGroupId = block.groupId"
            @pointerleave="hoveredGroupId = null"
          >
            <path
              class="block-glow"
              :d="stadiumPath(block.points, R + 5)"
              :style="{ stroke: SEATING_COLOUR_STYLES[block.colour].ring }"
            />
            <path
              class="block-shape"
              :d="stadiumPath(block.points, R)"
              :style="{
                fill: SEATING_COLOUR_STYLES[block.colour].tint,
                stroke: SEATING_COLOUR_STYLES[block.colour].ring,
              }"
            />
            <template v-if="blockImage(block)">
              <circle
                class="image-back"
                :cx="block.centre.x"
                :cy="block.centre.y"
                :r="R - 4"
              />
              <image
                :href="blockImage(block) ?? undefined"
                :x="block.centre.x - (R - 4)"
                :y="block.centre.y - (R - 4)"
                :width="2 * (R - 4)"
                :height="2 * (R - 4)"
                :clip-path="`url(#${clipId})`"
                preserveAspectRatio="xMidYMid meet"
              />
            </template>
            <text
              v-else
              class="plan-text"
              :x="block.centre.x"
              :y="block.centre.y"
              :font-size="
                fitFontSize(blockAcronym(block), blockInnerWidth(block), 15)
              "
              font-weight="600"
              text-anchor="middle"
              dominant-baseline="central"
            >
              {{ blockAcronym(block) }}
            </text>
            <text
              v-if="blockLabel(block)"
              class="plan-text plan-label"
              :x="block.label.x"
              :y="block.label.y"
              :transform="`rotate(${block.label.angle} ${block.label.x} ${block.label.y})`"
              font-size="12"
              text-anchor="middle"
              dominant-baseline="central"
            >
              {{ blockLabel(block) }}
            </text>
          </g>
        </g>

        <!-- Seats: the focus and pointer targets, and «Asistentes» -->
        <g
          v-for="seat in seats"
          :key="seat.id"
          class="seat"
          :class="{
            'is-dimmed': seatDimmed(seat),
            'is-chair': isChair(seat),
            'is-movable': mode === 'edit' && isChair(seat),
          }"
          :data-seat-id="seat.id"
          :role="interactive ? 'button' : undefined"
          :tabindex="interactive ? (seat.id === rovingId ? 0 : -1) : undefined"
          :aria-label="interactive && seatLabel ? seatLabel(seat) : undefined"
          :aria-pressed="
            interactive && selected.has(seat.id) ? true : undefined
          "
          :aria-disabled="seat.disabled && mode !== 'edit' ? true : undefined"
          @click="onSeatClick(seat, $event)"
          @contextmenu="onSeatContextMenu(seat, $event)"
          @pointerenter="onSeatEnter(seat)"
          @pointerleave="onSeatLeave"
        >
          <!-- Disabled: a crossed-out seat -->
          <template v-if="seat.disabled">
            <circle
              class="seat-disabled"
              :cx="seat.x"
              :cy="seat.y"
              :r="R - 3"
            />
            <path
              class="seat-cross"
              :d="`M ${seat.x - 10} ${seat.y - 10} L ${seat.x + 10} ${seat.y + 10} M ${seat.x + 10} ${seat.y - 10} L ${seat.x - 10} ${seat.y + 10}`"
            />
          </template>

          <!-- Empty: a loose chair is square, a table's seat round -->
          <template v-else-if="!seat.occupant">
            <rect
              v-if="isChair(seat)"
              class="seat-empty"
              :class="{ 'is-ghosted': ghost?.id === seat.id }"
              :x="seat.x - R"
              :y="seat.y - R"
              :width="2 * R"
              :height="2 * R"
              rx="12"
            />
            <circle
              v-else
              class="seat-empty"
              :cx="seat.x"
              :cy="seat.y"
              :r="R"
            />
          </template>

          <!-- «Asistentes»: the photo, the initials or a silhouette. In
               «Cuentas» the account's block, drawn below, shows it. -->
          <template v-else-if="view === 'people'">
            <circle
              :cx="seatPoint(seat).x"
              :cy="seatPoint(seat).y"
              :r="R"
              :style="{ fill: colourStyle(seat).tint }"
            />
            <image
              v-if="seat.occupant.person.photoUrl"
              :href="seat.occupant.person.photoUrl"
              :x="seatPoint(seat).x - R"
              :y="seatPoint(seat).y - R"
              :width="2 * R"
              :height="2 * R"
              :clip-path="`url(#${clipId})`"
              preserveAspectRatio="xMidYMid slice"
            />
            <text
              v-else-if="seatInitials(seat)"
              class="plan-text"
              :x="seatPoint(seat).x"
              :y="seatPoint(seat).y"
              font-size="16"
              font-weight="600"
              text-anchor="middle"
              dominant-baseline="central"
            >
              {{ seatInitials(seat) }}
            </text>
            <g
              v-else
              class="silhouette"
              :transform="`translate(${seatPoint(seat).x} ${seatPoint(seat).y})`"
            >
              <circle cx="0" cy="-6" r="7" />
              <path d="M -13 15 C -13 4 -7 2 0 2 C 7 2 13 4 13 15 Z" />
            </g>
            <circle
              class="seat-ring"
              :class="{ 'is-pending': seatPending(seat) }"
              :cx="seatPoint(seat).x"
              :cy="seatPoint(seat).y"
              :r="R - 1"
              :style="{ stroke: colourStyle(seat).ring }"
            />
            <text
              v-if="seatTags.get(seat.id) && ghost?.id !== seat.id"
              class="plan-text plan-label"
              :x="seatTags.get(seat.id)!.x"
              :y="seatTags.get(seat.id)!.y"
              :transform="`rotate(${seatTags.get(seat.id)!.angle} ${seatTags.get(seat.id)!.x} ${seatTags.get(seat.id)!.y})`"
              font-size="11"
              text-anchor="middle"
              dominant-baseline="central"
            >
              {{ seatTags.get(seat.id)!.text }}
            </text>
          </template>

          <!-- No longer registered: a small mark on the seat -->
          <g
            v-if="seatGone(seat)"
            class="gone-mark"
            :transform="`translate(${seatPoint(seat).x + R - 6} ${seatPoint(seat).y - R + 6})`"
          >
            <circle r="8" />
            <path d="M -3.5 -3.5 L 3.5 3.5 M 3.5 -3.5 L -3.5 3.5" />
          </g>

          <!-- What the pointer and the focus hit -->
          <circle
            class="seat-hit"
            :cx="seatPoint(seat).x"
            :cy="seatPoint(seat).y"
            :r="R"
          />
        </g>

        <!-- Rings above the seats -->
        <g aria-hidden="true" class="pointer-events-none">
          <circle
            v-for="seat in seats.filter((entry) => previewIds.has(entry.id))"
            :key="`preview-${seat.id}`"
            class="preview-ring"
            :class="preview?.fits ? 'fits' : 'does-not-fit'"
            :cx="seat.x"
            :cy="seat.y"
            :r="R + 3"
          />
          <circle
            v-for="seat in seats.filter((entry) => displacedIds.has(entry.id))"
            :key="`displaced-${seat.id}`"
            class="displaced-ring"
            :cx="seat.x"
            :cy="seat.y"
            :r="R + 3"
          />
          <circle
            v-for="seat in seats.filter((entry) => highlighted.has(entry.id))"
            :key="`match-${seat.id}`"
            class="match-ring"
            :cx="seat.x"
            :cy="seat.y"
            :r="R + 6"
          />
          <circle
            v-for="seat in seats.filter((entry) => selected.has(entry.id))"
            :key="`selected-${seat.id}`"
            class="selected-ring"
            :cx="seatPoint(seat).x"
            :cy="seatPoint(seat).y"
            :r="R + 7"
          />
          <template v-if="ghost">
            <rect
              class="chair-ghost"
              :x="ghost.x - R"
              :y="ghost.y - R"
              :width="2 * R"
              :height="2 * R"
              rx="12"
            />
          </template>
          <template v-if="showFocusRing && focusedSeat">
            <circle
              class="focus-halo"
              :cx="seatPoint(focusedSeat).x"
              :cy="seatPoint(focusedSeat).y"
              :r="R + 9"
            />
            <circle
              class="focus-ring"
              :class="{ 'is-grabbed': grabbedChairId === focusedSeat.id }"
              :cx="seatPoint(focusedSeat).x"
              :cy="seatPoint(focusedSeat).y"
              :r="R + 9"
            />
          </template>
        </g>

        <!-- The page draws its ghosts here, in room coordinates. -->
        <slot />
      </g>
    </svg>

    <template v-if="interactive">
      <p :id="helpId" class="sr-only">
        {{ t("seating.plan.help") }}
        <template v-if="mode === 'edit'">
          {{ t("seating.plan.helpEdit") }}
        </template>
        <template v-else-if="mode === 'place'">
          {{ t("seating.plan.helpPlace") }}
        </template>
        <template v-if="singleKeys">
          {{ t("seating.plan.helpZoom") }}
        </template>
      </p>
      <p class="sr-only" aria-live="polite" role="status">
        {{ announcement }}
      </p>

      <div
        class="bg-default/90 border-default absolute end-2 bottom-2 flex items-center gap-0.5 rounded-lg border p-0.5 shadow-sm"
        role="group"
        :aria-label="t('seating.plan.zoomGroup')"
      >
        <UTooltip :text="t('seating.plan.zoomOut')">
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            icon="i-lucide-minus"
            :aria-label="t('seating.plan.zoomOut')"
            @click="viewport.zoomOut()"
          />
        </UTooltip>
        <UTooltip :text="t('seating.plan.zoomIn')">
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            icon="i-lucide-plus"
            :aria-label="t('seating.plan.zoomIn')"
            @click="viewport.zoomIn()"
          />
        </UTooltip>
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          icon="i-lucide-scan"
          :label="t('seating.plan.fit')"
          @click="fit()"
        />
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          :label="t('seating.plan.actualSize')"
          @click="viewport.actualSize()"
        />
      </div>
    </template>

    <!-- HTML laid over the plan (what is being placed, and how). -->
    <slot name="overlay" />
  </div>
</template>

<style scoped>
.floor {
  fill: transparent;
}

.fixture {
  fill: var(--ui-bg-muted);
  stroke: var(--ui-border-accented);
  stroke-dasharray: 6 4;
  stroke-width: 1.5px;
  vector-effect: non-scaling-stroke;
}

.table {
  fill: var(--ui-bg-elevated);
  stroke: var(--ui-border-accented);
  stroke-width: 1.5px;
  vector-effect: non-scaling-stroke;
}

.table-presiding {
  fill: var(--ui-bg-accented);
}

.plan-text {
  fill: var(--ui-text-highlighted);
  font-family: inherit;
  font-feature-settings: "lnum";
}

/* A halo of the floor's colour, so a label reads over a table's edge. */
.plan-label {
  paint-order: stroke;
  stroke: var(--ui-bg);
  stroke-width: 3px;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}

.block-shape {
  stroke-width: 2px;
  vector-effect: non-scaling-stroke;
}

/* Pending registrations among the block's people: dashed, as in «Asistentes». */
.block.is-pending .block-shape {
  stroke-dasharray: 5 3;
}

.block-glow {
  fill: none;
  stroke-width: 5px;
  opacity: 0;
  vector-effect: non-scaling-stroke;
  transition: opacity 120ms ease;
}

.block.is-lit .block-glow {
  opacity: 0.45;
}

.image-back {
  fill: #fff;
}

.is-dimmed {
  opacity: 0.22;
}

.seat {
  cursor: pointer;
  outline: none;
}

.seat.is-movable {
  cursor: move;
}

/* A free seat is what «Colocar» aims at: its outline reaches 3:1 on the
   floor in both themes (the dimmed text colour, 4.7:1 and 6.5:1). */
.seat-empty {
  fill: var(--ui-bg);
  stroke: var(--ui-text-dimmed);
  stroke-width: 1.5px;
  vector-effect: non-scaling-stroke;
}

.seat-empty.is-ghosted {
  opacity: 0.4;
}

.seat-disabled {
  fill: var(--ui-bg-muted);
  stroke: var(--ui-border-accented);
  stroke-dasharray: 3 3;
  stroke-width: 1px;
  vector-effect: non-scaling-stroke;
}

.seat-cross {
  fill: none;
  stroke: var(--ui-text-dimmed);
  stroke-width: 1.5px;
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}

.seat-ring {
  fill: none;
  stroke-width: 2.5px;
  vector-effect: non-scaling-stroke;
}

.seat-ring.is-pending {
  stroke-dasharray: 5 3;
}

.silhouette {
  fill: var(--ui-text-muted);
}

.gone-mark circle {
  fill: var(--ui-bg);
  stroke: var(--ui-error);
  stroke-width: 1.5px;
  vector-effect: non-scaling-stroke;
}

.gone-mark path {
  stroke: var(--ui-error);
  stroke-width: 1.5px;
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}

.seat-hit {
  fill: transparent;
}

.preview-ring {
  stroke-width: 3px;
  vector-effect: non-scaling-stroke;
}

.preview-ring.fits {
  fill: color-mix(in oklab, var(--ui-success) 18%, transparent);
  stroke: var(--ui-success);
}

.preview-ring.does-not-fit {
  fill: color-mix(in oklab, var(--ui-error) 18%, transparent);
  stroke: var(--ui-error);
}

/* Who a placing would move: dashed, so it is told apart without colour. */
.displaced-ring {
  fill: none;
  stroke: var(--ui-warning);
  stroke-width: 3px;
  stroke-dasharray: 5 4;
  vector-effect: non-scaling-stroke;
}

.match-ring {
  fill: none;
  stroke: var(--ui-text-highlighted);
  stroke-width: 2.5px;
  vector-effect: non-scaling-stroke;
}

.selected-ring {
  fill: none;
  stroke: var(--ui-primary);
  stroke-width: 2.5px;
  stroke-dasharray: 6 3;
  vector-effect: non-scaling-stroke;
}

.chair-ghost {
  fill: color-mix(in oklab, var(--ui-primary) 12%, transparent);
  stroke: var(--ui-primary);
  stroke-dasharray: 4 3;
  stroke-width: 2px;
  vector-effect: non-scaling-stroke;
}

.focus-halo {
  fill: none;
  stroke: var(--ui-bg);
  stroke-width: 6px;
  vector-effect: non-scaling-stroke;
}

.focus-ring {
  fill: none;
  stroke: var(--ui-text-highlighted);
  stroke-width: 2.5px;
  vector-effect: non-scaling-stroke;
}

.focus-ring.is-grabbed {
  stroke: var(--ui-primary);
  stroke-dasharray: 4 3;
}
</style>
