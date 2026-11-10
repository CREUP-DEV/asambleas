import type { DocumentEditorPresenceDto } from "../../../shared/types/api";
import type { PresenceEntry } from "../live/presence";
import type { Actor } from "./actor";
import { redactEventActor } from "./visibility";

/**
 * The other editor tabs of a draft as `viewer` may read them: whoever acts
 * for an executive office reads as the generic "CEA", with no name, for
 * those who may not see the offices (as in the history).
 */
export function presenceForViewer(
  viewer: Actor,
  entries: PresenceEntry[],
): DocumentEditorPresenceDto[] {
  return entries.map((entry) => {
    const who = redactEventActor(viewer, {
      actorName: entry.name,
      actorMember: entry.member,
    });
    return {
      name: who.actorName,
      member: who.actorMember,
      sameAccount: entry.userId === viewer.user.id,
      unsaved: entry.unsaved,
    };
  });
}
