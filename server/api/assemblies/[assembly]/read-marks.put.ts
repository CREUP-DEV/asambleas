import { readBodyWith } from "../../../utils/core/http";
import { defineEventHandler } from "h3";
import type { ReadMarksDto } from "~~/shared/types/api";
import { readMarksBodySchema } from "~~/shared/utils/schemas/readMarks";
import { setReadMarks } from "../../../utils/domain/readMarks";
import { throwMutationError } from "../../../utils/errors";
import { resolveAssemblyRoute } from "../../../utils/domain/assemblyRoute";

/**
 * The account marks published documents or amendments as read, or as not
 * read. Any account that sees the assembly may: the marks are its own.
 */
export default defineEventHandler(async (event): Promise<ReadMarksDto> => {
  const { actor, assembly } = await resolveAssemblyRoute(event);
  const body = await readBodyWith(event, readMarksBodySchema);

  try {
    return await setReadMarks(event, actor, assembly, body);
  } catch (error) {
    throwMutationError("readMarks.set", error, event);
  }
});
