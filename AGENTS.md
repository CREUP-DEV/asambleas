# CREUP Assemblies - Agent Instructions

These instructions are the source of truth for agents editing this repository. `PLAN.md` is historical context only.

## Non-Negotiable Rules

- Follow these instructions before local preference or generic framework advice.
- Write code, identifiers and code comments in English.
- Put every user-visible UI string behind i18n keys in Spanish and English.
- Do not translate document or amendment content; users write that content directly.
- Keep Google authentication mandatory before any app access.
- Do not introduce Redis or Mailpit. Use PostgreSQL, pg-boss or in-memory cache as described here.
- Validate all untrusted input with Zod v4 from `zod/v4`.
- Protect every mutation with CSRF and same-origin checks.
- Sanitize rich text server-side before storage.
- Use patches for amendments. Never store full modified HTML copies per amendment.
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
| Jobs          | `pg-boss` v10 on PostgreSQL                         |
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
- Role sync env var: `NUXT_ROLE_API_URL`
- Export storage env var: `EXPORT_STORAGE_DIR`

## Repository Map

```text
app/
  components/       UI components grouped by domain
  composables/      Auth, permissions, locale, accessibility and workflow helpers
  layouts/          public and admin layouts
  middleware/       global auth redirect
  pages/            Nuxt pages
  utils/            client-side domain utilities
server/
  api/              Nitro endpoints
  db/               Drizzle client and schema
  handlers/         global auth/CSRF middleware
  plugins/          startup validation and export worker
  utils/            auth, RBAC, rich text, export, workflow and CRUD helpers
shared/
  constants/        roles, permissions, statuses and security constants
  utils/            schemas, rich text, diff, slug and config helpers
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
- Diff UI must support color mode and marks mode. Prefer the shared `app/utils/diffRenderer.ts` wrapper over direct component-level diff logic.

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

| Role       | Permissions                                                                                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin      | All, via bypass                                                                                                                                                |
| Secretaria | `assembly:create`, `assembly:manage`, `document:create`, `document:manage`, `amendment:create`, `amendment:manage`, `amendment:review`, `assembly:vote_result` |
| Asociado   | `document:create`, `amendment:create`                                                                                                                          |
| Moderador  | none                                                                                                                                                           |
| Invitado   | none                                                                                                                                                           |

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
```

Use `requirePermission(event, PERMISSION_KEYS.X)`, `hasPermission`, `requireAdmin` and `getAuthUserWithRole` from `server/utils/auth/rbac.ts`.

## Domain Rules

### Assemblies

Status workflow:

```text
draft -> provisional -> definitive
         <- provisional
```

- `draft`: visible only to Admin and Secretaria.
- `provisional`: visible to all authenticated users and editable by managers.
- `definitive`: visible to all authenticated users; root agenda structure is locked.
- Public routes should use readable slugs. Resolve slugs server-side before DB queries.

### Agenda Items

- Recursive tree through `parentId`.
- Load flat rows and build tree client-side with shared helpers.
- In definitive assemblies, do not alter locked root-item structure.
- Reorder operations must validate parent existence, assembly ownership and cycles.

### Documents

- `platform`: rich text document, amendable.
- `pdf`: uploaded PDF, not amendable.
- Platform document content must be sanitized server-side before insert/update.
- PDF uploads must validate size, MIME and magic bytes.
- `proponentId` is assigned by Secretaria for official documents and defaults to `submittedBy` for user documents.

### Amendments

Store only `contentPatch`, never full modified HTML snapshots.

Workflow:

```text
draft -> pending_review
  -> rejected_secretaria
  -> formal
  -> accepted_secretaria
    -> accepted_proponent
    -> rejected_proponent
      -> approved_vote
      -> rejected_vote
```

Statuses `formal`, `accepted_proponent` and `approved_vote` incorporate the patch into the document:

1. `applyPatch(document.content, amendment.contentPatch)`;
2. `hashContent(newContent)`;
3. update document `content` and `contentVersion`;
4. append a `contentHistory` entry with the resulting content hash.

Transactional amendments:

- are linked through `parentAmendmentId`;
- are allowed from `accepted_secretaria`;
- go through the same workflow;
- drafts must be visible to authors across the negotiation chain and to permitted managers.

The proponent decision step belongs to the document proponent. Secretaria should assign a proponent before that step instead of deciding as proponent.

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

Client CSRF pattern:

```ts
const csrfToken = useCookie(CSRF_COOKIE_NAME).value;
await $fetch(url, {
  method: "POST",
  headers: csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : undefined,
  body,
});
```

## Shared Helpers To Prefer

- `server/utils/auth/requireAuth.ts`: session helpers.
- `server/utils/auth/rbac.ts`: permissions and role checks.
- `server/utils/auth/roleSync.ts`: external role sync.
- `server/utils/validation.ts`: `validateCuid`, `validateAuthId`.
- `server/utils/routeResolvers.ts`: slug/CUID route resolution.
- `server/utils/optimisticLock.ts`: `assertOptimisticLock`, `buildOptimisticLockCondition`.
- `server/utils/crud.ts`: `runCrudTransaction`.
- `server/utils/errors.ts`: mutation error handling.
- `server/utils/richText.ts`: server-side DOMPurify sanitization.
- `server/utils/amendmentWorkflow.ts`: amendment transitions and incorporation.
- `server/utils/export/*`: queue, storage and PDF building.
- `shared/utils/diff.ts`: `computePatch`, `applyPatch`, `hashContent`.
- `shared/utils/richText.ts`: rich text checks and plain text extraction.
- `shared/utils/slug.ts`: readable route slugs.
- `shared/utils/schemas/*`: Zod schemas.

## Database And Migrations

- CUID2 primary keys use `text('id').primaryKey().$defaultFn(cuid)`.
- Timestamps use timezone-aware `timestamp({ withTimezone: true, mode: 'date' })`.
- `updatedAt` should use `.$onUpdate(() => sql\`now()\`)`.
- Self-referencing FKs may require raw SQL migrations.
- Edit schema files first, then run `pnpm db:generate`.
- Do not edit existing migration files after they have been committed.

## PDF Export

Flow:

1. `POST /api/assemblies/[id]/export` or document export endpoint creates a pg-boss job.
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

pg-boss v10 reminders:

- `work(queueName, { batchSize: 1 }, handler)` receives `Job<T>[]`.
- `send(queueName, data)` returns a job ID.
- `getJobById(queueName, jobId)` requires queue name first.
- Common states: `created`, `retry`, `active`, `completed`, `cancelled`, `failed`.

## Security Checklist

- Auth required for all non-auth routes.
- Permission checked server-side for every protected operation.
- Admin APIs are not protected by UI checks alone.
- Route params and body/query data validated before DB access.
- Mutations include CSRF and same-origin checks.
- Rich text sanitized before storage and before `v-html`.
- Uploaded PDFs validated by type and file signature.
- Optimistic locking applied to shared updates.
- Unknown permission keys rejected, not silently ignored.
- Export downloads authorized.

## Commands

```bash
pnpm dev
pnpm build
pnpm preview
pnpm lint
pnpm lint:fix
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
pnpm typecheck
pnpm i18n:check
pnpm i18n:audit-identical
pnpm build
```

Also verify manually when relevant:

- unauthenticated users land on `/login`;
- Google sign-in calls role sync and preserves privileged roles;
- admin pages reject non-admin users server-side;
- ES and EN UI both render new strings;
- document/amendment rich text remains sanitized;
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
