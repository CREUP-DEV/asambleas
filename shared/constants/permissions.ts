export const PERMISSION_KEYS = {
  USER_MANAGE_ROLES: "user:manage_roles",
  ROLE_MANAGE_PERMISSIONS: "role:manage_permissions",
  ASSEMBLY_CREATE: "assembly:create",
  ASSEMBLY_MANAGE: "assembly:manage",
  DOCUMENT_CREATE: "document:create",
  DOCUMENT_MANAGE: "document:manage",
  DOCUMENT_CORRECT_FORM: "document:correct_form",
  AMENDMENT_CREATE: "amendment:create",
  AMENDMENT_MANAGE: "amendment:manage",
  AMENDMENT_REVIEW: "amendment:review",
  ASSEMBLY_VOTE_RESULT: "assembly:vote_result",
  SESSION_MODERATE: "session:moderate",
  SESSION_RECORD_SPEAKERS: "session:record_speakers",
  CONTROL_SHEET_VIEW: "control_sheet:view",
  CONTROL_SHEET_EDIT: "control_sheet:edit",
  SEATING_VIEW: "seating:view",
  SEATING_EDIT: "seating:edit",
  MEMBER_MANAGE: "member:manage",
  STATS_VIEW: "stats:view",
  NOTIFICATION_MANAGE: "notification:manage",
} as const;

export type PermissionKey =
  (typeof PERMISSION_KEYS)[keyof typeof PERMISSION_KEYS];

export const ALL_PERMISSION_KEYS = Object.values(PERMISSION_KEYS);

/**
 * Keys that hold another: whoever holds one of the listed keys holds the
 * key too. Declared once, here; rules read a key through `holdsPermission`,
 * never with an OR of their own. `amendment:manage` opens exactly what
 * `amendment:review` opens (its description says so). Only for checks:
 * getEffectivePermissions, /api/me and the grant rules of the admin panel
 * (adminGrantViolation) keep the keys as granted, so holding an edit key
 * never lets anyone grant the matching view key. On the client
 * `useMe().can` applies the implications and `useMe().granted` keeps the
 * keys as granted, for the admin panel's `not_held` lock.
 */
export const PERMISSION_IMPLIED_BY: Partial<
  Record<PermissionKey, readonly PermissionKey[]>
> = {
  [PERMISSION_KEYS.AMENDMENT_REVIEW]: [PERMISSION_KEYS.AMENDMENT_MANAGE],
  [PERMISSION_KEYS.CONTROL_SHEET_VIEW]: [PERMISSION_KEYS.CONTROL_SHEET_EDIT],
  [PERMISSION_KEYS.SEATING_VIEW]: [PERMISSION_KEYS.SEATING_EDIT],
};

/** A check of one key: Actor.can on the server, useMe().can on the client. */
export type PermissionCheck = (key: PermissionKey) => boolean;

/** Whether `can` holds `key`, itself or through a key that implies it. */
export function holdsPermission(
  can: PermissionCheck,
  key: PermissionKey,
): boolean {
  return can(key) || (PERMISSION_IMPLIED_BY[key] ?? []).some(can);
}

/**
 * Who reads the control sheet (hoja de control) as such: what it notes,
 * its history, every amendment it lists (validated and withdrawn ones,
 * published or not) and the executive offices on it. Whoever reads or
 * edits it, whoever notes the speakers (session:record_speakers) and
 * whoever records results (assembly:vote_result), who both do it from
 * there. The one definition: canViewControlSheet on the server and the
 * sheet's own reads on the client go through `readsControlSheet`.
 */
export const CONTROL_SHEET_READER_KEYS: readonly PermissionKey[] = [
  PERMISSION_KEYS.CONTROL_SHEET_VIEW,
  PERMISSION_KEYS.CONTROL_SHEET_EDIT,
  PERMISSION_KEYS.SESSION_RECORD_SPEAKERS,
  PERMISSION_KEYS.ASSEMBLY_VOTE_RESULT,
];

/** Whether `can` holds a key of CONTROL_SHEET_READER_KEYS. */
export function readsControlSheet(can: PermissionCheck): boolean {
  return CONTROL_SHEET_READER_KEYS.some((key) => holdsPermission(can, key));
}

export const PERMISSION_DESCRIPTION_I18N_KEYS: Record<PermissionKey, string> = {
  [PERMISSION_KEYS.USER_MANAGE_ROLES]:
    "permissions.descriptions.userManageRoles",
  [PERMISSION_KEYS.ROLE_MANAGE_PERMISSIONS]:
    "permissions.descriptions.roleManagePermissions",
  [PERMISSION_KEYS.ASSEMBLY_CREATE]: "permissions.descriptions.assemblyCreate",
  [PERMISSION_KEYS.ASSEMBLY_MANAGE]: "permissions.descriptions.assemblyManage",
  [PERMISSION_KEYS.DOCUMENT_CREATE]: "permissions.descriptions.documentCreate",
  [PERMISSION_KEYS.DOCUMENT_MANAGE]: "permissions.descriptions.documentManage",
  [PERMISSION_KEYS.DOCUMENT_CORRECT_FORM]:
    "permissions.descriptions.documentCorrectForm",
  [PERMISSION_KEYS.AMENDMENT_CREATE]:
    "permissions.descriptions.amendmentCreate",
  [PERMISSION_KEYS.AMENDMENT_MANAGE]:
    "permissions.descriptions.amendmentManage",
  [PERMISSION_KEYS.AMENDMENT_REVIEW]:
    "permissions.descriptions.amendmentReview",
  [PERMISSION_KEYS.ASSEMBLY_VOTE_RESULT]:
    "permissions.descriptions.assemblyVoteResult",
  [PERMISSION_KEYS.SESSION_MODERATE]:
    "permissions.descriptions.sessionModerate",
  [PERMISSION_KEYS.SESSION_RECORD_SPEAKERS]:
    "permissions.descriptions.sessionRecordSpeakers",
  [PERMISSION_KEYS.CONTROL_SHEET_VIEW]:
    "permissions.descriptions.controlSheetView",
  [PERMISSION_KEYS.CONTROL_SHEET_EDIT]:
    "permissions.descriptions.controlSheetEdit",
  [PERMISSION_KEYS.SEATING_VIEW]: "permissions.descriptions.seatingView",
  [PERMISSION_KEYS.SEATING_EDIT]: "permissions.descriptions.seatingEdit",
  [PERMISSION_KEYS.MEMBER_MANAGE]: "permissions.descriptions.memberManage",
  [PERMISSION_KEYS.STATS_VIEW]: "permissions.descriptions.statsView",
  [PERMISSION_KEYS.NOTIFICATION_MANAGE]:
    "permissions.descriptions.notificationManage",
};

/**
 * One icon per permission, wherever permissions are listed. Those with a
 * page of their own take the icon of that page in the sidebar (users,
 * roles, members, assemblies, the session).
 */
export const PERMISSION_ICONS: Record<PermissionKey, string> = {
  [PERMISSION_KEYS.USER_MANAGE_ROLES]: "i-lucide-users",
  [PERMISSION_KEYS.ROLE_MANAGE_PERMISSIONS]: "i-lucide-shield-check",
  [PERMISSION_KEYS.ASSEMBLY_CREATE]: "i-lucide-calendar-plus",
  [PERMISSION_KEYS.ASSEMBLY_MANAGE]: "i-lucide-landmark",
  [PERMISSION_KEYS.DOCUMENT_CREATE]: "i-lucide-file-plus",
  [PERMISSION_KEYS.DOCUMENT_MANAGE]: "i-lucide-folder-cog",
  [PERMISSION_KEYS.DOCUMENT_CORRECT_FORM]: "i-lucide-spell-check",
  [PERMISSION_KEYS.AMENDMENT_CREATE]: "i-lucide-file-pen-line",
  [PERMISSION_KEYS.AMENDMENT_MANAGE]: "i-lucide-file-cog",
  [PERMISSION_KEYS.AMENDMENT_REVIEW]: "i-lucide-badge-check",
  [PERMISSION_KEYS.ASSEMBLY_VOTE_RESULT]: "i-lucide-vote",
  [PERMISSION_KEYS.SESSION_MODERATE]: "i-lucide-gavel",
  [PERMISSION_KEYS.SESSION_RECORD_SPEAKERS]: "i-lucide-notebook-pen",
  [PERMISSION_KEYS.CONTROL_SHEET_VIEW]: "i-lucide-sheet",
  [PERMISSION_KEYS.CONTROL_SHEET_EDIT]: "i-lucide-file-spreadsheet",
  [PERMISSION_KEYS.SEATING_VIEW]: "i-lucide-armchair",
  [PERMISSION_KEYS.SEATING_EDIT]: "i-lucide-move",
  [PERMISSION_KEYS.MEMBER_MANAGE]: "i-lucide-building-2",
  [PERMISSION_KEYS.STATS_VIEW]: "i-lucide-chart-column",
  [PERMISSION_KEYS.NOTIFICATION_MANAGE]: "i-lucide-mail",
};

export const DEFAULT_ROLE_PERMISSIONS: Record<string, PermissionKey[]> = {
  // The association's Secretaría manages everything, users and roles included.
  Secretaría: [...ALL_PERMISSION_KEYS],
  // The association's Presidencia manages everything, users and roles included.
  Presidencia: [...ALL_PERMISSION_KEYS],
  // The CEA keeps the control sheet with the Mesa. To leave it reading only,
  // take CONTROL_SHEET_EDIT from the role at /admin/roles and out of here:
  // the seed only adds grants, and adds back the defaults a role lacks.
  // The CEA and the Mesa lay out the room and seat everyone (Sala).
  CEA: [
    PERMISSION_KEYS.DOCUMENT_CREATE,
    PERMISSION_KEYS.AMENDMENT_CREATE,
    PERMISSION_KEYS.CONTROL_SHEET_VIEW,
    PERMISSION_KEYS.CONTROL_SHEET_EDIT,
    PERMISSION_KEYS.SEATING_VIEW,
    PERMISSION_KEYS.SEATING_EDIT,
  ],
  Asociado: [PERMISSION_KEYS.DOCUMENT_CREATE, PERMISSION_KEYS.AMENDMENT_CREATE],
  // Internal motions are barred by member kind, not by a permission.
  Sectorial: [
    PERMISSION_KEYS.DOCUMENT_CREATE,
    PERMISSION_KEYS.AMENDMENT_CREATE,
  ],
  // The Coordinación del CAS; internal motions are barred by member kind.
  CAS: [PERMISSION_KEYS.DOCUMENT_CREATE, PERMISSION_KEYS.AMENDMENT_CREATE],
  // The Mesa corrects approved texts in form (migration 0055 grants it to
  // every role that moderates or manages documents).
  Moderador: [
    PERMISSION_KEYS.SESSION_MODERATE,
    PERMISSION_KEYS.DOCUMENT_CORRECT_FORM,
    PERMISSION_KEYS.CONTROL_SHEET_VIEW,
    PERMISSION_KEYS.CONTROL_SHEET_EDIT,
    PERMISSION_KEYS.SEATING_VIEW,
    PERMISSION_KEYS.SEATING_EDIT,
  ],
  Invitado: [],
  CAI: [],
  CdG: [],
  Otro: [],
};
