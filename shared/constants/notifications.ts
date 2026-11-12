import { SYSTEM_ROLES } from "./roles";

/**
 * Email notifications (docs/design.md, "Email notifications"). Each kind is
 * one switch on /admin/notificaciones (`notification:manage`). Two
 * audiences:
 * - `roles`: every account with access whose role is among the kind's
 *   roles (the Secretaría, the Presidencia, the Mesa by default);
 * - `presenters`: the accounts that act for the members a document or an
 *   amendment concerns (its presenters, its authors, the parties of a
 *   transactional). Who they are follows the entity, never a setting.
 * The emails are in Spanish only, like the web's transactional emails.
 */
export const NOTIFICATION_KINDS = [
  // To roles -----------------------------------------------------------------
  /** A member sent a document to the Secretaría (document_submitted). */
  "document_submitted",
  /** A member presented an amendment (amendment_submitted, not a transactional). */
  "amendment_submitted",
  /**
   * A transactional every party accepted reaches the Secretaría for
   * validation (amendment_submitted without parties left, or the last
   * acceptance_recorded). Never one the Mesa presents: it needs no validation.
   */
  "transactional_ready",
  /**
   * What the Secretaría validated: a document published, an amendment
   * validated (late ones still await the Mesa's admission).
   */
  "submission_validated",
  // To the members concerned -------------------------------------------------
  /**
   * The parties of a transactional (the main authors of what it groups) are
   * asked to accept it.
   */
  "transactional_acceptance_requested",
  /** A manager assigned a document to the member, as presenter or co-presenter. */
  "presenter_assigned",
  /** The Secretaría sent the document or the amendment back for correction. */
  "presenter_correction",
  /** The document was published, the amendment validated or admitted. */
  "presenter_validated",
  /**
   * The document or the amendment was settled by someone else: voted,
   * approved, rejected, inadmissible, lapsed, transacted or closed.
   */
  "presenter_decided",
  /**
   * A substantial change by someone else: the amendment reclassified or its
   * authors corrected, the document's internal deadline changed.
   */
  "presenter_changed",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_AUDIENCES = ["roles", "presenters"] as const;
export type NotificationAudience = (typeof NOTIFICATION_AUDIENCES)[number];

export const NOTIFICATION_AUDIENCE: Record<
  NotificationKind,
  NotificationAudience
> = {
  document_submitted: "roles",
  amendment_submitted: "roles",
  transactional_ready: "roles",
  submission_validated: "roles",
  transactional_acceptance_requested: "presenters",
  presenter_assigned: "presenters",
  presenter_correction: "presenters",
  presenter_validated: "presenters",
  presenter_decided: "presenters",
  presenter_changed: "presenters",
};

/**
 * `immediate`: one email per notice, sent within seconds. `daily`: the
 * notices of the day in one email per account (NOTIFICATION_DIGEST_CRON).
 */
export const NOTIFICATION_FREQUENCIES = ["immediate", "daily"] as const;
export type NotificationFrequency = (typeof NOTIFICATION_FREQUENCIES)[number];

/** When the daily summaries go out, Europe/Madrid. */
export const NOTIFICATION_DIGEST_CRON = "0 8 * * *";
export const NOTIFICATION_DIGEST_HOUR = "08:00";

export interface NotificationKindSettings {
  enabled: boolean;
  /** Role names that receive it; only for the `roles` audience. */
  roles: string[];
  frequency: NotificationFrequency;
}

export interface NotificationSettings {
  /** The general switch: no email is queued nor sent while it is off. */
  enabled: boolean;
  kinds: Record<NotificationKind, NotificationKindSettings>;
}

const LEADERSHIP = [SYSTEM_ROLES.SECRETARIA, SYSTEM_ROLES.PRESIDENCIA];

function kind(
  roles: string[] = [],
  frequency: NotificationFrequency = "immediate",
): NotificationKindSettings {
  return { enabled: true, roles, frequency };
}

/**
 * What applies until someone saves the page, and what a stored row is read
 * over (a kind added later starts with these values).
 */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  kinds: {
    document_submitted: kind(LEADERSHIP),
    // Amendments come in bursts before the deadline: one summary a day.
    amendment_submitted: kind(LEADERSHIP, "daily"),
    transactional_ready: kind([...LEADERSHIP, SYSTEM_ROLES.MODERADOR]),
    submission_validated: kind([SYSTEM_ROLES.MODERADOR]),
    transactional_acceptance_requested: kind(),
    presenter_assigned: kind(),
    presenter_correction: kind(),
    presenter_validated: kind(),
    presenter_decided: kind(),
    presenter_changed: kind(),
  },
};

/** The order and grouping of the admin page. */
export const NOTIFICATION_GROUPS: {
  key: "leadership" | "mesa" | "transactionals" | "presenters";
  kinds: NotificationKind[];
}[] = [
  { key: "leadership", kinds: ["document_submitted", "amendment_submitted"] },
  { key: "mesa", kinds: ["submission_validated"] },
  {
    key: "transactionals",
    kinds: ["transactional_ready", "transactional_acceptance_requested"],
  },
  {
    key: "presenters",
    kinds: [
      "presenter_assigned",
      "presenter_correction",
      "presenter_validated",
      "presenter_decided",
      "presenter_changed",
    ],
  },
];

/** What happened to one email (email_deliveries.status). */
export const EMAIL_DELIVERY_STATUSES = [
  /** Waiting to go: now, or in the next daily summary. */
  "pending",
  /** Taken by the sender; back to pending if the process stops. */
  "sending",
  "sent",
  /** Gave up after EMAIL_MAX_ATTEMPTS, or a test that failed. */
  "failed",
  /** Never sent, for `reason` (EMAIL_SKIP_REASONS). */
  "skipped",
] as const;
export type EmailDeliveryStatus = (typeof EMAIL_DELIVERY_STATUSES)[number];

export const EMAIL_SKIP_REASONS = [
  /** No SMTP server configured (NUXT_SMTP_HOST, NUXT_SMTP_FROM_EMAIL). */
  "unconfigured",
  /** The general switch or the kind was turned off before it went. */
  "disabled",
  /** The account lost access, or has no address. */
  "no_access",
  /** The account may no longer see what it was about. */
  "not_visible",
  /** What it was about no longer exists. */
  "gone",
] as const;
export type EmailSkipReason = (typeof EMAIL_SKIP_REASONS)[number];

/** Send attempts of one email before it counts as failed. */
export const EMAIL_MAX_ATTEMPTS = 5;

/** The kind of a test email sent from the admin page. */
export const EMAIL_TEST_KIND = "test";
