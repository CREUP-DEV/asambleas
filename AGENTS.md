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

| Area          | Technology                                          |
| ------------- | --------------------------------------------------- |
| Framework     | Nuxt 4 + Nitro                                      |
| UI            | Nuxt UI v4 + Tailwind CSS v4                        |
| Auth          | `better-auth` + Google OAuth + Drizzle adapter      |
| Database      | PostgreSQL + Drizzle ORM                            |
| Jobs          | `pg-boss` v12 on PostgreSQL                         |
| Validation    | Zod v4 (`zod/v4`)                                   |
| i18n          | `@nuxtjs/i18n`, locales `es` default and `en`       |
| Accessibility | `@nuxt/a11y`, content font preferences              |
| Security      | `nuxt-security`, CSRF double-submit cookie          |
| Analytics     | `nuxt-umami`, self-hosted and cookie-free           |
| Diffs         | `diff-match-patch`                                  |
| PDF           | `pdfmake`, Raleway bundled in `server/assets/fonts` |
| IDs           | `@paralleldrive/cuid2`                              |

## Local Defaults

- App: `http://localhost:3000`
- PostgreSQL: `localhost:5432`
- Adminer: `http://localhost:8080`
- Intranet API base: `NUXT_INTRANET_API_URL` (role sync falls back to `${base}/user/role`; members from `/usuarios/asociados` and `/usuarios/sectoriales`)
- Role sync env var: `NUXT_ROLE_API_URL`
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
  plugins/          export worker and live updates hub
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
- Diff UI must support color mode and marks mode. Render diffs, provenance and plain text through the shared engine (`shared/utils/content/render.ts`) and `app/components/content/*`, never with component-level diff logic.

## Authentication And Role Sync

- First interaction is Google authentication.
- Unauthenticated users go to `/login`.
- All authenticated Google users may sign in; there is no allowlist.
- After authentication, call `NUXT_ROLE_API_URL` with `{ "email": "user@creup.es" }`.
- Always update `externalRole`, `externalName`, `externalInitials`, `university` and `lastRoleSyncAt` when role sync returns data.
- If role sync fails, log a warning and do not block sign-in.
- `INITIAL_ADMIN_EMAIL` receives `Admin` on first sign-in.

Role assignment rules:

| Case                                                | Platform role result       |
| --------------------------------------------------- | -------------------------- |
| New user + external `Asociado`                      | `Asociado`                 |
| New user + anything else or sync failure            | `Invitado`                 |
| Existing `Asociado` + external no longer `Asociado` | `Invitado`                 |
| Existing `Invitado` + external becomes `Asociado`   | `Asociado`                 |
| Existing `Admin`, `Secretaria` or `Moderador`       | Keep current platform role |

## RBAC

System roles:

- `Admin`
- `Secretaria`
- `Moderador`
- `Asociado`
- `Invitado`

`Admin` bypasses all permission checks through the RBAC helper. Do not reimplement ad hoc admin bypasses.

Default permissions:

| Role       | Permissions                                                                                                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin      | All, via bypass                                                                                                                                                                                     |
| Secretaria | `assembly:create`, `assembly:manage`, `document:create`, `document:manage`, `amendment:create`, `amendment:manage`, `amendment:review`, `assembly:vote_result`, `session:moderate`, `member:manage` |
| Asociado   | `document:create`, `amendment:create`                                                                                                                                                               |
| Moderador  | `session:moderate`                                                                                                                                                                                  |
| Invitado   | none                                                                                                                                                                                                |

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

Use `requirePermission(event, PERMISSION_KEYS.X)`, `hasPermission`, `requireAdmin` and `getAuthUserWithRole` from `server/utils/auth/rbac.ts`. Domain endpoints use `requireActor` and its helpers from `server/utils/domain/actor.ts`.

## Domain Rules

Full model: [`docs/design.md`](docs/design.md). Endpoints and business rules: [`docs/api.md`](docs/api.md).

### Members

- Documents and amendments are presented by members (`members`): student councils (asociados), sectorials and executive areas.
- Asociados and sectorials are synced from the intranet roster (`/usuarios/asociados`, `/usuarios/sectoriales`) and keyed by acronym (the intranet's `initials`).
- `users.memberId` links an account to the member it acts for. In the intranet an Asociado account is the member itself.

### Assemblies

- Status: `draft -> convened -> in_session -> closed` (see `ASSEMBLY_STATUS_TRANSITIONS`).
  - `draft` is visible only to managers.
  - `agendaFinalizedAt` marks the final agenda (ODD definitivo): root agenda items are then locked.
- Each type keeps its own counter: `(type, number)` is unique.
- Calendar milestones live in `assembly_milestones`, seeded from `shared/utils/calendar.ts` and checked by `checkCalendar`.
- Per-assembly policies live in `assemblies.settings`. Always read them merged over `DEFAULT_ASSEMBLY_SETTINGS`.
- Public routes use readable slugs (`80-ago`). Resolve them server-side with `server/utils/domain/resolvers.ts`.

### Agenda Items

- Recursive tree through `parentId`. Load the rows flat and build the tree client-side.
- Reorder operations must validate parent existence, assembly ownership and cycles.

### Documents

- `format`:
  - `structured`: blocks, amendable when `amendable`;
  - `file`: an uploaded PDF, never amendable.
- Kind defaults (amendable, voted, majority) come from `DOCUMENT_KIND_DEFAULTS`.
- The proponent edits the working draft. Publishing freezes it as the immutable `base` version, and amendments anchor to that.
- The final vote stores the `consolidated` version produced by `consolidate`.
- PDF uploads must validate size, MIME and magic bytes.

### Amendments

- Operations: `replace`, `insert` and `delete`, anchored to base block ids. Validate them with `validateOps`. Only `totality_return` may have no operations.
- Status: `draft -> submitted ->` one of `approved`, `rejected`, `withdrawn`, `lapsed`, `transacted` or `inadmissible`. Each step is recorded in its own record:
  - admission, with `late` computed by the server;
  - proponent position;
  - votes;
  - decisions;
  - acceptances.
- Transactionals link 1..N parents through `amendment_sources`. They need every party's acceptance before they can be voted. Approving one marks its parents `transacted`.
- Overlaps come from `findOverlaps` and are computed from the ranges each amendment really changes. Relations between amendments live in `amendment_relations`.
- Every state change calls `recordEvent`, which appends to the history and notifies live listeners.

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
- All `/api/admin/**` endpoints require Admin.
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

Client CSRF pattern:

```ts
const csrfToken = useCookie(CSRF_COOKIE_NAME).value;
await $fetch(url, {
  method: "POST",
  headers: csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : undefined,
  body,
});
```

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
- `server/utils/live/hub.ts`: live updates through Postgres `LISTEN/NOTIFY` and SSE.
- `server/utils/auth/rbac.ts` and `server/utils/auth/roleSync.ts`: permissions and external role sync.
- `server/utils/validation.ts`, `server/utils/optimisticLock.ts`, `server/utils/crud.ts` and `server/utils/errors.ts`.
- `shared/utils/content/*`, the amendment engine:
  - `validateOps`, `diffPassage`, `findOverlaps`, `consolidate` and `previewAmendment`;
  - rendering, editor conversion and `globalReplaceOps`.
- `shared/utils/calendar.ts`, `shared/utils/votes.ts`, `shared/utils/slug.ts` and `shared/utils/diff.ts` (`hashContent`).
- `shared/utils/schemas/*`: Zod schemas matching `shared/types/api.ts`.
- `server/utils/export/*`: queue, storage and PDF building.

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
- Raleway font files must be available from `server/assets/fonts` after build.

pg-boss v12 reminders:

- `work(queueName, { batchSize: 1 }, handler)` receives `Job<T>[]`.
- Queues must exist before `send` or `work`: create them on boot with `createQueue` (idempotent).
- `send(queueName, data)` returns a job ID.
- `getJobById(queueName, jobId)` requires queue name first.
- Common states: `created`, `retry`, `active`, `completed`, `cancelled`, `failed`.

## Security Checklist

- Auth required for all non-auth routes.
- Permission checked server-side for every protected operation.
- Admin APIs are not protected by UI checks alone.
- Route params and body/query data validated before DB access.
- Mutations include CSRF and same-origin checks.
- Document content stored as validated blocks and rendered escaped; no raw HTML in `v-html`.
- Uploaded PDFs validated by type and file signature.
- Optimistic locking applied to shared updates.
- Unknown permission keys rejected, not silently ignored.
- Export downloads authorized.

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
- Google sign-in calls role sync and preserves privileged roles;
- admin pages reject non-admin users server-side;
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
