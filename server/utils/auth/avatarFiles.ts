import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  USER_ID_PATTERN,
  USER_ID_SOURCE,
} from "~~/shared/utils/schemas/primitives";
import { getUploadDir } from "../core/uploadPaths";
import { logError } from "../core/logger";

/**
 * The accounts' photos as the platform stores them (user_avatars,
 * server/utils/auth/avatars.ts): one 192 × 192 WebP per account under
 * UPLOAD_STORAGE_DIR/avatars/, named by the account's id and the version of
 * the Google picture it came from (`<userId>-<version>.webp`), so a new
 * picture is a new name and the browser may keep each one for good. Pure
 * but for the paths and the removal of files.
 */

/** Only Google's photo host: the one better-auth stores (`users.image`). */
export const AVATAR_SOURCE_HOSTS: ReadonlySet<string> = new Set([
  "lh3.googleusercontent.com",
]);

/** Longer `users.image` values are never fetched. */
const AVATAR_SOURCE_MAX_LENGTH = 2048;

/** Side of the stored photo, the size asked of Google too. */
export const AVATAR_SIDE = 192;

/**
 * `<userId>-<version>.webp`: the account's id as better-auth makes it
 * (USER_ID_PATTERN, 32 letters and digits), version 16 hex digits.
 */
export const AVATAR_FILE_PATTERN = new RegExp(
  `^(${USER_ID_SOURCE})-([a-f0-9]{16})\\.webp$`,
);

/**
 * Whether `users.image` may be fetched: an https URL on Google's photo
 * host, without credentials nor a port of its own. Anything else (another
 * host, http, an address) is never fetched: the account shows its
 * avatar text instead.
 */
export function isAllowedAvatarSource(
  source: string | null | undefined,
): source is string {
  if (!source || source.length > AVATAR_SOURCE_MAX_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    url.port === "" &&
    AVATAR_SOURCE_HOSTS.has(url.hostname)
  );
}

/**
 * The URL fetched for a source: Google's size suffix (`=s96-c`, what the
 * sign-in gives) asks for AVATAR_SIDE instead, so the stored photo is not
 * a 96 px one blown up. A source without it is fetched as it is.
 */
export function avatarFetchUrl(source: string): string {
  return source.replace(/=s\d{1,4}(-c)?$/, `=s${AVATAR_SIDE}-c`);
}

/** The version of a source: 16 hex digits of its SHA-256. */
export function avatarVersion(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 16);
}

export function avatarFileName(userId: string, version: string): string {
  const name = `${userId}-${version}.webp`;
  if (!USER_ID_PATTERN.test(userId) || !AVATAR_FILE_PATTERN.test(name)) {
    throw new RangeError("Invalid avatar file name");
  }
  return name;
}

/** The parts of a file name, or null for anything that is not one. */
export function parseAvatarFileName(
  name: string | null | undefined,
): { userId: string; version: string } | null {
  if (!name) return null;
  const match = AVATAR_FILE_PATTERN.exec(name);
  return match ? { userId: match[1]!, version: match[2]! } : null;
}

/** Where the photos live. */
export function avatarDir(): string {
  return join(getUploadDir(), "avatars");
}

/** The path of one photo, or null for a name that is not one. */
export function avatarPath(name: string): string | null {
  return parseAvatarFileName(name) ? join(avatarDir(), name) : null;
}

/**
 * The URL a DTO sends for a stored photo (GET /api/uploads/avatars/[file]),
 * or null without one: the avatar then shows its text (`avatarText`).
 */
export function avatarUrl(file: string | null | undefined): string | null {
  return parseAvatarFileName(file)
    ? `/api/uploads/avatars/${encodeURIComponent(file!)}`
    : null;
}

/** What to do with an account's stored photo. */
export type AvatarAction = "fetch" | "drop" | "none";

/**
 * Whether an account's photo must be fetched (`users.image` is a Google
 * picture the row has not fetched yet), dropped (no picture to show, one
 * that may not be fetched, or an account without access) or left alone. A
 * source fetched before stays as it is, file or not: a picture that gave
 * nothing usable is tried again only when `users.image` changes.
 */
export function decideAvatar(
  account: { image: string | null; accessRevoked: boolean },
  stored: { sourceUrl: string } | null,
): AvatarAction {
  if (account.accessRevoked || !isAllowedAvatarSource(account.image)) {
    return stored ? "drop" : "none";
  }
  return stored?.sourceUrl === account.image ? "none" : "fetch";
}

/** Removes stored photos; names that are not one are skipped. */
export async function removeAvatarFiles(
  names: readonly (string | null | undefined)[],
): Promise<void> {
  for (const name of names) {
    const path = name ? avatarPath(name) : null;
    if (!path) continue;
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logError("auth.avatars", error, { action: "remove" });
      }
    }
  }
}
