import { defineEventHandler, getRouterParam } from "h3";
import type { ReadMarksDto } from "~~/shared/types/api";
import { readMarksBodySchema } from "~~/shared/utils/schemas/readMarks";
import { requireActor } from "../../../utils/domain/actor";
import { readAssemblyBody } from "../../../utils/domain/assemblies";
import { setReadMarks } from "../../../utils/domain/readMarks";
import { resolveAssembly } from "../../../utils/domain/resolvers";
import { throwMutationError } from "../../../utils/errors";

/**
 * The account marks published documents or amendments as read, or as not
 * read. Any account that sees the assembly may: the marks are its own.
 */
export default defineEventHandler(async (event): Promise<ReadMarksDto> => {
  const actor = await requireActor(event);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const body = await readAssemblyBody(event, readMarksBodySchema);

  try {
    return await setReadMarks(event, actor, assembly, body);
  } catch (error) {
    throwMutationError("readMarks.set", error, event);
  }
});
