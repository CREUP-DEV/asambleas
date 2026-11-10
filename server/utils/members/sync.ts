import type { H3Event } from "h3";
import { createError } from "h3";
import { eq, inArray, sql } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { AUDIT_ACTIONS } from "~~/shared/constants/activity";
import type {
  MemberSyncConfirmedKind,
  MemberSyncDeactivationKind,
  MemberSyncResult,
} from "~~/shared/types/api";
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
import {
  OPTIONAL_ROSTER_KINDS,
  findLargeDeactivations,
  isDeactivationConfirmed,
  normalizeRoster,
  planExecutiveSync,
  planRosterSync,
  type IntranetRosterEntry,
  type OptionalRosterKind,
  type RosterKind,
  withoutReservedAcronyms,
} from "./roster";

/**
 * What the audit log keeps of a member: the fields people edit or the
 * roster sync changes. `updatedAt` and `syncedAt` are left out, since every
 * write moves them: an edit that changes nothing then writes no row
 * (recordAudit skips equal before/after). `intranetId` is kept, so a sync
 * that only stores or replaces the Intranet id still leaves its row.
 */
export function memberAuditState(
  member: Pick<
    MemberRow,
    | "kind"
    | "acronym"
    | "name"
    | "university"
    | "region"
    | "intranetId"
    | "source"
    | "active"
  >,
): Record<string, unknown> {
  return {
    kind: member.kind,
    acronym: member.acronym,
    name: member.name,
    university: member.university,
    region: member.region,
    intranetId: member.intranetId,
    source: member.source,
    active: member.active,
  };
}

/** Who started a roster sync: an account (POST /api/members/sync) or the daily job. */
export type RosterSyncTrigger = "manual" | "scheduled";

/**
 * How a roster sync ended:
 * - `applied`: the roster was written;
 * - `blocked`: it would deactivate too many members of a kind
 *   (findLargeDeactivations) and was not confirmed. Nothing but the
 *   `members.sync_blocked` audit row was written.
 */
export type RosterSyncOutcome =
  | { status: "applied"; result: MemberSyncResult }
  | { status: "blocked"; kinds: MemberSyncDeactivationKind[] };

/** Serializes roster syncs (manual and scheduled) across instances. */
const ROSTER_SYNC_LOCK = "members_roster_sync";

/**
 * Longer than any roster acronym (20 characters), so it never collides
 * with one: renamed members go through it when several change at once.
 */
const renamePlaceholder = (memberId: string) => `~roster-sync~${memberId}`;

/**
 * Fetches an optional list (the CEA's places, the guests). One the Intranet
 * cannot give, for example because it does not have the route yet, is
 * logged and left out: the sync leaves that kind as it was.
 */
async function fetchOptionalRoster(
  base: string,
  kind: OptionalRosterKind,
  trigger: RosterSyncTrigger,
): Promise<IntranetRosterEntry[] | null> {
  try {
    return await fetchIntranetRoster(base, kind);
  } catch (error) {
    if (!(error instanceof IntranetUnavailableError)) throw error;
    logWarn("members.sync", {
      reason: "optional roster unavailable",
      kind,
      detail: error.message,
      trigger,
    });
    return null;
  }
}

/**
 * Syncs the members from the intranet rosters: asociados, sectorials and
 * guests (Invitado and Desasociado accounts, who attend but never present),
 * and the CEA's offices.
 *
 * Every list is fetched before anything is written: a failed or partial
 * fetch must never deactivate the members it did not return. Without the
 * asociados or the sectorials the sync fails; without the CEA list or the
 * guests it goes on and leaves that kind as it was (`skipped`). Members are
 * matched by their Intranet id, then by acronym (the intranet's `initials`,
 * case-insensitively): planRosterSync. Manual members are never touched.
 * The CEA list only adds offices (planExecutiveSync): they stay manual
 * members and are never deactivated by a sync.
 *
 * A sync that would deactivate every active intranet member of a kind, or
 * more than max(3, 30%) of them, is applied only with `confirmDeactivation`
 * and `confirmedKinds` covering what it would deactivate now
 * (isDeactivationConfirmed): a confirmation of 5 members never deactivates
 * 100 because the Intranet answered less on the retry. Otherwise it writes
 * the `members.sync_blocked` audit row alone and returns `blocked` with the
 * current counts (the caller answers 409). The scheduled job never
 * confirms.
 *
 * Traceability (source `intranet`, actor the account that ran it, or null
 * for the scheduled job): one `member.sync_create`, `member.sync_update`
 * (before/after) or `member.sync_deactivate` row per member it changed, plus
 * the `members.sync` summary, all sharing one `batchId` in `after`.
 *
 * Throws 503 when the intranet is not configured and 502 when it cannot be
 * read.
 */
export async function syncIntranetRoster(options: {
  /** The request: the actor (when `actor` is omitted), IP and user agent. */
  event?: H3Event | null;
  /** Who ran it; defaults to the request's actor. null for the scheduled job. */
  actor?: AuditActorInput | null;
  /** Defaults to "manual". */
  trigger?: RosterSyncTrigger;
  /**
   * Applies a large deactivation, when `confirmedKinds` covers it. Only a
   * manual sync may confirm one.
   */
  confirmDeactivation?: boolean;
  /** The counts the account was shown and confirmed (MemberSyncBody). */
  confirmedKinds?: readonly MemberSyncConfirmedKind[];
}): Promise<RosterSyncOutcome> {
  const trigger = options.trigger ?? "manual";
  const confirmDeactivation =
    trigger === "manual" && options.confirmDeactivation === true;
  const confirmedKinds = confirmDeactivation
    ? (options.confirmedKinds ?? [])
    : [];

  const base = getIntranetApiBaseUrl();
  if (!base) {
    throw createError({
      statusCode: 503,
      message: "La sincronización con la intranet no está configurada",
    });
  }

  let asociados;
  let sectoriales;
  let executives: IntranetRosterEntry[] | null;
  let guests: IntranetRosterEntry[] | null;
  try {
    [asociados, sectoriales, executives, guests] = await Promise.all([
      fetchIntranetRoster(base, "asociado"),
      fetchIntranetRoster(base, "sectorial"),
      fetchOptionalRoster(base, "executive", trigger),
      fetchOptionalRoster(base, "guest", trigger),
    ]);
  } catch (error) {
    if (error instanceof IntranetUnavailableError) {
      logWarn("members.sync", { reason: error.message, trigger });
      throw createError({
        statusCode: 502,
        message: "No se pudo obtener el listado de miembros de la intranet",
      });
    }
    throw error;
  }

  const skipped = OPTIONAL_ROSTER_KINDS.filter(
    (kind) => (kind === "executive" ? executives : guests) === null,
  );
  const synced: RosterKind[] = guests
    ? ["asociado", "sectorial", "guest"]
    : ["asociado", "sectorial"];
  // Guests come last: an acronym a council or a sectorial holds stays theirs.
  const roster = normalizeRoster([
    { kind: "asociado", entries: asociados },
    { kind: "sectorial", entries: sectoriales },
    ...(guests
      ? [
          {
            kind: "guest" as const,
            entries: withoutReservedAcronyms(guests, executives ?? []),
          },
        ]
      : []),
  ]);
  if (
    roster.skipped > 0 ||
    roster.duplicates.length > 0 ||
    roster.duplicateIds.length > 0
  ) {
    logWarn("members.sync", {
      reason: "roster rows ignored",
      withoutInitials: roster.skipped,
      duplicates: roster.duplicates,
      duplicateIds: roster.duplicateIds,
    });
  }

  const audit = {
    event: options.event,
    actor: options.actor,
    source: "intranet" as const,
  };

  return db.transaction(async (tx): Promise<RosterSyncOutcome> => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${ROSTER_SYNC_LOCK}))`,
    );
    const existing = await tx
      .select({
        id: members.id,
        kind: members.kind,
        acronym: members.acronym,
        name: members.name,
        university: members.university,
        region: members.region,
        intranetId: members.intranetId,
        source: members.source,
        active: members.active,
      })
      .from(members)
      .for("update");

    const plan = planRosterSync(roster.members, existing, synced);
    const large = findLargeDeactivations(existing, plan.deactivate);
    if (
      large.length > 0 &&
      !(confirmDeactivation && isDeactivationConfirmed(large, confirmedKinds))
    ) {
      await recordAudit(tx, {
        ...audit,
        action: AUDIT_ACTIONS.MEMBERS_SYNC_BLOCKED,
        targetType: "members",
        targetId: "intranet",
        after: { reason: "large_deactivation", kinds: large, trigger },
      });
      logWarn("members.sync", {
        reason: "large deactivation not confirmed",
        trigger,
        kinds: large,
      });
      return { status: "blocked", kinds: large };
    }

    const now = new Date();
    const batchId = createId();
    const memberAudit = (input: {
      action:
        | typeof AUDIT_ACTIONS.MEMBER_SYNC_CREATE
        | typeof AUDIT_ACTIONS.MEMBER_SYNC_UPDATE
        | typeof AUDIT_ACTIONS.MEMBER_SYNC_DEACTIVATE;
      memberId: string;
      before: Record<string, unknown> | null;
      after: Record<string, unknown>;
    }) =>
      recordAudit(tx, {
        ...audit,
        action: input.action,
        targetType: "member",
        targetId: input.memberId,
        before: input.before,
        after: { ...input.after, batchId },
      });

    // Updates go first, so a member renamed under its Intranet id frees its
    // acronym before an entry that takes it is inserted. When several
    // members change acronym, a chain or a swap would trip the unique index
    // statement by statement: they move to a placeholder first.
    const existingById = new Map(existing.map((member) => [member.id, member]));
    const renamed = plan.update.filter(
      ({ id, values }) => existingById.get(id)?.acronym !== values.acronym,
    );
    if (renamed.length > 1) {
      for (const { id } of renamed) {
        await tx
          .update(members)
          .set({ acronym: renamePlaceholder(id) })
          .where(eq(members.id, id));
      }
    }
    for (const { id, values } of plan.update) {
      await tx
        .update(members)
        .set({ ...values, active: true, syncedAt: now })
        .where(eq(members.id, id));
      const current = existingById.get(id);
      await memberAudit({
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
        await memberAudit({
          action: AUDIT_ACTIONS.MEMBER_SYNC_CREATE,
          memberId: row.id,
          before: null,
          after: memberAuditState(row),
        });
      }
    }
    if (plan.deactivate.length > 0) {
      await tx
        .update(members)
        .set({ active: false })
        .where(inArray(members.id, plan.deactivate));
      for (const memberId of plan.deactivate) {
        await memberAudit({
          action: AUDIT_ACTIONS.MEMBER_SYNC_DEACTIVATE,
          memberId,
          before: { active: true },
          after: { active: false },
        });
      }
    }

    // The CEA's offices, against the members as the roster left them.
    const current =
      executives && executives.length > 0
        ? await tx.select().from(members)
        : [];
    const executivePlan = planExecutiveSync(executives ?? [], current);
    const currentById = new Map(current.map((member) => [member.id, member]));
    for (const { id, name } of executivePlan.rename) {
      const before = currentById.get(id);
      if (!before) continue;
      await tx.update(members).set({ name }).where(eq(members.id, id));
      await memberAudit({
        action: AUDIT_ACTIONS.MEMBER_SYNC_UPDATE,
        memberId: id,
        before: memberAuditState(before),
        after: memberAuditState({ ...before, name }),
      });
    }
    if (executivePlan.create.length > 0) {
      const created = await tx
        .insert(members)
        .values(
          executivePlan.create.map((office) => ({
            kind: "executive" as const,
            acronym: office.acronym,
            name: office.name,
            // A CEA account stands for a person's place, not an office.
            intranetId: null,
            source: "manual" as const,
            active: true,
          })),
        )
        .returning();
      for (const row of created) {
        await memberAudit({
          action: AUDIT_ACTIONS.MEMBER_SYNC_CREATE,
          memberId: row.id,
          before: null,
          after: memberAuditState(row),
        });
      }
    }

    const result: MemberSyncResult = {
      created: plan.create.length + executivePlan.create.length,
      updated: plan.update.length + executivePlan.rename.length,
      deactivated: plan.deactivate.length,
      skipped,
    };

    await recordAudit(tx, {
      ...audit,
      action: AUDIT_ACTIONS.MEMBERS_SYNC,
      targetType: "members",
      targetId: "intranet",
      after: {
        ...result,
        unchanged: plan.unchanged.length,
        skipped,
        manualConflicts: plan.manualConflicts,
        acronymConflicts: [
          ...plan.acronymConflicts,
          ...executivePlan.conflicts,
        ],
        trigger,
        // A large deactivation applied because the account confirmed it.
        confirmedDeactivation: large.length > 0,
        batchId,
      },
    });

    if (plan.manualConflicts.length > 0) {
      logWarn("members.sync", {
        reason: "roster acronyms held by manual members",
        acronyms: plan.manualConflicts,
      });
    }
    if (executivePlan.conflicts.length > 0) {
      logWarn("members.sync", {
        reason: "CEA acronyms held by another kind of member",
        acronyms: executivePlan.conflicts,
      });
    }
    if (plan.acronymConflicts.length > 0) {
      logWarn("members.sync", {
        reason: "roster acronyms kept by another intranet member",
        acronyms: plan.acronymConflicts,
      });
    }
    if (plan.replacedIds.length > 0) {
      logWarn("members.sync", {
        reason: "intranet id replaced: a new account uses the acronym",
        members: plan.replacedIds.map(({ acronym, from, to }) => ({
          acronym,
          from,
          to,
        })),
      });
    }
    logInfo("members.sync", { ...result, trigger });
    return { status: "applied", result };
  });
}
