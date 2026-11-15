import type { Ref } from "vue";
import type {
  SeatingAssignmentsResultDto,
  SeatingDeleteResultDto,
  SeatingGroupCreateBody,
  SeatingGroupDto,
  SeatingGroupUpdateBody,
  SeatingPersonCreateBody,
  SeatingPersonDto,
  SeatingPersonResultDto,
  SeatingPersonUpdateBody,
  SeatingPlanDto,
} from "~~/shared/types/api";
import type { SeatAssignment } from "~~/shared/utils/seating/groups";
import { assignmentOps } from "~~/shared/utils/seating/proposal";
import { seatingRefusal } from "~/components/seating/-model";
import { useCurrentAssembly } from "../assembly/useCurrentAssembly";

/**
 * The writes of «Colocar» (docs/seating-plan.md, sections 7 and 8): who
 * sits where, through the assignments batch, and the people and groups of
 * the tray. Every write lands in the fetched plan as soon as the server
 * answers; the live event that follows refetches it anyway.
 *
 * - `apply(next)` sends the batch that turns the room as the page has it
 *   into `next` (assignmentOps: each seat with the occupant the page saw).
 *   One batch at a time. When the room changed meanwhile (409
 *   `seating_stale`) the page refetches and says so; nothing is retried.
 * - People and groups go through POST, PATCH (with the row's `updatedAt`)
 *   and DELETE; a stale row refetches and says so too, and hands the open
 *   dialog the row as it is now (`stale`), so its next save is not stale
 *   again. A row that is gone (404 `seating_not_found`) refetches too, and
 *   tells the dialog to close (`gone`).
 */
/** What a dialog does when its row changed or went meanwhile. */
export interface SeatingRowRefusal<T> {
  /** Someone saved it first: the row as it is now. */
  stale?: (current: T) => void;
  /** It is no longer in the room. */
  gone?: () => void;
}

export function useSeatingPlacing(options: {
  plan: Ref<SeatingPlanDto | null | undefined>;
  refresh: () => void;
}) {
  const api = useApi();
  const toast = useToast();
  const { t } = useI18n();
  const { apiBase } = useCurrentAssembly();

  /** A write is on its way: the page waits before the next one. */
  const busy = ref(false);

  function stale(): void {
    toast.add({
      id: "seating-stale",
      title: t("seating.place.stale"),
      color: "warning",
      icon: "i-lucide-refresh-ccw",
    });
    options.refresh();
  }

  function failed(error: unknown, fallbackKey: string): void {
    if (seatingRefusal(error, "seating_stale")) {
      stale();
      return;
    }
    api.notifyError(error, fallbackKey);
    // «Eso ya no está en la sala. Se muestra lo que hay ahora.»: it does.
    if (seatingRefusal(error, "seating_not_found")) options.refresh();
  }

  /**
   * Runs one write at a time; null when it failed or another was running.
   * `refused` hears the refusal before the page says it.
   */
  async function write<T>(
    run: () => Promise<T>,
    fallbackKey: string,
    refused?: (error: unknown) => void,
  ): Promise<T | null> {
    if (busy.value) return null;
    busy.value = true;
    try {
      return await run();
    } catch (error) {
      refused?.(error);
      failed(error, fallbackKey);
      return null;
    } finally {
      busy.value = false;
    }
  }

  /** Tells a dialog its row changed (with the row now) or went. */
  function rowRefusal<T>(
    key: "person" | "group",
    handlers: SeatingRowRefusal<T> | undefined,
  ): ((error: unknown) => void) | undefined {
    if (!handlers) return undefined;
    return (error) => {
      const data = seatingRefusal<Partial<Record<"person" | "group", T>>>(
        error,
        "seating_stale",
      );
      const current = data?.[key];
      if (current) handlers.stale?.(current);
      else if (seatingRefusal(error, "seating_not_found")) handlers.gone?.();
    };
  }

  function patchPlan(change: (plan: SeatingPlanDto) => SeatingPlanDto): void {
    const current = options.plan.value;
    if (current) options.plan.value = change(current);
  }

  function withoutSeats(
    assignments: readonly SeatAssignment[],
    released: readonly SeatAssignment[],
  ): SeatAssignment[] {
    const gone = new Set(released.map((entry) => entry.seatId));
    return assignments.filter((entry) => !gone.has(entry.seatId));
  }

  // Seats ---------------------------------------------------------------------

  /**
   * Turns the room into `next`. True when it is done (or there was nothing
   * to change).
   */
  async function apply(next: readonly SeatAssignment[]): Promise<boolean> {
    const current = options.plan.value;
    if (!current) return false;
    const ops = assignmentOps(current.assignments, next);
    if (ops.length === 0) return true;
    const result = await write(
      () =>
        api.send<SeatingAssignmentsResultDto>(
          `${apiBase.value}/seating/assignments`,
          { method: "POST", body: { ops } },
        ),
      "seating.place.failed",
    );
    if (!result) return false;
    patchPlan((plan) => ({ ...plan, assignments: result.assignments }));
    return true;
  }

  // People --------------------------------------------------------------------

  async function createPerson(
    body: SeatingPersonCreateBody,
  ): Promise<SeatingPersonDto | null> {
    const person = await write(
      () =>
        api.send<SeatingPersonDto>(`${apiBase.value}/seating/people`, {
          method: "POST",
          body,
        }),
      "seating.people.addFailed",
    );
    if (person) {
      patchPlan((plan) => ({ ...plan, people: [...plan.people, person] }));
    }
    return person;
  }

  /** Adds a group made by hand and its first person, one after the other. */
  async function createGroupWithPerson(
    groupBody: SeatingGroupCreateBody,
    personBody: (groupId: string) => SeatingPersonCreateBody,
  ): Promise<SeatingPersonDto | null> {
    const group = await write(
      () =>
        api.send<SeatingGroupDto>(`${apiBase.value}/seating/groups`, {
          method: "POST",
          body: groupBody,
        }),
      "seating.people.groupFailed",
    );
    if (!group) return null;
    patchPlan((plan) => ({ ...plan, groups: [...plan.groups, group] }));
    return createPerson(personBody(group.id));
  }

  async function updatePerson(
    person: SeatingPersonDto,
    changes: Omit<SeatingPersonUpdateBody, "updatedAt">,
    refused?: SeatingRowRefusal<SeatingPersonDto>,
  ): Promise<SeatingPersonResultDto | null> {
    const result = await write(
      () =>
        api.send<SeatingPersonResultDto>(
          `${apiBase.value}/seating/people/${encodeURIComponent(person.id)}`,
          {
            method: "PATCH",
            body: { ...changes, updatedAt: person.updatedAt },
          },
        ),
      "seating.people.saveFailed",
      rowRefusal("person", refused),
    );
    if (result) {
      patchPlan((plan) => ({
        ...plan,
        people: plan.people.map((entry) =>
          entry.id === result.person.id ? result.person : entry,
        ),
        assignments: withoutSeats(plan.assignments, result.released),
      }));
    }
    return result;
  }

  async function deletePerson(
    person: SeatingPersonDto,
    refused?: SeatingRowRefusal<SeatingPersonDto>,
  ): Promise<boolean> {
    const result = await write(
      () =>
        api.send<SeatingDeleteResultDto>(
          `${apiBase.value}/seating/people/${encodeURIComponent(person.id)}`,
          { method: "DELETE" },
        ),
      "seating.people.deleteFailed",
      rowRefusal("person", refused),
    );
    if (!result) return false;
    patchPlan((plan) => ({
      ...plan,
      people: plan.people.filter((entry) => entry.id !== person.id),
      assignments: withoutSeats(plan.assignments, result.released).filter(
        (entry) => entry.personId !== person.id,
      ),
    }));
    return true;
  }

  // Groups --------------------------------------------------------------------

  async function updateGroup(
    group: SeatingGroupDto,
    changes: Omit<SeatingGroupUpdateBody, "updatedAt">,
    refused?: SeatingRowRefusal<SeatingGroupDto>,
  ): Promise<SeatingGroupDto | null> {
    const result = await write(
      () =>
        api.send<SeatingGroupDto>(
          `${apiBase.value}/seating/groups/${encodeURIComponent(group.id)}`,
          { method: "PATCH", body: { ...changes, updatedAt: group.updatedAt } },
        ),
      "seating.groups.saveFailed",
      rowRefusal("group", refused),
    );
    if (result) {
      patchPlan((plan) => ({
        ...plan,
        groups: plan.groups.map((entry) =>
          entry.id === result.id ? result : entry,
        ),
      }));
    }
    return result;
  }

  async function deleteGroup(
    group: SeatingGroupDto,
    refused?: SeatingRowRefusal<SeatingGroupDto>,
  ): Promise<boolean> {
    const result = await write(
      () =>
        api.send<SeatingDeleteResultDto>(
          `${apiBase.value}/seating/groups/${encodeURIComponent(group.id)}`,
          { method: "DELETE" },
        ),
      "seating.groups.deleteFailed",
      rowRefusal("group", refused),
    );
    if (!result) return false;
    patchPlan((plan) => {
      const gone = new Set(
        plan.people
          .filter((entry) => entry.groupId === group.id)
          .map((entry) => entry.id),
      );
      return {
        ...plan,
        groups: plan.groups.filter((entry) => entry.id !== group.id),
        people: plan.people.filter((entry) => !gone.has(entry.id)),
        assignments: withoutSeats(plan.assignments, result.released).filter(
          (entry) => !gone.has(entry.personId),
        ),
      };
    });
    return true;
  }

  return {
    busy: readonly(busy),
    apply,
    createPerson,
    createGroupWithPerson,
    updatePerson,
    deletePerson,
    updateGroup,
    deleteGroup,
  };
}
