import type { MemberKind } from "~~/shared/constants/domain";
import { memberDescription } from "~/utils/format";

/** The little of a member the badge's spoken name reads. */
export interface SpokenMember {
  acronym: string;
  name: string;
  kind?: MemberKind | null;
}

/**
 * What a screen reader hears instead of a member's acronym: its
 * denomination and a council's university ("Consejo de Estudiantes ·
 * Universidad de Extremadura"), since councils share the same or nearly the
 * same denomination (user's decision of 2026-11-17), as the card it opens
 * reads them. An office of the CEA never takes a university (memberHighlight).
 * Undefined when there is nothing but the acronym to say.
 */
export function memberSpokenName(
  member: SpokenMember,
  university?: string | null,
): string | undefined {
  return memberDescription({
    ...member,
    university: member.kind === "executive" ? null : university,
  });
}

/**
 * Whether a badge needs the member directory to be spoken in full: a
 * council with an id, whose university only the directory carries.
 */
export function spokenNameNeedsDirectory(member: {
  id?: string | null;
  kind?: MemberKind | null;
}): boolean {
  return member.kind === "asociado" && Boolean(member.id);
}

/** The little of a pointer event the tap guard reads. */
interface GuardedEvent {
  pointerType?: string;
  stopPropagation(): void;
  preventDefault(): void;
}

/**
 * Keeps a tap on a hover card's trigger to itself. With `enable-touch`, a
 * finger opens the card on `pointerup`; the click the browser fires next
 * must not reach the row, link or label around it (a control sheet row
 * would open its panel over the card). A mouse click goes on as before.
 * Bind `pointerdown` and `click` on the trigger.
 */
export function useTouchTapGuard() {
  let touch = false;
  return {
    pointerdown(event: GuardedEvent): void {
      touch = event.pointerType === "touch";
    },
    click(event: GuardedEvent): void {
      if (touch) {
        event.stopPropagation();
        event.preventDefault();
      }
      touch = false;
    },
  };
}
