import { describe, expect, it } from "vitest";
import { ref } from "vue";
import { affectsAgenda } from "~/components/live-view/-model";
import { keepLastGoodData } from "../fetch/lastGoodData";
import {
  agendaCanFallBehind,
  behindAgendaRefresh,
  sharedAgendaAction,
} from "./useCurrentAssembly";

const event = (entityType: string, type = "updated") => ({
  entityType,
  type,
  entityId: "x",
});

/** What Directo does with a batch, in session or not. */
const directo = (
  events: ReturnType<typeof event>[],
  inSession = true,
): ReturnType<typeof sharedAgendaAction> =>
  sharedAgendaAction(events, { follows: affectsAgenda, active: inSession });

describe("sharedAgendaAction (Directo's agenda)", () => {
  it("refetches in session on what changes the titles, and on a poll", () => {
    expect(directo([event("agenda_item", "agenda_item_updated")])).toBe(
      "refresh",
    );
    expect(directo([event("document", "document_updated")])).toBe("refresh");
    expect(directo([event("assembly", "assembly_updated")])).toBe("refresh");
    expect(directo([event("assembly", "poll")])).toBe("refresh");
  });

  it("marks the agenda behind when an amendment changes the counts", () => {
    // The agenda pages follow these (AMENDMENT_LISTING_TYPES); Directo does
    // not, so the next agenda page refetches what it is handed.
    expect(directo([event("amendment", "amendment_published")])).toBe("behind");
    expect(directo([event("amendment", "amendment_withdrawn")])).toBe("behind");
    expect(directo([event("amendment", "amendment_reopened")])).toBe("behind");
  });

  it("refetches once for a batch that holds both", () => {
    expect(
      directo([
        event("amendment", "amendment_published"),
        event("agenda_item", "agenda_item_updated"),
      ]),
    ).toBe("refresh");
  });

  it("leaves the agenda alone on what changes neither", () => {
    expect(directo([event("live", "live_changed")])).toBe("none");
    expect(directo([event("speakers", "speaker_added")])).toBe("none");
    expect(directo([event("vote", "vote_recorded")])).toBe("none");
    expect(directo([event("amendment", "amendment_approved")])).toBe("none");
    expect(directo([])).toBe("none");
  });

  it("never refetches outside the session, but marks what it skips", () => {
    expect(directo([event("agenda_item", "agenda_item_updated")], false)).toBe(
      "behind",
    );
    expect(directo([event("assembly", "poll")], false)).toBe("behind");
    expect(directo([event("amendment", "amendment_published")], false)).toBe(
      "behind",
    );
    expect(directo([event("vote", "vote_recorded")], false)).toBe("none");
  });
});

describe("agendaCanFallBehind (Directo's mark)", () => {
  it("marks an agenda held or on its way", () => {
    expect(agendaCanFallBehind("success", true)).toBe(true);
    expect(agendaCanFallBehind("pending", true)).toBe(true);
    // Directo's first request, still in flight, may miss the change.
    expect(agendaCanFallBehind("pending", false)).toBe(true);
  });

  it("skips a fetch that holds nothing: the next page fetches anew", () => {
    // Outside the session Directo never fetches the agenda.
    expect(agendaCanFallBehind("idle", false)).toBe(false);
    expect(agendaCanFallBehind("error", false)).toBe(false);
  });
});

describe("behindAgendaRefresh (the next agenda page)", () => {
  it("refetches an agenda handed over at once", () => {
    expect(behindAgendaRefresh("success")).toBe("now");
  });

  it("refetches after a request in flight, which may predate the mark", () => {
    expect(behindAgendaRefresh("pending")).toBe("after-pending");
  });

  it("leaves alone a fetch with nothing held nor in flight", () => {
    expect(behindAgendaRefresh("idle")).toBe("none");
    expect(behindAgendaRefresh("error")).toBe("none");
  });

  it("keeps the agenda handed over when the refetch fails", () => {
    // useAssemblyAgenda wraps the fetch before refetching, so the wrapper
    // sees the handed-over agenda as good and keeps it on a failure.
    const data = ref<{ id: string } | undefined>({ id: "agenda" });
    const status = ref("success");
    const error = ref<unknown>(undefined);
    const { data: shown, stale } = keepLastGoodData({ data, status, error });
    expect(behindAgendaRefresh(status.value)).toBe("now");
    status.value = "pending";
    error.value = Object.assign(new Error("failed"), { statusCode: 502 });
    data.value = undefined;
    status.value = "error";
    expect(shown.value).toEqual({ id: "agenda" });
    expect(stale.value).toBe(true);
  });
});
