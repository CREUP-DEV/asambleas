import { createError } from "h3";
import { eq, inArray } from "drizzle-orm";
import type { MemberSyncResult } from "~~/shared/types/api";
import { db } from "../../db";
import { auditLog, members } from "../../db/schema";
import { logInfo, logWarn } from "../core/logger";
import {
  IntranetUnavailableError,
  fetchIntranetRoster,
  getIntranetApiBaseUrl,
} from "./intranet";
import { normalizeRoster, planRosterSync } from "./roster";

/**
 * Syncs asociados and sectorials from the intranet roster.
 *
 * Both lists are fetched before anything is written: a failed or partial
 * fetch must never deactivate the members it did not return. Members are
 * matched by acronym (the intranet's `initials`), case-insensitively. Manual
 * members are never touched.
 */
export async function syncIntranetRoster(actorUserId: string | null): Promise<MemberSyncResult> {
  const base = getIntranetApiBaseUrl();
  if (!base) {
    throw createError({
      statusCode: 503,
      message: "La sincronización con la intranet no está configurada",
    });
  }

  let asociados;
  let sectoriales;
  try {
    [asociados, sectoriales] = await Promise.all([
      fetchIntranetRoster(base, "asociado"),
      fetchIntranetRoster(base, "sectorial"),
    ]);
  } catch (error) {
    if (error instanceof IntranetUnavailableError) {
      logWarn("members.sync", { reason: error.message });
      throw createError({
        statusCode: 502,
        message: "No se pudo obtener el listado de miembros de la intranet",
      });
    }
    throw error;
  }

  const roster = normalizeRoster([
    { kind: "asociado", entries: asociados },
    { kind: "sectorial", entries: sectoriales },
  ]);
  if (roster.skipped > 0 || roster.duplicates.length > 0) {
    logWarn("members.sync", {
      reason: "roster rows ignored",
      withoutInitials: roster.skipped,
      duplicates: roster.duplicates,
    });
  }

  return db.transaction(async (tx) => {
    const existing = await tx
      .select({
        id: members.id,
        kind: members.kind,
        acronym: members.acronym,
        name: members.name,
        university: members.university,
        region: members.region,
        source: members.source,
        active: members.active,
      })
      .from(members)
      .for("update");

    const plan = planRosterSync(roster.members, existing);
    const now = new Date();

    if (plan.create.length > 0) {
      await tx.insert(members).values(
        plan.create.map((entry) => ({
          ...entry,
          source: "intranet" as const,
          active: true,
          syncedAt: now,
        })),
      );
    }
    for (const { id, values } of plan.update) {
      await tx
        .update(members)
        .set({ ...values, active: true, syncedAt: now })
        .where(eq(members.id, id));
    }
    if (plan.unchanged.length > 0) {
      await tx.update(members).set({ syncedAt: now }).where(inArray(members.id, plan.unchanged));
    }
    if (plan.deactivate.length > 0) {
      await tx.update(members).set({ active: false }).where(inArray(members.id, plan.deactivate));
    }

    const result: MemberSyncResult = {
      created: plan.create.length,
      updated: plan.update.length,
      deactivated: plan.deactivate.length,
    };

    await tx.insert(auditLog).values({
      actorUserId,
      action: "members.sync",
      targetType: "members",
      targetId: "intranet",
      before: null,
      after: {
        ...result,
        unchanged: plan.unchanged.length,
        manualConflicts: plan.manualConflicts,
      },
    });

    if (plan.manualConflicts.length > 0) {
      logWarn("members.sync", {
        reason: "roster acronyms held by manual members",
        acronyms: plan.manualConflicts,
      });
    }
    logInfo("members.sync", { ...result });
    return result;
  });
}
