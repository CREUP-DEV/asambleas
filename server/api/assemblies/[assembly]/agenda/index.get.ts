import { defineEventHandler, getRouterParam } from "h3";
import type { AgendaDto } from "~~/shared/types/api";
import { loadAgendaDto } from "../../../../utils/domain/assemblies";
import { resolveAssembly } from "../../../../utils/domain/resolvers";
import {
  isRoomViewer,
  requireViewer,
  roomAgenda,
  roomViewOf,
} from "../../../../utils/domain/roomView";

/**
 * Flat agenda items (the client builds the tree) and the visible documents.
 * The room view (`?view=room`, the projection) also gets the item the Mesa
 * puts on screen, with its title when the Mesa account reads it (roomAgenda).
 */
export default defineEventHandler(async (event): Promise<AgendaDto> => {
  const actor = await requireViewer(event);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const agenda = await loadAgendaDto(actor, assembly);
  return isRoomViewer(actor)
    ? roomAgenda(agenda, assembly.id, roomViewOf(event))
    : agenda;
});
