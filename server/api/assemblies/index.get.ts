import { defineEventHandler } from "h3";
import type { AssemblyListDto } from "~~/shared/types/api";
import { assemblyListQuerySchema } from "~~/shared/utils/schemas/assembly";
import { requireActor } from "../../utils/domain/actor";
import {
  listAssemblies,
  readAssemblyQuery,
} from "../../utils/domain/assemblies";

/** Assemblies, newest first. Drafts are listed only for managers and the Mesa. */
export default defineEventHandler(async (event): Promise<AssemblyListDto> => {
  const actor = await requireActor(event);
  const query = readAssemblyQuery(event, assemblyListQuerySchema);
  return listAssemblies(actor, query);
});
