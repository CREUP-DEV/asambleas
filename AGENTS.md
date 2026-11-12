# CREUP Assemblies - Agent Instructions

These instructions are the source of truth for agents editing this repository. The domain model and the API live in [`docs/design.md`](docs/design.md), [`docs/api.md`](docs/api.md) and [`shared/types/api.ts`](shared/types/api.ts); [`docs/proceso-asambleas.md`](docs/proceso-asambleas.md) records how CREUP assemblies work today.

## Non-Negotiable Rules

- Follow these instructions before local preference or generic framework advice.
- Write code, identifiers and code comments in English.
- Put every user-visible UI string behind i18n keys in Spanish and English.
- Do not translate document or amendment content; users write that content directly.
- Keep Google authentication mandatory before any app access.
- Background work and persistent state use PostgreSQL, pg-boss or in-memory cache as described here. Local email goes to Mailpit (`docker-compose.yml`).
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
| Email         | `nodemailer` over SMTP; Mailpit locally, the VPS's docker-mailserver in production       |

## Local Defaults

- App: `http://localhost:3000`
- PostgreSQL: `localhost:5432`
- Adminer: `http://localhost:8080`
- Mailpit: `http://localhost:8225` (SMTP on `localhost:1225`); every email the platform sends locally lands there
- Intranet API base: `NUXT_INTRANET_API_URL` (role sync falls back to `${base}/user/role`; members from `/usuarios/asociados`, `/usuarios/sectoriales` and `/usuarios/cea`). In production only `https:`, or `http:` to a host with no dot such as `http://intranet`; anything else counts as unset (`isIntranetUrlAllowed`)
- Intranet API token: `NUXT_INTRANET_API_TOKEN`, sent as `Authorization: Bearer <token>` on every intranet call when set; never log it. Without it nobody ever loses access
- Role sync env var: `NUXT_ROLE_API_URL`, an optional override of `${base}/user/role`; normally unset. On another origin than the base it never receives the token (`isRoleLookupAuthenticated`)
- The development server uses the production Intranet (`https://intranet.creup.es/api/asambleas/v1`, token in the local `.env` only): sign-in role sync, "Sincronizar", the daily roster sync and the daily access re-check read real data and write it to the local database. In production, the same public URL or `http://intranet/api/asambleas/v1` over the Intranet's Docker network (`DEPLOYMENT.md`).
- Daily roster sync: `NUXT_INTRANET_ROSTER_SYNC` (only `false` turns it off; needs `NUXT_INTRANET_API_URL`). The daily access re-check does not depend on it
- Export storage env var: `EXPORT_STORAGE_DIR`
- Email: `NUXT_SMTP_HOST`, `NUXT_SMTP_PORT`, `NUXT_SMTP_SECURE`, `NUXT_SMTP_USER`, `NUXT_SMTP_PASS`, `NUXT_SMTP_FROM_EMAIL`, `NUXT_SMTP_FROM_NAME` (`readSmtpConfig`). Locally they point at Mailpit (`127.0.0.1:1225`). Without a host or a sender nothing is sent: deliveries are skipped as `unconfigured`, never kept to go out later

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
- Diff UI must support color mode and marks mode. Render diffs, provenance and plain text through the shared engine (`shared/utils/content/render.ts`) and `app/components/content/*`, never with component-level diff logic. Colour mode is soft (`--cx-*` in `main.css`): changed text keeps the colour of the text around it, added text sits on a pale green tint with a thin underline, removed text is dimmed and struck through on a pale red tint; the hue goes on the line and the tint, never on the text. Pass `focus` (the ring, `.cx-focus`) only where several amendments show together (provenance), never on a single amendment's diff. A diff numbers ordered items as the PDF does: an item an amendment deletes takes no number (`cx-uncounted`, the PDF's `countable`; one carrying `start` hands it on, `handedOnListStarts`), and `previewAmendment` fragments carry their real numbers (`fragmentListStarts`, `struckListNext`), so an amendment to "k)" reads "k)" and two runs apart never read as one list. An editor seeded with a passage keeps its numbers (`seedListStarts`) and passes the base blocks before it to `diffPassage` (`before`), so those starts are no change of format. The projection shows only the blocks an amendment changes (context 0), fits its text to the free height down to a readable floor, scrolls to the first change and always uses strong marks, whatever the diff mode; it never forces light mode.
- Single-letter shortcuts (no modifier) can be turned off per browser (WCAG 2.1.4): every handler reads `useSingleKeyShortcuts().enabled` (`app/composables/accessibility/useSingleKeyShortcuts.ts`, localStorage, on by default, restored once hydration ends) and does nothing when it is false. The switch is the same `USwitch` in `ShellPreferences` and in every shortcut help (`ProponentReviewShortcutHelp`, the console toolbar's popover). While it is off, no kbd hint, tooltip or `aria-keyshortcuts` names a letter. The Mesa console's keys also do nothing while a console dialog is open (every console modal keeps its open state in `useSessionConsole`) or the focus is in a dialog, popover or field (`shortcutKeyIgnoredAt`, `app/composables/session/shortcutGuards.ts`; never guard `[role="menu"]` there, the card menu announces the keys). Their target follows the debate (`focusedId` moves with `liveState.amendmentId`), and `a` or `l` on an amendment that is not in debate asks first, naming its code.
- Relative dates go through `formatRelative` (`app/utils/format.ts`): under 24 hours it truncates hours and minutes, so a countdown never claims more time than is left; from there on it counts calendar days in Europe/Madrid (`assemblyDayOffset` in `shared/utils/calendar.ts`), so a deadline at 23:59 tomorrow reads "mañana" however many hours are left. The deadline a page is about (`DocumentHeader`, `ProgressBanner`, the hub's next milestone, the agenda item reader) passes `dated` to `CommonCountdown` ("mañana a las 23:59", `datedCountdown`); lists of many dates do not. A past moment such as a headcount uses `formatMoment`, which adds the day when it is not today ("ayer, 18:45").

## Authentication And Role Sync

- First interaction is Google authentication.
- Unauthenticated users go to `/login`. The global middleware (`app/middleware/auth.global.ts`, decisions in `-session.ts`) sends to the login page of the page's language only when `GET /api/auth/session` answers 401 (or 403); a network error, a 429 or a 5xx lets the navigation through and keeps the last verdict, and a verified session is re-checked every 2 minutes, never when only the query or hash changes. `/login` sends an account already signed in to its `redirect` (`safeRedirectPath`: same-site paths only). Never bring back a redirect to `/login` on every fetch error.
- All authenticated Google users may sign in (there is no allowlist), except an account deleted in the Intranet. That is an authenticated lookup (token set) answering 404 with exactly `{"error":"not_found"}` for an account the Intranet knew before (`externalRole` or `intranetId` set). It revokes access in one transaction: `accessRevokedAt` and `accessRevokedReason` (`intranet_deleted`) together, role `Invitado`, member cleared, every session deleted, open impersonations of it closed (`revoked`), `user.access_revoked`, and the sign-in refused (the login page of the user's language with `?error=access_revoked`, sent as `errorCallbackURL`). Exceptions: a `PROTECTED_ROLES` account keeps everything and gets `user.intranet_missing`; a Google account the Intranet never knew stays as before. Any other 404, a timeout or a 5xx is a plain failure and changes nothing.
- A revoked account gets access back only at a sign-in whose authenticated lookup returns it (`user.access_restored`, then normal role sync). Never restore it by hand: the Intranet is the source of truth. Its role never changes by hand (409 `admin.users.errors.targetRevoked`), and an Admin without access does not count as the last Admin.
- Sessions last 7 days and renew daily, so sign-in alone misses an account that keeps its session. The daily access re-check (`recheckIntranetAccess` in `server/utils/auth/accessRecheck.ts`, pg-boss queue `users-access-recheck` at 05:30 Europe/Madrid) looks up every account with a live session, access, intranet data and no protected role, one every 500 ms, and calls `applyIntranetNotFound` on each authenticated `notFound`; it never runs role sync. More than max(3, 30%) not found of the accounts the Intranet answered for revokes nobody and records `users.access_recheck_blocked`.
- `getAuthUserWithRole` reads `access_revoked_at` on every request and answers 401 for an account without access, so better-auth's 5-minute session cookie cache never keeps a revoked account in. Never add `accessRevokedAt` to `AuthUserWithRole`.
- Before the session is created (`databaseHooks.session.create.before`, `checkSignInAccess` in `server/utils/auth/roleSync.ts`), look the account up once with `lookupIntranetRole` (`server/utils/members/intranet.ts`): `POST` `{ "email": "user@creup.es" }` to `getRoleApiUrl()` with `Accept: application/json`. Role sync in `session.create.after` reuses that answer. Every intranet call (role sync and roster sync) sends `Authorization: Bearer <NUXT_INTRANET_API_TOKEN>` when the token is set (`intranetAuthHeaders`).
- Always update `externalRole`, `externalName`, `externalInitials`, `university` and `lastRoleSyncAt` when the lookup succeeds, and `intranetId` when the answer carries an `id`. A failed lookup writes nothing, `lastRoleSyncAt` included.
- If the Intranet lookup fails, log a warning and do not block sign-in. A database error in the access check refuses it (`sign_in_unavailable`) rather than let a deleted account in. Logs carry `accountRef` (`emailFingerprint`), never the email.
- `INITIAL_ADMIN_EMAIL` receives `Admin` on first sign-in.

Role assignment rules:

| Case                                                                                     | Platform role result                                                              | Member link (`users.memberId`)                                                                     |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| New user + external `Asociado`                                                           | `Asociado` (`Otro` if its role row is missing)                                    | The council with its intranet id, else its initials                                                |
| New user + external `Sectorial`                                                          | `Sectorial` (`Otro` if its role row is missing)                                   | The sectorial with its intranet id, else its initials                                              |
| New user + external `CEA`                                                                | `CEA` (`Otro` if its role row is missing)                                         | The `executive` office with its intranet id, else its email, else its initials, created if missing |
| New user + external `CAS` (the Coordinación del CAS, a CEA account in the Intranet)      | `CAS` (`Otro` if its role row is missing)                                         | The member `CAS` (kind `other`) with its intranet id, else its email, else its initials            |
| New user + external `CAI` or `CdG`                                                       | `CAI` or `CdG` (`Otro` if its role row is missing)                                | None                                                                                               |
| New user + anything else, sync failure or `not_found`                                    | `Otro` (never `Invitado`: that one is given here by hand)                         | None                                                                                               |
| Existing `Otro`, `Invitado`, `Asociado`, `Sectorial` or `CEA` + external `Asociado`      | `Asociado`                                                                        | The council with its id, else its initials                                                         |
| Existing `Otro`, `Invitado`, `Asociado`, `Sectorial` or `CEA` + external `Sectorial`     | `Sectorial`                                                                       | The sectorial with its id, else its initials                                                       |
| Existing `Otro`, `Invitado`, `Asociado`, `Sectorial` or `CEA` + external `CEA`           | `CEA`                                                                             | Linked again by initials when the role or the initials change; otherwise kept, even if set by hand |
| Existing `Otro`, `Invitado` or a synced role + external `CAS`, `CAI` or `CdG`            | `CAS`, `CAI` or `CdG`                                                             | `CAS`: the member `CAS`; `CAI` and `CdG`: cleared                                                  |
| Existing `Asociado`, `Sectorial`, `CEA`, `CAS`, `CAI` or `CdG` + any other external type | `Otro`                                                                            | Cleared                                                                                            |
| Existing `Otro` whose type stops being one linked to a member                            | `Otro`                                                                            | Cleared                                                                                            |
| Existing `Invitado` + any other external type                                            | Keep `Invitado` (`RAISED_ONLY_ROLES`: sync only raises it to a member role)       | Unchanged                                                                                          |
| Existing `Admin`, `Secretaria`, `Presidencia` or `Moderador`                             | Keep current platform role                                                        | Never cleared; linked like any account of its intranet type                                        |
| Existing account the Intranet knew, not a protected role, + authenticated `not_found`    | `Otro`, without access (`accessRevokedAt` set, sessions deleted, sign-in refused) | Cleared                                                                                            |
| Existing `Admin`, `Secretaria`, `Presidencia` or `Moderador` + authenticated `not_found` | Keep current platform role (`user.intranet_missing` and a warning)                | Kept                                                                                               |
| Existing account the Intranet never knew + authenticated `not_found`                     | Unchanged                                                                         | Unchanged                                                                                          |
| Account without access + authenticated lookup that returns it                            | Access restored (`user.access_restored`), then the rows above                     | As in the rows above                                                                               |
| Account without access + any other answer                                                | Sign-in refused, nothing changes                                                  | Unchanged (none)                                                                                   |

## RBAC

System roles:

- `Admin`
- `Secretaria`
- `Presidencia`
- `Moderador`
- `CEA`
- `Asociado`
- `Sectorial`
- `CAS`: the Coordinación del CAS (Comité de Asuntos Sectoriales). In the Intranet a CEA account, the responsible of the committee whose acronym is `CAS` in its committee management; the role lookup answers `CAS` for it, and here it presents for the member `CAS` (kind `other`, from `/usuarios/cas`), never as an office of the CEA. The Secretaría del CAS is of type `Otros` there: it gets `Invitado` here by hand.
- `CAI` and `CdG`: the members of the Comité de Asuntos Internacionales and the Comité de Garantías (intranet types `CAI` and `CdG`; the Coordinación del CAI is a CEA office). They read like `Invitado`, and the Mesa marks them at the headcounts as guests (`HEADCOUNT_GUEST_ROLES`).
- `Invitado`: given here by hand by whoever manages roles, never by role sync. It reads like `Otro`, and the Mesa marks its accounts at the headcounts, as guests without a vote.
- `Otro`: every other account (any other intranet type, or none). It reads what is published and appears nowhere else.

`isReadOnlyRole` (`shared/constants/roles.ts`) is true for both, and for `CAI` and `CdG`. Audit rows written before the rename that say `Invitado` meant today's `Otro`.

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
| CAS         | `document:create`, `amendment:create` (never an internal motion: see Documents)                                     |
| Moderador   | `session:moderate`                                                                                                  |
| Invitado    | none                                                                                                                |
| CAI         | none                                                                                                                |
| CdG         | none                                                                                                                |
| Otro        | none                                                                                                                |

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
stats:view
notification:manage
```

Use `requirePermission(event, PERMISSION_KEYS.X)`, `requireAnyPermission`, `hasPermission`, `requireAdmin`, `getEffectivePermissions` and `getAuthUserWithRole` from `server/utils/auth/rbac.ts`. Domain endpoints use `requireActor` and its helpers from `server/utils/domain/actor.ts`.

## Domain Rules

Full model: [`docs/design.md`](docs/design.md). Endpoints and business rules: [`docs/api.md`](docs/api.md).

### Members

- Documents and amendments are presented by members (`members`): student councils (asociados), sectorials and executive offices. The executive offices are the single-person offices, "cargos unipersonales", of the Comisión Ejecutiva Ampliada such as PRES or SE, whose kind is labelled just "CEA" (sentences about one office still say "cargo de la CEA"), and never called areas in visible text; code identifiers keep `executive`; the `CEA` role is shown as "Comisión Ejecutiva Ampliada (CEA)", and the UI and PDFs never say "Comisión Ejecutiva" alone.
- Asociados, sectorials, the CEA's offices and the CAS are synced from the intranet roster (`/usuarios/asociados`, `/usuarios/sectoriales`, `/usuarios/cea`, one account per office, which outlives whoever holds it, and `/usuarios/cas`, the Coordinación del CAS as the member `CAS`, kind `other`, under the committee's name), by hand and daily at 05:00 Europe/Madrid (pg-boss, `server/utils/members/schedule.ts`), all the same way: matched by their Intranet id (`members.intranetId`, unique when set) first, so an acronym change updates the member, then by the account's email (`members.email`, unique when set), so an account recreated with a new id keeps its member, and deactivated once the Intranet no longer lists them. The acronym (the intranet's `initials`) only matches a member that stores no other id or email (members from before, manual offices): it never hands a member to another account, and a new account whose acronym another member keeps is not created (`acronymConflicts`). `members.email` never reaches a client, an audit row (`memberAuditState`) or a log. The Secretaría can assign documents to an office before anyone signs in.
- What the Intranet lists and a sync cannot store (an acronym listed twice, or already held by another member, and accounts without initials) is never dropped in silence: `MemberSyncResult.ignored` carries it, the members page warns, and the `members.sync` audit row keeps it (the daily run has no screen).
- Offices used to be manual members: a manual `executive` member whose acronym the CEA list names is adopted (`adopt` in `planRosterSync`, `server/utils/members/roster.ts`) and syncs from then on; one the list does not name stays manual, and no sync touches it. Every other manual member is never touched. The CEA and CAS lists are optional (`OPTIONAL_ROSTER_KINDS`): when the Intranet cannot give one, the sync goes on, leaves those members as they were (none created, updated nor deactivated) and says so in `MemberSyncResult.skipped`. The CAS list adopts a manual `other` member `CAS` the same way; the other manual `other` members (say the CAI or the CdG as presenters) are never touched. The CAS was a CEA office before: matched by its Intranet id, that office becomes the member `CAS`.
- A roster sync that would deactivate every active asociado, sectorial or office, or more than max(3, 30%) of them, is not applied unless the body says `confirmDeactivation: true` with `confirmedKinds` covering what it would deactivate now (`isDeactivationConfirmed`): otherwise it records `members.sync_blocked` and answers 409 `large_deactivation` with the current counts. The daily run never confirms, and its audit rows have actor null.
- Every list of members follows one order, `orderMembers` (`shared/utils/memberOrder.ts`): asociados, sectorials, the others and the CEA's offices, each by acronym, inactive ones last. The headcount is the one exception (`compareRollCall`, see the headcounts under Amendments). `GET /api/members` answers in it. Menus that pick members (who presents a document, the authors of an amendment or a transactional, the delegations of a headcount, who asks for the floor) show the acronym and, below it, the whole denomination and university, never cut (`memberMenuItem`, `MEMBER_MENU_UI` in `app/utils/format.ts`). Where someone chooses who presents a document or an amendment, its own kind goes first (`orderMembers(list, member.kind)` in `AmendmentComposer`, `AgendaNewDocumentModal`, `AgendaBulkDocumentsModal` and `DocumentMetadataForm`); only the order changes, never who is listed.
- `users.memberId` links an account to the member it acts for. In the intranet an Asociado or Sectorial account is the member itself, a CEA account is its office's place, and the Coordinación del CAS (role lookup `CAS`) is the member `CAS` (`canLinkToMember`: only an `other` member). All four link by `users.intranetId` = `members.intranetId` first, then by `users.email` = `members.email`, then by initials, never to a member that stores another account's id or email (`server/utils/members/link.ts`); a member created at a sign-in is an intranet member with that id and email (an office or the CAS named after its acronym until the next sync, since the account carries its holder's name). Whoever holds `user:manage_roles` can link any account by hand (`PUT /api/admin/users/[id]/member`), and a CEA account keeps such a link while its initials stay the same.
- Who sees the executive offices is one predicate, `canSeeExecutiveMembers` (`server/utils/domain/visibility.ts`): the roles Admin, Secretaría, Presidencia, Moderador and CEA, the holders of `document:manage`, `amendment:review`, `amendment:manage`, `assembly:manage`, `session:moderate`, `member:manage`, `user:manage_roles`, `stats:view` or `notification:manage`, and an account that acts for an office (`Actor.memberKind`). Everyone else gets from the server one generic presenter, `GENERIC_EXECUTIVE_MEMBER` (`CEA`, "Comisión Ejecutiva Ampliada"), instead of any office; never hide an office on screen instead.
  - Every answer that carries a member goes through the helpers there: `redactMember`, `redactMembers`, `redactPresenters`, `redactAuthors` (remaps `mainAuthorId`), `redactAcceptances`, `redactEventActor` (also drops the name of the person who acted for an office), `redactPayloadMembers` with `loadExecutiveMask` (member ids in payloads), `collapseExecutive` (`GET /api/members`) and `visibleAcronym` (PDFs, every one of them built with the requester's actor, the annotated PDF and the assembly dossier included; which amendments an annotated PDF carries is the one thing decided as a public reader, `publicExportActor` in `server/utils/export/actor.ts`: only published ones, whoever asks). `MeDto.member` stays real. A new DTO with a `MemberRef` or a member id uses them.
  - `GENERIC_EXECUTIVE_MEMBER_ID` is never a member. On a document, an account that does not see the offices neither adds nor removes one: bodies go through `resolveBodyMembers` (`server/utils/domain/executiveMembers.ts`), which answers 422 `executive_member` for an office by its real id (there or not) and for the generic id with no office there, and keeps the offices that are.
  - Amendments and transactionals are the one exception: the CEA presents them too, and any member may present one with it. Only in the composer are the real offices read by accounts that do not see them. An account that presents amendments for a member (`canNameExecutiveAuthors`) reads the list to pick from, `GET /api/members?for=amendment` (`AMENDMENT_AUTHORS_QUERY`; nothing but the two composers may use it). Whoever may edit a draft reads its real authors and main author, `GET .../amendments/[amendment]/authors` (`amendmentComposerAuthors`, `AmendmentComposerAuthorsDto`): exactly the checks of `updateAmendmentDraft`, so an author (`composerAuthorsAccess`) of a draft, one sent back for correction included, while the document still takes amendments (`assertAmendable`: 409 once it is voted or the assembly closed). Both carry members only, never who acts for them. So while it composes, whoever may edit a draft always sees which offices present it and which is the main author, and names every office by its real id. Those bodies go through `requireAmendmentBodyMembers`: the generic id is never an author (422 `executive_author`, for everyone), an office named as main author follows the rule of any member (it must be among the authors the body ends with), and an account that neither sees nor may name the offices cannot name one (422 `executive_member`), except to keep the ones already on the draft it edits (`known`, passed only by `updateAmendmentDraft` after its edit checks: that account reads them in the composer). Everything those accounts read outside the composer, its own draft included (lists, the detail, history, news, activity, PDFs), is the generic "CEA".
  - That account knows every real office id, so outside those two reads no answer may tell which offices an entity has: on a document never accept a real id "because it is already there" nor count the offices behind the generic entry in an error, and on an amendment check that the actor may edit the draft (author, draft, `assertAmendable`) before any answer that depends on its authors. `redactPayloadMembers` puts the generic id last in every list of ids, since stored lists are sorted by id.
  - On the client the generic entry is told by its id, never by the viewer's role (`app/utils/executiveMembers.ts`): a picker that adds members passes its list through `addableMembers`, a generic entry already on a document is shown fixed (`withFixedGenericExecutive`), a draft whose authors carry it gets its real authors before its composer opens (`hidesExecutiveAuthors`, `loadDraftAuthors` in the document page; the composer never offers nor sends the generic entry), and filters by member use it as any other id. The 422 is worded once, in `useApi().notifyError` (`errorReasonKey`). `MeDto.seesExecutiveMembers` (`useMe().seesExecutiveMembers`) only words hints (outside the composer the offices a member names read as "CEA"); never use it to hide or show data.
  - The projection is opened on a Mesa account but read by the room: every read it makes sends `?view=room` (`ROOM_VIEW_QUERY`, `shared/constants/roomView.ts`) and each endpoint it reads calls `requireViewer` (`server/utils/domain/roomView.ts`) first. The flag is honoured only for `session:moderate` (403 otherwise) and only on GET; with it the request answers as `roomViewer`, an account that sees only what is public, so every visibility rule and `redact*` applies by itself (offices read as "CEA", nobody speaking for one is named, nothing unpublished goes out). A new endpoint the projection reads calls `requireViewer`, or it shows the room the Mesa's view. Never hide offices on the projection's client instead.
  - Amendments whose main author is an office are coded `CEA n` for everyone, numbered per document across all the offices (`amendmentCodePrefix`): a code never names the office.

### Assemblies

- Status: `draft -> convened -> in_session -> closed` (see `ASSEMBLY_STATUS_TRANSITIONS`).
  - `draft` is visible only to managers.
  - The agenda turns final (ODD definitivo) on its own when the calendar's `agenda_final` date comes: `agendaFinalSince` (`shared/utils/calendar.ts`) gives `AssemblyDto.agendaFinalizedAt` and the server's `isAgendaFinal`. Nobody marks or reopens it by hand; moving that date moves it, and without it the agenda stays provisional. Only a provisional agenda shows a badge ("provisional"); a final one shows none. The column `assemblies.agenda_finalized_at` and the events `agenda_finalized` and `agenda_reopened` are from before. Nothing is locked then: creating, renaming, moving or deleting a root item needs `confirmFinal: true` in the request (409 with `data.code` `agenda_final` without it, so the client asks and retries) and its event carries `afterFinal: true`. Every such path goes through `confirmFinalRootChange` (`server/utils/domain/assemblies.ts`). Sub-items never need it.
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
- Agenda numbers ("17.1") are never stored, and everyone reads the same number for the same item: the one an account that sees only what is public reads. `AgendaItemDto.unlisted` marks the items such an account does not receive (`unlistedAgendaItemIds` in `shared/utils/agendaNumbering.ts`, which asks `visibleAgendaItems` for that viewer; never a second copy of the rule), and `numberAgendaItems` there is the only numbering: it counts siblings skipping the unlisted ones, which get no number (null, nor anything under them), keep their place and never shift the others. `buildAgendaTree`, the session rows and the exports (`server/utils/export/mapping.ts`) all call it; never number by position anywhere else. Where a number shows, an unlisted item shows the neutral mark "Sin publicar" (`AgendaItemNumber`), and in sentences and labels `numberedAgendaTitle` or `agendaNumberInText` (`app/utils/agendaTree.ts`), so no label reads an empty number. The convocation leaves unlisted items out, and so does the projection (`proyeccion/[assembly].vue`, which reads everything in the room view), except the item the Mesa itself puts on screen: the room view's agenda adds it, still unlisted so no number moves, with its title only when the Mesa account reads it (`roomAgenda`, `withScreenItem` in `server/utils/domain/roomView.ts`), never a withheld title.
- Deleting an item removes its sub-items and every document under them (`removeDocument` for each, one `agenda_item_deleted` per item). Only amendments keep it: any amendment row of any status under it answers 409 `agenda_item_amendments`. During the session, 409 `agenda_item_live` while the projection or an open speaking turn is on one of them.

### Documents

- `format`:
  - `structured`: blocks, amendable when `amendable`;
  - `file`: an uploaded PDF, never amendable.
  - Presenters and managers may switch it until publication (`DocumentFormatSwitch`); the draft text and the PDF both stay for a switch back.
  - A kind that takes amendments by default is presented as text: only managers create one as a PDF or switch one to it. The server refuses a non-manager with 422 `file_kind` (`fileFormatRefused` in `shared/utils/documentFormat.ts`), and the forms offer members no PDF there.
- Kind defaults (amendable, voted, majority, accepted amendments) come from `DOCUMENT_KIND_DEFAULTS`. An amendment vote proposes `amendmentVoteMajority` (absolute in a reform of the Estatutos or a regulation, simple otherwise). `acceptedAmendments` is per document: `incorporate` (regulations and the Estatutos, RRI art. 65.5) approves an amendment the main presenter accepts at once (approval method `proponent`), and changing that answer before the final vote reopens it; `vote` leaves it to the assembly. Only managers change it, never after the final vote, and the change applies to the amendments already answered (`applyAcceptedAmendmentsRule`). Where accepting would incorporate an undecided amendment, the presenter's review and the answer form (`AmendmentStep`, `PositionPanel`) say in quiet lines what it sets off: the overlapping amendments already approved it clashes with, the pending transactionals it withdraws (back if the answer changes before the final vote), and that everyone sees the approval while the answers are still reserved (`acceptIncorporates`, `incorporatedClashIds`, `answersReserved` in `app/components/proponent-review/-review.ts`).
- A document is always presented by someone: every create names a presenter (a manager's own member by default) and no update clears it (422 `presenter_required` in `planPresenters`); the forms offer no "nobody". Documents stored without one, from before, keep none until someone is named.
- A document has a main presenter (`proponentMemberId`), who alone answers its amendments, and may have co-presenters (`document_proponents`, see `server/utils/domain/presenters.ts`). Co-presenters see and edit the draft like the main one and follow what it decides, but only the main presenter or a manager changes who the main presenter is (403 `main_only`); with co-presenters a main presenter is required. Visibility checks take both (`DocumentPresenters`): load the co-presenters with the row (`resolveDocument`, `withCoProponentIds`).
- Who may present a kind is a rule of the member, not of the role: a sectorial or an `other` member (the CAS) never presents an internal motion, as main presenter or co-presenter, though it may amend one (`memberMayPresent` in `shared/utils/presenterKinds.ts`). The server checks the kind and every presenter a create or update ends with, for managers too (422 `presenter_kind`, `requirePresentersMayPresent`), and the forms leave those out.
- The presenters edit the working draft. Publishing freezes it as the immutable `base` version, and amendments anchor to that.
- Several people edit a draft by turns: saving checks the `contentHash` the editor started from (409 and a recovery panel when someone saved first), and a live event makes the other open editors load the new text or warn. The draft editor says who else has it open and who holds unsaved changes (`DocumentPresenceNotice`, `useDocumentPresence`, `POST .../presence`): a heartbeat kept only in this process's memory (`server/utils/live/presence.ts`, one app container), keyed by account and tab (a council's account is shared), never recorded and never sent over the live stream. Names go through `redactEventActor`; an impersonating Admin is never announced.
- The final vote stores the `consolidated` version produced by `consolidate`.
- PDF uploads must validate size, MIME and magic bytes.
- Every PDF of a document has a `document_files` row (`attachDocumentFile`). One replaced before publication goes with its row; one replaced once published stays on disk with `replacedAt` set, since delegates may have read it. Only document managers read those (`DocumentFileVersions` in the edit page, `GET .../files`, and the uploads route, which answers 404 to everyone else), and `removeDocument` removes them all with the document.
- An uploaded PDF shows in the browser's own viewer on large screens (`DocumentPdfViewer`, in the document page and the consolidated text), with the way to open it in a new tab; phones and browsers without an inline viewer (`navigator.pdfViewerEnabled`) get the card with the button. The signed convocatoria of an assembly shows the same way on its convocatoria page (`assemblies.convocationFileUrl`, `/api/uploads/convocations/[filename]`, `server/utils/domain/convocation.ts`). That page is a section of the hub like any other (`convocatoria/index.vue`); only the generated convocatoria (`ConvocationSheet`) has a view outside the shell, to print it (`convocatoria/imprimir.vue`). Only `/api/uploads/documents/**` and `/api/uploads/convocations/**` may be framed, and only by the platform (`frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN` in their route rules); every other response keeps `frame-ancestors 'none'` and `DENY`.
- Documents are created only through `createDocuments` (`server/utils/domain/documentCreate.ts`), one or several (`POST .../agenda/[item]/documents`, managers only, all or none), and removed only through `removeDocument` (`documents.ts`), which the single delete and the agenda delete share; the caller removes the PDF and the images from disk once the transaction commits.
- A document is expected (`isExpectedDocument`) when it has a `dueAt` or hangs from an item that takes no submissions and is not an automatic sub-item. A member's document in an automatic sub-item is never expected for that reason, so `documents_close` binds it.
- Presenters send documents to the Secretaría (`submitted`). Publishing is the Secretaría's validation; `POST .../correction` sends a document back to draft with a note. Managers can create expected documents for a member, with an internal deadline (`dueAt`), for the tracking panel.

### Amendments

- Operations: `replace`, `insert` and `delete`, anchored to base block ids. Validate them with `validateOps`. Only `totality_return` may have no operations.
- A `replace` also amends formatting (`shared/utils/content/format.ts`): optional `marks` (the inline formatting of its new text; with `text` equal to `baseText`, formatting alone) and optional `block` (the new format of the whole block: type, level, list, marker, start, alignment; alone on an empty operation at 0). Operations stored without them stay valid and consolidate to the same blocks, so never make either field required nor rewrite stored ops. A format change is a `modification`, shows its text once with words that say what changes (`FormatChange` codes, `common.content.format.*`; on screen a dotted line of its own hue and a note at the end of the block, never a chip inside the line, and a blank one only when it is the block's one change, `isShownFormatSegment`), never as a strike and a rewrite, and in overlaps takes its range (marks) or its whole block (`block`). Moving a block is still a delete and an insert; a table cell's fill and an image are not amendable.
- Status: `draft -> submitted ->` one of `approved`, `rejected`, `withdrawn`, `lapsed`, `transacted` or `inadmissible`. Each step is recorded in its own record:
  - admission, with `late` computed by the server;
  - the main presenter's position (only once validated, published and, if late, admitted: `positionBlocker`; never after the final vote), with `PositionDto.recordedBy` saying whether the Mesa recorded it (the `by` of the latest `position_changed` event, so it survives a change of main presenter);
  - votes;
  - decisions;
  - acceptances.
- Amendments are numbered on their first publication (`numberOnPublication` in `server/utils/domain/amendments.ts`), never on presentation: `number` per document, the code's sequence per prefix (`CEA n` shared by the offices; a member whose prefix changed starts at 1) and `T n` for transactionals, so what everyone reads runs without gaps. Until then its authors, the Secretaría and the Mesa read it without a code ("Sin número"; clients word it, never `code ?? ""`). Every path that sets `publishedAt` calls it; a code names one amendment of the document (`amendments_document_code_unique`).
- Presenting never admits. The Secretaría validates each amendment (admitting the on-time ones; late ones still need the Mesa) or sends it back with a correction note, and publishes it when validating or later. Only published amendments are visible beyond their authors, the Secretaría and the Mesa (`publishedAt`). Transactionals the Mesa presents, and late amendments it admits, are published at once.
- Late amendments (`late`, computed on submission) stay `admission: pending` after the Secretaría validates them; once published they show as out of time until the Secretaría or the Mesa records the assembly's decision (`POST .../amendments/admission`). The validation inbox lists them, published or not, until then (`awaitsAssemblyDecision`). Only admitted amendments can be decided or grouped into a transactional.
- Those who review amendments (`amendment:review`; never `session:moderate` alone) can reclassify a presented, undecided amendment between "de forma" (`formal`) and the content kind (`partial`), the only two kinds with a counterpart (`reclassifyTarget` in `shared/utils/amendmentReclassify.ts`; `POST .../[amendment]/reclassify`, optimistic lock). It records `amendment_reclassified` (`{ from, to }`), which the history shows with the members before and after, and the authors read in their news.
- Those who review amendments (`amendment:review`; never `session:moderate` alone) can correct who presents a presented, undecided amendment or transactional, in case it was presented wrong (`changeAmendmentAuthors`, `POST .../[amendment]/authors`, optimistic lock; `canChangeAmendmentAuthors` in `shared/utils/amendmentAuthors.ts`; `AmendmentAuthorsChange` in the detail). The number stays and the code of a published amendment follows the new main author as after a correction (`numberingToKeep`, `amendmentCodePrefix`), so it never names an office; the code moves only with the main author, and a code given up once public is never handed to another amendment (`nextMemberSeq` reads the `previousCode` of these events). One not published yet has no code to move. The main author cannot change while a transactional over the amendment is open (409), also when the amendment is itself a transactional, and `createTransactionalAmendment` re-checks its parents' main authors under the document lock. It records `amendment_authors_changed` (`{ from, to }` with member ids, plus `code` and `previousCode` when the code changes), which the history shows and the authors read in their news.
- The workspace reads amendments one at a time: the detail (`AmendmentDetail`) shows first the code, who presents it and one status (`amendmentStatusLine`), what changes, why, and the panels that are the viewer's turn; everything else goes under "Ver detalles". Never fold a panel that asks the viewer to act, and never switch the text view when an amendment is selected (only the mode tabs and "Ver en el documento" do).
- An amendment with co-authors has a main author (`AmendmentDto.mainAuthorId`, stored as `meta.presentingMemberId`); with several authors the bodies must name it (`mainAuthorMemberId`).
- Transactionals link 1..N parents through `amendment_sources`. They build only on published, submitted, admitted and undecided amendments. Any account with `amendment:create` acting for a member (or the Mesa) can propose one. Its parties are the main authors of its parents (acceptance rows with the role `author`; `proponent` rows are leftovers of the earlier rule and are ignored). One proposed by a member is `pending_authors` until every party accepts it (any rejection closes it as `withdrawn`), then goes to the Secretaría (`validate` answers 409 before that, and the inbox lists it read only). Validating a transactional always publishes it (`publishOnValidation`). Once validated and accepted, whichever comes last, it replaces its parents (they become `transacted`) and follows the normal flow; one the Mesa presents is validated and published at once and replaces them when the parties accept in the room. Replacing them closes every other submitted transactional over any of them (`lapsed`, reason `sources_transacted`): every path that calls `replaceSources` locks those competitors in the same ordered pass (`findCompetitors`). Settling a parent any other way (withdrawn, lapsed, declared inadmissible, voted, or incorporated by the main presenter's acceptance) closes the pending transactionals over it at once (`withdrawn`, `amendment_withdrawn` with `by: "sources_closed"`): every such path locks them in the same ordered pass and calls `closeTransactionalsOver` (`server/utils/domain/transactionalClosure.ts`). The closed transactional gets the parent's `decidedAt` and no `outcomeNote` (clients word the reason in the viewer's language from its parents), and its authors and parties see it in their news with nobody named (`by` null), also when their own act closed it. It is undone the same way: when that parent goes back to undecided before the final vote (the main presenter's answer changes, the Mesa reopens its decision, the rule goes back to `vote`, the assembly readmits it), the transactionals closed over it come back (`submitted`, `amendment_reopened` with `reason: "source_reopened"`, `sourceId` and `sourceCode`, news with nobody named) if their latest withdrawal is that automatic closure, every parent is open again (in whatever order they were reopened; a closure from before this rule too) and no main author rejected them (`transactionalsToRestore` and `reopenTransactionalsClosedBy`; every reopen path locks them and their other parents in the same ordered pass, `restoreLockIds`, then their acceptances). Reopening a transactional never restores its own parents, and one that never replaced them, or that a main author rejected, cannot be reopened (`transactionalReopenBlocker`). In the Mesa console a one-click decision that would close a pending transactional over the amendment (assent, de forma, withdraw, lapse, or acceptance where accepted amendments are incorporated) asks first, in the same dialog as the not-in-debate question, and says that reopening the amendment before the final vote brings it back unless another of its parents was decided (`sessionPendingTransactionalIds`, mirroring `transactionalsToClose`; `confirmSettling`), and the card of a closed one says so only while that holds (`isSessionClosureReversible`); "Ahora en debate" and the vote, admission and lapse dialogs name it and who it waits for (`useSessionTransactionalsOver`), and bulk assent (`sessionAssentPlan`) leaves out amendments with one pending (`transactional_pending`) and those that collide with one left out of the batch (`transactional_clash`).
- Majorities are counted on the members present by default (`DEFAULT_ASSEMBLY_SETTINGS.denominator`). The Mesa takes headcounts (`headcounts`, `server/utils/domain/headcounts.ts`): each active asociado in the room or not, and one not in the room may delegate to another (one per receiver); a delegation counts only while its receiver is in the room (`tallyHeadcount`). The active sectorials are marked only as in the room: they never vote, delegate, receive a delegation nor count, and each entry stores whether it had a vote (`headcount_entries.voting`), so a correction never turns one into a vote. The guests are the accounts with access and a guest role (`HEADCOUNT_GUEST_ROLES`: `Invitado`, `CAI`, `CdG`) (`headcount_guests`, with the name the account had at the count): marked in the room, never counted, and listed, with the members a new count offers, only to the Mesa; who was in the room stays public, never an email. The form and every list of a count follow the roll call (`compareRollCall` and `compareGuests` in `shared/utils/headcount.ts`): asociados, sectorials, guests, each in reverse alphabetical order of its name (followed by its university for a council). Quorum is data in each type's calendar rules (`quorum`, one threshold read through `quorumRulesOf`): the call a session opens in, the second when the type has two, so there is no first-call quorum and the Mesa never picks a call. Never hardcode it. A count is a snapshot (`eligible`, `present`, `required`); the latest one fills `present` on the server when a vote omits it (`withHeadcount`, its pure part `fillPresent`), and votes record it (`votes.headcountId`). Vote forms (the console's and `ReviewAdmissionModal`) open with `present` empty and the latest count as its placeholder and the base of their preview (`sessionFillPresent`, mirroring `fillPresent`), so what they show is what the server stores, also when a count arrives while a form is open; a figure the Mesa types is kept. Wherever a count's time shows (the vote form, the headcount panel, the live view, the projection), one from another Madrid day says its day (`formatMoment`), and the vote form adds a discreet line. Missing quorum only warns.
- Speaking turns (`speaking_turns`) are written down by the Mesa (`session:moderate`) through `/api/assemblies/[assembly]/speakers`; the Mesa's answer carries `history` (`speakerHistory`), so its form lists first who spoke most in the assembly, suggests the names written down before for the member chosen, and offers the councils and sectorials only while in the room or delegated at the latest headcount (a delegate may speak for them); attendees see who has the floor only while `live_state.speakersVisible` is true. Writes lock the assembly row first. Closing the assembly ends the turn with the floor, cancels the waiting ones and hides the list (`closeSpeakingTurns`), since a closed assembly refuses every speakers write.
- Overlaps come from `findOverlaps` and are computed from the ranges each amendment really changes. Relations between amendments live in `amendment_relations`.
- Every state change calls `recordEvent`, which appends to the history and notifies live listeners.

### Read marks

- Each account marks by hand what it has read among the published documents and their published amendments (`document_reads`, `amendment_reads`; `server/utils/domain/readMarks.ts`, `shared/utils/readMarks.ts`). Opening one never marks it, and nothing else takes a mark. The marks are the account's own (a council's account shares them): only the account changes them, and the only endpoints that return another account's are the statistics (`stats:view`, see Statistics).
- A mark stores the revision it was made on (`documentRevision`: the base version and the PDF; an amendment's operations and justification). Another revision reads as `changed` ("Con cambios"). What is left to read never counts what the account's member presents (`own`) nor amendments already decided (`open`).
- The hub fetches them once (`provideReadMarks`) and everything under it uses `useReadMarks`; never fetch them per row. A published document's page starts with `DocumentReadBar` (position, the documents before and after it in the order of the agenda, what is left and "Marcar como leído"). On the overview the reading progress lives in the agenda block's header: it is not a fourth block.
- "Publicado" is shown only to a document's presenters (`showsDocumentStatus`, and `DocumentHeader`): to everyone else a document they can read is public by being there. Rows show the read mark (`ReadMark`) instead.

### Statistics

- `/admin/estadisticas` opens with `stats:view`. Out of the box only the Secretaría and the Presidencia hold it (every key, `DEFAULT_ROLE_PERMISSIONS`) and an Admin by the bypass; whoever holds `user:manage_roles` or `role:manage_permissions` may grant it to another account or role. It shows, per assembly, each member, each account and each published document: read marks (read, `changed` and the total, never counting what the account's member presents), sign-ins (audit `auth.sign_in`), amendments and documents written and sent, amendments presented by outcome, late ones, headcounts (in the room, delegated, received), speaking turns, and which published documents each account opened, how often and for how long. A member's reading is its account that read most; its opening adds up all its accounts. `server/utils/domain/stats.ts` builds it through `GET /api/admin/stats` and `GET /api/admin/stats/users/[id]` (each mark and each document's opening of one account), and writes nothing.
- Opening is the one thing recorded for the statistics: `document_views`, one row per account, published document and day (Europe/Madrid) with `views` and `seconds`. `useDocumentReading` (the document page and `AgendaItemReader`) posts `POST .../documents/[document]/reading` once when a published document opens and every `READING_BEAT_MS` with the seconds the page was visible with someone at it (input in the last `READING_IDLE_MS`, or the focus in the embedded PDF), and on leaving or hiding with `keepalive`. `recordDocumentReading` credits each beat at most `READING_BEAT_MAX_SECONDS` and never more than the time since that account's last beat on the document (plus `READING_SLACK_SECONDS`), in SQL, so two tabs never count twice. It keeps nothing for a document that is not published nor while an Admin impersonates; the row is the record (`NON_RECORDING_MUTATIONS`). Call it time open, never time read: inside a PDF nothing tells.
- It names every account with the member it acts for, so `stats:view` sees the executive offices (`canSeeExecutiveMembers`). Private notes never reach it, not even counted.
- Online accounts: Usuarios and Estadísticas put a green dot on the avatar (`CommonAccountAvatar`) of every account that used the platform in the last `ONLINE_WINDOW_MINUTES` (`AdminUserDto.online`, `StatsAccountDto.online`). `markSeen` (`server/utils/live/online.ts`) runs in `getAuthUserWithRole` and on every live-stream heartbeat, always for the real user, never the account an Admin acts as. It lives in this process's memory only, like the editors' presence: never stored, logged or sent anywhere else, and everyone reads offline after a restart.

### Email notifications

- What is notified by email, to whom and how often is data, edited at `/admin/notificaciones` (`notification:manage`, held by the Secretaría and the Presidencia through every key): one row of `notification_settings` read over `DEFAULT_NOTIFICATION_SETTINGS` (`readNotificationSettings`), with a general switch and, per kind (`NOTIFICATION_KINDS` in `shared/constants/notifications.ts`), on or off, the roles it goes to (the `roles` audience) and the frequency (`immediate`, one email per notice; or `daily`, one summary per account at 08:00 Madrid, pg-boss queue `notifications-digest`). Every notice is `immediate` by default except `amendment_submitted`, `daily`: amendments come in bursts before the deadline. Saving uses optimistic locking and writes `notifications.update`; the test email writes `notifications.test`. Never hardcode who gets a notice.
- The `presenters` audience is never a setting: the accounts linked to the members a document or an amendment concerns (its presenters, its authors, a transactional's parties). Nobody is told about their own act: never the account that did it, and for those notices no account of the member that did it; what an Admin did while impersonating an account reaches it, as in the news.
- `recordEvent` puts every event that may notify (`eventMayNotify`, `server/utils/notifications/triggers.ts`) in `notification_outbox`, in the transaction of the change. Never send an email from inside a transaction or a request: the sender (`server/utils/notifications/runner.ts`, woken by the live hub's LISTEN and every 30 s) reads the outbox once committed, plans one `email_deliveries` row per account and notice (`noticesForEvent` in `rules.ts` is the rule, pure; `planDeliveries` in `plan.ts`; `dedupeKey` unique per account) and sends them with retries. A transactional reaching the Secretaría is told once whichever path gets it there (`transactional_ready:<id>`).
- An email is composed when it goes (`composeNotice`, `server/utils/notifications/compose.ts`) as its account sees things then: `canSeeAssembly`, `canSeeDocument`, `canSeeLoadedAmendment` (otherwise `not_visible`) and `visibleAcronym`, so the offices read as "CEA" for whoever may not see them. It carries the code, the title, who presents it, a correction note to the presenters it was written for, and a link; never the text of a document or an amendment. The stored row keeps the subject once sent, never the body nor the address; the log shows the subject only to `document:manage`.
- Every subject starts with its assembly in brackets, `[80.ª AGO]` (`EmailNotice.tag`, `formatAssemblyLabel`; a summary names each of its assemblies once), so the inbox tells assemblies apart. Composers write the subject without it.
- Emails are in Spanish only, like the web's transactional emails, drawn like the platform (`server/utils/notifications/template.ts`: Raleway with lining figures, slate neutrals, `creup-red-900` for the button and accents, the assembly as a badge, a card with the light logo `public/marca/correo-cabecera.png`; tables and inline styles, everything escaped, a plain text part). A daily summary lists its notices with links, not one button each. Their copy lives in `compose.ts`, not in `i18n/locales`; the admin page is UI and goes through i18n as usual.
- Logs carry `accountRef` (`emailFingerprint`), never an address, and SMTP errors go through `describeSmtpError`.

### Private notes

- Each account keeps private notes on a published document (`document_notes`; `server/utils/domain/documentNotes.ts`, `shared/utils/documentNotes.ts`): about the whole document, or on a stretch of one block of its text (block id, character offsets into the block's text as it shows, and the text it covered, `quote`). They are the account's own (a council's account shares them): every read and write is keyed by `actor.user.id`, and no endpoint returns another account's.
- An Admin acting as the account is that account here too: it reads and writes its notes, and what it writes is recorded under the impersonation. The activity records only that one was written, changed or deleted (`document_note.*`, payload `anchored`), never its text nor where it is. Never add either to a payload, a log or an export.
- Nothing follows the document: when the text is published again, `locateNote` looks the quote up in the block, and a note it cannot place stays listed with its quote ("Sin ubicación"). Never delete notes because the text changed.
- `DocumentNotes` is the whole UI (the "Notas" button, the side panel, the dialog, the marks on the text), on the document page and in the reader of an agenda item. The marks are drawn with the CSS Custom Highlight API (`::highlight(cx-note)` in `main.css`) over the text ContentView renders: never write a note into the rendered HTML. "Añadir nota aquí" is in the text's right-click menu (`AmendmentTextActions`), next to "Hacer enmienda aquí".

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
- `/api/admin/**` opens by permission: users, their roles, member links and grants need `user:manage_roles`; roles and the permission catalog need `role:manage_permissions` (reading roles needs either); the statistics need `stats:view`; the email notifications need `notification:manage`. Each endpoint checks its own with `requireAnyPermission`, and only an Admin gives or takes the `Admin` role. A non-Admin never raises its own access nor locks itself out: not its own role, its own account's grants or member link, not `user:manage_roles` or `role:manage_permissions` taken away from the role it holds, and no key it does not hold itself (`adminGrantViolation`). The last Admin cannot leave the `Admin` role.
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
- `app/composables/shell/*` and `ShellBreadcrumbs`: the breadcrumb row. Every page with the default layout puts `<ShellBreadcrumbs />` in its panel header, right after the navbar (the assembly hub does it for all its pages); the trail comes from the route (`-trail.ts`), so a new route gets its step there, and pages never add their own "back" link up the hierarchy. A document's trail goes through the agenda item it hangs from ("Orden del día > 3. Resoluciones > RES 4"), whatever page it was opened from: `useDocumentBreadcrumb` registers those items from the agenda. A page of a document names it with `useDocumentBreadcrumb` (client only, once mounted: the row renders before the page loads the document); the page of an agenda item (`orden-del-dia/[item]`, keyed by the item's slug, `AgendaItemDto.slug` from `agendaItemSlugs`, and by its id when the viewer may not read its title; link to it only through `agendaItemPath`) names itself and the items above it the same way with `useAgendaItemBreadcrumb`. Pages sized to the viewport take `--shell-banner-height` (the impersonation banner, 0 without it) and `--shell-breadcrumb-height` off; the dashboard's sidebar and panels fill their group (`min-h-full` in `app.config.ts`), never a whole screen.
- `ShellWelcome` and `app/components/shell/-welcome.ts`: the welcome, mounted client only by the default layout. It opens by itself until this browser closes it (`WELCOME_SEEN_STORAGE_KEY` in `localStorage`) and again from "Ayuda" in the user menu (`ShellUserMenu`). Like the language, the theme and the content preferences it belongs to the browser, never to the account: one account may be shared by several people (a council's account is the council). Never open it by itself or record it while an Admin impersonates (`welcomePending`). Audit rows `user.onboarding_seen` are from before. Its wording follows permissions and the member's kind (`welcomeAudience`; the CAS has its own, `cas`), never the role name alone.
- `ShellPreferences`: language, theme and the content accessibility preferences as visible radio groups, shown by "Preferencias" in the user menu and by the welcome's last step. Add a preference there, never as a submenu of the user menu.
- `app/composables/assembly/-sections.ts` and `useAssemblySections`: the one list of an assembly's sections, for the sidebar and the phone toolbar of the hub. Add a section there, never in one of the two menus.
- `HomeFold` (`app/components/home/Fold.vue`): the home page and the assembly overview keep at most three blocks in first plane, for every role: on the home page "Tareas pendientes" (last on the page, in the DOM too, when there is nothing to do), the next deadline of the calendar and the upcoming assemblies; on the overview "Tareas pendientes", the agenda summary and, beside it, the calendar, whose header carries the next deadline, with the assembly's figures under it in the same column. Anything else goes under them in a `HomeFold`, folded by default and remembered per browser; never add a fourth block.
- First plane of a page: only notices about that page's own subject, each fact once and in its quietest form (a document's amendment deadline is the line in `DocumentHeader`, never a box as well; the hub's next deadline and its phone status button stay off a document's pages and the overview has its own block), and one main action, two at most. Everything else goes in a "Más" menu (`moreItems` on the document page and the agenda page; a lone entry shows as its own button). `ExportButton` with `hide-idle` is started from such a menu through its exposed `start`.
- `server/utils/live/hub.ts`: live updates through Postgres `LISTEN/NOTIFY` and SSE. The stream's heartbeat is a named `ping` event every 25 s (`liveHeartbeat`, `server/utils/live/sse.ts`), never an SSE comment, which EventSource never exposes. `useAssemblyLive` is the only EventSource client: it reopens after 60 s without `ready`, `change` or `ping` on a visible page (counted as a failure: backoff, polling after 3), on `online`, on `pageshow` with `persisted`, and when a page hidden over 30 s comes back with a missed heartbeat (`app/composables/live/-watchdog.ts`); each reopen sets `missedChanges`, so the next `ready` refetches.
- `useComposerLeaveGuard` (`app/composables/amendment/useComposerLeaveGuard.ts`): every composer guards leaving with it (route leave, route update when the path changes, since another document is the same page remounted, never a query-only change; and `beforeunload`). A new composer uses it, never its own guards. The read bar hides while a composer is open.
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
- A release must still run on the schema of the next one: the previous
  release keeps running while the migration applies, and after a
  `scripts/rollback.sh`. Drop or rename a table or column, or change the
  shape of a JSON column (`calendar_rules.quorum`, `assemblies.settings`,
  payloads, operations), one release after the code stops reading the old
  form, never in the same one; until then write or read both. Precedent:
  0021 dropped `headcounts.call` and changed `calendar_rules.quorum`, which
  the previous release read. For `users` it is mandatory: better-auth selects
  every column of the row on each request. `users.onboarding_seen_at` is
  unused and waiting to go.
- The image ships `drizzle/meta/_journal.json`: `scripts/rollback.sh`
  compares it with `drizzle.__drizzle_migrations` and refuses, without
  `--force`, an image older than the database. `scripts/deploy.sh` dumps the
  database (`backups/db/asambleas-predeploy-<date>.dump`, the last 10 kept)
  before migrating and stops if the dump fails; DEPLOYMENT.md "Restaurar"
  says how to restore one.

## PDF Export

Flow:

1. `POST /api/assemblies/[assembly]/export` or `POST /api/assemblies/[assembly]/documents/[document]/export` creates a pg-boss job. Queues are created on boot (`createQueue`).
2. The worker loads the data (`buildData.ts`) and builds the pdfmake definition (`pdfBuilder.ts`); pdfmake lays it out and renders it in a separate Node process (`renderPdf`, `server/utils/export/pdfRender.ts`, like the DOCX converter), with its own heap ceiling (`PDF_RENDER_LIMITS`), a timeout and an env allowlist, one render at a time across both queues (`withRenderSlot`), so the room keeps answering while a PDF is made. Never use worker_threads. The definition crosses as JSON: every function in it comes from `pdfFunction` or `constantLayout` (`pdfSerial.ts`), and `serializePdfDefinition` refuses anything else. A render out of heap, time or room is not retried (`PdfRenderLimitError`); one the kernel kills is. The worker logs `export-worker.timing`. Never replace `pageBreakBefore` with unbreakable stacks: pdfmake silently clips what does not fit on a page. The assembly dossier (`POST /api/assemblies/[assembly]/export`) needs `assembly:manage`, checked again by the worker.
3. Worker writes metadata and PDF to `EXPORT_STORAGE_DIR`.
4. Client polls `GET /api/exports/[jobId]/status`.
5. Client downloads through `GET /api/exports/[jobId]/download`.

Security and reliability:

- Download/status must verify the requester is the job owner or has the required permission.
- Do not store generated PDFs only in memory.
- Include `EXPORT_STORAGE_DIR` in backups.
- Keep PDF labels localized and use shared assembly/date formatters.
- Raleway font files must be available from `server/assets/fonts` after build, and the letterhead logos from `server/assets/brand`.
- The template's approval line ("Aprobada por [Mayoría] en la … el [Día] …") is recognised by `shared/utils/content/approvalLine.ts`, shared by the Word import (`templateHeader.ts`, `DocxImport`) and the PDF export: a document's PDF fills an unfilled one from the final vote that approved it (and then skips its own vote line) or leaves it out before; the stored text never changes.
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
- nuxt-security's `xssValidator` stays off: Zod, `blocksSchema` and escaped rendering cover XSS, and it refused plain texts such as «<<Ley>>» or «>50 %». Its rate limiter counts per IP plus the matching route rule, so it is off for `/api/assemblies/**`, `/api/exports/**` and `/api/me/**` (a whole room shares one IP); uploads and export requests keep buckets of their own (`UPLOAD_RATE_LIMIT`, `EXPORT_RATE_LIMIT` in `nuxt.config.ts`). A new endpoint there that reads uploads or queues work gets its own `rateLimiter` rule, or it inherits `false`. Never put a security header in a plain `headers` route rule (nuxt-security turns it into a bucket of its own; use `security.headers`). `server/securityRules.test.ts` replays the module's rule resolution: keep it in step with `nuxt.config.ts` and re-derive it when nuxt-security is upgraded.
- The projection reads as the room (`?view=room`, `requireViewer`): only the Mesa may ask for it, and the answer is what an account that sees only what is public reads.
- Impersonation only for the real Admin role; the admin section, `/api/members` and `/api/calendar-rules` read-only while it lasts; `x-acting-user` on unsafe requests.
- An account deleted in the Intranet has no access (`accessRevokedAt`), checked on every request and found by the daily re-check even if it never signs in again; only an authenticated Intranet lookup gives it back.
- The Intranet token never travels over `http:` to a public host in production, and logs never carry an email (`accountRef`).
- Activity readers re-check visibility with the current actor and never show others' IPs or emails to non-Admins.
- Email notifications leave through the outbox after commit, are composed with the recipient's visibility, never carry document or amendment text, and never put an address in a log, an audit row or the delivery log.
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
pnpm verify    # lint, format:check, typecheck, i18n:check, i18n:audit-identical and test
bash ./scripts/deploy.sh    # pnpm verify, build, push to GHCR and roll out on the VPS (DEPLOYMENT.md); refuses a dirty tree without --allow-dirty, asks before deploying while an assembly is in session, dumps the database before migrating; --seed also runs the RBAC seed
bash ./scripts/rollback.sh  # previous image; refuses one older than the database's migrations without --force (restore the pre-deploy dump first)
bash ./scripts/clone-prod-db.sh  # replace the local database and uploads with production's (DEPLOYMENT.md); backups/ keeps both sides
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

`pnpm verify` runs all of it except `pnpm build`, and `scripts/deploy.sh` runs it before building; only `DEPLOY_SKIP_VERIFY=1` skips it (`DEPLOY_SKIP_BUILD=1` does not).

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
