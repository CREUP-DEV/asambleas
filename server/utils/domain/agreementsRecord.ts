import { fail } from "../core/http";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
  agreementRecordTexts,
  assemblies,
  documents,
  documentVersions,
  members,
  votes,
} from "../../db/schema";
import { agendaChildGroups } from "~~/shared/utils/agendaNumbering";
import {
  agreementsRecord,
  agreementsRecordBlocks,
  dropSignatureSpacers,
  type AgreementsRecord,
  type AgreementsRecordInput,
  type RecordItem,
  type RecordItemVote,
  type RecordText,
} from "~~/shared/utils/agreementsRecord";
import type { SheetVote } from "~~/shared/utils/controlSheet";
import { blocksSchema } from "~~/shared/utils/schemas/content";
import type {
  AgreementRecordTextBody,
  AgreementsRecordDto,
} from "~~/shared/types/api";
import type { Block } from "~~/shared/types/content";
import { logError } from "../core/logger";
import { assertOptimisticLock, STALE_WRITE_DATA } from "../optimisticLock";
import { loadPublishedAgenda } from "../export/buildData";
import { canManageDocuments, type Actor } from "./actor";
import type { AssemblyRow } from "./assemblies";
import { createDocuments } from "./documentCreate";
import {
  assignReference,
  hashBlocks,
  lockDocument,
  nextVersionNumber,
  type DocumentRow,
} from "./documents";
import { recordEvent, type Executor } from "./events";
import {
  clearSigning,
  loadSigningDto,
  removeSigningFiles,
} from "./agreementsSigning";

/**
 * The acta de acuerdos as a document of the platform (user's decisions of
 * 2026-11-21): the Secretaría creates it once, under the agenda item where
 * the assembly reads and approves it, and from then on the platform writes
 * its text from the votes (shared/utils/agreementsRecord.ts) and the
 * Secretaría's corrections (agreement_record_texts).
 *
 * - It is a published `minutes` text, voted and never amendable, marked
 *   `documents.generated`. Nothing anchors to its base, so a new base
 *   replaces the old one whenever what it says changes (and its working
 *   copy follows, for a frozen text never reads it); every other published
 *   base stays immutable.
 * - After every committed change of the assembly, a quiet spell later
 *   (server/plugins/agreements-record.ts), and at once after a correction.
 *   Nothing changes when the text is the same.
 * - Its own final vote freezes it. Once that vote approves it, the text is
 *   written one last time as a new consolidated version replacing the
 *   voted one, to add the agreement that approves the record itself; then
 *   nothing changes it but a correction of form.
 * - Built only from what an account that sees only what is public reads
 *   (loadPublishedAgenda): published documents, listed items, no withheld
 *   title.
 */

export const AGREEMENTS_RECORD = "agreements_record" as const;

const STALE_TEXT_MESSAGE =
  "Otra persona ha cambiado esta corrección. Recarga el acta";

/** The note of the version that adds the record's own approval. */
const SELF_APPROVAL_NOTE = "Acuerdo de aprobación del acta";

function sheetVote(row: typeof votes.$inferSelect): SheetVote {
  return {
    method: row.method,
    result: row.result,
    inFavor: row.inFavor,
    against: row.against,
    abstentions: row.abstentions,
    blank: row.blank,
    invalid: row.invalid,
    unanimous: row.unanimous,
  };
}

/** The assembly's record, or null before the Secretaría creates it. */
export async function findAgreementsRecord(
  assemblyId: string,
  executor: Executor = db,
): Promise<DocumentRow | null> {
  const [row] = await executor
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.assemblyId, assemblyId),
        eq(documents.generated, AGREEMENTS_RECORD),
      ),
    );
  return row ?? null;
}

/** The office that certifies: the Secretaría Ejecutiva of the roster. */
async function secretaryOffice(): Promise<{
  id: string;
  holderName: string | null;
} | null> {
  const [row] = await db
    .select({ id: members.id, holderName: members.holderName })
    .from(members)
    .where(and(eq(members.kind, "executive"), eq(members.acronym, "SE")));
  return row ?? null;
}

async function loadTexts(
  assemblyId: string,
): Promise<(typeof agreementRecordTexts.$inferSelect)[]> {
  return db
    .select()
    .from(agreementRecordTexts)
    .where(eq(agreementRecordTexts.assemblyId, assemblyId));
}

/** Everything the record is worded from, as the public reads it. */
async function loadRecordInput(
  assembly: AssemblyRow,
  self: DocumentRow | null,
): Promise<AgreementsRecordInput> {
  const [published, voteRows, office, textRows] = await Promise.all([
    loadPublishedAgenda(assembly.id),
    db
      .select()
      .from(votes)
      .where(
        and(
          eq(votes.assemblyId, assembly.id),
          eq(votes.subjectType, "agenda_item"),
        ),
      ),
    secretaryOffice(),
    loadTexts(assembly.id),
  ]);
  const { agendaRows, documentRows, agenda } = published;

  // The agenda in reading order, depth first.
  const children = agendaChildGroups(agendaRows);
  const items: RecordItem[] = [];
  const walk = (parentId: string | null) => {
    for (const row of children.get(parentId) ?? []) {
      items.push({
        id: row.id,
        parentId,
        title: "titleHidden" in row && row.titleHidden ? "" : row.title,
        listed: (agenda.numbering.get(row.id) ?? null) !== null,
      });
      walk(row.id);
    }
  };
  walk(null);

  const finalIds = documentRows
    .map((document) => document.finalVoteId)
    .concat(self?.finalVoteId ?? null)
    .filter((id): id is string => Boolean(id));
  const finalRows =
    finalIds.length > 0
      ? await db.select().from(votes).where(inArray(votes.id, finalIds))
      : [];
  const finalVotes = new Map(finalRows.map((row) => [row.id, sheetVote(row)]));

  const itemVotes: RecordItemVote[] = voteRows.map((row) => ({
    ...sheetVote(row),
    id: row.id,
    subjectId: row.subjectId,
    recordedAt: row.recordedAt.toISOString(),
    voidedAt: row.voidedAt?.toISOString() ?? null,
    election: row.election
      ? {
          candidates: row.election.candidates,
          elected: row.election.elected,
        }
      : null,
  }));

  const texts = new Map<string, RecordText>(
    textRows.map((row) => [row.key, { text: row.text, omitted: row.omitted }]),
  );

  return {
    assembly: {
      number: assembly.number,
      type: assembly.type,
      startDate: assembly.startDate,
      location: assembly.location,
    },
    items,
    documents: documentRows.map((document) => ({
      id: document.id,
      agendaItemId: document.agendaItemId,
      kind: document.kind,
      title: document.title,
      status: document.status,
      voted: document.voted,
      finalVote: document.finalVoteId
        ? (finalVotes.get(document.finalVoteId) ?? null)
        : null,
    })),
    itemVotes,
    selfDocumentId: self?.id ?? null,
    selfVote: self?.finalVoteId
      ? (finalVotes.get(self.finalVoteId) ?? null)
      : null,
    secretaryName: office?.holderName ?? null,
    texts,
  };
}

/** The record and its text, as they read now. */
export async function buildRecord(
  assembly: AssemblyRow,
  self: DocumentRow | null,
): Promise<{ record: AgreementsRecord; blocks: Block[] }> {
  const input = await loadRecordInput(assembly, self);
  const record = agreementsRecord(input);
  // Through the schema, so the stored form and its hash are the canonical ones.
  const blocks = blocksSchema.parse(
    agreementsRecordBlocks(record, input.assembly),
  );
  return { record, blocks };
}

/**
 * Whether the record's text no longer follows the votes: its own final vote
 * rejected it, or already gave its last version.
 */
export async function isFrozen(
  executor: Executor,
  document: DocumentRow,
): Promise<boolean> {
  if (!document.finalVoteId) return false;
  const [vote] = await executor
    .select({ result: votes.result })
    .from(votes)
    .where(eq(votes.id, document.finalVoteId));
  if (vote?.result !== "approved") return true;
  if (!document.consolidatedVersionId) return true;
  const [consolidated] = await executor
    .select({ replaces: documentVersions.replacesVersionId })
    .from(documentVersions)
    .where(eq(documentVersions.id, document.consolidatedVersionId));
  return Boolean(consolidated?.replaces);
}

/**
 * Writes the record's text again from the votes and the corrections, when
 * it changed. Returns whether it wrote. Never throws for a record that is
 * gone or frozen.
 */
export async function regenerateAgreementsRecord(
  assemblyId: string,
): Promise<boolean> {
  const found = await findAgreementsRecord(assemblyId);
  if (!found || found.format !== "structured" || found.status !== "published")
    return false;
  if (await isFrozen(db, found)) return false;
  const [assembly] = await db
    .select()
    .from(assemblies)
    .where(eq(assemblies.id, assemblyId));
  if (!assembly) return false;

  const { blocks } = await buildRecord(assembly, found);
  const contentHash = await hashBlocks(blocks);

  return db.transaction(async (tx) => {
    // NO KEY UPDATE, as every write of a document that keeps the row ("Row
    // locks" in documents.ts): it serializes with the record's final vote
    // and the other writers, and lets an insert that references the record
    // (a version, live_state) go on without waiting.
    const current = await lockDocument(tx, found.id);
    // Read again under the lock: a vote may have come in meanwhile, and
    // the next change of the assembly writes it.
    if (
      current.status !== "published" ||
      current.finalVoteId !== found.finalVoteId ||
      (await isFrozen(tx, current))
    ) {
      return false;
    }

    if (!current.finalVoteId) {
      const [base] = current.baseVersionId
        ? await tx
            .select({ contentHash: documentVersions.contentHash })
            .from(documentVersions)
            .where(eq(documentVersions.id, current.baseVersionId))
        : [];
      if (base?.contentHash === contentHash) return false;
      const [version] = await tx
        .insert(documentVersions)
        .values({
          documentId: current.id,
          number: await nextVersionNumber(tx, current.id),
          kind: "base",
          blocks,
          contentHash,
        })
        .returning({ id: documentVersions.id });
      if (current.workingVersionId) {
        await tx
          .update(documentVersions)
          .set({ blocks, contentHash })
          .where(
            and(
              eq(documentVersions.id, current.workingVersionId),
              eq(documentVersions.kind, "draft"),
            ),
          );
      }
      await tx
        .update(documents)
        .set({ baseVersionId: version!.id })
        .where(eq(documents.id, current.id));
    } else {
      // Approved: once, the version that adds the record's own approval.
      const [consolidated] = await tx
        .select({ contentHash: documentVersions.contentHash })
        .from(documentVersions)
        .where(eq(documentVersions.id, current.consolidatedVersionId!));
      if (consolidated?.contentHash === contentHash) return false;
      const [version] = await tx
        .insert(documentVersions)
        .values({
          documentId: current.id,
          number: await nextVersionNumber(tx, current.id),
          kind: "consolidated",
          blocks,
          contentHash,
          note: SELF_APPROVAL_NOTE,
          replacesVersionId: current.consolidatedVersionId,
        })
        .returning({ id: documentVersions.id });
      await tx
        .update(documents)
        .set({ consolidatedVersionId: version!.id })
        .where(eq(documents.id, current.id));
    }

    // Its own type, not `document_content_updated`: it comes after every
    // item vote, election and final vote, and the room's filters
    // (app/composables/assembly/-liveFilters.ts) know it changes neither
    // the AssemblyDto nor the titles Directo reads, so the room does not
    // fetch them all again a second time per vote.
    await recordEvent(tx, {
      assemblyId,
      entityType: "document",
      entityId: current.id,
      documentId: current.id,
      type: "agreements_record_updated",
      payload: {
        contentHash,
        blockCount: blocks.length,
        generated: AGREEMENTS_RECORD,
      },
      actor: null,
    });
    return true;
  });
}

/** Only document managers (the Secretaría) read and correct the record. */
export function requireRecordManager(actor: Actor): void {
  if (!canManageDocuments(actor)) {
    fail(403, "No tienes permiso para gestionar el acta de acuerdos");
  }
}

/** Whether the record's own final vote approved it. */
export async function isApproved(
  executor: Executor,
  document: DocumentRow,
): Promise<boolean> {
  if (!document.finalVoteId || !document.consolidatedVersionId) return false;
  const [vote] = await executor
    .select({ result: votes.result })
    .from(votes)
    .where(eq(votes.id, document.finalVoteId));
  return vote?.result === "approved";
}

/**
 * The hash of the text in force (the consolidated one once voted), as the
 * record words it now: the empty `ar-signature-*` paragraphs versions
 * written before 2026-11-23 kept for the signature are left out, so such a
 * version without corrections does not read as outdated.
 */
async function inForceHash(
  executor: Executor,
  document: DocumentRow,
): Promise<string | null> {
  const versionId = document.consolidatedVersionId ?? document.baseVersionId;
  if (!versionId) return null;
  const [version] = await executor
    .select({
      contentHash: documentVersions.contentHash,
      blocks: documentVersions.blocks,
    })
    .from(documentVersions)
    .where(eq(documentVersions.id, versionId));
  if (!version) return null;
  return withoutSignatureSpacers(version.blocks, version.contentHash);
}

/** The hash of `blocks` without the old signature spacers. */
async function withoutSignatureSpacers(
  blocks: Block[],
  contentHash: string,
): Promise<string> {
  const kept = dropSignatureSpacers(blocks);
  // Through the schema, as buildRecord does: the canonical form and order
  // of keys its hash was taken over (jsonb hands them back reordered).
  return kept ? hashBlocks(blocksSchema.parse(kept)) : contentHash;
}

/** The record as the Secretaría's panel reads it. */
export async function loadAgreementsRecordDto(
  assembly: AssemblyRow,
): Promise<AgreementsRecordDto> {
  const document = await findAgreementsRecord(assembly.id);
  const [{ record, blocks }, textRows] = await Promise.all([
    buildRecord(assembly, document),
    loadTexts(assembly.id),
  ]);
  let summary: AgreementsRecordDto["document"] = null;
  if (document) {
    const [frozen, approved, hash] = await Promise.all([
      isFrozen(db, document),
      isApproved(db, document),
      inForceHash(db, document),
    ]);
    summary = {
      id: document.id,
      slug: document.slug,
      title: document.title,
      agendaItemId: document.agendaItemId,
      status: document.status,
      frozen,
      approved,
      outdated:
        frozen &&
        approved &&
        hash !== null &&
        hash !== (await hashBlocks(blocks)),
    };
  }
  return {
    document: summary,
    record,
    locks: Object.fromEntries(
      textRows.map((row) => [row.key, row.updatedAt.toISOString()]),
    ),
    signing: document ? await loadSigningDto(document) : null,
  };
}

/** The note of a version written again after a correction. */
const CORRECTION_NOTE = "Corrección del acta de acuerdos";

/**
 * Writes an approved record again from its corrections (user's decision of
 * 2026-11-23: the record is regenerated with a correction): a new
 * consolidated version replacing the one in force, as a correction of form
 * does, and its signed PDF goes, since it signs the text before; the
 * Secretaría prepares and signs it again. Only once frozen and approved
 * (before, every change writes it by itself). Nothing happens when the text
 * would be the same.
 */
export async function regenerateApprovedRecord(
  actor: Actor,
  assembly: AssemblyRow,
): Promise<AgreementsRecordDto> {
  requireRecordManager(actor);
  const found = await findAgreementsRecord(assembly.id);
  if (!found) fail(404, "La asamblea no tiene acta de acuerdos");
  if (!(await isApproved(db, found)) || !(await isFrozen(db, found))) {
    fail(
      409,
      "El acta todavía no está aprobada: hasta entonces se actualiza sola",
    );
  }
  const { blocks } = await buildRecord(assembly, found);
  const contentHash = await hashBlocks(blocks);

  const removed = await db.transaction(async (tx) => {
    const current = await lockDocument(tx, found.id);
    if (
      current.finalVoteId !== found.finalVoteId ||
      current.consolidatedVersionId !== found.consolidatedVersionId
    ) {
      fail(
        409,
        "El acta ha cambiado mientras tanto. Recarga e inténtalo de nuevo",
        STALE_WRITE_DATA,
      );
    }
    if ((await inForceHash(tx, current)) === contentHash) return null;
    const [version] = await tx
      .insert(documentVersions)
      .values({
        documentId: current.id,
        number: await nextVersionNumber(tx, current.id),
        kind: "consolidated",
        blocks,
        contentHash,
        note: CORRECTION_NOTE,
        replacesVersionId: current.consolidatedVersionId,
        createdByUserId: actor.user.id,
      })
      .returning({ id: documentVersions.id });
    await tx
      .update(documents)
      .set({ consolidatedVersionId: version!.id })
      .where(eq(documents.id, current.id));
    const files = await clearSigning(tx, current.id);
    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "document",
      entityId: current.id,
      documentId: current.id,
      type: "agreements_record_regenerated",
      payload: {
        contentHash,
        versionId: version!.id,
        signatureRemoved: files.signed !== null,
      },
      actor,
    });
    return files;
  });
  if (removed) await removeSigningFiles(removed);
  return loadAgreementsRecordDto(assembly);
}

/**
 * Creates the record under an agenda item and publishes it at once: a
 * `minutes` text presented by the Secretaría Ejecutiva, voted, never
 * amendable. One per assembly (409).
 */
export async function createAgreementsRecord(
  actor: Actor,
  assembly: AssemblyRow,
  agendaItemId: string,
): Promise<AgreementsRecordDto> {
  requireRecordManager(actor);
  if (await findAgreementsRecord(assembly.id)) {
    fail(409, "La asamblea ya tiene acta de acuerdos");
  }
  const { record, blocks } = await buildRecord(assembly, null);
  const office = await secretaryOffice();
  const [created] = await createDocuments({ actor, assembly, agendaItemId }, [
    {
      kind: "minutes",
      format: "structured",
      title: record.title,
      amendable: false,
      voted: true,
      blocks,
      ...(office ? { proponentMemberId: office.id } : {}),
    },
  ]);
  if (!created) fail(500, "No se pudo crear el acta de acuerdos");

  await db.transaction(async (tx) => {
    const current = await lockDocument(tx, created.id);
    const [working] = await tx
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.id, current.workingVersionId!));
    if (!working) fail(500, "No se pudo crear el acta de acuerdos");
    const [base] = await tx
      .insert(documentVersions)
      .values({
        documentId: current.id,
        number: await nextVersionNumber(tx, current.id),
        kind: "base",
        blocks: working.blocks,
        contentHash: working.contentHash,
        createdByUserId: actor.user.id,
      })
      .returning({ id: documentVersions.id });
    const now = new Date();
    const reference = await assignReference(tx, current.kind, now);
    await tx
      .update(documents)
      .set({
        generated: AGREEMENTS_RECORD,
        status: "published",
        publishedAt: now,
        baseVersionId: base!.id,
        reference,
      })
      .where(eq(documents.id, current.id));
    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "document",
      entityId: current.id,
      documentId: current.id,
      type: "document_published",
      payload: {
        reference,
        baseVersionId: base!.id,
        republished: false,
        from: current.status,
        generated: AGREEMENTS_RECORD,
      },
      actor,
    });
  });
  return loadAgreementsRecordDto(assembly);
}

/**
 * Saves one correction of the Secretaría (its words, or that the line is
 * left out; null words and not omitted take it back) and writes the record
 * again at once. `updatedAt` is the lock of that line's correction: null
 * when there was none.
 */
export async function saveAgreementRecordText(
  actor: Actor,
  assembly: AssemblyRow,
  body: AgreementRecordTextBody,
): Promise<AgreementsRecordDto> {
  requireRecordManager(actor);
  const text = body.text?.trim() ? body.text.trim() : null;
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(agreementRecordTexts)
      .where(
        and(
          eq(agreementRecordTexts.assemblyId, assembly.id),
          eq(agreementRecordTexts.key, body.key),
        ),
      )
      .for("update");
    // Null means there was none: a row someone wrote meanwhile is stale too.
    if (current ? !body.updatedAt : body.updatedAt) {
      fail(409, STALE_TEXT_MESSAGE, STALE_WRITE_DATA);
    }
    if (current) {
      assertOptimisticLock(
        body.updatedAt,
        current.updatedAt,
        STALE_TEXT_MESSAGE,
      );
    }
    const before = current
      ? { text: current.text, omitted: current.omitted }
      : null;
    if (text === null && !body.omitted) {
      if (!current) return;
      await tx
        .delete(agreementRecordTexts)
        .where(
          and(
            eq(agreementRecordTexts.assemblyId, assembly.id),
            eq(agreementRecordTexts.key, body.key),
          ),
        );
    } else {
      await tx
        .insert(agreementRecordTexts)
        .values({
          assemblyId: assembly.id,
          key: body.key,
          text,
          omitted: body.omitted,
          updatedByUserId: actor.user.id,
        })
        .onConflictDoUpdate({
          target: [agreementRecordTexts.assemblyId, agreementRecordTexts.key],
          set: {
            text,
            omitted: body.omitted,
            updatedByUserId: actor.user.id,
            updatedAt: new Date(),
          },
        });
    }
    // An event of the record itself, which is all a correction changes:
    // as one of the assembly it made the whole room fetch every DocumentDto
    // and the AssemblyDto again (affectsDocumentDto). Before the record is
    // created there is no document to name, and the assembly stands in.
    const document = await findAgreementsRecord(assembly.id, tx);
    await recordEvent(tx, {
      assemblyId: assembly.id,
      ...(document
        ? {
            entityType: "document" as const,
            entityId: document.id,
            documentId: document.id,
          }
        : { entityType: "assembly" as const, entityId: assembly.id }),
      type: "agreements_record_corrected",
      payload: {
        key: body.key,
        before,
        after:
          text === null && !body.omitted
            ? null
            : { text, omitted: body.omitted },
      },
      actor,
    });
  });
  try {
    await regenerateAgreementsRecord(assembly.id);
  } catch (error) {
    // The correction is saved; the next change writes the text.
    logError("agreementsRecord.regenerate", error);
  }
  return loadAgreementsRecordDto(assembly);
}
