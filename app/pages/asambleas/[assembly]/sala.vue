<script setup lang="ts">
import type { DropdownMenuItem, TabsItem } from "@nuxt/ui";
import { viewsSeating } from "~~/shared/utils/permissionRules";
import type {
  AssemblyDto,
  SeatingGroupDto,
  SeatingPersonCreateBody,
  SeatingPersonDto,
  SeatingSourceStaleData,
} from "~~/shared/types/api";
import {
  SEATING_SEAT_DIAMETER,
  type SeatingLayout,
  type SeatingTemplate,
} from "~~/shared/utils/seating/layout";
import {
  hasSeatingRoom,
  seatingCounts,
  seatingLegend,
} from "~~/shared/utils/seating/groups";
import {
  assignmentOps,
  proposeSeating,
} from "~~/shared/utils/seating/proposal";
import { seatingWalk } from "~~/shared/utils/seating/runs";
import { seatingWarnings } from "~~/shared/utils/seating/warnings";
import { SEATING_STALE_REASON } from "~~/shared/constants/errorReasons";
import {
  SEATING_COLOUR_STYLES,
  searchSeating,
  seatViews,
  seatingRefusal,
  type SeatView,
  type SeatingPlanMode,
  type SeatingPlanPreview,
  type SeatingPlanView,
} from "~/components/seating/-model";
import {
  applyPlacement,
  assignSeat,
  placementTarget,
  trayGroups,
  unitAt,
  unseatPeople,
  type PlacementChoice,
  type PlacementResult,
  type PlacementTarget,
  type SeatingPersonDraft,
  type SeatingPick,
} from "~/components/seating/-placing";

/**
 * The room of the assembly («Sala», docs/seating-plan.md, section 7): the
 * layout of the tables and who sits where, for the CEA, the Mesa, the
 * Secretaría and the Presidencia (seating:view or seating:edit). Hidden for
 * an AGET, held online.
 *
 * - The header counts the people, says how the last read of the Intranet's
 *   attendees went («Sincronizar», and once on opening when it is over ten
 *   minutes old, for editors), switches between «Cuentas» and «Asistentes»
 *   and, for editors, between «Ver», «Colocar» and «Editar sala».
 * - A room not laid out yet opens on the template gallery for editors.
 * - The plan is one SVG (SeatingPlan) that takes the height the header
 *   leaves; the page never scrolls besides it on large screens. «Lista»
 *   («Más») shows the same room as text, for screen readers and phones.
 * - «¿Dónde está…?» dims everyone else and centres the match; tapping a seat
 *   opens its details next to it (a drawer on a phone).
 * - «Colocar»: the tray (beside the plan, a drawer on a phone) picks an
 *   account or a person; the seats it would take light up under the pointer
 *   or the focus, green when they fit and red when not, and a tap or Enter
 *   places it. A tap on someone seated picks them to move (the block in
 *   «Cuentas», the person in «Asistentes»); a block of the same size swaps,
 *   anything else asks («Intercambiar», «Desplazar»). Delete or «Quitar»
 *   unseats; the seat's menu does the rest. «Proponer reparto» shows a
 *   proposal as a ghost to apply or discard. Every change is one
 *   assignments batch with the occupants the page saw (useSeatingPlacing),
 *   and the live region says what happened.
 */

const { t } = useI18n();
const toast = useToast();
const route = useRoute();
const router = useRouter();
const api = useApi();
const { can, me } = useMe();
const { assembly } = useCurrentAssembly();
const words = useSeatingWords();

useHead({
  title: () =>
    [t("seating.title"), assembly.value?.label].filter(Boolean).join(" · "),
});

const hasRoom = computed(() =>
  assembly.value ? hasSeatingRoom(assembly.value.type) : true,
);
const allowed = computed(() => hasRoom.value && viewsSeating(can));

const seating = useSeatingPlan({ allowed });
await seating.ready;
const plan = seating.plan;
const canEdit = computed(() => plan.value?.can.edit ?? false);
const meId = computed(() => me.value?.id ?? null);

const editor = useSeatingLayoutEditor({ plan });
const placing = useSeatingPlacing({ plan, refresh: seating.refresh });

// View («Cuentas» | «Asistentes») and «Lista» live in the query -----------------

const VIEW_QUERY = "vista";
const LIST_QUERY = "lista";

function setQuery(key: string, value: string | undefined): void {
  void router.replace({ query: { ...route.query, [key]: value } });
}

const view = computed<SeatingPlanView>({
  get: () => (route.query[VIEW_QUERY] === "asistentes" ? "people" : "accounts"),
  set: (value) =>
    setQuery(VIEW_QUERY, value === "people" ? "asistentes" : undefined),
});
const viewItems = computed<TabsItem[]>(() => [
  {
    value: "accounts",
    label: t("seating.view.accounts"),
    icon: "i-lucide-building-2",
  },
  { value: "people", label: t("seating.view.people"), icon: "i-lucide-users" },
]);

const listWanted = computed({
  get: () => route.query[LIST_QUERY] === "1",
  set: (value: boolean) => setQuery(LIST_QUERY, value ? "1" : undefined),
});

const { confirmLeaving } = useLeaveGuard(
  () => editor.dirty.value,
  () => t("seating.edit.leaveQuestion"),
);

const modeState = ref<SeatingPlanMode>("view");
/** Redraws the mode tabs when leaving «Editar sala» is called off. */
const modeTabsKey = ref(0);
const mode = computed<SeatingPlanMode>({
  get: () => (canEdit.value ? modeState.value : "view"),
  set: (value) => {
    if (value === modeState.value) return;
    if (modeState.value === "edit") {
      if (!confirmLeaving()) {
        modeTabsKey.value += 1;
        return;
      }
      editor.stop();
    }
    if (value === "edit") editor.start();
    modeState.value = value;
    selectedSeatId.value = null;
    detailsOpen.value = false;
    menuOpen.value = false;
    pick.value = null;
    proposalOpen.value = false;
    confirm.value = null;
  },
});
const modeItems = computed<TabsItem[]>(() => [
  { value: "view", label: t("seating.mode.view"), icon: "i-lucide-eye" },
  { value: "place", label: t("seating.mode.place"), icon: "i-lucide-hand" },
  {
    value: "edit",
    label: t("seating.mode.edit"),
    icon: "i-lucide-pencil-ruler",
  },
]);

const placingMode = computed(() => mode.value === "place");
/** «Lista» shows the room as text; never while editing it. */
const listShown = computed(() => listWanted.value && mode.value !== "edit");

// The room: the draft while editing, the saved one otherwise ------------------

const layout = computed<SeatingLayout | null>(() =>
  mode.value === "edit" && editor.draft.value
    ? editor.draft.value
    : (plan.value?.layout ?? null),
);
const walk = computed(() => (layout.value ? seatingWalk(layout.value) : null));

// «Proponer reparto»: worked out again whenever the room changes, so what
// is applied is always a proposal over the room as it is now.
const proposalOpen = ref(false);
const redoAll = ref(false);
const proposal = computed(() => {
  const current = plan.value;
  if (
    !proposalOpen.value ||
    !placingMode.value ||
    !current?.layout ||
    !assembly.value
  ) {
    return null;
  }
  return proposeSeating({
    layout: current.layout,
    groups: current.groups,
    people: current.people,
    assignments: current.assignments,
    assemblyType: assembly.value.type,
    mode: redoAll.value ? "redoAll" : "fillEmpty",
  });
});
const proposalChanges = computed(() =>
  proposal.value && plan.value
    ? assignmentOps(plan.value.assignments, proposal.value.assignments).length
    : 0,
);

const seats = computed<SeatView[]>(() => {
  const current = plan.value;
  if (!layout.value || !walk.value || !current) return [];
  return seatViews(
    layout.value,
    walk.value,
    proposal.value
      ? { ...current, assignments: proposal.value.assignments }
      : current,
  );
});
const seatById = computed(
  () => new Map(seats.value.map((seat) => [seat.id, seat])),
);

const counts = computed(() =>
  plan.value
    ? seatingCounts(
        plan.value.groups,
        plan.value.people,
        plan.value.assignments,
      )
    : null,
);
const legend = computed(() =>
  plan.value
    ? seatingLegend(
        plan.value.groups,
        plan.value.people,
        plan.value.assignments,
      )
    : [],
);
const tray = computed(() => (plan.value ? trayGroups(plan.value) : []));
const warnings = computed(() =>
  plan.value?.layout
    ? seatingWarnings({
        layout: plan.value.layout,
        groups: plan.value.groups,
        people: plan.value.people,
        assignments: plan.value.assignments,
      })
    : [],
);

const planView = useTemplateRef<{
  fit: () => void;
  show: (seatIds: readonly string[]) => void;
  focusSeat: (id: string) => void;
  seatElement: (id: string) => SVGGElement | null;
  middleOfView: () => { x: number; y: number };
}>("planView");

const focusedSeatId = ref<string | null>(null);
/** Editar sala: the seat or chair being edited. */
const selectedSeatId = ref<string | null>(null);
const announcement = ref("");

function announce(text: string): void {
  // The same words twice in a row are read again only if the region changes.
  announcement.value = "";
  void nextTick(() => {
    announcement.value = text;
  });
}

function seatAriaLabel(seat: SeatView): string {
  if (!walk.value) return "";
  const label = words.seatAriaLabel(walk.value, seat);
  // While placing, the seat with the focus also says how the pick lands
  // there («Solo caben 2 de 3»), as the overlay shows it.
  if (pick.value && seat.id === focusedSeatId.value && plan.value) {
    const where = placementTarget(
      walk.value,
      plan.value,
      pick.value,
      seat.id,
      view.value,
    );
    return `${label}. ${statusOf(pick.value, where)}`;
  }
  return label;
}

// «¿Dónde está…?» --------------------------------------------------------------------

const query = ref("");
const matchIndex = ref(-1);
const search = computed(() =>
  plan.value
    ? searchSeating(query.value, seats.value, plan.value)
    : { seatIds: [], unseated: 0 },
);
const searching = computed(() => query.value.trim().length > 0);

function announceSearch(): void {
  if (!searching.value) {
    announcement.value = "";
    return;
  }
  const found = search.value.seatIds.length;
  const parts = [
    found > 0
      ? t("seating.search.found", { count: found }, found)
      : t("seating.search.none"),
  ];
  if (search.value.unseated > 0) {
    parts.push(
      t(
        "seating.search.unseated",
        { count: search.value.unseated },
        search.value.unseated,
      ),
    );
  }
  announcement.value = parts.join(" · ");
}

const showMatches = useDebounceFn(() => {
  matchIndex.value = -1;
  announceSearch();
  if (search.value.seatIds.length > 0)
    planView.value?.show(search.value.seatIds);
}, 250);
watch(query, () => void showMatches());

/** Enter or the arrows of the search: one match after another. */
function stepMatch(step: 1 | -1): void {
  const ids = search.value.seatIds;
  if (ids.length === 0) return;
  matchIndex.value =
    matchIndex.value < 0
      ? step === 1
        ? 0
        : ids.length - 1
      : (matchIndex.value + step + ids.length) % ids.length;
  const id = ids[matchIndex.value]!;
  focusedSeatId.value = id;
  planView.value?.show([id]);
  const seat = seatById.value.get(id);
  if (seat) announcement.value = seatAriaLabel(seat);
}

function clearSearch(): void {
  query.value = "";
  matchIndex.value = -1;
}

/** Seats pointed out from the tray or the warnings, for a few seconds. */
const pointed = ref<string[]>([]);
let pointedTimer: ReturnType<typeof setTimeout> | null = null;

async function showSeats(seatIds: readonly string[]): Promise<void> {
  if (seatIds.length === 0) return;
  trayOpen.value = false;
  // From «Lista», the plan comes back first (the plan shows them once it
  // has a size, instead of fitting the room).
  if (listWanted.value) {
    await router.replace({
      query: { ...route.query, [LIST_QUERY]: undefined },
    });
  }
  pointed.value = [...seatIds];
  if (pointedTimer) clearTimeout(pointedTimer);
  pointedTimer = setTimeout(() => {
    pointed.value = [];
  }, 4000);
  await nextTick();
  planView.value?.show(seatIds);
}
onBeforeUnmount(() => {
  if (pointedTimer) clearTimeout(pointedTimer);
});

const highlightedSeatIds = computed(() =>
  searching.value ? search.value.seatIds : pointed.value,
);

// Seat details -------------------------------------------------------------------------

const mounted = ref(false);
onMounted(() => {
  mounted.value = true;
});
const wide = useMediaQuery("(min-width: 640px)");
/** The popover on large screens, the drawer on phones, only once mounted. */
const usePopover = computed(() => mounted.value && wide.value);

const detailsOpen = ref(false);
const detailsSeatId = ref<string | null>(null);
const detailsAnchor = shallowRef<Element | null>(null);
const detailsSeat = computed(() =>
  detailsSeatId.value
    ? (seatById.value.get(detailsSeatId.value) ?? null)
    : null,
);

// The seat went away (a live change, a new layout): its details close.
watch(detailsSeat, (seat) => {
  if (!seat) detailsOpen.value = false;
});

/** A popover anchored to a seat has no trigger to give the focus back to. */
function refocusSeat(seatId: string | null): void {
  if (!seatId || !import.meta.client) return;
  const active = document.activeElement;
  if (!active || active === document.body) {
    planView.value?.seatElement(seatId)?.focus({ preventScroll: true });
  }
}

watch(detailsOpen, (open) => {
  if (!open) refocusSeat(detailsSeatId.value);
});

function openDetails(seatId: string, element: Element): void {
  menuOpen.value = false;
  detailsSeatId.value = seatId;
  detailsAnchor.value = element;
  detailsOpen.value = true;
}

// Colocar: what is being placed ------------------------------------------------------------

const pick = shallowRef<SeatingPick | null>(null);
const hoverSeatId = ref<string | null>(null);
const trayOpen = ref(false);

// People who left the plan (a live change) leave the pick; nobody left, no pick.
watch(plan, (current) => {
  const active = pick.value;
  if (!active || !current) return;
  const known = new Set(current.people.map((person) => person.id));
  const kept = active.personIds.filter((id) => known.has(id));
  if (kept.length === active.personIds.length) return;
  pick.value = kept.length ? { ...active, personIds: kept } : null;
});

// A question about a placing names who it would move: when the room
// changes under it so that the answer would move someone else, it closes.
watch(plan, (current) => {
  const asked = confirm.value;
  if (!asked) return;
  const room = walk.value;
  const again =
    current && room
      ? placementTarget(room, current, asked.pick, asked.seatId, view.value)
      : null;
  const same =
    again !== null &&
    again.fits === asked.target.fits &&
    again.seatIds.join() === asked.target.seatIds.join() &&
    again.displaced.join() === asked.target.displaced.join();
  if (!same) confirm.value = null;
});

function pickText(value: SeatingPick): string {
  return plan.value ? words.pickText(value, plan.value) : "";
}

/** The seats of the people being moved, marked on the plan. */
const pickSeatIds = computed(() => {
  const active = pick.value;
  if (!active || !plan.value) return [];
  const picked = new Set(active.personIds);
  return plan.value.assignments
    .filter((entry) => picked.has(entry.personId))
    .map((entry) => entry.seatId);
});

/** Where a keyboard pick starts: its own seat, else the first free one off the Mesa. */
function firstFreeSeat(): string | null {
  const free = seats.value.filter((seat) => !seat.disabled && !seat.occupant);
  const offMesa = free.find(
    (seat) => walk.value?.seats.get(seat.id)?.zone !== "presiding",
  );
  return pickSeatIds.value[0] ?? offMesa?.id ?? free[0]?.id ?? null;
}

function startPick(next: SeatingPick, keyboard: boolean): void {
  pick.value = next;
  detailsOpen.value = false;
  menuOpen.value = false;
  trayOpen.value = false;
  // In «Lista» the plan is not on screen: each seat of the list offers
  // «Colocar aquí» instead.
  announce(
    t(listShown.value ? "seating.place.pickedList" : "seating.place.picked", {
      who: pickText(next),
    }),
  );
  if (keyboard && !listShown.value) {
    const seatId = firstFreeSeat();
    if (seatId) void nextTick(() => planView.value?.focusSeat(seatId));
  }
}

function cancelPick(): void {
  if (!pick.value) return;
  pick.value = null;
  announce(t("seating.place.cancelled"));
}

// «Esc para cancelar» from anywhere on the page (the tray, a button), not
// only from the plan, which says it itself; never from a dialog, a menu or
// a field, which Escape closes or clears.
useEventListener(
  import.meta.client ? document : undefined,
  "keydown",
  (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || !pick.value) {
      return;
    }
    const target = event.target as Element | null;
    if (
      target?.closest?.(
        '[role="dialog"], [role="menu"], [role="application"], input, textarea, select',
      )
    ) {
      return;
    }
    cancelPick();
  },
);

/** Where the pick would land: the seat under the pointer, else the focused one. */
const target = computed<PlacementTarget | null>(() => {
  const seatId = hoverSeatId.value ?? focusedSeatId.value;
  if (!placingMode.value || !pick.value || !walk.value || !plan.value) {
    return null;
  }
  if (!seatId) return null;
  return placementTarget(
    walk.value,
    plan.value,
    pick.value,
    seatId,
    view.value,
  );
});

const preview = computed<SeatingPlanPreview | null>(() => {
  const value = target.value;
  if (!value || !plan.value) return null;
  const displaced = new Set(value.displaced);
  return {
    seatIds: value.seatIds,
    fits: value.fits,
    displacedSeatIds: plan.value.assignments
      .filter((entry) => displaced.has(entry.personId))
      .map((entry) => entry.seatId),
  };
});

/** «UMA (2) y Ana Pérez, UGR»: who a placing would move. */
function peopleText(personIds: readonly string[]): string {
  const current = plan.value;
  if (!current) return "";
  const groupOf = new Map(current.people.map((p) => [p.id, p.groupId]));
  const byGroup = new Map<string, string[]>();
  for (const id of personIds) {
    const groupId = groupOf.get(id) ?? "";
    byGroup.set(groupId, [...(byGroup.get(groupId) ?? []), id]);
  }
  return words.listText(
    [...byGroup].map(([groupId, ids]) =>
      words.pickText({ groupId, personIds: ids, swap: false }, current),
    ),
  );
}

/** How a pick would land on a seat, in words: never by colour alone. */
function statusOf(active: SeatingPick, value: PlacementTarget | null): string {
  if (!value) return t("seating.place.chooseSeat");
  if (value.swap) {
    return t("seating.place.previewSwap", {
      who: peopleText(value.displaced),
    });
  }
  if (value.displaced.length > 0) {
    return t("seating.place.previewOccupied", {
      who: peopleText(value.displaced),
    });
  }
  if (!value.fits) {
    return t("seating.place.previewShort", {
      fit: value.seatIds.length,
      count: active.personIds.length,
    });
  }
  return t("seating.place.previewFits");
}

const pickStatus = computed(() =>
  pick.value ? statusOf(pick.value, target.value) : "",
);

/** What the live region says once a placing is done. */
function announceResult(
  value: SeatingPick,
  result: PlacementResult,
  verb: "placed" | "unseated",
): void {
  const room = walk.value;
  if (!room) return;
  const parts: string[] = [];
  if (verb === "unseated") {
    parts.push(t("seating.announce.unseated", { who: pickText(value) }));
  } else {
    parts.push(
      t("seating.announce.placed", {
        who: pickText(value),
        seats: words.seatsText(
          room,
          result.placed.map((entry) => entry.seatId),
        ),
      }),
    );
    const left = value.personIds.length - result.placed.length;
    if (left > 0) {
      parts.push(t("seating.announce.notPlaced", { count: left }, left));
    }
    if (result.moved.length > 0) {
      parts.push(
        t("seating.announce.moved", {
          who: peopleText(result.moved.map((entry) => entry.personId)),
          seats: words.seatsText(
            room,
            result.moved.map((entry) => entry.seatId),
          ),
        }),
      );
    }
  }
  const unseated = result.unseated.filter(
    (id) => !value.personIds.includes(id),
  );
  if (unseated.length > 0) {
    parts.push(
      t("seating.announce.othersUnseated", { who: peopleText(unseated) }),
    );
  }
  announce(parts.join(" "));
}

/** Sends a placing; true when it is done. */
async function commit(
  value: SeatingPick,
  where: PlacementTarget,
  choice: PlacementChoice,
): Promise<boolean> {
  const current = plan.value;
  const room = walk.value;
  if (!current || !room) return false;
  const result = applyPlacement(
    room,
    current.assignments,
    value,
    where,
    choice,
  );
  const done = await placing.apply(result.assignments);
  // Refused or not, the question was about the room as it was.
  confirm.value = null;
  if (!done) return false;
  pick.value = null;
  announceResult(value, result, "placed");
  return true;
}

/** A pick landing on a seat: at once, or after asking. */
function land(seatId: string): void {
  const active = pick.value;
  const current = plan.value;
  const room = walk.value;
  if (!active || !current || !room) return;
  const where = placementTarget(room, current, active, seatId, view.value);
  if (!where || where.seatIds.length === 0) return;
  if (where.swap || (where.fits && where.displaced.length === 0)) {
    void commit(active, where, "displace");
    return;
  }
  // «Intercambiar con…» asked for it already.
  if (active.swap && where.fits) {
    void commit(active, where, "swap");
    return;
  }
  confirm.value = { pick: active, target: where, seatId };
}

// The question when a placing does not simply fit ----------------------------------------

const confirm = shallowRef<{
  pick: SeatingPick;
  target: PlacementTarget;
  /** The seat it was dropped on. */
  seatId: string;
} | null>(null);
const confirmOpen = computed({
  get: () => confirm.value !== null,
  set: (open) => {
    if (!open) confirm.value = null;
  },
});
/** «Intercambiar» needs seats to give back: only when moving people seated. */
const confirmCanSwap = computed(() => {
  const value = confirm.value;
  if (!value || !plan.value) return false;
  const picked = new Set(value.pick.personIds);
  return plan.value.assignments.some((entry) => picked.has(entry.personId));
});
const confirmSeats = computed(() =>
  confirm.value && walk.value
    ? words.seatsText(walk.value, confirm.value.target.seatIds)
    : "",
);

// Seats: activation, Delete, the menu --------------------------------------------------------

function onSeatActivate(seatId: string, element: Element): void {
  if (mode.value === "edit") {
    // Escape or a tap on the floor lets it go.
    selectedSeatId.value = seatId;
    return;
  }
  if (placingMode.value && !proposal.value && plan.value && walk.value) {
    if (pick.value) {
      land(seatId);
      return;
    }
    const unit = unitAt(walk.value, plan.value, seatId, view.value);
    if (unit) {
      startPick(unit, false);
      return;
    }
  }
  openDetails(seatId, element);
}

async function unseat(value: SeatingPick): Promise<void> {
  const current = plan.value;
  const room = walk.value;
  if (!current || !room) return;
  const result = unseatPeople(room, current.assignments, value.personIds);
  if (await placing.apply(result.assignments)) {
    if (
      pick.value &&
      pick.value.personIds.some((id) => value.personIds.includes(id))
    ) {
      pick.value = null;
    }
    announceResult(value, result, "unseated");
  }
}

function onDelete(seatId: string): void {
  if (mode.value === "edit") {
    if (layout.value?.chairs.some((chair) => chair.id === seatId)) {
      onRemoveChair(seatId);
    }
    return;
  }
  if (!placingMode.value || proposal.value || !plan.value || !walk.value) {
    return;
  }
  const unit = unitAt(walk.value, plan.value, seatId, view.value);
  if (unit) void unseat(unit);
}

const menuOpen = ref(false);
const menuSeatId = ref<string | null>(null);
const menuAnchor = shallowRef<Element | null>(null);
const menuSeat = computed(() =>
  menuSeatId.value ? (seatById.value.get(menuSeatId.value) ?? null) : null,
);

watch(menuSeat, (seat) => {
  if (!seat) menuOpen.value = false;
});
watch(menuOpen, (open) => {
  if (!open) refocusSeat(menuSeatId.value);
});

/** Only editors placing get the seat menu: the others keep the browser's. */
const seatMenuOn = computed(
  () => canEdit.value && placingMode.value && !proposal.value,
);

function onSeatMenu(seatId: string, element: Element): void {
  detailsOpen.value = false;
  menuSeatId.value = seatId;
  menuAnchor.value = element;
  menuOpen.value = true;
}

const menuTitle = computed(() =>
  menuSeat.value ? seatAriaLabel(menuSeat.value) : "",
);
const menuItems = computed(() => {
  const seat = menuSeat.value;
  if (!seat) return [];
  const items: {
    key: string;
    label: string;
    icon: string;
    danger?: boolean;
  }[] = [];
  if (seat.occupant) {
    items.push(
      { key: "move", label: t("seating.menu.move"), icon: "i-lucide-move" },
      {
        key: "swap",
        label: t("seating.menu.swap"),
        icon: "i-lucide-arrow-left-right",
      },
      {
        key: "unseat",
        label: t("seating.menu.unseat"),
        icon: "i-lucide-log-out",
      },
      {
        key: "noSeat",
        label: t("seating.menu.noSeat"),
        icon: "i-lucide-armchair",
      },
    );
  } else if (pick.value && !seat.disabled) {
    items.push({
      key: "here",
      label: t("seating.menu.placeHere", { who: pickText(pick.value) }),
      icon: "i-lucide-arrow-down-to-dot",
    });
  }
  items.push({
    key: "details",
    label: t("seating.menu.details"),
    icon: "i-lucide-info",
  });
  return items;
});

function onMenuSelect(key: string): void {
  const seat = menuSeat.value;
  const element = menuAnchor.value;
  menuOpen.value = false;
  if (!seat || !plan.value || !walk.value) return;
  const unit = unitAt(walk.value, plan.value, seat.id, view.value);
  // The menu goes away with the focus in it: the seat takes it back.
  if (key !== "details") {
    planView.value?.seatElement(seat.id)?.focus({ preventScroll: true });
  }
  switch (key) {
    case "move":
      if (unit) startPick(unit, false);
      return;
    case "swap":
      if (unit) startPick({ ...unit, swap: true }, false);
      return;
    case "unseat":
      if (unit) void unseat(unit);
      return;
    case "noSeat":
      if (seat.occupant) void setNeedsSeat(seat.occupant.person, false);
      return;
    case "here":
      land(seat.id);
      return;
    default:
      if (element) openDetails(seat.id, element);
  }
}

function onCancel(): void {
  if (confirm.value) confirm.value = null;
  else if (menuOpen.value) menuOpen.value = false;
  else if (detailsOpen.value) detailsOpen.value = false;
  else if (pick.value) cancelPick();
  else if (proposalOpen.value) discardProposal();
  else if (selectedSeatId.value) selectedSeatId.value = null;
  else if (searching.value) clearSearch();
}

function onFloorTap(): void {
  detailsOpen.value = false;
  menuOpen.value = false;
  if (mode.value === "edit") selectedSeatId.value = null;
}

const selectedSeatIds = computed(() => {
  if (mode.value === "edit") {
    return selectedSeatId.value ? [selectedSeatId.value] : [];
  }
  if (pick.value) return pickSeatIds.value;
  return detailsOpen.value && detailsSeatId.value ? [detailsSeatId.value] : [];
});

// «Proponer reparto» ------------------------------------------------------------------------

function openProposal(): void {
  pick.value = null;
  confirm.value = null;
  trayOpen.value = false;
  redoAll.value = false;
  proposalOpen.value = true;
  announce(t("seating.proposal.opened"));
}

function discardProposal(): void {
  proposalOpen.value = false;
  announce(t("seating.proposal.discarded"));
}

async function applyProposal(): Promise<void> {
  const value = proposal.value;
  if (!value) return;
  const placed = value.placed.length;
  if (await placing.apply(value.assignments)) {
    proposalOpen.value = false;
    toast.add({
      title: t("seating.proposal.applied", { count: placed }, placed),
      color: "success",
      icon: "i-lucide-check",
    });
  }
}

/** The proposal's new seats, drawn as a ghost over the plan. */
const ghosts = computed(() => {
  const value = proposal.value;
  if (!value) return [];
  return value.placed.flatMap((entry) => {
    const seat = seatById.value.get(entry.seatId);
    if (!seat) return [];
    return [
      {
        id: seat.id,
        x: seat.x,
        y: seat.y,
        ring: SEATING_COLOUR_STYLES[seat.occupant?.colour ?? "neutral"].ring,
      },
    ];
  });
});
const GHOST_RADIUS = SEATING_SEAT_DIAMETER / 2 + 5;

// «Lista»: «Asignar…» -----------------------------------------------------------------------

const assignSeatId = ref<string | null>(null);
const assignOpen = computed({
  get: () => assignSeatId.value !== null,
  set: (open) => {
    if (!open) assignSeatId.value = null;
  },
});
const assignCurrent = computed(() =>
  assignSeatId.value
    ? (plan.value?.assignments.find(
        (entry) => entry.seatId === assignSeatId.value,
      )?.personId ?? null)
    : null,
);

async function onAssign(personId: string | null): Promise<void> {
  const seatId = assignSeatId.value;
  const current = plan.value;
  const room = walk.value;
  assignSeatId.value = null;
  if (!seatId || !current || !room) return;
  const result = assignSeat(room, current.assignments, seatId, personId);
  if (!(await placing.apply(result.assignments))) return;
  const groupOf = new Map(current.people.map((p) => [p.id, p.groupId]));
  if (personId) {
    announceResult(
      {
        groupId: groupOf.get(personId) ?? "",
        personIds: [personId],
        swap: false,
      },
      result,
      "placed",
    );
  } else if (result.unseated.length) {
    announceResult(
      {
        groupId: groupOf.get(result.unseated[0]!) ?? "",
        personIds: result.unseated,
        swap: false,
      },
      result,
      "unseated",
    );
  }
}

// The tray: people and groups ----------------------------------------------------------------

const personModalOpen = ref(false);
const personEditing = shallowRef<SeatingPersonDto | null>(null);
const personGroupId = ref<string | null>(null);
const orderedGroups = computed(() => tray.value.map((entry) => entry.group));

function onAddPerson(groupId: string | null): void {
  personEditing.value = null;
  personGroupId.value = groupId;
  personModalOpen.value = true;
}

function onEditPerson(person: SeatingPersonDto): void {
  personEditing.value = person;
  personModalOpen.value = true;
}

async function onPersonAdd(draft: SeatingPersonDraft): Promise<void> {
  const body = (groupId: string): SeatingPersonCreateBody => ({
    source: "manual",
    groupId,
    firstName: draft.firstName,
    surname: draft.surname,
    label: draft.label,
    needsSeat: draft.needsSeat,
    ...(draft.linkMe && meId.value ? { userId: meId.value } : {}),
  });
  const group = draft.group;
  const person =
    "id" in group
      ? await placing.createPerson(body(group.id))
      : await placing.createGroupWithPerson(
          { acronym: group.acronym, name: group.name, kind: group.kind },
          body,
        );
  if (!person) return;
  personModalOpen.value = false;
  toast.add({
    title: t("seating.people.added", { name: words.personLabel(person) }),
    color: "success",
    icon: "i-lucide-user-plus",
  });
}

async function onPersonEdit(
  changes: Parameters<typeof placing.updatePerson>[1],
): Promise<void> {
  const person = personEditing.value;
  if (!person) return;
  if (Object.keys(changes).length === 0) {
    personModalOpen.value = false;
    return;
  }
  const saved = await placing.updatePerson(person, changes, {
    // Someone saved it first: the dialog keeps what was typed, now over
    // the row as it is, so the next «Guardar» is not refused again.
    stale: (current) => {
      if (personEditing.value?.id === current.id) personEditing.value = current;
    },
    gone: () => {
      personModalOpen.value = false;
    },
  });
  if (saved) {
    personModalOpen.value = false;
    toast.add({
      title: t("seating.people.saved"),
      color: "success",
      icon: "i-lucide-check",
    });
  }
}

async function onAddPlaceholder(group: SeatingGroupDto): Promise<void> {
  const person = await placing.createPerson({
    source: "placeholder",
    groupId: group.id,
  });
  if (person) {
    toast.add({
      title: t("seating.people.placeholderAdded", { acronym: group.acronym }),
      color: "success",
      icon: "i-lucide-user-round-plus",
    });
  }
}

async function setNeedsSeat(
  person: SeatingPersonDto,
  value: boolean,
): Promise<void> {
  const result = await placing.updatePerson(person, { needsSeat: value });
  if (!result) return;
  const name = words.personLabel(person);
  announce(
    value
      ? t("seating.people.needsSeatAgain", { name })
      : result.released.length > 0
        ? t("seating.people.noSeatReleased", { name })
        : t("seating.people.noSeatDone", { name }),
  );
}

function onUnseatPeople(personIds: string[]): void {
  const current = plan.value;
  if (!current || personIds.length === 0) return;
  const groupId =
    current.people.find((person) => person.id === personIds[0])?.groupId ?? "";
  void unseat({ groupId, personIds, swap: false });
}

const groupModalOpen = ref(false);
const groupEditing = shallowRef<SeatingGroupDto | null>(null);

function onEditGroup(group: SeatingGroupDto): void {
  groupEditing.value = group;
  groupModalOpen.value = true;
}

async function onGroupSave(
  changes: Parameters<typeof placing.updateGroup>[1],
): Promise<void> {
  const group = groupEditing.value;
  if (!group) return;
  if (Object.keys(changes).length === 0) {
    groupModalOpen.value = false;
    return;
  }
  const saved = await placing.updateGroup(group, changes, {
    stale: (current) => {
      if (groupEditing.value?.id === current.id) groupEditing.value = current;
    },
    gone: () => {
      groupModalOpen.value = false;
    },
  });
  if (saved) {
    groupModalOpen.value = false;
    toast.add({
      title: t("seating.groups.saved"),
      color: "success",
      icon: "i-lucide-check",
    });
  }
}

/** A person or a group made by hand, until the deletion is confirmed. */
const removal = shallowRef<
  | { kind: "person"; person: SeatingPersonDto }
  | { kind: "group"; group: SeatingGroupDto; people: number }
  | null
>(null);
const removalOpen = computed({
  get: () => removal.value !== null,
  set: (open) => {
    if (!open) removal.value = null;
  },
});

function onDeleteGroup(group: SeatingGroupDto): void {
  removal.value = {
    kind: "group",
    group,
    people: (plan.value?.people ?? []).filter(
      (person) => person.groupId === group.id,
    ).length,
  };
}

async function confirmRemoval(): Promise<void> {
  const value = removal.value;
  if (!value) return;
  // Already gone: the question closes, and the room shows as it is.
  const refused = {
    gone: () => {
      removal.value = null;
    },
  };
  const done =
    value.kind === "person"
      ? await placing.deletePerson(value.person, refused)
      : await placing.deleteGroup(value.group, refused);
  if (!done) return;
  removal.value = null;
  toast.add({
    title:
      value.kind === "person"
        ? t("seating.people.deleted")
        : t("seating.groups.deleted"),
    color: "success",
    icon: "i-lucide-trash-2",
  });
}

// Editar sala ----------------------------------------------------------------------------

function fitSoon(): void {
  void nextTick(() => planView.value?.fit());
}

function onRegenerate(template: SeatingTemplate): void {
  editor.regenerate(template);
  selectedSeatId.value = null;
  fitSoon();
}

function onAddChair(): void {
  const near = planView.value?.middleOfView() ?? { x: 0, y: 0 };
  const id = editor.addChair(near);
  if (!id) return;
  selectedSeatId.value = id;
  announcement.value = t("seating.edit.chairAdded");
  void nextTick(() => planView.value?.focusSeat(id));
}

function onRemoveChair(id: string): void {
  editor.removeChair(id);
  if (selectedSeatId.value === id) selectedSeatId.value = null;
  announcement.value = t("seating.edit.chairRemoved");
}

function onChairMove(id: string, point: { x: number; y: number }): void {
  if (mode.value !== "edit") return;
  editor.moveChair(id, point);
  selectedSeatId.value = id;
}

function savedToast(released: number): void {
  toast.add({
    title: t("seating.edit.saved"),
    description:
      released > 0
        ? t("seating.edit.released", { count: released }, released)
        : undefined,
    color: "success",
    icon: "i-lucide-check",
  });
}

async function onSave(releaseSeats = false): Promise<void> {
  const { outcome, released } = await editor.save(releaseSeats);
  if (outcome === "saved") savedToast(released);
  else if (outcome === "occupied" && releaseSeats) {
    // Someone was seated there after the list was shown: it shows again.
    toast.add({
      id: "seating-occupied-changed",
      title: t("seating.edit.occupiedChanged"),
      color: "warning",
      icon: "i-lucide-refresh-ccw",
    });
  }
}

/** The people a save would send back to the tray, named. */
const occupiedPeople = computed(() => {
  const list = editor.occupied.value ?? [];
  const people = new Map((plan.value?.people ?? []).map((p) => [p.id, p]));
  const groups = new Map((plan.value?.groups ?? []).map((g) => [g.id, g]));
  return list.map((entry) => {
    const person = people.get(entry.personId);
    const group = person ? groups.get(person.groupId) : undefined;
    return {
      seatId: entry.seatId,
      text: person
        ? [group?.acronym, words.personLabel(person)].filter(Boolean).join(", ")
        : t("seating.person.unnamed"),
    };
  });
});
const occupiedOpen = computed({
  get: () => (editor.occupied.value?.length ?? 0) > 0,
  set: (open) => {
    if (!open) editor.cancelRelease();
  },
});

// First time: the gallery -------------------------------------------------------------------

async function onCreate(created: SeatingLayout): Promise<void> {
  const { outcome } = await editor.save(false, created);
  if (outcome === "saved") {
    savedToast(0);
  } else if (outcome === "stale") {
    toast.add({
      title: t("seating.gallery.taken"),
      color: "warning",
      icon: "i-lucide-refresh-ccw",
    });
    seating.refresh();
  }
}

// The Intranet ---------------------------------------------------------------------------------

async function onSync(): Promise<void> {
  const { result, error } = await seating.sync();
  if (error) {
    api.notifyError(error, "seating.sync.failedToast");
    return;
  }
  if (!result) return;
  if (!result.called) {
    toast.add({
      title: t("seating.sync.throttled"),
      color: "neutral",
      icon: "i-lucide-clock",
    });
    return;
  }
  switch (result.plan.sync.status) {
    case "ok":
      toast.add({
        title: t("seating.sync.done"),
        color: "success",
        icon: "i-lucide-check",
      });
      return;
    case "failed":
      toast.add({
        title: t("seating.sync.failedToast"),
        color: "warning",
        icon: "i-lucide-cloud-alert",
      });
      return;
    case "unavailable":
      // The line says nothing about it: only whoever pressed is told.
      toast.add({
        title: t("seating.sync.unavailable"),
        color: "neutral",
        icon: "i-lucide-cloud",
      });
      return;
    default:
      // not_found is said by the line itself.
      return;
  }
}

const sourceOpen = ref(false);
const sourceSaving = ref(false);

async function chooseSource(sourceAssemblyId: string | null): Promise<void> {
  if (sourceSaving.value) return;
  sourceSaving.value = true;
  try {
    await seating.setSource(sourceAssemblyId);
    sourceOpen.value = false;
    toast.add({
      title: t("seating.source.saved"),
      color: "success",
      icon: "i-lucide-check",
    });
  } catch (error) {
    if (seatingRefusal<SeatingSourceStaleData>(error, SEATING_STALE_REASON)) {
      sourceOpen.value = false;
      seating.refresh();
    }
    api.notifyError(error, "seating.source.failed");
  } finally {
    sourceSaving.value = false;
  }
}

/** The label of the assembly the attendees are read from, when not its own. */
const sourceId = computed(() => plan.value?.sourceAssemblyId ?? null);
const sourceFetch = useAsyncData<string | null>(
  computed(() => `seating-source-${sourceId.value ?? "none"}`),
  async () => {
    if (!sourceId.value) return null;
    try {
      const source = await api.get<AssemblyDto>(
        `/api/assemblies/${encodeURIComponent(sourceId.value)}`,
      );
      return source.label;
    } catch {
      return null;
    }
  },
  { server: false, lazy: true, default: () => null },
);
const sourceLabel = computed(() =>
  sourceId.value ? (sourceFetch.data.value ?? t("seating.source.other")) : null,
);

// «Más» --------------------------------------------------------------------------------------------

interface MoreItem {
  label: string;
  icon: string;
  run: () => void;
}

const moreList = computed<MoreItem[]>(() => {
  const items: MoreItem[] = [];
  if (plan.value?.layout && mode.value !== "edit") {
    items.push(
      listWanted.value
        ? {
            label: t("seating.list.showPlan"),
            icon: "i-lucide-map",
            run: () => {
              listWanted.value = false;
            },
          }
        : {
            label: t("seating.list.show"),
            icon: "i-lucide-list",
            run: () => {
              listWanted.value = true;
            },
          },
    );
  }
  if (canEdit.value) {
    items.push({
      label: t("seating.source.readOther"),
      icon: "i-lucide-users",
      run: () => {
        sourceOpen.value = true;
      },
    });
    if (sourceId.value) {
      items.push({
        label: t("seating.source.readOwn"),
        icon: "i-lucide-undo-2",
        run: () => void chooseSource(null),
      });
    }
  }
  return items;
});
const moreItems = computed<DropdownMenuItem[]>(() =>
  moreList.value.map((item) => ({
    label: item.label,
    icon: item.icon,
    onSelect: () => item.run(),
  })),
);

// Loading ---------------------------------------------------------------------------------------------

const loading = computed(() => seating.pending.value && !plan.value);
const failed = computed(() => Boolean(seating.error.value) && !plan.value);
</script>

<template>
  <div v-if="assembly" class="flex flex-col gap-3 lg:min-h-0 lg:flex-1">
    <!-- On large screens this root fills the hub body, so the plan takes the
         height the header leaves and the page never scrolls besides it. On
         a phone the plan keeps a height of its own and the page scrolls. -->
    <CommonEmptyState
      v-if="!hasRoom"
      icon="i-lucide-monitor"
      :title="t('seating.onlineTitle')"
      :description="t('seating.onlineDescription')"
      variant="outline"
    />

    <CommonEmptyState
      v-else-if="!allowed"
      icon="i-lucide-shield-x"
      :title="t('seating.forbiddenTitle')"
      :description="t('seating.forbiddenDescription')"
      variant="outline"
    />

    <div v-else-if="loading" class="space-y-3" role="status">
      <span class="sr-only">{{ t("seating.loading") }}</span>
      <USkeleton aria-hidden="true" class="h-10 w-72 max-w-full" />
      <USkeleton aria-hidden="true" class="h-96 w-full" />
    </div>

    <UAlert
      v-else-if="failed || !plan"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :title="t('seating.loadError')"
      :actions="[
        {
          label: t('seating.retry'),
          color: 'error',
          variant: 'outline',
          onClick: () => seating.refresh(),
        },
      ]"
      role="alert"
    />

    <template v-else>
      <!-- Header: the action sits beside the title only, so the counts and
           the sync line keep the full width and do not wrap beside it
           (E-113). On a phone a long single action drops below the title
           instead of squeezing it. -->
      <div class="space-y-1">
        <div
          class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 sm:flex-nowrap"
        >
          <h2 class="text-highlighted min-w-0 text-xl font-semibold">
            {{ t("seating.title") }}
          </h2>
          <UButton
            v-if="moreList.length === 1"
            color="neutral"
            variant="outline"
            :icon="moreList[0]!.icon"
            :label="moreList[0]!.label"
            class="shrink-0"
            @click="moreList[0]!.run()"
          />
          <UDropdownMenu
            v-else-if="moreList.length > 1"
            :items="moreItems"
            :content="{ align: 'end' }"
          >
            <UButton
              color="neutral"
              variant="outline"
              icon="i-lucide-ellipsis"
              :label="t('seating.more')"
              class="shrink-0"
            />
          </UDropdownMenu>
        </div>
        <p
          v-if="counts && counts.people + counts.notNeeded + counts.gone > 0"
          class="text-default text-sm tabular-nums"
        >
          {{ words.countsText(counts) }}
        </p>
        <SeatingSyncLine
          :sync="plan.sync"
          :syncing="seating.syncing.value"
          :can-edit="canEdit"
          :source-label="sourceLabel"
          @sync="onSync"
          @read-other="sourceOpen = true"
        />
      </div>

      <!-- First time: the gallery for editors, a calm note for readers -->
      <template v-if="!plan.layout">
        <SeatingTemplateGallery
          v-if="canEdit"
          :saving="editor.saving.value"
          @create="onCreate"
        />
        <CommonEmptyState
          v-else
          icon="i-lucide-armchair"
          :title="t('seating.notReadyTitle')"
          :description="t('seating.notReadyDescription')"
          variant="outline"
        />
      </template>

      <template v-else>
        <!-- View, mode and search -->
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
          <UTabs
            v-model="view"
            :items="viewItems"
            :content="false"
            size="sm"
            :aria-label="t('seating.view.label')"
          />
          <UTabs
            v-if="canEdit"
            :key="modeTabsKey"
            v-model="mode"
            :items="modeItems"
            :content="false"
            size="sm"
            variant="link"
            :aria-label="t('seating.mode.label')"
          />
          <div class="flex min-w-0 flex-1 items-center gap-1 sm:justify-end">
            <UInput
              v-model="query"
              icon="i-lucide-search"
              :placeholder="t('seating.search.placeholder')"
              :aria-label="t('seating.search.label')"
              class="w-full sm:w-64"
              @keydown.enter.prevent="stepMatch($event.shiftKey ? -1 : 1)"
              @keydown.esc="clearSearch"
            >
              <template v-if="searching" #trailing>
                <span class="text-muted text-xs tabular-nums">
                  {{
                    search.seatIds.length === 0
                      ? t("seating.search.none")
                      : matchIndex >= 0
                        ? t("seating.search.position", {
                            index: matchIndex + 1,
                            count: search.seatIds.length,
                          })
                        : t(
                            "seating.search.found",
                            { count: search.seatIds.length },
                            search.seatIds.length,
                          )
                  }}
                </span>
                <UButton
                  color="neutral"
                  variant="link"
                  size="xs"
                  icon="i-lucide-x"
                  :aria-label="t('seating.search.clear')"
                  @click="clearSearch"
                />
              </template>
            </UInput>
          </div>
        </div>

        <SeatingLegend :entries="legend" />

        <!-- Colocar on a phone: the tray opens in a drawer -->
        <div
          v-if="placingMode && !proposal"
          class="flex flex-wrap items-center gap-2 lg:hidden"
        >
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-users"
            :label="
              t(
                'seating.tray.open',
                { count: counts?.unseated ?? 0 },
                counts?.unseated ?? 0,
              )
            "
            @click="trayOpen = true"
          />
        </div>

        <!-- The tray, the plan (or «Lista») and the side panel of «Editar sala» -->
        <div class="flex flex-col gap-3 lg:min-h-0 lg:flex-1 lg:flex-row">
          <template v-if="placingMode && walk">
            <SeatingProposalPanel
              v-if="proposal"
              v-model:redo-all="redoAll"
              class="lg:w-80 lg:shrink-0"
              :proposal="proposal"
              :plan="plan"
              :changes="proposalChanges"
              :busy="placing.busy.value"
              @apply="applyProposal"
              @discard="discardProposal"
              @show="showSeats"
            />
            <div
              v-else
              class="hidden lg:flex lg:min-h-0 lg:w-80 lg:shrink-0 lg:flex-col"
            >
              <SeatingTray
                class="lg:flex-1"
                :groups="tray"
                :walk="walk"
                :view="view"
                :pick="pick"
                :busy="placing.busy.value"
                :me-id="meId"
                @pick="startPick"
                @add-person="onAddPerson"
                @add-placeholder="onAddPlaceholder"
                @edit-person="onEditPerson"
                @delete-person="removal = { kind: 'person', person: $event }"
                @needs-seat="setNeedsSeat"
                @edit-group="onEditGroup"
                @delete-group="onDeleteGroup"
                @unseat="onUnseatPeople"
                @show="showSeats"
                @propose="openProposal"
              >
                <template #top>
                  <SeatingWarnings
                    :warnings="warnings"
                    :plan="plan"
                    :walk="walk"
                    @show="showSeats"
                  />
                </template>
              </SeatingTray>
            </div>
          </template>

          <SeatingListView
            v-if="listShown && walk"
            :walk="walk"
            :seats="seats"
            :groups="tray"
            :can-assign="canEdit && placingMode && !proposal"
            :busy="placing.busy.value"
            :picking="pick ? pickText(pick) : null"
            @assign="assignSeatId = $event"
            @place="land"
            @cancel="cancelPick"
          />

          <div
            v-else
            class="border-default bg-muted/30 relative min-h-[24rem] flex-1 overflow-hidden rounded-lg border lg:min-h-80"
          >
            <ClientOnly>
              <SeatingPlan
                v-if="layout && walk"
                ref="planView"
                v-model:focused-seat-id="focusedSeatId"
                :layout="layout"
                :walk="walk"
                :seats="seats"
                :label="t('seating.plan.label')"
                :seat-label="seatAriaLabel"
                :view="view"
                :mode="mode"
                :highlighted-seat-ids="highlightedSeatIds"
                :selected-seat-ids="selectedSeatIds"
                :preview="preview"
                @seat-activate="onSeatActivate"
                @seat-hover="hoverSeatId = $event"
                v-on="seatMenuOn ? { seatMenu: onSeatMenu } : {}"
                @chair-move="onChairMove"
                @delete="onDelete"
                @cancel="onCancel"
                @floor-tap="onFloorTap"
                @view-change="
                  detailsOpen = false;
                  menuOpen = false;
                "
              >
                <!-- The proposal's new seats, as a ghost -->
                <g
                  v-if="ghosts.length"
                  class="pointer-events-none"
                  aria-hidden="true"
                >
                  <circle
                    v-for="ghost in ghosts"
                    :key="`ghost-${ghost.id}`"
                    class="proposal-ghost"
                    :cx="ghost.x"
                    :cy="ghost.y"
                    :r="GHOST_RADIUS"
                    :style="{ stroke: ghost.ring }"
                  />
                </g>

                <template #overlay>
                  <div
                    v-if="pick"
                    class="bg-default/95 border-default absolute inset-x-2 top-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-sm shadow-sm sm:inset-x-auto sm:start-2 sm:max-w-lg"
                  >
                    <UIcon
                      name="i-lucide-hand"
                      class="text-primary size-4 shrink-0"
                      aria-hidden="true"
                    />
                    <span class="text-default min-w-0 flex-1 break-words">
                      <span class="text-highlighted font-medium">
                        {{
                          t("seating.place.picking", { who: pickText(pick) })
                        }}
                      </span>
                      · {{ pickStatus }} ·
                      <span class="text-muted">{{
                        t("seating.place.escHint")
                      }}</span>
                    </span>
                    <UButton
                      color="neutral"
                      variant="outline"
                      size="xs"
                      :label="t('common.cancel')"
                      @click="cancelPick"
                    />
                  </div>
                  <div
                    v-else-if="proposal"
                    class="bg-default/95 border-default text-default absolute inset-x-2 top-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm shadow-sm sm:inset-x-auto sm:start-2 sm:max-w-md"
                  >
                    <UIcon
                      name="i-lucide-wand-sparkles"
                      class="text-primary size-4 shrink-0"
                      aria-hidden="true"
                    />
                    <span>{{ t("seating.proposal.ghostNote") }}</span>
                  </div>
                </template>
              </SeatingPlan>
              <template #fallback>
                <USkeleton aria-hidden="true" class="absolute inset-0" />
              </template>
            </ClientOnly>
            <p
              v-if="seats.length === 0"
              class="text-muted pointer-events-none absolute inset-x-0 top-6 px-6 text-center text-sm"
            >
              {{
                mode === "edit"
                  ? t("seating.plan.emptyEdit")
                  : t("seating.plan.empty")
              }}
            </p>
          </div>

          <SeatingEditPanel
            v-if="mode === 'edit' && editor.draft.value && walk"
            class="lg:w-80 lg:shrink-0"
            :draft="editor.draft.value"
            :walk="walk"
            :selected-seat-id="selectedSeatId"
            :dirty="editor.dirty.value"
            :saving="editor.saving.value"
            :saved-elsewhere="editor.savedElsewhere.value"
            :conflict="editor.conflict.value"
            :can-regenerate="editor.canRegenerate.value"
            @regenerate="onRegenerate"
            @add-chair="onAddChair"
            @remove-chair="onRemoveChair"
            @toggle-seat="editor.toggleSeat"
            @save="onSave()"
            @discard="editor.discard()"
            @load-theirs="editor.loadTheirs()"
            @keep-mine="editor.keepMine()"
          />
        </div>
      </template>

      <p class="sr-only" aria-live="polite" role="status">
        {{ announcement }}
      </p>

      <!-- The tray on a phone -->
      <UDrawer
        v-if="placingMode && walk"
        v-model:open="trayOpen"
        :title="t('seating.tray.title')"
        class="lg:hidden"
      >
        <template #body>
          <SeatingTray
            :groups="tray"
            :walk="walk"
            :view="view"
            :pick="pick"
            :busy="placing.busy.value"
            :me-id="meId"
            @pick="startPick"
            @add-person="onAddPerson"
            @add-placeholder="onAddPlaceholder"
            @edit-person="onEditPerson"
            @delete-person="removal = { kind: 'person', person: $event }"
            @needs-seat="setNeedsSeat"
            @edit-group="onEditGroup"
            @delete-group="onDeleteGroup"
            @unseat="onUnseatPeople"
            @show="showSeats"
            @propose="openProposal"
          >
            <template #top>
              <SeatingWarnings
                :warnings="warnings"
                :plan="plan"
                :walk="walk"
                @show="showSeats"
              />
            </template>
          </SeatingTray>
        </template>
      </UDrawer>

      <!-- A seat's details: next to it, or a drawer on a phone -->
      <UPopover
        v-if="usePopover"
        v-model:open="detailsOpen"
        :reference="detailsAnchor ?? undefined"
        :content="{ side: 'top', sideOffset: 10, collisionPadding: 12 }"
      >
        <template #content>
          <div class="p-3">
            <SeatingSeatDetails
              v-if="detailsSeat && walk"
              :seat="detailsSeat"
              :walk="walk"
            />
          </div>
        </template>
      </UPopover>
      <UDrawer
        v-else
        v-model:open="detailsOpen"
        :title="t('seating.details.title')"
      >
        <template #body>
          <SeatingSeatDetails
            v-if="detailsSeat && walk"
            :seat="detailsSeat"
            :walk="walk"
          />
        </template>
      </UDrawer>

      <!-- A seat's menu in «Colocar»: next to it, or a drawer on a phone -->
      <UPopover
        v-if="usePopover"
        v-model:open="menuOpen"
        :reference="menuAnchor ?? undefined"
        :content="{
          side: 'right',
          align: 'start',
          sideOffset: 8,
          collisionPadding: 12,
        }"
      >
        <template #content>
          <SeatingSeatMenu
            v-if="menuSeat"
            :title="menuTitle"
            :items="menuItems"
            @select="onMenuSelect"
          />
        </template>
      </UPopover>
      <UDrawer v-else v-model:open="menuOpen" :title="t('seating.menu.title')">
        <template #body>
          <SeatingSeatMenu
            v-if="menuSeat"
            :title="menuTitle"
            :items="menuItems"
            @select="onMenuSelect"
          />
        </template>
      </UDrawer>

      <!-- A placing that does not simply fit -->
      <UModal
        v-model:open="confirmOpen"
        :title="
          confirm && confirm.target.displaced.length > 0
            ? t('seating.place.occupiedTitle')
            : t('seating.place.shortTitle')
        "
        :dismissible="!placing.busy.value"
      >
        <template #body>
          <div v-if="confirm" class="text-default space-y-3 text-sm">
            <p>
              {{
                t("seating.place.confirmWhat", {
                  who: pickText(confirm.pick),
                  seats: confirmSeats,
                })
              }}
            </p>
            <p v-if="!confirm.target.fits">
              {{
                t("seating.place.shortDescription", {
                  fit: confirm.target.seatIds.length,
                  count: confirm.pick.personIds.length,
                })
              }}
            </p>
            <template v-if="confirm.target.displaced.length > 0">
              <p>
                {{
                  t("seating.place.occupiedDescription", {
                    who: peopleText(confirm.target.displaced),
                  })
                }}
              </p>
              <dl class="space-y-2">
                <div v-if="confirmCanSwap">
                  <dt class="text-highlighted font-medium">
                    {{ t("seating.place.swap") }}
                  </dt>
                  <dd class="text-muted">{{ t("seating.place.swapHint") }}</dd>
                </div>
                <div>
                  <dt class="text-highlighted font-medium">
                    {{ t("seating.place.displace") }}
                  </dt>
                  <dd class="text-muted">
                    {{ t("seating.place.displaceHint") }}
                  </dd>
                </div>
              </dl>
            </template>
          </div>
        </template>
        <template #footer>
          <div v-if="confirm" class="flex w-full flex-wrap justify-end gap-2">
            <UButton
              color="neutral"
              variant="outline"
              :label="t('common.cancel')"
              :disabled="placing.busy.value"
              @click="confirm = null"
            />
            <template v-if="confirm.target.displaced.length > 0">
              <UButton
                color="neutral"
                variant="outline"
                icon="i-lucide-log-out"
                :label="t('seating.place.displace')"
                :loading="placing.busy.value"
                @click="commit(confirm.pick, confirm.target, 'displace')"
              />
              <UButton
                v-if="confirmCanSwap"
                icon="i-lucide-arrow-left-right"
                :label="t('seating.place.swap')"
                :loading="placing.busy.value"
                @click="commit(confirm.pick, confirm.target, 'swap')"
              />
            </template>
            <UButton
              v-else
              icon="i-lucide-armchair"
              :label="
                t(
                  'seating.place.placeFitting',
                  { count: confirm.target.seatIds.length },
                  confirm.target.seatIds.length,
                )
              "
              :loading="placing.busy.value"
              @click="commit(confirm.pick, confirm.target, 'displace')"
            />
          </div>
        </template>
      </UModal>

      <!-- A save that would take seats from people -->
      <UModal
        v-model:open="occupiedOpen"
        :title="t('seating.edit.occupiedTitle')"
        :description="
          t(
            'seating.edit.occupiedDescription',
            { count: occupiedPeople.length },
            occupiedPeople.length,
          )
        "
        :dismissible="!editor.saving.value"
      >
        <template #body>
          <ul class="text-default max-h-64 space-y-1 overflow-y-auto text-sm">
            <li v-for="entry in occupiedPeople" :key="entry.seatId">
              {{ entry.text }}
            </li>
          </ul>
        </template>
        <template #footer>
          <div class="flex w-full flex-wrap justify-end gap-2">
            <UButton
              color="neutral"
              variant="outline"
              :label="t('common.cancel')"
              :disabled="editor.saving.value"
              @click="occupiedOpen = false"
            />
            <UButton
              color="warning"
              icon="i-lucide-save"
              :label="t('seating.edit.occupiedConfirm')"
              :loading="editor.saving.value"
              @click="onSave(true)"
            />
          </div>
        </template>
      </UModal>

      <template v-if="canEdit && walk">
        <SeatingAssignModal
          v-model:open="assignOpen"
          :seat-title="assignSeatId ? words.seatName(walk, assignSeatId) : ''"
          :current-person-id="assignCurrent"
          :groups="tray"
          :walk="walk"
          @choose="onAssign"
        />
        <SeatingPersonModal
          v-model:open="personModalOpen"
          :person="personEditing"
          :groups="orderedGroups"
          :group-id="personGroupId"
          :me-id="meId"
          :saving="placing.busy.value"
          @add="onPersonAdd"
          @edit="onPersonEdit"
        />
        <SeatingGroupModal
          v-model:open="groupModalOpen"
          :group="groupEditing"
          :saving="placing.busy.value"
          @save="onGroupSave"
        />
      </template>

      <!-- Deleting a person or a group made by hand -->
      <UModal
        v-model:open="removalOpen"
        :title="
          removal?.kind === 'group'
            ? t('seating.groups.deleteTitle', {
                acronym: removal.group.acronym,
              })
            : removal?.kind === 'person'
              ? t('seating.people.deleteTitle', {
                  name: words.personLabel(removal.person),
                })
              : ''
        "
        :description="
          removal?.kind === 'group'
            ? t(
                'seating.groups.deleteDescription',
                { count: removal.people },
                removal.people,
              )
            : t('seating.people.deleteDescription')
        "
        :dismissible="!placing.busy.value"
      >
        <template #footer>
          <div class="flex w-full flex-wrap justify-end gap-2">
            <UButton
              color="neutral"
              variant="outline"
              :label="t('common.cancel')"
              :disabled="placing.busy.value"
              @click="removal = null"
            />
            <UButton
              color="error"
              icon="i-lucide-trash-2"
              :label="t('common.delete')"
              :loading="placing.busy.value"
              @click="confirmRemoval"
            />
          </div>
        </template>
      </UModal>

      <SeatingSourceModal
        v-if="canEdit"
        v-model:open="sourceOpen"
        :assembly-id="assembly.id"
        :source-assembly-id="plan.sourceAssemblyId"
        :saving="sourceSaving"
        @choose="chooseSource"
      />
    </template>
  </div>
</template>

<style scoped>
/* «Proponer reparto»: the seats the proposal fills, as a dashed ghost ring
   of the account's colour, so it reads without colour too. */
.proposal-ghost {
  fill: none;
  stroke-width: 2.5px;
  stroke-dasharray: 4 4;
  vector-effect: non-scaling-stroke;
}
</style>
