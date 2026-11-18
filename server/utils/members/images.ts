import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "../../db";
import { userAvatars, users } from "../../db/schema";
import { avatarUrl } from "../auth/avatarFiles";

/**
 * The photo of each member's avatar (MemberDto.image): the stored photo of
 * an account that acts for it (`users.memberId`), with access, the most
 * recently stored one when there are several. A council's or a
 * sectorial's account is the member itself, so its photo is the logo the
 * member uses. Only the platform's own copy (user_avatars), never
 * Google's address.
 */
export async function memberImages(): Promise<Map<string, string>> {
  const rows = await db
    .selectDistinctOn([users.memberId], {
      memberId: users.memberId,
      file: userAvatars.file,
    })
    .from(users)
    .innerJoin(userAvatars, eq(userAvatars.userId, users.id))
    .where(
      and(
        isNotNull(users.memberId),
        isNull(users.accessRevokedAt),
        isNotNull(userAvatars.file),
      ),
    )
    .orderBy(users.memberId, desc(userAvatars.updatedAt));
  const images = new Map<string, string>();
  for (const row of rows) {
    const url = avatarUrl(row.file);
    if (row.memberId && url) images.set(row.memberId, url);
  }
  return images;
}
