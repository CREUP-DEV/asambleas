import type { MaybeRefOrGetter } from "vue";
import type {
  LiveEventDto,
  SpeakersDto,
  SpeakingTurnBody,
  SpeakingTurnDto,
  SpeakingTurnUpdateBody,
} from "~~/shared/types/api";
import { useApi } from "../api/useApi";
import { keepLastGoodData } from "../fetch/lastGoodData";
import {
  isSessionSpeakersEvent,
  sessionSpeakers,
  sessionTurnMoveIndex,
  sessionTurnWho,
} from "./sessionModel";

export interface SessionSpeakersOptions {
  /** The assembly's API base, e.g. `/api/assemblies/{id}`. */
  baseUrl: MaybeRefOrGetter<string>;
  /** Fetch key of the assembly (its route param). */
  key: MaybeRefOrGetter<string>;
  /** Only the Mesa writes turns down; nothing is fetched for anyone else. */
  enabled: MaybeRefOrGetter<boolean>;
  /** The console's in-flight tracker (busy keys). */
  track: <T>(key: string, run: () => Promise<T>) => Promise<T>;
}

type TurnChange = Omit<SpeakingTurnUpdateBody, "updatedAt">;

interface SendOptions {
  /** The caller tells the Mesa what went wrong; no toast from here. */
  quiet?: boolean;
}

/**
 * Speaking turns the Mesa writes down during the session: who asked for the
 * floor, who has it and who already spoke. Every change returns the whole
 * list, which replaces the one on screen; a conflict (another Mesa member
 * changed the same turn) reloads it. Live events from other devices reload
 * it too. A failed background reload keeps the list on screen and says so
 * quietly, without a toast per event.
 *
 * Busy keys: `speaker-add` while a turn is being added, `speaker-{id}`
 * while one turn changes and `speaker-{id}-return` while a turn given the
 * floor by mistake goes back to the list. The server answers every change with the whole
 * list (`SpeakersDto`); `position` is the 0-based place among the waiting
 * turns, and it records `speakers` live events.
 */
export function useSessionSpeakers(options: SessionSpeakersOptions) {
  const api = useApi();
  const toast = useToast();
  const { t } = useI18n();

  const url = computed(() => `${toValue(options.baseUrl)}/speakers`);

  const speakersFetch = useAsyncData(
    () => `session-speakers-${toValue(options.key)}`,
    () =>
      toValue(options.enabled)
        ? api.get<SpeakersDto>(url.value)
        : Promise.resolve(null),
    { server: false, watch: [() => toValue(options.enabled)] },
  );
  const { data, failed } = keepLastGoodData(speakersFetch, {
    resetOn: () => toValue(options.key),
  });

  const turns = computed<SpeakingTurnDto[]>(() => data.value?.turns ?? []);
  /** Each member's turns in the whole assembly (the Mesa only). */
  const history = computed(
    () =>
      new Map(
        (data.value?.history ?? []).map((entry) => [entry.memberId, entry]),
      ),
  );
  const view = computed(() => sessionSpeakers(turns.value));
  const byId = computed(
    () => new Map(turns.value.map((turn) => [turn.id, turn])),
  );
  const loading = computed(
    () =>
      !data.value &&
      (speakersFetch.status.value === "pending" ||
        speakersFetch.status.value === "idle"),
  );
  /** Nothing could be loaded at all (the panel offers to retry). */
  const unavailable = computed(
    () => !data.value && speakersFetch.status.value === "error",
  );

  function refresh(): Promise<void> {
    return speakersFetch.refresh();
  }

  function store(result: SpeakersDto | SpeakingTurnDto | null): void {
    if (result && Array.isArray((result as SpeakersDto).turns)) {
      data.value = result as SpeakersDto;
    } else {
      void refresh();
    }
  }

  /** Writes a turn down at the end of the queue. */
  async function add(
    body: SpeakingTurnBody,
    send: SendOptions = {},
  ): Promise<boolean> {
    try {
      const result = await options.track("speaker-add", () =>
        api.send<SpeakersDto | SpeakingTurnDto>(url.value, { body }),
      );
      store(result);
      return true;
    } catch (error) {
      if (!send.quiet) api.notifyError(error, "session.speakers.errors.add");
      return false;
    }
  }

  /**
   * Sends one change of a turn. A conflict means another Mesa device changed
   * the list first (two people pressed "Siguiente" at once): nothing went
   * wrong, so the list is reloaded and a calm notice says so.
   */
  async function update(
    turn: SpeakingTurnDto,
    change: TurnChange,
    send: SendOptions = {},
  ): Promise<boolean> {
    const fresh = byId.value.get(turn.id) ?? turn;
    const body: SpeakingTurnUpdateBody = {
      ...change,
      updatedAt: fresh.updatedAt,
    };
    try {
      const result = await options.track(`speaker-${turn.id}`, () =>
        api.send<SpeakersDto>(`${url.value}/${encodeURIComponent(turn.id)}`, {
          method: "PUT",
          body,
        }),
      );
      store(result);
      return true;
    } catch (error) {
      if (api.isConflict(error)) void refresh();
      if (send.quiet) return false;
      if (api.isConflict(error)) {
        toast.add({
          id: "session-speakers-changed",
          title: t("session.speakers.changedElsewhere"),
          color: "info",
          icon: "i-lucide-refresh-ccw",
        });
      } else {
        api.notifyError(error, "session.speakers.errors.update");
      }
      return false;
    }
  }

  /** Gives the floor to a turn; whoever was speaking is done. */
  function giveFloor(turn: SpeakingTurnDto): Promise<boolean> {
    return update(turn, { status: "speaking" });
  }

  function finish(turn: SpeakingTurnDto): Promise<boolean> {
    return update(turn, { status: "done" });
  }

  /** Fixes the person's name of a turn; blank clears it. */
  function rename(turn: SpeakingTurnDto, speaker: string): Promise<boolean> {
    return update(turn, { speaker: speaker.trim() || null });
  }

  /**
   * Writes a turn down again at `place` of the waiting list: the same
   * member, person and agenda item, as a new turn. True once it is back on
   * the list, even if it could not be moved up to its place.
   */
  async function writeAgain(
    turn: SpeakingTurnDto,
    place: number,
    send: SendOptions = {},
  ): Promise<boolean> {
    const before = new Set(turns.value.map((other) => other.id));
    const ok = await add(
      {
        memberId: turn.member?.id ?? null,
        speaker: turn.speaker,
        ...(turn.agendaItemId ? { agendaItemId: turn.agendaItemId } : {}),
      },
      send,
    );
    if (!ok) return false;
    const waiting = view.value.waiting;
    const created = waiting.find((other) => !before.has(other.id));
    if (created && waiting.indexOf(created) > place) {
      await update(created, { position: place }, send);
    }
    return true;
  }

  /**
   * Puts a cancelled turn back in the waiting list at `place` (0 speaks
   * next). The Mesa's list keeps a cancelled turn only while it belongs to
   * the agenda item in debate (open turns carry over between items): one
   * written down for an earlier item is gone from it, and its `updatedAt`
   * with it, so it is written down again in the same place instead.
   */
  async function restore(
    turn: SpeakingTurnDto,
    place: number,
    send: SendOptions = {},
  ): Promise<boolean> {
    const listed = byId.value.get(turn.id);
    if (listed?.status === "cancelled") {
      return update(listed, { status: "waiting", position: place }, send);
    }
    return writeAgain(turn, place, send);
  }

  /**
   * Takes a turn off the list (the person no longer wants to speak). A
   * mistake is undone from the toast: the turn goes back to its place.
   */
  async function remove(turn: SpeakingTurnDto): Promise<boolean> {
    const before = byId.value.get(turn.id) ?? turn;
    const place = Math.max(
      0,
      view.value.waiting.findIndex((other) => other.id === turn.id),
    );
    const ok = await update(turn, { status: "cancelled" });
    if (!ok) return false;
    toast.add({
      id: `session-speaker-removed-${turn.id}`,
      title: t("session.speakers.removed", {
        who: sessionTurnWho(before) ?? t("session.speakers.unnamed"),
      }),
      color: "neutral",
      icon: "i-lucide-x",
      actions: [
        {
          label: t("session.actions.undo"),
          color: "neutral",
          variant: "outline",
          onClick: () => {
            void restore(before, place);
          },
        },
      ],
    });
    return true;
  }

  /**
   * Takes the floor back from a turn given by mistake: it goes back to the
   * head of the waiting list, as if it had not spoken yet. The server only
   * allows that in two steps (speaking, cancelled, waiting). Should the
   * second step fail, the person is off the list: the Mesa is told plainly,
   * so it writes them down again.
   */
  function returnToQueue(turn: SpeakingTurnDto): Promise<boolean> {
    return options.track(`speaker-${turn.id}-return`, async () => {
      const before = byId.value.get(turn.id) ?? turn;
      if (!(await update(before, { status: "cancelled" }))) return false;
      if (await restore(before, 0, { quiet: true })) return true;
      toast.add({
        id: `session-speaker-return-${turn.id}`,
        title: t("session.speakers.errors.backToQueue", {
          who: sessionTurnWho(before) ?? t("session.speakers.unnamed"),
        }),
        color: "error",
        icon: "i-lucide-circle-alert",
      });
      return false;
    });
  }

  /** Moves a waiting turn one place up (-1) or down (1). */
  function move(turn: SpeakingTurnDto, step: 1 | -1): Promise<boolean> {
    const position = sessionTurnMoveIndex(view.value.waiting, turn.id, step);
    if (position === null) return Promise.resolve(false);
    return update(turn, { position });
  }

  /**
   * The next step of the floor: the first waiting turn speaks (which ends
   * the current one), or, with nobody waiting, the current turn ends.
   */
  function next(): Promise<boolean> {
    const first = view.value.waiting[0];
    if (first) return giveFloor(first);
    const current = view.value.speaking;
    return current ? finish(current) : Promise.resolve(false);
  }

  function onLive(events: LiveEventDto[]): void {
    if (events.some(isSessionSpeakersEvent)) void refresh();
  }

  return {
    turns,
    history,
    view,
    loading,
    unavailable,
    failed,
    refresh,
    add,
    giveFloor,
    finish,
    rename,
    remove,
    returnToQueue,
    move,
    next,
    onLive,
  };
}

export type SessionSpeakersState = ReturnType<typeof useSessionSpeakers>;
