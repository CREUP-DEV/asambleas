import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  emailDeliveries,
  events,
  notificationOutbox,
  users,
} from "../../db/schema";
import { logError, logInfo, logWarn } from "../core/logger";
import type { Actor } from "../domain/actor";
import { loadExportActor } from "../export/actor";
import { emailFingerprint } from "../members/intranet";
import {
  EMAIL_MAX_ATTEMPTS,
  EMAIL_TEST_KIND,
  NOTIFICATION_KINDS,
  type EmailSkipReason,
  type NotificationKind,
  type NotificationSettings,
} from "~~/shared/constants/notifications";
import { composeNotice } from "./compose";
import {
  describeSmtpError,
  readSmtpConfig,
  sendEmail,
  siteOrigin,
  type SmtpConfig,
} from "./mailer";
import { planDeliveries, type NotifyingEvent } from "./plan";
import { loadNotificationSettings } from "./settings";
import {
  renderDigestEmail,
  renderNoticeEmail,
  type EmailNotice,
  type RenderedEmail,
} from "./template";

/**
 * The sender (docs/design.md, "Email notifications"):
 * 1. `processOutbox` reads the committed events of notification_outbox and
 *    queues one email_deliveries row per account and notice (planDeliveries).
 * 2. `sendImmediate` sends the `immediate` deliveries one by one, retrying
 *    a failed send with a growing pause up to EMAIL_MAX_ATTEMPTS.
 * 3. `sendDigests` sends the `daily` ones once a day, one email per account.
 * Each email is composed when it goes, as its account sees things then.
 * Rows are claimed with SKIP LOCKED, so two processes never send one twice.
 * Logs never carry an address (`accountRef`).
 */

type DeliveryRow = typeof emailDeliveries.$inferSelect;

const OUTBOX_BATCH = 50;
const SEND_BATCH = 20;
/** Outbox attempts before an event is given up (logged). */
const OUTBOX_MAX_ATTEMPTS = 5;
/** Pause after the n-th failed send, in minutes. */
const RETRY_MINUTES = [1, 5, 15, 60, 180];

function isKind(value: string): value is NotificationKind {
  return (NOTIFICATION_KINDS as readonly string[]).includes(value);
}

async function loadEvent(id: string): Promise<NotifyingEvent | null> {
  const [row] = await db
    .select({
      id: events.id,
      assemblyId: events.assemblyId,
      entityType: events.entityType,
      entityId: events.entityId,
      type: events.type,
      payload: events.payload,
      actorUserId: events.actorUserId,
      actorMemberId: events.actorMemberId,
      impersonationId: events.impersonationId,
    })
    .from(events)
    .where(eq(events.id, id));
  return row ?? null;
}

// 1. Outbox -------------------------------------------------------------------

/** Turns committed events into deliveries. Returns how many it read. */
export async function processOutbox(): Promise<number> {
  const { settings } = await loadNotificationSettings();
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        eventId: notificationOutbox.eventId,
        attempts: notificationOutbox.attempts,
      })
      .from(notificationOutbox)
      .where(isNull(notificationOutbox.processedAt))
      .orderBy(asc(notificationOutbox.createdAt))
      .limit(OUTBOX_BATCH)
      .for("update", { skipLocked: true });

    for (const row of rows) {
      try {
        // A savepoint: one event that fails leaves the others going.
        await tx.transaction(async (sp) => {
          const event = await loadEvent(row.eventId);
          const planned = event
            ? await planDeliveries(event, settings, sp)
            : [];
          if (event && planned.length > 0) {
            await sp
              .insert(emailDeliveries)
              .values(
                planned.map((delivery) => ({
                  kind: delivery.kind,
                  eventId: event.id,
                  assemblyId: event.assemblyId,
                  userId: delivery.userId,
                  dedupeKey: delivery.dedupeKey,
                  frequency: delivery.frequency,
                })),
              )
              .onConflictDoNothing({
                target: [emailDeliveries.userId, emailDeliveries.dedupeKey],
              });
          }
          await sp
            .update(notificationOutbox)
            .set({ processedAt: new Date() })
            .where(eq(notificationOutbox.eventId, row.eventId));
        });
      } catch (error) {
        const attempts = row.attempts + 1;
        logError("email.outbox", error, { eventId: row.eventId, attempts });
        await tx
          .update(notificationOutbox)
          .set({
            attempts,
            lastError: describeSmtpError(error),
            ...(attempts >= OUTBOX_MAX_ATTEMPTS
              ? { processedAt: new Date() }
              : {}),
          })
          .where(eq(notificationOutbox.eventId, row.eventId));
      }
    }
    return rows.length;
  });
}

// 2. Immediate emails -----------------------------------------------------------

/** Takes due deliveries of one frequency (status `sending`, one more attempt). */
async function claim(
  frequency: "immediate" | "daily",
  limit: number,
  userId?: string,
): Promise<DeliveryRow[]> {
  const result = await db.execute<{ id: string }>(sql`
    update ${emailDeliveries}
    set status = 'sending', attempts = ${emailDeliveries.attempts} + 1
    where ${emailDeliveries.id} in (
      select ${emailDeliveries.id} from ${emailDeliveries}
      where ${emailDeliveries.status} = 'pending'
        and ${emailDeliveries.frequency} = ${frequency}
        and ${emailDeliveries.nextAttemptAt} <= now()
        ${userId ? sql`and ${emailDeliveries.userId} = ${userId}` : sql``}
      order by ${emailDeliveries.createdAt}
      limit ${limit}
      for update skip locked
    )
    returning ${emailDeliveries.id}`);
  const ids = result.rows.map((row) => row.id);
  if (ids.length === 0) return [];
  return db
    .select()
    .from(emailDeliveries)
    .where(inArray(emailDeliveries.id, ids))
    .orderBy(asc(emailDeliveries.createdAt));
}

async function finish(
  ids: string[],
  values: Partial<DeliveryRow>,
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(emailDeliveries)
    .set(values)
    .where(inArray(emailDeliveries.id, ids));
}

async function skip(ids: string[], reason: EmailSkipReason): Promise<void> {
  await finish(ids, { status: "skipped", reason, lastError: null });
}

/** After a failed send: pending again after a pause, or failed for good. */
async function failed(rows: DeliveryRow[], error: unknown): Promise<void> {
  const message = describeSmtpError(error);
  for (const row of rows) {
    const last = row.attempts >= EMAIL_MAX_ATTEMPTS;
    const pause =
      RETRY_MINUTES[Math.min(row.attempts, RETRY_MINUTES.length) - 1]!;
    await finish([row.id], {
      status: last ? "failed" : "pending",
      lastError: message,
      nextAttemptAt: new Date(Date.now() + pause * 60_000),
    });
  }
}

interface Recipient {
  email: string;
  actor: Actor;
}

/** The account as it is now, or why nothing goes to it. */
async function loadRecipient(
  userId: string,
): Promise<Recipient | EmailSkipReason> {
  const [user] = await db
    .select({ email: users.email, accessRevokedAt: users.accessRevokedAt })
    .from(users)
    .where(eq(users.id, userId));
  if (!user || user.accessRevokedAt || !user.email.includes("@")) {
    return "no_access";
  }
  const actor = await loadExportActor(userId);
  if (!actor) return "no_access";
  return { email: user.email, actor };
}

/** The notice of one delivery for its account, or why it does not go. */
async function noticeFor(
  row: DeliveryRow,
  recipient: Recipient,
  settings: NotificationSettings,
  origin: string,
): Promise<{ notice: EmailNotice; reason: string } | EmailSkipReason> {
  if (!isKind(row.kind)) return "gone";
  if (!settings.enabled || !settings.kinds[row.kind].enabled) return "disabled";
  if (!row.eventId) return "gone";
  const event = await loadEvent(row.eventId);
  if (!event) return "gone";
  const result = await composeNotice({
    kind: row.kind,
    event,
    actor: recipient.actor,
    origin,
  });
  return "skip" in result ? result.skip : result;
}

async function deliver(
  config: SmtpConfig,
  rows: DeliveryRow[],
  recipient: Recipient,
  email: RenderedEmail,
): Promise<boolean> {
  try {
    await sendEmail(config, {
      to: recipient.email,
      subject: email.subject,
      html: email.html,
      text: email.text,
      messageId: `<${rows[0]!.id}@asambleas.creup>`,
    });
    await finish(
      rows.map((row) => row.id),
      {
        status: "sent",
        sentAt: new Date(),
        subject: email.subject,
        lastError: null,
      },
    );
    logInfo("email.sent", {
      kind: rows.length === 1 ? rows[0]!.kind : "digest",
      count: rows.length,
      accountRef: emailFingerprint(recipient.email),
    });
    return true;
  } catch (error) {
    logWarn("email.send_failed", {
      error: describeSmtpError(error),
      accountRef: emailFingerprint(recipient.email),
    });
    await failed(rows, error);
    return false;
  }
}

/** Sends the due immediate emails. Returns how many it took. */
export async function sendImmediate(): Promise<number> {
  const rows = await claim("immediate", SEND_BATCH);
  if (rows.length === 0) return 0;
  const config = readSmtpConfig();
  if (!config) {
    await skip(
      rows.map((row) => row.id),
      "unconfigured",
    );
    return rows.length;
  }
  const { settings } = await loadNotificationSettings();
  const origin = siteOrigin();
  for (const row of rows) {
    try {
      const recipient = await loadRecipient(row.userId);
      if (typeof recipient === "string") {
        await skip([row.id], recipient);
        continue;
      }
      const notice = await noticeFor(row, recipient, settings, origin);
      if (typeof notice === "string") {
        await skip([row.id], notice);
        continue;
      }
      await deliver(
        config,
        [row],
        recipient,
        renderNoticeEmail(notice.notice, { origin, reason: notice.reason }),
      );
    } catch (error) {
      logError("email.compose", error, { deliveryId: row.id });
      await failed([row], error);
    }
  }
  return rows.length;
}

// 3. Daily summaries ------------------------------------------------------------

/**
 * Sends every account its due `daily` deliveries in one email. Run by the
 * daily schedule (./schedule.ts). Returns how many emails went.
 */
export async function sendDigests(): Promise<number> {
  const pending = await db
    .selectDistinct({ userId: emailDeliveries.userId })
    .from(emailDeliveries)
    .where(
      and(
        eq(emailDeliveries.status, "pending"),
        eq(emailDeliveries.frequency, "daily"),
        lte(emailDeliveries.nextAttemptAt, new Date()),
      ),
    );
  const config = readSmtpConfig();
  const { settings } = await loadNotificationSettings();
  const origin = siteOrigin();
  let sent = 0;
  for (const { userId } of pending) {
    const rows = await claim("daily", 200, userId);
    if (rows.length === 0) continue;
    if (!config) {
      await skip(
        rows.map((row) => row.id),
        "unconfigured",
      );
      continue;
    }
    try {
      const recipient = await loadRecipient(userId);
      if (typeof recipient === "string") {
        await skip(
          rows.map((row) => row.id),
          recipient,
        );
        continue;
      }
      const going: DeliveryRow[] = [];
      const notices: EmailNotice[] = [];
      let reason = "";
      for (const row of rows) {
        const notice = await noticeFor(row, recipient, settings, origin);
        if (typeof notice === "string") {
          await skip([row.id], notice);
          continue;
        }
        going.push(row);
        notices.push(notice.notice);
        reason ||= notice.reason;
      }
      if (going.length === 0) continue;
      const email =
        notices.length === 1
          ? renderNoticeEmail(notices[0]!, { origin, reason })
          : renderDigestEmail(notices, {
              origin,
              reason:
                "Recibes este resumen diario por los avisos que te corresponden en la plataforma.",
            });
      if (await deliver(config, going, recipient, email)) sent += 1;
    } catch (error) {
      logError("email.digest", error, { count: rows.length });
      await failed(rows, error);
    }
  }
  return sent;
}

/** At boot: rows a stopped process left half sent go back to pending. */
export async function releaseStaleClaims(): Promise<void> {
  await db
    .update(emailDeliveries)
    .set({ status: "pending" })
    .where(eq(emailDeliveries.status, "sending"));
}

// Test email ---------------------------------------------------------------------

/**
 * A test email to the caller's own address (POST
 * /api/admin/notifications/test), sent now, with a delivery row in the log.
 */
export async function sendTestEmail(actor: Actor): Promise<{
  status: "sent" | "failed" | "skipped";
  reason: EmailSkipReason | null;
}> {
  const [row] = await db
    .insert(emailDeliveries)
    .values({
      kind: EMAIL_TEST_KIND,
      userId: actor.user.id,
      dedupeKey: `${EMAIL_TEST_KIND}:${crypto.randomUUID()}`,
      status: "sending",
      attempts: 1,
    })
    .returning();
  const config = readSmtpConfig();
  if (!config) {
    await skip([row!.id], "unconfigured");
    return { status: "skipped", reason: "unconfigured" };
  }
  const origin = siteOrigin();
  const email = renderNoticeEmail(
    {
      tag: null,
      subject: "Prueba de los avisos por correo",
      heading: "Los avisos por correo funcionan",
      lead: "Este es un correo de prueba enviado desde la administración de la plataforma de asambleas. Si lo lees, el envío está bien configurado.",
      details: [{ label: "Remitente", value: config.fromEmail }],
      note: null,
      action: {
        label: "Abrir los avisos por correo",
        url: `${origin}/admin/notificaciones`,
      },
    },
    {
      origin,
      reason: "Recibes este correo porque has pedido una prueba.",
    },
  );
  try {
    await sendEmail(config, {
      to: actor.user.email,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
    await finish([row!.id], {
      status: "sent",
      sentAt: new Date(),
      subject: email.subject,
    });
    return { status: "sent", reason: null };
  } catch (error) {
    await finish([row!.id], {
      status: "failed",
      lastError: describeSmtpError(error),
    });
    return { status: "failed", reason: null };
  }
}
