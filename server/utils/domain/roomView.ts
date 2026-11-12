import type { H3Event } from "h3";
import { createError, getQuery } from "h3";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "../../db";
import { liveState } from "../../db/schema";
import type { AgendaDto, AgendaItemDto } from "~~/shared/types/api";
import { ROOM_VIEW } from "~~/shared/constants/roomView";
import { agendaItemSlugs } from "~~/shared/utils/slug";
import { canModerate, requireActor, type Actor } from "./actor";
import {
  canReadItemTitle,
  loadAgendaItems,
  toAgendaItemDto,
  type AgendaItemRow,
} from "./assemblies";
import type { Executor } from "./events";

/**
 * The room view (`?view=room`, shared/constants/roomView.ts): the projection
 * is opened on a Mesa account but read by the whole room, so its reads
 * answer as an account that sees only what is public and manages nothing.
 * Every visibility rule and every redact* helper then applies by itself:
 * the executive offices read as the generic "CEA", the person who speaks
 * for one goes, and unpublished documents, amendments and agenda items stay
 * out. Only the Mesa (session:moderate) may ask for it, and only on reads.
 */

/**
 * The user id of the room viewer. Never a real account, so no "created by
 * this account" rule (an amendment or a document the Mesa account created
 * or submitted) lets anything through.
 */
export const ROOM_VIEWER_ID = "room-view";

const roomViewQuerySchema = z.object({
  view: z.enum([ROOM_VIEW]).optional(),
});

/**
 * The public reader the room view answers as, built from the real actor:
 * no role, no permissions, no member and an id no row carries. The
 * impersonation the request runs under stays, as with any actor.
 */
export function roomViewer(actor: Actor): Actor {
  return {
    user: {
      ...actor.user,
      id: ROOM_VIEWER_ID,
      name: "",
      email: "",
      image: null,
      roleId: null,
      role: null,
      memberId: null,
      externalRole: null,
      externalName: null,
      externalInitials: null,
      university: null,
    },
    memberId: null,
    memberKind: null,
    isAdmin: false,
    permissions: [],
    can: () => false,
    impersonation: actor.impersonation ?? null,
  };
}

/** Whether the actor is the room viewer (roomViewer). */
export function isRoomViewer(actor: Actor): boolean {
  return actor.user.id === ROOM_VIEWER_ID;
}

/**
 * Whether the request asks for the room view: 400 for any other `view`,
 * and on anything but a read (the room view never writes).
 */
export function wantsRoomView(event: H3Event): boolean {
  const query = roomViewQuerySchema.safeParse({
    view: getQuery(event).view,
  });
  if (!query.success) {
    throw createError({ statusCode: 400, message: "Parámetros no válidos" });
  }
  if (query.data.view === undefined) return false;
  if (event.method !== "GET" && event.method !== "HEAD") {
    throw createError({ statusCode: 400, message: "Parámetros no válidos" });
  }
  return true;
}

/**
 * The actor a read answers as: the signed-in one, or with `?view=room` the
 * room viewer, which only the Mesa may ask for (403 otherwise). The room
 * viewer replaces the request's cached actor, so the shared resolvers that
 * call requireActor themselves (resolveDocumentRoute,
 * loadAmendmentDocumentContext) answer as it too: call this first. The real
 * Mesa actor stays at hand (roomViewOf), so the room never reads more than
 * the account that opened the projection.
 */
export async function requireViewer(event: H3Event): Promise<Actor> {
  const actor = await requireActor(event);
  if (!wantsRoomView(event)) return actor;
  if (!canModerate(actor)) {
    throw createError({
      statusCode: 403,
      message: "No tienes permiso para realizar esta acción",
    });
  }
  const viewer = roomViewer(actor);
  event.context.actor = viewer;
  event.context.roomViewOf = actor;
  return viewer;
}

/**
 * The signed-in Mesa actor behind a room-view request (requireViewer), or
 * undefined when the request does not ask for the room view.
 */
export function roomViewOf(event: H3Event): Actor | undefined {
  return event.context.roomViewOf as Actor | undefined;
}

/**
 * Whether the room reads the title of the item the Mesa puts on screen:
 * only when the Mesa account that opened the projection reads it itself
 * (canReadItemTitle: a Moderador does not read a draft's title), and never
 * a title withheld after its document was deleted, not even through a
 * document manager.
 */
export async function screenTitleReadable(
  mesa: Actor | undefined,
  row: AgendaItemRow,
  executor: Executor = db,
): Promise<boolean> {
  if (!mesa || row.titleWithheld) return false;
  return canReadItemTitle(mesa, row, executor);
}

/**
 * The agenda as the room reads it, plus the item the Mesa itself puts on
 * screen when the room viewer does not get it, or gets it without its title
 * (an item that carries the title of a document not published yet): the
 * room reads its title on the projection when `screenTitleReadable`
 * (screenTitleReadable), and the items above it come without theirs, only
 * so it has a place in the tree. An item the room already receives keeps
 * its `unlisted` flag, so the numbers everyone reads never move; one it
 * does not receive is unlisted, like everything added above it.
 */
export function withScreenItem(
  listed: AgendaItemDto[],
  rows: readonly AgendaItemRow[],
  screenItemId: string | null,
  screenTitleReadable = false,
): AgendaItemDto[] {
  if (!screenItemId) return listed;
  const have = new Map(listed.map((item) => [item.id, item]));
  const screen = have.get(screenItemId);
  // Listed with its title, or listed and nothing more to give it.
  if (screen && (!screen.titleHidden || !screenTitleReadable)) return listed;

  const byId = new Map(rows.map((row) => [row.id, row]));
  const slugs = agendaItemSlugs(rows);
  const added = new Map<string, AgendaItemDto>();
  let row = byId.get(screenItemId);
  let isScreen = true;
  while (row && !added.has(row.id) && (isScreen || !have.has(row.id))) {
    const titleHidden = isScreen
      ? row.titleWithheld || !screenTitleReadable
      : true;
    const unlisted = have.get(row.id)?.unlisted ?? true;
    // The title is all the room reads of it: not its description nor the
    // document it was created for.
    added.set(row.id, {
      ...toAgendaItemDto(row, titleHidden, unlisted, slugs.get(row.id)),
      description: null,
      generatedForDocumentId: null,
    });
    isScreen = false;
    row = row.parentId ? byId.get(row.parentId) : undefined;
  }
  if (added.size === 0) return listed;
  return rows.flatMap((item) => {
    const dto = added.get(item.id) ?? have.get(item.id);
    return dto ? [dto] : [];
  });
}

/**
 * The room view's agenda (loadAgendaDto with the room viewer). `mesa` is
 * the account that opened the projection (roomViewOf): the item on screen
 * shows its title only when that account reads it.
 */
export async function roomAgenda(
  agenda: AgendaDto,
  assemblyId: string,
  mesa: Actor | undefined,
): Promise<AgendaDto> {
  const [state] = await db
    .select({ agendaItemId: liveState.agendaItemId })
    .from(liveState)
    .where(eq(liveState.assemblyId, assemblyId));
  const screenItemId = state?.agendaItemId ?? null;
  if (!screenItemId) return agenda;
  const listed = agenda.items.find((item) => item.id === screenItemId);
  if (listed && !listed.titleHidden) return agenda;
  const rows = await loadAgendaItems(assemblyId);
  const screenRow = rows.find((row) => row.id === screenItemId);
  if (!screenRow) return agenda;
  return {
    ...agenda,
    items: withScreenItem(
      agenda.items,
      rows,
      screenItemId,
      await screenTitleReadable(mesa, screenRow),
    ),
  };
}
