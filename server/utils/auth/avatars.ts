import { randomBytes } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { Job, PgBoss } from "pg-boss";
import { z } from "zod/v4";
import { db } from "../../db";
import { userAvatars, users } from "../../db/schema";
import { logError, logInfo, logWarn } from "../core/logger";
import { getExportQueue } from "../export/queue";
import { errorSummary } from "../errors";
import { renderSeatingImage } from "../seating/images";
import { isTooLarge, readCapped } from "../seating/intranet";
import {
  avatarDir,
  avatarFetchUrl,
  avatarFileName,
  avatarVersion,
  decideAvatar,
  isAllowedAvatarSource,
  removeAvatarFiles,
} from "./avatarFiles";

/**
 * The accounts' photos, stored here instead of loading them from Google
 * (user_avatars, avatarFiles.ts). better-auth keeps the Google picture's URL
 * in `users.image`; a job of the pg-boss queue `user-avatars` (on the export
 * queue's instance) fetches it from Google's photo host only, at most
 * AVATAR_MAX_BYTES, and stores a 192 × 192 WebP without metadata drawn as
 * the seating view draws its photos (renderSeatingImage). The row names the
 * file only if `users.image` is still the URL fetched and the account still
 * has access, under the account's row FOR SHARE: applyIntranetNotFound
 * takes it FOR UPDATE, so a photo never comes back after a revocation.
 *
 * Jobs are queued after a sign-in (afterSessionCreate) and, once per boot,
 * for every account whose picture is not stored yet (backfillUserAvatars).
 * Logs carry the user id, never an email nor the picture's URL.
 */

export const USER_AVATARS_QUEUE = "user-avatars";
/** Photos fetched at once by this process. */
const AVATAR_CONCURRENCY = 2;
/** A Google picture is a few kilobytes; nothing past this is read. */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
/** How long Google gets to answer. */
const AVATAR_FETCH_TIMEOUT_MS = 10_000;
const AVATAR_RETRY_LIMIT = 3;

const userAvatarJobSchema = z.object({
  userId: z.string().regex(/^[A-Za-z0-9]{8,64}$/),
});
export type UserAvatarJob = z.infer<typeof userAvatarJobSchema>;

/** Google could not answer now (network, timeout, 408, 429, 5xx): retried. */
export class AvatarSourceUnavailableError extends Error {
  constructor(reason: string) {
    super(`avatar source unavailable: ${reason}`);
    this.name = "AvatarSourceUnavailableError";
  }
}

/**
 * How fetching a picture went. `unusable` is final for that source: a
 * redirect (never followed: it could lead off the allowed host), a 4xx, an
 * answer that is not an image or one past AVATAR_MAX_BYTES.
 */
export type AvatarFetch =
  | { outcome: "ok"; data: Buffer }
  | {
      outcome: "unusable";
      reason: "refused" | "redirect" | "status" | "not_image" | "too_large";
      status?: number;
    };

/** Fetches a picture of Google's photo host; throws only what a retry may mend. */
export async function fetchAvatarSource(
  source: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AvatarFetch> {
  const url = avatarFetchUrl(source);
  if (!isAllowedAvatarSource(source) || !isAllowedAvatarSource(url)) {
    return { outcome: "unusable", reason: "refused" };
  }
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "image/*" },
      redirect: "manual",
      signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AvatarSourceUnavailableError(
      error instanceof Error ? error.name : "network",
    );
  }
  const status = response.status;
  const drop = () => response.body?.cancel().catch(() => undefined);
  if (status >= 300 && status < 400) {
    await drop();
    return { outcome: "unusable", reason: "redirect", status };
  }
  if (status === 408 || status === 429 || status >= 500) {
    await drop();
    throw new AvatarSourceUnavailableError(`status ${status}`);
  }
  if (!response.ok) {
    await drop();
    return { outcome: "unusable", reason: "status", status };
  }
  const type = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!type.startsWith("image/")) {
    await drop();
    return { outcome: "unusable", reason: "not_image", status };
  }
  let data: Awaited<ReturnType<typeof readCapped>>;
  try {
    data = await readCapped(response, AVATAR_MAX_BYTES);
  } catch (error) {
    throw new AvatarSourceUnavailableError(
      error instanceof Error ? error.name : "network",
    );
  }
  if (isTooLarge(data)) return { outcome: "unusable", reason: "too_large" };
  return { outcome: "ok", data };
}

/**
 * Logs a failure by its name and SQLSTATE only: drizzle's message and stack
 * end with the query's parameters, and the claim binds the picture's URL.
 */
function logAvatarError(error: unknown, meta: Record<string, unknown>): void {
  logError("auth.avatars", errorSummary(error), meta);
}

// Files ----------------------------------------------------------------------

/** Writes a photo whole: a reader never sees half of it. */
async function writeAvatarFile(name: string, data: Buffer): Promise<void> {
  const dir = avatarDir();
  await mkdir(dir, { recursive: true });
  const temporary = join(dir, `.${name}.${randomBytes(6).toString("hex")}`);
  await writeFile(temporary, data);
  try {
    await rename(temporary, join(dir, name));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

// Rows -----------------------------------------------------------------------

/** The account's picture, its access and what is stored of it. */
async function loadAvatarState(userId: string) {
  const [row] = await db
    .select({
      image: users.image,
      accessRevokedAt: users.accessRevokedAt,
      sourceUrl: userAvatars.sourceUrl,
    })
    .from(users)
    .leftJoin(userAvatars, eq(userAvatars.userId, users.id))
    .where(eq(users.id, userId));
  if (!row) return null;
  return {
    image: row.image,
    accessRevoked: row.accessRevokedAt !== null,
    stored: row.sourceUrl === null ? null : { sourceUrl: row.sourceUrl },
  };
}

type ClaimResult =
  | { claimed: true; previousFile: string | null }
  | { claimed: false; currentFile: string | null };

/**
 * Stores what a source gave (`name`, or null when it gave nothing usable)
 * if the account still has that picture and access: under the account's
 * row FOR SHARE, then the photo's row FOR UPDATE.
 */
async function claimAvatar(
  userId: string,
  source: string,
  name: string | null,
  now: Date,
): Promise<ClaimResult> {
  return db.transaction(async (tx): Promise<ClaimResult> => {
    const [account] = await tx
      .select({ image: users.image, accessRevokedAt: users.accessRevokedAt })
      .from(users)
      .where(eq(users.id, userId))
      .for("share");
    const [current] = await tx
      .select({ file: userAvatars.file })
      .from(userAvatars)
      .where(eq(userAvatars.userId, userId))
      .for("update");
    if (!account || account.accessRevokedAt || account.image !== source) {
      return { claimed: false, currentFile: current?.file ?? null };
    }
    const values = {
      sourceUrl: source,
      file: name,
      version: avatarVersion(source),
      fetchedAt: now,
    };
    await tx
      .insert(userAvatars)
      .values({ userId, ...values })
      .onConflictDoUpdate({
        target: userAvatars.userId,
        set: { ...values, updatedAt: sql`now()` },
      });
    return { claimed: true, previousFile: current?.file ?? null };
  });
}

/**
 * Drops the stored photo of an account that no longer has one to show
 * (decideAvatar `drop`, checked again under the locks), the file once
 * committed. Whether it dropped anything.
 */
export async function dropUserAvatar(userId: string): Promise<boolean> {
  const removed = await db.transaction(async (tx) => {
    const [account] = await tx
      .select({ image: users.image, accessRevokedAt: users.accessRevokedAt })
      .from(users)
      .where(eq(users.id, userId))
      .for("share");
    const [current] = await tx
      .select({ sourceUrl: userAvatars.sourceUrl, file: userAvatars.file })
      .from(userAvatars)
      .where(eq(userAvatars.userId, userId))
      .for("update");
    if (!current) return null;
    if (
      account &&
      decideAvatar(
        {
          image: account.image,
          accessRevoked: account.accessRevokedAt !== null,
        },
        current,
      ) !== "drop"
    ) {
      return null;
    }
    await tx.delete(userAvatars).where(eq(userAvatars.userId, userId));
    return { file: current.file };
  });
  if (!removed) return false;
  await removeAvatarFiles([removed.file]);
  return true;
}

// Jobs -----------------------------------------------------------------------

export type UserAvatarOutcome =
  "stored" | "unusable" | "dropped" | "skipped" | "stale";

/**
 * One job: decides again from the account as it is now (a job queued
 * before a change does what the change asks), fetches, draws, writes and
 * names the file. Throws only what a retry may mend.
 */
export async function processUserAvatarJob(
  data: unknown,
  now: () => Date = () => new Date(),
): Promise<UserAvatarOutcome> {
  const parsed = userAvatarJobSchema.safeParse(data);
  if (!parsed.success) {
    logWarn("auth.avatars", { outcome: "invalid_job" });
    return "skipped";
  }
  const { userId } = parsed.data;
  const state = await loadAvatarState(userId);
  if (!state) return "skipped";
  const action = decideAvatar(state, state.stored);
  if (action === "drop") {
    return (await dropUserAvatar(userId)) ? "dropped" : "skipped";
  }
  if (action === "none") return "skipped";
  const source = state.image!;

  const fetched = await fetchAvatarSource(source);
  let name: string | null = null;
  if (fetched.outcome === "ok") {
    const picture = await renderSeatingImage(fetched.data, "photo");
    if (picture) {
      name = avatarFileName(userId, avatarVersion(source));
      await writeAvatarFile(name, picture);
    } else {
      logWarn("auth.avatars", {
        outcome: "unusable",
        reason: "unreadable",
        userId,
      });
    }
  } else {
    logWarn("auth.avatars", {
      outcome: "unusable",
      reason: fetched.reason,
      status: fetched.status ?? null,
      userId,
    });
  }

  const claim = await claimAvatar(userId, source, name, now());
  if (!claim.claimed) {
    // The picture changed or the account lost access meanwhile.
    if (name && claim.currentFile !== name) await removeAvatarFiles([name]);
    return "stale";
  }
  if (claim.previousFile && claim.previousFile !== name) {
    await removeAvatarFiles([claim.previousFile]);
  }
  return name ? "stored" : "unusable";
}

// Queue ----------------------------------------------------------------------

/**
 * Queues photo jobs. One queued job per account (singletonKey, policy
 * `short`): it reads the account when it runs. Never throws: a missing
 * queue only means the photo comes with a later sign-in or boot.
 */
export async function enqueueUserAvatars(
  userIds: readonly string[],
): Promise<void> {
  if (userIds.length === 0) return;
  try {
    const boss = await getExportQueue();
    await boss.insert(
      USER_AVATARS_QUEUE,
      userIds.map((userId) => ({ data: { userId }, singletonKey: userId })),
    );
  } catch (error) {
    logAvatarError(error, {
      action: "enqueue",
      jobs: userIds.length,
    });
  }
}

/**
 * After a sign-in: queues the account's photo when its picture is not
 * stored yet, or drops the stored one when it has none to show. Never
 * throws; the caller does not wait for it.
 */
export async function refreshUserAvatar(userId: string): Promise<void> {
  try {
    const state = await loadAvatarState(userId);
    if (!state) return;
    const action = decideAvatar(state, state.stored);
    if (action === "fetch") await enqueueUserAvatars([userId]);
    else if (action === "drop") await dropUserAvatar(userId);
  } catch (error) {
    logAvatarError(error, { action: "refresh", userId });
  }
}

/**
 * Once per boot: queues every account whose picture is not stored yet and
 * drops the photos of accounts that no longer have one to show. Accounts
 * without access are never fetched.
 */
export async function backfillUserAvatars(): Promise<{
  queued: number;
  dropped: number;
}> {
  const rows = await db
    .select({
      userId: users.id,
      image: users.image,
      accessRevokedAt: users.accessRevokedAt,
      sourceUrl: userAvatars.sourceUrl,
    })
    .from(users)
    .leftJoin(userAvatars, eq(userAvatars.userId, users.id))
    .where(
      or(
        and(
          isNotNull(users.image),
          isNull(users.accessRevokedAt),
          or(
            isNull(userAvatars.userId),
            ne(userAvatars.sourceUrl, users.image),
          ),
        ),
        and(
          isNotNull(userAvatars.userId),
          or(isNull(users.image), isNotNull(users.accessRevokedAt)),
        ),
      ),
    );
  const toFetch: string[] = [];
  let dropped = 0;
  for (const row of rows) {
    const action = decideAvatar(
      { image: row.image, accessRevoked: row.accessRevokedAt !== null },
      row.sourceUrl === null ? null : { sourceUrl: row.sourceUrl },
    );
    if (action === "fetch") toFetch.push(row.userId);
    else if (action === "drop" && (await dropUserAvatar(row.userId))) {
      dropped += 1;
    }
  }
  await enqueueUserAvatars(toFetch);
  return { queued: toFetch.length, dropped };
}

/**
 * Creates the queue (idempotent), starts its worker on the export queue's
 * pg-boss instance and runs the boot backfill. Started by
 * server/plugins/user-avatars.ts.
 */
export async function startUserAvatars(boss: PgBoss): Promise<void> {
  await boss.createQueue(USER_AVATARS_QUEUE, {
    // One queued job per account (singletonKey).
    policy: "short",
    retryLimit: AVATAR_RETRY_LIMIT,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 120,
    deleteAfterSeconds: 24 * 3600,
  });
  await boss.work<unknown>(
    USER_AVATARS_QUEUE,
    { batchSize: 1, localConcurrency: AVATAR_CONCURRENCY },
    async (jobs: Job<unknown>[]) => {
      for (const job of jobs) {
        try {
          await processUserAvatarJob(job.data);
        } catch (error) {
          if (error instanceof AvatarSourceUnavailableError) {
            logWarn("auth.avatars", {
              outcome: "retry",
              reason: error.message,
            });
          } else {
            logAvatarError(error, { jobId: job.id });
          }
          throw error;
        }
      }
    },
  );
  const backfill = await backfillUserAvatars();
  logInfo("auth.avatars", { message: "worker started", ...backfill });
}
