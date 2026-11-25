import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { ENTITY_ID_PATTERN } from "~~/shared/utils/schemas/primitives";
import { logError } from "../../core/logger";
import type { ExportLocale } from "../labels";
import { getExportStorageDir } from "../storage";
import type { PackageIncludes } from "./plan";

/**
 * Where the documentation packages live, under EXPORT_STORAGE_DIR:
 *
 *   packages/<assemblyId>/pieces/<key>.pdf|.docx   rendered pieces, by key
 *   packages/<assemblyId>/<locale>-<variant>-<fingerprint>.zip
 *   packages/<assemblyId>/<locale>-<variant>.json  the last ZIP built
 *
 * Everything here can be built again from the database and the uploads, so
 * it needs no backup. Files are written under a temporary name and renamed,
 * so a reader never sees half a file.
 */

/** Which package of a language: with the Word versions, and how text aligns. */
export interface PackageFormat {
  /** Adds the Word version of every text. */
  editable: boolean;
  /** PDFs with justified text (the default) or aligned to the left. */
  justified: boolean;
}

export const PACKAGE_VARIANTS = [
  "pdf",
  "editable",
  "pdf-ragged",
  "editable-ragged",
] as const;
export type PackageVariant = (typeof PACKAGE_VARIANTS)[number];

export function packageVariant(format: PackageFormat): PackageVariant {
  const base = format.editable ? "editable" : "pdf";
  return format.justified ? base : `${base}-ragged`;
}

const KEY = /^[a-z0-9:._-]{1,120}$/i;

export function packagesDir(): string {
  return join(getExportStorageDir(), "packages");
}

export function assemblyPackageDir(assemblyId: string): string {
  // Assembly ids are cuid2: never a path of their own.
  if (!ENTITY_ID_PATTERN.test(assemblyId)) {
    throw new Error("Invalid assembly id");
  }
  return join(packagesDir(), assemblyId);
}

export function piecesDir(assemblyId: string): string {
  return join(assemblyPackageDir(assemblyId), "pieces");
}

export function piecePath(
  assemblyId: string,
  key: string,
  extension: "pdf" | "docx",
): string {
  if (!KEY.test(key) || key.includes(":")) throw new Error("Invalid piece key");
  return join(piecesDir(assemblyId), `${key}.${extension}`);
}

function stateName(locale: ExportLocale, variant: PackageVariant): string {
  return `${locale}-${variant}`;
}

export function zipFileName(
  locale: ExportLocale,
  variant: PackageVariant,
  fingerprint: string,
): string {
  return `${stateName(locale, variant)}-${fingerprint}.zip`;
}

const stateSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{32}$/),
  zipFile: z.string().regex(/^[a-z]{2}-(pdf|editable)-[a-f0-9]{32}\.zip$/),
  /** The root folder, which names the download. */
  root: z.string().min(1).max(200),
  builtAt: z.string(),
  bytes: z.number().int().min(0),
  includes: z.object({
    documents: z.array(
      z.object({
        id: z.string(),
        baseVersionId: z.string().nullable(),
        consolidatedVersionId: z.string().nullable(),
        fileUrl: z.string().nullable(),
      }),
    ),
    amendmentIds: z.array(z.string()),
    convocationFileUrl: z.string().nullable(),
  }),
  /** Keys of the rendered pieces the ZIP holds, kept while it is the last. */
  pieces: z.array(z.string()),
});

export type PackageState = z.infer<typeof stateSchema> & {
  includes: PackageIncludes;
};

export async function readPackageState(
  assemblyId: string,
  locale: ExportLocale,
  variant: PackageVariant,
): Promise<PackageState | null> {
  try {
    const raw = await readFile(
      join(
        assemblyPackageDir(assemblyId),
        `${stateName(locale, variant)}.json`,
      ),
      "utf8",
    );
    const parsed = stateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logError("package.state", error);
    }
    return null;
  }
}

/** Writes `data` to `path` through a temporary file in the same folder. */
export async function writeAtomically(
  path: string,
  data: string | Buffer,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, path);
}

export async function writePackageState(
  assemblyId: string,
  locale: ExportLocale,
  variant: PackageVariant,
  state: PackageState,
): Promise<void> {
  await writeAtomically(
    join(assemblyPackageDir(assemblyId), `${stateName(locale, variant)}.json`),
    JSON.stringify(state),
  );
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function ensurePackageDirs(assemblyId: string): Promise<void> {
  await mkdir(piecesDir(assemblyId), { recursive: true });
}

/**
 * Removes what no state names any more: the older ZIPs and the pieces that
 * no last ZIP holds, and leftovers of builds that stopped half way. A file
 * a download still reads may refuse to go (Windows); it goes next time.
 */
export async function sweepPackageDir(assemblyId: string): Promise<void> {
  const dir = assemblyPackageDir(assemblyId);
  const states = await Promise.all(
    (["es", "en"] as const).flatMap((locale) =>
      PACKAGE_VARIANTS.map((variant) =>
        readPackageState(assemblyId, locale, variant),
      ),
    ),
  );
  const zips = new Set(
    states.flatMap((state) => (state ? [state.zipFile] : [])),
  );
  const pieces = new Set(states.flatMap((state) => state?.pieces ?? []));
  const remove = async (path: string) => {
    try {
      await unlink(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT" && code !== "EBUSY" && code !== "EPERM") {
        logError("package.sweep", error);
      }
    }
  };
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (name.endsWith(".tmp")) await remove(join(dir, name));
    else if (name.endsWith(".zip") && !zips.has(name)) {
      await remove(join(dir, name));
    }
  }
  const piecesPath = piecesDir(assemblyId);
  for (const name of await readdir(piecesPath).catch(() => [] as string[])) {
    const key = name.replace(/\.(pdf|docx|tmp)$/, "").replace(/\..*$/, "");
    if (name.endsWith(".tmp") || !pieces.has(key)) {
      await remove(join(piecesPath, name));
    }
  }
}

/** Everything of an assembly's packages, when the assembly goes. */
export async function removeAssemblyPackages(
  assemblyId: string,
): Promise<void> {
  try {
    await rm(assemblyPackageDir(assemblyId), { recursive: true, force: true });
  } catch (error) {
    logError("package.remove", error);
  }
}
