# CREUP Assemblies & Amendments — Agent Instructions

## Project Overview

Internal platform for CREUP (Coordinadora de Representantes de Estudiantes de Universidades Públicas) to manage assemblies, agenda items, documentation, and amendments. Separate repository from the public website (`creup/web`).

**Key priorities:**
- Mandatory Google authentication before any access.
- External role synchronization from CREUP intranet.
- Permission-based RBAC with editable role permissions.
- Assembly lifecycle with status workflow.
- Document management (platform editor + PDF upload).
- Amendment workflow: Secretaría validation → proponent decision → assembly vote.
- Diff display and PDF export with accessibility options.

---

## Tech Stack

- **Framework:** Nuxt 4 + Nitro server routes.
- **UI:** Nuxt UI v4 + Tailwind CSS v4.
- **Auth:** `better-auth` with Google OAuth. Session storage via Drizzle PostgreSQL adapter (no Redis).
- **Validation:** Zod for all untrusted input.
- **Database:** PostgreSQL + Drizzle ORM. Session and job data also in PostgreSQL.
- **Background jobs:** `pg-boss` (PostgreSQL-based queue) for async PDF export.
- **i18n:** `@nuxtjs/i18n` — Spanish (default) and English. UI only; document/amendment content is in whatever language the author writes.
- **Accessibility:** `@nuxt/a11y`.
- **Analytics:** `nuxt-umami` (self-hosted, cookie-free).
- **Diffs:** `diff-match-patch` — compact patch storage for amendments (NOT full HTML copies).
- **PDF generation:** `pdfmake` with Raleway font embedded.
- **Infra:** `docker-compose.yml` with PostgreSQL + Adminer.
- **Permission cache:** In-memory LRU Map (TTL 60s, covers 5 system roles).

---

## Language Rules (Mandatory)

- **All code and code comments must be in English.**
- **All UI text must be available in Spanish AND English** via i18n keys — this includes admin pages, error messages, labels, buttons, badges, and toasts.
- Use i18n keys for every user-visible string. Never hardcode UI text.
- Document and amendment content is not translated — it appears as written.

---

## Visual Identity

Same as the `creup/web` project. Copy `app/assets/css/main.css` from `web` and remove equality-purple/members-map sections.

**Primary colors:**
- `creup-red-900`: `#792225` (light mode primary)
- `creup-blue-950`: `#163866` (light mode secondary)

**Fonts:** Raleway (sans, Google Fonts), Red Rose (serif, local), Fira Code (mono, local).
**Accessible fonts:** Atkinson Hyperlegible, OpenDyslexic — loaded via `@nuxt/fonts`, applied to document/amendment content only (not UI chrome).

**app.config.ts:**
```ts
ui: { colors: { primary: 'creup-red', secondary: 'creup-blue' } }
```

---

## Authentication & External Role Sync (Mandatory)

### Login policy

- First interaction must be authentication with Google.
- Unauthenticated users must be redirected to `/login`.
- All authenticated users can sign in — no allowlist restriction.

### External role endpoint

After authentication, POST to `CREUP_ROLE_API_URL` env var (default: `https://intranet.creup.es/api/user/role`).

Request body:
```json
{ "email": "user@creup.es" }
```

Expected response:
```json
{ "role": "CEA", "name": "Vocalía de Digitalización y Transparencia CREUP", "initials": "VDT", "university": null }
```

### Synchronization rules

Always update: `externalRole`, `externalName`, `externalInitials`, `university`, `lastRoleSyncAt`.

Platform role assignment:
- **New user, no roleId:** external `"Asociado"` → platform role `Asociado`; anything else → `Invitado`.
- **Existing `Asociado`** + external changes to non-`"Asociado"` → switch to `Invitado`.
- **Existing `Invitado`** + external becomes `"Asociado"` → switch to `Asociado`.
- **Existing `Admin` / `Secretaría` / `Moderador`** → **DO NOT change role**.

If external API is unreachable: log warning, do NOT block sign-in. New user with API failure → `Invitado`.

### Initial admin bootstrap

`INITIAL_ADMIN_EMAIL` env var (default `tic@creup.es`) → assigned `Admin` role on first sign-in, overriding normal new-user logic.

---

## RBAC Model (Mandatory)

- Five system roles: `Admin`, `Secretaría`, `Moderador`, `Asociado`, `Invitado`.
- Role-permission matrix stored in DB, editable via admin UI.
- **`Admin` bypasses ALL permission checks** — no permission matrix needed.
- Permission keys are strings in DB — add new ones without schema migration.

### Default permission assignments

| Role | Permissions |
|---|---|
| Admin | All (bypass) |
| Secretaría | assembly:create, assembly:manage, document:create, document:manage, amendment:create, amendment:manage, amendment:review, assembly:vote_result |
| Asociado | document:create, amendment:create |
| Moderador | (none — same as Invitado for now) |
| Invitado | (none — view-only) |

### Permission keys

```
user:manage_roles        — change user platform roles
role:manage_permissions  — edit role-permission matrix
assembly:create          — create assemblies
assembly:manage          — edit assemblies, change status
document:create          — create/submit documents
document:manage          — edit/delete/accept documents
amendment:create         — create/submit amendments
amendment:manage         — edit own draft amendments
amendment:review         — Secretaría validate/mark formal/reject amendments
assembly:vote_result     — record assembly vote outcome
```

---

## Domain Model

### Assemblies

Fields: `number`, `type` (AGO/AGE/AGET), `status`, `startDate`, `endDate`, `location`.

**Status workflow:**
```
draft → provisional → definitive
        ←── (revert allowed)
```
- `draft`: visible only to Admin + Secretaría.
- `provisional`: visible to all, fully editable.
- `definitive`: visible to all; agenda structure locked. Adding/editing sub-items to existing items is still allowed.

### Agenda Items (recursive tree, unlimited depth)

Fields: `assemblyId`, `parentId` (self-reference), `title`, `order`, `allowDocumentSubmission`, `documentSubmissionDeadline`, `allowAmendments`, `amendmentDeadline`.

**Self-referencing FK must be added via raw SQL in migration** (Drizzle limitation):
```sql
ALTER TABLE agenda_items ADD CONSTRAINT fk_agenda_items_parent
  FOREIGN KEY (parent_id) REFERENCES agenda_items(id) ON DELETE CASCADE;
```

Load strategy: one flat query per assembly, build tree client-side with hierarchical numbering ("1", "1.1", "1.2.3").

### Documents

Fields: `agendaItemId`, `type` (platform/pdf), `title`, `content` (rich text HTML, platform only), `fileUrl` (pdf only), `submittedBy` (null = official), `proponentId` (FK users), `status`, `contentHistory` (jsonb), `contentVersion` (SHA-256 hash of current content).

**proponentId rules:**
- Official documents (created by Secretaría): Secretaría assigns explicitly.
- User-submitted documents: auto-set to `submittedBy` when accepted.
- If `proponentId` is null when an amendment needs proponent decision, Secretaría must assign first.

**Document types:**
- `platform`: created in rich text editor (TipTap). Only this type supports amendments.
- `pdf`: uploaded file. No amendments allowed.

**Status:** `draft` → `pending_review` → `accepted`.
- Official docs: `accepted` immediately on creation.
- User-submitted docs: `pending_review` until Secretaría accepts.

**contentHistory** (jsonb array, populated only on amendment incorporation):
```ts
[{ contentHash: string, amendmentId: string, type: 'formal'|'accepted_proponent'|'approved_vote', incorporatedAt: string }]
```

### Amendments

**Storage: diff-match-patch patches, NOT full HTML copies.** Documents can be many pages with up to 60 amendments — storing full copies per amendment is unacceptable (60 × 50KB = 3MB per document).

Fields: `documentId`, `submittedBy`, `contentPatch` (diff-match-patch format), `baseContentVersion` (SHA-256 of document.content at creation), `justification`, `type` (regular/formal), `status`, `parentAmendmentId` (self-reference for transactionals), timestamps.

**Self-referencing FK:**
```sql
ALTER TABLE amendments ADD CONSTRAINT fk_amendments_parent
  FOREIGN KEY (parent_amendment_id) REFERENCES amendments(id) ON DELETE CASCADE;
```

**Shared utilities `shared/utils/diff.ts`:**
```ts
computePatch(base: string, modified: string): string
applyPatch(base: string, patch: string): string | null
hashContent(content: string): string  // SHA-256 hex
```

**Amendment status workflow:**

```
STEP 1 — Asociado creates:
  draft (visible: submitter + Secretaría + Admin)
    ↓ [submitter sends]
  pending_review

STEP 2 — Secretaría reviews:
  pending_review
    → rejected_secretaria    (invalid — end)
    → formal                 (de forma → auto-incorporated → end*)
    → accepted_secretaria    (valid → goes to proponent)

STEP 3 — Document proponent decides:
  accepted_secretaria
    → accepted_proponent     (accepts → incorporated → end*)
    → rejected_proponent     (rejects → pending assembly vote)

STEP 4 — Assembly vote result (recorded by Secretaría):
  rejected_proponent
    → approved_vote          (assembly approves → incorporated → end*)
    → rejected_vote          (assembly rejects → end)

*end* = applyPatch(document.content, contentPatch) → update document.content + append to contentHistory
```

**"De forma" (formal) amendments:**
- Secretaría marks during review: `type = 'formal'`, status → `formal`.
- Auto-incorporated without proponent review.
- Visible with "De forma" badge in all views.

**Transactional amendments (multiple negotiation rounds):**
- Negotiation between `document.proponentId` and `amendment.submittedBy`.
- Created when amendment is in `accepted_secretaria`.
- `parentAmendmentId` chains: original → trans1 → trans2 → ...
- Each round is a new row with `parentAmendmentId` pointing to previous.
- Draft visibility: submitter + Secretaría + Admin + all authors in the chain.
- Each transactional goes through the full workflow (Steps 2-4).
- Utility `getEffectiveAmendmentContent(amendmentId)`: traverse chain to latest version.

**Visibility rules:**

| Status | Visible to |
|---|---|
| draft (regular) | Submitter + Secretaría + Admin |
| draft (transactional) | Submitter + Secretaría + Admin + all chain authors |
| pending_review | Submitter + Secretaría + Admin |
| rejected_secretaria | All authenticated |
| formal | All authenticated (badge "De forma") |
| accepted_secretaria | All authenticated |
| accepted_proponent | All authenticated (badge "Aceptada por proponente") |
| rejected_proponent | All authenticated (badge "Rechazada — Pendiente votación") |
| approved_vote | All authenticated (badge "Aprobada en votación") |
| rejected_vote | All authenticated (badge "Rechazada en votación") |

---

## Role Behavior Summary

| Role | Can see | Can do |
|---|---|---|
| Admin | Everything | Everything |
| Secretaría | Everything | Create/manage assemblies, documents, review amendments, record vote results |
| Asociado | Assemblies (provisional+), documents (definitive), accepted amendments | Submit documents (where allowed, within deadline), submit/edit amendments (where allowed, within deadline) |
| Moderador | Same as Invitado | Same as Invitado (to be expanded) |
| Invitado | Assemblies (provisional+), documents (definitive), accepted amendments | Nothing (view only) |

**Single document shortcut:** if an agenda item has exactly 1 document, open it directly. If multiple, show list.

---

## Diff Display & Accessibility Preferences

User accessibility preferences stored in **localStorage** (no DB — no cross-device persistence needed at this stage).

**Composable `useAccessibilityPreferences()`:**
- `diffDisplayMode`: `'color'` | `'marks'`
  - `color`: additions `bg-green-100 text-green-800`, deletions `line-through text-red-700`
  - `marks`: additions `underline font-bold`, deletions `line-through` (for color blindness)
- `contentFont`: `'raleway'` | `'atkinson'` | `'opendyslexic'`
  - Applied via CSS variable `--user-content-font` to document content and editor only (NOT UI chrome)

---

## PDF Export (Async Background Job)

PDF generation is async via `pg-boss` (PostgreSQL-based queue — no Redis needed).

Flow:
1. `POST /api/assemblies/[id]/export` → creates pg-boss job → returns `{ jobId }`.
2. Worker (`server/plugins/export-worker.ts`) processes job → generates PDF with `pdfmake` → stores file.
3. Client polls `GET /api/exports/[jobId]/status` → `pending | processing | done | failed`.
4. Client downloads `GET /api/exports/[jobId]/download` when done.

PDF format: CREUP header, assembly metadata, hierarchically numbered agenda items, document content (HTML → pdfmake nodes), amendment list with status badges. **Headings in CREUP red (#792225). Font: Raleway.**

---

## Admin Area

Only `Admin` can access `/admin/**` routes and `/api/admin/**` endpoints.

MVP features:
- List users, change user roles.
- List roles, view/edit role-permission matrix.
- All admin UI text in i18n (ES + EN).

---

## Server/API Conventions

- Keep handlers small and focused: read params → validate with Zod → enforce auth/authorization → DB operations → return stable JSON.
- Never trust client-provided data.
- Use `createError` with proper HTTP status.
- Error messages for users in i18n (both languages). Internal/log messages in English.
- Zod validation on all untrusted inputs via `validateBody`, `validateQuery`, `validateRouteParams`.
- `requirePermission(event, key)` for authorization checks — Admin bypasses automatically.
- Use `runCrudTransaction(db, fn)` for mutations that touch multiple tables.
- Optimistic locking via `assertOptimisticLock` for concurrent edit protection.

---

## Database & Drizzle

- Schema lives in `server/db/schema/`.
- Drizzle config: `drizzle.config.ts`.
- Migrations: `drizzle/`.
- Seed script: `drizzle/seed.ts`.
- CUID primary keys: `text('id').primaryKey().$defaultFn(cuid)`.
- Timestamps: `timestamp({ withTimezone: true, mode: 'date' }).defaultNow()` + `.$onUpdate(() => sql\`now()\`)` for updatedAt.
- Self-referencing FKs (agenda_items, amendments) added via raw SQL in migrations.
- No locale check helpers (single language content).

**Schema files:**
```
server/db/schema/
  common.ts      — cuid helper
  auth.ts        — users (extended), sessions, accounts, verifications
  rbac.ts        — roles, permissions, rolePermissions
  assembly.ts    — assemblies
  agendaItem.ts  — agenda_items (recursive tree)
  document.ts    — documents (with contentHistory jsonb)
  amendment.ts   — amendments (contentPatch, baseContentVersion, chain)
```

---

## i18n

- `@nuxtjs/i18n` with locales `es` (default) and `en`.
- Strategy: `prefix_except_default`.
- Files: `i18n/locales/es.json`, `i18n/locales/en.json`.
- Scripts: `pnpm i18n:check` (key parity), `pnpm i18n:audit-identical`.
- Scope: UI only. Document/amendment content is not internationalized.

---

## Local Development Workflow

### Infra

```bash
docker compose up -d
```

Services: PostgreSQL (5433) + Adminer (8089).
No Redis — pg-boss uses the main PostgreSQL database.

Adminer: `http://localhost:8089`
- system: `PostgreSQL`, server: `postgres`, user/password/db: from `.env`

### App

```bash
pnpm dev        # Start dev server (default port 3001)
pnpm build
pnpm preview
pnpm lint
pnpm lint:fix
pnpm typecheck
```

### DB

```bash
pnpm db:generate   # Generate Drizzle migrations
pnpm db:migrate    # Apply migrations
pnpm db:seed       # Seed system roles and permissions
pnpm db:studio     # Open Drizzle Studio GUI
```

### i18n

```bash
pnpm i18n:check             # Verify key parity between locales
pnpm i18n:audit-identical   # Find identical translations (candidates for removal)
```

---

## Engineering Principles

- Keep solutions minimal and explicit.
- Prefer Nuxt UI components over custom implementations.
- Plan abstractions for known complexity upfront; implement only when the code needs them.
  - `useAmendmentWorkflow(amendmentId)` — encapsulates all amendment state logic
  - `useAmendmentChain(amendmentId)` — loads full transactional chain
  - `useDocumentContent(docId)` — current effective content (original + incorporated patches)
  - `DiffRenderer` wrapper — wraps `diff-match-patch`, swappeable without touching consumers
  - `requirePermission(event, key)` — extensible server-side authorization
- Accessibility baseline: semantic HTML, keyboard navigation, visible focus, meaningful labels.
- All accessible font and diff preferences via `useAccessibilityPreferences()` composable.
- Avoid premature abstractions beyond the above plan — extract helpers only when handlers become hard to read.
- Patch-based amendment storage (`diff-match-patch`) is mandatory — never store full HTML copies per amendment.
- Use `pg-boss` for all background jobs; do not block HTTP requests with PDF generation.

---

## Commit Guidelines

Use Conventional Commits:

```
feat: add amendment proponent decision workflow
fix: preserve admin role during external role sync
docs: document amendment status transitions
chore(deps): upgrade better-auth and drizzle packages
refactor: extract useAmendmentWorkflow composable
test: add API tests for amendment review endpoints
i18n: add English translations for amendment statuses
a11y: add ARIA labels to amendment diff view
```

---

## Pull Request Checklist

- Google auth remains mandatory before any access.
- External role sync logic follows the exact transition rules (especially Admin/Secretaría role preservation).
- Admin role remains full-access bypass.
- All UI text uses i18n keys — no hardcoded Spanish/English strings.
- Zod validation added/updated for all modified endpoints.
- Amendment patches use `diff-match-patch` format — never store full HTML copies.
- `requirePermission` called on all non-public endpoints.
- Background jobs (PDF export) go through pg-boss — never block HTTP requests.
- `pnpm lint` passes.
- `pnpm typecheck` passes.
- `pnpm i18n:check` passes (no missing keys).
