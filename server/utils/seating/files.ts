import { join } from "node:path";
import { getUploadDir } from "../core/uploadPaths";
import type { SeatingImageKind } from "./intranet";

/**
 * The cached images of the seating view: one 192 × 192 WebP per account
 * logo and per attendee photo, under UPLOAD_STORAGE_DIR/seating/<planId>/,
 * named by kind, row id and the Intranet's version (`photo-<id>-<v>.webp`),
 * so a new version is a new name and the browser may keep each one forever.
 * Pure but for the paths.
 */

/** `logo-<group id>-<version>.webp` or `photo-<person id>-<version>.webp`. */
export const SEATING_IMAGE_FILE_PATTERN =
  /^(logo|photo)-([a-z0-9]{20,32})-([a-z0-9]{1,64})\.webp$/;

/** An Intranet image version that may name a file. */
export const SEATING_IMAGE_VERSION_PATTERN = /^[a-z0-9]{1,64}$/;

export interface SeatingImageFile {
  kind: SeatingImageKind;
  id: string;
  version: string;
}

export function seatingImageFileName(file: SeatingImageFile): string {
  const name = `${file.kind}-${file.id}-${file.version}.webp`;
  if (!SEATING_IMAGE_FILE_PATTERN.test(name)) {
    throw new RangeError("Invalid seating image file name");
  }
  return name;
}

/** The parts of a file name, or null for anything that is not one. */
export function parseSeatingImageFileName(
  name: string,
): SeatingImageFile | null {
  const match = SEATING_IMAGE_FILE_PATTERN.exec(name);
  if (!match) return null;
  return {
    kind: match[1] as SeatingImageKind,
    id: match[2]!,
    version: match[3]!,
  };
}

/** Plan ids are cuid2: never a path of their own. */
const PLAN_ID_PATTERN = /^[a-z0-9]{20,32}$/;

/** Where a plan's images live. */
export function seatingImageDir(planId: string): string {
  if (!PLAN_ID_PATTERN.test(planId)) {
    throw new RangeError("Invalid seating plan id");
  }
  return join(getUploadDir(), "seating", planId);
}

/** The path of one cached image, or null for a name that is not one. */
export function seatingImagePath(planId: string, name: string): string | null {
  return parseSeatingImageFileName(name)
    ? join(seatingImageDir(planId), name)
    : null;
}

/** The URL the platform serves an image at (by the assembly's id). */
export function seatingImageUrl(assemblyId: string, name: string): string {
  return `/api/assemblies/${encodeURIComponent(assemblyId)}/seating/images/${encodeURIComponent(name)}`;
}
