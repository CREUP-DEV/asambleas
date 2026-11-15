import type {
  SeatingGroupDto,
  SeatingPersonDto,
  SeatingSyncDto,
} from "~~/shared/types/api";
import type {
  SeatingCounts,
  SeatingLegendKind,
} from "~~/shared/utils/seating/groups";
import {
  seatLabelParts,
  type SeatingRunKind,
  type SeatingWalk,
} from "~~/shared/utils/seating/runs";
import {
  personName,
  seatNameKey,
  type SeatOccupant,
  type SeatView,
} from "~/components/seating/-model";
import {
  seatRanges,
  type SeatRange,
  type SeatingPick,
} from "~/components/seating/-placing";

/** The i18n key of a stretch of seats, by its run, under `seating.range`. */
const RANGE_KEYS: Record<SeatingRunKind, string> = {
  presiding: "presiding",
  outer_u: "outerU",
  inner_u: "innerU",
  loose: "loose",
  other: "other",
};

/**
 * How the seating view words its seats, people and counts, in the viewer's
 * language: «Asiento 12, U exterior: UGR, Ana Pérez», «libre»,
 * «93 personas · 88 sentadas · 5 sin asiento». Names, acronyms and cargos
 * are content and are never translated.
 */
export function useSeatingWords() {
  const { t, locale } = useI18n();

  /** «a, b y c», in the viewer's language. */
  function listText(parts: readonly string[]): string {
    try {
      return new Intl.ListFormat(locale.value, { type: "conjunction" }).format(
        parts,
      );
    } catch {
      return parts.join(", ");
    }
  }

  /** «los asientos 12 a 14 de la U exterior y la silla suelta 2». */
  function rangesText(ranges: readonly SeatRange[]): string {
    return listText(
      ranges.map((range) =>
        t(
          `seating.range.${range.from === range.to ? "one" : "many"}.${RANGE_KEYS[range.kind]}`,
          { from: range.from, to: range.to, ordinal: range.ordinal },
        ),
      ),
    );
  }

  /** The seats as stretches in a row, worded. */
  function seatsText(walk: SeatingWalk, seatIds: Iterable<string>): string {
    return rangesText(seatRanges(walk, seatIds));
  }

  /** «Asiento 12, U exterior», «Silla suelta 2», with its own label. */
  function seatName(walk: SeatingWalk, seatId: string): string {
    const parts = seatLabelParts(walk, seatId);
    if (!parts) return t("seating.seat.unknown");
    const name = t(seatNameKey(parts.run.kind), {
      number: parts.number,
      ordinal: parts.run.ordinal,
    });
    // Punctuation only: the same in every language.
    return parts.label ? `${name} (${parts.label})` : name;
  }

  /** A person as the plan names them: their name, their cargo, or neither. */
  function personLabel(person: SeatingPersonDto): string {
    const name = personName(person);
    if (name && person.label) return `${name} (${person.label})`;
    return name ?? person.label ?? t("seating.person.unnamed");
  }

  /** «UGR, Ana Pérez, pendiente». */
  function occupantText(occupant: SeatOccupant): string {
    const parts = [
      occupant.group?.acronym,
      personLabel(occupant.person),
      occupant.person.goneAt || occupant.group?.goneAt
        ? t("seating.person.goneShort")
        : occupant.person.status === "pending"
          ? t("seating.person.pendingShort")
          : null,
    ].filter((part): part is string => Boolean(part));
    return parts.join(", ");
  }

  /** What a seat says to a screen reader. */
  function seatAriaLabel(walk: SeatingWalk, seat: SeatView): string {
    const name = seatName(walk, seat.id);
    const state = seat.occupant
      ? occupantText(seat.occupant)
      : seat.disabled
        ? t("seating.seat.disabled")
        : t("seating.seat.free");
    return `${name}: ${state}`;
  }

  /** A group's full name, as the tray and the details show it. */
  function groupName(group: SeatingGroupDto): string {
    return group.member?.name ?? group.name;
  }

  /**
   * Who is being placed: «UGR (3)» for a block, «Ana Pérez, UGR» for one
   * person. Punctuation only around content: the same in every language.
   */
  function pickText(
    pick: SeatingPick,
    plan: {
      groups: readonly SeatingGroupDto[];
      people: readonly SeatingPersonDto[];
    },
  ): string {
    const group = plan.groups.find((entry) => entry.id === pick.groupId);
    if (pick.personIds.length === 1) {
      const person = plan.people.find(
        (entry) => entry.id === pick.personIds[0],
      );
      if (person) {
        return group
          ? `${personLabel(person)}, ${group.acronym}`
          : personLabel(person);
      }
    }
    return group
      ? `${group.acronym} (${pick.personIds.length})`
      : String(pick.personIds.length);
  }

  function legendLabel(kind: SeatingLegendKind): string {
    return t(`seating.legend.kinds.${kind}`);
  }

  /** «93 personas · 88 sentadas · 5 sin asiento». */
  function countsText(counts: SeatingCounts): string {
    return [
      t("seating.counts.people", { count: counts.people }, counts.people),
      t("seating.counts.seated", { count: counts.seated }, counts.seated),
      t("seating.counts.unseated", { count: counts.unseated }, counts.unseated),
    ].join(" · ");
  }

  /** The status a person's registration is in, for the details. */
  function statusLabel(
    person: SeatingPersonDto,
    group: SeatingGroupDto | null,
  ) {
    if (person.goneAt || group?.goneAt) return t("seating.person.gone");
    if (!person.needsSeat) return t("seating.person.noSeat");
    switch (person.source) {
      case "placeholder":
        return t("seating.person.placeholder");
      case "manual":
        return t("seating.person.manual");
      default:
        return person.status === "pending"
          ? t("seating.person.pending")
          : t("seating.person.confirmed");
    }
  }

  /**
   * The sync line's status, without its time. Null says nothing: no
   * Intranet configured, or one without the attendees' route yet (the room
   * works with groups made by hand, and only a «Sincronizar» pressed by hand
   * says so, in a toast).
   */
  function syncStatusKey(sync: SeatingSyncDto): string | null {
    switch (sync.status) {
      case "ok":
        return sync.eventName ? "seating.sync.ok" : "seating.sync.okNoEvent";
      case "not_found":
        return "seating.sync.notFound";
      case "failed":
        return "seating.sync.failed";
      case "unavailable":
      case "unconfigured":
        return null;
      default:
        return "seating.sync.never";
    }
  }

  return {
    listText,
    rangesText,
    seatsText,
    pickText,
    seatName,
    personLabel,
    occupantText,
    seatAriaLabel,
    groupName,
    legendLabel,
    countsText,
    statusLabel,
    syncStatusKey,
  };
}
