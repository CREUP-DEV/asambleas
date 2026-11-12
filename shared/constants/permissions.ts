export const PERMISSION_KEYS = {
  USER_MANAGE_ROLES: "user:manage_roles",
  ROLE_MANAGE_PERMISSIONS: "role:manage_permissions",
  ASSEMBLY_CREATE: "assembly:create",
  ASSEMBLY_MANAGE: "assembly:manage",
  DOCUMENT_CREATE: "document:create",
  DOCUMENT_MANAGE: "document:manage",
  AMENDMENT_CREATE: "amendment:create",
  AMENDMENT_MANAGE: "amendment:manage",
  AMENDMENT_REVIEW: "amendment:review",
  ASSEMBLY_VOTE_RESULT: "assembly:vote_result",
  SESSION_MODERATE: "session:moderate",
  MEMBER_MANAGE: "member:manage",
  STATS_VIEW: "stats:view",
  NOTIFICATION_MANAGE: "notification:manage",
} as const;

export type PermissionKey =
  (typeof PERMISSION_KEYS)[keyof typeof PERMISSION_KEYS];

export const ALL_PERMISSION_KEYS = Object.values(PERMISSION_KEYS);

export const PERMISSION_DESCRIPTION_I18N_KEYS: Record<PermissionKey, string> = {
  [PERMISSION_KEYS.USER_MANAGE_ROLES]:
    "permissions.descriptions.userManageRoles",
  [PERMISSION_KEYS.ROLE_MANAGE_PERMISSIONS]:
    "permissions.descriptions.roleManagePermissions",
  [PERMISSION_KEYS.ASSEMBLY_CREATE]: "permissions.descriptions.assemblyCreate",
  [PERMISSION_KEYS.ASSEMBLY_MANAGE]: "permissions.descriptions.assemblyManage",
  [PERMISSION_KEYS.DOCUMENT_CREATE]: "permissions.descriptions.documentCreate",
  [PERMISSION_KEYS.DOCUMENT_MANAGE]: "permissions.descriptions.documentManage",
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
  [PERMISSION_KEYS.AMENDMENT_CREATE]: "i-lucide-file-pen-line",
  [PERMISSION_KEYS.AMENDMENT_MANAGE]: "i-lucide-file-cog",
  [PERMISSION_KEYS.AMENDMENT_REVIEW]: "i-lucide-badge-check",
  [PERMISSION_KEYS.ASSEMBLY_VOTE_RESULT]: "i-lucide-vote",
  [PERMISSION_KEYS.SESSION_MODERATE]: "i-lucide-gavel",
  [PERMISSION_KEYS.MEMBER_MANAGE]: "i-lucide-building-2",
  [PERMISSION_KEYS.STATS_VIEW]: "i-lucide-chart-column",
  [PERMISSION_KEYS.NOTIFICATION_MANAGE]: "i-lucide-mail",
};

export const DEFAULT_ROLE_PERMISSIONS: Record<string, PermissionKey[]> = {
  // The association's Secretaría manages everything, users and roles included.
  Secretaría: [...ALL_PERMISSION_KEYS],
  // The association's Presidencia manages everything, users and roles included.
  Presidencia: [...ALL_PERMISSION_KEYS],
  CEA: [PERMISSION_KEYS.DOCUMENT_CREATE, PERMISSION_KEYS.AMENDMENT_CREATE],
  Asociado: [PERMISSION_KEYS.DOCUMENT_CREATE, PERMISSION_KEYS.AMENDMENT_CREATE],
  // Internal motions are barred by member kind, not by a permission.
  Sectorial: [
    PERMISSION_KEYS.DOCUMENT_CREATE,
    PERMISSION_KEYS.AMENDMENT_CREATE,
  ],
  // The Coordinación del CAS; internal motions are barred by member kind.
  CAS: [PERMISSION_KEYS.DOCUMENT_CREATE, PERMISSION_KEYS.AMENDMENT_CREATE],
  Moderador: [PERMISSION_KEYS.SESSION_MODERATE],
  Invitado: [],
  CAI: [],
  CdG: [],
  Otro: [],
};
