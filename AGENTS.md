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
- Raleway, the UI font, is self-hosted (`app/assets/css/fonts.css`, from `server/assets/fonts`) with `ascent-override`/`descent-override` pinned (88%/29.4%: the hhea total, split so the box's middle falls between the middle of the lowercase letters and of the capitals). Without them Windows lays it out with `winAscent` (1154 of 1000) and every line of text sits 2 to 3 px below the icons next to it; with the plain hhea split (94%/23.4%) icons sat on the capitals' middle and looked high next to lowercase labels. Never move it back to a provider of `@nuxt/fonts`, which cannot set overrides. Align an icon with its text with `flex items-center` (or `self-center` in an `items-baseline` row), never with margin nudges tuned on one browser. The icon's own wrapper must be flex too: an icon alone in a block element (a `<dt>` next to an `sr-only` label) sits on the text baseline and comes out 2 to 3 px high. An icon inside running text that wraps uses `align-middle`, which centres it on the lowercase letters; in an `items-start` row the icon takes `mt-*` of (line height minus icon size) / 2.
- Diff UI must support color mode and marks mode. Render diffs, provenance and plain text through the shared engine (`shared/utils/content/render.ts`) and `app/components/content/*`, never with component-level diff logic. Colour mode is soft (`--cx-*` in `main.css`): changed text keeps the colour of the text around it, added text sits on a pale green tint with a thin underline, removed text is dimmed and struck through on a pale red tint; the hue goes on the line and the tint, never on the text. Pass `focus` (the ring, `.cx-focus`) only where several amendments show together (provenance), never on a single amendment's diff.

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
| New user + external `CEA`                                                                | `CEA` (`Invitado` if its role row is missing)                                         | The `executive` office with its initials, created if missing                                       |
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

- Documents and amendments are presented by members (`members`): student councils (asociados), sectorials and executive offices (the single-person offices, "cargos unipersonales", of the Comisión Ejecutiva Ampliada such as PRES or SE, shown as "Cargo de la CEA" and never called areas in visible text; code identifiers keep `executive`; the `CEA` role is shown as "Comisión Ejecutiva Ampliada (CEA)", and the UI and PDFs never say "Comisión Ejecutiva" alone).
- Asociados and sectorials are synced from the intranet roster (`/usuarios/asociados`, `/usuarios/sectoriales`), by hand and daily at 05:00 Europe/Madrid (pg-boss, `server/utils/members/schedule.ts`). They are matched by their Intranet id (`members.intranetId`, unique when set) first, then by acronym (the intranet's `initials`), so an acronym change updates the member.
- A roster sync that would deactivate every active member of a kind, or more than max(3, 30%) of them, is not applied unless the body says `confirmDeactivation: true` with `confirmedKinds` covering what it would deactivate now (`isDeactivationConfirmed`): otherwise it records `members.sync_blocked` and answers 409 `large_deactivation` with the current counts. The daily run never confirms, and its audit rows have actor null.
- Every list of members follows one order, `orderMembers` (`shared/utils/memberOrder.ts`): asociados, sectorials, the others and the CEA's offices, each by acronym, inactive ones last. `GET /api/members` answers in it. Where someone chooses who to present an amendment with, its own kind goes first (`orderMembers(list, member.kind)` in `AmendmentComposer`); only the order changes, never who is listed.
- `users.memberId` links an account to the member it acts for. In the intranet an Asociado or Sectorial account is the member itself. Asociado and Sectorial accounts link by `users.intranetId` = `members.intranetId` first, then by initials (`server/utils/members/link.ts`).
- CEA accounts (intranet type `CEA`) act for an `executive` member keyed by their intranet initials. Whoever holds `user:manage_roles` can link any account by hand (`PUT /api/admin/users/[id]/member`).
- Who sees the executive offices is one predicate, `canSeeExecutiveMembers` (`server/utils/domain/visibility.ts`): the roles Admin, Secretaría, Presidencia, Moderador and CEA, the holders of `document:manage`, `amendment:review`, `amendment:manage`, `assembly:manage`, `session:moderate`, `member:manage` or `user:manage_roles`, and an account that acts for an office (`Actor.memberKind`). Everyone else gets from the server one generic presenter, `GENERIC_EXECUTIVE_MEMBER` (`CEA`, "Comisión Ejecutiva Ampliada"), instead of any office; never hide an office on screen instead.
  - Every answer that carries a member goes through the helpers there: `redactMember`, `redactMembers`, `redactPresenters`, `redactAuthors` (remaps `mainAuthorId`), `redactAcceptances`, `redactEventActor` (also drops the name of the person who acted for an office), `redactPayloadMembers` with `loadExecutiveMask` (member ids in payloads), `collapseExecutive` (`GET /api/members`) and `visibleAcronym` (PDFs, built with the requester's actor). `MeDto.member` stays real. A new DTO with a `MemberRef` or a member id uses them.
  - `GENERIC_EXECUTIVE_MEMBER_ID` is never a member. On a document, an account that does not see the offices neither adds nor removes one: bodies go through `resolveBodyMembers` (`server/utils/domain/executiveMembers.ts`), which answers 422 `executive_member` for an office by its real id (there or not) and for the generic id with no office there, and keeps the offices that are.
  - Amendments and transactionals are the one exception: the CEA presents them too, and any member may present one with it. Only in the composer are the real offices read by accounts that do not see them. An account that presents amendments for a member (`canNameExecutiveAuthors`) reads the list to pick from, `GET /api/members?for=amendment` (`AMENDMENT_AUTHORS_QUERY`; nothing but the two composers may use it). Whoever may edit a draft reads its real authors and main author, `GET .../amendments/[amendment]/authors` (`amendmentComposerAuthors`, `AmendmentComposerAuthorsDto`): exactly the checks of `updateAmendmentDraft`, so an author (`composerAuthorsAccess`) of a draft, one sent back for correction included, while the document still takes amendments (`assertAmendable`: 409 once it is voted or the assembly closed). Both carry members only, never who acts for them. So while it composes, whoever may edit a draft always sees which offices present it and which is the main author, and names every office by its real id. Those bodies go through `requireAmendmentBodyMembers`: the generic id is never an author (422 `executive_author`, for everyone), an office named as main author follows the rule of any member (it must be among the authors the body ends with), and an account that neither sees nor may name the offices cannot name one (422 `executive_member`), except to keep the ones already on the draft it edits (`known`, passed only by `updateAmendmentDraft` after its edit checks: that account reads them in the composer). Everything those accounts read outside the composer, its own draft included (lists, the detail, history, news, activity, PDFs), is the generic "CEA".
  - That account knows every real office id, so outside those two reads no answer may tell which offices an entity has: on a document never accept a real id "because it is already there" nor count the offices behind the generic entry in an error, and on an amendment check that the actor may edit the draft (author, draft, `assertAmendable`) before any answer that depends on its authors. `redactPayloadMembers` puts the generic id last in every list of ids, since stored lists are sorted by id.
  - On the client the generic entry is told by its id, never by the viewer's role (`app/utils/executiveMembers.ts`): a picker that adds members passes its list through `addableMembers`, a generic entry already on a document is shown fixed (`withFixedGenericExecutive`), a draft whose authors carry it gets its real authors before its composer opens (`hidesExecutiveAuthors`, `loadDraftAuthors` in the document page; the composer never offers nor sends the generic entry), and filters by member use it as any other id. The 422 is worded once, in `useApi().notifyError` (`errorReasonKey`). `MeDto.seesExecutiveMembers` (`useMe().seesExecutiveMembers`) only words hints (outside the composer the offices a member names read as "CEA"); never use it to hide or show data.
  - Amendments whose main author is an office are coded `CEA n` for everyone, numbered per document across all the offices (`amendmentCodePrefix`): a code never names the office.

### Assemblies

- Status: `draft -> convened -> in_session -> closed` (see `ASSEMBLY_STATUS_TRANSITIONS`).
  - `draft` is visible only to managers.
  - `agendaFinalizedAt` marks the final agenda (ODD definitivo). Managers mark it or reopen it on the agenda page (`AgendaFinalAction`, PUT `calendar` with `agendaFinal`), never in the calendar editor. Nothing is locked then: creating, renaming, moving or deleting a root item needs `confirmFinal: true` in the request (409 with `data.code` `agenda_final` without it, so the client asks and retries) and its event carries `afterFinal: true`. Every such path goes through `confirmFinalRootChange` (`server/utils/domain/assemblies.ts`). Sub-items never need it.
- Each type keeps its own counter: `(type, number)` is unique.
- Calendar milestones live in `assembly_milestones`, seeded by `defaultMilestones` and checked by `checkCalendar`, both from the calendar rules of the type (`calendar_rules`: default offsets, regulatory minimums, documents sent with a short convocation, reform window; read from the 2025 RRI and RFAG, since the 2026 drafts were never approved). The rules are data, edited at `/admin/calendario` (`CALENDAR_RULES_PERMISSION`); never hardcode a regulatory deadline. `INITIAL_CALENDAR_RULES` is only what `pnpm db:seed` stores for a type with no row (it never overwrites one).
- Per-assembly policies live in `assemblies.settings`. Always read them merged over `DEFAULT_ASSEMBLY_SETTINGS`.
- Public routes use readable slugs (`80-ago`). Resolve them server-side with `server/utils/domain/resolvers.ts`.

### Agenda Items

- Recursive tree through `parentId`. Load the rows flat and build the tree client-side.
- Reorder operations must validate parent existence, assembly ownership and cycles.
- Every transaction that writes agenda rows takes `lockAssembly` first (`server/utils/domain/agendaWrites.ts`): the agenda endpoints, and the document paths that create, rename or remove an automatic sub-item (creating a document, deleting one, and `updateDocument` when it moves or renames one). Lock order: assembly, then documents.
- An item where members present (a container) has `acceptsSubmissions` and `submissionKinds`, the document kinds it takes; empty means every kind (`itemAcceptsKind` in `shared/utils/agendaSubmissions.ts`). The kinds bind members, never managers (422 `submission_kind`).
- A document created under a container, or moved to one, gets its own automatic sub-item in the same transaction (`insertAutoItem`, `bindAutoItem`; `agenda_items.generatedForDocumentId`), whoever creates it. Its title follows the document's until a manager renames it (`titleCustom`, `syncAutoItemTitle`), and it goes when the document is deleted or moved away unless it holds something else (`findRemovableAutoItem`, `removeAutoItem`); kept that way after a move, it stops being the document's and becomes an ordinary item that remembers the document in `hiddenWithDocumentId` (`unbindAutoItem`) until the document is deleted or a manager gives the item a new title; one a manager had already renamed (`titleCustom`) carries the manager's title and keeps no link (`keepsDocumentTitle`). Nobody, managers included, puts a document in another document's automatic sub-item (422 `auto_item`, `requireNotOthersAutoItem`), and the pickers leave those out. It never needs `confirmFinal` nor gets `afterFinal`. Its events carry `auto: true` and `documentId`.
- An automatic sub-item carries the title of its document, and so may one kept after its document moved away (`titleDocumentId` in `shared/utils/agendaSubmissions.ts`: `generatedForDocumentId`, else `hiddenWithDocumentId`). Never return that title to a viewer who cannot see the document, until it is published: agenda readers go through `visibleAgendaItems`, which leaves the item out, and send one that stays because of what it holds without its title (`hiddenTitleItemIds`; `AgendaItemDto.titleHidden`, worded by `agendaWithTitles` over the fetched agenda, and by `agendaHiddenTitle` in PDFs). Its events carry the `documentId` (`titleDocumentPayload`), and the activity shows them with the document's visibility; once that document is deleted, to everyone if it was public by then (`DeletedInfo.wasPublic`). Deleting a document that was never public leaves its title withheld on the items that carried it and stay (`withholdItemTitles` in `removeDocument`, `agenda_items.titleWithheld`; never one with `titleCustom`): only document managers read their title and description, and their events, until one of them gives the item a new title (PUT `[item]` clears `hiddenWithDocumentId` and `titleWithheld`). A masked item is sent without title, description and `generatedForDocumentId` (`toAgendaItemDto`), by the mutations too: an `assembly:manage` holder who may not read the title (`canReadItemTitle`) changes neither it nor the description. The neutral label is worded when read, never stored in fetched data (`agendaWithTitles`).
- Deleting an item removes its sub-items and every document under them (`removeDocument` for each, one `agenda_item_deleted` per item). Only amendments keep it: any amendment row of any status under it answers 409 `agenda_item_amendments`. During the session, 409 `agenda_item_live` while the projection or an open speaking turn is on one of them.

### Documents

- `format`:
  - `structured`: blocks, amendable when `amendable`;
  - `file`: an uploaded PDF, never amendable.
  - Presenters and managers may switch it until publication (`DocumentFormatSwitch`); the draft text and the PDF both stay for a switch back.
  - A kind that takes amendments by default is presented as text: only managers create one as a PDF or switch one to it. The server refuses a non-manager with 422 `file_kind` (`fileFormatRefused` in `shared/utils/documentFormat.ts`), and the forms offer members no PDF there.
- Kind defaults (amendable, voted, majority, accepted amendments) come from `DOCUMENT_KIND_DEFAULTS`. An amendment vote proposes `amendmentVoteMajority` (absolute in a reform of the Estatutos or a regulation, simple otherwise). `acceptedAmendments` is per document: `incorporate` (regulations and the Estatutos, RRI art. 65.5) approves an amendment the main presenter accepts at once (approval method `proponent`), and changing that answer before the final vote reopens it; `vote` leaves it to the assembly. Only managers change it, never after the final vote, and the change applies to the amendments already answered (`applyAcceptedAmendmentsRule`).
- A document has a main presenter (`proponentMemberId`), who alone answers its amendments, and may have co-presenters (`document_proponents`, see `server/utils/domain/presenters.ts`). Co-presenters see and edit the draft like the main one and follow what it decides, but only the main presenter or a manager changes who the main presenter is (403 `main_only`); with co-presenters a main presenter is required. Visibility checks take both (`DocumentPresenters`): load the co-presenters with the row (`resolveDocument`, `withCoProponentIds`).
- Who may present a kind is a rule of the member, not of the role: a sectorial never presents an internal motion, as main presenter or co-presenter, though it may amend one (`memberMayPresent` in `shared/utils/presenterKinds.ts`). The server checks the kind and every presenter a create or update ends with, for managers too (422 `presenter_kind`, `requirePresentersMayPresent`), and the forms leave those out.
- The presenters edit the working draft. Publishing freezes it as the immutable `base` version, and amendments anchor to that.
- The final vote stores the `consolidated` version produced by `consolidate`.
- PDF uploads must validate size, MIME and magic bytes.
- Documents are created only through `createDocuments` (`server/utils/domain/documentCreate.ts`), one or several (`POST .../agenda/[item]/documents`, managers only, all or none), and removed only through `removeDocument` (`documents.ts`), which the single delete and the agenda delete share; the caller removes the PDF and the images from disk once the transaction commits.
- A document is expected (`isExpectedDocument`) when it has a `dueAt` or hangs from an item that takes no submissions and is not an automatic sub-item. A member's document in an automatic sub-item is never expected for that reason, so `documents_close` binds it.
- Presenters send documents to the Secretaría (`submitted`). Publishing is the Secretaría's validation; `POST .../correction` sends a document back to draft with a note. Managers can create expected documents for a member, with an internal deadline (`dueAt`), for the tracking panel.

### Amendments

- Operations: `replace`, `insert` and `delete`, anchored to base block ids. Validate them with `validateOps`. Only `totality_return` may have no operations.
- A `replace` also amends formatting (`shared/utils/content/format.ts`): optional `marks` (the inline formatting of its new text; with `text` equal to `baseText`, formatting alone) and optional `block` (the new format of the whole block: type, level, list, marker, start, alignment; alone on an empty operation at 0). Operations stored without them stay valid and consolidate to the same blocks, so never make either field required nor rewrite stored ops. A format change is a `modification`, shows its text once with a label in words (`FormatChange` codes, `common.content.format.*`), never as a strike and a rewrite, and in overlaps takes its range (marks) or its whole block (`block`). Moving a block is still a delete and an insert; a table cell's fill and an image are not amendable.
- Status: `draft -> submitted ->` one of `approved`, `rejected`, `withdrawn`, `lapsed`, `transacted` or `inadmissible`. Each step is recorded in its own record:
  - admission, with `late` computed by the server;
  - the main presenter's position (only once validated, published and, if late, admitted: `positionBlocker`; never after the final vote), with `PositionDto.recordedBy` saying whether the Mesa recorded it (the `by` of the latest `position_changed` event, so it survives a change of main presenter);
  - votes;
  - decisions;
  - acceptances.
- Presenting never admits. The Secretaría validates each amendment (admitting the on-time ones; late ones still need the Mesa) or sends it back with a correction note, and publishes it when validating or later. Only published amendments are visible beyond their authors, the Secretaría and the Mesa (`publishedAt`). Transactionals the Mesa presents, and late amendments it admits, are published at once.
- Late amendments (`late`, computed on submission) stay `admission: pending` after the Secretaría validates them; once published they show as out of time until the Secretaría or the Mesa records the assembly's decision (`POST .../amendments/admission`). The validation inbox lists them, published or not, until then (`awaitsAssemblyDecision`). Only admitted amendments can be decided or grouped into a transactional.
- Those who review amendments (`amendment:review`; never `session:moderate` alone) can reclassify a presented, undecided amendment between "de forma" (`formal`) and the content kind (`partial`), the only two kinds with a counterpart (`reclassifyTarget` in `shared/utils/amendmentReclassify.ts`; `POST .../[amendment]/reclassify`, optimistic lock). It records `amendment_reclassified` (`{ from, to }`), which the history shows with the members before and after, and the authors read in their news.
- Those who review amendments (`amendment:review`; never `session:moderate` alone) can correct who presents a presented, undecided amendment or transactional, in case it was presented wrong (`changeAmendmentAuthors`, `POST .../[amendment]/authors`, optimistic lock; `canChangeAmendmentAuthors` in `shared/utils/amendmentAuthors.ts`; `AmendmentAuthorsChange` in the detail). The number stays and the code follows the new main author as after a correction (`numberingToKeep`, `amendmentCodePrefix`), so it never names an office; the code moves only with the main author, and a code given up is never handed to another amendment (`nextMemberSeq` reads the `previousCode` of these events). The main author cannot change while a transactional over the amendment is open (409), also when the amendment is itself a transactional, and `createTransactionalAmendment` re-checks its parents' main authors under the document lock. It records `amendment_authors_changed` (`{ from, to }` with member ids, plus `code` and `previousCode` when the code changes), which the history shows and the authors read in their news.
- The workspace reads amendments one at a time: the detail (`AmendmentDetail`) shows first the code, who presents it and one status (`amendmentStatusLine`), what changes, why, and the panels that are the viewer's turn; everything else goes under "Ver detalles". Never fold a panel that asks the viewer to act, and never switch the text view when an amendment is selected (only the mode tabs and "Ver en el documento" do).
- An amendment with co-authors has a main author (`AmendmentDto.mainAuthorId`, stored as `meta.presentingMemberId`); with several authors the bodies must name it (`mainAuthorMemberId`).
- Transactionals link 1..N parents through `amendment_sources`. They build only on published, submitted, admitted and undecided amendments. Any account with `amendment:create` acting for a member (or the Mesa) can propose one. Its parties are the main authors of its parents (acceptance rows with the role `author`; `proponent` rows are leftovers of the earlier rule and are ignored). One proposed by a member is `pending_authors` until every party accepts it (any rejection closes it as `withdrawn`), then goes to the Secretaría (`validate` answers 409 before that, and the inbox lists it read only). Validating a transactional always publishes it (`publishOnValidation`). Once validated and accepted, whichever comes last, it replaces its parents (they become `transacted`) and follows the normal flow; one the Mesa presents is validated and published at once and replaces them when the parties accept in the room. Replacing them closes every other submitted transactional over any of them (`lapsed`, reason `sources_transacted`): every path that calls `replaceSources` locks those competitors in the same ordered pass (`findCompetitors`). Settling a parent any other way (withdrawn, lapsed, declared inadmissible, voted, or incorporated by the main presenter's acceptance) closes the pending transactionals over it at once (`withdrawn`, `amendment_withdrawn` with `by: "sources_closed"`): every such path locks them in the same ordered pass and calls `closeTransactionalsOver` (`server/utils/domain/transactionalClosure.ts`). The closed transactional gets the parent's `decidedAt` and no `outcomeNote` (clients word the reason in the viewer's language from its parents), and its authors and parties see it in their news with nobody named (`by` null), also when their own act closed it. Reopening it never restores its parents, and one that never replaced them, or that a main author rejected, cannot be reopened (`transactionalReopenBlocker`).
- Majorities are counted on the members present by default (`DEFAULT_ASSEMBLY_SETTINGS.denominator`). The Mesa takes headcounts (`headcounts`, `server/utils/domain/headcounts.ts`): each active asociado in the room or not, and one not in the room may delegate to another (one per receiver); a delegation counts only while its receiver is in the room (`tallyHeadcount`). Quorum is data in each type's calendar rules (`quorum`, read through `quorumRulesOf`); never hardcode it. A count is a snapshot (`eligible`, `present`, `required`); the latest one fills `present` in the vote forms and on the server when a vote omits it (`withHeadcount`), and votes record it (`votes.headcountId`). Missing quorum only warns.
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
- `server/utils/domain/visibility.ts`: who sees assemblies, documents, amendments, positions and the executive offices (`canSeeExecutiveMembers` and the `redact*` helpers); `server/utils/domain/executiveMembers.ts`: the mask of hidden offices and the rule for the members a body names.
- `server/utils/domain/resolvers.ts`: slug and CUID route resolution with 404 on hidden targets.
- `server/utils/domain/events.ts`: `recordEvent` (history plus live notification).
- `server/utils/domain/audit.ts`: `recordAudit`, the only `audit_log` writer; `server/utils/domain/changes.ts`: `diffChanges`.
- `server/utils/domain/activity.ts` (activity reader), `server/utils/domain/impersonators.ts` (who sees `impersonatedBy`) and `redactDocumentChanges` next to `redactCorrectionNote` in `visibility.ts`.
- `server/utils/auth/impersonation.ts`: start, stop, lazy close and the request guards.
- `app/composables/activity/*`: `useActivityPages`, `useActivityText`, `useActivityOptions`, and the pure `-filters.ts` and `-present.ts`.
- `app/composables/shell/*` and `ShellBreadcrumbs`: the breadcrumb row. Every page with the default layout puts `<ShellBreadcrumbs />` in its panel header, right after the navbar (the assembly hub does it for all its pages); the trail comes from the route (`-trail.ts`), so a new route gets its step there, and pages never add their own "back" link up the hierarchy. A page of a document names it with `useDocumentBreadcrumb` (client only, once mounted: the row renders before the page loads the document); the page of an agenda item (`orden-del-dia/[item]`, keyed by the item's id) names itself and the items above it the same way with `useAgendaItemBreadcrumb`. Pages sized to the viewport take `--shell-breadcrumb-height` off.
- `ShellWelcome` and `app/components/shell/-welcome.ts`: the welcome, mounted client only by the default layout. It opens by itself while `MeDto.onboardingSeen` is false and again from "Ayuda" in the sidebar footer; closing it calls `POST /api/me/onboarding` (`users.onboardingSeenAt`, `user.onboarding_seen`). Never open it by itself or record it while an Admin impersonates (`welcomePending`; the endpoint answers 403). Its wording follows permissions and the member's kind (`welcomeAudience`), never the role name alone.
- `ShellPreferences`: language, theme and the content accessibility preferences as visible radio groups, shown by "Preferencias" in the user menu and by the welcome's last step. Add a preference there, never as a submenu of the user menu.
- `app/composables/assembly/-sections.ts` and `useAssemblySections`: the one list of an assembly's sections, for the sidebar and the phone toolbar of the hub. Add a section there, never in one of the two menus.
- `HomeFold` (`app/components/home/Fold.vue`): the home page and the assembly overview keep at most three blocks in first plane, for every role ("Te toca", the next deadline of the calendar, and the upcoming assemblies or the agenda summary). Anything else goes under them in a `HomeFold`, folded by default and remembered per browser; never add a fourth block.
- First plane of a page: only notices about that page's own subject, each fact once and in its quietest form (a document's amendment deadline is the line in `DocumentHeader`, never a box as well; the hub's next deadline and its phone status button stay off a document's pages and the overview has its own block), and one main action, two at most. Everything else goes in a "Más" menu (`moreItems` on the document page and the agenda page; a lone entry shows as its own button). `ExportButton` with `hide-idle` and `AgendaFinalAction` with `as="menu"` are started from such a menu through their exposed `start` and `ask`.
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
- An executive office, the person who acted for it and its acronym in an amendment code never reach an account that may not see the offices (`canSeeExecutiveMembers`): the server answers the generic "CEA" everywhere a member leaves it, PDFs included, and never takes the generic id for a member. The only real offices such an account reads are in the amendment composers: the member list (`GET /api/members?for=amendment`, for accounts that present amendments), which says nothing about who presented what, and the real authors of a draft it may edit (`GET .../amendments/[amendment]/authors`, only while the draft can still be edited). Neither carries a person.

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
