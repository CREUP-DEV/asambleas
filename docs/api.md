# API

Every shape lives in [`shared/types/api.ts`](../shared/types/api.ts). Request
bodies are validated with Zod v4 schemas in `shared/utils/schemas/`, which must
match those types. Model and rules: [`design.md`](./design.md).

## Conventions

The usual AGENTS.md handler order applies:

1. `requireActor(event)` from `server/utils/domain/actor.ts`.
2. Resolve the route params.
3. Validate the body with `readBodyWith` (the query with `readQueryWith`).
4. Run the DB work in a transaction.
5. Call `recordEvent`.
6. Return the DTO.

- **Validation errors.** `server/utils/core/http.ts`. A body that fails its
  schema answers 400 «Datos no válidos» with `data.issues` (a `path` and a
  `message` each); a body that is not JSON, 400 «Cuerpo de la petición no
  válido»; a query, 400 «Parámetros no válidos» without issues. A few
  endpoints keep their own 400 text (and `messageKey`, such as the
  impersonation's reason). The amendment endpoints, a passage's wording,
  the exports, the package request and the final vote's annulment read a
  missing body as `{}`.
- **Unexpected errors.** `throwMutationError` answers a unique violation
  with 409 «Ya existe un registro con esos datos» and anything else with 500
  «Error al procesar la solicitud», and logs only the error's summary
  (`errorSummary`), never its message, which carries the query's parameters.
  Any other error an `/api` handler lets through (a mutation without its own
  `try`, a read) gets the same answer (with the status the thrown value
  carried, if any, such as an Intranet call's) and the same log from
  `funnelUnhandledError` (`server/plugins/error-funnel.ts`), before Nitro's
  and Nuxt's error handlers, which would log it whole. A page's error keeps
  Nuxt's error page.

- **Route params.**
  - `[assembly]` accepts the slug (`80-ago`) or the id. Resolve it with
    `resolveAssembly`.
  - `[document]` accepts the slug or the id within the assembly.
  - `[amendment]` and `[item]` are CUIDs.
  - All resolvers live in `server/utils/domain/resolvers.ts`, and they return
    404 whenever the actor cannot see the target (`visibility.ts`). A
    malformed id answers 404 as well, on the control sheet's PATCH too.
  - A param without a resolver answers 400 when malformed (`validateCuid`,
    `validateAuthId` in `server/utils/validation.ts`).
  - Ids and instants are checked against one definition each
    (`shared/utils/schemas/primitives.ts`): a row's id is 20 to 32
    lowercase letters and digits (cuid2, and the fixed ids such as the
    CEA's generic member), an account's id 32 letters and digits, an instant
    ISO 8601 with its offset and a year from 0001.
- **Mutations.** CSRF and same-origin are enforced by the `serverHandlers`
  middleware. Every new top-level API section (`/api/members`, `/api/me`) needs
  its entry in `nuxt.config.ts`.
- **Optimistic locking.** Shared PUT, PATCH and POST mutations of existing
  rows take `updatedAt` and use `buildOptimisticLockCondition`, so the write is
  atomic, or `assertOptimisticLock` on a row locked first. A missing
  `updatedAt` is refused like a stale one, except where an endpoint says it
  is optional (a document's `POST .../submit` and `POST .../publish`, the
  PDF upload's multipart field, the signed acta's). A conflict returns 409
  with `data.reason: "stale_write"`
  (`STALE_WRITE_DATA` / `staleWriteError` in `server/utils/optimisticLock.ts`;
  `assertOptimisticLock` adds it). Any other 409 is a rule of the current
  state: it carries its own reason or `messageKey`, or none, and the client
  then shows a neutral text (`common.errors.conflictState`).
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

| Method | Path                                | Who                       | Notes                                                                                                                                                                                                                                                                        |
| ------ | ----------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/me`                           | any                       | `MeDto`. `permissions` are the role's plus the user's own grants (see "Permissions" below). `image` is the URL of the stored photo (`/api/uploads/avatars/[file]`), never the Google picture, or null until one is stored.                                                   |
| GET    | `/api/me/work`                      | any                       | `MeWorkDto`, see "Review and work" below.                                                                                                                                                                                                                                    |
| GET    | `/api/uploads/avatars/[file]`       | any                       | An account's stored photo (`user_avatars`): a 192 × 192 WebP, served only while its account's row names that file (404 otherwise), `private, max-age=31536000, immutable`, `nosniff`, in a rate limiter bucket of its own (`AVATAR_IMAGE_RATE_LIMIT`). See "Account photos". |
| GET    | `/api/members`                      | any                       | `MemberDto[]`, active first, by kind (asociados, sectorials, others, offices) and acronym. `?all=1` also returns inactive members. One generic entry instead of the executive offices, except with `?for=amendment`; see below.                                              |
| POST   | `/api/members`                      | `member:manage`           | Creates a member manually, typically an executive office.                                                                                                                                                                                                                    |
| PUT    | `/api/members/[id]`                 | `member:manage`           | Edits name, kind or active, with `updatedAt`.                                                                                                                                                                                                                                |
| POST   | `/api/members/sync`                 | `member:manage`           | Optional body `MemberSyncBody`. Syncs the intranet roster. Returns `MemberSyncResult`; 409 when it needs confirmation, see "Roster sync".                                                                                                                                    |
| GET    | `/api/admin/users`                  | `user:manage_roles`       | Paginated `AdminUserDto` rows, each with `member`, `extraPermissions`, its access state, `online`, `image` (the stored photo's URL, or null) and `avatarText` (what its avatar reads without a photo, `accountAvatarText`). See "Users list".                                |
| PUT    | `/api/admin/users/[id]/role`        | `user:manage_roles`       | Body `{ roleId }`. Only an Admin gives or takes Admin, Secretaría or Presidencia.                                                                                                                                                                                            |
| PUT    | `/api/admin/users/[id]/member`      | `user:manage_roles`       | Body `{ memberId: string \| null }`. Links an account to a member, see below.                                                                                                                                                                                                |
| PUT    | `/api/admin/users/[id]/permissions` | `user:manage_roles`       | Body `{ permissions: PermissionKey[] }`. Sets the user's own grants, see "Permissions".                                                                                                                                                                                      |
| GET    | `/api/admin/roles`                  | see notes                 | The roles. `user:manage_roles` or `role:manage_permissions`.                                                                                                                                                                                                                 |
| GET    | `/api/admin/roles/[id]/permissions` | see notes                 | What a role grants. `user:manage_roles` or `role:manage_permissions`.                                                                                                                                                                                                        |
| PUT    | `/api/admin/roles/[id]/permissions` | `role:manage_permissions` | Body `{ permissionKeys }`. Not on the Admin role, see "Admin section".                                                                                                                                                                                                       |
| GET    | `/api/admin/permissions`            | see notes                 | The permission catalog. `user:manage_roles` or `role:manage_permissions`.                                                                                                                                                                                                    |

**Account photos.** better-auth keeps the Google picture's URL in
`users.image`, and no answer sends it: `MeDto.image`, `AdminUserDto.image`
and `StatsAccountDto.image` are the URL of the photo the platform stored
(`/api/uploads/avatars/<userId>-<version>.webp`, `user_avatars`), or null
until one is stored, and the avatar then reads `avatarText`. The pg-boss
queue `user-avatars` fetches the picture from `lh3.googleusercontent.com`
only (https, no redirect followed, 10 s, 5 MB) after a sign-in and, once per
boot, for every account whose picture is not stored yet; an account that
loses access, or whose `users.image` turns null, loses its stored photo. The
browser loads no image from Google (`img-src 'self' data: blob:`).

**Executive offices (`MemberRef`).** Wherever an answer carries a member
(`MemberRef`, `MemberDto`, a bare member id such as `mainAuthorId` or the
ids in an event payload), an executive office is itself only for the accounts
that see the offices: Admin, Secretaría, Presidencia, Moderador and CEA, the
holders of `document:manage`, `amendment:review`, `amendment:manage`,
`assembly:manage`, `session:moderate`, `member:manage`,
`user:manage_roles`, `stats:view`, `notification:manage`, `seating:view` or
`seating:edit`, the holders of a key of the control sheet's readers
(`CONTROL_SHEET_READER_KEYS`: `control_sheet:view`, `control_sheet:edit`,
`session:record_speakers`, `assembly:vote_result`), and the accounts that
act for an office (`canSeeExecutiveMembers`). Everyone else
gets the generic presenter
`{ id: GENERIC_EXECUTIVE_MEMBER_ID, acronym: "CEA", name: "Comisión Ejecutiva Ampliada", kind: "executive" }`
(`shared/constants/domain.ts`) instead, once per list:

- documents: `proponent` and `coProponents` (not repeated among the
  co-presenters when the main presenter is an office);
- amendments: `authors`, `mainAuthorId` and `acceptances` (the offices answer
  as one party: rejected if any did, pending while any is);
- both histories: `actorMember`, and `actorName` is null when the member
  acted for is an office; member ids in `payload` become the generic id;
- `/api/me/work`: `acceptances[].proposedBy`, `news[].by` and every document
  and amendment in it;
- `/api/me/activity`: `actor.member`, and `actor.id` and `actor.name` are
  the generic id and name unless the act is the account's own; member ids
  in `payload`; a member target that is an office has the generic id, the
  label `CEA` and an empty payload;
- speaking turns: `member`, and `speaker` is null for an office's turn;
- `GET /api/members`: one generic `MemberDto` instead of all the offices
  (`active` while any office is; it cannot be edited), placed where "CEA"
  sorts, as among the co-presenters of a document;
- PDF exports name the office as `CEA`, according to who requested them.

There are two exceptions, both for the composers of amendments only. The
first is `GET /api/members?for=amendment`
(`MEMBER_LIST_FOR_AMENDMENT`), the list the composers of amendments and
transactionals offer as authors, and nothing else uses: an account that
presents amendments for a member (`amendment:create` and a member,
`canNameExecutiveAuthors`) gets the active members with the real offices,
acronym and name, so it can present one together with them. It carries
members only, never who acts for an office, and `all` is ignored. Any other
account gets the usual list.

The second is `GET .../amendments/[amendment]/authors`
(`AmendmentComposerAuthorsDto`: `authors`, the main one first, and
`mainAuthorId`): whoever may edit a draft reads its real authors, so the
composer shows which offices present the draft and which is the main
author (decided on 2026-11-10). It answers under exactly the checks of
`PUT /[amendment]`, in the same order: 404 when the amendment is hidden;
403 unless the account is its creator or acts for one of its authors; 409
once it is no longer a draft (one sent back for correction is a draft);
409 when the document no longer takes amendments (not published, voted, or
the assembly closed). It does not ask for `canNameExecutiveAuthors`: an
author that lost its member still edits its draft. It carries members
only. What that account reads anywhere else, its own draft included (the
list, the detail, history, news, activity, PDFs), is the generic
presenter.

`MeDto.member` is always the account's real member, and
`MeDto.seesExecutiveMembers` says whether the account reads the offices as
they are (`canSeeExecutiveMembers`). The generic id is not a
member. In the body of a document (`proponentMemberId`,
`coProponentMemberIds`; `resolveBodyMembers`) the rule is:

- an account that does not see the offices cannot add one, by its real id or
  by the generic one: 422 with `data: { reason: "executive_member" }`
  (`EXECUTIVE_MEMBER_REFUSED_REASON`). It cannot remove one either: the
  offices already on the document stay whatever its list says.
  A real office id gets that 422 whether or not the office is on the
  document, so the answer never tells which office stands behind the
  generic presenter (such an account may know the ids from
  `?for=amendment`).
  The generic id is accepted only as a stand-in for them (in a list), or
  for the office that is main presenter, or the only office there (as the main
  one); otherwise 422 `executive_member`. As the main one with several
  offices there and none of them in that place, it cannot say which: 422
  with `data: { reason: "executive_main" }`
  (`EXECUTIVE_MAIN_REFUSED_REASON`), since nothing was added;
- an account that sees the offices names them by their real ids; the generic
  id gets the same 422.

The CEA presents amendments and transactionals too, and any member may
present one with it, so in the body of an amendment or a transactional
(`authorMemberIds`, `mainAuthorMemberId`; `requireAmendmentBodyMembers`)
every office is named by its real id, as a co-author or as the main author.
An account that does not see the offices takes the ids from
`GET /api/members?for=amendment` and, for the ones already on a draft, from
`GET .../amendments/[amendment]/authors`:

- the generic id is never an author, whoever sends it, in the list or as
  the main author: 422 with `data: { reason: "executive_author" }`
  (`EXECUTIVE_AUTHOR_REFUSED_REASON`). It stands for nothing: the offices a
  list leaves out stop presenting the draft, as any other member;
- an office as `mainAuthorMemberId` follows the rule of every member: it
  must be among the authors the body ends with (422 otherwise);
- an account that neither sees the offices nor may name them
  (`canNameExecutiveAuthors`) cannot name one: 422 `executive_member`.
  The one exception is `PUT /[amendment]` on a draft it may edit: the
  offices already among its authors, which it reads in the composer, may
  be sent back (kept) or left out, never another one added;
- whether the actor may edit the draft is checked before any answer that
  depends on its authors;
- a member that proposes a transactional may name any office as a co-author,
  party or not (the other co-authors must be parties);
- once presented, whoever reviews amendments corrects who presents it (see
  "Correcting who presents an amendment").

**Intranet.** Every call to the intranet API (role sync, `POST /user/role`,
and the roster sync, `GET /usuarios/asociados`, `/usuarios/sectoriales`,
`/usuarios/cea` and `/usuarios/cas`) sends `Authorization: Bearer <NUXT_INTRANET_API_TOKEN>` when that variable
is set (a blank value counts as unset). The token is never logged, and
neither is an email: logs carry `accountRef`. The role lookup also sends
`Accept: application/json`. In production, `NUXT_INTRANET_API_URL` and
`NUXT_ROLE_API_URL` must be `https:`, or `http:` to a host with no dot
(`http://intranet`); anything else counts as unset. A `NUXT_ROLE_API_URL` on
another origin than `NUXT_INTRANET_API_URL` never receives the token. Details
in [`intranet.md`](./intranet.md), sections 1 and 2.

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

**Welcome.** Whether the welcome was seen is kept by the browser
(`localStorage`), like the language, the theme and the content preferences,
never on the account: one account may be shared by several people. No
endpoint records it: `POST /api/me/onboarding` is gone,
`users.onboarding_seen_at` is no longer read nor written (it goes in a later
release), and older `user.onboarding_seen` audit rows stay as they were.

**Roster sync.** `POST /api/members/sync` takes an optional body
`MemberSyncBody` `{ confirmDeactivation?: boolean, confirmedKinds?: [{ kind,
toDeactivate }] }` (at most one entry per kind); no body is `{}`, and an
invalid one answers 400. It answers 503 without a usable
`NUXT_INTRANET_API_URL` and 502 when the asociados or the sectorials fail,
writing nothing. The CEA list (`/usuarios/cea`) and the CAS list
(`/usuarios/cas`, the Coordinación del CAS as the `other` member `CAS`) are
optional: when one fails, the sync goes on without it and leaves those
members as they were, and `MemberSyncResult.skipped` names it (`executive`,
`other`; the members page warns). Asociados,
sectorials and offices are matched by `intranet_id`, then by `email` (an
account recreated in the Intranet keeps its address), and deactivated once
the Intranet no longer lists them. The acronym only matches a member that
stores neither, or the same ones: it never hands a member to another account,
and a new one whose acronym another member keeps is not created (it goes to
`ignored`). What the Intranet
lists and the sync cannot store is in `MemberSyncResult.ignored`
`{ acronyms, withoutInitials }`: acronyms listed twice (the first one is
kept) or held by another member, and accounts without initials. The members
page warns, and the `members.sync` audit row keeps it, also for the daily
run. A manual office the CEA list names by its acronym is adopted and syncs
from then on; other manual members are never touched. A sync that would
deactivate every active intranet asociado, sectorial or office, or more than
max(3, 30%) of them, needs `confirmDeactivation: true` and, in `confirmedKinds`, every
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
acts for (at most 100 characters; blank is no search). `role` (a role's id)
lists only the accounts holding it; an unknown id lists none. Order is by name. An invalid value answers 400
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

**Admin section.** `/api/admin/**` opens by permission, not by role. The
`serverHandlers` gate (`server/handlers/auth.ts`) only authenticates (401
without a session) and applies the same-origin, CSRF, `x-acting-user` and
impersonation checks; it filters by no permission key. Each endpoint checks
its own as its first step (`server/handlers/adminEndpoints.test.ts` fails a
handler that does not), Admin holding every key:

- the statistics need `stats:view` and the notifications
  `notification:manage`;

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
  `members.intranet_id`), else the one with its email (`users.email` =
  `members.email`, the address the Intranet looked it up by), else the one
  with its `initials` (the member's acronym). A member found by acronym whose
  `intranet_id` or `email` belongs to another account is not linked, and a
  warning is logged. A missing member is created as an intranet member with
  the account's id and email, and the next roster sync fills it in.
- `CEA` accounts (role shown as "Comisión Ejecutiva Ampliada (CEA)") are the
  place of their executive office (its kind labelled "CEA"), which outlives
  whoever holds it, and link like the others: by intranet id, then by
  email, then by initials. A missing office is created as an intranet member with the
  account's id, named after its acronym (the account carries its holder's
  name) until the next roster sync names it. A CEA account is never linked
  to a council or a sectorial that shares its initials.
- Other types leave `memberId` alone.
- A CEA account that already acts for a member keeps it while its intranet
  initials stay the same, so a link an admin set by hand is not undone at
  the next sign-in. When the initials change (the cargo moved to another
  office), it is linked again by them. Asociado and Sectorial accounts always
  follow their id or their initials.
- An account stops acting for its member (`memberId` becomes null, in the
  same transaction as the role change) when it has a synced role (`Otro`,
  `Asociado`, `Sectorial`, `CEA`) and either its role changes with its
  intranet type (a CEA cargo whose term ended becomes `Otro`, a sectorial
  that signed in as `Otro` becomes `Sectorial`) or its
  intranet type stops being `Asociado`, `Sectorial` or `CEA`. The new type,
  if it is one of those, links it again. `Admin`, `Secretaría`,
  `Presidencia` and `Moderador` accounts keep their role and their link.
- When the role resolved by the sync has no row (the database was not seeded
  after a role was added), the sync logs a warning; a new account gets
  `Otro` instead, and an existing one keeps its role and its member. Run
  `pnpm db:seed` after deploying a new role.

Whoever holds `user:manage_roles` links an account by hand with
`PUT /api/admin/users/[id]/member` (only an Admin its own account, 403
otherwise, see "Admin section"):
when its initials are missing, or when a CEA account's initials are the
person's rather than the office's (the sync then created an `executive` member
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

| Method | Path                                          | Who                | Notes                                                                                                                                                                                                                                                                                                                                                                 |
| ------ | --------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/assemblies`                             | any                | `AssemblyListDto`. Drafts are listed only for managers. Takes `?status=&type=&page=`.                                                                                                                                                                                                                                                                                 |
| POST   | `/api/assemblies`                             | `assembly:create`  | `AssemblyCreateBody`. Seeds the milestones from `defaultMilestones` with the calendar rules of the type, unless told not to.                                                                                                                                                                                                                                          |
| GET    | `/api/assemblies/[assembly]`                  | visible            | `AssemblyDto`, including the milestones, the type's `calendarRules` and the warnings from `checkCalendar`.                                                                                                                                                                                                                                                            |
| PUT    | `/api/assemblies/[assembly]`                  | `assembly:manage`  | `AssemblyUpdateBody`. Settings are merged (see below).                                                                                                                                                                                                                                                                                                                |
| DELETE | `/api/assemblies/[assembly]`                  | `assembly:manage`  | Only in `draft`.                                                                                                                                                                                                                                                                                                                                                      |
| PUT    | `/api/assemblies/[assembly]/status`           | `assembly:manage`  | Follows `ASSEMBLY_STATUS_TRANSITIONS`. Entering `in_session` creates the `live_state` row. Closing ends the speaking turns (see speaking turns).                                                                                                                                                                                                                      |
| PUT    | `/api/assemblies/[assembly]/calendar`         | `assembly:manage`  | `CalendarBody`. Upserts or deletes the milestones. Returns `AssemblyDto`.                                                                                                                                                                                                                                                                                             |
| POST   | `/api/assemblies/[assembly]/convocation`      | `assembly:manage`  | The signed convocatoria: multipart `file` (PDF up to 20 MB, type and signature checked) and `updatedAt`. Replaces the one before. Records `convocation_uploaded`. Returns `AssemblyDto`.                                                                                                                                                                              |
| DELETE | `/api/assemblies/[assembly]/convocation`      | `assembly:manage`  | `?updatedAt=`. Removes the signed convocatoria and its file. Records `convocation_removed`. Returns `AssemblyDto`.                                                                                                                                                                                                                                                    |
| GET    | `/api/uploads/convocations/[filename]`        | visible            | The signed convocatoria (`AssemblyDto.convocationFile.url`) to whoever sees the assembly. Drawn in the page by pdf.js, never framed. Revalidated by ETag (304), and a single `Range` answers 206 (416 past the end; `If-Range` must name the current ETag), in a rate limiter bucket of its own, as the documents' PDFs (`GET /api/uploads/documents/[filename]`) do. |
| GET    | `/api/assemblies/[assembly]/review`           | see notes          | `ReviewQueueDto`, the Secretaría's validation inbox. `document:manage` or `amendment:review`, otherwise 403. See "Review and work" below.                                                                                                                                                                                                                             |
| GET    | `/api/assemblies/[assembly]/review/validated` | `amendment:review` | `ReviewValidatedDto`: validated and published amendments still undecided whose validation can be taken back. See "Review and work" below.                                                                                                                                                                                                                             |

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
`transactionalProposers` (user's decision of 2026-11-20) says who may present
a transactional: `involved` (the default), the authors of the original
amendments it combines (down through any transactional it combines) and the
document's presenters; `anyone`, also any member account with
`amendment:create`. The Mesa always may. A transactional's parties are the
main authors of those original amendments, never a combined transactional's
own author.

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
quorum of the type: `{ numerator, denominator, strict }`, a share of the
asociados with a vote, "at least" or, with `strict`, "more than". It is the
quorum of the call a session opens in: the second call when the type has
two, its only call otherwise. There is no first-call quorum.

## Agenda

| Method | Path                                                 | Who               | Notes                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------ | ---------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/assemblies/[assembly]/agenda`                  | visible           | `AgendaDto`: flat items plus the documents the actor can see. Items that carry the title of a document the actor cannot see are left out, or sent with `titleHidden` (see "Automatic sub-items").                                                                                                                                                                                                                  |
| POST   | `/api/assemblies/[assembly]/agenda`                  | `assembly:manage` | `AgendaItemBody` (`title`, `parentId`, `description`, `acceptsSubmissions`, `submissionKinds`, `confirmFinal`). Returns `AgendaItemDto`.                                                                                                                                                                                                                                                                           |
| PUT    | `/api/assemblies/[assembly]/agenda/[item]`           | `assembly:manage` | `AgendaItemBody` with `updatedAt` (required; a POST drops it). Returns `AgendaItemDto`. A new title on an automatic sub-item sets `titleCustom`.                                                                                                                                                                                                                                                                   |
| DELETE | `/api/assemblies/[assembly]/agenda/[item]`           | `assembly:manage` | Deletes the item with its sub-items and every document under them. 409 `agenda_item_amendments` while any of those documents has an amendment of any status; 409 `agenda_item_live` during the session while one of them is being debated; 409 `agenda_item_sheet` while the control sheet noted something about one of them or one of them has a vote of its own (voided ones too). See "Deleting an item" below. |
| PUT    | `/api/assemblies/[assembly]/agenda/reorder`          | `assembly:manage` | `AgendaReorderBody`. Validates that every parent exists in the same assembly and that there are no cycles.                                                                                                                                                                                                                                                                                                         |
| POST   | `/api/assemblies/[assembly]/agenda/[item]/documents` | `document:manage` | `BulkDocumentsBody`. Creates several documents under the item, all or none. Returns 201 `BulkDocumentsDto`. See "Adding several documents" below.                                                                                                                                                                                                                                                                  |

Once the agenda is final (`agendaFinalizedAt`, the calendar's `agenda_final`
date once it has come: `agendaFinalSince`), a change to the root items
needs a confirmation: creating one (POST), renaming one or moving an item
from or to the root level (PUT `[item]`), changing which items are root items
or their order (PUT `reorder`) and deleting one (DELETE). The request says
`confirmFinal: true` in the body (`?confirmFinal=true` in the query of the
DELETE, which has no body). Without it the answer is 409 with
`data: { code: "agenda_final" }` (`AGENDA_FINAL_CONFLICT_CODE`) and nothing
changes, so the client asks "El orden del día ya es definitivo. ¿Cambiarlo
igualmente?" and sends the request again. The event of a confirmed change
carries `afterFinal: true`. Sub-items, and the description, the submissions
switch and «Se vota el punto» of a root item, never need `confirmFinal` and never get `afterFinal`;
on a provisional agenda `confirmFinal` is ignored (`confirmFinalRootChange`).

Nobody marks the agenda as final or reopens it: moving the `agenda_final`
milestone (PUT `calendar`) is how. The events `agenda_finalized` and
`agenda_reopened` remain only in the history from before.

**Items where members present ("containers").** `acceptsSubmissions` marks an
item where members present documents, and `submissionKinds` names the
document kinds it takes; an empty list means every kind (`itemAcceptsKind` in
`shared/utils/agendaSubmissions.ts`). `AgendaItemBody.submissionKinds` is
optional: left out, a POST stores none and a PUT keeps the stored ones. It is
stored empty while `acceptsSubmissions` is off. The kinds bind members only:
a member that creates a document of another kind there, moves one in or
changes the kind of one already there gets 422 with
`data: { reason: "submission_kind" }`; managers put any kind anywhere.

**«Se vota el punto».** `voted` marks an item voted by itself (a
ratification, an election) rather than through its documents' final votes.
`AgendaItemBody.voted` is optional: left out, a POST stores false and a PUT
keeps the stored value. It is never stored on an item where members present
(`normalizeItemVoted`): turning submissions on clears it. It is never refused: while a document of the item is
voted (`itemHasVotedDocuments` in `shared/utils/controlSheet.ts`) it means
nothing, since those votes are the item's. It only makes the control sheet
list the item and read it «Pendiente» instead of «No aplica» until its vote;
recording a vote on the item never requires it (see "Votes on an agenda
item").

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
  it becomes an ordinary item (`auto` false, `generatedForDocumentId` null):
  its title no longer follows the document's, it takes other documents and
  it never goes with the document. It may still carry the document's title,
  so the server remembers the document (`agenda_items.hiddenWithDocumentId`,
  not in the DTO) and keeps hiding the item as below until the document is
  published, the document is deleted or a manager gives the item a new
  title. An item a manager had already renamed (`titleCustom`) carries the
  manager's title, so it keeps no link and everyone reads it at once.
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
  Kept for that reason, it is sent without its title: `title` is empty and
  `titleHidden` true (`hiddenTitleItemIds`), and clients show a neutral
  label ("Punto de un documento sin publicar"). A masked item also comes without `description` and
  `generatedForDocumentId`. The same goes for the item
  kept after its document moved away, and for one whose document was
  deleted before it was public (a draft, or one under review): the delete
  marks the items that carried its title and stay as withheld
  (`agenda_items.titleWithheld`, never one with `titleCustom`), and only
  document managers read their title and description until one of them
  gives the item a new title. PUT `[item]` answers with the same mask: an
  account with `assembly:manage` that may not read the title (no
  `document:manage`, not a presenter) changes the rest of the item, and
  what it sends as title and description is ignored. The assembly export
  does the same with the items of documents that are not public (a
  postponed one is public, as in the platform, though it is not printed)
  and with withheld titles, for every requester, and a
  document's export never prints such a title of the item it hangs from.
- has no number while not everyone receives it. Agenda numbers ("17.1") are
  never stored: they are computed from the items, and everyone reads the
  same number for the same item, the one an account that sees only what is
  public reads. `AgendaItemDto.unlisted` is true on the items such an
  account does not receive (`unlistedAgendaItemIds`: what
  `visibleAgendaItems` leaves out for someone who sees only the published
  and postponed documents), whoever the viewer is. `numberAgendaItems`
  (`shared/utils/agendaNumbering.ts`) counts the siblings skipping those,
  so an unlisted item has no number (nor anything under it), keeps its
  place and never shifts its siblings; clients show "Sin publicar" where
  the number would be, and the convocation leaves it out. An item everyone
  gets without its title (`titleHidden`) is listed and numbered. Screens
  and PDFs use that one function. The assembly export never holds an
  unlisted item, and `agendaNumbering` in a document's export data is null
  while its item is unlisted. PUT `[item]` answers with the flag too; a new
  item (POST) is always listed.

Its events are `agenda_item_created`, `agenda_item_updated` (the title
following the document) and `agenda_item_deleted`, each with `auto: true` and
the `documentId`; the activity shows them to those who can see that document.
The later events of an item kept after its document moved away (a manager's
PUT, its delete) carry the `documentId` without `auto`, are shown the same
way, and the delete of an item above it leaves it out of `deletedItems`.
Once the document is deleted, the events that name it are shown to everyone
if it was public by then (the `status` of its `document_deleted`), and
otherwise to document managers and those who could see it. The events of an
item whose title is withheld carry `titleWithheld: true` and are the document
managers'.

**Deleting an item.** DELETE removes the item, its sub-items and every
document under them, in one transaction. Amendments keep it: while any
of those documents has an amendment row of any status (drafts and withdrawn
ones included) the answer is 409 with
`data: { code: "agenda_item_amendments", documents, amendments }` (how many
documents have amendments and how many amendments in all) and nothing
changes. Published and voted documents without amendments go. While the
assembly is `in_session` it is also refused, 409 with
`data: { code: "agenda_item_live" }`, if the projection shows one of the
items or documents or one of the items has a speaking turn waiting or in
progress. It is refused too, 409 with `data: { code: "agenda_item_sheet" }`,
while the control sheet noted something about one of the items (a listing, a
result by hand, a treated mark or observations) or one of the items has a
vote of its own, voided ones too (a vote stays in the minutes). Each document goes as in DELETE `documents/[document]`
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
item itself otherwise. Every row names its presenter: a row without
`proponentMemberId` takes the manager's own member, and with neither the row
is refused (422). The form starts every row with the manager's own member.
The rules of a
single create apply to each row (`presenter_kind`, a member that does not
exist or is inactive); the error of a row carries `data.index`, its position
in the request. It answers 201 with `BulkDocumentsDto`: `{ documents: [{ id,
slug, title, kind, format, agendaItemId }] }` in the order sent, so the
client uploads a PDF to each `file` document through `POST
.../documents/[document]/file`. Each document records `document_created` and
each sub-item `agenda_item_created`.

## Documents

| Method | Path                                                                                     | Who                                                               | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------ | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/assemblies/[assembly]/documents`                                                   | visible                                                           | `DocumentSummaryDto[]`. `amendmentCount` counts the amendments past draft that the actor can see (see who sees an amendment). `hasAmendments` says whether the document has any amendment at all, drafts and unpublished ones included, to accounts with `document:manage` or `assembly:manage`; null for everyone else.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| POST   | `/api/assemblies/[assembly]/documents`                                                   | see below                                                         | `DocumentCreateBody`. Creates a draft and its working version. Under an item that accepts submissions it also creates the automatic sub-item, so the `agendaItemId` returned is the sub-item's.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GET    | `/api/assemblies/[assembly]/documents/[document]`                                        | visible                                                           | `DocumentDto`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| PUT    | `/api/assemblies/[assembly]/documents/[document]`                                        | editor                                                            | `DocumentUpdateBody`. `format` switches between text and PDF until publication (409 after); the draft text and the PDF both stay for a switch back, and a PDF is never amendable. Status changes return 409 once the final vote is recorded. A new `title` renames its automatic sub-item unless that has its own title; a new `agendaItemId` removes the automatic sub-item left empty and, under an item that accepts submissions, creates a new one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| DELETE | `/api/assemblies/[assembly]/documents/[document]`                                        | `document:manage`                                                 | Returns 409 with a final vote (annul it first) or, once published, while it has any amendment, drafts included (`deleteBlocker`; withdraw it instead). Takes its versions, co-presenters and the votes of an annulled final vote with it, and clears the live projection if it shows it. `DocumentDto.can.delete` mirrors the rule. Its automatic sub-item goes with it when it holds nothing else.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| PUT    | `/api/assemblies/[assembly]/documents/[document]/content`                                | editor                                                            | `DocumentContentBody`. Replaces the working draft. Returns 409 if `baseHash` is stale or the document is published.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| POST   | `/api/assemblies/[assembly]/documents/[document]/reading`                                | visible                                                           | `DocumentReadingBody` (`opened`, `seconds` 0 to 60). A beat of an open published document, for the statistics: `opened` adds a view, `seconds` adds time, credited at most the time since the account's last beat on the document that day (plus 5 s). Returns `DocumentReadingDto` (`recorded` false for a document that is not published or while an Admin impersonates). Records no event: the `document_views` row is the record (`NON_RECORDING_MUTATIONS`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| POST   | `/api/assemblies/[assembly]/documents/[document]/presence`                               | editor                                                            | `DocumentPresenceBody`. Heartbeat of an open draft editor (every 20 s, at once when `unsaved` changes): records the tab in memory for 90 s (background tabs beat only once a minute), or drops it with `leaving: true`, and returns `DocumentPresenceDto`, the other tabs editing the draft (never the caller's own; two tabs of one account count apart, since a council's account is shared). Names follow `redactEventActor`: whoever acts for a CEA office reads as the generic "CEA" with no name to those who may not see the offices. An impersonating Admin is never announced. Writes no state and records no event (`NON_RECORDING_MUTATIONS`). 409 once the text is frozen or the document is a PDF.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| POST   | `/api/assemblies/[assembly]/documents/[document]/import`                                 | editor                                                            | Multipart DOCX up to 15 MB, with magic bytes checked. Returns `DocxImportDto` and saves no text; the file's pictures are stored for the document as images (as by the upload below), recording one `document_images_imported` with their count. The archive's real inflated size and entry count are bounded, mammoth runs in a child process with its own heap and time limit, and the HTML it returns is bounded in nodes, nesting, block elements and formatting marks before it is parsed. `warnings` lists what was lost: `tracked_changes`, `comments`, `images_dropped` (a picture that could not be read or stored, or past 100 pictures or 32 MB), `images_in_tables` (pictures in a table or list, left out), `images_without_alt` (stored pictures with no description), `tables_flattened` (a table nested in a table cell became a paragraph per row), `tables_split` (tables laid side by side in one table, with an empty spacer column whose cells hide their top and bottom rules, became tables one after the other), `formulas_dropped` (a Word equation that could not be read; the others become formula blocks or marks, their LaTeX source) and `highlight`. A Word title equal to the document's title is left out. 413 when a size or markup limit is exceeded, 415 for a corrupt or non-DOCX file, 422 when the document exceeds the content limits (blocks, text per paragraph, nesting, formatting) or has no usable text (that one carries `data: { reason: "empty" }`, since splitting the file cannot help), 429 when the user already has an import running or waiting or the conversion queue is full (an import whose client disconnects leaves the queue at once), 500 when the converter cannot start. |
| POST   | `/api/assemblies/[assembly]/documents/[document]/images`                                 | editor                                                            | Multipart `file`: a PNG or JPEG up to 10 MB (`DOCUMENT_IMAGE_MAX_BYTES`; a larger one answers 413 with `data.messageKey` `common.editor.image.tooLarge`) for the text of a structured draft (409 once the text is frozen, or past 200 images). Checked by signature and written again by `sharp` (upright, no metadata, at most 2,400 px a side). Returns `{ asset, width, height }`; records `document_image_uploaded`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| GET    | `/api/uploads/images/[image]`                                                            | visible                                                           | A stored image, to whoever can see its document (404 otherwise), with its own type, `nosniff` and private caching.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| POST   | `/api/assemblies/[assembly]/documents/[document]/file`                                   | `document:manage` or proponent                                    | PDF upload for the `file` format. See PDF replacement below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| GET    | `/api/assemblies/[assembly]/documents/[document]/files`                                  | `document:manage`                                                 | `DocumentFileVersionDto[]`: the PDFs the published document replaced, newest replacement first. See PDF replacement below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| POST   | `/api/assemblies/[assembly]/documents/[document]/submit`                                 | proponent                                                         | A presenter sends a draft to the Secretaría (`submitted`). See validation below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| POST   | `/api/assemblies/[assembly]/documents/[document]/correction`                             | `document:manage`                                                 | `CorrectionBody`. Sends a submitted document back to draft with a note. Returns `DocumentDto`. See validation below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| PUT    | `/api/assemblies/[assembly]/documents/[document]/positions`                              | `document:manage`                                                 | `PositionsPublicationBody`. Publishes the main presenter's answers to a published document's amendments before their debate (`public: true`), or takes that back (`false`; 409 `document.positions.errors.debateStarted` once the debate of its agenda item started, when they are public for good). Optimistic lock on the document. Records `document_positions_published` or `document_positions_unpublished` (the debate's start records `document_positions_debate_started`). Returns `DocumentDto`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| POST   | `/api/assemblies/[assembly]/documents/[document]/publish`                                | `document:manage`                                                 | Validates (publishes) the document. See publishing rules below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GET    | `/api/assemblies/[assembly]/documents/[document]/history`                                | visible                                                           | `EventDto[]` for the document and its amendments, respecting amendment visibility. Correction notes are removed from the payload for those who may not read them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| GET    | `/api/assemblies/[assembly]/documents/[document]/pages`                                  | visible                                                           | `DocumentPagesDto`: where each printed page of the text's clean Spanish PDF starts (user's decisions of 2026-11-21), for the readers' «pág. N». `base` is the text as presented, `consolidated` the consolidated text once voted (corrected and conciliated versions included), each `PageMapDto` `{ versionId, total, starts: PageMapStart[] }` with one start per printed page that holds a block (`{ blockId, page, inside }`, `inside` when the page breaks inside that block; the cover of a positioning is not counted). Only a published `structured` document has them (otherwise both null). A map is returned only while its stored key matches the text as its PDF would come out now (`pageLayoutKey`); a missing or stale one is queued (`document-pages`) and the answer says `pending: true` with `retryAfter`, the seconds until the soonest of its jobs may run (its `startAfter`, past the prebuild in a convened or sitting assembly; `pagesRetryAfter`), never under 5; the reader waits at least that long, never less than its own 20/40/60 s schedule. Takes `?view=room` like the document's GET.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| POST   | `/api/assemblies/[assembly]/documents/[document]/final-vote`                             | `session:moderate` or `assembly:vote_result`                      | `FinalVoteBody`. See final vote rules below; `project: false` (the control sheet) leaves the projection where it is. Returns `DocumentDto`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| GET    | `/api/assemblies/[assembly]/documents/[document]/form-corrections`                       | document readers                                                  | `FormCorrectionsDto`: the corrections of form to the approved text, oldest first; the ones not applied only for the Secretaría, the Mesa and the presenters.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| POST   | `/api/assemblies/[assembly]/documents/[document]/form-corrections`                       | `document:correct_form` (applied at once); a presenter (proposed) | `FormCorrectionBody`. 409 `stale` when `fromVersionId` is not the consolidated version in force, 422 `no_change`. 409 `pendingConciliation` while a passage of the approved text is pending conciliation. Returns `FormCorrectionsDto`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| POST   | `/api/assemblies/[assembly]/documents/[document]/form-corrections/[correction]/decision` | `document:manage`                                                 | `FormCorrectionDecisionBody`. Applies (409 when another correction overtook it) or rejects a pending one. Returns `FormCorrectionsDto`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| DELETE | `/api/assemblies/[assembly]/documents/[document]/form-corrections/[correction]`          | its author                                                        | `FormCorrectionWithdrawBody`. Withdraws a pending one. Returns `FormCorrectionsDto`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| POST   | `/api/assemblies/[assembly]/documents/[document]/conciliations`                          | `document:correct_form` (applied at once); a presenter (proposed) | `ConciliationBody`: the wording of a passage the final vote left pending conciliation, over the base. 409 `stale` when `fromVersionId` is not the consolidated version in force, 409 `passage_changed` when the passage is not pending in it, 422 `wording_outside`. A proposal is decided or withdrawn through `form-corrections/[correction]`. Returns `FormCorrectionsDto`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| DELETE | `/api/assemblies/[assembly]/documents/[document]/final-vote`                             | `session:moderate` or `assembly:vote_result`                      | `FinalVoteAnnulBody`. Annuls the final vote, see below. Returns `DocumentDto`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| POST   | `/api/assemblies/[assembly]/documents/[document]/export`                                 | visible                                                           | Body `{ variant: "clean" \| "annotated", locale, justified }`. Enqueues a PDF export and returns `{ jobId }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

**Who can create.** Managers (`document:manage`) can always create a document,
for any members (see presenters below) and with no content. Members with
`document:create` (Asociado, Sectorial and CEA accounts) can create one under
an agenda item that has `acceptsSubmissions`, of a kind the item takes
(`submissionKinds`; 422 `submission_kind` otherwise), until its kind's
deadline (`presentationDeadlinePassed`: `candidacies_close` for candidacies
and venues, `reports_close` for reports, `documents_close` for the rest and
for a kind whose own milestone the assembly lacks; 409 `data.reason`
`documents_deadline_passed`; `assembly_closed` once the assembly is closed), always as one of its
presenters. The same deadline binds sending it (`POST .../submit`), so a
member never holds a draft it can no longer send, and changing its kind or
its item (`PUT`): a member's change that leaves the document past its kind's
deadline where it ends up hanging, when it was not before, gets the same 409
`documents_deadline_passed` (`requirePresentationChangeOpen`). That covers a
kind whose deadline has passed, moved along or not, and a move out of an item
reserved to the Secretaría, which takes away the exemption of an expected
document. An internal deadline or a correction requested exempt the change
wherever the document goes, and a draft already past its deadline, or still
within it after the change, moves and changes freely. Under such an
item the document gets its own automatic sub-item (see Agenda), whoever
creates it.

**Who may present a kind.** A sectorial or an `other` member (the CAS) never presents an internal motion,
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
`DocumentSummaryDto.proponent`), and may have co-presenters
(`document_proponents`, `DocumentSummaryDto.coProponents` by acronym), who
prepare the text with it and answer its amendments as it does. Bodies
carry `proponentMemberId` and `coProponentMemberIds` (never the main
presenter; up to 20, no repeats). The rules (`planPresenters` in
`server/utils/domain/presenters.ts`):

- a document is always presented by someone (`presenter_required`, 422): a
  create names a presenter, and an update never clears it (`null`). A
  document stored without one, from before this rule, keeps none until
  someone is named;
- with co-presenters there must be a main presenter: 422 otherwise;
- managers set any members (they must exist and be active, 422; a
  presenter set earlier stays even if the roster sync deactivates it). On
  create the main presenter defaults to their own member; a manager without
  a member names one;
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
  `reason: "rule_changed"`), for the assembly to vote, and the
  transactionals its incorporation closed come back (see transactionals).

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
without a `dueAt` it is not expected and its kind's deadline
(`presentationDeadlinePassed`) binds it. That deadline does not bind an
expected document: its `dueAt`, if any, is the deadline, and an overdue one can still
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
  must do it before its kind's deadline (`presentationDeadlinePassed`)
  unless the document is expected (see
  above; 409 `data.reason` `documents_deadline_passed`); managers are not
  bound by it. Nobody sends one once the assembly is closed (409
  `assembly_closed`).
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
its final vote; after it the upload returns 409. Every PDF has a
`document_files` row. Before publication the previous file is deleted with its
row. Once published, the previous file stays on disk, its row gets
`replacedAt` and `replacedByUserId`, and the `document_file_uploaded` event
records `previousFileId` and `previousFileName` (events from before carry
`previousFileUrl` instead). `GET .../files` lists those files to document
managers, and the uploads route serves one only to a document manager who can
see the document; to everyone else it answers 404. Deleting the document
removes them all.

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
- Every amendment must be decided first: otherwise 409 with
  `{ undecided: ids }`.
- Records the vote on the whole text, whatever its result, as `finalVoteId`.
  That closes every amendment action on the document.
- When it is approved, consolidates the base with the approved amendments, in
  approval order (`inApprovalOrder`) or in `order`, and the Mesa's wordings,
  using `consolidateApproved` (shared/utils/content/passages.ts), and stores
  the result as a `consolidated` version (`consolidatedVersionId`). A
  deletion wins over the approved changes inside what it deletes; where
  approved amendments change the same text, or text that touches, the Mesa
  words the passage first.
- An approved amendment that no longer fits the base returns 409 with
  `{ conflicts }`. A passage still without the Mesa's wording returns 409
  with `{ pendingPassages }` unless the body says `allowPendingPassages: true`
  (user's decisions of 2026-11-21; 422 together with `order`; a rejection
  needs no flag): the `consolidated` version then stores the automatic
  proposal there and lists the passages in `pendingPassages` (`VersionDto`;
  `DocumentSummaryDto.pendingConciliation` counts them), and `document_voted`
  carries `pendingPassageKeys`. Nothing is stored on a 409.
- The live projection shows the vote (see the live session below).

**Wording a passage.** `PUT .../documents/[document]/wordings`
(`session:moderate` or `assembly:vote_result`, until the final vote) takes
`PassageWordingBody` `{ amendmentIds, blockIds, ops, note? }`: the approved
amendments and base blocks of a passage as `consolidateApproved` reports it
(409 `passage_changed` otherwise) and `ops` against the base that change only
those blocks (422 `wording_outside` otherwise). Setting it again for the same
passage replaces it. It applies while those amendments and blocks are still
the passage; if one of them is reopened or another approved amendment touches
those blocks, it waits, kept. `DELETE .../wordings/[wording]` removes it (the
automatic proposal applies again). They record `passage_worded` and
`passage_wording_removed`, and `GET .../amendments` returns them as
`wordings` (only those over amendments the reader sees).

**Conciliating a passage after the vote** (user's decisions of 2026-11-21).
`POST .../documents/[document]/conciliations` takes `ConciliationBody` `{
fromVersionId, amendmentIds, blockIds, ops, reason? }` for a passage listed in
the consolidated version's `pendingPassages`. With `document:correct_form` it
applies at once: the wording is stored in `passage_wordings`, the text is
rebuilt from the base with the approved amendments in approval order and every
wording, and a new `consolidated` version replaces the one in force
(`replacesVersionId`) with the passages still pending; `passage_conciliated`
(payload `codes`, `reason`, `madeAs`, `validated`). A presenter's waits for
the Secretaría as a correction of form (`document_form_corrections.passage`,
`FormCorrectionDto.passage`; `passage_conciliation_proposed`, payload `codes`,
`reason`), who applies it through `.../form-corrections/[correction]/decision`
(while its passage is still pending, whatever other passages were conciliated
since; 409 `passage_changed` otherwise) or rejects it. Annulling the final
vote voids the pending ones. While any passage is pending, corrections of form
answer 409 `pendingConciliation`. `DocumentCapabilities.conciliate` says
whether the reader conciliates (`direct`), proposes (`propose`) or neither.

**Passages that merge on their own** (user's decision of 2026-11-20).
`consolidateApproved` first tries to merge the changes of a paragraph word by
word, and only what does not merge is `pending` (and holds the final vote
back). A `merged` passage needs no wording: the same change made twice counts
once; a change that rewrites a stretch is split into the words it really
changes (`wordEdits`, a word diff without semantic cleanup), so another
change of a real word (three letters or digits) it leaves as it was applies
too (an acronym expanded inside a rewritten sentence); two changes that meet
at one point both apply only when one of them keeps its own words (a wrap
such as "SIGC" -> "Sistema … (SIGC)"); a touch-up (punctuation, or up to
three words the rewrite does not bring back) inside text another change
rewrites, six words or more and three times longer, has no effect, reported
as `superseded` like a deletion's; and a space or sign a rewrite next to it
already adds counts once. The Mesa may still word a merged passage, which then
reads `worded`.

**Annulling the final vote.** `DELETE .../final-vote` with
`FinalVoteAnnulBody` (`updatedAt` of the document for the optimistic lock,
optional `note`) corrects a wrongly recorded final vote.

- `session:moderate`, and the assembly must not be `closed` (409,
  `data.messageKey` `common.errors.voteAssemblyClosed`, as for an item vote).
- 409 when the document has no final vote, or when `updatedAt` is stale.
- The vote row and the consolidated version stay for the record. The document
  loses `finalVoteId` and `consolidatedVersionId`, so its amendments can be
  decided or reopened again and the final vote taken again.
- Records `final_vote_annulled` (payload `voteId`, `result`,
  `consolidatedVersionId` and `note`) and stops projecting the vote.
- Voids the corrections of form still pending; a new final vote rebuilds
  the text without the applied ones.
- Returns the `DocumentDto`.

## Amendments

All paths are under `/api/assemblies/[assembly]/documents/[document]/amendments`.

`GET ?ids=a,b` (comma-separated, at most `PARTIAL_AMENDMENTS_MAX`, 20; more,
none or a malformed id is a 400) reads some amendments of the list instead
of all of it, through the same context as the full list (`?view=room`,
visibility, positions, redaction): `PartialDocumentAmendmentsDto` with the
asked amendments and those whose DTO reads them (the amendments a
transactional groups and the transactionals over one,
`linkedAmendmentIds`, only from the asked ones the reader sees), each the
DTO the full list would send, in text order; `gone`, the asked ids the
reader does not get (deleted or hidden, never told apart), on which the
reader reads the whole list; and `baseVersionId`. Relations and wordings
are not sent. The room's readers (the document page, Directo, the projection)
read it after a live batch whose changes stay within a few amendments
(`amendmentsRefetchPlan`: decisions, answers, acceptances) and merge it into
the list they hold (`mergePartialAmendments`), reading the whole list
otherwise.

| Method | Path                                           | Who                                                              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | ---------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | ``                                             | visible                                                          | `DocumentAmendmentsDto`, filtered by `canSeeAmendment`. Positions are nulled when `canSeePositions` is false: until the document's answers are public (published by the Secretaría, or its agenda item's debate started), only its presenters, the Mesa and reviewers read them.                                                                                                                                                                                                                                                                               |
| POST   | ``                                             | `amendment:create`, document amendable and published             | `AmendmentDraftBody`. Creates a draft.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| PUT    | `/[amendment]`                                 | author while the amendment is a draft                            | `AmendmentUpdateBody`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| DELETE | `/[amendment]`                                 | author while the amendment is a draft                            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| POST   | `/[amendment]/submit`                          | author                                                           | See submission rules below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| POST   | `/[amendment]/withdraw`                        | author or moderator                                              | Allowed until the amendment is decided. Closes the pending transactionals over it. A transactional already in force over amendments of members other than the author's is the Mesa's to withdraw: 409 to its authors (`withdrawNeedsMesa`). Records `amendment_withdrawn` with `{ by: "author" \| "moderator", replacedSources?: true, replacedSourceIds? }`, both set when it withdraws a transactional in force (`replacesSourcesNow`) that replaced sources (`transactedSourceIds`): those stay `transacted`; their authors read it in their news.          |
| POST   | `/validate`                                    | `amendment:review`                                               | `ValidateAmendmentsBody`. See validation below. Returns `DocumentAmendmentsDto`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| POST   | `/publish`                                     | `amendment:review`                                               | `PublishAmendmentsBody`. See validation below. Returns `DocumentAmendmentsDto`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| POST   | `/[amendment]/correction`                      | `amendment:review`                                               | `AmendmentCorrectionBody`. See validation below. Returns `AmendmentDto`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| POST   | `/[amendment]/unvalidate`                      | `amendment:review`                                               | `UndoValidationBody`. Takes a validation back. See validation below. Returns `AmendmentDto`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| POST   | `/[amendment]/reclassify`                      | `amendment:review`                                               | `ReclassifyBody`. See reclassifying below. Returns `AmendmentDto`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| GET    | `/[amendment]/authors`                         | author while the draft can be edited                             | `AmendmentComposerAuthorsDto`: the draft's real authors, for its composer only. See "Executive areas".                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| POST   | `/[amendment]/authors`                         | `amendment:review`                                               | `AmendmentAuthorsBody`. See correcting who presents an amendment below. Returns `AmendmentDto`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| POST   | `/admission`                                   | `amendment:review` or moderator                                  | See admission rules below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| PUT    | `/[amendment]/position`                        | main presenter or moderator                                      | `PositionBody`. See the main presenter's answer below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| POST   | `/[amendment]/outcome`                         | moderator or `assembly:vote_result`                              | See outcome rules below. A vote with `project: false` (the control sheet), or by whoever only holds `assembly:vote_result`, is not projected.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| POST   | `/assent`                                      | moderator or `assembly:vote_result`                              | `BulkAssentBody` (`items`: id and `updatedAt`, up to 500, unique) → `BulkAssentDto`: a bloc approved by assent in one request, each through the single `approve`/`assent` outcome in order; `failed` lists those it could not approve with the reason, and the rest go on. Live notices go out together at the end. Only while the session is open.                                                                                                                                                                                                            |
| POST   | `/bloc-vote`                                   | moderator or `assembly:vote_result`                              | `BlocVoteBody` → `BlocVoteDto`: one counted vote on two or more amendments (no assent: that is `/assent`), under the document's amendment majority; carried, every one approved, else every one rejected, in one transaction. 409 `{ tie: true }` under `tieRule: "repeat"`. Reopening one needs `wholeVote: true` and reopens them all.                                                                                                                                                                                                                       |
| POST   | `/lapse`                                       | moderator or `assembly:vote_result`                              | `BulkLapseBody` (as `BulkAssentBody`) → `BulkLapseDto` (as `BulkAssentDto`): the lapse offer's amendments marked as lapsed in one request, each through the single `lapse` outcome in order; `failed` lists those it could not mark, and the rest go on. Live notices go out together at the end. Only while the session is open.                                                                                                                                                                                                                              |
| POST   | `/alternatives`                                | moderator or `assembly:vote_result`                              | `AlternativesVoteBody` → `AlternativesVoteDto`: a vote between sets of amendments (user's decisions of 2026-11-20). The most voted option wins (absolute majority on the Estatutos and regulations): its amendments approved (or, with `winnerOutcome: "keep"`, left undecided to be voted against the original text), the others rejected, at once. 409 `{ tie: true, undecided }` with no winner unless `tieResolution`; 409 `errors.splitChanged` if it splits the options on screen otherwise. Reopening one needs `wholeVote: true` and reopens them all. |
| POST   | `/transactional`                               | `amendment:create` acting for a member, or moderator             | See transactional rules below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| POST   | `/[amendment]/acceptance`                      | pending party (main author), or a moderator for one              | See acceptance rules below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| POST   | `/[amendment]/revisions`                       | the transactional's main author, moderator or `amendment:review` | `TransactionalRevisionBody`. Proposes including amendments in an existing transactional, with its new text. See inclusions below.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | `/[amendment]/revisions/[revision]/acceptance` | pending party of the inclusion, or a moderator for one           | `AcceptanceBody`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | `/[amendment]/revisions/[revision]/validate`   | `amendment:review`                                               | Applies a member's inclusion every party accepted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| POST   | `/[amendment]/revisions/[revision]/cancel`     | whoever proposed it, moderator or `amendment:review`             | Withdraws an open inclusion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| POST   | `/relations`                                   | moderator, reviewer or proponent                                 | `RelationBody`. Both amendments must belong to the document, so `same_in_other_document` returns 422.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| DELETE | `/relations/[relation]`                        | the same roles                                                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| GET    | `/[amendment]/history`                         | visible                                                          | `EventDto[]`. Correction notes are removed for those who may not read them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

**Inclusions in a transactional** (user's decision of 2026-11-19;
`proposeTransactionalRevision` and the functions after it in `amendments.ts`).

- A `transactional_revisions` row holds the amendments it adds
  (`addedSourceIds`) and the full new text (`ops`, `justification`); at most
  one open per transactional (409 otherwise). Its parties are the main
  authors of every parent of the new version, old and added
  (`transactional_revision_acceptances`); the proposer's member, when it is
  one, is accepted at once; the Mesa and the Secretaría are no party.
- The added amendments must be open parents (published, undecided, admitted
  or late awaiting admission) of the same document and not parents already.
- Any rejection leaves the transactional as it was (`rejected`). All
  accepted, one proposed by the Mesa or the Secretaría (`staffProposed`) is
  applied at once; a member's waits for `.../validate` (`pending_validation`).
- Applying it writes the new text, adds the parents and the new parties
  (accepted), and, when the transactional is already in force (validated
  and accepted), replaces the added parents now (`replaceSources`; a late
  one awaiting the assembly stays linked).
- `AmendmentDto.proposer` (`{ member: MemberRef; at: IsoDate | null;
presentsDocument: boolean } | null`): for a transactional a member
  presented (never the Mesa in session), that member (redacted like the
  authors) and when (`submittedAt`); null otherwise, and when that member is
  no longer among its authors. `presentsDocument` says that member presents
  the document now, decided on the server with the real ids
  (`proposingPresenterOf`): two offices both read as "CEA". Stored as
  `meta.proposerMemberId`; those presented before 2026-11-21 get it at boot
  from their latest `amendment_submitted` with `admission: "pending"`.
- `AmendmentDto.openRevision` (`TransactionalRevisionDto`) carries the open
  one: added parents the reader sees, new text, answers, and `can.answer`,
  `can.validate`, `can.cancel`. Events: `transactional_revision_proposed`,
  `_answered`, `_ready`, `_applied`, `_rejected`, `_cancelled`; the parties
  still to answer get `transactional_acceptance_requested`, and a member's
  inclusion ready for validation `transactional_ready`.

**Who sees an amendment** (`canSeeAmendment`).

- Drafts: their authors, the user who created them, the members involved
  in a transactional (its parties, the main authors of what it replaces, and
  every other author of those amendments) and reviewers (`amendment:review`
  or `amendment:manage`). The Mesa alone (`session:moderate`) does not read
  members' drafts.
- Presented amendments are visible to everyone who can see the document only
  once the Secretaría publishes them (`publishedAt`). Until then (waiting for
  validation, validated but kept private, or decided before publication) only
  their authors, the user who created them, the members involved in a
  transactional, reviewers and the Mesa see them, and the CEA's accounts (role
  `CEA`) from the moment they are presented, before their validation too
  (`seesPresentedAmendments`). A transactional also reaches the presenters of
  its document (main presenter and co-presenters) from the moment it is
  presented, withdrawn ones aside (`presentsTransactionalDocument`; user's
  decision of 2026-11-21): reading only, never as an insider. Once validated
  (`validatedAt`), an unpublished amendment is also visible to whoever reads
  the control sheet (`CONTROL_SHEET_READER_KEYS`: `control_sheet:view`,
  `:edit`, `session:record_speakers` or `assembly:vote_result`)
  (`seesValidatedAmendments`). Nobody answers one before its validation
  (`positionBlocker`); their main presenter answers it once it is published,
  or once validated when an office of the CEA presents the document.
  Visibility is per amendment: there is no assembly-wide policy any more.
- The same rule drives `amendmentCount` in document summaries, the history
  and the admission decisions returned by `GET .../decisions`.
- `correctionNote` is returned only to the authors, the creator, the members
  involved in a transactional, reviewers and the Mesa, and null for everyone
  else.

**Main author.** An amendment with co-authors has a main author
(`AmendmentDto.mainAuthorId`, listed first in `authors`), stored as the
presenting member: it drives the code (`UGR4`, or `CEA4` for any
executive office) and alone answers the
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
- It numbers it (`numberAmendments`): `number` is the next per document and
  `memberSeq` the next of the code's prefix in the document, and `code` is
  `"{PREFIX}{memberSeq}"` with no space (`UGR3`). The prefix is the acronym
  the presenter's avatar reads (`amendmentCodePrefix`): a council's
  university acronym, else its own; a sectorial's or the CAS's acronym. When
  the main author is an executive office the code is `"CEA{memberSeq}"` for
  everyone, and the offices share that sequence, so the code never names the
  office. A number once given is never given again, also when the amendment
  is withdrawn or, sent back for correction, deleted (`takenAmendmentCodes`).
  An amendment sent back for correction keeps its `number`, and its
  `memberSeq` and `code` while its main author's prefix is the same;
  otherwise it takes the next of the new prefix. A transactional takes the
  next `T{n}`. The `amendment_submitted` event carries the `number` and
  `code` it got. Publishing numbers only an amendment presented before this
  rule that has none yet.
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
  `submitted` amendment back to `draft` with the note in `correctionNote` and
  `correctionRequestedAt`: one not validated yet, or one validated, published
  or not, that is still undecided (`can.unvalidate`, below). `submittedAt`
  becomes null; number, code and timing are kept (see submitting): its
  authors may fix it and present it again, on time if it was, or leave it
  (a draft never counts). A validated one also loses `validatedAt`,
  `publishedAt` and its admission, and its presenter's answer goes back to
  pending. Records `amendment_correction_requested` (`{ note }`, plus
  `afterValidation`, `published` and `positionReset` when they apply). A
  transactional still waiting for its main authors returns 409.
- The body is an `AmendmentCorrectionBody`: with `correctable: false` (user's
  decision of 2026-11-19; absent or true is the correction above) the
  amendment cannot be corrected, and the Secretaría declares it not admitted
  with the note instead. It takes one waiting for validation (late or not),
  one validated that could go back to review (as above) unless it is late,
  and a `draft` already sent back for a correction (`correctionRequestedAt`);
  anything else, or after the final vote, 409. The amendment gets
  `status` and `admission` `inadmissible`, `decidedAt` and the note as
  `outcomeNote`; `validatedAt` and `publishedAt` stay as they were (one never
  validated stays private), a returned draft gets back `submittedAt` and
  `submittedByUserId` from its latest `amendment_submitted`, and one
  validated has its presenter's answer reset. It records a `decisions` row
  (`inadmission`, method `secretaria`, the note), `decision_recorded` and
  `amendment_inadmissible` (`{ decisionId, method: "secretaria", note,
onReview: true }`, plus `afterValidation`, `published`, `afterCorrection`
  and `positionReset` when they apply). The Mesa may readmit it
  (`POST .../admission`). Same locks and optimistic lock as the correction.
- `POST .../[amendment]/unvalidate` (`UndoValidationBody`: the amendment's
  `updatedAt`) takes a validation back: the amendment stays `submitted` and
  loses `validatedAt`, `publishedAt` and its admission, so the Secretaría
  has it in «Por revisar» again and only its authors, the Secretaría and the
  Mesa read it. The presenter's answer goes back to pending. Records
  `amendment_validation_undone` (`{ published }`, plus `positionReset`). Both this and a
  correction after validation need `can.unvalidate`
  (`validationReopenBlocker`): validated, undecided, not a transactional,
  not a late one the assembly admitted, the document not voted and the
  assembly not closed; and they answer 409 while the Mesa has it on screen
  or any transactional groups it, closed ones included (they could come
  back over it), each with a `messageKey`.
- Reclassifying: `POST .../[amendment]/reclassify` (`amendment:review` or
  `amendment:manage`; `session:moderate` alone answers 403. `ReclassifyBody`:
  the `kind` it becomes and the amendment's `updatedAt` for the optimistic
  lock) moves a `submitted` amendment between "de forma" (`formal`) and the
  content kind (`partial`), whatever its review state, and also one the
  main presenter's acceptance incorporated (`approved` with
  `approvalMethod: "proponent"`), which changing that answer would reopen
  (`canReclassifyAmendment`). Only those two kinds have a counterpart
  (`reclassifyTarget` in `shared/utils/amendmentReclassify.ts`): a
  transactional, a `kind` that is not the other one of the two, a draft,
  any other decided amendment and a voted document all return 409. Records
  `amendment_reclassified` (`{ from, to }`), shown in the amendment's
  history and in its authors' news. Only the answer may change with it
  (`reclassifyPositionPlan`): made `formal` while it can be answered and
  nobody answered it, it is accepted by itself (see the automatic answer
  below); made `partial` while its answer is still that automatic
  acceptance (`accept`, and its latest `position_changed` has
  `by: "auto"`), the answer goes back to `pending` (`position_changed`
  with `by: "auto"`), which reopens it if that acceptance had incorporated
  it (`amendment_reopened` with `reason: "position_changed"` and
  `by: "auto"`). An answer given by hand stays, and the amendment follows
  its new kind's rule (`reclassifyIncorporation`): made `formal`,
  undecided and admitted with an acceptance, it is incorporated; made
  `partial` under the `vote` rule while that acceptance had incorporated
  it, it is reopened (`amendment_reopened` with `reason: "reclassified"`)
  and what its incorporation closed comes back. Locks: the document
  (share), the amendment with the transactionals over it and what they
  group, their acceptances, then its position row.
- Correcting who presents an amendment: `POST .../[amendment]/authors`
  (`amendment:review` or `amendment:manage`; `session:moderate` alone
  answers 403. `AmendmentAuthorsBody`: `authorMemberIds`, at least one,
  `mainAuthorMemberId`, one of them, and the amendment's `updatedAt` for
  the optimistic lock) replaces the authors and the main author of a
  `submitted` amendment or transactional, in case it was presented wrong
  (`changeAmendmentAuthors`). A draft is its authors' to edit; a draft, a
  decided amendment and a voted document return 409, and a body that
  changes nothing 422. Members added must be active; offices are named by
  their real ids (reviewers see them). The number in the document stays.
  The code follows the main author as when a
  corrected draft is presented again (`numberingToKeep`): kept while its
  prefix is the same, also from one office to another (both `CEA`),
  otherwise the next of the new main author's sequence. The code only moves
  when the main author changes. A code given up this way is never handed to
  another amendment (the `previousCode` of these events counts as taken in
  its sequence, `nextMemberSeq`); only the same amendment gets it back if a
  later correction returns it to that sequence. A transactional keeps its
  `T n`. The main author is a party of the transactionals over
  the amendment (or over the transactional, once it replaced its parents),
  so it cannot change while one of them is a draft or presented (409); its
  co-authors can. Proposing a transactional re-checks the main authors of
  its parents under the document lock (409 if one changed meanwhile).
  Records
  `amendment_authors_changed`
  (`{ from: { authorMemberIds, mainAuthorId }, to: { ... }, code?, previousCode? }`,
  the codes only when the code changes), shown in the amendment's history
  with the members before and after (member ids masked as everywhere, the
  generic id always last in a list) and in the news of its authors after
  the change. A member taken out is not told.
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
  (see transactionals); they are locked in the same ordered pass. The note
  becomes their `outcomeNote` and goes in `amendment_inadmissible` (`note`),
  so their authors read why (user's decision of 2026-11-19); one already
  inadmissible (a failed vote to readmit it) keeps its own. Readmitting one
  clears its `outcomeNote`.
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
- A vote is projected live (see the live session below), naming what it
  decided (`LiveStateDto.voteDecision`). Before deciding, the console in
  control may put the published late amendments on screen as a proposal to
  admit them or not (`LiveStateBody.amendmentBlocPurpose`); a decision by the
  Mesa, the Secretaría or assent leaves it there, each amendment showing what
  was decided.
- Returns `AmendmentAdmissionDto`.

**The presenters' answer.** `PUT .../[amendment]/position` with a
`PositionBody` records the answer of the document's presenters (accept,
reject, transact, or back to pending, with an optional comment). Returns the
`AmendmentDto`.

- A presenter's member answers, the main presenter or a co-presenter, or the
  Mesa for them (403 otherwise). The `position_changed` event names whose
  answer it is (`memberId`: the presenter the actor acts for, or the main
  presenter when the Mesa records it, with `by: "moderator"`), and so do
  the `amendment_approved` and `amendment_reopened` it sets off, which the
  home page's news credit. `PositionDto.answeredBy` gives that member for a
  presenter's answer to the readers of `recordedBy` (the generic `CEA` id
  for an office the reader does not see).
  `PositionDto.recorder` names who recorded it on the presenter's behalf
  (`mesa`, `secretaria` or `presidencia`, by that account's role), and
  `recordedBy`, `recorder` and `updatedAt` are null for a reader other than
  the amendment's authors, the document's presenters, the CEA's accounts,
  the Mesa, the Secretaría and the Presidencia (`seesAnswerRecord`).
  `PositionDto.recordedBy` says who recorded the answer, as it was then:
  `"mesa"` when the amendment's latest `position_changed` has
  `by: "moderator"`, `"presenter"` when it has `by: "proponent"`, `"auto"`
  when it has `by: "auto"` (the automatic answer below), so an
  answer keeps its author when the document later gets another main
  presenter. Without that event it compares the member of the user stored
  in `amendment_positions.decidedByUserId` with the document's current main
  presenter (`"presenter"` for the pending row created on submission, which
  nobody recorded).
- Only once the amendment can be answered (`positionBlocker`), 409
  otherwise: presented and undecided, validated by the Secretaría, for a
  transactional once every main author accepted it, and seen by the main
  presenter (user's decision of 2026-11-17): published, or only validated
  when an office of the CEA presents the document, since the CEA's
  accounts read validated amendments. A late one is answered before the
  assembly decides whether to treat it; under "incorporate" its acceptance
  is kept and incorporates it when the assembly admits it. The message
  says what is missing. `can.position` follows the same rule, and is false once
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
  (`submitted`, `amendment_reopened` with `reason: "position_changed"`)
  and brings back the transactionals its acceptance closed (see
  transactionals). Under the `vote` rule an answer never decides anything.
- One the assembly approved otherwise (by a vote, by assent or as a formal
  one: `approvalMethod` other than `proponent`) can still be answered under
  either rule until the final vote, once its presenter reads it (user's
  decision of 2026-11-19, `answerableAfterDecision`): only the answer and
  `position_changed` are recorded, the approval and the text stay, and
  `can.position` says so. A rejected one too (2026-11-21): accepting it
  does not approve it. A withdrawn, lapsed, transacted or inadmissible one
  is decided: 409.
- After the final vote nothing changes (409).
- Locks: the document (share), the amendment (and what a transactional
  replaces, with the other transactionals over that or over the amendment)
  in id order, its acceptances, then its position row.
- A formal amendment follows the `incorporate` rule whatever the
  document's (user's decision of 2026-11-20, `amendmentRule`): an
  acceptance incorporates it, also under `vote`, and switching the document
  to `vote` leaves it in the text. Validating one always publishes it
  (`publishOnValidation`, as a transactional; `publish: false` is ignored
  for it). Those validated before this rule are published, accepted and
  incorporated once at boot (`settleFormalAmendments`).
- The automatic answer: a "de forma" amendment (`kind: "formal"`) does not
  wait for the main presenter. The moment it can be answered
  (`positionBlocker`) with no answer yet (none, or `pending`), it is
  accepted by itself, exactly as if the main presenter had accepted it
  (`shouldAutoAcceptPosition`, `autoAcceptFormal`, which shares
  `recordPosition` with this endpoint): the stored answer (with
  `decidedByUserId` the user whose act made it answerable),
  `position_changed` with `by: "auto"` (and `memberId`, the main
  presenter) and, as a formal one follows `incorporate`, the approval
  (`amendment_approved` with `{ method: "proponent", byPosition: true,
memberId, reason: "formal" }`) that closes the pending transactionals
  over it. It runs at the end of the transaction that made it answerable,
  under that path's locks plus the transactionals over it, their
  acceptances and its position row: validating it with `publish`,
  publishing it (not once the document is voted), admitting it (also a
  readmission, or a failed vote to declare it inadmissible), the Mesa's
  `reopen`, and reclassifying it as `formal`. Never a content amendment,
  never after the final vote. The presenters see it
  (`recordedBy: "auto"`) and change it with this endpoint like any answer
  until the final vote. `position_changed` sends no email; the
  `amendment_approved` email says it was accepted automatically, and the
  news name nobody for it (`automatic`).
- A transactional a presenter presented (user's decision of 2026-11-21): when
  the member stored as its proposer (`meta.proposerMemberId`) is the
  document's main presenter or a co-presenter, the moment it can be answered
  (every party accepted, validated and published; no answer and no
  `position_changed` ever; under `incorporate` no parent still awaiting the
  assembly's admission: `shouldAcceptProposedTransactional`) it is accepted as
  that presenter's answer (`acceptProposedTransactionals`, through
  `recordPosition`): `decidedByUserId` the account that presented it,
  `position_changed` with `{ position: "accept", by: "proponent", memberId,
reason: "proposed" }` (so `recordedBy: "presenter"` and `answeredBy` that
  presenter; `reason: "proposed"` says the answer came from presenting it),
  and under `incorporate` the approval with `reason: "proposed"` and what it
  closes. It runs at the end of `POST .../validate` and of an admission under
  `incorporate`, also one that declares a parent not admitted while the
  transactional goes on with the others, under their locks (the
  transactional, what it groups, the
  other transactionals over those and over it, their acceptances, then its
  position row). A presenter only named as co-author by someone else does not
  count. One presented by an author of what it combines waits for the
  presenter's answer as before. Those presented before this rule are settled
  once at boot (`backfillProposedTransactionals`,
  `settleProposedTransactionals`, with the validator as actor): only the ones
  whose proposer that boot fills in (`meta.proposerBackfilled`, removed when
  the run ends), so a later restart settles nothing; an answer someone set
  back to pending is never overridden. The answer changes like any
  other until the final vote.
- A formal amendment its main presenter rejects is not debated by default
  (user's decision of 2026-11-20): under either rule the answer rejects an
  admitted one at once, undecided or incorporated by its acceptance
  (`positionEffect` "reject":
  `status: rejected` with no vote, `amendment_rejected` with
  `{ method: "proponent", byPosition: true, reason: "formal_rejected",
memberId }`, what waited on it closed). Rejected that way
  (`rejectedByAnswer`: formal, rejected, no `outcomeVoteId`), its answer
  stays open until the final vote: any other answer reopens it
  (`amendment_reopened` with `reason: "position_changed"`), and under
  `incorporate` an acceptance then incorporates it. The Mesa may reopen it
  (`reopen`) to debate and vote it; the answer stays "reject" and nothing
  rejects it again until the presenter answers again.

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
  amendment through `POST .../withdraw` (except a transactional already in
  force over other members' amendments, which only the Mesa withdraws:
  `withdrawNeedsMesa`, 409).
- Every outcome that settles the amendment (`approve`, `vote`, `withdraw`,
  `lapse`) closes the pending transactionals over it (see transactionals),
  locked in the same ordered pass as the amendment.
- `reopen` brings the amendment back to `submitted`. Its vote row stays for
  the record, but the `amendment_reopened` event records it as
  `voidedVoteId` and the projection stops showing it. The main presenter's
  answer stays. Under the `incorporate` rule an acceptance never leaves an
  admitted amendment undecided, so one that keeps it (given after the
  assembly approved it, or before the rule changed) is incorporated again
  at once (`amendment_approved` with `{ method: "proponent", byPosition:
true }`, `incorporateOnAdmission`); not a transactional. Clients do not
  offer reopening one the acceptance incorporated while that answer can
  be changed: changing it is what takes it out (`isSessionReopenable`).
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
- Reopening any amendment brings back the pending transactionals its
  decision closed, when they can go through again (see transactionals).
- When approving any amendment, the response lists the ids of amendments with
  hard overlaps or an `incompatible` relation, so the client can offer to mark
  them as `lapse`.

**Transactionals.** The body is a `TransactionalBody`. Any member can
propose one over published amendments, before or during the session
(docs/design.md, "Transactionals").

- Who: any account with `amendment:create` that acts for a member (a council,
  sectorial or CEA office), the document's main presenter, the authors of the
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
  presenter is not a party unless it is one of them. The creator's own member,
  when it is a party, is accepted at once. When a presenter of the document
  (main or co-presenter) presents it, that presenter is still no party, but
  presenting it is its answer: see the automatic answer under «The main
  presenter's answer».
- Authors: the proposer's member plus `authorMemberIds`; non-moderators may
  only add members involved (the authors of what it groups and the
  document's main presenter), 403 otherwise. `mainAuthorMemberId` names the
  main author among them (422 when it is not one, and required with several).
- With `submit` (default) it is submitted at once and `late` is ignored.
  Created by a member, it goes:
  1. to the main authors of what it groups (`pending_authors`, private to its
     authors, its creator, the members involved, the document's presenters,
     the CEA, reviewers and the Mesa). Its `amendment_submitted` event carries
     `awaitsAuthors: true` while it waits. Each one accepts or rejects it
     (`POST .../acceptance`); any rejection closes it and the originals carry
     on. The Secretaría's inbox lists it read only (`can.validate` false) and
     its counts leave it out;
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
  When that amendment goes back to undecided before the final vote (a new
  answer takes an incorporated one out, `reopen` below, the rule changes
  back to `vote`, or the assembly readmits an inadmissible one), the
  transactionals its settling closed come back: `submitted` again,
  `decidedAt` cleared, and `amendment_reopened` with
  `{ previousStatus: "withdrawn", reason: "source_reopened", sourceId,
sourceCode }`, read in the news like the closure (nobody named, its
  parties too). Only one whose latest withdrawal is such a closure, whose
  amendments are all open again and that no main author rejected
  (`reopenTransactionalsClosedBy`); the others stay as they are. The order
  does not matter: one over A and B, closed by A, with B decided later,
  comes back when the second of them is reopened, and so does a closure
  from before this rule once everything it groups is open. Every reopen path locks those transactionals and what they group in
  the same ordered pass (`restoreLockIds`), then their acceptances.
  An older one left submitted with a source already closed is still never
  asked for an answer (`can.accept` false, left out of the home page's
  `acceptances`, and accepting it returns 409); its proposer withdraws it
  or the Mesa closes it.
- Withdrawing a transactional in force never restores its sources: they
  stay `transacted`. So once it stands in for amendments of members other
  than the author's, only the Mesa withdraws it: `can.withdraw` is false
  and `POST .../withdraw` returns 409 to its authors (`withdrawNeedsMesa`,
  checked again under the lock). While it waits for its parties or the
  Secretaría, or groups only the author's own amendments, its author still
  may.
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

## Read marks

What an account marked as read, by hand, among the published documents of an
assembly and the published amendments to them (docs/design.md, "Read
marks"). The marks are the account's own: any account that sees the assembly
reads and changes its own, and nobody else's. Only the statistics read
another account's (`stats:view`, "Statistics").

| Method | Path                                    | Permission | Notes                                                                                                                                                                                                                                                     |
| ------ | --------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/assemblies/[assembly]/read-marks` | visible    | `ReadMarksDto`: every published document (`id`, `state`, `own`) and every published amendment to one that is not withdrawn (`id`, `documentId`, `state`, `own`, `open`).                                                                                  |
| PUT    | `/api/assemblies/[assembly]/read-marks` | visible    | `ReadMarksBody` (`read`, `documentIds`, `amendmentIds`, at least one id, up to 500 of each). Marks them as read on the revision on show, or removes the marks. 404 if any id is not in the GET's lists. Records `read_marks.set`. Returns `ReadMarksDto`. |

`state` is `unread` (never marked), `read` (marked on the revision on show)
or `changed` (marked on another one: the document was published again or its
PDF replaced, the amendment came back corrected). `own`: the account's
member presents it. `open`: the amendment is presented and undecided.

### Private notes

The account's private notes on a published document (design.md, "Private
notes"). They are the account's own: any account that sees the document
reads and changes its own, and nobody else's (an Admin acting as the account
is that account). While the document is not published, GET answers
`available: false` with no notes, and the writes answer 409.

| Method | Path                                                           | Permission | Notes                                                                                                                                                                                                                      |
| ------ | -------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/assemblies/[assembly]/documents/[document]/notes`        | visible    | `DocumentNotesDto`: `available` and the account's notes, oldest first (`id`, `anchor` or null, `body`, `createdAt`, `updatedAt`).                                                                                          |
| POST   | `/api/assemblies/[assembly]/documents/[document]/notes`        | visible    | `DocumentNoteCreateBody` (`body`, up to 4000 characters; optional `anchor`: `blockId`, `from` < `to`, `quote` up to 2000). 409 past 200 notes on the document. Records `document_note.created`. Returns `DocumentNoteDto`. |
| PUT    | `/api/assemblies/[assembly]/documents/[document]/notes/[note]` | visible    | `DocumentNoteUpdateBody` (`body`, `updatedAt`). Only the text changes. 404 if it is not the account's; 409 if `updatedAt` is no longer the stored one. Records `document_note.updated`. Returns `DocumentNoteDto`.         |
| DELETE | `/api/assemblies/[assembly]/documents/[document]/notes/[note]` | visible    | 404 if it is not the account's. Records `document_note.deleted`. Returns `{ success: true }`.                                                                                                                              |

The account's private notes on an amendment it reads, about the whole
amendment (no anchor), under
`/api/assemblies/[assembly]/documents/[document]/amendments/[amendment]/notes`
(the amendment answers 404 to an account that may not read it). GET answers
`AmendmentNotesDto` (`available` false, with no notes, for a draft); POST
takes `AmendmentNoteCreateBody` (`body`, up to 4000 characters; 409 past 50
notes on the amendment); PUT `.../[note]` takes `AmendmentNoteUpdateBody`
(`body`, `updatedAt`); DELETE `.../[note]` returns `{ success: true }`. They
record `amendment_note.created`, `.updated` and `.deleted`, with the
amendment's document as target and no payload.

## Statistics

Read only, for whoever holds `stats:view` (by default the Secretaría and
the Presidencia, and an Admin; design.md, "Statistics"). Both
take `?assembly=`, a slug or an id, and answer 404 for an assembly the caller
may not see.

| Method | Path                          | Permission   | Notes                                                                                                                                                                                                                                                                    |
| ------ | ----------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/admin/stats`            | `stats:view` | `StatsDto`: `assembly`, `totals`, `members` (`StatsMemberDto`, in `orderMembers` order), `accounts` (`StatsAccountDto`, with `online`, `image`, the stored photo's URL or null, and `avatarText`) and `documents` (`StatsDocumentDto`).                                  |
| GET    | `/api/admin/stats/users/[id]` | `stats:view` | `StatsAccountDetailDto`: the account's `StatsAccountDto`, its member and every published document and amendment with the state of its mark (`state`, `readAt`, `own`) and, for documents, its opening (`views`, `seconds`, `firstOpenedAt`). 404 for an unknown account. |

## Email notifications

For whoever holds `notification:manage` (by default the Secretaría and the
Presidencia, and an Admin; design.md, "Email notifications"). Read-only
while an Admin impersonates, like the whole admin section.

| Method | Path                                  | Permission            | Notes                                                                                                                                                                                                                                                        |
| ------ | ------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/admin/notifications`            | `notification:manage` | `NotificationSettingsDto`: `settings` (the stored row over `DEFAULT_NOTIFICATION_SETTINGS`), `updatedAt` (null while nothing was stored), `roles` (the role names), `smtp` (`configured`, `from`) and `lastDay` (deliveries of the last 24 hours by status). |
| PUT    | `/api/admin/notifications`            | `notification:manage` | Body `NotificationSettingsBody` (`settings`, every kind; `updatedAt` as read). 409 when it changed since. Audit `notifications.update` (before and after). Answers the new `NotificationSettingsDto`.                                                        |
| POST   | `/api/admin/notifications/test`       | `notification:manage` | Sends a test email to the caller's own address now and logs it (kind `test`). `EmailTestResultDto`: `sent`, `failed` or `skipped` (`unconfigured`). Audit `notifications.test`.                                                                              |
| GET    | `/api/admin/notifications/deliveries` | `notification:manage` | `EmailDeliveryDto[]`, newest first, `?limit=` up to 200 (50 by default): kind, status, frequency, skip reason, recipient (id and name, never the address), attempts, last error, times. `subject` only for `document:manage`.                                |

## Review and work

**Validation inbox.** `GET /api/assemblies/[assembly]/review` returns a
`ReviewQueueDto` for `document:manage` or `amendment:review` (403 otherwise):

- `documents`: with `document:manage`, the `submitted` documents waiting for
  validation, as `DocumentSummaryDto`, in creation order;
- `amendments`: with `amendment:review`, each with its document reference,
  grouped by document in agenda order (then creation order) and then in
  text order, none of a withdrawn or postponed document (they wait for
  nobody until it is published again):
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
- `formCorrections`: with `document:manage`, the documents whose presenters
  proposed corrections of form to the approved text, each with how many wait
  («Texto aprobado»). It counts the proposed conciliations of passages left
  pending by the final vote too (user's decisions of 2026-11-21).

`GET /api/assemblies/[assembly]/review/validated` returns a
`ReviewValidatedDto` for `amendment:review` (403 otherwise): «Publicadas»,
the amendments validated and published that are still `submitted` and
whose validation can be taken back (`can.unvalidate`), in the same order,
late ones waiting for the assembly's decision left out. The inbox reads it
only when that tab is opened; `POST .../amendments/[amendment]/unvalidate`
takes a validation back.

**Home page.** `GET /api/me/work` returns a `MeWorkDto` over the assemblies
that are not closed and that the actor can see (draft assemblies only for
managers and the Mesa), soonest first:

- `documents`: the documents the actor's member presents, as main presenter
  or co-presenter, that are `draft` (expected ones included), `submitted` or
  `published`. A draft whose presentation is closed for the actor
  (`presentationClosed`: past its kind's deadline
  (`presentationDeadlinePassed`), not expected, not sent back
  for a correction; managers are not bound by it) is listed with
  `presentationClosedAt` (the deadline that passed, `workDocumentClosedAt`
  from the kind's `presentationDeadlineAt`), and the home page shows it as a
  quiet update (`document_closed`), not a task, since `POST .../submit` would
  refuse it;
- `amendments`: the amendments the actor's member authored that are still
  `draft` or `submitted`, newest change first, drafts only while their
  document still takes amendments (published, structured, amendable, with a
  base text and not voted, as `assertAmendable`), with `reviewState` (a
  member-proposed transactional shows `pending_authors`), the
  `correctionNote`, and `late` and `admission`, so a late one can say it
  waits for the assembly's decision;
- `review`: for `document:manage` or `amendment:review`, per assembly with
  something pending, `documentsToValidate` and `documentsOverdue` (expected
  drafts past `dueAt`), which need `document:manage`, and
  `amendmentsToValidate` and `amendmentsToPublish` (the inbox's "to
  validate" and "to publish" sets: transactionals waiting for their main
  authors, late amendments waiting for the assembly's decision and the
  amendments of withdrawn or postponed documents are not counted), which
  need `amendment:review`;
- `proponent`: the `published` documents the actor's member presents as main
  presenter, not voted yet, with something to answer, in assembly order and
  then creation order. `positionsPending` counts, over the amendments of the
  document the actor can see, the `submitted` ones without an answer that
  the main presenter can answer now (`positionBlocker`: validated,
  published, admitted if late, and for a transactional accepted by its main
  authors), under either rule. Documents with 0 are left out. `answerBy` is
  when the assembly starts (`startDate`), before which the main presenter
  is expected to answer them all; null once the assembly is `in_session`.
  The home task shows it as its deadline only while it is ahead, and never
  as overdue (`homeWorkProponentDueAt`), since the Mesa can still record
  answers in the room;
- `acceptances`: the submitted transactionals the actor's member can
  still answer, as main author of an amendment they would replace
  (`awaitsPartyAnswer`: its answer pending, everything it groups still
  open, the document published and not voted), in assembly and document
  order, each with `replaces`: the member's amendments it would replace,
  and `proposedBy`: its main author (null when the Mesa presented it on
  nobody's behalf);
- `news` ("Novedades"): what others decided about the member's work in the
  last 30 days, newest first, at most 30 (`MeWorkNewsDto`):
  - for the presenters of a document (main and co-presenters), the answers
    another presenter, or the Mesa for them, gave to its amendments
    (`position_changed`);
  - for the authors of an amendment, the presenters' answer to it
    (`position_changed`), once the document's answers are public to them
    (`canSeePositions`);
  - for the authors of an amendment, the main authors' answers to the
    transactionals over it, and to the transactionals the member proposed
    (`acceptance_recorded`);
  - for the authors of an amendment, what was settled about it:
    `amendment_validated`, `amendment_published`,
    `amendment_correction_requested`, `amendment_reclassified` (the value
    is the kind it became), `amendment_authors_changed` (the value is
    its new code, when it changed), `amendment_admitted`,
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
    `amendment_lapsed` with `reason: "sources_transacted"`, and coming back
    by itself: `amendment_reopened` with `reason: "source_reopened"`;
  - for the authors of the amendments a transactional replaced, that
    transactional withdrawn once in force (validated and accepted by every
    main author, `replacesSourcesNow`): `amendment_withdrawn` with
    `replacedSources: true` and `replacedSourceIds`, the sources it
    replaced (`transacted`; a late one still waiting for admission is not
    among them, and one presented under the earlier rule replaced none
    before its approval, so it records neither), told only to those
    amendments' authors, recorded when an author withdraws it
    (`POST .../withdraw`, which leaves it to the Mesa while other members'
    amendments are among them) or the Mesa does, from that endpoint or the
    session console; their amendments stay `transacted`. Its value is
    `replaced`;
  - for the presenters of a document (main and co-presenters), what was
    settled about it, with `amendment: null`: `document_published` (the
    Secretaría's validation), `document_correction_requested`,
    `document_voted` and `document_status_changed`.

  `by` is the member that decided: null for a transactional that closed by
  itself or came back by itself (`amendment_withdrawn` with
  `by: "sources_closed"`, `amendment_lapsed` with
  `reason: "sources_transacted"`, `amendment_reopened` with
  `reason: "source_reopened"`) and for the automatic answer to a formal
  amendment (`position_changed` or `amendment_reopened` with `by: "auto"`,
  `amendment_approved` with `reason: "formal"`, which also carry
  `automatic: true`), which nobody decided; the party, for an answer to a transactional; the main
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
  `by: "sources_closed"`) or whose reopening brought it back
  (`amendment_reopened` with `reason: "source_reopened"`), `replaced` for a
  transactional in force withdrawn (`amendment_withdrawn` with
  `replacedSources`), the result of the final vote (`document_voted`)
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

| Method | Path                                            | Who                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------ | ----------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/assemblies/[assembly]/decisions`          | visible             | `DecisionDto[]`. An admission decision (`admit_late`, `inadmission`) lists in `subjectIds` only the amendments the actor can see, and is left out when it names none of them, so its note and vote do not reveal private amendments.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| GET    | `/api/assemblies/[assembly]/live-state`         | visible             | `LiveStateDto`. The question of a point vote on screen goes only to a reader who gets that item with its title (`liveStateFor` in `server/utils/live/liveState.ts`, the rule of the item-votes endpoints: `loadReaderItems`); the PUT answers the Mesa the same way.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| PUT    | `/api/assemblies/[assembly]/live-state`         | `session:moderate`  | `LiveStateBody`. Records a `live_changed` event; a body that changes nothing writes nothing and records none. An `amendmentId` must be published (409 otherwise): every delegate follows the projection. `speakersVisible` shows attendees who has the floor (see speaking turns).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| GET    | `/api/assemblies/[assembly]/live-scroll`        | visible (room view) | `LiveScrollDto` or nothing (204): where the Mesa last had the document on screen scrolled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| POST   | `/api/assemblies/[assembly]/live-scroll`        | `session:moderate`  | `LiveScrollBody`. 204. Memory only, never recorded; ignored unless it is the live document in session. Pushed on the live stream as a `scroll` event.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | `/api/assemblies/[assembly]/projection-control` | `session:moderate`  | `ProjectionControlBody` (`tabId`, `action`: `beat`, `take` or `leave`) → `ProjectionControlDto` (who controls the projection, `you`, `sameAccount`, open consoles). Memory only; a change of holder is recorded once (`projection_control_changed`). Writes that move the screen need the holder's tab in `x-console-tab`: `PUT live-state` answers 409 `projection_control` otherwise; scroll, pointer and tally are ignored; votes are recorded without projecting.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | `/api/assemblies/[assembly]/live-pointer`       | `session:moderate`  | `LivePointerBody`. 204. The Mesa's pointer, clicks and strokes on the live document; pushed as a `pointer` event, never kept nor recorded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| GET    | `/api/assemblies/[assembly]/live-tally`         | visible (room view) | `LiveTallyDto` or null: the secret vote the Mesa is counting, for a projection that opens mid-count.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| POST   | `/api/assemblies/[assembly]/live-tally`         | `session:moderate`  | `LiveTallyBody`. 204. A secret vote the Mesa is counting (`LiveTally`: subject, question, method, `reveal` `live` or `end`, counts only when `live`, present, majority), or null to end it. In session only (null always); from the console holding projection control, ignored otherwise. The question goes only when the subject is an agenda item whose title the public reads. Memory only, never recorded; pushed as a `tally` event. Projecting a vote forgets it; one not sent again for 90 s (`LIVE_TALLY_TTL_MS`) ends, with a null `tally` event. Pushes publish in arrival order: an older one never lands after a newer one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| GET    | `/api/assemblies/[assembly]/session-progress`   | `session:moderate`  | `SessionProgressDto`: documents projected in session and where every item stands by the sheet's rule (`items`: treated, why, awaiting a vote, whether marked, the mark's token).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| GET    | `/api/assemblies/[assembly]/live`               | visible             | SSE stream. On connect it sends `event: ready`. Each `LiveMessage` from `subscribeToAssembly` goes out as `event: change` with a `LiveEventDto`, except to a stream outside the message's audience (`liveMessageReaches`: amendment events about drafts and unpublished amendments). `?channels=` lists the pushes the page follows among `scroll`, `pointer`, `tally` and `state` (comma-separated, possibly empty); without it, the first three. `state` sends, after each `live_changed` and always after that `change`, `event: state` with a `LiveStatePushDto`: the live state loaded once for every stream (`server/utils/live/statePush.ts`; one load in flight per assembly, only the newest delivered, nothing on a failed load) as someone who sees only what is public reads it, with `voteQuestionRedacted` true when a point vote's question was taken out, in which case clients read `GET .../live-state` instead. Clients keep a read only if its `updatedAt` is not older than anything they hold, and a push (which comes in commit order) only if it is not older than their last read, and read the state on a `live` change only when no push followed it (`statePushed` in `useAssemblyLive`). Every 25 s it sends `event: ping` with non-empty data (`liveHeartbeat`, `server/utils/live/sse.ts`), never an SSE comment, which EventSource never exposes: `useAssemblyLive` reads it to find a stream that died in silence. The stream closes when the client disconnects. |

**Projected votes.** Clients do not manage `voteId` after a vote. When the
assembly has a `live_state` row (the session started), the server sets
`live_state.voteId` in the same transaction as every vote it records:

- an amendment outcome vote, which also points the projection at the amendment
  and its document;
- an admission vote, which only replaces the vote;
- a final vote, which also points the projection at the document, with no
  amendment;
- a vote on an agenda item, only when the console asks for it (`project:
true`, the Mesa) and that item is still the one in debate: it replaces
  only the vote (`ItemVoteResultDto.projected` says whether it did). The
  control sheet never projects.

Choosing a new document also selects its agenda item, as with
`PUT .../live-state`. When that vote is voided (the amendment is reopened, the
final vote is annulled, an item vote is voided) and the projection still shows it, the server clears
`voteId`; `PUT .../live-state` refuses a `voteId` of a voided item vote. Each change records `live_changed` (`entityType: "live"`).

**Live state.** `LiveStateDto.speakersVisible` (false before the session
starts) says whether attendees see who has the floor and who is next.
`LiveStateBody.recess` starts a recess (`{ until }`, optional ISO instant) or ends it (null); `LiveStateDto.recess` says since when and until when. `LiveStateBody.amendmentBloc` (user's decision of 2026-11-19) puts on screen a bloc the Mesa proposes to approve together: up to 200 distinct published amendments of one document, which it selects with its agenda item (409 when one is not published, 422 when one is of another assembly or document, or when it comes with a non-null `amendmentId` or `voteId`); null or `[]` takes it off. It takes the amendment and the vote off the screen, and an amendment, a vote (also one the server projects) or another document takes it off; it moves the screen (projection control) and goes on it only in session. `LiveStateDto.amendmentBloc` is empty without one, and the `live_changed` payload carries it. `LiveStateBody.amendmentBlocPurpose` (user's decision of 2026-11-21) sends the bloc as a proposal on admission: `admit` («Se propone admitir a debate») or `inadmit` («Se propone no admitir»); null or left out proposes to approve it. Every amendment must be late, presented, validated, published and still pending admission (409 otherwise, `messageKey` `session.admissionProposal.errors.notPending`); a purpose without a non-empty bloc, or with `amendmentBlocOptions`, is refused (422). It goes and comes with the bloc, never decides anything by itself, and stays on screen after the Mesa decides until something else takes its place. `LiveStateDto.amendmentBlocPurpose` is null for a bloc to approve and without a bloc, and the `live_changed` payload carries it when set. `LiveStateDto.voteDecision` is `{ kind, subjectIds }` of the `decisions` row a decision vote on screen recorded (null for any other vote and without one), so the room names what was decided. `speakingLimitSeconds` is the default limit of a speaking turn (180 by default). A move of the live state from one agenda item to another marks the item left treated in the control sheet (docs: AGENTS.md, sessionProgress).

`PUT .../live-state` with `speakersVisible` changes it; besides
`live_changed` it then records `speakers_visibility_changed`
(`entityType: "speakers"`, `{ visible }`), so clients that follow the
speakers refetch them.

## Agreements record

The acta de acuerdos (user's decisions of 2026-11-21): the record the
platform words from the votes, in the format of the 79.ª AGO's record
(`shared/utils/agreementsRecord.ts`), kept as a published `minutes` text of
the item where it is read and voted (`documents.generated =
'agreements_record'`, one per assembly) and written again a quiet spell
after every change of the assembly (`server/plugins/agreements-record.ts`,
event `agreements_record_updated` on the record when its text changed),
until its own final vote: an approving one adds, once, the agreement that
approves the record (a consolidated version replacing the voted one).
Corrections are kept apart (`agreement_record_texts`), so they survive;
each is an `agreements_record_corrected` event on the record (on the
assembly while there is no record yet).

| Method | Path                                                 | Who               | Notes                                                                                                                            |
| ------ | ---------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/assemblies/[assembly]/agreements-record`       | `document:manage` | `AgreementsRecordDto`: the record as it reads now, its document once created, the lock of each correction.                       |
| POST   | `/api/assemblies/[assembly]/agreements-record`       | `document:manage` | `AgreementsRecordCreateBody`. Creates and publishes it under the item; 409 when the assembly has one.                            |
| PUT    | `/api/assemblies/[assembly]/agreements-record/texts` | `document:manage` | `AgreementRecordTextBody`: one correction (words without the suffix, or left out); null and not omitted take it back. 409 stale. |

Built only from what the public reads (published documents, listed items,
no withheld title). Schemas: `shared/utils/schemas/agreementsRecord.ts`.

**Regenerating and signing it** (user's decisions of 2026-11-23,
`server/utils/domain/agreementsSigning.ts`). Once its own final vote
approved it, the votes no longer change it, but the Secretaría still
corrects it: `AgreementsRecordDto.document.outdated` says the corrections
(or the votes) no longer match its text in force, and «Regenerar» writes it
again as a new consolidated version replacing the one in force (note
«Corrección del acta de acuerdos», event `agreements_record_regenerated`),
which takes its signed PDF away. It is then signed: the platform renders
the PDF to sign (the clean consolidated text, Spanish, justified) with the
visible signature of the Secretaría Ejecutiva above the name, read from the
Intranet at that moment (`GET {base}/firma-secretaria`, docs/intranet.md)
and kept nowhere else; without it the space stays blank. The Secretaría
signs it with AutoFirma from the page (PAdES over SHA-512,
`alwaysCreateRevision`, the client in `public/autofirma`) or downloads it,
signs it elsewhere and uploads it. A signed PDF must carry a signature
dictionary (`/ByteRange`) and be uploaded for the version prepared, which
must still be the one in force. Once published it leads the document
(`DocumentDto.signedFile`, served by `GET /api/uploads/agreements/[filename]`
to whoever sees the document, only while it signs the text in force) and
stands for the generated PDF in the documentation package. One row per
record in `agreement_record_signings`.

| Method | Path                                                            | Who               | Notes                                                                                                                                                   |
| ------ | --------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/assemblies/[assembly]/agreements-record/regenerate`       | `document:manage` | Writes the approved record again from its corrections; drops its signed PDF. 409 before it is approved.                                                 |
| POST   | `/api/assemblies/[assembly]/agreements-record/signing`          | `document:manage` | Renders the PDF to sign (export rate limit); the one prepared before goes. 409 before it is approved.                                                   |
| GET    | `/api/assemblies/[assembly]/agreements-record/signing/prepared` | `document:manage` | The PDF prepared to sign, for the text in force; 404 without one.                                                                                       |
| POST   | `/api/assemblies/[assembly]/agreements-record/signing/signed`   | `document:manage` | Multipart `file` (PDF up to 20 MB with a digital signature, 422 without one) and `updatedAt` of the signing. Publishes it (`agreements_record_signed`). |
| DELETE | `/api/assemblies/[assembly]/agreements-record/signing/signed`   | `document:manage` | Withdraws the signed PDF (`agreements_record_signature_removed`).                                                                                       |

## Headcounts

| Method | Path                                                | Who                | Notes                                                                                                      |
| ------ | --------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------- |
| GET    | `/api/assemblies/[assembly]/headcounts`             | visible            | `HeadcountsDto`: counts newest first (figures only but for the Mesa), `latest` whole, `members`, `quorum`. |
| POST   | `/api/assemblies/[assembly]/headcounts`             | `session:moderate` | `HeadcountBody`. 201 with `HeadcountsDto`.                                                                 |
| PUT    | `/api/assemblies/[assembly]/headcounts/[headcount]` | `session:moderate` | `HeadcountUpdateBody` (with `updatedAt`). Returns `HeadcountsDto`.                                         |
| GET    | `/api/assemblies/[assembly]/headcounts/expected`    | `session:moderate` | `HeadcountExpectedDto`: who registered in the Intranet.                                                    |

`expected` lists the members (`memberIds`, councils and sectorials) and the
guest accounts (`guestIds`) whose Intranet account has somebody registered
for the assembly (`GET {intranet}/asambleas/{type}/{number}/inscritos`,
docs/intranet.md), asked at most once a minute per assembly; `status` says
how the Intranet answered (`ok`, `not_found`, `unavailable`, `failed`,
`unconfigured`). Never with `?view=room`.

The Mesa's counts of the asociados with a vote, with the sectorials and the
guests (accounts with the role `Invitado`, `CAI` or `CdG`: `HEADCOUNT_GUEST_ROLES`) in the room, who never vote nor
count (docs/design.md, "Headcounts and quorum"). Schemas:
`shared/utils/schemas/headcount.ts`.

- **Reading.** Public to everyone who sees the assembly, for transparency:
  the live view and the projection show the latest count, who was in the
  room, the delegations, the quorum and the majorities it gives. `members` are
  those a new count lists, in the order of the roll call (`compareRollCall`:
  the active asociados, then the active sectorials, each in reverse
  alphabetical order of its name and university), with their `university`;
  entries follow that order too, those counted with a vote first, and each
  says whether it had a vote (`voting`). `guests` are the accounts with a
  guest role (`Invitado`, `CAI`, `CdG`) and access (`userId`, `name`; never an email), reverse
  alphabetical by name (`compareGuests`). Only the Mesa (`session:moderate`)
  gets `members` and `guests`; everyone else, empty lists. Each count
  carries its own `guests` (the name each account had then; `userId` null
  once it is deleted), and `attending` counts the sectorials and guests in
  the room. `quorum` is the threshold of the assembly type
  (`quorumRulesOf`, the initial one for a row stored before quorum
  existed).
- **Recording.** `entries` lists the members in the room (`present`) and the
  delegated ones (`delegated` with `delegateId`); absent ones are left out.
  A sectorial is only ever `present`, and `guests` lists the account ids of
  the guests in the room. 422 `{ problems: [{ memberId, problem }] }` when a
  member is listed twice, is not an active asociado nor sectorial, a
  sectorial delegates (`no_vote`), or a delegation names nobody with a vote
  or one that already receives another (`HEADCOUNT_PROBLEMS`); 422
  `{ guests: [ids] }` for a guest listed twice or that is no account with
  a guest role. A delegation to a member not in the room is stored but
  does not count (`delegated` and `present` leave it out). Refused (409) in
  a draft or closed assembly. Records `headcount_recorded`.
- **Correcting.** Optimistic lock on `updatedAt` (409 when stale). The
  members it may list are those a new count lists plus those it listed, each
  as the count had it (`headcount_entries.voting`): a correction never turns
  a sectorial into a vote. Its guests may be the accounts with a guest
  role now and those it listed (a deleted account's entry stays). Its
  `eligible` and `required` stay. Records `headcount_corrected` with
  `changes`.
- **Locks and events.** Every write locks the assembly row first. Events
  have `entityType: "headcount"` and carry the figures only (`eligible`,
  `present`, `required`, `quorum`; older ones also `call`), never who was there (read
  through GET); the activity log shows them to everyone who sees the
  assembly.
- **Votes.** With majorities on `present`, a vote whose body has no
  `present` takes the latest count's, and every vote with counts stores the
  latest count's id in `votes.headcountId`.

## Control sheet

| Method | Path                                                              | Who                  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------ | ----------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/assemblies/[assembly]/control-sheet`                        | visible              | `ControlSheetDto`: all of it with a sheet key (`can.internal`), its public part to everyone else (no notes, turns nor session start; whether each row was treated as plain ids, `treated`; answers only where `canSeePositions`). Never with `?view=room` (403). `documents[].presenting` and `documents[].awaitingAnswer` are the reader's own: whether it presents the document, and how many of its amendments wait for the presenters' answer (presented, unanswered, nothing holding the answer back). |
| GET    | `/api/assemblies/[assembly]/control-sheet/notes`                  | visible              | `ControlSheetNotesDto`: the account's own general private notes (no anchor) on the published documents it sees and the amendments past draft it may read, oldest first, plus how many anchored notes each document has. Keyed by the account, never part of `ControlSheetDto`. Never with `?view=room` (403).                                                                                                                                                                                               |
| PATCH  | `/api/assemblies/[assembly]/control-sheet/items/[item]`           | see below            | `ControlSheetItemBody`. Returns `ControlSheetItemRowDto`.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| PATCH  | `/api/assemblies/[assembly]/control-sheet/amendments/[amendment]` | see below            | `ControlSheetAmendmentBody`. Returns `ControlSheetAmendmentRowDto`.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| GET    | `/api/assemblies/[assembly]/control-sheet/history?row=`           | `control_sheet:view` | `ControlSheetHistoryDto`: one sheet row's changes, newest first.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GET    | `/api/assemblies/[assembly]/control-sheet/activity`               | `control_sheet:view` | `ActivityPageDto`: the sheet's «Historial» (below).                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| GET    | `/api/assemblies/[assembly]/control-sheet/activity/people`        | `control_sheet:view` | `UserRef[]`: whoever recorded a row of the «Historial».                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| GET    | `/api/assemblies/[assembly]/control-sheet/documents/[document]`   | `control_sheet:view` | `ControlSheetDocumentObservationsDto`: see below.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| POST   | `/api/assemblies/[assembly]/agenda/[item]/votes`                  | see below            | `ItemVoteBody`. Returns `ItemVoteResultDto`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| GET    | `/api/assemblies/[assembly]/item-votes`                           | see below            | `ItemVotesDto`. Never with `?view=room`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| DELETE | `/api/assemblies/[assembly]/votes/[vote]`                         | see below            | `VoteVoidBody`. Voids an item vote. Returns `VoteDto`.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| PATCH  | `/api/assemblies/[assembly]/votes/[vote]/unanimity`               | see below            | `VoteUnanimityBody`. Returns `VoteDto`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

`control_sheet:edit` also reads. Schemas: `shared/utils/schemas/controlSheet.ts`, and `shared/utils/schemas/vote.ts` for votes.

`ControlSheetAmendmentBody.observationsAppend` (never with `observations`)
adds a text below the amendment's observations, a blank line apart,
whatever they are now: it replaces nothing, so it takes no lock token, and
it records `control_sheet_observations_updated` and a revision like any
other save. 422 (`data.reason` `control_sheet_observations_too_long`) when
the result would pass 5000 characters. The amendment's notes send it for
an account that edits the sheet.

`GET .../control-sheet/documents/[document]` gives a sheet reader what the
sheet says about one document it sees, for the document's page: the
observations of its agenda item (when the reader gets that item) and of
each of its amendments the reader sees, only rows with something written,
the amendments in their order with their code, each with who wrote last
and when. Never with `?view=room`.

`ControlSheetDto.positions` gives every sheet reader the main presenter's
answer (`PositionDto`) to each amendment it sees that has one, as soon as it
is given, public or not yet. Only the sheet does:
`AmendmentDto.position` and every other reader keep `canSeePositions`.

**«Historial».** `GET .../control-sheet/activity` lists what changed in
the sheet or about it, by anyone, newest first and paged like "Mi
actividad" (`cursor`, `limit` up to 100): the sheet's notes, the main
presenters' answers (`position_changed`) and the votes and decisions that
settle items, documents and amendments (`CONTROL_SHEET_ACTIVITY_GROUPS`,
`controlSheetActivityQuerySchema`). Filters: `group` (`sheet`, `answers`,
`votes`, comma-separated), `subject` (`item:<id>` with its documents and
their amendments, `document:<id>` with its amendments, or
`amendment:<id>`), `actor` (a user id, from `.../activity/people`), and
`from`/`to`. Each row is judged again for the reader as in "Mi actividad"
(`toMeActivityItem`): what it may not read is left out, except the
answers, which every sheet reader reads, as `ControlSheetDto.positions`.
Never with `?view=room`.

**Votes on an agenda item.** An item is voted either once per voted
document (their final votes, above) or by itself: a ratification, an
election, an item without documents. Then the vote is on the item (subject
`agenda_item`), and `ItemVoteBody.question` says what was voted (up to 500
characters, public with the vote: the live state carries it).

- **Who.** Recording and voiding: the Mesa (`session:moderate`) or
  `control_sheet:edit`. Only the Mesa projects (`project: true`, from the
  console). Unanimity: the Mesa on any assent vote in force (an item vote,
  or a document's final vote by assent still pointed at), and
  `control_sheet:edit` on item votes. Reading (`GET .../item-votes`): the
  Mesa or a control sheet key.
- **When.** Recording is refused on a draft or closed assembly; voiding and
  unanimity on a closed one (409).
- **Rule.** Refused (422 `data.reason: "item_has_voted_documents"`) while a
  document of the item is voted, presented and neither withdrawn nor
  postponed (`itemHasVotedDocuments`): its documents' final votes are the
  item's votes. Refused too (422 `item_is_container`) on an item where
  members present: each document is voted in its own sub-item
  (`itemTakesOwnVote` holds both). A caller who neither moderates nor
  manages documents and sees none of the item's voted documents (all of them
  unpublished) gets a neutral 422 `item_takes_no_vote` instead, so nothing
  tells it such a document exists. The item must be one the caller gets (404 otherwise).
- **Question.** `GET .../item-votes` and `ControlSheetDto.itemVotes` send
  `question: null` on the votes of an item the reader gets without its
  title. The clients prefill a title only when the public reads it
  (`AgendaItemDto.publicTitleHidden`). The
  majority is simple unless the body says otherwise; the latest headcount
  fills `present` as for every vote. `VoteInput.unanimous` is taken only
  for an assent. Several votes on one item are allowed: the latest one not
  voided gives its result (`latestItemVote`).
- **Election.** `ItemVoteBody.election` (`ElectionInput`) records candidates
  and their votes instead of in favour and against (never by assent nor
  registered; 422 when the counts exceed the ballots or the members
  present). The server works out who is elected or goes to a second round
  (`computeElectionOutcome`) and returns it in `VoteDto.election`; the vote
  is approved when every post is filled. A second round is a new vote on
  the item.
- **Voiding.** `DELETE .../votes/[vote]` sets `voidedAt` on an item vote
  (409 for any other vote, which goes through reopening or annulling what it
  decided, and for one already voided); it stays for the record. A stale
  `updatedAt` answers 409.
- **Which votes are in force.** An amendment, document or admission vote
  only while `amendments.outcomeVoteId`, `documents.finalVoteId` or
  `decisions.voteId` points at it; an item vote while `voidedAt` is null.
- **Records.** `vote_recorded`, `vote_voided` and `vote_unanimity_changed`,
  of entity `vote`, with `subjectType`, `subjectId` and, for an item, the
  document whose title it carries (`titleDocumentPayload`), never as the
  event's `documentId`. The activity shows an item vote to whoever gets the
  item, worded as the item reads to them. Deleting an item whose subtree
  holds item votes answers 409 `agenda_item_sheet`; an automatic sub-item
  holding them is kept, and they follow its document to its new sub-item.

- **Reading.** `ControlSheetDto` adds to the agenda (`GET .../agenda`) what
  it lacks, as the reader may see it: each visible document's final vote and
  how many of its amendments past draft the reader sees (and how many are
  undecided), the turns that took the floor on items the reader gets, and
  what the sheet noted about those items and amendments, and the votes on
  those items (`itemVotes`, voided ones too). `sessionStartedAt`
  is the first time the assembly went into session (null without a sheet
  key). `treated` goes to every reader (user's decision of 2026-11-19):
  `itemIds`, the items it gets the Mesa marked or noted «Retirado» or
  «Decaído», never one still waiting for a vote; `amendmentIds`, the
  amendments it sees marked or settled in session. Plain ids: never who,
  when nor the result by hand. `awaitingItemIds`, only with a sheet key
  (null otherwise), lists the items it gets that still wait for a vote,
  over every non-draft document (those it cannot see included), the set
  the 422 `control_sheet_awaiting_vote` guard reads.
- **Writing.** Observations and `listed` need
  `control_sheet:edit`; the result by hand and the
  treated mark `session:moderate`; a «Retirado» by hand only on an item
  without documents (422 `control_sheet_withdrawn_document`). The mark, a
  «Retirado» or a «Decaído» on an item still waiting for a vote answers 422
  `control_sheet_awaiting_vote`; the mark on an amendment still to be
  decided, 422 `control_sheet_amendment_undecided`; taking a mark away is
  always allowed. An item body that changes only `treated` needs
  `session:moderate` alone, with or without a sheet key (the session
  console); without one, the row answered (and a 409's `data.row`) keeps
  only its tokens and whether it is marked. Any other needs a sheet key.
  Every field
  travels with the lock token
  it was read with (`updatedAt`, null when never set); a stale one answers
  409 with `data.reason` `control_sheet_stale`, `data.fields` and the row as
  it is (`data.row`), and nothing is written. An item or amendment the
  reader does not get answers 404, as do drafts. Observations are trimmed
  and up to 5,000 characters.
- **Records.** Each field changed records an event of entity
  `control_sheet` (entityId: the sheet row) with `subjectType` and
  `subjectId`: `control_sheet_observations_updated` (`revisionId`,
  `cleared`; the text stays in `control_sheet_observation_revisions`),
  `control_sheet_result_changed` (`changes`), `control_sheet_treated_changed` and
  `control_sheet_listed_changed`. The activity shows them to the sheet's
  readers only, for items and amendments they read.

## Seating

The room of an assembly and who sits where (`docs/seating-plan.md`). Every
path is under `/api/assemblies/[assembly]/seating`. An AGET has no room:
every path answers 404 with `data.reason` `seating_not_found`.

| Method | Path                        | Who            | Notes                                                             |
| ------ | --------------------------- | -------------- | ----------------------------------------------------------------- |
| GET    | `…/seating`                 | `seating:view` | `SeatingPlanDto`. Never with `?view=room` (403). Creates nothing. |
| PUT    | `…/seating/layout`          | `seating:edit` | `SeatingLayoutBody`. Returns `SeatingLayoutResultDto`.            |
| POST   | `…/seating/assignments`     | `seating:edit` | `SeatingAssignmentsBody`. Returns `SeatingAssignmentsResultDto`.  |
| POST   | `…/seating/sync`            | `seating:edit` | No body. Returns `SeatingSyncResultDto`, always 200.              |
| PUT    | `…/seating/source`          | `seating:edit` | `SeatingSourceBody`. Returns `SeatingSourceResultDto`.            |
| POST   | `…/seating/groups`          | `seating:edit` | `SeatingGroupCreateBody`. Returns `SeatingGroupDto`.              |
| PATCH  | `…/seating/groups/[group]`  | `seating:edit` | `SeatingGroupUpdateBody`. Returns `SeatingGroupDto`.              |
| DELETE | `…/seating/groups/[group]`  | `seating:edit` | Returns `SeatingDeleteResultDto`.                                 |
| POST   | `…/seating/people`          | `seating:edit` | `SeatingPersonCreateBody`. Returns `SeatingPersonDto`.            |
| PATCH  | `…/seating/people/[person]` | `seating:edit` | `SeatingPersonUpdateBody`. Returns `SeatingPersonResultDto`.      |
| DELETE | `…/seating/people/[person]` | `seating:edit` | Returns `SeatingDeleteResultDto`.                                 |
| GET    | `…/seating/images/[file]`   | `seating:view` | A cached WebP. Never with `?view=room` (403).                     |

`seating:edit` also reads. Schemas: `shared/utils/schemas/seating.ts`;
types: the «Seating» section of `shared/types/api.ts`.

- **Reading.** An assembly without a plan answers an empty one (`planId`,
  `layout` and `layoutUpdatedAt` null, no groups). Names, surnames, labels
  and photo URLs of the people are personal data and go only to seating
  readers, never to a log: the handlers log a failed query only by its
  summary (`throwMutationError`: name, SQLSTATE, constraint, stack frames).
  A group's `member` goes
  through `redactMember`; `imageUrl` and `photoUrl` are null without a
  cached file of the row's current version or for what the Intranet no
  longer lists (`goneAt`). `can.edit` is `seating:edit`. Texts drop control
  characters.
- **The plan.** The first write or sync makes it, with the Mesa's group
  (`kind` mesa) and its usual people for the type: at an AGO two
  placeholders, «Presidencia de la Mesa» and «Vocalía de la Mesa». The
  Mesa's group is never deleted and never changes kind.
- **Layout.** `updatedAt` is `layoutUpdatedAt` as read, null only while
  there is no layout; anything else answers 409 `seating_stale` with
  `SeatingLayoutStaleData`. Seats the new layout removes or disables that
  someone sits on answer 409 `seating_seats_occupied` with
  `SeatingSeatsOccupiedData` (the seats and their people), unless
  `releaseSeats` lists every one of them, seat and person, as that 409
  named them: those people then lose their seat in the same write
  (`released`). Anyone seated there since was not confirmed and answers
  the same 409 again, with the new list. Records `seating_layout_updated`.
- **Assignments.** Up to 600 ops, each seat once and each `next` person
  once; all or none. Each seat must hold `expected` (null for empty); a
  `next` person who sits on a seat the batch does not name, a seat the
  layout lacks or disables, a person no longer in the plan or marked «No
  necesita asiento», or another batch filling the same seat at the same
  time, answer 409 `seating_stale` with `SeatingAssignmentsStaleData`
  (`seats` with who sits there now, `unavailableSeatIds`,
  `unknownPersonIds`). Emptying a seat is always allowed. A move empties
  the old seat in the same batch (`assignmentOps`). The batch deletes only
  the rows it saw (never a seat it saw empty), so a seat filled meanwhile
  makes it fail rather than throw the other batch's person out.
  Records one `seating_assignments_changed` (placed, moved and removed
  counts, member ids) when anything changed.
- **Sync.** Within a minute of the last call to the Intranet, whatever it
  answered, `called` is false and nothing is asked. Otherwise it reads
  `GET {NUXT_INTRANET_API_URL}/asambleas/{type}/{number}/asistentes` for the
  assembly, or for `sourceAssemblyId`. `plan.sync.status`: `ok` (groups and
  people synced, `counts`), `not_found` (no Intranet event with that type
  and number: offer another assembly's attendees), `unavailable` (the
  Intranet does not have the route yet: groups made by hand only; the
  page's line says nothing, and only a sync pressed by hand says it, in a
  toast), `failed` (try again later), `unconfigured`. Its own rate limiter
  bucket (60 per 5 minutes per IP): a change of source starts the minute
  again. Only `ok` writes
  groups and people; groups made by hand, people added by hand and
  placeholders, `needsSeat`, `label`, `position` and every assignment are
  never touched; what the Intranet stops listing gets `goneAt` and keeps
  its seat. Records `seating_synced` (status and counts) only when the
  status or a row changed.
- **Source.** `expected` is the source as read (null is a value), compared
  with the plan row once locked (made if missing, never for its own
  attendees while there is none); another answers 409 `seating_stale` with
  `SeatingSourceStaleData`. The assembly
  itself is refused (422), and so is one the editor cannot see. A change
  clears the last sync, so the next one calls at once. Records
  `seating_source_changed`.
- **Groups and people.** PATCH takes `updatedAt` (409 `seating_stale` with
  `SeatingGroupStaleData` or `SeatingPersonStaleData`). Only groups made by
  hand change or go (422 for an Intranet account or the Mesa); a group's
  `memberId` must be a real member (422 `executive_member` for the generic
  «CEA»). Intranet people take only `needsSeat`, `label` and `position`
  (422 otherwise) and are never deleted (mark them «No necesita asiento»);
  a placeholder given a `firstName` becomes a person added by hand.
  `userId` links only a person of the Mesa, and only to the editor's own
  account (422 otherwise); null unlinks it.
  `needsSeat` false frees the person's seat in the same write
  (`released`). A group or person not in the plan answers 404
  `seating_not_found`. Deleting frees their seats (`released`).
- **Images.** `[file]` is `logo-<group>-<version>.webp` or
  `photo-<person>-<version>.webp` that a row of this assembly's plan names
  now, with that version (404 otherwise), served with `Cache-Control: private,
max-age=31536000, immutable`, `nosniff` and `Content-Disposition: inline`.
  Its own rate limiter bucket (10,000 per 5 minutes per IP).
- **Records and live.** Every write records an event of entity `seating`
  (entityId: the plan): `seating_synced`, `seating_layout_updated`,
  `seating_assignments_changed`, `seating_group_created`, `_updated` and
  `_deleted`, `seating_person_created`, `_updated` and `_deleted`,
  `seating_source_changed`, with ids, kinds, counts and the names of the
  fields changed, never a name. A new cached image sends a live
  `seating_images_ready` with no history row. The hub ignores the entity
  (`IGNORED_LIVE_ENTITIES`); the activity shows these events to seating
  readers only.

## Speaking turns

| Method | Path                                         | Who                | Notes                                                    |
| ------ | -------------------------------------------- | ------------------ | -------------------------------------------------------- |
| GET    | `/api/assemblies/[assembly]/speakers`        | visible            | `SpeakersDto`. What each actor gets is described below.  |
| POST   | `/api/assemblies/[assembly]/speakers`        | `session:moderate` | `SpeakingTurnBody`. Adds a turn. 201 with `SpeakersDto`. |
| PUT    | `/api/assemblies/[assembly]/speakers/[turn]` | `session:moderate` | `SpeakingTurnUpdateBody`. Returns `SpeakersDto`.         |

| Method | Path                                               | Who                                             | Notes                                          |
| ------ | -------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------- |
| GET    | `/api/assemblies/[assembly]/speakers/notes`        | `session:moderate` or `session:record_speakers` | `SpeakerNotesDto`: every turn that spoke.      |
| POST   | `/api/assemblies/[assembly]/speakers/notes`        | `session:moderate` or `session:record_speakers` | `SpeakerNoteBody`. 201 with `SpeakerNotesDto`. |
| DELETE | `/api/assemblies/[assembly]/speakers/notes/[turn]` | `session:moderate` or `session:record_speakers` | Takes a note back. Returns `SpeakerNotesDto`.  |

The Mesa writes down who asks to speak, gives and ends the floor and orders
the queue (`speaking_turns`). Schemas: `shared/utils/schemas/speakers.ts`.

- **Undoing the end of a turn.** A PUT with `status: "speaking"` on a
  `done` turn takes the floor back (user's decision of 2026-11-21; the
  console's «Deshacer» in the notice that says it ended): only for a turn
  given from the queue (never a note), within 10 minutes of its end
  (`TURN_RESUME_WINDOW_MS`) and while nobody else has the floor
  (`resumableTurn`), else 409 with the reason. Its clock goes on from where
  it stopped (`startedAt` moved on by the time off the floor, `endedAt`
  cleared); event `speaking_turn_resumed`.

- **Who spoke.** Giving the floor stamps the turn with the item and the
  amendment in debate then (`amendmentId`). Whoever notes the speakers
  (`canNoteSpeakers`) notes who spoke on an item or an amendment of it, from
  the live view and the control sheet: a `noted` turn, `done`, out of the
  queue. Noting a member (or, without one, a name) already there, given the
  floor or noted, changes nothing; only notes are taken back (`cancelled`,
  409 for a turn given from the queue). 422 for an item or an amendment of
  another assembly, or an amendment the actor may not read; 409 while the
  assembly is a draft or closed. `GET` leaves out turns on amendments the
  actor may not read. Notes never reach the `turns` of `GET .../speakers`,
  `history`, the sheet's «Turnos de palabra» nor the
  statistics; the sheet's
  «Intervinientes» names everyone once. Events `speaking_turn_noted` and
  `speaking_turn_unnoted` (ids only).

- **Reading.** The Mesa (`session:moderate`) gets the turns that are
  `speaking` or `waiting` and every turn of the agenda item in debate
  (`live_state.agendaItemId`; with none, the turns without an item).
  Anyone else gets the `speaking` and `waiting` turns only while
  `live_state.speakersVisible` is true, and `turns: []` otherwise. `visible`
  is always the current flag. Order: who has the floor, then the queue by
  `position`, then the finished and cancelled turns in the order they
  happened. The Mesa also gets `history` (`SpeakerHistoryDto[]`,
  `speakerHistory` in `server/utils/domain/speakersRules.ts`): for each
  member with a turn in the assembly, how many it spoke in (`speaking` or
  `done`) and up to 10 names written down for it, the latest first. The
  form puts those who spoke most first and suggests those names; it offers
  the councils and sectorials of the latest headcount, in the room or
  delegated (whoever holds the delegation may speak for them), and the other
  members always.
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
  their `updatedAt`, so «Siguiente» also sends what the console saw:
  `expectHead` (the turn must still be the first waiting) and
  `expectedSpeakingId` (the turn it saw speaking, null for nobody); 409 when
  either changed (`turnUpdateExpectationsHold`), and the console reloads the
  list. The answer always includes the turn it changed, even
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

## Room view

The projection is opened on a Mesa account but read by the room, so every
read it makes adds `?view=room` (`ROOM_VIEW_QUERY`). These GETs take it:
`/api/assemblies/[assembly]`, `.../live-state`, `.../agenda`,
`.../speakers`, `.../headcounts`, `.../documents/[document]` and
`.../documents/[document]/amendments`. Each calls `requireViewer`
(`server/utils/domain/roomView.ts`): the flag is honoured only for
`session:moderate` (403 otherwise) and only on GET (400 otherwise), and the
answer is what an account that sees only what is public reads (offices as
the generic "CEA", no person speaking for one, nothing unpublished). A draft
assembly answers 404; a document put in debate while not public answers 404
and the projection shows its agenda item instead. `.../agenda?view=room`
also includes the item on screen, still unlisted, with its title only when
the Mesa account reads it.

## Exports

Existing endpoints, now based on structured content:

- `POST /api/assemblies/[assembly]/export` (`assembly:manage`, checked again
  by the worker): body `{ locale, justified }`. Enqueues the assembly dossier (cover,
  agenda and every published document) and returns `{ jobId }`. No screen
  offers it.
- `GET /api/exports/[jobId]/status`
- `GET /api/exports/[jobId]/download`

pdfmake lays out and renders each PDF in a separate Node process
(`server/utils/export/pdfRender.ts`), one at a time, so the app keeps
answering while a PDF is made.

The PDF builder renders blocks:

- headings, lists and emphasis are kept;
- the annotated variant marks every amended fragment with its amendment code
  and ends with an annex of the amendments and their outcomes. Like the clean
  PDF, it names presenters and authors as the requester reads them (the
  real executive offices for the Secretaría and the Mesa, the generic
  "CEA" for a delegate). Its text, codes and annex carry only published
  amendments, whoever requests it (`publicExportActor` decides which), so
  an amendment presented but never published never reaches the file;
- "Presentado por" names the main presenter, then the co-presenters;
- labels come from the locale files.

Every PDF follows the reader's text alignment (user's decision of
2026-11-23; «Alineación del texto» in the preferences, justified by
default): the export bodies and the package's carry `justified` (true when
absent), and paragraphs, list items and quotes without an alignment of
their own are justified; never a table's cells. Justifying spreads the
spaces of lines already broken, so it never moves a page: the page maps of
the web text hold for both (`pdfPages.test.ts`).

A consolidated text approved pending conciliation (user's decisions of
2026-11-21) prints «Aprobado pendiente de conciliar las enmiendas E3 y E5; …»
under the vote line and opens each pending passage with «[Pendiente de
conciliar E3 y E5]» (clean PDF, assembly PDF, package PDF and Word copy); the
annotated PDF's annex keeps those passages «Redacción pendiente de conciliar,
junto con …».

### Documentation package

"Descargar documentación" (the agenda block of the overview, the agenda's
"Más" and the documents page): a ZIP of everything the assembly has published, for any
account that sees the assembly (not a draft: 404
`assembly.package.notPublic`). `locale` (`es`, `en`), `editable` (the
Word version of every text) and `justified` (the PDFs' text, true when
absent; only justified packages are built ahead, the others when asked)
choose the package, in the body of the POST and
the query of the GETs (`AssemblyPackageStatusDto`, `assemblyPackageSchema`).
The POST's `selection` (`packageSelectionSchema`) asks for a part of it
instead, see "Parts" below; the GETs then name it by `filter`.

| Method | Path                                          | Who     | Notes                                                                                                                      |
| ------ | --------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/assemblies/[assembly]/package`          | visible | Queues a build unless the current one is there or one waits. Records `export.request` `{ package, locale, editable }`.     |
| GET    | `/api/assemblies/[assembly]/package/status`   | visible | `ready`, `building` (with `progress`), `failed` or `idle`, and `file`, the ZIP that can be downloaded now.                 |
| GET    | `/api/assemblies/[assembly]/package/download` | visible | Streams `file` (`application/zip`). 409 `assembly.package.notReady` without one. Records `export.download` (same payload). |
| GET    | `/api/assemblies/[assembly]/package/options`  | visible | `PackageOptionsDto`: what the filters of a part offer, as the public reads it.                                             |

**What it holds.** One package for everyone, built as a reader who sees only
what is public (`publicExportActor`, `server/utils/export/package/load.ts`):
the executive offices read as "CEA", and nothing unpublished goes in.

- `00 Convocatoria.pdf`: the signed convocatoria as uploaded, otherwise the
  one generated from the assembly (`buildConvocationPdf`, the wording of
  `ConvocationSheet`).
- `00 Orden del día.pdf`: the numbered items (`buildAgendaPdf`).
- A folder per numbered item that holds something, nested as the agenda and
  named by its number (`03.10 …`, so it sorts) and title. Inside, each
  published document: an uploaded PDF as it is; a text as presented (no
  approval line) and, once voted, its consolidated text with the approval
  line (`(texto consolidado)`), as PDF and, with `editable`, as Word
  (`buildDocumentDocx`); and its published amendments, one PDF each on
  CREUP's amendment template (`buildAmendmentPdf`) in `Enmiendas/`.
  Postponed documents are listed in the convocatoria, not included.

The amendment template lists the document, where it changes ("título,
sección o líneas": the headings above each change, `amendmentLocations`),
the typology (supresión, adición or both, `amendmentTypology` over
`changeKinds`), who presents it (main author first), the amendments a
transactional groups and, once settled, its outcome; then the change over
the published text as the platform marks it (`previewAmendment`, added
text underlined, removed text struck through) and its explanation.

**How it is built.** `server/utils/export/package/`: `planPackage` (pure)
gives every path a piece and every piece a key, a hash of all it shows and
`PACKAGE_RENDERER_VERSION`; the plan's fingerprint changes when any path or
key does. A build (pg-boss queue `assembly-package`, policy `stately`, one
per assembly, language and variant running and one waiting) renders only
the pieces not on disk, one after another (a document's amendments in
batches of 20 in one render process, `renderPdfBatch`), and writes the ZIP
stored, not compressed, and streamed (`writeZip`). Everything lives under
`EXPORT_STORAGE_DIR/packages/<assemblyId>/` and is swept after each build
(`sweepPackageDir`); it can always be built again, so it needs no backup.
A committed change of a convened or sitting assembly builds its Spanish
packages two minutes after the last one (`server/plugins/assembly-packages.ts`).

**Older packages.** While the current package builds, `file` may be the
last one built, only if everything in it is still public as it was: the same
documents with the same texts and PDFs, the same amendments, the same
signed convocatoria (`packageStillPublic`). Otherwise nothing is offered
until the build ends.

**Parts** (user's decision of 2026-11-20). The dialog's filters take a part
of the package: some documents (`documentIds`, all of them when null),
with or without their texts (`texts`), and all, none or some of their
amendments (`amendments`: `all`, `none`, `authors` with `memberIds`, the
public ids of who signs them, an office as the generic "CEA", or `selected`
with `amendmentIds`, the control sheet's list). A selection that takes
everything is the whole package. A part is never planned nor built on its
own: `filterPackagePlan` (`server/utils/export/package/filter.ts`) keeps
the whole plan's entries it takes, with the same paths and keys, so it
renders nothing of its own and unzips into the whole package's folders. It
holds no convocatoria nor agenda. It is not kept either: the download zips
its pieces as it streams (`packageZipStream`, no `Content-Length`), named
after what it takes (`packageDownloadName`: "… - Punto 4", "… - Enmiendas
de UGR, UCO", plain hyphens). Its status is `ready` once every rendered
piece is on disk (`file.bytes` is then about its size), `empty` when it
takes nothing, and otherwise follows the whole package's build, which the
POST queues. The POST keeps the normalised filter in memory for 12 hours
under a 16-character key (`part.key`, with how many documents and
amendments it holds and how many of the `amendmentIds` are not public,
`dropped`); a key forgotten (a restart) answers 404
`assembly.package.selectionExpired`, and the client asks again. The audit
rows say how much was chosen (`part`), never the ids. The options
(`packageOptions`) come from the package's own source, kept in memory with
its plan: the documents under the agenda item that gathers them (an
automatic sub-item counts as its parent, `packageDocumentGroups`), their
amendments with who signs them, and those who sign, with a council's
university.

**Pages of the texts.** (user's decisions of 2026-11-21) Every Spanish PDF
of a text the package renders (`documentPdf`) is rendered with its blocks
tagged (`buildDocumentPdf`'s `pageTags`, `content.ts`'s `pageTag` and a
`pgtag-` pdfmake id) and with `renderPdfBatch`'s `pages`: the render process
reads back on which pages each tagged node was laid out and the parent
stores where each printed page starts (`document_page_maps`,
`server/utils/export/pageMap.ts`, `documentPages.ts`). The PDF does not
change: the render process drops the `pgtag-` ids as named destinations
(`pdfPages.test.ts` compares the bytes). A text the package has not
rendered (assemblies not prebuilt, pieces cached before the maps existed) is
rendered for its pages alone by the `document-pages` job, which
`GET .../pages` queues (policy `stately`, `singletonKey` per version and
key, not retried; the process does not queue the same key again for 10
minutes). It lays out the same definition (`package/documentPdf.ts`,
`cleanDocumentDefinition`).

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
