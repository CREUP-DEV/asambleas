import type { Ref } from "vue";
import type {
  SeatingAssignmentDto,
  SeatingLayoutResultDto,
  SeatingLayoutStaleData,
  SeatingPlanDto,
  SeatingSeatsOccupiedData,
} from "~~/shared/types/api";
import {
  defaultSeatingIdFactory,
  type SeatingLayout,
  type SeatingTemplate,
} from "~~/shared/utils/seating/layout";
import { canGenerateTemplate } from "~~/shared/utils/seating/templates";
import {
  SEATING_SEATS_OCCUPIED_REASON,
  SEATING_STALE_REASON,
} from "~~/shared/constants/errorReasons";
import {
  freeChairSpot,
  regenerateKeepingIds,
  sameLayout,
  sameToken,
  seatingRefusal,
} from "~/components/seating/-model";
import { useCurrentAssembly } from "../assembly/useCurrentAssembly";

/**
 * «Editar sala» (docs/seating-plan.md, section 7; phase 4): a draft of the
 * room kept apart from the fetched plan, so a live refetch never overwrites
 * what is being edited, saved with «Guardar sala» under the layout's lock.
 *
 * - The Doble U's numbers regenerate the draft keeping every seat id the
 *   saved room has (regenerateKeepingIds).
 * - Loose chairs are added at a free spot, moved and removed; table seats
 *   are disabled and enabled.
 * - A save that removes occupied seats comes back 409
 *   `seating_seats_occupied`: `occupied` lists them until the editor
 *   confirms (`save(true)` sends `releaseSeats`) or cancels.
 * - A save over a room someone else saved comes back 409 `seating_stale`:
 *   `conflict` holds their room until the editor loads it or keeps theirs
 *   as the new base, so the next save overwrites it knowingly.
 */

export type SeatingSaveOutcome =
  "saved" | "unchanged" | "occupied" | "stale" | "failed";

export function useSeatingLayoutEditor(options: {
  plan: Ref<SeatingPlanDto | null | undefined>;
}) {
  const api = useApi();
  const { apiBase } = useCurrentAssembly();

  /** What is being edited; null while not editing. */
  const draft = shallowRef<SeatingLayout | null>(null);
  /** The saved room the draft started from (or the one kept on a conflict). */
  const base = shallowRef<SeatingLayout | null>(null);
  /** The lock token sent with the save. */
  const baseToken = ref<string | null>(null);
  const saving = ref(false);
  /** People who would lose their seat, until the editor decides. */
  const occupied = shallowRef<SeatingAssignmentDto[] | null>(null);
  /** The room someone else saved first, until the editor decides. */
  const conflict = shallowRef<SeatingLayoutStaleData | null>(null);

  const editing = computed(() => draft.value !== null);
  const dirty = computed(
    () => draft.value !== null && !sameLayout(draft.value, base.value),
  );
  /** Someone saved the room since this draft started (a quiet notice). */
  const savedElsewhere = computed(() => {
    const plan = options.plan.value;
    return (
      editing.value &&
      !conflict.value &&
      plan !== null &&
      plan !== undefined &&
      !sameToken(plan.layoutUpdatedAt, baseToken.value)
    );
  });
  const canRegenerate = computed(() =>
    draft.value ? canGenerateTemplate(draft.value.template) : false,
  );

  function start(): void {
    const plan = options.plan.value;
    if (!plan?.layout) return;
    draft.value = plan.layout;
    base.value = plan.layout;
    baseToken.value = plan.layoutUpdatedAt;
    occupied.value = null;
    conflict.value = null;
  }

  function stop(): void {
    draft.value = null;
    base.value = null;
    baseToken.value = null;
    occupied.value = null;
    conflict.value = null;
  }

  /** Throws away the draft's changes. */
  function discard(): void {
    draft.value = base.value;
    occupied.value = null;
  }

  // Changes -----------------------------------------------------------------------

  /** New numbers or another template, keeping the saved room's seat ids. */
  function regenerate(template: SeatingTemplate): void {
    const current = draft.value;
    if (!current || !canGenerateTemplate(template)) return;
    draft.value = regenerateKeepingIds(
      current,
      options.plan.value?.layout ?? base.value,
      template,
    );
  }

  /** «Añadir silla suelta», at the free spot nearest to `near`. Its id. */
  function addChair(near: { x: number; y: number }): string | null {
    const current = draft.value;
    if (!current) return null;
    const spot = freeChairSpot(current, near);
    const id = defaultSeatingIdFactory();
    draft.value = {
      ...current,
      chairs: [...current.chairs, { id, x: spot.x, y: spot.y, rotation: 0 }],
    };
    return id;
  }

  function moveChair(id: string, point: { x: number; y: number }): void {
    const current = draft.value;
    if (!current) return;
    draft.value = {
      ...current,
      chairs: current.chairs.map((chair) =>
        chair.id === id ? { ...chair, x: point.x, y: point.y } : chair,
      ),
    };
  }

  function removeChair(id: string): void {
    const current = draft.value;
    if (!current) return;
    draft.value = {
      ...current,
      chairs: current.chairs.filter((chair) => chair.id !== id),
    };
  }

  /** Disables a table's seat (a pillar, an aisle), or enables it again. */
  function toggleSeat(seatId: string): void {
    const current = draft.value;
    if (!current) return;
    draft.value = {
      ...current,
      tables: current.tables.map((table) =>
        table.seats.some((seat) => seat.id === seatId)
          ? {
              ...table,
              seats: table.seats.map((seat) => {
                if (seat.id !== seatId) return seat;
                if (seat.disabled) {
                  const { disabled: _disabled, ...enabled } = seat;
                  return enabled;
                }
                return { ...seat, disabled: true };
              }),
            }
          : table,
      ),
    };
  }

  // Saving --------------------------------------------------------------------------

  function applySaved(result: SeatingLayoutResultDto): void {
    const plan = options.plan.value;
    if (plan) {
      const released = new Set(result.released.map((entry) => entry.seatId));
      options.plan.value = {
        ...plan,
        layout: result.layout,
        layoutUpdatedAt: result.layoutUpdatedAt,
        template: result.layout.template,
        assignments: plan.assignments.filter(
          (entry) => !released.has(entry.seatId),
        ),
      };
    }
  }

  /**
   * Saves `layout` (the draft by default) under the lock. With
   * `releaseSeats`, the people the last 409 `seating_seats_occupied` named
   * (`occupied`) go back to the tray: the confirmation names them, seat and
   * person, so anyone seated there since is refused again, with the new
   * list in `occupied`.
   */
  async function save(
    releaseSeats = false,
    layout: SeatingLayout | null = draft.value,
  ): Promise<{ outcome: SeatingSaveOutcome; released: number }> {
    if (!layout || saving.value) return { outcome: "failed", released: 0 };
    if (
      draft.value &&
      layout === draft.value &&
      !dirty.value &&
      !releaseSeats
    ) {
      return { outcome: "unchanged", released: 0 };
    }
    saving.value = true;
    try {
      const result = await api.send<SeatingLayoutResultDto>(
        `${apiBase.value}/seating/layout`,
        {
          method: "PUT",
          body: {
            layout,
            updatedAt: editing.value
              ? baseToken.value
              : (options.plan.value?.layoutUpdatedAt ?? null),
            ...(releaseSeats ? { releaseSeats: occupied.value ?? [] } : {}),
          },
        },
      );
      applySaved(result);
      if (editing.value) {
        draft.value = result.layout;
        base.value = result.layout;
        baseToken.value = result.layoutUpdatedAt;
      }
      occupied.value = null;
      conflict.value = null;
      return { outcome: "saved", released: result.released.length };
    } catch (error) {
      const seats = seatingRefusal<SeatingSeatsOccupiedData>(
        error,
        SEATING_SEATS_OCCUPIED_REASON,
      );
      if (seats) {
        occupied.value = seats.seats;
        return { outcome: "occupied", released: 0 };
      }
      const stale = seatingRefusal<SeatingLayoutStaleData>(
        error,
        SEATING_STALE_REASON,
      );
      if (stale) {
        conflict.value = {
          layout: stale.layout,
          layoutUpdatedAt: stale.layoutUpdatedAt,
        };
        occupied.value = null;
        return { outcome: "stale", released: 0 };
      }
      api.notifyError(error, "seating.edit.saveFailed");
      return { outcome: "failed", released: 0 };
    } finally {
      saving.value = false;
    }
  }

  /** «Cargar la sala guardada»: their room replaces the draft. */
  function loadTheirs(): void {
    const theirs = conflict.value ?? {
      layout: options.plan.value?.layout ?? null,
      layoutUpdatedAt: options.plan.value?.layoutUpdatedAt ?? null,
    };
    conflict.value = null;
    occupied.value = null;
    if (!theirs.layout) {
      stop();
      return;
    }
    draft.value = theirs.layout;
    base.value = theirs.layout;
    baseToken.value = theirs.layoutUpdatedAt;
  }

  /**
   * «Seguir con la mía»: the draft stays, on top of their room, so the
   * next save replaces it knowingly instead of failing again.
   */
  function keepMine(): void {
    const theirs = conflict.value ?? {
      layout: options.plan.value?.layout ?? null,
      layoutUpdatedAt: options.plan.value?.layoutUpdatedAt ?? null,
    };
    conflict.value = null;
    base.value = theirs.layout;
    baseToken.value = theirs.layoutUpdatedAt;
  }

  function cancelRelease(): void {
    occupied.value = null;
  }

  return {
    draft: computed(() => draft.value),
    editing,
    dirty,
    saving: readonly(saving),
    occupied: computed(() => occupied.value),
    conflict: computed(() => conflict.value),
    savedElsewhere,
    canRegenerate,
    start,
    stop,
    discard,
    regenerate,
    addChair,
    moveChair,
    removeChair,
    toggleSeat,
    save,
    loadTheirs,
    keepMine,
    cancelRelease,
  };
}
