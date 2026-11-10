import type { MemberKind } from "~~/shared/constants/domain";
import {
  PERMISSION_KEYS,
  type PermissionKey,
} from "~~/shared/constants/permissions";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";

/**
 * The welcome (ShellWelcome): who it talks to and which steps it shows.
 * Pure, so the role-to-steps rules are tested without the dialog.
 */

/**
 * Who the welcome talks to. It follows what the account can do, not the
 * name of its role, so a custom role or a per-user grant reads right:
 * - `secretariat`: validates and organises (Admin, Secretaría, Presidencia);
 * - `mesa`: runs the session (Moderador);
 * - `cea`, `asociado`, `sectorial`: present documents and amendments;
 * - `guest`: reads only.
 */
export type WelcomeAudience =
  "secretariat" | "mesa" | "cea" | "asociado" | "sectorial" | "guest";

/** What the welcome needs of GET /api/me. */
export interface WelcomeAccount {
  isAdmin: boolean;
  permissions: readonly PermissionKey[];
  role: string | null;
  member: { kind: MemberKind } | null;
}

/** Permissions that mean "validates and organises". */
const SECRETARIAT_PERMISSIONS: readonly PermissionKey[] = [
  PERMISSION_KEYS.ASSEMBLY_MANAGE,
  PERMISSION_KEYS.DOCUMENT_MANAGE,
  PERMISSION_KEYS.AMENDMENT_MANAGE,
  PERMISSION_KEYS.AMENDMENT_REVIEW,
];

const PRESENTER_PERMISSIONS: readonly PermissionKey[] = [
  PERMISSION_KEYS.DOCUMENT_CREATE,
  PERMISSION_KEYS.AMENDMENT_CREATE,
];

function presenterAudience(account: WelcomeAccount): WelcomeAudience {
  // The member the account acts for says more than the role: a hand-linked
  // account presents for that member whatever its role is called.
  switch (account.member?.kind) {
    case "executive":
      return "cea";
    case "sectorial":
      return "sectorial";
    case "asociado":
      return "asociado";
  }
  if (account.role === SYSTEM_ROLES.CEA) return "cea";
  if (account.role === SYSTEM_ROLES.SECTORIAL) return "sectorial";
  return "asociado";
}

export function welcomeAudience(account: WelcomeAccount): WelcomeAudience {
  const has = (keys: readonly PermissionKey[]) =>
    keys.some((key) => account.permissions.includes(key));

  if (account.isAdmin || has(SECRETARIAT_PERMISSIONS)) return "secretariat";
  if (has([PERMISSION_KEYS.SESSION_MODERATE])) return "mesa";
  if (has(PRESENTER_PERMISSIONS)) return presenterAudience(account);
  return "guest";
}

export const WELCOME_STEP_IDS = [
  "role",
  "find",
  "work",
  "back",
  "preferences",
] as const;
export type WelcomeStepId = (typeof WELCOME_STEP_IDS)[number];

export interface WelcomeStep {
  id: WelcomeStepId;
  /** The step's drawing: a row of large icons, decorative. */
  icons: readonly string[];
  /** i18n key of the heading. */
  titleKey: string;
  /** i18n key of the one idea of the step. */
  bodyKey: string;
}

const AUDIENCE_ICONS: Record<WelcomeAudience, string> = {
  secretariat: "i-lucide-clipboard-check",
  mesa: "i-lucide-mic",
  cea: "i-lucide-briefcase",
  asociado: "i-lucide-graduation-cap",
  sectorial: "i-lucide-users",
  guest: "i-lucide-eye",
};

/** What step 3 explains: the main thing this audience does. */
export type WelcomeWork = "present" | "manage" | "moderate" | "read";

export function welcomeWork(audience: WelcomeAudience): WelcomeWork {
  switch (audience) {
    case "secretariat":
      return "manage";
    case "mesa":
      return "moderate";
    case "guest":
      return "read";
    default:
      return "present";
  }
}

const WORK_ICONS: Record<WelcomeWork, readonly string[]> = {
  present: ["i-lucide-file-plus", "i-lucide-pencil-line", "i-lucide-send"],
  manage: [
    "i-lucide-inbox",
    "i-lucide-clipboard-check",
    "i-lucide-list-ordered",
  ],
  moderate: ["i-lucide-mic", "i-lucide-users", "i-lucide-vote"],
  read: ["i-lucide-list-ordered", "i-lucide-file-text", "i-lucide-book-open"],
};

/** The five steps of the welcome for an audience, in order. */
export function welcomeSteps(audience: WelcomeAudience): WelcomeStep[] {
  const work = welcomeWork(audience);
  // Only a guest has nothing to do on the home page: it lists assemblies.
  const home = audience === "guest" ? "guest" : "tasks";
  return [
    {
      id: "role",
      icons: ["i-lucide-landmark", AUDIENCE_ICONS[audience]],
      titleKey: "onboarding.steps.role.title",
      bodyKey: `onboarding.steps.role.body.${audience}`,
    },
    {
      id: "find",
      icons: ["i-lucide-house", "i-lucide-arrow-right", "i-lucide-landmark"],
      titleKey: `onboarding.steps.find.${home}.title`,
      bodyKey: `onboarding.steps.find.${home}.body`,
    },
    {
      id: "work",
      icons: WORK_ICONS[work],
      titleKey: `onboarding.steps.work.${work}.title`,
      bodyKey: `onboarding.steps.work.${work}.body`,
    },
    {
      id: "back",
      icons: ["i-lucide-chevron-left", "i-lucide-life-buoy"],
      titleKey: "onboarding.steps.back.title",
      bodyKey: "onboarding.steps.back.body",
    },
    {
      id: "preferences",
      icons: ["i-lucide-languages", "i-lucide-sun-moon", "i-lucide-type"],
      titleKey: "onboarding.steps.preferences.title",
      bodyKey: "onboarding.steps.preferences.body",
    },
  ];
}

/**
 * Where this browser keeps that the welcome was closed. Per browser, not
 * per account: an account may be shared by several people (a council's
 * account is the council), and each one should see the welcome once on
 * their own device, like the language, the theme and the content
 * preferences.
 */
export const WELCOME_SEEN_STORAGE_KEY = "creup:welcome-seen";

/** What decides whether the welcome opens by itself and is recorded. */
export interface WelcomeState {
  /** This browser already closed the welcome. */
  seen: boolean;
  /** The account the page acts as; null before it is known. */
  account: { impersonation: unknown } | null | undefined;
}

/**
 * Whether the welcome opens by itself and closing it is recorded in this
 * browser: once the account is known, until this browser closes it. Never
 * while an Admin acts as an account: the Admin is not the one who has to
 * see it, and what the Admin closes must not count for that browser.
 */
export function welcomePending(state: WelcomeState): boolean {
  return Boolean(state.account && !state.seen && !state.account.impersonation);
}
