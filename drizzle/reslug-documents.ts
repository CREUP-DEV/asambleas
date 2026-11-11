/**
 * Gives every document the URL slug of its current title under today's rule
 * (pickDocumentSlug in shared/utils/slug.ts): after the slug limit grew, the
 * documents created before keep a slug cut short until this runs. Old links
 * stop working; nothing keeps them.
 *
 *   pnpm db:reslug --dry-run   prints what would change, writes nothing
 *   pnpm db:reslug             applies it
 *
 * In production: `docker compose run -T --rm --no-deps <app>
 * /app/ops/reslug-documents.mjs [--dry-run]` (DEPLOYMENT.md).
 *
 * One transaction per assembly, under the advisory lock of
 * uniqueDocumentSlug, so a document created meanwhile cannot take a slug
 * twice. Documents are walked in creation order, each taking the first free
 * slug among the ones already settled. Rows that change go first to a
 * temporary slug and then to the final one, so the unique index never sees
 * two rows with the same slug. Each assembly that changed gets one
 * `documents.reslug` audit row (source import). Running it again changes
 * nothing.
 *
 * Runs under tsx, outside Nuxt, like the seed: import only from `shared/**`,
 * `server/db/schema` and `server/utils/domain/audit.ts`, with relative paths.
 */
import "dotenv/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../server/db/schema";
import { recordAudit } from "../server/utils/domain/audit";
import { AUDIT_ACTIONS } from "../shared/constants/activity";
import { requireConfigString } from "../shared/utils/config";
import { planDocumentSlugs } from "../shared/utils/slug";

type Db = NodePgDatabase<typeof schema>;

async function reslugAssembly(
  db: Db,
  assembly: { id: string; number: number; type: string },
  dryRun: boolean,
): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`document_slug:${assembly.id}`}))`,
    );
    const rows = await tx
      .select({
        id: schema.documents.id,
        slug: schema.documents.slug,
        title: schema.documents.title,
      })
      .from(schema.documents)
      .where(eq(schema.documents.assemblyId, assembly.id))
      .orderBy(asc(schema.documents.createdAt), asc(schema.documents.id));
    const changes = planDocumentSlugs(rows);
    if (changes.length === 0) return 0;

    console.log(`${assembly.number}.ª ${assembly.type}:`);
    for (const change of changes) {
      console.log(`  ${change.from}\n    -> ${change.to}`);
    }
    if (dryRun) return changes.length;

    for (const change of changes) {
      await tx
        .update(schema.documents)
        .set({ slug: `__reslug__${change.id}` })
        .where(eq(schema.documents.id, change.id));
    }
    for (const change of changes) {
      await tx
        .update(schema.documents)
        .set({ slug: change.to })
        .where(eq(schema.documents.id, change.id));
    }
    await recordAudit(tx, {
      actor: null,
      source: "import",
      action: AUDIT_ACTIONS.DOCUMENTS_RESLUG,
      targetType: "assembly",
      targetId: assembly.id,
      assemblyId: assembly.id,
      after: { count: changes.length, documents: changes },
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
    const assemblies = await db
      .select({
        id: schema.assemblies.id,
        number: schema.assemblies.number,
        type: schema.assemblies.type,
      })
      .from(schema.assemblies)
      .orderBy(asc(schema.assemblies.createdAt));
    let total = 0;
    for (const assembly of assemblies) {
      total += await reslugAssembly(db, assembly, dryRun);
    }
    console.log(
      dryRun
        ? `Dry run: ${total} documents would get a new slug. Nothing written.`
        : `${total} documents got a new slug.`,
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
    console.error("Reslug failed:", error);
    process.exit(1);
  });
}
