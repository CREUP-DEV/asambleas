import { createError } from "h3";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { agendaItems, documents, votes } from "../../db/schema";
import { assertOptimisticLock } from "../optimisticLock";
import { validateCuid } from "../validation";
import {
  canEditControlSheet,
  canRecordResults,
  canManageDocuments,
  canModerate,
  canViewControlSheet,
  type Actor,
} from "./actor";
import { titleDocumentPayload } from "./agendaWrites";
import { evaluateVoteInput } from "./amendments";
import type { AgendaItemRow, AssemblyRow } from "./assemblies";
import { loadReaderItems } from "./controlSheet";
import {
  assemblySettings,
  clearLiveVote,
  projectItemVote,
  shareLockAssembly,
} from "./documents";
import { recordEvent, type Executor } from "./events";
import { assertSessionOpen } from "./sessionOpen";
import { fillPresent, latestHeadcount } from "./headcounts";
import { resolveAgendaItem } from "./resolvers";
import {
  loadItemVoteRows,
  toItemVoteDto,
  toVoteDto,
  VOTE_MESSAGE_KEYS,
} from "./votes";
import type {
  ItemVoteBody,
  ItemVoteResultDto,
  ItemVotesDto,
  VoteDto,
  VoteUnanimityBody,
  VoteVoidBody,
} from "~~/shared/types/api";
import { isPublicDocumentStatus } from "~~/shared/utils/agendaSubmissions";
import {
  isItemVotedDocument,
  itemHasVotedDocuments,
} from "~~/shared/utils/controlSheet";

/**
 * Votes on an agenda item itself (a ratification, an election), subject
 * `agenda_item`: recorded by the Mesa or the control sheet's editors, put
 * on screen only by the Mesa, voided (never deleted: a voided vote stays for
 * the record) and marked unanimous. The latest one not voided gives the
 * item's result (latestItemVote in shared/utils/controlSheet.ts). An item
 * voted through its documents' final votes takes none
 * (itemHasVotedDocuments). Every write records its event (entity `vote`)
 * with no top-level documentId: the item's document, if it carries one's
 * title, goes only in the payload (titleDocumentPayload).
 */

/** Reason of the 422 a vote on an item with voted documents gets (useApi's REASON_KEYS). */
export const ITEM_HAS_VOTED_DOCUMENTS_REASON = "item_has_voted_documents";
/**
 * The same refusal, worded for someone who may not see those documents
 * (none of them is public yet), so it names none.
 */
export const ITEM_TAKES_NO_VOTE_REASON = "item_takes_no_vote";
/** `data.reason` of the 422 for an item where members present. */
export const ITEM_IS_CONTAINER_REASON = "item_is_container";

const STALE_VOTE_MESSAGE =
  "La votación ha cambiado mientras tanto. Recarga e inténtalo de nuevo";

function fail(statusCode: number, message: string, data?: unknown): never {
  throw createError({ statusCode, message, ...(data ? { data } : {}) });
}

/**
 * Recording and voiding votes on agenda items: the Mesa, the sheet's
 * editors and whoever records results (assembly:vote_result).
 */
export function canRecordItemVotes(actor: Actor): boolean {
  return canRecordResults(actor) || canEditControlSheet(actor);
}

export function requireItemVoteRecorder(actor: Actor): void {
  if (!canRecordItemVotes(actor)) {
    fail(403, "No tienes permiso para registrar votaciones de los puntos");
  }
}

/** Reading them: the Mesa and the control sheet's readers. */
export function requireItemVoteReader(actor: Actor): void {
  if (!canModerate(actor) && !canViewControlSheet(actor)) {
    fail(403, "No tienes permiso para ver las votaciones de los puntos");
  }
}

/**
 * 404 unless the actor gets the item (the sheet's rule, visibleAgendaItems).
 * The ids of the items it gets without their title come back, so a vote it
 * is answered with goes without its question as in its reads
 * (toItemVoteDto).
 */
async function requireVisibleItem(
  actor: Actor,
  assemblyId: string,
  itemId: string,
): Promise<Set<string>> {
  const { items, titleHidden } = await loadReaderItems(actor, assemblyId);
  if (!items.has(itemId)) fail(404, "Punto no encontrado");
  return titleHidden;
}

/**
 * The agenda item of the route, as the agenda endpoints resolve it, and
 * only if the actor gets it (404 otherwise).
 */
export async function resolveVotableItem(
  actor: Actor,
  assembly: AssemblyRow,
  param: string | undefined,
): Promise<AgendaItemRow> {
  const item = await resolveAgendaItem(assembly.id, param);
  await requireVisibleItem(actor, assembly.id, item.id);
  return item;
}

/** What a vote of the assembly is about, or null when it is not one of its votes. */
async function findAssemblyVote(
  assemblyId: string,
  voteId: string,
): Promise<{ subjectType: VoteDto["subjectType"]; subjectId: string } | null> {
  const [row] = await db
    .select({ subjectType: votes.subjectType, subjectId: votes.subjectId })
    .from(votes)
    .where(and(eq(votes.id, voteId), eq(votes.assemblyId, assemblyId)));
  return row ?? null;
}

/** The vote row locked NO KEY UPDATE ("Row locks" in documents.ts), or 404. */
async function lockVote(tx: Executor, assemblyId: string, voteId: string) {
  const [row] = await tx
    .select()
    .from(votes)
    .where(and(eq(votes.id, voteId), eq(votes.assemblyId, assemblyId)))
    .for("no key update");
  if (!row) fail(404, "Votación no encontrada");
  return row;
}

/** What the events of a vote on an item say about the title the item carries. */
async function itemTitlePayload(
  tx: Executor,
  itemId: string,
): Promise<ReturnType<typeof titleDocumentPayload>> {
  const [item] = await tx
    .select({
      generatedForDocumentId: agendaItems.generatedForDocumentId,
      hiddenWithDocumentId: agendaItems.hiddenWithDocumentId,
      titleWithheld: agendaItems.titleWithheld,
    })
    .from(agendaItems)
    .where(eq(agendaItems.id, itemId));
  return item ? titleDocumentPayload(item) : {};
}

/**
 * Records a vote on the agenda item (POST .../agenda/[item]/votes). Refused
 * on a draft or closed assembly (409), and while a document of the item is
 * voted (422 `item_has_voted_documents`: the item is voted through their
 * final votes; `item_takes_no_vote` for a sheet editor who is neither the
 * Mesa nor a document manager while none of them is public, so nothing
 * tells it such a document exists). It needs no «Se vota el punto». Counted
 * votes take the latest headcount as any vote (fillPresent) and a simple
 * majority unless the body names one; a tie under tieRule "repeat" answers
 * 409 `{ tie: true }` and stores nothing. Only an assent may be unanimous. With
 * `project` (the Mesa only, from the console that controls the projection)
 * it goes on screen while the projection is still on the item; `projected`
 * says whether it did, and it is stored either way.
 */
export async function recordItemVote(
  actor: Actor,
  assembly: AssemblyRow,
  item: AgendaItemRow,
  body: ItemVoteBody,
  /**
   * The request comes from the session console that controls the
   * projection (controlsProjection): only then does a vote go on screen.
   */
  options: { controlsProjection?: boolean } = {},
): Promise<ItemVoteResultDto> {
  requireItemVoteRecorder(actor);
  if (body.project && !canModerate(actor)) {
    fail(403, "Solo la Mesa proyecta las votaciones");
  }

  return db.transaction(async (tx) => {
    // The status and the latest headcount are read under this lock: status
    // and headcount writes wait for it.
    const locked = await shareLockAssembly(tx, assembly.id);
    if (!locked) fail(404, "Asamblea no encontrada");
    assertSessionOpen(locked.status);
    // Agenda writes wait for the assembly lock: the item is there until
    // this commits.
    const [current] = await tx
      .select()
      .from(agendaItems)
      .where(
        and(
          eq(agendaItems.id, item.id),
          eq(agendaItems.assemblyId, assembly.id),
        ),
      );
    if (!current) fail(404, "Punto no encontrado");
    // Members present here: each document is voted in its own sub-item.
    if (current.acceptsSubmissions) {
      fail(422, "En este punto cada documento se vota en su subpunto", {
        reason: ITEM_IS_CONTAINER_REASON,
      });
    }
    // FOR SHARE in id order, after the assembly: none of the item's
    // documents becomes voted or changes status until this commits, and a
    // document moving in waits on the assembly lock.
    const held = await tx
      .select({ voted: documents.voted, status: documents.status })
      .from(documents)
      .where(eq(documents.agendaItemId, current.id))
      .orderBy(asc(documents.id))
      .for("share");
    if (itemHasVotedDocuments(held)) {
      // A sheet editor who is neither the Mesa nor a document manager does
      // not see a document before it is public: told only that the item
      // takes no vote, so the refusal never says one is there.
      const seesEveryDocument = canModerate(actor) || canManageDocuments(actor);
      const votedPublicly = held.some(
        (document) =>
          isItemVotedDocument(document) &&
          isPublicDocumentStatus(document.status),
      );
      if (!seesEveryDocument && !votedPublicly) {
        fail(422, "Este punto no admite ahora una votación propia", {
          reason: ITEM_TAKES_NO_VOTE_REASON,
        });
      }
      fail(422, "Este punto se vota con la votación final de sus documentos", {
        reason: ITEM_HAS_VOTED_DOCUMENTS_REASON,
      });
    }

    const settings = assemblySettings(locked);
    const based = fillPresent(
      body.vote,
      body.vote.method === "assent"
        ? null
        : await latestHeadcount(assembly.id, tx),
      settings,
    );
    const vote = based.vote;
    // Agenda items have no majority of their own.
    const { majority, outcome } = evaluateVoteInput(vote, settings, "simple");

    const [row] = await tx
      .insert(votes)
      .values({
        assemblyId: assembly.id,
        subjectType: "agenda_item",
        subjectId: current.id,
        method: vote.method,
        inFavor: vote.inFavor ?? 0,
        against: vote.against ?? 0,
        abstentions: vote.abstentions ?? 0,
        blank: vote.blank ?? 0,
        invalid: vote.invalid ?? 0,
        notCast: vote.notCast ?? 0,
        present: vote.present ?? null,
        headcountId: based.headcountId,
        majority,
        result: outcome.result,
        note: vote.note || null,
        question: body.question,
        unanimous: vote.method === "assent" && vote.unanimous === true,
        recordedByUserId: actor.user.id,
      })
      .returning();

    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "vote",
      entityId: row!.id,
      type: "vote_recorded",
      payload: {
        subjectType: "agenda_item",
        subjectId: current.id,
        result: row!.result,
        ...titleDocumentPayload(current),
      },
      actor,
    });
    const projected =
      body.project === true &&
      options.controlsProjection === true &&
      (await projectItemVote(tx, {
        assemblyId: assembly.id,
        voteId: row!.id,
        agendaItemId: current.id,
        actor,
      }));

    return { vote: toVoteDto(row!), projected };
  });
}

/**
 * Voids a vote on an agenda item (DELETE .../votes/[vote]): the Mesa or the
 * sheet's editors, not once the assembly is closed, with the optimistic
 * lock on the vote. It stays, read as voided, and no longer gives the
 * item's result. Other votes are not voided here (409): they go through
 * reopening or annulling what they decided. Records `vote_voided` and stops
 * projecting it.
 */
export async function voidItemVote(
  actor: Actor,
  assembly: AssemblyRow,
  voteParam: string | undefined,
  body: VoteVoidBody,
): Promise<VoteDto> {
  requireItemVoteRecorder(actor);
  const voteId = validateCuid(voteParam, "Votación");
  const stored = await findAssemblyVote(assembly.id, voteId);
  if (!stored) fail(404, "Votación no encontrada");
  if (stored.subjectType !== "agenda_item") {
    fail(409, "Esta votación se anula desde lo que decidió", {
      messageKey: VOTE_MESSAGE_KEYS.notVoidable,
    });
  }
  const titleHidden = await requireVisibleItem(
    actor,
    assembly.id,
    stored.subjectId,
  );

  return db.transaction(async (tx) => {
    const locked = await shareLockAssembly(tx, assembly.id);
    if (!locked) fail(404, "Asamblea no encontrada");
    if (locked.status === "closed") {
      fail(409, "La asamblea ya está cerrada", {
        messageKey: VOTE_MESSAGE_KEYS.closed,
      });
    }
    const vote = await lockVote(tx, assembly.id, voteId);
    if (vote.voidedAt) {
      fail(409, "Esta votación ya está anulada", {
        messageKey: VOTE_MESSAGE_KEYS.voided,
      });
    }
    // Also stale when its document moved it to another item meanwhile.
    assertOptimisticLock(body.updatedAt, vote.updatedAt, STALE_VOTE_MESSAGE);

    const [updated] = await tx
      .update(votes)
      .set({ voidedAt: sql`now()`, voidedByUserId: actor.user.id })
      .where(eq(votes.id, vote.id))
      .returning();
    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "vote",
      entityId: vote.id,
      type: "vote_voided",
      payload: {
        subjectType: vote.subjectType,
        subjectId: vote.subjectId,
        result: vote.result,
        ...(await itemTitlePayload(tx, vote.subjectId)),
      },
      actor,
    });
    await clearLiveVote(tx, {
      assemblyId: assembly.id,
      voteId: vote.id,
      actor,
    });
    return toItemVoteDto(updated!, titleHidden);
  });
}

/**
 * Marks an assent vote in force as unanimous (nobody objected when
 * unanimity was asked), or takes it back (PATCH .../votes/[vote]/unanimity),
 * not once the assembly is closed, with the optimistic lock on the vote. In
 * force: a vote on an agenda item not voided (the Mesa or the sheet's
 * editors), or a document's final vote its document still points at (the
 * Mesa). Any other vote, or one that is not an assent, is refused (422).
 * Records `vote_unanimity_changed`; a document's carries its documentId, so
 * its pages refresh.
 */
export async function setVoteUnanimity(
  actor: Actor,
  assembly: AssemblyRow,
  voteParam: string | undefined,
  body: VoteUnanimityBody,
): Promise<VoteDto> {
  // Only the Mesa and the sheet's editors ever change it: whoever else asks
  // learns nothing of the vote.
  requireItemVoteRecorder(actor);
  const voteId = validateCuid(voteParam, "Votación");
  const stored = await findAssemblyVote(assembly.id, voteId);
  if (!stored) fail(404, "Votación no encontrada");
  let titleHidden: ReadonlySet<string> = new Set();
  if (stored.subjectType === "agenda_item") {
    titleHidden = await requireVisibleItem(
      actor,
      assembly.id,
      stored.subjectId,
    );
  } else if (stored.subjectType === "document") {
    // A final vote is on a published document: whoever sees the assembly
    // sees it.
    if (!canModerate(actor)) {
      fail(403, "Solo la Mesa cambia la unanimidad de una votación final");
    }
  } else {
    fail(422, "Esta votación no se marca como unánime", {
      messageKey: VOTE_MESSAGE_KEYS.unanimityRefused,
    });
  }

  return db.transaction(async (tx) => {
    const locked = await shareLockAssembly(tx, assembly.id);
    if (!locked) fail(404, "Asamblea no encontrada");
    if (locked.status === "closed") {
      fail(409, "La asamblea ya está cerrada", {
        messageKey: VOTE_MESSAGE_KEYS.closed,
      });
    }
    // The document before the vote row ("Row locks"): annulling its final
    // vote waits until this commits.
    let pointedAt = true;
    if (stored.subjectType === "document") {
      const [document] = await tx
        .select({ finalVoteId: documents.finalVoteId })
        .from(documents)
        .where(
          and(
            eq(documents.id, stored.subjectId),
            eq(documents.assemblyId, assembly.id),
          ),
        )
        .for("share");
      pointedAt = document?.finalVoteId === voteId;
    }
    const vote = await lockVote(tx, assembly.id, voteId);
    if (vote.method !== "assent") {
      fail(422, "Solo una votación por asentimiento puede ser unánime", {
        messageKey: VOTE_MESSAGE_KEYS.unanimityRefused,
      });
    }
    if (vote.voidedAt || !pointedAt) {
      fail(409, "Esta votación ya no está en vigor", {
        messageKey: VOTE_MESSAGE_KEYS.notInForce,
      });
    }
    assertOptimisticLock(body.updatedAt, vote.updatedAt, STALE_VOTE_MESSAGE);
    if (vote.unanimous === body.unanimous) {
      return toItemVoteDto(vote, titleHidden);
    }

    const [updated] = await tx
      .update(votes)
      .set({ unanimous: body.unanimous })
      .where(eq(votes.id, vote.id))
      .returning();
    const isDocument = vote.subjectType === "document";
    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "vote",
      entityId: vote.id,
      ...(isDocument ? { documentId: vote.subjectId } : {}),
      type: "vote_unanimity_changed",
      payload: {
        subjectType: vote.subjectType,
        subjectId: vote.subjectId,
        unanimous: body.unanimous,
        ...(isDocument ? {} : await itemTitlePayload(tx, vote.subjectId)),
      },
      actor,
    });
    return toItemVoteDto(updated!, titleHidden);
  });
}

/**
 * The votes on agenda items the actor gets, voided ones too, oldest first
 * (GET .../item-votes): the Mesa or the control sheet's readers. One on an
 * item the actor gets without its title comes without its question.
 */
export async function loadItemVotes(
  actor: Actor,
  assembly: AssemblyRow,
): Promise<ItemVotesDto> {
  requireItemVoteReader(actor);
  const [{ items, titleHidden }, rows] = await Promise.all([
    loadReaderItems(actor, assembly.id),
    loadItemVoteRows(assembly.id),
  ]);
  // The control sheet's rule (loadControlSheet): only the items the reader
  // gets, and no question on one it gets without its title.
  return {
    votes: rows
      .filter((row) => items.has(row.subjectId))
      .map((row) => toItemVoteDto(row, titleHidden)),
  };
}
