/**
 * Images of the room that failed for good: the Intranet gave a version, but
 * no file can be cached for it (a 404 or a file over the size cap, or bytes
 * sharp or librsvg cannot draw). Without this, every sync would queue them
 * again and fetch up to 5 MB each time, since their row never gets a file.
 *
 * Kept in this process's memory only, like the editors' presence: a new
 * version from the Intranet is another key and is tried at once, and a
 * restart tries each failed one again once. A transient failure (a timeout,
 * a 5xx) never lands here: the job throws and pg-boss retries it.
 */

/** What identifies one image at one version, as the queue's singletonKey. */
export interface SeatingImageKeyParts {
  kind: "logo" | "photo";
  id: string;
  version: string;
}

/** Bounds the memory a long run with many changing failures could take. */
export const FAILED_SEATING_IMAGES_LIMIT = 5_000;

const failed = new Set<string>();

export function seatingImageKey(image: SeatingImageKeyParts): string {
  return `${image.kind}:${image.id}:${image.version}`;
}

/** Remembers an image at that version as one that is not worth fetching. */
export function rememberFailedSeatingImage(image: SeatingImageKeyParts): void {
  const key = seatingImageKey(image);
  failed.delete(key);
  failed.add(key);
  // A Set keeps insertion order: the oldest failure goes first.
  while (failed.size > FAILED_SEATING_IMAGES_LIMIT) {
    const oldest = failed.values().next().value;
    if (oldest === undefined) break;
    failed.delete(oldest);
  }
}

/** The images still worth queueing: none that failed at the same version. */
export function withoutFailedSeatingImages<T extends SeatingImageKeyParts>(
  images: readonly T[],
): T[] {
  return images.filter((image) => !failed.has(seatingImageKey(image)));
}

/** Tests only: forgets every failure. */
export function forgetFailedSeatingImages(): void {
  failed.clear();
}
