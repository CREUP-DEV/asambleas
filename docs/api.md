# API

Every shape lives in [`shared/types/api.ts`](../shared/types/api.ts). Request
bodies are validated with Zod v4 schemas in `shared/utils/schemas/`, which must
match those types. Model and rules: [`design.md`](./design.md).

## Conventions

The usual AGENTS.md handler order applies:

1. `requireActor(event)` from `server/utils/domain/actor.ts`.
2. Resolve the route params.
3. Validate the body.
4. Run the DB work in a transaction.
5. Call `recordEvent`.
6. Return the DTO.

- **Route params.**
  - `[assembly]` accepts the slug (`80-ago`) or the id. Resolve it with
    `resolveAssembly`.
  - `[document]` accepts the slug or the id within the assembly.
  - `[amendment]` and `[item]` are CUIDs.
  - All resolvers live in `server/utils/domain/resolvers.ts`, and they return
    404 whenever the actor cannot see the target (`visibility.ts`).
- **Mutations.** CSRF and same-origin are enforced by the `serverHandlers`
  middleware. Every new top-level API section (`/api/members`, `/api/me`) needs
  its entry in `nuxt.config.ts`.
- **Optimistic locking.** Shared PUT, PATCH and POST mutations of existing
  rows take `updatedAt` and use `buildOptimisticLockCondition`, so the write is
  atomic. A conflict returns 409.
- **Row locks.** Transactions lock rows in one order: assembly, document,
  amendments (by id), acceptances, `live_state`. A path that settles an
  amendment locks the transactionals over it in the same amendment pass,
  since settling it closes them. A transaction that moves the
  live projection from a document or amendment path share-locks the assembly
  before the document. One that may write agenda rows from a document path
  (creating a document, deleting one, moving or renaming one) takes the
  assembly lock of the agenda endpoints (`lockAssembly`) before the document,
  so it serializes with an agenda delete. Explicit locks are `FOR NO KEY UPDATE` or `FOR SHARE`,
  and `FOR UPDATE` only on a row that is deleted, so foreign key checks never
  wait on them. "Row locks" in `server/utils/domain/documents.ts` has the
  details.
- **Error messages.** Use `createError({ statusCode, message })` with Spanish
  messages. The client maps status codes to i18n keys.
- **History.** Every state change calls `recordEvent` inside the same
  transaction, with `documentId` set for document-scoped changes. Event
  `type` values are `snake_case` verbs, for example `amendment_submitted`,
  `vote_recorded` and `live_changed`.

## Members and me

| Method | Path                                | Who                       | Notes                                                                                                                                         |
| ------ | ----------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/me`                           | any                       | `MeDto`. `permissions` are the role's plus the user's own grants (see "Permissions" below).                                                   |
| GET    | `/api/me/work`                      | any                       | `MeWorkDto`, see "Review and work" below.                                                                                                     |
| GET    | `/api/members`                      | any                       | `MemberDto[]`, active first, by acronym. `?all=1` also returns inactive members. One generic entry instead of the executive areas, see below. |
| POST   | `/api/members`                      | `member:manage`           | Creates a member manually, typically an executive area.                                                                                       |
| PUT    | `/api/members/[id]`                 | `member:manage`           | Edits name, kind or active, with `updatedAt`.                                                                                                 |
| POST   | `/api/members/sync`                 | `member:manage`           | Optional body `MemberSyncBody`. Syncs the intranet roster. Returns `MemberSyncResult`; 409 when it needs confirmation, see "Roster sync".     |
| GET    | `/api/admin/users`                  | `user:manage_roles`       | Paginated `AdminUserDto` rows, each with `member`, `extraPermissions` and its access state. See "Users list".                                 |
| PUT    | `/api/admin/users/[id]/role`        | `user:manage_roles`       | Body `{ roleId }`. Only an Admin gives or takes Admin, Secretaría or Presidencia.                                                             |
| PUT    | `/api/admin/users/[id]/member`      | `user:manage_roles`       | Body `{ memberId: string \| null }`. Links an account to a member, see below.                                                                 |
| PUT    | `/api/admin/users/[id]/permissions` | `user:manage_roles`       | Body `{ permissions: PermissionKey[] }`. Sets the user's own grants, see "Permissions".                                                       |
| GET    | `/api/admin/roles`                  | see notes                 | The roles. `user:manage_roles` or `role:manage_permissions`.                                                                                  |
| GET    | `/api/admin/roles/[id]/permissions` | see notes                 | What a role grants. `user:manage_roles` or `role:manage_permissions`.                                                                         |
| PUT    | `/api/admin/roles/[id]/permissions` | `role:manage_permissions` | Body `{ permissionKeys }`. Not on the Admin role, see "Admin section".                                                                        |
| GET    | `/api/admin/permissions`            | see notes                 | The permission catalog. `user:manage_roles` or `role:manage_permissions`.                                                                     |

**Executive areas (`MemberRef`).** Wherever an answer carries a member
(`MemberRef`, `MemberDto`, a bare member id such as `mainAuthorId` or the
ids in an event payload), an executive area is itself only for the accounts
that see the areas: Admin, Secretaría, Presidencia, Moderador and CEA, the
holders of `document:manage`, `amendment:review`, `amendment:manage`,
`assembly:manage`, `session:moderate`, `member:manage` or
`user:manage_roles`, and the accounts that act for an area. Everyone else
gets the generic presenter
`{ id: GENERIC_EXECUTIVE_MEMBER_ID, acronym: "CEA", name: "Comisión Ejecutiva Ampliada", kind: "executive" }`
(`shared/constants/domain.ts`) instead, once per list:

- documents: `proponent` and `coProponents` (not repeated among the
  co-presenters when the main presenter is an area);
- amendments: `authors`, `mainAuthorId` and `acceptances` (the areas answer
  as one party: rejected if any did, pending while any is);
- both histories: `actorMember`, and `actorName` is null when the member
  acted for is an area; member ids in `payload` become the generic id;
- `/api/me/work`: `acceptances[].proposedBy`, `news[].by` and every document
  and amendment in it;
- `/api/me/activity`: `actor.member`, and `actor.id` and `actor.name` are
  the generic id and name unless the act is the account's own; member ids
  in `payload`; a member target that is an area has the generic id, the
  label `CEA` and an empty payload;
- speaking turns: `member`, and `speaker` is null for an area's turn;
- `GET /api/members`: one generic `MemberDto` instead of all the areas
  (`active` while any area is; it cannot be edited), placed where "CEA"
  sorts, as among the co-presenters of a document;
- PDF exports name the area as `CEA`, according to who requested them.

`MeDto.member` is always the account's real member. The generic id is not a
member. In a body (`proponentMemberId`, `coProponentMemberIds`,
`authorMemberIds`, `mainAuthorMemberId`) the rule is:

- an account that does not see the areas cannot add one, by its real id or
  by the generic one: 422 with `data: { reason: "executive_member" }`
  (`EXECUTIVE_MEMBER_REFUSED_REASON`). It cannot remove one either: the
  areas already on the document or amendment stay whatever its list says.
  The generic id is accepted only as a stand-in for them (in a list), or
  for the area that is main presenter or main author, or the only area
  there (as the main one); otherwise 422 `executive_member`. As the main
  one with several areas there and none of them in that place, it cannot
  say which: 422 with `data: { reason: "executive_main" }`
  (`EXECUTIVE_MAIN_REFUSED_REASON`), since nothing was added;
- an account that sees the areas names them by their real ids; the generic
  id gets the same 422.

**Intranet.** Every call to the intranet API (role sync, `POST /user/role`,
and the roster sync, `GET /usuarios/asociados` and `/usuarios/sectoriales`)
sends `Authorization: Bearer <NUXT_INTRANET_API_TOKEN>` when that variable
is set (a blank value counts as unset). The token is never logged, and
neither is an email: logs carry `accountRef`. The role lookup also sends
`Accept: application/json`. In production, `NUXT_INTRANET_API_URL` and
`NUXT_ROLE_API_URL` must be `https:`, or `http:` to a host with no dot
(`http://intranet`); anything else counts as unset. A `NUXT_ROLE_API_URL` on
another origin than `NUXT_INTRANET_API_URL` never receives the token. Details
in [`intranet.md`](./intranet.md), section 1.

**Sign-in and access.** The role lookup runs once per sign-in, before the
session is created. An account the Intranet deleted (an authenticated 404
`{"error":"not_found"}` for an account it knew before) loses access, unless
it holds a protected role; see "Access and deleted accounts" in
[`design.md`](./design.md). A refused sign-in lands on the login page of the
user's language with `?error=<code>` and the same `redirect` (the client's
`errorCallbackURL`; `onAPIError.errorURL`, `/login`, is the fallback), with
`access_revoked` (the account has no access) or
`sign_in_unavailable` (the access check failed); the login page shows a
localized message for each and a general one for any other code, and never
`error_description`. `auth.sign_in` records the lookup outcome in `roleSync`:
`ok`, `not_found`, `failed` or `unconfigured`. Every request then reads
`access_revoked_at`: an account without access gets 401 on every endpoint,
`GET /api/auth/session` included, so the client sends it to `/login`. A
daily re-check (05:30 Europe/Madrid) revokes the accounts with a live
session that the Intranet deleted.

**Roster sync.** `POST /api/members/sync` takes an optional body
`MemberSyncBody` `{ confirmDeactivation?: boolean, confirmedKinds?: [{ kind,
toDeactivate }] }` (at most one entry per kind); no body is `{}`, and an
invalid one answers 400. It answers 503 without a usable
`NUXT_INTRANET_API_URL` and 502 when either list fails, writing nothing.
Members are matched by `intranet_id`, then by acronym. A sync that would
deactivate every active intranet member of a kind, or more than max(3, 30%)
of them, needs `confirmDeactivation: true` and, in `confirmedKinds`, every
kind it would deactivate too much of with at least as many members as it
would deactivate now. Otherwise nothing changes but a `members.sync_blocked`
audit row, and the answer is 409 with `data: MemberSyncBlockedData`
`{ reason: "large_deactivation", kinds: [{ kind, active, toDeactivate }] }`,
listing only the kinds over the limit with the current counts. The members
page shows those counts and sends the request again with them; if the
Intranet answers less on that retry (say 100 to deactivate where 5 were
confirmed), it gets 409 again with the new counts. The same sync runs daily
at 05:00 Europe/Madrid with no actor, and it never confirms.

**Users list.** `GET /api/admin/users` takes `page`, `pageSize` (up to 100,
default 50) and `access`: `all` (the default) or `revoked`, the accounts whose
`access_revoked_at` is set. `q` searches, case-insensitively, the name, the email,
the intranet initials and the acronym or name of the member the account
acts for (at most 100 characters; blank is no search). Order is by name. An invalid value answers 400
("Paginación o filtro inválidos"). Each row (`AdminUserDto`) carries
`accessRevokedAt` and `accessRevokedReason` (`intranet_deleted`), null while
the account has access; `PUT .../member` and `.../permissions` return the
same row.

**Permissions.** A user's permissions are the union of their role's
(`role_permissions`) and the ones an admin granted to that user alone
(`user_permissions`); Admin has every key. The same set backs `requireActor`,
`requirePermission`, `GET /api/auth/permissions`, `GET /api/me` and the export
worker, and it is cached per user for a minute (a change through the endpoint
below takes effect at once). The association's `Secretaría` and `Presidencia`
hold every permission, users and roles included: `pnpm db:seed` adds the
missing grants to their existing role rows (it never removes any). Both are
kept by role sync, like `Admin` and `Moderador`, which the Mesa's Vocalía and
Presidencia keep (`session:moderate`).

**Admin section.** `/api/admin/**` opens by permission, not by role: the
`serverHandlers` gate (`server/handlers/auth.ts`) lets in users holding
`user:manage_roles` or `role:manage_permissions` (Admin holds every key) and
each endpoint checks its own:

- users, their roles, their member links and their grants need
  `user:manage_roles`;
- changing what a role grants needs `role:manage_permissions`;
- reading the roles, what each grants and the permission catalog needs
  either, since assigning roles and grants shows them too;
- only an Admin gives or takes the Admin role: `PUT .../users/[id]/role`
  answers 403 to anyone else when the new role or the user's current one is
  Admin. Only an Admin changes its own role (403 for anyone else, "Solo un
  Admin puede cambiar su propio rol"), and the last Admin who can sign in
  cannot leave the role (409): give it to someone else first. An Admin
  without access (`access_revoked_at`) does not count. The Admin accounts
  are locked in id order, so two Admins leaving at once cannot both go;
- the role of an account without access never changes: `PUT
.../users/[id]/role` answers 409 with `data.messageKey`
  `admin.users.errors.targetRevoked`, also when the account lost access
  while the request ran. Access, and with it the role, comes back only from
  the Intranet;
- only an Admin may touch the Admin role's permissions (403 for anyone
  else); it holds every permission anyway, so even an Admin gets 400;
- only an Admin changes the access of the association's Secretaría and
  Presidencia (403 for anyone else, "Solo un Admin puede cambiar el rol o
  los permisos de Secretaría y Presidencia"): giving or taking either role
  (`PUT .../users/[id]/role` when the new role or the user's current one is
  one of them; saving the role the user already has is fine), what either
  role grants (`PUT .../roles/[id]/permissions`), and the grants of an
  account that holds either role (`PUT .../users/[id]/permissions`). So
  Secretaría and Presidencia cannot change each other's access
  (`touchesLeadershipRole` in `server/utils/auth/rbac.ts`);
- holding these permissions never lets anyone raise their own access or
  lock themselves out. A non-Admin gets 403 when it changes its own role
  (above), the grants or the member link of its own account (acting for a
  member is acting with its rights), when it takes `user:manage_roles` or
  `role:manage_permissions` away from the role it holds (it would lock
  itself, and everyone with that role, out of this section; giving them is
  fine, and so are other changes to that role under the next rule), or
  when it adds or removes a key it does not hold itself: as a user's
  grant, in a role, or by giving a user a role that holds a key its current
  one does not (or the other way round). Only the keys that change count,
  so saving an unchanged list is fine. An Admin passes all of these
  (`adminGrantViolation` in `server/utils/auth/rbac.ts`). Secretaría and
  Presidencia hold every key, so in practice this keeps each one away from
  its own account and role assignment, and keeps their own role able to
  manage users and roles;
- an Admin account's grants and member link may be edited by anyone with
  `user:manage_roles`: they change nothing about what an Admin can do,
  since Admin holds every key.

`PUT /api/admin/users/[id]/permissions` replaces the user's grants with
`permissions` (an empty list removes them all): grants left out are revoked
and kept ones keep who granted them. Role permissions are never subtracted. A
malformed body returns 400 and keys outside the catalog 422 with
`data: { unknown }`, never ignored; an unknown user 404. It writes
`user.permissions_set` to the audit log (`before` and `after` lists) and
returns the user row as `GET /api/admin/users` lists it, whose rows carry
`extraPermissions: PermissionKey[]` in catalog order.

**Linking accounts to members.** After each successful role lookup, role sync
links `users.memberId`:

- `Asociado` and `Sectorial` accounts are the member itself: the member of
  that kind with the account's intranet id (`users.intranet_id` =
  `members.intranet_id`), else the one with its `initials` (the member's
  acronym). A member found by acronym whose `intranet_id` belongs to another
  account is not linked, and a warning is logged. A missing member is created
  as an intranet member with the account's id, and the next roster sync
  fills it in.
- `CEA` accounts (role shown as "Comisión Ejecutiva Ampliada (CEA)") act for
  their executive area (shown as "Área de la CEA"). A missing area is created as a
  manual `executive` member named after its acronym (the intranet name may be
  the person's), so the roster sync never deactivates it; an admin renames
  it. CEA accounts link by initials only, since their intranet id is a
  person's. A CEA account is never linked to a council or a sectorial that
  shares its initials.
- Other types leave `memberId` alone.
- A CEA account that already acts for a member keeps it while its intranet
  initials stay the same, so a link an admin set by hand is not undone at
  the next sign-in. When the initials change (the cargo moved to another
  area), it is linked again by them. Asociado and Sectorial accounts always
  follow their id or their initials.
- An account stops acting for its member (`memberId` becomes null, in the
  same transaction as the role change) when it has a synced role (`Invitado`,
  `Asociado`, `Sectorial`, `CEA`) and either its role changes with its
  intranet type (a CEA cargo whose term ended becomes `Invitado`, a
  sectorial that signed in as `Invitado` becomes `Sectorial`) or its
  intranet type stops being `Asociado`, `Sectorial` or `CEA`. The new type,
  if it is one of those, links it again. `Admin`, `Secretaría`,
  `Presidencia` and `Moderador` accounts keep their role and their link.
- When the role resolved by the sync has no row (the database was not seeded
  after a role was added), the sync logs a warning; a new account gets
  `Invitado` instead, and an existing one keeps its role and its member. Run
  `pnpm db:seed` after deploying a new role.

Whoever holds `user:manage_roles` links an account by hand with
`PUT /api/admin/users/[id]/member` (only an Admin its own account, 403
otherwise, see "Admin section"):
when its initials are missing, or when a CEA account's initials are the
person's rather than the area's (the sync then created an `executive` member
named after them, which the admin can deactivate). The member must exist
(404) and be active (422); `null` unlinks it. The change is written to the
audit log (`user.member_link`). It returns the user row as
`GET /api/admin/users` lists it, which now includes `memberId` and `member`
(`MemberRef` or null). A manual link on an Asociado or Sectorial account with
an id or initials is replaced at its next sign-in, and a CEA account's when
its initials change. An account that loses access (see "Sign-in and
access") loses its member link too.

An account with no member that tries to create a document or an amendment
gets 403 with the next step: ask the Secretaría to link it.

## Assemblies and calendar

| Method | Path                                  | Who               | Notes                                                                                                                                            |
| ------ | ------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/assemblies`                     | any               | `AssemblyListDto`. Drafts are listed only for managers. Takes `?status=&type=&page=`.                                                            |
| POST   | `/api/assemblies`                     | `assembly:create` | `AssemblyCreateBody`. Seeds the milestones from `defaultMilestones` with the calendar rules of the type, unless told not to.                     |
| GET    | `/api/assemblies/[assembly]`          | visible           | `AssemblyDto`, including the milestones, the type's `calendarRules` and the warnings from `checkCalendar`.                                       |
| PUT    | `/api/assemblies/[assembly]`          | `assembly:manage` | `AssemblyUpdateBody`. Settings are merged (see below).                                                                                           |
| DELETE | `/api/assemblies/[assembly]`          | `assembly:manage` | Only in `draft`.                                                                                                                                 |
| PUT    | `/api/assemblies/[assembly]/status`   | `assembly:manage` | Follows `ASSEMBLY_STATUS_TRANSITIONS`. Entering `in_session` creates the `live_state` row. Closing ends the speaking turns (see speaking turns). |
| PUT    | `/api/assemblies/[assembly]/calendar` | `assembly:manage` | `CalendarBody`. Upserts or deletes the milestones and toggles `agendaFinalizedAt`. Returns `AssemblyDto`.                                        |
| GET    | `/api/assemblies/[assembly]/review`   | see notes         | `ReviewQueueDto`, the Secretaría's validation inbox. `document:manage` or `amendment:review`, otherwise 403. See "Review and work" below.        |

**Calendar warnings.** `calendarWarnings` comes from `checkCalendar` with the
calendar rules of the assembly's type. For managers, `calendarDocuments` lists
the amendable `regulation` and `statutes` documents (not withdrawn or
postponed) with their own windows, so the reform window check
(`regulation_window_short`) runs on the server and again in the calendar
editor while dates change; it is empty for everyone else. A warning carries
the broken minimum (`limit`, an offset, or `days`) and, for the reform
window, the `document`.

**Settings.** `AssemblyDto.settings` is the stored JSON merged over
`DEFAULT_ASSEMBLY_SETTINGS`, reading only the keys the defaults have. Keys of
removed policies, such as the old `amendmentVisibility`, are neither returned
nor kept: the next `PUT` writes the settings back without them.

## Calendar rules

The default deadlines and regulatory minimums of each assembly type
(`calendar_rules`, docs/design.md "Calendar and convocatoria"). Both need
`CALENDAR_RULES_PERMISSION` (`assembly:manage`) and are read-only while an
Admin impersonates (403 `admin.impersonationReadOnly`).

| Method | Path                         | Notes                                                                                                                                                                                                                                                                                                                                                    |
| ------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/calendar-rules`        | `CalendarRulesDto[]`, one per type in `ALL_ASSEMBLY_TYPES` order. A type with no stored row shows `INITIAL_CALENDAR_RULES` with `stored: false` and `updatedAt: null`.                                                                                                                                                                                   |
| PUT    | `/api/calendar-rules/[type]` | `CalendarRulesBody` (`rules` plus the `updatedAt` read, null while the type has no stored row: the call then stores the first one). 404 for an unknown type, 400 for invalid rules (strict: unknown milestones, mixed units or keys are refused), 409 on a stale `updatedAt` (a row that appeared or changed meanwhile). Writes `calendar_rules.update`. |

`rules.quorum` (optional, so rows stored before it stay valid) holds the
quorum of each call: `{ numerator, denominator, strict }`, a share of the
asociados with a vote, "at least" or, with `strict`, "more than";
`secondCall` is null for a type with a single call.

## Agenda

| Method | Path                                                 | Who               | Notes                                                                                                                                                                                                                                                                    |
| ------ | ---------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/assemblies/[assembly]/agenda`                  | visible           | `AgendaDto`: flat items plus the documents the actor can see. Automatic sub-items of documents the actor cannot see are left out.                                                                                                                                        |
| POST   | `/api/assemblies/[assembly]/agenda`                  | `assembly:manage` | `AgendaItemBody` (`title`, `parentId`, `description`, `acceptsSubmissions`, `submissionKinds`, `confirmFinal`). Returns `AgendaItemDto`.                                                                                                                                 |
| PUT    | `/api/assemblies/[assembly]/agenda/[item]`           | `assembly:manage` | `AgendaItemBody` with `updatedAt`. Returns `AgendaItemDto`. A new title on an automatic sub-item sets `titleCustom`.                                                                                                                                                     |
| DELETE | `/api/assemblies/[assembly]/agenda/[item]`           | `assembly:manage` | Deletes the item with its sub-items and every document under them. 409 `agenda_item_amendments` while any of those documents has an amendment of any status; 409 `agenda_item_live` during the session while one of them is being debated. See "Deleting an item" below. |
| PUT    | `/api/assemblies/[assembly]/agenda/reorder`          | `assembly:manage` | `AgendaReorderBody`. Validates that every parent exists in the same assembly and that there are no cycles.                                                                                                                                                               |
| POST   | `/api/assemblies/[assembly]/agenda/[item]/documents` | `document:manage` | `BulkDocumentsBody`. Creates several documents under the item, all or none. Returns 201 `BulkDocumentsDto`. See "Adding several documents" below.                                                                                                                        |

Once the agenda is final (`agendaFinalizedAt`), a change to the root items
needs a confirmation: creating one (POST), renaming one or moving an item
from or to the root level (PUT `[item]`), changing which items are root items
or their order (PUT `reorder`) and deleting one (DELETE). The request says
`confirmFinal: true` in the body (`?confirmFinal=true` in the query of the
DELETE, which has no body). Without it the answer is 409 with
`data: { code: "agenda_final" }` (`AGENDA_FINAL_CONFLICT_CODE`) and nothing
changes, so the client asks "El orden del día ya es definitivo. ¿Cambiarlo
igualmente?" and sends the request again. The event of a confirmed change
carries `afterFinal: true`. Sub-items, and the description and submissions
switch of a root item, never need `confirmFinal` and never get `afterFinal`;
on a provisional agenda `confirmFinal` is ignored (`confirmFinalRootChange`).

The agenda is marked as final or reopened with PUT `calendar`
(`{ milestones: [], agendaFinal }`), from the agenda page; it records
`agenda_finalized` or `agenda_reopened`.

**Items where members present ("containers").** `acceptsSubmissions` marks an
item where members present documents, and `submissionKinds` names the
document kinds it takes; an empty list means every kind (`itemAcceptsKind` in
`shared/utils/agendaSubmissions.ts`). `AgendaItemBody.submissionKinds` is
optional: left out, a POST stores none and a PUT keeps the stored ones. It is
stored empty while `acceptsSubmissions` is off. The kinds bind members only:
a member that creates a document of another kind there, moves one in or
changes the kind of one already there gets 422 with
`data: { reason: "submission_kind" }`; managers put any kind anywhere.

**Automatic sub-items.** Every document created under an item that accepts
submissions, by a member or by a manager, gets its own sub-item in the same
transaction: titled like the document, last among its siblings, with
`acceptsSubmissions` false, and the document hangs from it (so the
`agendaItemId` of the answer is the sub-item's). The same happens when a
document is moved (PUT) to such an item. `AgendaItemDto` says it with `auto:
true` and `generatedForDocumentId`. The sub-item:

- takes the document's new title when the document is renamed, until a manager
  renames the sub-item itself (PUT `[item]` with another title sets
  `titleCustom`); from then on it keeps its own;
- is deleted when its document is deleted or moved to another item, unless it
  holds another document or a sub-item by then; kept that way after a move,
  it becomes an ordinary item (`auto` false, `generatedForDocumentId` null).
  Moving the document to the item its sub-item hangs from changes nothing,
  whatever the sub-item holds. The session keeps going on its parent (the
  projection and the open speaking turns move there);
- takes no other document: creating one under it (single or bulk) or moving
  one into it answers 422 with `data: { reason: "auto_item" }`, for managers
  too;
- has `auto: true` and `documentId` in the payload of all its events, the
  manager's PUT `[item]` included, so the activity shows them only to those
  who see the document;
- never needs `confirmFinal` nor gets `afterFinal`: it is a sub-item;
- is left out of `AgendaDto.items` for a viewer who cannot see its document
  (another member's draft), since it carries that document's title, unless
  it holds a document the viewer sees or a sub-item (`visibleAgendaItems`).
  The assembly export leaves out those of unpublished documents. Numbering
  computed from the items can therefore differ between viewers until the
  documents are published.

Its events are `agenda_item_created`, `agenda_item_updated` (the title
following the document) and `agenda_item_deleted`, each with `auto: true` and
the `documentId`; the activity shows them to those who can see that document.

**Deleting an item.** DELETE removes the item, its sub-items and every
document under them, in one transaction. Only amendments keep it: while any
of those documents has an amendment row of any status (drafts and withdrawn
ones included) the answer is 409 with
`data: { code: "agenda_item_amendments", documents, amendments }` (how many
documents have amendments and how many amendments in all) and nothing
changes. Published and voted documents without amendments go. While the
assembly is `in_session` it is also refused, 409 with
`data: { code: "agenda_item_live" }`, if the projection shows one of the
items or documents or one of the items has a speaking turn waiting or in
progress. Each document goes as in DELETE `documents/[document]`
(`removeDocument`: its `document_deleted` event, the votes of its final vote,
the projection, and its PDF and images once the delete commits), without
`deleteBlocker` (a final vote does not keep it). Each item records its own
`agenda_item_deleted`: the one asked for lists the sub-items written by hand
in `deletedItems` and says `deletedDocuments`; the others say `cascade:
true`. To word the confirmation the client counts sub-items and documents
from `AgendaDto`, and reads `DocumentSummaryDto.hasAmendments` to know
beforehand whether the delete is blocked.

**Adding several documents.** `POST .../agenda/[item]/documents` takes
`BulkDocumentsBody`: `{ documents: [{ title, kind, format, proponentMemberId?,
dueAt? }] }`, 1 to 30 rows (`BULK_DOCUMENTS_MAX`). It creates them all or
none: each one an empty draft with the defaults of its kind, with its
automatic sub-item when the item accepts submissions and hanging from the
item itself otherwise. A row without `proponentMemberId` (or with null) has
no presenter; it never defaults to the manager's own member. The rules of a
single create apply to each row (`presenter_kind`, a member that does not
exist or is inactive); the error of a row carries `data.index`, its position
in the request. It answers 201 with `BulkDocumentsDto`: `{ documents: [{ id,
slug, title, kind, format, agendaItemId }] }` in the order sent, so the
client uploads a PDF to each `file` document through `POST
.../documents/[document]/file`. Each document records `document_created` and
each sub-item `agenda_item_created`.

## Documents

| Method | Path                                                         | Who                            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------ | ------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/assemblies/[assembly]/documents`                       | visible                        | `DocumentSummaryDto[]`. `amendmentCount` counts the amendments past draft that the actor can see (see who sees an amendment). `hasAmendments` says whether the document has any amendment at all, drafts and unpublished ones included, to accounts with `document:manage` or `assembly:manage`; null for everyone else.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| POST   | `/api/assemblies/[assembly]/documents`                       | see below                      | `DocumentCreateBody`. Creates a draft and its working version. Under an item that accepts submissions it also creates the automatic sub-item, so the `agendaItemId` returned is the sub-item's.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GET    | `/api/assemblies/[assembly]/documents/[document]`            | visible                        | `DocumentDto`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| PUT    | `/api/assemblies/[assembly]/documents/[document]`            | editor                         | `DocumentUpdateBody`. `format` switches between text and PDF until publication (409 after); the draft text and the PDF both stay for a switch back, and a PDF is never amendable. Status changes return 409 once the final vote is recorded. A new `title` renames its automatic sub-item unless that has its own title; a new `agendaItemId` removes the automatic sub-item left empty and, under an item that accepts submissions, creates a new one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| DELETE | `/api/assemblies/[assembly]/documents/[document]`            | `document:manage`              | Returns 409 with a final vote (annul it first) or, once published, while it has any amendment, drafts included (`deleteBlocker`; withdraw it instead). Takes its versions, co-presenters and the votes of an annulled final vote with it, and clears the live projection if it shows it. `DocumentDto.can.delete` mirrors the rule. Its automatic sub-item goes with it when it holds nothing else.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| PUT    | `/api/assemblies/[assembly]/documents/[document]/content`    | editor                         | `DocumentContentBody`. Replaces the working draft. Returns 409 if `baseHash` is stale or the document is published.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| POST   | `/api/assemblies/[assembly]/documents/[document]/import`     | editor                         | Multipart DOCX up to 15 MB, with magic bytes checked. Returns `DocxImportDto` and saves no text; the file's pictures are stored for the document as images (as by the upload below), recording one `document_images_imported` with their count. The archive's real inflated size and entry count are bounded, mammoth runs in a child process with its own heap and time limit, and the HTML it returns is bounded in nodes, nesting, block elements and formatting marks before it is parsed. `warnings` lists what was lost: `tracked_changes`, `comments`, `images_dropped` (a picture that could not be read or stored, or past 100 pictures or 32 MB), `images_in_tables` (pictures in a table or list, left out), `images_without_alt` (stored pictures with no description), `tables_flattened` (a table nested in a table cell became a paragraph per row) and `highlight`. A Word title equal to the document's title is left out. 413 when a size or markup limit is exceeded, 415 for a corrupt or non-DOCX file, 422 when the document exceeds the content limits (blocks, text per paragraph, nesting, formatting) or has no usable text (that one carries `data: { reason: "empty" }`, since splitting the file cannot help), 429 when the user already has an import running or waiting or the conversion queue is full (an import whose client disconnects leaves the queue at once), 500 when the converter cannot start. |
| POST   | `/api/assemblies/[assembly]/documents/[document]/images`     | editor                         | Multipart `file`: a PNG or JPEG up to 10 MB for the text of a structured draft (409 once the text is frozen, or past 200 images). Checked by signature and written again by `sharp` (upright, no metadata, at most 2,400 px a side). Returns `{ asset, width, height }`; records `document_image_uploaded`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| GET    | `/api/uploads/images/[image]`                                | visible                        | A stored image, to whoever can see its document (404 otherwise), with its own type, `nosniff` and private caching.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| POST   | `/api/assemblies/[assembly]/documents/[document]/file`       | `document:manage` or proponent | PDF upload for the `file` format. See PDF replacement below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| POST   | `/api/assemblies/[assembly]/documents/[document]/submit`     | proponent                      | A presenter sends a draft to the Secretaría (`submitted`). See validation below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| POST   | `/api/assemblies/[assembly]/documents/[document]/correction` | `document:manage`              | `CorrectionBody`. Sends a submitted document back to draft with a note. Returns `DocumentDto`. See validation below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| POST   | `/api/assemblies/[assembly]/documents/[document]/publish`    | `document:manage`              | Validates (publishes) the document. See publishing rules below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GET    | `/api/assemblies/[assembly]/documents/[document]/history`    | visible                        | `EventDto[]` for the document and its amendments, respecting amendment visibility. Correction notes are removed from the payload for those who may not read them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| POST   | `/api/assemblies/[assembly]/documents/[document]/final-vote` | `session:moderate`             | `FinalVoteBody`. See final vote rules below. Returns `DocumentDto`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| DELETE | `/api/assemblies/[assembly]/documents/[document]/final-vote` | `session:moderate`             | `FinalVoteAnnulBody`. Annuls the final vote, see below. Returns `DocumentDto`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| POST   | `/api/assemblies/[assembly]/documents/[document]/export`     | visible                        | Body `{ variant: "clean" \| "annotated", locale }`. Enqueues a PDF export and returns `{ jobId }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

**Who can create.** Managers (`document:manage`) can always create a document,
for any members (see presenters below) and with no content. Members with
`document:create` (Asociado, Sectorial and CEA accounts) can create one under
an agenda item that has `acceptsSubmissions`, of a kind the item takes
(`submissionKinds`; 422 `submission_kind` otherwise), until the
`documents_close` milestone, always as one of its presenters. Under such an
item the document gets its own automatic sub-item (see Agenda), whoever
creates it.

**Who may present a kind.** A sectorial never presents an internal motion,
as main presenter or as co-presenter (it may amend one). The rule follows the
member, not the account's role (`memberMayPresent` in
`shared/utils/presenterKinds.ts`): `POST` and `PUT` check the kind and every
presenter the document ends with, for managers too, and answer 422 with
`data: { reason: "presenter_kind" }` (the message names the sectorials). A
`PUT` that changes neither the kind nor the presenters is not checked.

**Who may use a PDF.** A kind that takes amendments by default
(`DOCUMENT_KIND_DEFAULTS[kind].amendable`) is presented as text: only
managers store one with `format: "file"`. A non-manager `POST` with such a
kind and `format: "file"`, or a `PUT` that switches such a document to
`file` or moves a PDF to such a kind, gets 422 with
`data: { reason: "file_kind" }` (`fileFormatRefused` in
`shared/utils/documentFormat.ts`). A PDF a manager stored for such a kind
stays editable by its presenters, who may always switch it back to text.

**Presenters.** A document has a main presenter (`proponentMemberId`,
`DocumentSummaryDto.proponent`), who alone answers its amendments, and may
have co-presenters (`document_proponents`, `DocumentSummaryDto.coProponents`
by acronym), who prepare the text with it and see what it decides. Bodies
carry `proponentMemberId` and `coProponentMemberIds` (never the main
presenter; up to 20, no repeats). The rules (`planPresenters` in
`server/utils/domain/presenters.ts`):

- with co-presenters there must be a main presenter: 422 otherwise;
- managers set any members (they must exist and be active, 422; a
  presenter set earlier stays even if the roster sync deactivates it). On
  create the main
  presenter defaults to their own member, and an explicit `null` leaves it
  empty when there are no co-presenters;
- a member creating its own document is always one of its presenters: its
  member joins the co-presenters unless it is the main presenter. With
  co-presenters it names the main presenter (422 when it names none). The
  main presenter named is a presenter too, so a member may add another member
  and make it the main one in the same body (`proponentMemberId: b`,
  `coProponentMemberIds: [own]`);
- on `PUT`, presenters may change them while the document is a draft (it is
  the only time they can edit it), with the same rules, and their own member
  cannot leave (422). Only the main presenter itself or a manager changes
  who the main presenter is: a co-presenter (or the user who created the
  document without presenting it) naming another one, itself included, or
  none gets 403 with `data: { reason: "main_only" }`; it may still change
  the co-presenters. Managers change them at any time. Fields left out keep
  their value. Naming a new main presenter without `coProponentMemberIds`
  keeps the former one as a co-presenter: always for a presenter, and for a
  manager when the new one was already a presenter (otherwise a manager
  replaces it);
- the main presenter listed among the co-presenters is dropped from them.

The change is recorded in `document_created` and `document_updated`
(`proponentMemberId`, `coProponentMemberIds`).

**Accepted amendments.** `acceptedAmendments` (`DocumentSummaryDto`, create
and update bodies) says what an amendment the main presenter accepts
becomes: `incorporate` approves it at once, `vote` leaves it to the assembly
(see the main presenter's answer below). It defaults from the kind
(`DOCUMENT_KIND_DEFAULTS`: regulations incorporate). Only managers change it:
a presenter's value is ignored on create and refused on update (403), and a
presenter changing the kind gets the kind's default, as with `amendable`,
`voted` and `majority`.

Changing it on a published document applies the new rule to the amendments
the main presenter already answered, so the rule always says what an
accepted amendment is (`acceptedRulePlan`, `applyAcceptedAmendmentsRule`):

- to `incorporate`: every undecided amendment with an `accept` answer that
  the presenter could answer now (validated, admitted, published, and for a
  transactional accepted by its main authors) is approved at once
  (`approvalMethod: "proponent"`, `amendment_approved` with
  `reason: "rule_changed"` and the main presenter as `memberId`), which
  closes the pending transactionals over it (see transactionals). A
  transactional presented under the earlier rule whose sources are still
  open is left for the Mesa;
- to `vote`: every amendment approved by the presenter's acceptance goes
  back to undecided, keeping the answer (`amendment_reopened` with
  `reason: "rule_changed"`), for the assembly to vote.

After the final vote (or once the consolidated text exists) the rule no
longer changes: 409.

**Expected documents.** A manager creates a document in advance for the member
that has to provide it (a CEA report, a resolution) with an internal deadline,
`dueAt` (`DocumentCreateBody.dueAt`, changed later through `PUT`). It starts
as an empty draft that the member fills in and presents. Only managers set
`dueAt`: a presenter that sends one gets 403. A document is expected when it
has a `dueAt` or hangs from an agenda item that does not accept submissions
(only a manager could have created it there, such as a CEA report without an
internal deadline). An automatic sub-item does not count as such an item: a
document in one was presented under an item that accepts submissions, so
without a `dueAt` it is not expected and `documents_close` binds it. The `documents_close` milestone does not bind an expected
document: its `dueAt`, if any, is the deadline, and an overdue one can still
be presented (the tracking panel flags it).

**Summary fields.** `DocumentSummaryDto` carries what the tracking panel needs:
`submittedAt` (null while it is a draft), `dueAt`, `hasContent` (blocks in the
working draft, or a PDF uploaded) and the pending correction,
`correctionNote` and `correctionRequestedAt`, which are returned only to the
document's presenters (its main presenter, its co-presenters and the user who
created it) and to `document:manage`, and null for everyone else.

**Validation by the Secretaría.** Nothing a member presents is visible to the
rest of the assembly until the Secretaría has checked it.

- `POST .../submit` sends a draft with content (422 otherwise) to the
  Secretaría (`submitted`, `submittedAt`). Presenting it again after a
  correction clears `correctionNote` and `correctionRequestedAt`. Members
  must do it before `documents_close` unless the document is expected (see
  above); managers are not bound by it.
- Publishing (`POST .../publish`) is the validation: see the rules below. It
  also clears a pending correction.
- `POST .../correction` (`document:manage`, `CorrectionBody`: a note of 1 to
  2000 characters and the document's `updatedAt` for the optimistic lock)
  sends a `submitted` document back to `draft`: `submittedAt` becomes null and
  the note is stored in `correctionNote` with `correctionRequestedAt`. Any
  other status returns 409. It records `document_correction_requested`
  (`{ note }`). The presenters fix the draft and present it again.

**Editor.** An editor holds `document:manage`, or acts for one of its
presenters (main or co-presenter) or created it, while the document is a
`draft`. Presenting it (`POST .../submit`) and uploading its PDF follow the
same rule.

**Who sees a document.** Published and postponed documents are public. Drafts
are private to their presenters (main and co-presenters), the user who
created them and `document:manage`. The Mesa (`session:moderate`) also sees
every document past draft (submitted, withdrawn). The same rule backs the
document list counts, the uploads route, exports and the home page.

**Status changes.** `PUT` with `status` is for managers and follows
`assertStatusChange`. A forbidden change returns 409.

- `withdrawn`: only from `submitted`, `published` or `postponed`. A draft is
  still private to its proponent and may be unfinished, so it cannot be
  withdrawn. An unwanted draft is deleted instead.
- `postponed`: only a document that was published, since postponed documents
  are public.
- `submitted`: only to restore a withdrawn submission. The document must be
  `withdrawn`, have a `submittedAt` and never have been published. It keeps
  its original `submittedAt`. A withdrawn or postponed document that was
  published is restored by publishing it again. A draft is presented through
  `POST .../submit`, which checks its content.
- Once the final vote is recorded, every status change returns 409. Annul the
  final vote first.

**PDF replacement.** Managers may replace the PDF of a `file` document until
its final vote; after it the upload returns 409. Before publication the
previous file is deleted. Once published, the previous file stays on disk and
the `document_file_uploaded` event records `previousFileUrl` and
`previousFileName`. The uploads route only serves the current `fileUrl`, so
the old file is kept for the record, not served.

**Publishing.**

- Validates the document: it is how the Secretaría accepts a presented one.
- Freezes the working draft as an immutable `base` version.
- Sets `status=published`, `publishedAt` and `baseVersionId`.
- Assigns the reference (`RES 012/2026`) for kinds that use one.
- Amendments open according to the window.
- A structured document needs at least one block.

**Final vote.**

- Needs a published document with `voted`, in an assembly that is neither
  `draft` nor `closed`, and no final vote yet.
- An approved totality return (devolución) sends the text back: it returns
  409 with `{ totalityReturn: id }`, whatever the vote.
- Every amendment must be decided first: otherwise 409 with
  `{ undecided: ids }`.
- Records the vote on the whole text, whatever its result, as `finalVoteId`.
  That closes every amendment action on the document.
- When it is approved, consolidates the base with the approved amendments, in
  approval order or in `order`, using `consolidate`, and stores the result as
  a `consolidated` version (`consolidatedVersionId`).
- If `consolidate` reports conflicts, it returns 409 with `{ conflicts }` and
  stores nothing.
- The live projection shows the vote (see the live session below).

**Annulling the final vote.** `DELETE .../final-vote` with
`FinalVoteAnnulBody` (`updatedAt` of the document for the optimistic lock,
optional `note`) corrects a wrongly recorded final vote.

- `session:moderate`, and the assembly must not be `closed` (409).
- 409 when the document has no final vote, or when `updatedAt` is stale.
- The vote row and the consolidated version stay for the record. The document
  loses `finalVoteId` and `consolidatedVersionId`, so its amendments can be
  decided or reopened again and the final vote taken again.
- Records `final_vote_annulled` (payload `voteId`, `result`,
  `consolidatedVersionId` and `note`) and stops projecting the vote.
- Returns the `DocumentDto`.

## Amendments

All paths are under `/api/assemblies/[assembly]/documents/[document]/amendments`.

| Method | Path                      | Who                                                  | Notes                                                                                                         |
| ------ | ------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| GET    | ``                        | visible                                              | `DocumentAmendmentsDto`, filtered by `canSeeAmendment`. Positions are nulled when `canSeePositions` is false. |
| POST   | ``                        | `amendment:create`, document amendable and published | `AmendmentDraftBody`. Creates a draft.                                                                        |
| PUT    | `/[amendment]`            | author while the amendment is a draft                | `AmendmentUpdateBody`                                                                                         |
| DELETE | `/[amendment]`            | author while the amendment is a draft                |                                                                                                               |
| POST   | `/[amendment]/submit`     | author                                               | See submission rules below.                                                                                   |
| POST   | `/[amendment]/withdraw`   | author or moderator                                  | Allowed until the amendment is decided. Closes the pending transactionals over it.                            |
| POST   | `/validate`               | `amendment:review`                                   | `ValidateAmendmentsBody`. See validation below. Returns `DocumentAmendmentsDto`.                              |
| POST   | `/publish`                | `amendment:review`                                   | `PublishAmendmentsBody`. See validation below. Returns `DocumentAmendmentsDto`.                               |
| POST   | `/[amendment]/correction` | `amendment:review`                                   | `CorrectionBody`. See validation below. Returns `AmendmentDto`.                                               |
| POST   | `/[amendment]/reclassify` | `amendment:review`                                   | `ReclassifyBody`. See reclassifying below. Returns `AmendmentDto`.                                            |
| POST   | `/admission`              | `amendment:review` or moderator                      | See admission rules below.                                                                                    |
| PUT    | `/[amendment]/position`   | main presenter or moderator                          | `PositionBody`. See the main presenter's answer below.                                                        |
| POST   | `/[amendment]/outcome`    | moderator                                            | See outcome rules below.                                                                                      |
| POST   | `/transactional`          | `amendment:create` acting for a member, or moderator | See transactional rules below.                                                                                |
| POST   | `/[amendment]/acceptance` | pending party (main author), or a moderator for one  | See acceptance rules below.                                                                                   |
| POST   | `/relations`              | moderator, reviewer or proponent                     | `RelationBody`. Both amendments must belong to the document, so `same_in_other_document` returns 422.         |
| DELETE | `/relations/[relation]`   | the same roles                                       |                                                                                                               |
| GET    | `/[amendment]/history`    | visible                                              | `EventDto[]`. Correction notes are removed for those who may not read them.                                   |

**Who sees an amendment** (`canSeeAmendment`).

- Drafts: their authors, the user who created them, the members involved
  in a transactional (its parties, the main authors of what it replaces, and
  every other author of those amendments) and reviewers (`amendment:review`
  or `amendment:manage`). The Mesa alone (`session:moderate`) does not read
  members' drafts.
- Presented amendments are visible to everyone who can see the document
  only once the Secretaría publishes them (`publishedAt`). Until then
  (waiting for validation, validated but kept private, or decided before
  publication) only their authors, the user who created them, the members
  involved in a transactional, reviewers and the Mesa see them. Visibility
  is per amendment: there is no assembly-wide policy any more.
- The same rule drives `amendmentCount` in document summaries, the history
  and the admission decisions returned by `GET .../decisions`.
- `correctionNote` is returned only to the authors, the creator, the members
  involved in a transactional, reviewers and the Mesa, and null for everyone
  else.

**Main author.** An amendment with co-authors has a main author
(`AmendmentDto.mainAuthorId`, listed first in `authors`), stored as the
presenting member: it drives the code (`CEUM 4`, or `CEA 4` for any
executive area) and alone answers the
transactionals proposed over the amendment. With a single author it is that
author; a transactional the Mesa drafts for nobody has none (null).

**Creating a draft.**

- `validateOps` runs against the base, and any error returns 422 with the
  reasons.
- A `replace` operation may carry formatting (`docs/design.md`,
  "Amendments"): `marks` for its new text (cleaned like a block's: clipped
  to the text, links only to safe addresses) or `block`, the new format of
  its whole block, stored with only the fields its type keeps. Both are
  optional. Their own reasons: `format_shape` (a `block` that is malformed
  or not alone on an empty operation at 0), `format_image` (the block is an
  image), `duplicate_format` (two for one block), `marks_out_of_range`, and
  `noop` when the format or the marks are the ones the base already has.
- Authors are the actor's member plus `authorMemberIds`. A moderator may use
  `onBehalfOfMemberId`.
- `mainAuthorMemberId` names the main author, which must be one of the
  authors (422). With several authors it is required (422 without it).
- `positionKey` is computed with `positionKey`.

**Editing a draft.**

- `authorMemberIds` replaces the co-authors; the main author stays. The
  actor's member is always kept: a co-author editing a draft presented by
  another member does not drop out of it.
- `mainAuthorMemberId` names a new main author, which must already be an
  author or be listed in `authorMemberIds` (422); it then anchors the
  authors, and the former main author stays only if it is listed (or is the
  actor). Left out, the stored main author stays while it is still an
  author; when it is not and there are several authors, 422.
- Ordinary drafts may name any active member as co-author. On a transactional
  draft, a non-moderator may only add the members involved (the authors of
  what it replaces and the document's main presenter), as when it is
  created: otherwise 403.

**Submitting.** Submission does several things at once:

- It sets `status=submitted`, `submittedAt` and `submittedByUserId`, and
  clears a pending correction (`correctionNote`, `correctionRequestedAt`).
- It computes `late` from `amendmentWindow` and `isLateSubmission`. An
  amendment the Secretaría sent back for correction keeps the timing of its
  first presentation: fixing it after the window closed does not make it late.
- It assigns `number` (next free number per document) and `memberSeq` (next per
  main author within the document). An amendment sent back for correction
  keeps its `number`, and its `memberSeq` while the same member presents it,
  so numbering has no gaps. Deleting such a draft leaves its number unused.
- It sets `code` to `"{ACRONYM} {memberSeq}"`. When the main author is an
  executive area the code is `"CEA {memberSeq}"` for everyone, and
  `memberSeq` counts the amendments of all the areas to the document
  together (`amendmentCodePrefix`), so the code never names the area.
- It never admits: `admission` stays `pending` and `validatedAt` and
  `publishedAt` stay null until the Secretaría validates it (see below).
- It creates the `amendment_positions` row as `pending`.

**Validation by the Secretaría.** Every presented amendment needs the
Secretaría's validation before it can be decided (an outcome needs
`admission=admitted`), and the Secretaría decides per amendment whether it
becomes visible to everyone when validating it or later.

- `POST .../validate` (`ValidateAmendmentsBody`: `amendmentIds`, `publish`)
  validates in bulk. Every amendment must belong to the document (404) and
  still be `submitted` and not validated (409: someone already reviewed it,
  reload). A transactional proposed by a member needs every main author's
  acceptance first (409 while it is `pending_authors`, see transactionals
  below; the acceptance rows are share-locked after the amendments). It sets
  `validatedAt` and `validatedByUserId`. An on-time amendment is admitted at
  the same time (`admission=admitted`); a late one keeps `admission=pending`
  until the assembly decides whether to treat it (the Secretaría or the Mesa
  records it, see late amendments). With `publish` it also sets
  `publishedAt`; a transactional is published whatever `publish` says
  (`publishOnValidation`), since it replaces published amendments and
  cannot stay private. Records `amendment_validated` (`{ publish,
admission }`, `publish` being what happened to that amendment, plus
  `method: "secretaria"` when it admits) per amendment. Validating a
  transactional makes it replace what it groups: those amendments must
  still be open (409, saying which one still needs the Secretaría's
  validation or the assembly's decision to treat it, or is already
  decided) and become `transacted` (`amendment_transacted`).
- `POST .../publish` (`PublishAmendmentsBody`) makes validated amendments
  visible to everyone: each one must be validated, past draft and not
  published yet (409). Records `amendment_published`. Publishing only changes
  who sees an amendment, so it is the one amendment change still allowed
  after the final vote (`can.publish` is the only capability left then).
- `POST .../[amendment]/correction` (`CorrectionBody`: a note of 1 to 2000
  characters and the amendment's `updatedAt` for the optimistic lock) sends a
  `submitted`, not yet validated amendment back to `draft` with the note in
  `correctionNote` and `correctionRequestedAt`. `submittedAt` becomes null;
  number, code and timing are kept (see submitting). Records
  `amendment_correction_requested` (`{ note }`). A transactional still
  waiting for its main authors returns 409.
- Reclassifying: `POST .../[amendment]/reclassify` (`amendment:review` or
  `amendment:manage`; `session:moderate` alone answers 403. `ReclassifyBody`:
  the `kind` it becomes and the amendment's `updatedAt` for the optimistic
  lock) moves a `submitted` amendment between "de forma" (`formal`) and the
  content kind (`partial`), whatever its review state. Only those two kinds
  have a counterpart (`reclassifyTarget` in
  `shared/utils/amendmentReclassify.ts`): a totality amendment or a
  transactional, a `kind` that is not the other one of the two, a draft, a
  decided amendment and a voted document all return 409. Nothing else about
  the amendment changes. Records `amendment_reclassified`
  (`{ from, to }`), shown in the amendment's history and in its authors'
  news.
- `reviewState` on `AmendmentDto` tells where it stands:
  - `correction_requested`: a draft the Secretaría sent back;
  - `published`: `publishedAt` is set, whatever its status;
  - `pending_authors`: a transactional proposed by a member, `submitted`
    and not validated, that some main author of what it replaces has not
    accepted yet (only acceptance rows with the role `author` count: rows
    with the role `proponent` come from the earlier rule and are ignored,
    also in `acceptances`). A rejection closes it, so it never stays here
    rejected;
  - `pending_validation`: `submitted`, not validated and not waiting for
    its main authors;
  - `validated`: validated, not published and still relevant to the debate
    (not withdrawn nor inadmissible). The inbox lists these to publish,
    except the late ones still waiting for the assembly's decision, which
    it lists with the late ones;
  - null otherwise: a draft never presented, or an amendment settled while
    private that waits for nothing (withdrawn, lapsed or inadmissible before
    validation, or withdrawn or inadmissible after a private validation).

  `can.validate` holds for reviewers on a submitted, unvalidated amendment
  that does not wait for its main authors, and `can.publish` on a
  validated, unpublished one past draft (a withdrawn or inadmissible one can
  still be published on purpose).

- Row locks follow the usual order: the document (share), then the
  amendments and, for `validate`, the sources of the transactionals, in id
  order, then the acceptances.

**Late amendments.** An amendment presented after its window closes gets
`late: true` (computed, see submitting). Validating it keeps `admission`
`pending` (with `publish` it becomes visible at once), so `AmendmentDto`
shows `late: true`, `admission: "pending"` and `reviewState: "published"`:
the client says it is out of time and waits for the assembly to decide
whether to treat it. The Secretaría or the Mesa records that decision with
`POST .../admission` below. Until it is `admitted`, the main presenter cannot
answer it, an outcome returns 409 and it cannot be the source of a
transactional; the final vote waits for it to be decided (declared
inadmissible, for instance).

**Admission.** The body is an `AdmissionBody`, usable one by one or in bulk.

- It creates a `decisions` row (`admit_late` or `inadmission`), with a vote
  when the method is `vote`.
- It sets `admission`. Inadmissible amendments also get
  `status=inadmissible`, which closes the pending transactionals over them
  (see transactionals); they are locked in the same ordered pass.
- The Mesa does not skip the Secretaría: admitting an on-time amendment
  (`late=false`) that is `submitted` and not validated returns 409 (the
  Secretaría validates it, which admits it). So does a vote on its
  admission in either direction, since a failed vote to declare it
  inadmissible would admit it. Declaring it inadmissible directly, deciding
  on a late or validated one, and re-admitting an inadmissible one are
  allowed. The check runs before the transaction and again on the locked
  rows.
- Deciding on admission checks the amendment: one not validated yet (a late
  one) gets `validatedAt` and `validatedByUserId`, and its
  `amendment_admitted` or `amendment_inadmissible` event carries
  `validated: true`.
- Admitting is a public act of the Mesa: an amendment that ends up admitted
  is also published (`publishedAt`, if it was not set), so delegates can read
  what is debated, and `amendment_published` (`{ decisionId }`) is recorded
  for each one that was not public yet. An inadmission publishes nothing.
- Admitting needs amendments still pending or inadmissible; declaring them
  inadmissible needs them still submitted, otherwise 409. The amendments are
  locked in the transaction and must still have the status and admission the
  operator decided on, so a concurrent decision on the same amendments, in
  either direction, is neither duplicated nor overturned: the later one
  returns 409.
- A vote is projected live (see the live session below).
- Returns `AmendmentAdmissionDto`.

**The main presenter's answer.** `PUT .../[amendment]/position` with a
`PositionBody` records the answer of the document's main presenter (accept,
reject, transact, or back to pending, with an optional comment). Returns the
`AmendmentDto`.

- Only the main presenter's member answers, or the Mesa for it (403
  otherwise); co-presenters see the answer (`positionsVisible` holds for every
  presenter) but cannot give it. The `position_changed` event names whose
  answer it is (`memberId`: the main presenter, also when the Mesa records
  it, with `by: "moderator"`), which the home page's news credit.
  `PositionDto.recordedBy` says who recorded the answer, as it was then:
  `"mesa"` when the amendment's latest `position_changed` has
  `by: "moderator"`, `"presenter"` when it has `by: "proponent"`, so an
  answer keeps its author when the document later gets another main
  presenter. Without that event it compares the member of the user stored
  in `amendment_positions.decidedByUserId` with the document's current main
  presenter (`"presenter"` for the pending row created on submission, which
  nobody recorded).
- Only once the amendment can be answered (`positionBlocker`), 409
  otherwise: presented and undecided, validated by the Secretaría and, if
  late, admitted by the assembly (`admission: "admitted"`), for a
  transactional once every main author accepted it, and published, so the
  answer is about something every delegate can read (under either rule;
  a late one is published when the assembly admits it). The message says
  what is missing. `can.position` follows the same rule, and is false once
  the document is voted.
- `positionUpdatedAt` is the `PositionDto.updatedAt` the client saw (null
  when there was no answer): when it is sent and the stored answer changed
  since, 409, so two people answering at once do not overwrite each other.
- Under the document's `incorporate` rule, accepting approves the amendment
  at once: `status: "approved"`, `approvalMethod: "proponent"`, `decidedAt`,
  with `amendment_approved` (`{ method: "proponent", byPosition: true,
memberId }`, the main presenter) after `position_changed`, and closes the
  pending transactionals over it (see transactionals). Changing the answer
  of an amendment approved that way to anything but `accept` reopens it
  (`submitted`, `amendment_reopened` with `reason: "position_changed"`).
  One the Mesa approved otherwise (by vote, say) is decided: 409. Under the
  `vote` rule an answer never decides anything.
- After the final vote nothing changes (409).
- Locks: the document (share), the amendment (and what a transactional
  replaces, with the other transactionals over that or over the amendment)
  in id order, its acceptances, then its position row.

**Outcome.** The body is an `OutcomeBody`; the response is an
`AmendmentOutcomeDto`.

- `approve` sets `status=approved` with `approvalMethod`.
- `vote` records a vote with `computeVoteOutcome` and then approves or
  rejects. Without a `majority` in the body it uses `amendmentVoteMajority`:
  `absolute` for an amendment to `regulation` or `statutes` (RRI 2025 art.
  65.5), `simple` otherwise (art. 18.3). The session's vote dialog proposes
  the same one. A tie under `tieRule=repeat` stores
  nothing and returns 409. The vote is projected live, pointing the
  projection at the amendment.
- `withdraw` and `lapse` set `withdrawn` and `lapsed`, only on amendments in
  the debate: `admission: "admitted"` (validated and, if late, admitted by
  the assembly), 409 otherwise. An author can still withdraw its own
  amendment through `POST .../withdraw`.
- Every outcome that settles the amendment (`approve`, `vote`, `withdraw`,
  `lapse`) closes the pending transactionals over it (see transactionals),
  locked in the same ordered pass as the amendment.
- `reopen` brings the amendment back to `submitted`. Its vote row stays for
  the record, but the `amendment_reopened` event records it as
  `voidedVoteId` and the projection stops showing it.
- `approve` and `vote` require the amendment to be admitted and published
  (`publishedAt`): an amendment the Secretaría validated but kept private
  returns 409 until it publishes it, so nothing is decided that delegates
  cannot read. A transactional must have replaced its sources (every main
  author accepted it, 409 otherwise): the Mesa's own wait for their answer
  in the room.
- A transactional replaced its sources when it took over (see
  transactionals), so approving it does not touch them. One presented under
  the earlier rule, which replaced its sources only on approval, replaces
  the ones still open now; a source decided otherwise returns 409, so a
  source and its transactional never both end up approved.
- Reopening a transactional does not give its sources back: they stay
  `transacted`. A transactional that never replaced its sources can only be
  reopened while they are all still open, and one a main author rejected
  stays closed (409 for both, `transactionalReopenBlocker`): the way to try
  again is a new transactional. Reopening locks the transactional and its
  sources in one pass, then its acceptances.
- When approving any amendment, the response lists the ids of amendments with
  hard overlaps or an `incompatible` relation, so the client can offer to mark
  them as `lapse`.

**Transactionals.** The body is a `TransactionalBody`. Any member can
propose one over published amendments, before or during the session
(docs/design.md, "Transactionals").

- Who: any account with `amendment:create` that acts for a member (a council,
  sectorial or CEA area), the document's main presenter, the authors of the
  amendments it groups, or a moderator. An account without a member gets
  403 with the next step (ask the Secretaría to link it).
- The sources must belong to the document (404 otherwise, also for a source
  the actor cannot see) and be published (`publishedAt`), submitted,
  admitted and undecided; a source that is itself a transactional must have
  replaced its own sources (its main authors accepted it). This is checked
  again under the document lock, both on creation and on submission of a
  draft transactional. The 409 says what is missing, first what someone can
  still do: a source still waiting for the Secretaría's validation, then one
  out of time whose treatment the assembly has not decided yet, then a
  transactional its main authors have not accepted, then one not published
  yet, then one already decided.
- The ops are validated against the same base.
- It creates `kind=transactional`, numbered `T1`, `T2` and so on per
  document, and fills `amendment_sources`.
- Its parties are the main authors of the amendments it groups: one
  `amendment_acceptances` row each, with the role `author`. The document's
  presenter is not a party unless it is one of them. The creator's own
  member, when it is a party, is accepted at once.
- Authors: the proposer's member plus `authorMemberIds`; non-moderators may
  only add members involved (the authors of what it groups and the
  document's main presenter), 403 otherwise. `mainAuthorMemberId` names the
  main author among them (422 when it is not one, and required with several).
- With `submit` (default) it is submitted at once and `late` is ignored.
  Created by a member, it goes:
  1. to the main authors of what it groups (`pending_authors`, private to its
     authors, its creator, the members involved, reviewers and the Mesa). Its
     `amendment_submitted` event carries `awaitsAuthors: true` while it
     waits. Each one accepts or rejects it (`POST .../acceptance`); any
     rejection closes it and the originals carry on. The Secretaría's inbox
     lists it read only (`can.validate` false) and its counts leave it out;
  2. once all accepted, to the Secretaría, which validates it
     (`POST .../validate` answers 409 until then); validating it publishes
     it;
  3. validated and accepted, it replaces those amendments: they become
     `transacted` (`amendment_transacted` with `transactionalId` and `code`)
     and it follows the normal flow (the main presenter's answer, then the
     vote or its incorporation, per the document's rule).
- Created by a moderator (the Mesa in session), it is validated, admitted and
  published at once (`amendment_validated` with `publish: true` and
  `method: "mesa"`), and it replaces the originals as soon as their main
  authors accept it in the room (the Mesa records their answers); at once
  when there is nobody else to ask.
- Validated and accepted happen in either order: whichever comes last makes
  it replace its sources, which must still be open (409 otherwise).
  Validating a transactional always publishes it, so delegates see what
  replaced the originals.
- Two transactionals over the same amendment cannot both replace it. When
  one does, every other submitted transactional over any of those
  amendments lapses: `status: "lapsed"`, `decidedAt`, and `amendment_lapsed`
  with `{ reason: "sources_transacted", transactionalId, code }` (the one
  that replaced them), which its authors see in their news. Validating, in
  one request, two transactionals that group the same amendment returns 409:
  the Secretaría validates one, and the other lapses.
- A transactional that has not replaced its sources yet (waiting for its
  main authors, for the Secretaría or, the Mesa's, for the answers in the
  room) is closed at once when one of those amendments is settled another
  way: withdrawn (by its authors or the Mesa), lapsed, declared
  inadmissible, approved or rejected (by vote or as the Mesa records it),
  or incorporated by the main presenter's acceptance (also when the
  document's rule changes to `incorporate`). It becomes `withdrawn` with
  `decidedAt`, and `amendment_withdrawn` records
  `{ by: "sources_closed", sourceId, sourceCode, sourceStatus }`: the
  amendment that closed it and where it ended up. Its `decidedAt` is the
  same instant as that amendment's, so the `AmendmentDto` alone tells
  which source closed it (`sourceIds`, their `status` and `decidedAt`):
  clients put that reason into words in the viewer's language, and
  `outcomeNote` stays empty, for the Mesa's own words (a Spanish note would
  reach English readers untranslated). Its authors and its parties (every
  author of what it groups) read it in their news, also when their own act
  closed it. One left behind because another transactional replaced its
  sources is not withdrawn but `lapsed`, with the reason
  `sources_transacted` (above): it lost its object, as the assembly calls
  it, and clients tell it apart that way. Every path that settles an
  amendment locks the transactionals over it in the same ordered pass
  (`closeTransactionalsOver` in `server/utils/domain/transactionalClosure.ts`).
  An older one left submitted with a source already closed is still never
  asked for an answer (`can.accept` false, left out of the home page's
  `acceptances`, and accepting it returns 409); its proposer withdraws it
  or the Mesa closes it.
- Every path that replaces sources locks the transactional, its sources and
  the other transactionals over them in one ordered pass, after the
  document (share). Presenting a transactional takes the document
  `NO KEY UPDATE`, so no new one appears in between.
- Submitting a draft transactional later follows the same rule, by who
  submits it.
- While it is submitted, the final vote on the document waits for it, like
  any undecided amendment.

**After the final vote.** Every amendment change (drafts, submission,
validation, correction, withdrawal, admission, position, outcome, acceptance,
relations) returns 409 once the document has a final vote; only publishing
is still allowed. The capabilities say so: every `can` flag but `publish`,
`moderate` and `review` is false. Each one re-reads the document under a row
lock inside its transaction, so a change racing the final vote either commits
first (and the final vote sees it) or is refused.

**Acceptance.** The body is an `AcceptanceBody`: a party (the main author
of an amendment the transactional groups) accepts or rejects a submitted
transactional (409 for a draft or a decided one). The party is found by
member: the actor's, or `memberId` when the Mesa records the answer given in
the room (403 for anyone else; 404 when that member is not a party).

- Each `AcceptanceDto` says who recorded the answer in `recordedBy`:
  `"mesa"` when the latest `acceptance_recorded` event for that party has
  `recordedForMemberId` (the Mesa recorded it in the room), `"party"`
  otherwise, including a pending row and the proposer's own acceptance
  with no event. It comes from the event, never from current member
  links, like `PositionDto.recordedBy`.
- A party answers once (409 afterwards); the Mesa can correct an answer
  until the transactional replaced its sources, after which the answers are
  final (409): the originals are gone.
- Any rejection closes it: `status: "withdrawn"`, `decidedAt` and
  `amendment_withdrawn` (`{ by: "author_rejection", memberId }`) after
  `acceptance_recorded`. The home page's news tell it through the
  rejection only. The originals carry on. Who rejected it is in its
  `acceptances` (decision `rejected`, member, `decidedAt`) and in that
  event; `outcomeNote` stays empty, for the Mesa's own words, so clients put
  it into words in the viewer's language.
- Accepting needs every amendment it groups still open (409 otherwise, see
  transactionals); rejecting is always possible.
- The last acceptance moves a member-proposed transactional to the
  Secretaría (`pending_validation`), and makes one already validated (the
  Mesa's) replace its sources at once.
- Locks: the document (share), the transactional, its sources and the other
  transactionals over them in id order, then its acceptance rows. The
  answers are read again under those locks, so two parties answering at
  once both count.

## Review and work

**Validation inbox.** `GET /api/assemblies/[assembly]/review` returns a
`ReviewQueueDto` for `document:manage` or `amendment:review` (403 otherwise):

- `documents`: with `document:manage`, the `submitted` documents waiting for
  validation, as `DocumentSummaryDto`, in creation order;
- `amendments`: with `amendment:review`, each with its document reference,
  grouped by document in agenda order (then creation order) and then in
  text order:
  - waiting for validation: `submitted`, not validated, and not a
    transactional still waiting for its main authors;
  - waiting for publication: validated, not published, and not draft,
    withdrawn or inadmissible;
  - late ones waiting for the assembly's decision, published or not:
    `late`, `admission: "pending"`, `submitted` and validated. The
    Secretaría (or the Mesa) records that decision with
    `POST .../amendments/admission`;
  - read only, member-proposed transactionals still waiting for their main
    authors (`pending_authors`; `can.validate` is false), so the Secretaría
    sees what is about to reach it. They are not counted on the home page.

**Home page.** `GET /api/me/work` returns a `MeWorkDto` over the assemblies
that are not closed and that the actor can see (draft assemblies only for
managers and the Mesa), soonest first:

- `documents`: the documents the actor's member presents, as main presenter
  or co-presenter, that are `draft` (expected ones included), `submitted` or
  `published`;
- `amendments`: the amendments the actor's member authored that are still
  `draft` or `submitted`, newest change first, with `reviewState` (a
  member-proposed transactional shows `pending_authors`), the
  `correctionNote`, and `late` and `admission`, so a late one can say it
  waits for the assembly's decision;
- `review`: for `document:manage` or `amendment:review`, per assembly with
  something pending, `documentsToValidate` and `documentsOverdue` (expected
  drafts past `dueAt`), which need `document:manage`, and
  `amendmentsToValidate` and `amendmentsToPublish` (the inbox's "to
  validate" and "to publish" sets: transactionals waiting for their main
  authors and late amendments waiting for the assembly's decision are not
  counted), which need `amendment:review`;
- `proponent`: the `published` documents the actor's member presents as main
  presenter, not voted yet, with something to answer, in assembly order and
  then creation order. `positionsPending` counts, over the amendments of the
  document the actor can see, the `submitted` ones without an answer that
  the main presenter can answer now (`positionBlocker`: validated,
  published, admitted if late, and for a transactional accepted by its main
  authors), under either rule. Documents with 0 are left out;
- `acceptances`: the submitted transactionals the actor's member can
  still answer, as main author of an amendment they would replace
  (`awaitsPartyAnswer`: its answer pending, everything it groups still
  open, the document published and not voted), in assembly and document
  order, each with `replaces`: the member's amendments it would replace,
  and `proposedBy`: its main author (null when the Mesa presented it on
  nobody's behalf);
- `news` ("Novedades"): what others decided about the member's work in the
  last 30 days, newest first, at most 30 (`MeWorkNewsDto`):
  - for a co-presenter, the main presenter's answers to the document's
    amendments (`position_changed`);
  - for the authors of an amendment, the main presenter's answer to it
    (`position_changed`), when the assembly's `positionVisibility` lets them
    see positions (`canSeePositions`);
  - for the authors of an amendment, the main authors' answers to the
    transactionals over it, and to the transactionals the member proposed
    (`acceptance_recorded`);
  - for the authors of an amendment, what was settled about it:
    `amendment_validated`, `amendment_published`,
    `amendment_correction_requested`, `amendment_reclassified` (the value
    is the kind it became), `amendment_admitted`,
    `amendment_inadmissible`, `amendment_approved`, `amendment_rejected`,
    `amendment_withdrawn`, `amendment_lapsed` (with
    `reason: "sources_transacted"` for a transactional closed because
    another one replaced what it grouped), `amendment_transacted` and
    `amendment_reopened`. A transactional a main author's rejection closed
    is told by that rejection (`acceptance_recorded`): its
    `amendment_withdrawn` with `by: "author_rejection"` is left out;
  - for the authors of the amendments a transactional groups (its parties
    among them), that transactional closing by itself:
    `amendment_withdrawn` with `by: "sources_closed"` and
    `amendment_lapsed` with `reason: "sources_transacted"`;
  - for the presenters of a document (main and co-presenters), what was
    settled about it, with `amendment: null`: `document_published` (the
    Secretaría's validation), `document_correction_requested`,
    `document_voted` and `document_status_changed`.

  `by` is the member that decided: null for a transactional that closed by
  itself (`amendment_withdrawn` with `by: "sources_closed"`,
  `amendment_lapsed` with `reason: "sources_transacted"`), which nobody
  decided; the party, for an answer to a transactional; the main
  presenter, also when the Mesa recorded it, for an answer to an amendment
  (`position_changed`), for an amendment its acceptance incorporated
  (`amendment_approved` with method `proponent`) and for one a new answer
  took out again (`amendment_reopened` with
  `reason: "position_changed"`): the event's `memberId`, or the document's
  current main presenter for older events without it; otherwise the member
  the actor acted for, or null. `value` is the decision in short: the
  position (`position_changed`), the answer (`acceptance_recorded`), the
  admission left by a validation (`amendment_validated`), the approval
  method (`amendment_approved`, `proponent` when it was incorporated), the
  code of the transactional that replaced the amendment
  (`amendment_transacted`) or that replaced first what a lapsed
  transactional grouped (`amendment_lapsed` with
  `reason: "sources_transacted"`), the code of the amendment whose fate
  closed a transactional (`amendment_withdrawn` with
  `by: "sources_closed"`), the result of the final vote (`document_voted`)
  or the new status (`document_status_changed`); null otherwise.
  `ownAmendment` is true when the amendment is one the member wrote (main
  author or co-author), false for document news and for transactionals it
  is only a party to. Decisions taken by the user, or for the user's
  member, are left out (an incorporation the member's own acceptance
  caused, too), and so is anything the actor cannot see (the document and
  the amendment, as their endpoints decide). A transactional that closed by
  itself is not a decision, so it stays, also when the user's own act on
  what it grouped (withdrawing it, say) closed it.

An account without a member gets empty `documents`, `amendments`,
`proponent`, `acceptances` and `news`.

## Votes, decisions and live session

| Method | Path                                    | Who                | Notes                                                                                                                                                                                                                                    |
| ------ | --------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/assemblies/[assembly]/decisions`  | visible            | `DecisionDto[]`. An admission decision (`admit_late`, `inadmission`) lists in `subjectIds` only the amendments the actor can see, and is left out when it names none of them, so its note and vote do not reveal private amendments.     |
| GET    | `/api/assemblies/[assembly]/live-state` | visible            | `LiveStateDto`                                                                                                                                                                                                                           |
| PUT    | `/api/assemblies/[assembly]/live-state` | `session:moderate` | `LiveStateBody`. Records a `live_changed` event. An `amendmentId` must be published (409 otherwise): every delegate follows the projection. `speakersVisible` shows attendees who has the floor (see speaking turns).                    |
| GET    | `/api/assemblies/[assembly]/live`       | visible            | SSE stream. On connect it sends `event: ready`. Each `LiveMessage` from `subscribeToAssembly` goes out as `event: change` with a `LiveEventDto`. A comment heartbeat goes out every 25 s. The stream closes when the client disconnects. |

**Projected votes.** Clients do not manage `voteId` after a vote. When the
assembly has a `live_state` row (the session started), the server sets
`live_state.voteId` in the same transaction as every vote it records:

- an amendment outcome vote, which also points the projection at the amendment
  and its document;
- an admission vote, which only replaces the vote;
- a final vote, which also points the projection at the document, with no
  amendment.

Choosing a new document also selects its agenda item, as with
`PUT .../live-state`. When that vote is voided (the amendment is reopened, the
final vote is annulled) and the projection still shows it, the server clears
`voteId`. Each change records `live_changed` (`entityType: "live"`).

**Live state.** `LiveStateDto.speakersVisible` (false before the session
starts) says whether attendees see who has the floor and who is next.
`PUT .../live-state` with `speakersVisible` changes it; besides
`live_changed` it then records `speakers_visibility_changed`
(`entityType: "speakers"`, `{ visible }`), so clients that follow the
speakers refetch them.

## Headcounts

| Method | Path                                                | Who                | Notes                                                                |
| ------ | --------------------------------------------------- | ------------------ | -------------------------------------------------------------------- |
| GET    | `/api/assemblies/[assembly]/headcounts`             | visible            | `HeadcountsDto`: counts newest first, `latest`, `members`, `quorum`. |
| POST   | `/api/assemblies/[assembly]/headcounts`             | `session:moderate` | `HeadcountBody`. 201 with `HeadcountsDto`.                           |
| PUT    | `/api/assemblies/[assembly]/headcounts/[headcount]` | `session:moderate` | `HeadcountUpdateBody` (with `updatedAt`). Returns `HeadcountsDto`.   |

The Mesa's counts of the asociados with a vote (docs/design.md, "Headcounts
and quorum"). Schemas: `shared/utils/schemas/headcount.ts`.

- **Reading.** Public to everyone who sees the assembly, for transparency:
  the live view and the projection show the latest count, who was in the
  room, the delegations, the quorum and the majorities it gives. `members` are the
  active asociados now and `quorum` the rules of the assembly type
  (`quorumRulesOf`, the initial ones for a row stored before quorum existed).
- **Recording.** `entries` lists the members in the room (`present`) and the
  delegated ones (`delegated` with `delegateId`); absent ones are left out.
  422 `{ problems: [{ memberId, problem }] }` when a member is listed twice,
  is not an active asociado, or a delegation names nobody with a vote or one
  that already receives another (`HEADCOUNT_PROBLEMS`). A delegation to a
  member not in the room is stored but does not count (`delegated` and
  `present` leave it out).
  `call: "second"` on a type without a second call is 422. Refused (409) in
  a draft or closed assembly. Records `headcount_recorded`.
- **Correcting.** Optimistic lock on `updatedAt` (409 when stale). The
  members it may list are the active asociados plus those it listed; its
  `eligible` stays, and `required` too unless `call` changes. Records
  `headcount_corrected` with `changes`.
- **Locks and events.** Every write locks the assembly row first. Events
  have `entityType: "headcount"` and carry the figures only (`call`,
  `eligible`, `present`, `required`, `quorum`), never who was there (read
  through GET); the activity log shows them to everyone who sees the
  assembly.
- **Votes.** With majorities on `present`, a vote whose body has no
  `present` takes the latest count's, and every vote with counts stores the
  latest count's id in `votes.headcountId`.

## Speaking turns

| Method | Path                                         | Who                | Notes                                                    |
| ------ | -------------------------------------------- | ------------------ | -------------------------------------------------------- |
| GET    | `/api/assemblies/[assembly]/speakers`        | visible            | `SpeakersDto`. What each actor gets is described below.  |
| POST   | `/api/assemblies/[assembly]/speakers`        | `session:moderate` | `SpeakingTurnBody`. Adds a turn. 201 with `SpeakersDto`. |
| PUT    | `/api/assemblies/[assembly]/speakers/[turn]` | `session:moderate` | `SpeakingTurnUpdateBody`. Returns `SpeakersDto`.         |

The Mesa writes down who asks to speak, gives and ends the floor and orders
the queue (`speaking_turns`). Schemas: `shared/utils/schemas/speakers.ts`.

- **Reading.** The Mesa (`session:moderate`) gets the turns that are
  `speaking` or `waiting` and every turn of the agenda item in debate
  (`live_state.agendaItemId`; with none, the turns without an item).
  Anyone else gets the `speaking` and `waiting` turns only while
  `live_state.speakersVisible` is true, and `turns: []` otherwise. `visible`
  is always the current flag. Order: who has the floor, then the queue by
  `position`, then the finished and cancelled turns in the order they
  happened.
- **Adding.** A turn needs a `memberId` (an active member, 422 otherwise),
  a `speaker` name (one line, up to 120 characters) or both (422 with
  neither). `agendaItemId` defaults to the item in debate; one given must
  belong to the assembly (422). It joins the end of the queue (`waiting`),
  which holds up to 200 turns (409 when full).
- **Changing.** `updatedAt` is the turn's optimistic lock (409 when stale).
  `status` follows `waiting -> speaking | cancelled`,
  `speaking -> done | cancelled` and `cancelled -> waiting` (409 otherwise).
  Giving the floor (`speaking`) ends the turn that had it (`done`), sets
  `startedAt`; ending or cancelling sets `endedAt`; a restored turn joins the
  end of the queue. `position` moves a waiting turn to that place of the
  queue (0 speaks next, clamped to the queue; 409 for a turn that is not
  waiting). `speaker` fixes or clears the name. The waiting queue is kept
  numbered `0..n-1`; turns that only move because of another change keep
  their `updatedAt`. The answer always includes the turn it changed, even
  when the Mesa's list would leave it out (a turn of another agenda item
  that is no longer waiting or speaking).
- **Route param.** A malformed `[turn]` returns 400 before the body is
  read; a turn of another assembly, or none, 404.
- **Closing.** When the assembly moves to `closed` (`PUT .../status`, in the
  same transaction), the turn with the floor ends (`done`), the waiting ones
  are cancelled and `live_state.speakersVisible` becomes false, recording
  `speaking_turn_finished`, `speaking_turn_cancelled` and, when the
  visibility changes, `live_changed` and `speakers_visibility_changed` (the
  `speakers` events carry `reason: "assembly_closed"`). Reopening the session keeps
  them as they were left.
- **Locks and events.** Every write locks the assembly row first
  (`lockAssembly`), so the queue changes one at a time. A closed assembly
  returns 409. Each change records an event with `entityType: "speakers"`
  and the turn as `entityId`: `speaking_turn_added`, `speaking_turn_started`,
  `speaking_turn_finished` (also for the turn that loses the floor),
  `speaking_turn_cancelled`, `speaking_turn_restored`, `speaking_turn_moved`
  or `speaking_turn_updated`. Payloads carry ids and statuses, never the
  person's name.

## Exports

Existing endpoints, now based on structured content:

- `GET /api/exports/[jobId]/status`
- `GET /api/exports/[jobId]/download`

The PDF builder renders blocks:

- headings, lists and emphasis are kept;
- the annotated variant marks every amended fragment with its amendment code
  and ends with an annex of the amendments and their outcomes. Text, codes
  and annex only use the amendments the requester can see
  (`canSeeAmendment`), so a private amendment never shows up in a member's
  export;
- "Presentado por" names the main presenter, then the co-presenters;
- labels come from the locale files.

## Activity and impersonation

Contract in `shared/types/api.ts`, schemas in `shared/utils/schemas/activity.ts`.

| Method | Path                                | Who                 | Notes                                                                              |
| ------ | ----------------------------------- | ------------------- | ---------------------------------------------------------------------------------- |
| POST   | `/api/admin/users/[id]/impersonate` | Admin (real role)   | Body `ImpersonationStartBody` `{ reason }`. Returns `ImpersonationDto`. See below. |
| DELETE | `/api/me/impersonation`             | while impersonating | Back to the Admin's own account. 409 `impersonation.errors.notActive` otherwise.   |
| GET    | `/api/me/activity`                  | any                 | `MeActivityPageDto`. `tab` = `by`, `to`, `access` or `member`. See below.          |
| GET    | `/api/admin/activity`               | Admin (real role)   | `ActivityPageDto`, unredacted, with IP and user agent.                             |
| GET    | `/api/admin/impersonations`         | Admin (real role)   | `AdminImpersonationPageDto`: filters `admin`, `target`, `active`.                  |

**Starting.** `requireAdmin` on the real role, never a permission key. The
reason is one line of 1 to 200 characters. Errors carry `data.messageKey`:
403 `impersonation.errors.adminOnly`, 404 `notFound`, 422 `self`, 403
`targetAdmin`, 403 `targetRevoked` (an account without access), 409
`nested`, 400 `reason`. The limit is 60 minutes, fixed, capped by the
Admin's session. Nothing touches cookies; the client reloads. An open
impersonation ends as `revoked` when its target loses access.

**While impersonating.** Every request runs as the target. `GET /api/me`
returns `impersonation: { id, by, startedAt, expiresAt }` (otherwise null), and
`GET /api/auth/session` returns `impersonating`. Unsafe requests to
`/api/admin/**` and `/api/members/**` answer 403
`admin.impersonationReadOnly`.

**`x-acting-user`.** Every unsafe request to `/api/admin`, `/api/assemblies`,
`/api/exports`, `/api/uploads`, `/api/members` and `/api/me` carries the id of
the account the page acts as (`ACTING_USER_HEADER_NAME`; `useApi().send` adds
it). It is required when the signed-in user is Admin and checked when present
for anyone else; a mismatch answers 409 `auth.identityChanged` and the client
reloads. Only `DELETE /api/me/impersonation` is exempt.

**`GET /api/me/activity`.** Query: `tab` (default `by`), `assembly` (slug or
id), `category` (repeated or comma-separated), `from` (inclusive) and `to`
(exclusive) as ISO date-times with offset, `cursor`, `limit` up to 100
(default 50). Bad parameters answer 400.

- `by`: the account's events and its own audit rows (sign-ins excluded).
- `to`: audit rows about the account (creation, role, grants, member link,
  role sync), grants of the roles it held while it held them (`approximate`
  when the period is inferred), and impersonations of the account.
- `access`: its sign-ins and sign-outs (with its own IP and user agent),
  access lost or given back (`user.access_revoked`, `user.access_restored`)
  and impersonations on it or by it.
- `member`: other accounts' events for its member, and answers the Mesa
  recorded for it; empty without a member.
- Privacy: every row is judged again with the current actor; rows about
  things the account can no longer see keep type, time and assembly with
  `target.available = false` and an empty payload; others' IPs and emails are
  never sent; `impersonatedBy` only reaches the account itself and Admins.
- `recentImpersonations` lists impersonations of the account in the last 30
  days. A page may hold fewer items than `limit`, even none, with a
  `nextCursor`: page by `nextCursor` only.

**`GET /api/admin/activity`.** Filters `actor`, `target`, `user` (either),
`member`, `assembly` (slug or id, so a deleted assembly can still be found),
`action`, `category`, `kind`, `source`, `impersonated`, `impersonation`, `from`,
`to`, `q` (name or email), `cursor`, `limit` up to 200. Filters combine with
AND.

**Cursors** are opaque (base64url of the UTC time with microseconds and the
id); order is newest first.

**Histories and news.** `EventDto.impersonatedBy` (document and amendment
histories) and `MeWorkNewsDto.impersonatedBy` name the Admin who acted as the
actor's account, only for that account and for Admins.
`document_updated.changes` is removed from the document history for anyone
who is not a presenter, the submitter or a manager.

**Records written by existing endpoints.** The exports record
`export.request` (if it cannot be recorded, nothing is queued: 503) and every
download records `export.download`. `PUT /api/admin/users/[id]/role`,
`.../permissions`, `PUT /api/admin/roles/[id]/permissions` and
`PUT /api/members/[id]` write no row when nothing changes; giving or taking
Admin ends the affected impersonations. `POST /api/members/sync` writes one
row per changed member plus the summary, linked by `batchId`, or only
`members.sync_blocked` when it answers 409. Sign-in and the daily access
re-check write `user.access_revoked`, `user.access_restored` (sign-in only)
and `user.intranet_missing` (sign-in only) (source `intranet`, no actor)
when the Intranet says so; the re-check writes `users.access_recheck_blocked`
when it refuses a mass revocation.
`DELETE /api/assemblies/[assembly]` keeps a copy of the deleted draft's
history in its audit row.
