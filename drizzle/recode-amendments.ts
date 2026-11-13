/**
 * Gives every presented amendment the code of today's rule
 * (planAmendmentCodes in shared/utils/amendmentCode.ts): the prefix of its
 * main author now, the same acronym its avatar reads ("UGR", "ANEM", "CEA"),
 * and its place among that prefix's amendments of the document, by the
 * number they have and then in the order they were presented, with no space
 * ("UGR1"; "SIUEH 4" becomes "SIUEH4"). Amendments presented before
 * the rule were numbered on publication ("CGEUGR 1") or not at all.
 *
 * A council's prefix is its university's acronym, which only the roster sync
 * brings: run it after "Sincronizar" in Miembros, or the councils keep their
 * own acronym ("CGEUGR1").
 *
 *   pnpm db:recode-amendments --dry-run   prints what would change, writes nothing
 *   pnpm db:recode-amendments             applies it
 *
 * In production: `docker compose run -T --rm --no-deps <app>
 * /app/ops/recode-amendments.mjs [--dry-run]` (DEPLOYMENT.md).
 *
 * One transaction per document, under the document's row lock, its
 * amendments' row locks and the numbering lock of
 * server/utils/domain/amendments.ts (the order presenting and publishing
 * take them in), so an amendment presented or published meanwhile waits. Rows that change
 * go first to a temporary code, so the unique index never sees one code
 * twice. The events that carry an amendment's old code (its presentation,
 * its validation, a transactional closed by it) take the new one, so the
 * history reads the codes everyone knows. Each document that changed gets
 * one `amendments.recode` audit row (source import). Running it again changes
 * nothing.
 *
 * Runs under tsx, outside Nuxt, like the seed: import only from `shared/**`,
 * `server/db/schema` and `server/utils/domain/audit.ts`, with relative paths.
 */
import "dotenv/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../server/db/schema";
import { recordAudit } from "../server/utils/domain/audit";
import { AUDIT_ACTIONS } from "../shared/constants/activity";
import {
  amendmentCodePrefix,
  planAmendmentCodes,
  type CodedAmendment,
} from "../shared/utils/amendmentCode";
import { requireConfigString } from "../shared/utils/config";

type Db = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The amendments of a document with the code prefix of their main author. */
async function loadCoded(
  tx: Tx,
  documentId: string,
): Promise<CodedAmendment[]> {
  const rows = await tx
    .select({
      id: schema.amendments.id,
      kind: schema.amendments.kind,
      status: schema.amendments.status,
      number: schema.amendments.number,
      memberSeq: schema.amendments.memberSeq,
      code: schema.amendments.code,
      submittedAt: schema.amendments.submittedAt,
      createdAt: schema.amendments.createdAt,
      meta: schema.amendments.meta,
    })
    .from(schema.amendments)
    .where(eq(schema.amendments.documentId, documentId));
  if (rows.length === 0) return [];
  const authors = await tx
    .select({
      amendmentId: schema.amendmentAuthors.amendmentId,
      memberId: schema.amendmentAuthors.memberId,
    })
    .from(schema.amendmentAuthors)
    .where(
      inArray(
        schema.amendmentAuthors.amendmentId,
        rows.map((row) => row.id),
      ),
    );
  const members = await tx
    .select({
      id: schema.members.id,
      acronym: schema.members.acronym,
      kind: schema.members.kind,
      universityAcronym: schema.members.universityAcronym,
    })
    .from(schema.members);
  const memberById = new Map(members.map((member) => [member.id, member]));
  return rows.map((row) => {
    const own = authors.filter((author) => author.amendmentId === row.id);
    // The main author: the stored one, or the only author.
    const mainId =
      (row.meta as { presentingMemberId?: string } | null)
        ?.presentingMemberId ?? (own.length === 1 ? own[0]!.memberId : null);
    const main = mainId ? memberById.get(mainId) : undefined;
    return {
      id: row.id,
      transactional: row.kind === "transactional",
      status: row.status,
      number: row.number,
      memberSeq: row.memberSeq,
      code: row.code,
      submittedAt: row.submittedAt,
      createdAt: row.createdAt,
      prefix: main ? amendmentCodePrefix(main) : null,
    };
  });
}

async function recodeDocument(
  db: Db,
  document: { id: string; title: string; assemblyId: string },
  dryRun: boolean,
): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select 1 from ${schema.documents} where ${schema.documents.id} = ${document.id} for update`,
    );
    // Its amendments before the numbering lock, the order presenting and
    // publishing take them in, so they never wait on each other.
    await tx.execute(
      sql`select 1 from ${schema.amendments} where ${schema.amendments.documentId} = ${document.id} order by ${schema.amendments.id} for update`,
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`amendment_numbering:${document.id}`}))`,
    );
    const changes = planAmendmentCodes(await loadCoded(tx, document.id));
    if (changes.length === 0) return 0;

    console.log(`${document.title}:`);
    for (const change of changes) {
      console.log(
        `  ${change.previousCode ?? "(sin número)"} -> ${change.code}`,
      );
    }
    if (dryRun) return changes.length;

    for (const change of changes) {
      await tx
        .update(schema.amendments)
        .set({ code: `__recode__${change.id}` })
        .where(eq(schema.amendments.id, change.id));
    }
    for (const change of changes) {
      await tx
        .update(schema.amendments)
        .set({
          number: change.number,
          memberSeq: change.memberSeq,
          code: change.code,
        })
        .where(eq(schema.amendments.id, change.id));
      if (change.previousCode === null) continue;
      // The amendment's own events that name its old code.
      await tx
        .update(schema.events)
        .set({
          payload: sql`jsonb_set(${schema.events.payload}, '{code}', to_jsonb(${change.code}::text))`,
        })
        .where(
          and(
            eq(schema.events.entityType, "amendment"),
            eq(schema.events.entityId, change.id),
            sql`${schema.events.payload}->>'code' = ${change.previousCode}`,
          ),
        );
      // Transactionals closed or reopened by it name it as their source.
      await tx
        .update(schema.events)
        .set({
          payload: sql`jsonb_set(${schema.events.payload}, '{sourceCode}', to_jsonb(${change.code}::text))`,
        })
        .where(
          and(
            sql`${schema.events.payload}->>'sourceId' = ${change.id}`,
            sql`${schema.events.payload}->>'sourceCode' = ${change.previousCode}`,
          ),
        );
    }
    await recordAudit(tx, {
      actor: null,
      source: "import",
      action: AUDIT_ACTIONS.AMENDMENTS_RECODE,
      targetType: "document",
      targetId: document.id,
      assemblyId: document.assemblyId,
      after: {
        count: changes.length,
        amendments: changes.map((change) => ({
          id: change.id,
          from: change.previousCode,
          to: change.code,
        })),
      },
    });
    return changes.length;
  });
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const db = drizzle(
    requireConfigString(process.env.DATABASE_URL, "DATABASE_URL"),
    { schema },
  );
  try {
    const documents = await db
      .selectDistinct({
        id: schema.documents.id,
        title: schema.documents.title,
        assemblyId: schema.documents.assemblyId,
        createdAt: schema.documents.createdAt,
      })
      .from(schema.documents)
      .innerJoin(
        schema.amendments,
        eq(schema.amendments.documentId, schema.documents.id),
      )
      .orderBy(asc(schema.documents.createdAt), asc(schema.documents.id));
    let total = 0;
    for (const document of documents) {
      total += await recodeDocument(db, document, dryRun);
    }
    console.log(
      dryRun
        ? `Dry run: ${total} amendments would get a new code. Nothing written.`
        : `${total} amendments got a new code.`,
    );
  } finally {
    await db.$client.end();
  }
}

/** True when run directly, false when imported (tests). */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalize = (path: string) => {
    const absolute = resolve(path).replace(/\.[cm]?[jt]s$/, "");
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  };
  return normalize(fileURLToPath(import.meta.url)) === normalize(entry);
}

if (isEntryPoint()) {
  main().catch((error) => {
    console.error("Recode failed:", error);
    process.exit(1);
  });
}
