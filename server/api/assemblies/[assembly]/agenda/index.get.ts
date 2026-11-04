import { defineEventHandler, getRouterParam } from "h3";
import type { AgendaDto } from "~~/shared/types/api";
import { requireActor } from "../../../../utils/domain/actor";
import { loadAgendaDto } from "../../../../utils/domain/assemblies";
import { resolveAssembly } from "../../../../utils/domain/resolvers";

/** Flat agenda items (the client builds the tree) and the visible documents. */
export default defineEventHandler(async (event): Promise<AgendaDto> => {
  const actor = await requireActor(event);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  return loadAgendaDto(actor, assembly);
});
