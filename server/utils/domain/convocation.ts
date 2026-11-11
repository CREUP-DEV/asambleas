import { createError } from "h3";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { assemblies } from "../../db/schema";
import type { Actor } from "./actor";
import type { AssemblyRow } from "./assemblies";
import {
  PDF_URL_PREFIX,
  removeStoredPdf,
  STORED_PDF_NAME,
  storePdf,
  type UploadedFile,
} from "./documents";
import { recordEvent } from "./events";
import { buildOptimisticLockCondition } from "../optimisticLock";

/**
 * The signed convocatoria of an assembly, uploaded as a PDF by Secretaría.
 * Stored beside the documents' PDFs (same directory, random names) but
 * served by its own route, /api/uploads/convocations/[filename], which asks
 * only that the reader sees the assembly.
 */
export const CONVOCATION_URL_PREFIX = "/api/uploads/convocations/";

const STALE_ASSEMBLY_MESSAGE =
  "La asamblea ha cambiado mientras la editabas. Recarga e inténtalo de nuevo";

/** The stored name of a convocation URL, or null if it is not one. */
export function convocationStoredName(
  fileUrl: string | null | undefined,
): string | null {
  if (!fileUrl?.startsWith(CONVOCATION_URL_PREFIX)) return null;
  const name = fileUrl.slice(CONVOCATION_URL_PREFIX.length);
  return STORED_PDF_NAME.test(name) ? name : null;
}

/** Best-effort removal of a convocation PDF nobody points to any more. */
export async function removeConvocationPdf(
  fileUrl: string | null | undefined,
): Promise<void> {
  const name = convocationStoredName(fileUrl);
  if (name) await removeStoredPdf(`${PDF_URL_PREFIX}${name}`);
}

function readUpdatedAt(value: string | undefined): string | undefined {
  const updatedAt = value?.trim() || undefined;
  if (updatedAt && Number.isNaN(new Date(updatedAt).getTime())) {
    throw createError({ statusCode: 400, message: "Datos no válidos" });
  }
  return updatedAt;
}

/**
 * Stores the signed convocatoria (validated as a PDF by `storePdf`) and
 * points the assembly to it, replacing the one before, whose file goes once
 * the change commits. Records `convocation_uploaded`.
 */
export async function attachConvocationFile(
  actor: Actor,
  assembly: AssemblyRow,
  file: UploadedFile,
): Promise<void> {
  const updatedAt = readUpdatedAt(file.fields.updatedAt);
  const stored = await storePdf(file);
  const fileUrl = `${CONVOCATION_URL_PREFIX}${stored.fileUrl.slice(PDF_URL_PREFIX.length)}`;
  let previous: string | null;
  try {
    previous = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(assemblies)
        .set({
          convocationFileUrl: fileUrl,
          convocationFileName: stored.fileName,
          convocationUploadedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(assemblies.id, assembly.id),
            buildOptimisticLockCondition(assemblies.updatedAt, updatedAt),
          ),
        )
        .returning({ id: assemblies.id });
      if (!row) {
        throw createError({ statusCode: 409, message: STALE_ASSEMBLY_MESSAGE });
      }
      await recordEvent(tx, {
        assemblyId: assembly.id,
        entityType: "assembly",
        entityId: assembly.id,
        type: "convocation_uploaded",
        payload: {
          fileName: stored.fileName,
          replaced: assembly.convocationFileUrl !== null,
        },
        actor,
      });
      return assembly.convocationFileUrl;
    });
  } catch (error) {
    await removeStoredPdf(stored.fileUrl);
    throw error;
  }
  if (previous && previous !== fileUrl) await removeConvocationPdf(previous);
}

/**
 * Takes the signed convocatoria away (the generated one leads again) and
 * removes its file once that commits. Records `convocation_removed`.
 */
export async function removeConvocationFile(
  actor: Actor,
  assembly: AssemblyRow,
  updatedAtValue: string | undefined,
): Promise<void> {
  const updatedAt = readUpdatedAt(updatedAtValue);
  if (!assembly.convocationFileUrl) {
    throw createError({
      statusCode: 409,
      message: "La asamblea no tiene convocatoria en PDF",
    });
  }
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(assemblies)
      .set({
        convocationFileUrl: null,
        convocationFileName: null,
        convocationUploadedAt: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(assemblies.id, assembly.id),
          buildOptimisticLockCondition(assemblies.updatedAt, updatedAt),
        ),
      )
      .returning({ id: assemblies.id });
    if (!row) {
      throw createError({ statusCode: 409, message: STALE_ASSEMBLY_MESSAGE });
    }
    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "assembly",
      entityId: assembly.id,
      type: "convocation_removed",
      payload: { fileName: assembly.convocationFileName },
      actor,
    });
  });
  await removeConvocationPdf(assembly.convocationFileUrl);
}
