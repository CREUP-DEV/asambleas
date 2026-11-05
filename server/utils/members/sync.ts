import type { H3Event } from "h3";
import { createError } from "h3";
import { eq, inArray } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { AUDIT_ACTIONS } from "~~/shared/constants/activity";
import type { MemberSyncResult } from "~~/shared/types/api";
import { db } from "../../db";
import { members } from "../../db/schema";
import { logInfo, logWarn } from "../core/logger";
import { recordAudit, type AuditActorInput } from "../domain/audit";
import type { MemberRow } from "./dto";
import {
  IntranetUnavailableError,
  fetchIntranetRoster,
  getIntranetApiBaseUrl,
} from "./intranet";
import { normalizeRoster, planRosterSync } from "./roster";

/**
 * What the audit log keeps of a member: the fields people edit or the
 * roster sync changes. `updatedAt` and `syncedAt` are left out, since every
 * write moves them: an edit that changes nothing then writes no row
 * (recordAudit skips equal before/after).
 */
export function memberAuditState(
  member: Pick<
    MemberRow,
    "kind" | "acronym" | "name" | "university" | "region" | "source" | "active"
  >,
): Record<string, unknown> {
  return {
    kind: member.kind,
    acronym: member.acronym,
    name: member.name,
    university: member.university,
    region: member.region,
    source: member.source,
    active: member.active,
  };
}

/**
 * Syncs asociados and sectorials from the intranet roster.
 *
 * Both lists are fetched before anything is written: a failed or partial
 * fetch must never deactivate the members it did not return. Members are
 * matched by acronym (the intranet's `initials`), case-insensitively. Manual
 * members are never touched.
 *
 * Traceability (source `intranet`, actor the account that ran it): one
 * `member.sync_create`, `member.sync_update` (before/after) or
 * `member.sync_deactivate` row per member it changed, plus the `members.sync`
 * summary, all sharing one `batchId` in `after`.
 */
export async function syncIntranetRoster(options: {
  /** The request: the actor (when `actor` is omitted), IP and user agent. */
  event?: H3Event | null;
  /** Who ran it; defaults to the request's actor. */
  actor?: AuditActorInput | null;
}): Promise<MemberSyncResult> {
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
    const batchId = createId();
    const audit = (input: {
      action:
        | typeof AUDIT_ACTIONS.MEMBER_SYNC_CREATE
        | typeof AUDIT_ACTIONS.MEMBER_SYNC_UPDATE
        | typeof AUDIT_ACTIONS.MEMBER_SYNC_DEACTIVATE;
      memberId: string;
      before: Record<string, unknown> | null;
      after: Record<string, unknown>;
    }) =>
      recordAudit(tx, {
        event: options.event,
        actor: options.actor,
        source: "intranet",
        action: input.action,
        targetType: "member",
        targetId: input.memberId,
        before: input.before,
        after: { ...input.after, batchId },
      });

    if (plan.create.length > 0) {
      const created = await tx
        .insert(members)
        .values(
          plan.create.map((entry) => ({
            ...entry,
            source: "intranet" as const,
            active: true,
            syncedAt: now,
          })),
        )
        .returning();
      for (const row of created) {
        await audit({
          action: AUDIT_ACTIONS.MEMBER_SYNC_CREATE,
          memberId: row.id,
          before: null,
          after: memberAuditState(row),
        });
      }
    }
    const existingById = new Map(existing.map((member) => [member.id, member]));
    for (const { id, values } of plan.update) {
      await tx
        .update(members)
        .set({ ...values, active: true, syncedAt: now })
        .where(eq(members.id, id));
      const current = existingById.get(id);
      await audit({
        action: AUDIT_ACTIONS.MEMBER_SYNC_UPDATE,
        memberId: id,
        before: current ? memberAuditState(current) : null,
        after: memberAuditState({
          ...values,
          source: current?.source ?? "intranet",
          active: true,
        }),
      });
    }
    if (plan.unchanged.length > 0) {
      await tx
        .update(members)
        .set({ syncedAt: now })
        .where(inArray(members.id, plan.unchanged));
    }
    if (plan.deactivate.length > 0) {
      await tx
        .update(members)
        .set({ active: false })
        .where(inArray(members.id, plan.deactivate));
      for (const memberId of plan.deactivate) {
        await audit({
          action: AUDIT_ACTIONS.MEMBER_SYNC_DEACTIVATE,
          memberId,
          before: { active: true },
          after: { active: false },
        });
      }
    }

    const result: MemberSyncResult = {
      created: plan.create.length,
      updated: plan.update.length,
      deactivated: plan.deactivate.length,
    };

    await recordAudit(tx, {
      event: options.event,
      actor: options.actor,
      source: "intranet",
      action: AUDIT_ACTIONS.MEMBERS_SYNC,
      targetType: "members",
      targetId: "intranet",
      after: {
        ...result,
        unchanged: plan.unchanged.length,
        manualConflicts: plan.manualConflicts,
        batchId,
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
