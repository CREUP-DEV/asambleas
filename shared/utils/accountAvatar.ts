import type { MemberKind } from "../constants/domain";

/**
 * What an account's avatar reads when it has no photo:
 * - an account that acts for a sectorial, a CEA office or another member
 *   (the CAS): that member's acronym ("ANEM", "SE");
 * - any other account with a university (a council, a guest council): the
 *   university's acronym ("UGR", "UVa"), its own or its council's, as the
 *   Intranet stores it (it cannot be worked out from the university's
 *   name: UV is the Universitat de València, so Valladolid is UVa);
 * - a council account without one: the council's acronym;
 * - anyone else: null, and UAvatar draws the initials of the name.
 *
 * Case is kept: "UVa" and "CdEUB" are not "UVA" and "CDEUB".
 */
export function accountAvatarText(
  account: { universityAcronym: string | null },
  member: {
    kind: MemberKind;
    acronym: string;
    universityAcronym: string | null;
  } | null,
): string | null {
  if (member && member.kind !== "asociado") return member.acronym;
  return (
    account.universityAcronym?.trim() ||
    member?.universityAcronym?.trim() ||
    member?.acronym ||
    null
  );
}
