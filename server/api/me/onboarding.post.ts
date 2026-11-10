import { createError, defineEventHandler } from "h3";
import { and, eq, isNull } from "drizzle-orm";
import type { MeOnboardingResult } from "~~/shared/types/api";
import { AUDIT_ACTIONS } from "~~/shared/constants/activity";
import { db } from "../../db";
import { users } from "../../db/schema";
import { requireActor } from "../../utils/domain/actor";
import { recordAudit } from "../../utils/domain/audit";

/**
 * The account closed the welcome: sets `users.onboarding_seen_at` once and
 * writes `user.onboarding_seen`. Calling it again changes and records
 * nothing. 403 while an Admin acts as the account: what the Admin looked
 * at says nothing about what the account has seen.
 */
export default defineEventHandler(
  async (event): Promise<MeOnboardingResult> => {
    const actor = await requireActor(event);
    if (actor.impersonation) {
      throw createError({
        statusCode: 403,
        message:
          "No se puede marcar la bienvenida mientras actúas como otra cuenta",
      });
    }

    await db.transaction(async (tx) => {
      const [marked] = await tx
        .update(users)
        .set({ onboardingSeenAt: new Date() })
        .where(and(eq(users.id, actor.user.id), isNull(users.onboardingSeenAt)))
        .returning({ id: users.id });
      if (!marked) return;

      await recordAudit(tx, {
        event,
        actor,
        action: AUDIT_ACTIONS.USER_ONBOARDING_SEEN,
        targetType: "user",
        targetId: actor.user.id,
        before: { onboardingSeen: false },
        after: { onboardingSeen: true },
      });
    });

    return { onboardingSeen: true };
  },
);
