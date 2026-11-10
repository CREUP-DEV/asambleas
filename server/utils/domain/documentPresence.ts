import { eq } from "drizzle-orm";
import { db } from "../../db";
import { members } from "../../db/schema";
import type {
  DocumentPresenceBody,
  DocumentPresenceDto,
  MemberRef,
} from "../../../shared/types/api";
import { leavePresence, listPresence, touchPresence } from "../live/presence";
import type { DocumentRouteContext } from "./documents";
import { requireTextEditor } from "./documents";
import { presenceForViewer } from "./documentPresenceView";

async function loadMemberRef(
  memberId: string | null,
): Promise<MemberRef | null> {
  if (!memberId) return null;
  const [row] = await db
    .select({
      id: members.id,
      acronym: members.acronym,
      name: members.name,
      kind: members.kind,
    })
    .from(members)
    .where(eq(members.id, memberId))
    .limit(1);
  return row ?? null;
}

/**
 * Heartbeat of an open draft editor: records this tab (or drops it when
 * `leaving`) and answers the other tabs editing the same draft. Only those
 * who may edit the text take part; it writes no state and so records no
 * event (it would wake every live listener of the assembly on each beat).
 *
 * An Admin impersonating an account is never announced as that account,
 * but still sees who else is editing.
 */
export async function documentPresence(
  ctx: DocumentRouteContext,
  body: DocumentPresenceBody,
): Promise<DocumentPresenceDto> {
  const { actor, document } = ctx;
  requireTextEditor(actor, document);
  const self = { userId: actor.user.id, tabId: body.tabId };

  if (body.leaving) {
    leavePresence(document.id, self);
    return { editors: [] };
  }

  if (!actor.impersonation) {
    touchPresence(document.id, {
      ...self,
      // The intranet's name, as the history shows it; never the email.
      name: actor.user.externalName ?? actor.user.name,
      member: await loadMemberRef(actor.memberId),
      unsaved: body.unsaved ?? false,
    });
  }

  return {
    editors: presenceForViewer(actor, listPresence(document.id, self)),
  };
}
