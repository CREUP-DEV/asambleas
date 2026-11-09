# CREUP Assemblies - Agent Instructions

These instructions are the source of truth for agents editing this repository. The domain model and the API live in [`docs/design.md`](docs/design.md), [`docs/api.md`](docs/api.md) and [`shared/types/api.ts`](shared/types/api.ts); [`docs/proceso-asambleas.md`](docs/proceso-asambleas.md) records how CREUP assemblies work today.

## Non-Negotiable Rules

- Follow these instructions before local preference or generic framework advice.
- Write code, identifiers and code comments in English.
- Put every user-visible UI string behind i18n keys in Spanish and English.
- Do not translate document or amendment content; users write that content directly.
- Keep Google authentication mandatory before any app access.
- Do not introduce Redis or Mailpit. Use PostgreSQL, pg-boss or in-memory cache as described here.
- Validate all untrusted input with Zod v4 from `zod/v4`.
- Protect every mutation with CSRF and same-origin checks.
- Store document content as structured blocks validated with `blocksSchema`; never store or echo raw HTML. Render it only through `shared/utils/content/render.ts`, which escapes everything.
- Store amendments as operations anchored to the document's frozen base version. Never store modified copies of the text.
- Use optimistic locking on shared PUT/PATCH mutations.
- Run the verification checklist before finishing code changes.

## Project Overview

Internal platform for CREUP assembly management:

- assemblies and lifecycle state;
- recursive agenda items;
- platform documents and uploaded PDFs;
- amendments, transactional amendments and incorporation history;
- role synchronization from the CREUP intranet;
- async PDF exports with accessibility preferences.

The public website lives in a separate `creup/web` repository. This app may mirror visual identity and selected helpers, but it has its own database, auth scope and deployment model.

## Stack

| Area          | Technology                                                                               |
| ------------- | ---------------------------------------------------------------------------------------- |
| Framework     | Nuxt 4 + Nitro                                                                           |
| UI            | Nuxt UI v4 + Tailwind CSS v4                                                             |
| Auth          | `better-auth` + Google OAuth + Drizzle adapter                                           |
| Database      | PostgreSQL + Drizzle ORM                                                                 |
| Jobs          | `pg-boss` v12 on PostgreSQL                                                              |
| Validation    | Zod v4 (`zod/v4`)                                                                        |
| i18n          | `@nuxtjs/i18n`, locales `es` default and `en`                                            |
| Accessibility | `@nuxt/a11y`, content font preferences                                                   |
| Security      | `nuxt-security`, CSRF double-submit cookie                                               |
| Analytics     | `nuxt-umami`, self-hosted and cookie-free                                                |
| Diffs         | `diff-match-patch`                                                                       |
| PDF           | `pdfmake`, Raleway bundled in `server/assets/fonts`, letterhead in `server/assets/brand` |
| IDs           | `@paralleldrive/cuid2`                                                                   |

## Local Defaults

- App: `http://localhost:3000`
- PostgreSQL: `localhost:5432`
- Adminer: `http://localhost:8080`
- Intranet API base: `NUXT_INTRANET_API_URL` (role sync falls back to `${base}/user/role`; members from `/usuarios/asociados` and `/usuarios/sectoriales`). In production only `https:`, or `http:` to a host with no dot such as `http://intranet`; anything else counts as unset (`isIntranetUrlAllowed`)
- Intranet API token: `NUXT_INTRANET_API_TOKEN`, sent as `Authorization: Bearer <token>` on every intranet call when set; never log it. Without it nobody ever loses access
- Role sync env var: `NUXT_ROLE_API_URL`, an optional override of `${base}/user/role`; normally unset. On another origin than the base it never receives the token (`isRoleLookupAuthenticated`)
- The development server uses the production Intranet (`https://intranet.creup.es/api/asambleas/v1`, token in the local `.env` only): sign-in role sync, "Sincronizar", the daily roster sync and the daily access re-check read real data and write it to the local database. In production, the same public URL or `http://intranet/api/asambleas/v1` over the Intranet's Docker network (`DEPLOYMENT.md`).
- Daily roster sync: `NUXT_INTRANET_ROSTER_SYNC` (only `false` turns it off; needs `NUXT_INTRANET_API_URL`). The daily access re-check does not depend on it
- Export storage env var: `EXPORT_STORAGE_DIR`

## Repository Map

```text
app/
  components/       UI components grouped by domain
  composables/      Auth, permissions, locale, accessibility and workflow helpers
  layouts/          the authenticated dashboard shell
  middleware/       global auth redirect
  pages/            Nuxt pages
  utils/            client-side domain utilities
server/
  api/              Nitro endpoints
  db/               Drizzle client and schema
  handlers/         global auth/CSRF middleware
  plugins/          export worker, daily intranet jobs and live updates hub
  utils/            auth, RBAC, domain (actor, visibility, events, resolvers), live, export and CRUD helpers
shared/
  constants/        roles, permissions, domain enums and security constants
  types/            content (blocks, amendment operations) and the API contract
  utils/            amendment engine (content/), schemas, calendar, votes, slug and config helpers
docs/               design, API and research on how assemblies run
i18n/locales/       es.json and en.json
drizzle/            migrations and seed
server/assets/      server-bundled fonts/assets
```

## Language, i18n And Accessibility

- UI text must use `t('key.path')` or another existing i18n-aware API.
- Add keys to both `i18n/locales/es.json` and `i18n/locales/en.json`.
- Run `pnpm i18n:check` and `pnpm i18n:audit-identical` after adding text.
- Admin pages, toasts, aria labels, button labels, validation copy, badges and error states count as UI.
- Visible text should not use long dashes or legacy assembly labels such as `Nº 80`; use shared formatters such as `80.ª AGO`.
- Content accessibility preferences apply only to document/amendment content, not UI chrome:
  - Raleway;
  - Atkinson Hyperlegible;
  - OpenDyslexic.
- Never put body text in a status colour (`success`, `info`, `warning`, `error`) on a tint of that colour: yellow text in a yellow box does not read, and the others are hard work too. Status boxes keep their text neutral (`text-default`, `text-highlighted`) and use the colour only on the icon, the border or the ring. `UAlert` does this for every status colour through `app/app.config.ts`, so never pass `:ui` classes that colour its title or description again; hand-built boxes (`bg-<colour>/5`, `bg-<colour>/10`) follow the same rule. Only a large result heading (an outcome, a count) may keep its colour. Light mode uses the 700 step for `--ui-success`, `--ui-info`, `--ui-warning` and `--ui-error` (`main.css`) so standalone status words and white text on a solid status background pass WCAG AA; status badges and buttons on a tint go one step darker (`app.config.ts`).
- Diff UI must support color mode and marks mode. Render diffs, provenance and plain text through the shared engine (`shared/utils/content/render.ts`) and `app/components/content/*`, never with component-level diff logic.

## Authentication And Role Sync

- First interaction is Google authentication.
- Unauthenticated users go to `/login`.
- All authenticated Google users may sign in (there is no allowlist), except an account deleted in the Intranet. That is an authenticated lookup (token set) answering 404 with exactly `{"error":"not_found"}` for an account the Intranet knew before (`externalRole` or `intranetId` set). It revokes access in one transaction: `accessRevokedAt` and `accessRevokedReason` (`intranet_deleted`) together, role `Invitado`, member cleared, every session deleted, open impersonations of it closed (`revoked`), `user.access_revoked`, and the sign-in refused (the login page of the user's language with `?error=access_revoked`, sent as `errorCallbackURL`). Exceptions: a `PROTECTED_ROLES` account keeps everything and gets `user.intranet_missing`; a Google account the Intranet never knew stays as before. Any other 404, a timeout or a 5xx is a plain failure and changes nothing.
- A revoked account gets access back only at a sign-in whose authenticated lookup returns it (`user.access_restored`, then normal role sync). Never restore it by hand: the Intranet is the source of truth. Its role never changes by hand (409 `admin.users.errors.targetRevoked`), and an Admin without access does not count as the last Admin.
- Sessions last 7 days and renew daily, so sign-in alone misses an account that keeps its session. The daily access re-check (`recheckIntranetAccess` in `server/utils/auth/accessRecheck.ts`, pg-boss queue `users-access-recheck` at 05:30 Europe/Madrid) looks up every account with a live session, access, intranet data and no protected role, one every 500 ms, and calls `applyIntranetNotFound` on each authenticated `notFound`; it never runs role sync. More than max(3, 30%) not found of the accounts the Intranet answered for revokes nobody and records `users.access_recheck_blocked`.
- `getAuthUserWithRole` reads `access_revoked_at` on every request and answers 401 for an account without access, so better-auth's 5-minute session cookie cache never keeps a revoked account in. Never add `accessRevokedAt` to `AuthUserWithRole`.
- Before the session is created (`databaseHooks.session.create.before`, `checkSignInAccess` in `server/utils/auth/roleSync.ts`), look the account up once with `lookupIntranetRole` (`server/utils/members/intranet.ts`): `POST` `{ "email": "user@creup.es" }` to `getRoleApiUrl()` with `Accept: application/json`. Role sync in `session.create.after` reuses that answer. Every intranet call (role sync and roster sync) sends `Authorization: Bearer <NUXT_INTRANET_API_TOKEN>` when the token is set (`intranetAuthHeaders`).
- Always update `externalRole`, `externalName`, `externalInitials`, `university` and `lastRoleSyncAt` when the lookup succeeds, and `intranetId` when the answer carries an `id`. A failed lookup writes nothing, `lastRoleSyncAt` included.
- If the Intranet lookup fails, log a warning and do not block sign-in. A database error in the access check refuses it (`sign_in_unavailable`) rather than let a deleted account in. Logs carry `accountRef` (`emailFingerprint`), never the email.
- `INITIAL_ADMIN_EMAIL` receives `Admin` on first sign-in.

Role assignment rules:

| Case                                                                                     | Platform role result                                                                  | Member link (`users.memberId`)                                                                     |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| New user + external `Asociado`                                                           | `Asociado` (`Invitado` if its role row is missing)                                    | The council with its intranet id, else its initials                                                |
| New user + external `Sectorial`                                                          | `Sectorial` (`Invitado` if its role row is missing)                                   | The sectorial with its intranet id, else its initials                                              |
| New user + external `CEA`                                                                | `CEA` (`Invitado` if its role row is missing)                                         | The `executive` area with its initials, created if missing                                         |
| New user + anything else, sync failure or `not_found`                                    | `Invitado`                                                                            | None                                                                                               |
| Existing `Invitado`, `Asociado`, `Sectorial` or `CEA` + external `Asociado`              | `Asociado`                                                                            | The council with its id, else its initials                                                         |
| Existing `Invitado`, `Asociado`, `Sectorial` or `CEA` + external `Sectorial`             | `Sectorial`                                                                           | The sectorial with its id, else its initials                                                       |
| Existing `Invitado`, `Asociado`, `Sectorial` or `CEA` + external `CEA`                   | `CEA`                                                                                 | Linked again by initials when the role or the initials change; otherwise kept, even if set by hand |
| Existing `Asociado`, `Sectorial` or `CEA` + any other external type                      | `Invitado`                                                                            | Cleared                                                                                            |
| Existing `Invitado` whose type stops being `Asociado`, `Sectorial` or `CEA`              | `Invitado`                                                                            | Cleared                                                                                            |
| Existing `Admin`, `Secretaria`, `Presidencia` or `Moderador`                             | Keep current platform role                                                            | Never cleared; linked like any account of its intranet type                                        |
| Existing account the Intranet knew, not a protected role, + authenticated `not_found`    | `Invitado`, without access (`accessRevokedAt` set, sessions deleted, sign-in refused) | Cleared                                                                                            |
| Existing `Admin`, `Secretaria`, `Presidencia` or `Moderador` + authenticated `not_found` | Keep current platform role (`user.intranet_missing` and a warning)                    | Kept                                                                                               |
| Existing account the Intranet never knew + authenticated `not_found`                     | Unchanged                                                                             | Unchanged                                                                                          |
| Account without access + authenticated lookup that returns it                            | Access restored (`user.access_restored`), then the rows above                         | As in the rows above                                                                               |
| Account without access + any other answer                                                | Sign-in refused, nothing changes                                                      | Unchanged (none)                                                                                   |

## RBAC

System roles:

- `Admin`
- `Secretaria`
- `Presidencia`
- `Moderador`
- `CEA`
- `Asociado`
- `Sectorial`
- `Invitado`

`Admin` bypasses all permission checks through the RBAC helper. Do not reimplement ad hoc admin bypasses. `Admin`, `Secretaria`, `Presidencia` and `Moderador` are `PROTECTED_ROLES`: role sync never changes them. The association's Secretaría and Presidencia hold every permission, users and roles included; the Mesa (Vocalía and Presidencia de la Mesa) uses `Moderador`. Only an Admin gives or takes the `Admin` role or touches its permissions. Only an Admin changes the access of Secretaría and Presidencia: giving or taking either role, what either grants, and the grants of an account holding either (`touchesLeadershipRole`), so neither changes the other's.

Default permissions:

| Role        | Permissions                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------- |
| Admin       | All, via bypass                                                                                                     |
| Secretaria  | All the keys below, `user:manage_roles` and `role:manage_permissions` included (`pnpm db:seed` adds missing grants) |
| Presidencia | Same as `Secretaria`                                                                                                |
| CEA         | `document:create`, `amendment:create`                                                                               |
| Asociado    | `document:create`, `amendment:create`                                                                               |
| Sectorial   | `document:create`, `amendment:create` (never an internal motion: see Documents)                                     |
| Moderador   | `session:moderate`                                                                                                  |
| Invitado    | none                                                                                                                |

Per-user permissions: whoever holds `user:manage_roles` can grant single permissions to one user on top of their role (`user_permissions`, `PUT /api/admin/users/[id]/permissions`). A user's permissions are the union of both; never subtract role permissions per user. Read them only through `getEffectivePermissions` (`server/utils/auth/rbac.ts`), which `requireActor`, `requirePermission`, `attachAuthContext`, `/api/auth/permissions` and the export actor use.

Permission keys:

```text
user:manage_roles
role:manage_permissions
assembly:create
assembly:manage
document:create
document:manage
amendment:create
amendment:manage
amendment:review
assembly:vote_result
session:moderate
member:manage
```

Use `requirePermission(event, PERMISSION_KEYS.X)`, `requireAnyPermission`, `hasPermission`, `requireAdmin`, `getEffectivePermissions` and `getAuthUserWithRole` from `server/utils/auth/rbac.ts`. Domain endpoints use `requireActor` and its helpers from `server/utils/domain/actor.ts`.

## Domain Rules

Full model: [`docs/design.md`](docs/design.md). Endpoints and business rules: [`docs/api.md`](docs/api.md).

### Members

- Documents and amendments are presented by members (`members`): student councils (asociados), sectorials and executive areas.
- Asociados and sectorials are synced from the intranet roster (`/usuarios/asociados`, `/usuarios/sectoriales`), by hand and daily at 05:00 Europe/Madrid (pg-boss, `server/utils/members/schedule.ts`). They are matched by their Intranet id (`members.intranetId`, unique when set) first, then by acronym (the intranet's `initials`), so an acronym change updates the member.
- A roster sync that would deactivate every active member of a kind, or more than max(3, 30%) of them, is not applied unless the body says `confirmDeactivation: true` with `confirmedKinds` covering what it would deactivate now (`isDeactivationConfirmed`): otherwise it records `members.sync_blocked` and answers 409 `large_deactivation` with the current counts. The daily run never confirms, and its audit rows have actor null.
- `users.memberId` links an account to the member it acts for. In the intranet an Asociado or Sectorial account is the member itself. Asociado and Sectorial accounts link by `users.intranetId` = `members.intranetId` first, then by initials (`server/utils/members/link.ts`).
- CEA accounts (intranet type `CEA`) act for an `executive` member keyed by their intranet initials. Whoever holds `user:manage_roles` can link any account by hand (`PUT /api/admin/users/[id]/member`).

### Assemblies

- Status: `draft -> convened -> in_session -> closed` (see `ASSEMBLY_STATUS_TRANSITIONS`).
  - `draft` is visible only to managers.
  - `agendaFinalizedAt` marks the final agenda (ODD definitivo): root agenda items are then locked.
- Each type keeps its own counter: `(type, number)` is unique.
- Calendar milestones live in `assembly_milestones`, seeded by `defaultMilestones` and checked by `checkCalendar`, both from the calendar rules of the type (`calendar_rules`: default offsets, regulatory minimums, documents sent with a short convocation, reform window; read from the 2025 RRI and RFAG, since the 2026 drafts were never approved). The rules are data, edited at `/admin/calendario` (`CALENDAR_RULES_PERMISSION`); never hardcode a regulatory deadline. `INITIAL_CALENDAR_RULES` is only what `pnpm db:seed` stores for a type with no row (it never overwrites one).
- Per-assembly policies live in `assemblies.settings`. Always read them merged over `DEFAULT_ASSEMBLY_SETTINGS`.
- Public routes use readable slugs (`80-ago`). Resolve them server-side with `server/utils/domain/resolvers.ts`.

### Agenda Items

- Recursive tree through `parentId`. Load the rows flat and build the tree client-side.
- Reorder operations must validate parent existence, assembly ownership and cycles.

### Documents

- `format`:
  - `structured`: blocks, amendable when `amendable`;
  - `file`: an uploaded PDF, never amendable.
  - Presenters and managers may switch it until publication (`DocumentFormatSwitch`); the draft text and the PDF both stay for a switch back.
- Kind defaults (amendable, voted, majority, accepted amendments) come from `DOCUMENT_KIND_DEFAULTS`. An amendment vote proposes `amendmentVoteMajority` (absolute in a reform of the Estatutos or a regulation, simple otherwise). `acceptedAmendments` is per document: `incorporate` (regulations and the Estatutos, RRI art. 65.5) approves an amendment the main presenter accepts at once (approval method `proponent`), and changing that answer before the final vote reopens it; `vote` leaves it to the assembly. Only managers change it, never after the final vote, and the change applies to the amendments already answered (`applyAcceptedAmendmentsRule`).
- A document has a main presenter (`proponentMemberId`), who alone answers its amendments, and may have co-presenters (`document_proponents`, see `server/utils/domain/presenters.ts`). Co-presenters see and edit the draft like the main one and follow what it decides, but only the main presenter or a manager changes who the main presenter is (403 `main_only`); with co-presenters a main presenter is required. Visibility checks take both (`DocumentPresenters`): load the co-presenters with the row (`resolveDocument`, `withCoProponentIds`).
- Who may present a kind is a rule of the member, not of the role: a sectorial never presents an internal motion, as main presenter or co-presenter, though it may amend one (`memberMayPresent` in `shared/utils/presenterKinds.ts`). The server checks the kind and every presenter a create or update ends with, for managers too (422 `presenter_kind`, `requirePresentersMayPresent`), and the forms leave those out.
- The presenters edit the working draft. Publishing freezes it as the immutable `base` version, and amendments anchor to that.
- The final vote stores the `consolidated` version produced by `consolidate`.
- PDF uploads must validate size, MIME and magic bytes.
- Presenters send documents to the Secretaría (`submitted`). Publishing is the Secretaría's validation; `POST .../correction` sends a document back to draft with a note. Managers can create expected documents for a member, with an internal deadline (`dueAt`), for the tracking panel.

### Amendments

- Operations: `replace`, `insert` and `delete`, anchored to base block ids. Validate them with `validateOps`. Only `totality_return` may have no operations.
- Status: `draft -> submitted ->` one of `approved`, `rejected`, `withdrawn`, `lapsed`, `transacted` or `inadmissible`. Each step is recorded in its own record:
  - admission, with `late` computed by the server;
  - the main presenter's position (only once validated, published and, if late, admitted: `positionBlocker`; never after the final vote), with `PositionDto.recordedBy` saying whether the Mesa recorded it (the `by` of the latest `position_changed` event, so it survives a change of main presenter);
  - votes;
  - decisions;
  - acceptances.
- Presenting never admits. The Secretaría validates each amendment (admitting the on-time ones; late ones still need the Mesa) or sends it back with a correction note, and publishes it when validating or later. Only published amendments are visible beyond their authors, the Secretaría and the Mesa (`publishedAt`). Transactionals the Mesa presents, and late amendments it admits, are published at once.
- Late amendments (`late`, computed on submission) stay `admission: pending` after the Secretaría validates them; once published they show as out of time until the Secretaría or the Mesa records the assembly's decision (`POST .../amendments/admission`). The validation inbox lists them, published or not, until then (`awaitsAssemblyDecision`). Only admitted amendments can be decided or grouped into a transactional.
- An amendment with co-authors has a main author (`AmendmentDto.mainAuthorId`, stored as `meta.presentingMemberId`); with several authors the bodies must name it (`mainAuthorMemberId`).
- Transactionals link 1..N parents through `amendment_sources`. They build only on published, submitted, admitted and undecided amendments. Any account with `amendment:create` acting for a member (or the Mesa) can propose one. Its parties are the main authors of its parents (acceptance rows with the role `author`; `proponent` rows are leftovers of the earlier rule and are ignored). One proposed by a member is `pending_authors` until every party accepts it (any rejection closes it as `withdrawn`), then goes to the Secretaría (`validate` answers 409 before that, and the inbox lists it read only). Validating a transactional always publishes it (`publishOnValidation`). Once validated and accepted, whichever comes last, it replaces its parents (they become `transacted`) and follows the normal flow; one the Mesa presents is validated and published at once and replaces them when the parties accept in the room. Replacing them closes every other submitted transactional over any of them (`lapsed`, reason `sources_transacted`): every path that calls `replaceSources` locks those competitors in the same ordered pass (`findCompetitors`). Settling a parent any other way (withdrawn, lapsed, declared inadmissible, voted, or incorporated by the main presenter's acceptance) closes the pending transactionals over it at once (`withdrawn`, `amendment_withdrawn` with `by: "sources_closed"`): every such path locks them in the same ordered pass and calls `closeTransactionalsOver` (`server/utils/domain/transactionalClosure.ts`). The closed transactional gets the parent's `decidedAt` and no `outcomeNote` (clients word the reason in the viewer's language from its parents), and its authors and parties see it in their news with nobody named (`by` null), also when their own act closed it. Reopening it never restores its parents, and one that never replaced them, or that a main author rejected, cannot be reopened (`transactionalReopenBlocker`).
- Majorities are counted on the members present by default (`DEFAULT_ASSEMBLY_SETTINGS.denominator`). The Mesa takes headcounts (`headcounts`, `server/utils/domain/headcounts.ts`): each active asociado absent, in the room, or represented by a delegation to one in the room (one per receiver), counted by `tallyHeadcount`. Quorum is data in each type's calendar rules (`quorum`, read through `quorumRulesOf`); never hardcode it. A count is a snapshot (`eligible`, `present`, `required`); the latest one fills `present` in the vote forms and on the server when a vote omits it (`withHeadcount`), and votes record it (`votes.headcountId`). Missing quorum only warns.
- Speaking turns (`speaking_turns`) are written down by the Mesa (`session:moderate`) through `/api/assemblies/[assembly]/speakers`; attendees see who has the floor only while `live_state.speakersVisible` is true. Writes lock the assembly row first. Closing the assembly ends the turn with the floor, cancels the waiting ones and hides the list (`closeSpeakingTurns`), since a closed assembly refuses every speakers write.
- Overlaps come from `findOverlaps` and are computed from the ranges each amendment really changes. Relations between amendments live in `amendment_relations`.
- Every state change calls `recordEvent`, which appends to the history and notifies live listeners.

## Traceability And Impersonation

Model in [`docs/design.md`](docs/design.md) ("Traceability", "Impersonation"); endpoints in [`docs/api.md`](docs/api.md) ("Activity and impersonation").

- Every mutation calls `recordEvent` or `recordAudit`, directly or through a server function. Never insert into `audit_log` directly: `recordAudit` (`server/utils/domain/audit.ts`) is the only writer. `server/utils/domain/traceability.test.ts` enforces it; an endpoint that writes no state goes in its commented `NON_RECORDING_MUTATIONS` allowlist.
- Identity comes only from `getAuthUserWithRole`, `requireActor` or the RBAC callers on the server and from `useMe` on the client, never from `session.user` or `authClient.useSession`: while an Admin impersonates, the session is still the Admin's.
- Impersonation is Admin-only by the real role through `requireAdmin`, never a permission key. Never as oneself or another Admin, never as an account without access (403 `targetRevoked`), never nested, 60 minutes fixed, with a reason. An open impersonation of an account that loses access ends as `revoked`. The admin section, `/api/members` and `/api/calendar-rules` are read-only while it lasts, and every unsafe request sends `x-acting-user`.
- Events recorded with `actor: null` inside an impersonated request pass `impersonationId` explicitly.
- The Intranet writes with source `intranet` and actor null: `user.access_revoked`, `user.access_restored` and `user.intranet_missing` at sign-in, `user.access_revoked` and `users.access_recheck_blocked` in the daily access re-check, and the daily roster sync's `members.sync` rows and `members.sync_blocked`. A manual roster sync keeps the account that ran it as actor.
- Update events put what changed in `payload.changes`, built with `diffChanges` (`server/utils/domain/changes.ts`) from the stored row against what was written, never from the request body; never content blocks or correction notes. Delete events carry an explicit allowlist that names the entity and its insiders; never spread the row into a payload.
- Read activity only through `server/utils/domain/activity.ts`. A new event type, audit action or payload key goes into `shared/constants/activity.ts` and into `EVENT_PAYLOAD_KEYS` or `AUDIT_PAYLOAD_KEYS` (otherwise non-Admins see nothing of it), with an `activity.actions.<action>` key in both locales and an icon in `ACTIVITY_ACTION_ICONS`. Linked messages (`@:key`) may reuse existing wording.
- Scripts that write to the database outside Nuxt (seed, one-off loaders) write audit rows with the exact `recordAudit` shape (source `seed` or `import`). The seed may import `audit.ts`, so keep its runtime imports to packages and `../../db/schema`.
- IP addresses and user agents in `audit_log` and `impersonations` are personal data; there is no retention job yet.

## API Rules

Typical handler order:

1. `requireAuth`, `requireAdmin` or `requirePermission`.
2. Validate route params. Use slug resolvers when routes accept slugs; otherwise use `validateCuid` or `validateAuthId`.
3. Validate query/body with Zod.
4. Run DB work.
5. Return minimal stable JSON.

Rules:

- Use `createError({ statusCode, message })`, not plain errors.
- User-facing API messages should be Spanish unless routed through i18n.
- Keep handlers small. Extract complex logic to `server/utils/`.
- Do not expose internal DB fields unless the client needs them.
- `/api/admin/**` opens by permission: users, their roles, member links and grants need `user:manage_roles`; roles and the permission catalog need `role:manage_permissions` (reading roles needs either). Each endpoint checks its own with `requireAnyPermission`, and only an Admin gives or takes the `Admin` role. A non-Admin never raises its own access nor locks itself out: not its own role, its own account's grants or member link, not `user:manage_roles` or `role:manage_permissions` taken away from the role it holds, and no key it does not hold itself (`adminGrantViolation`). The last Admin cannot leave the `Admin` role.
- All mutation endpoints need CSRF header and same-origin protection.
- Client mutations must include `CSRF_HEADER_NAME` from `shared/constants/security.ts`.
- That protection comes from the `serverHandlers` middleware in `nuxt.config.ts`:
  `server/handlers/auth.ts` for the admin section, `server/handlers/protected.ts`
  for the authenticated non-admin sections. A new API section needs its own
  entry, or its mutations run unprotected.
- Middleware routes must be a plain prefix (`/api/assemblies`), never
  `/api/assemblies/**`. Nitro registers them with `h3App.use(route, ...)`, which
  prefix-matches literally, so a `/**` suffix silently never matches and the
  middleware never runs.
- `/api/auth` is deliberately left uncovered: the Google OAuth callback is a
  cross-origin POST.
- The CSRF cookie is issued by `server/middleware/csrfCookie.ts`, which runs on
  every response including the page render. Issuing it from an API handler is
  not enough: during SSR those run as internal `$fetch` calls whose `Set-Cookie`
  never reaches the browser.

Client mutations go through the shared client, which adds the CSRF header and
`x-acting-user` (`ACTING_USER_HEADER_NAME`, the account the page acts as):

```ts
const api = useApi();
await api.send(url, { method: "POST", body });
```

A raw `$fetch` with only the CSRF header gets 409 `auth.identityChanged` for any
real Admin. Server section handlers match paths on the full decoded original
URL, never on `event.path` (h3 slices the prefix, and `/api/me` also matches
`/api/members`).

## Error Pages

`app/error.vue` renders only localized copy, keyed off the status code. Never
render `error.message` or `statusMessage`: on a 5xx that is the server-side
exception, and on a 4xx it is untranslated framework or handler text.

Pages that need their own wording pass an i18n key:

```ts
throw createError({
  statusCode: 404,
  data: { messageKey: "assembly.notFound" },
});
```

## Shared Helpers To Prefer

- `server/utils/domain/actor.ts`: `requireActor`, `requireCan`, `canModerate`, `canManageDocuments` and related checks. Admin passes every check.
- `server/utils/domain/visibility.ts`: who sees assemblies, documents, amendments and positions.
- `server/utils/domain/resolvers.ts`: slug and CUID route resolution with 404 on hidden targets.
- `server/utils/domain/events.ts`: `recordEvent` (history plus live notification).
- `server/utils/domain/audit.ts`: `recordAudit`, the only `audit_log` writer; `server/utils/domain/changes.ts`: `diffChanges`.
- `server/utils/domain/activity.ts` (activity reader), `server/utils/domain/impersonators.ts` (who sees `impersonatedBy`) and `redactDocumentChanges` next to `redactCorrectionNote` in `visibility.ts`.
- `server/utils/auth/impersonation.ts`: start, stop, lazy close and the request guards.
- `app/composables/activity/*`: `useActivityPages`, `useActivityText`, `useActivityOptions`, and the pure `-filters.ts` and `-present.ts`.
- `server/utils/live/hub.ts`: live updates through Postgres `LISTEN/NOTIFY` and SSE.
- `server/utils/auth/rbac.ts` and `server/utils/auth/roleSync.ts`: permissions and external role sync.
- `server/utils/validation.ts`, `server/utils/optimisticLock.ts`, `server/utils/crud.ts` and `server/utils/errors.ts`.
- `shared/utils/content/*`, the amendment engine:
  - `validateOps`, `diffPassage`, `findOverlaps`, `consolidate` and `previewAmendment`;
  - rendering, editor conversion and `globalReplaceOps`.
- `shared/utils/calendar.ts`, `shared/utils/votes.ts`, `shared/utils/slug.ts` and `shared/utils/diff.ts` (`hashContent`).
- `shared/utils/schemas/*`: Zod schemas matching `shared/types/api.ts`.
- `server/utils/export/*`: queue, storage and PDF building.

Import `shared/` from `app/` through the `~~/shared/...` alias, never a
relative path. The SSR build keeps shared modules external, and Rollup
renders an external that was imported relatively as a wrong relative path, so
`pnpm build` fails in Nitro with "Could not resolve". Vitest resolves `~~`
and `~` too (`vitest.config.ts`).

## Database And Migrations

- CUID2 primary keys use `text('id').primaryKey().$defaultFn(cuid)`.
- Timestamps use timezone-aware `timestamp({ withTimezone: true, mode: 'date' })`.
- `updatedAt` should use `.$onUpdate(() => sql\`now()\`)`.
- Self-referencing FKs may require raw SQL migrations.
- Edit schema files first, then run `pnpm db:generate`.
- `drizzle/meta` is tracked, not ignored. `db:migrate` reads the journal to know
  what to apply and `db:generate` diffs the snapshots to emit the next
  migration, so a clone without it can do neither. Commit what drizzle-kit
  writes there; never hand-edit or reformat it.
- Do not edit existing migration files after they have been committed.

## PDF Export

Flow:

1. `POST /api/assemblies/[assembly]/export` or `POST /api/assemblies/[assembly]/documents/[document]/export` creates a pg-boss job. Queues are created on boot (`createQueue`).
2. Worker generates PDF with `pdfmake`.
3. Worker writes metadata and PDF to `EXPORT_STORAGE_DIR`.
4. Client polls `GET /api/exports/[jobId]/status`.
5. Client downloads through `GET /api/exports/[jobId]/download`.

Security and reliability:

- Download/status must verify the requester is the job owner or has the required permission.
- Do not store generated PDFs only in memory.
- Include `EXPORT_STORAGE_DIR` in backups.
- Keep PDF labels localized and use shared assembly/date formatters.
- Raleway font files must be available from `server/assets/fonts` after build, and the letterhead logos from `server/assets/brand`.
- Exports follow CREUP's document template (`server/utils/export/brand.ts` and `CONTENT_STYLES`): logos in the header, a band down the left edge naming the kind of document ("Documentación interna", "Moción Interna", "Normativa propia", "Posicionamiento", "Resolución"), website, email and page count in the footer, and the title alone above the text. Level 1 headings sit on a burgundy bar and level 3 in a burgundy box, in exports and in the platform (`--content-heading` in `main.css`); positionings open with a cover page. Logos are PNGs because pdfmake embeds an image once but redraws an SVG on every page; the band's label is drawn as glyph outlines with `fontkit`, since pdfmake's SVG text cannot reach fonts in its virtual file system.

pg-boss v12 reminders:

- `work(queueName, { batchSize: 1 }, handler)` receives `Job<T>[]`.
- Queues must exist before `send` or `work`: create them on boot with `createQueue` (idempotent).
- `send(queueName, data)` returns a job ID.
- `getJobById(queueName, jobId)` requires queue name first.
- Common states: `created`, `retry`, `active`, `completed`, `cancelled`, `failed`.

## Security Checklist

- Auth required for all non-auth routes.
- Permission checked server-side for every protected operation.
- Admin APIs are not protected by UI checks alone: each one checks its permission server-side.
- Route params and body/query data validated before DB access.
- Mutations include CSRF and same-origin checks.
- Document content stored as validated blocks and rendered escaped; no raw HTML in `v-html`.
- Uploaded PDFs validated by type and file signature.
- Optimistic locking applied to shared updates.
- Unknown permission keys rejected, not silently ignored.
- Export downloads authorized.
- Every mutation leaves an event or an audit row (`recordEvent` / `recordAudit`).
- Impersonation only for the real Admin role; the admin section, `/api/members` and `/api/calendar-rules` read-only while it lasts; `x-acting-user` on unsafe requests.
- An account deleted in the Intranet has no access (`accessRevokedAt`), checked on every request and found by the daily re-check even if it never signs in again; only an authenticated Intranet lookup gives it back.
- The Intranet token never travels over `http:` to a public host in production, and logs never carry an email (`accountRef`).
- Activity readers re-check visibility with the current actor and never show others' IPs or emails to non-Admins.

## Formatting

`eslint` runs Prettier over JS, TS and Vue. Everything else Prettier owns
(Markdown, CSS, YAML, JSON) is covered only by `pnpm format:check`, so run it
alongside `pnpm lint`. `.prettierignore` excludes generated output, the pnpm
lockfile and `drizzle/meta`; do not reformat those by hand.

## Commands

```bash
pnpm dev
pnpm build
pnpm preview
pnpm lint
pnpm lint:fix
pnpm format
pnpm format:check
pnpm typecheck
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm db:studio
pnpm i18n:check
pnpm i18n:audit-identical
bash ./deploy.sh    # build, push to GHCR and roll out on the VPS (DEPLOYMENT.md); --seed also runs the RBAC seed
bash ./rollback.sh
```

## Verification Checklist

Run before handing off code changes:

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm i18n:check
pnpm i18n:audit-identical
pnpm test
pnpm build
```

Also verify manually when relevant:

- unauthenticated users land on `/login`;
- Google sign-in calls role sync and preserves privileged roles, and an account the Intranet deleted is refused;
- admin pages reject users without `user:manage_roles` or `role:manage_permissions` server-side, only an Admin gives or takes the Admin role, and only an Admin changes Secretaría's and Presidencia's access;
- ES and EN UI both render new strings;
- document content stays block-based and escaped on render;
- amendment incorporation updates document content and history;
- PDF export survives app restart because files are persisted.

## Commit Guidelines

Use Conventional Commits:

```text
feat: add amendment proponent decision workflow
fix: preserve admin role during external role sync
docs: update deployment runbook
refactor: extract localized content helpers
a11y: add diff display preferences
```
