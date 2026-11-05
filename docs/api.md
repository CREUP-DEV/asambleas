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
  amendments (by id), acceptances, `live_state`. A transaction that moves the
  live projection from a document or amendment path, or moves a document to
  another agenda item, share-locks the assembly before the document, so the
  move serializes with an agenda delete of its target. Explicit locks are `FOR NO KEY UPDATE` or `FOR SHARE`,
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

| Method | Path                                | Who             | Notes                                                                                       |
| ------ | ----------------------------------- | --------------- | ------------------------------------------------------------------------------------------- |
| GET    | `/api/me`                           | any             | `MeDto`. `permissions` are the role's plus the user's own grants (see "Permissions" below). |
| GET    | `/api/me/work`                      | any             | `MeWorkDto`, see "Review and work" below.                                                   |
| GET    | `/api/members`                      | any             | `MemberDto[]`, active first, by acronym. `?all=1` also returns inactive members.            |
| POST   | `/api/members`                      | `member:manage` | Creates a member manually, typically an executive area.                                     |
| PUT    | `/api/members/[id]`                 | `member:manage` | Edits name, kind or active, with `updatedAt`.                                               |
| POST   | `/api/members/sync`                 | `member:manage` | Syncs the intranet roster. Returns `MemberSyncResult`.                                      |
| GET    | `/api/admin/users`                  | Admin           | Paginated user rows, each with `member` and `extraPermissions`.                             |
| PUT    | `/api/admin/users/[id]/member`      | Admin           | Body `{ memberId: string \| null }`. Links an account to a member, see below.               |
| PUT    | `/api/admin/users/[id]/permissions` | Admin           | Body `{ permissions: PermissionKey[] }`. Sets the user's own grants, see "Permissions".     |

**Intranet.** Every call to the intranet API (role sync, `POST /user/role`,
and the roster sync, `GET /usuarios/asociados` and `/usuarios/sectoriales`)
sends `Authorization: Bearer <NUXT_INTRANET_API_TOKEN>` when that variable
is set (a blank value counts as unset). The token is never logged.

**Permissions.** A user's permissions are the union of their role's
(`role_permissions`) and the ones an admin granted to that user alone
(`user_permissions`); Admin has every key. The same set backs `requireActor`,
`requirePermission`, `GET /api/auth/permissions`, `GET /api/me` and the export
worker, and it is cached per user for a minute (a change through the endpoint
below takes effect at once). `Presidencia` is a system role with the
Secretaría's default permissions, kept by role sync like `Secretaría`.

`PUT /api/admin/users/[id]/permissions` replaces the user's grants with
`permissions` (an empty list removes them all): grants left out are revoked
and kept ones keep who granted them. Role permissions are never subtracted. A
malformed body returns 400 and keys outside the catalog 422 with
`data: { unknown }`, never ignored; an unknown user 404. It writes
`user.permissions_set` to the audit log (`before` and `after` lists) and
returns the user row as `GET /api/admin/users` lists it, whose rows carry
`extraPermissions: PermissionKey[]` in catalog order.

**Linking accounts to members.** After each sign-in, role sync links
`users.memberId` by the intranet `initials` (the member's acronym):

- `Asociado` and `Sectorial` accounts are the member itself. A missing member
  is created as an intranet member, and the next roster sync fills it in.
- `CEA` accounts act for their executive area. A missing area is created as a
  manual `executive` member named after its acronym (the intranet name may be
  the person's), so the roster sync never deactivates it; an admin renames
  it. A CEA account is never linked to a council or a sectorial that shares
  its initials.
- Other types leave `memberId` alone.
- A CEA account that already acts for a member keeps it while its intranet
  initials stay the same, so a link an admin set by hand is not undone at
  the next sign-in. When the initials change (the cargo moved to another
  area), it is linked again by them. Asociado and Sectorial accounts always
  follow their initials.
- An account stops acting for its member (`memberId` becomes null, in the
  same transaction as the role change) when it has a synced role (`Invitado`,
  `Asociado`, `CEA`) and either its role changes with its intranet type (a CEA
  cargo whose term ended becomes `Invitado`) or its intranet type stops being
  `Asociado`, `Sectorial` or `CEA`. The new type, if it is one of those,
  links it again. `Admin`, `Secretaría`, `Presidencia` and `Moderador`
  accounts keep their role and their link.
- When the role resolved by the sync has no row (the database was not seeded
  after a role was added), the sync logs a warning; a new account gets
  `Invitado` instead, and an existing one keeps its role and its member. Run
  `pnpm db:seed` after deploying a new role.

An admin links an account by hand with `PUT /api/admin/users/[id]/member`:
when its initials are missing, or when a CEA account's initials are the
person's rather than the area's (the sync then created an `executive` member
named after them, which the admin can deactivate). The member must exist
(404) and be active (422); `null` unlinks it. The change is written to the
audit log (`user.member_link`). It returns the user row as
`GET /api/admin/users` lists it, which now includes `memberId` and `member`
(`MemberRef` or null). A manual link on an Asociado or Sectorial account with
initials is replaced at its next sign-in, and a CEA account's when its
initials change.

An account with no member that tries to create a document or an amendment
gets 403 with the next step: ask the Secretaría to link it.

## Assemblies and calendar

| Method | Path                                  | Who               | Notes                                                                                                                                            |
| ------ | ------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/assemblies`                     | any               | `AssemblyListDto`. Drafts are listed only for managers. Takes `?status=&type=&page=`.                                                            |
| POST   | `/api/assemblies`                     | `assembly:create` | `AssemblyCreateBody`. Seeds the milestones from `defaultMilestones` unless told not to.                                                          |
| GET    | `/api/assemblies/[assembly]`          | visible           | `AssemblyDto`, including the milestones and the warnings from `checkCalendar`.                                                                   |
| PUT    | `/api/assemblies/[assembly]`          | `assembly:manage` | `AssemblyUpdateBody`. Settings are merged (see below).                                                                                           |
| DELETE | `/api/assemblies/[assembly]`          | `assembly:manage` | Only in `draft`.                                                                                                                                 |
| PUT    | `/api/assemblies/[assembly]/status`   | `assembly:manage` | Follows `ASSEMBLY_STATUS_TRANSITIONS`. Entering `in_session` creates the `live_state` row. Closing ends the speaking turns (see speaking turns). |
| PUT    | `/api/assemblies/[assembly]/calendar` | `assembly:manage` | `CalendarBody`. Upserts or deletes the milestones and toggles `agendaFinalizedAt`. Returns `AssemblyDto`.                                        |
| GET    | `/api/assemblies/[assembly]/review`   | see notes         | `ReviewQueueDto`, the Secretaría's validation inbox. `document:manage` or `amendment:review`, otherwise 403. See "Review and work" below.        |

**Settings.** `AssemblyDto.settings` is the stored JSON merged over
`DEFAULT_ASSEMBLY_SETTINGS`, reading only the keys the defaults have. Keys of
removed policies, such as the old `amendmentVisibility`, are neither returned
nor kept: the next `PUT` writes the settings back without them.

## Agenda

| Method | Path                                        | Who               | Notes                                                                                                                                                                                                       |
| ------ | ------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/assemblies/[assembly]/agenda`         | visible           | `AgendaDto`: flat items plus the documents the actor can see.                                                                                                                                               |
| POST   | `/api/assemblies/[assembly]/agenda`         | `assembly:manage` | `AgendaItemBody`.                                                                                                                                                                                           |
| PUT    | `/api/assemblies/[assembly]/agenda/[item]`  | `assembly:manage` | `AgendaItemBody` with `updatedAt`.                                                                                                                                                                          |
| DELETE | `/api/assemblies/[assembly]/agenda/[item]`  | `assembly:manage` | Children cascade. Returns 409 if the item or its children hold a submitted, published or postponed document, or any document that was ever published (it keeps its base version, reference and amendments). |
| PUT    | `/api/assemblies/[assembly]/agenda/reorder` | `assembly:manage` | `AgendaReorderBody`. Validates that every parent exists in the same assembly and that there are no cycles.                                                                                                  |

Once the agenda is final (`agendaFinalizedAt`), root items cannot be created,
deleted or moved. Sub-items still can.

## Documents

| Method | Path                                                         | Who                            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | ------------------------------------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/assemblies/[assembly]/documents`                       | visible                        | `DocumentSummaryDto[]`. `amendmentCount` counts the amendments past draft that the actor can see (see who sees an amendment).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| POST   | `/api/assemblies/[assembly]/documents`                       | see below                      | `DocumentCreateBody`. Creates a draft and its working version.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| GET    | `/api/assemblies/[assembly]/documents/[document]`            | visible                        | `DocumentDto`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| PUT    | `/api/assemblies/[assembly]/documents/[document]`            | editor                         | `DocumentUpdateBody`. Status changes return 409 once the final vote is recorded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| DELETE | `/api/assemblies/[assembly]/documents/[document]`            | `document:manage`              | Only before publication.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| PUT    | `/api/assemblies/[assembly]/documents/[document]/content`    | editor                         | `DocumentContentBody`. Replaces the working draft. Returns 409 if `baseHash` is stale or the document is published.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| POST   | `/api/assemblies/[assembly]/documents/[document]/import`     | editor                         | Multipart DOCX up to 15 MB, with magic bytes checked. Returns `DocxImportDto` and saves nothing. The archive's real inflated size and entry count are bounded, mammoth runs in a child process with its own heap and time limit, and the HTML it returns is bounded in nodes, nesting, block elements and formatting marks before it is parsed. 413 when a size or markup limit is exceeded, 415 for a corrupt or non-DOCX file, 422 when the document exceeds the content limits (blocks, text per paragraph, nesting, formatting) or has no usable text (that one carries `data: { reason: "empty" }`, since splitting the file cannot help), 429 when the user already has an import running or waiting or the conversion queue is full (an import whose client disconnects leaves the queue at once), 500 when the converter cannot start. |
| POST   | `/api/assemblies/[assembly]/documents/[document]/file`       | `document:manage` or proponent | PDF upload for the `file` format. See PDF replacement below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| POST   | `/api/assemblies/[assembly]/documents/[document]/submit`     | proponent                      | A presenter sends a draft to the Secretaría (`submitted`). See validation below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| POST   | `/api/assemblies/[assembly]/documents/[document]/correction` | `document:manage`              | `CorrectionBody`. Sends a submitted document back to draft with a note. Returns `DocumentDto`. See validation below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| POST   | `/api/assemblies/[assembly]/documents/[document]/publish`    | `document:manage`              | Validates (publishes) the document. See publishing rules below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| GET    | `/api/assemblies/[assembly]/documents/[document]/history`    | visible                        | `EventDto[]` for the document and its amendments, respecting amendment visibility. Correction notes are removed from the payload for those who may not read them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | `/api/assemblies/[assembly]/documents/[document]/final-vote` | `session:moderate`             | `FinalVoteBody`. See final vote rules below. Returns `DocumentDto`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| DELETE | `/api/assemblies/[assembly]/documents/[document]/final-vote` | `session:moderate`             | `FinalVoteAnnulBody`. Annuls the final vote, see below. Returns `DocumentDto`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| POST   | `/api/assemblies/[assembly]/documents/[document]/export`     | visible                        | Body `{ variant: "clean" \| "annotated", locale }`. Enqueues a PDF export and returns `{ jobId }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

**Who can create.** Managers (`document:manage`) can always create a document,
for any member (`proponentMemberId`) and with no content. Members with
`document:create` (Asociado and CEA accounts) can create one under an agenda
item that has `acceptsSubmissions`, until the `documents_close` milestone. The
proponent then defaults to their member.

**Expected documents.** A manager creates a document in advance for the member
that has to provide it (a CEA report, a resolution) with an internal deadline,
`dueAt` (`DocumentCreateBody.dueAt`, changed later through `PUT`). It starts
as an empty draft that the member fills in and presents. Only managers set
`dueAt`: a presenter that sends one gets 403. A document is expected when it
has a `dueAt` or hangs from an agenda item that does not accept submissions
(only a manager could have created it there, such as a CEA report without an
internal deadline). The `documents_close` milestone does not bind an expected
document: its `dueAt`, if any, is the deadline, and an overdue one can still
be presented (the tracking panel flags it).

**Summary fields.** `DocumentSummaryDto` carries what the tracking panel needs:
`submittedAt` (null while it is a draft), `dueAt`, `hasContent` (blocks in the
working draft, or a PDF uploaded) and the pending correction,
`correctionNote` and `correctionRequestedAt`, which are returned only to the
document's presenters (its proponent member and the user who created it) and
to `document:manage`, and null for everyone else.

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

**Editor.** An editor holds `document:manage`, or acts for the proponent while
the document is a `draft`.

**Who sees a document.** Published and postponed documents are public. Drafts
are private to their proponent, the user who created them and
`document:manage`. The Mesa (`session:moderate`) also sees every document past
draft (submitted, withdrawn).

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
- An approved totality return (devolución) sends the text back (RFAG 2026 art.
  23ter): it returns 409 with `{ totalityReturn: id }`, whatever the vote.
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
| POST   | `/[amendment]/withdraw`   | author or moderator                                  | Allowed until the amendment is decided.                                                                       |
| POST   | `/validate`               | `amendment:review`                                   | `ValidateAmendmentsBody`. See validation below. Returns `DocumentAmendmentsDto`.                              |
| POST   | `/publish`                | `amendment:review`                                   | `PublishAmendmentsBody`. See validation below. Returns `DocumentAmendmentsDto`.                               |
| POST   | `/[amendment]/correction` | `amendment:review`                                   | `CorrectionBody`. See validation below. Returns `AmendmentDto`.                                               |
| POST   | `/admission`              | `amendment:review` or moderator                      | See admission rules below.                                                                                    |
| PUT    | `/[amendment]/position`   | proponent or moderator                               | `PositionBody`. Records an event.                                                                             |
| POST   | `/[amendment]/outcome`    | moderator                                            | See outcome rules below.                                                                                      |
| POST   | `/transactional`          | `amendment:create` acting for a member, or moderator | See transactional rules below.                                                                                |
| POST   | `/[amendment]/acceptance` | pending party, or a moderator for one                | See acceptance rules below.                                                                                   |
| POST   | `/relations`              | moderator, reviewer or proponent                     | `RelationBody`. Both amendments must belong to the document, so `same_in_other_document` returns 422.         |
| DELETE | `/relations/[relation]`   | the same roles                                       |                                                                                                               |
| GET    | `/[amendment]/history`    | visible                                              | `EventDto[]`. Correction notes are removed for those who may not read them.                                   |

**Who sees an amendment** (`canSeeAmendment`).

- Drafts: their authors, the user who created them, the parties of a
  transactional and reviewers (`amendment:review` or `amendment:manage`). The
  Mesa alone (`session:moderate`) does not read members' drafts.
- Presented amendments are visible to everyone who can see the document
  only once the Secretaría publishes them (`publishedAt`). Until then
  (waiting for validation, validated but kept private, or decided before
  publication) only their authors, the user who created them, the parties of
  a transactional, reviewers and the Mesa see them. Visibility is per
  amendment: there is no assembly-wide policy any more.
- The same rule drives `amendmentCount` in document summaries, the history
  and the admission decisions returned by `GET .../decisions`.
- `correctionNote` is returned only to the authors, the creator, the parties,
  reviewers and the Mesa, and null for everyone else.

**Creating a draft.**

- `validateOps` runs against the base, and any error returns 422 with the
  reasons.
- Authors are the actor's member plus `authorMemberIds`. A moderator may use
  `onBehalfOfMemberId`.
- `positionKey` is computed with `positionKey`.

**Editing a draft.**

- `authorMemberIds` replaces the co-authors; the presenting member stays. The
  actor's member is always kept: a co-author editing a draft presented by
  another member does not drop out of it.
- Ordinary drafts may name any active member as co-author. On a transactional
  draft, a non-moderator may only add its parties (the authors of what it
  absorbs and the proponent), as when it is created: otherwise 403.

**Submitting.** Submission does several things at once:

- It sets `status=submitted`, `submittedAt` and `submittedByUserId`, and
  clears a pending correction (`correctionNote`, `correctionRequestedAt`).
- It computes `late` from `amendmentWindow` and `isLateSubmission`. An
  amendment the Secretaría sent back for correction keeps the timing of its
  first presentation: fixing it after the window closed does not make it late.
- It assigns `number` (next free number per document) and `memberSeq` (next per
  first author within the document). An amendment sent back for correction
  keeps its `number`, and its `memberSeq` while the same member presents it,
  so numbering has no gaps. Deleting such a draft leaves its number unused.
- It sets `code` to `"{ACRONYM} {memberSeq}"`.
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
  reload). A transactional proposed by a member also needs the approval of
  the document's presenter first (409 while it is `pending_proponent`, see
  transactionals below; the acceptance rows are share-locked after the
  amendments). It sets `validatedAt` and
  `validatedByUserId`. An on-time amendment is admitted at the same time
  (`admission=admitted`); a late one keeps `admission=pending` until the
  assembly decides whether to treat it (the Secretaría or the Mesa records
  it, see late amendments). With `publish` it also sets `publishedAt`. A
  transactional is validated only while everything it absorbs is still open,
  as on its creation (409, saying which amendment it groups still needs the
  Secretaría's validation or the assembly's decision to treat it, or is
  already decided). Records `amendment_validated`
  (`{ publish, admission }`, plus `method: "secretaria"` when it admits)
  per amendment.
- `POST .../publish` (`PublishAmendmentsBody`) makes validated amendments
  visible to everyone: each one must be validated, past draft and not
  published yet (409). Records `amendment_published`. Publishing only changes
  who sees an amendment, so it is the one amendment change still allowed
  after the final vote.
- `POST .../[amendment]/correction` (`CorrectionBody`: a note of 1 to 2000
  characters and the amendment's `updatedAt` for the optimistic lock) sends a
  `submitted`, not yet validated amendment back to `draft` with the note in
  `correctionNote` and `correctionRequestedAt`. `submittedAt` becomes null;
  number, code and timing are kept (see submitting). Records
  `amendment_correction_requested` (`{ note }`). A transactional still
  waiting for the presenter's approval returns 409.
- `reviewState` on `AmendmentDto` tells where it stands:
  - `correction_requested`: a draft the Secretaría sent back;
  - `published`: `publishedAt` is set, whatever its status;
  - `pending_proponent`: a transactional proposed by a member, `submitted`
    and not validated, whose presenter acceptance (the acceptance row of
    the document's proponent member, whatever its role) is not `accepted`.
    It stays here when the presenter rejects it: the rejection shows in
    `acceptances`, and the proposer can withdraw it;
  - `pending_validation`: `submitted`, not validated and not waiting for
    the presenter;
  - `validated`: validated, not published and still relevant to the debate
    (not withdrawn nor inadmissible). The inbox lists these to publish,
    except the late ones still waiting for the assembly's decision, which
    it lists with the late ones;
  - null otherwise: a draft never presented, or an amendment settled while
    private that waits for nothing (withdrawn, lapsed or inadmissible before
    validation, or withdrawn or inadmissible after a private validation).

  `can.validate` holds for reviewers on a submitted, unvalidated amendment
  that does not wait for the presenter, and `can.publish` on a validated,
  unpublished one past draft (a withdrawn or inadmissible one can still be
  published on purpose).

- Row locks follow the usual order: the document (share), then the
  amendments and, for `validate`, the lineage of transactionals, in id order.

**Late amendments.** An amendment presented after its window closes gets
`late: true` (computed, see submitting). Validating it keeps `admission`
`pending` (with `publish` it becomes visible at once), so `AmendmentDto`
shows `late: true`, `admission: "pending"` and `reviewState: "published"`:
the client says it is out of time and waits for the assembly to decide
whether to treat it. The Secretaría or the Mesa records that decision with
`POST .../admission` below. Until it is `admitted`, an outcome returns 409
and it cannot be the source of a transactional; the final vote waits for it
to be decided (declared inadmissible, for instance).

**Admission.** The body is an `AdmissionBody`, usable one by one or in bulk.

- It creates a `decisions` row (`admit_late` or `inadmission`), with a vote
  when the method is `vote`.
- It sets `admission`. Inadmissible amendments also get
  `status=inadmissible`.
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

**Outcome.** The body is an `OutcomeBody`; the response is an
`AmendmentOutcomeDto`.

- `approve` sets `status=approved` with `approvalMethod`.
- `vote` records a vote with `computeVoteOutcome` (majority `simple` by
  default) and then approves or rejects. A tie under `tieRule=repeat` stores
  nothing and returns 409. The vote is projected live, pointing the
  projection at the amendment.
- `withdraw` and `lapse` set `withdrawn` and `lapsed`.
- `reopen` brings the amendment back to `submitted`. Its vote row stays for
  the record, but the `amendment_reopened` event records it as
  `voidedVoteId` and the projection stops showing it.
- `approve` and `vote` require the amendment to be admitted and published
  (`publishedAt`): an amendment the Secretaría validated but kept private
  returns 409 until it publishes it, so nothing is decided that delegates
  cannot read. A transactional also needs every acceptance to be
  `accepted`.
- Approving a transactional absorbs its lineage: its parents and, through
  nested transactionals (a transactional over another), their parents at any
  depth. The lineage is locked and re-checked in the transaction: every
  amendment in it must be submitted, admitted and undecided, otherwise 409,
  so a parent and its transactional can never both end up approved. A
  transactional rejected by vote needs no such check. All of the lineage
  becomes `transacted` (`amendment_transacted`, with `nested: true` below the
  direct parents).
- Reopening an approved transactional gives its whole lineage back to
  `submitted`, except what another approved transactional still absorbs.
- When approving any amendment, the response lists the ids of amendments with
  hard overlaps or an `incompatible` relation, so the client can offer to mark
  them as `lapse`.

**Transactionals.** The body is a `TransactionalBody`. Any member can
propose one over published amendments, before or during the session.

- Who: any account with `amendment:create` that acts for a member (a council,
  sectorial or CEA area), its parties (the document's presenter and the
  authors of the sources) or a moderator. An account without a member gets
  403 with the next step (ask the Secretaría to link it).
- The sources must belong to the document (404 otherwise, also for a source
  the actor cannot see) and be published (`publishedAt`), submitted,
  admitted and undecided; everything a source transactional absorbs must be
  submitted, admitted and undecided too. This is checked again under the
  document lock, both on creation and on submission of a draft
  transactional. The 409 says what is missing, first what someone can still
  do: a source still waiting for the Secretaría's validation, then one
  out of time whose treatment the assembly has not decided yet, then one not
  published yet, then one already decided.
- The ops are validated against the same base.
- It creates `kind=transactional`, numbered `T1`, `T2` and so on per document,
  and fills `amendment_sources`.
- It creates `amendment_acceptances` for every author member of every source,
  and of every amendment a source transactional absorbs (`role=author`), and
  for the document proponent (`role=proponent`). The creator's own member is
  accepted at once. A member that is both keeps a single row; it is stored
  as `author`, but `AcceptanceDto.role` always reports the row of the
  document's proponent member as `proponent`, so clients find the
  presenter's answer by role.
- Non-moderators may name as co-authors only the parties; the proposer's
  member is always an author (it accepts nothing: it is not a party unless
  it wrote a source or presents the document).
- With `submit` it is submitted immediately and `late` is ignored. Created by
  a moderator (the Mesa in session), it is validated, admitted and published
  at once (`amendment_validated` with `publish: true` and `method: "mesa"`);
  the parties answer in the room. Created by a member, it goes:
  1. to the document's presenter, which approves it with its acceptance
     (`POST .../acceptance`). Until then it is `pending_proponent`, private
     to its authors, its creator, its parties, reviewers and the Mesa. The
     Secretaría's inbox lists it read only (`can.validate` false) while the
     presenter has not answered, and its counts leave it out. When the proposer is the
     presenter's member, that acceptance is accepted at once and it goes
     straight to the Secretaría. Its `amendment_submitted` event carries
     `awaitsProponent: true` when it waits;
  2. then to the Secretaría, which validates and publishes it like any other
     amendment (`POST .../validate` answers 409 until the presenter accepts);
  3. before it is voted, every party accepts it (see outcome).
- Submitting a draft transactional later follows the same rule, by who
  submits it.
- If the presenter rejects it, it stays submitted and private as
  `pending_proponent` with the rejected acceptance visible to the proposer.
  The proposer (or the Mesa) withdraws it. While it stays submitted, the
  final vote on the document waits for it, like any undecided amendment.

**After the final vote.** Every amendment change (drafts, submission,
validation, correction, withdrawal, admission, position, outcome, acceptance,
relations) returns 409 once the document has a final vote; only publishing
is still allowed. Each one re-reads the document under a row
lock inside its transaction, so a change racing the final vote either commits
first (and the final vote sees it) or is refused.

**Acceptance.** The body is an `AcceptanceBody`, and it updates that party's
row. A party answers once (409 afterwards); the Mesa can record or correct
any party's answer given in the room (`memberId`). The presenter's
acceptance of a member-proposed transactional is what moves it from
`pending_proponent` to the Secretaría.

## Review and work

**Validation inbox.** `GET /api/assemblies/[assembly]/review` returns a
`ReviewQueueDto` for `document:manage` or `amendment:review` (403 otherwise):

- `documents`: with `document:manage`, the `submitted` documents waiting for
  validation, as `DocumentSummaryDto`, in creation order;
- `amendments`: with `amendment:review`, each with its document reference,
  grouped by document in agenda order (then creation order) and then in
  text order:
  - waiting for validation: `submitted`, not validated, and not a
    transactional still waiting for the presenter's approval;
  - waiting for publication: validated, not published, and not draft,
    withdrawn or inadmissible;
  - late ones waiting for the assembly's decision, published or not:
    `late`, `admission: "pending"`, `submitted` and validated. The
    Secretaría (or the Mesa) records that decision with
    `POST .../amendments/admission`;
  - read only, member-proposed transactionals whose presenter has not
    answered yet (`pending_proponent` with the presenter's acceptance
    `pending`; `can.validate` is false), so the Secretaría sees what is
    about to reach it. One the presenter rejected is left out: it waits only
    for its proposer to withdraw it.

**Home page.** `GET /api/me/work` returns a `MeWorkDto` over the assemblies
that are not closed and that the actor can see (draft assemblies only for
managers and the Mesa), soonest first:

- `documents`: the documents the actor's member presents (`proponentMemberId`)
  that are `draft` (expected ones included), `submitted` or `published`;
- `amendments`: the amendments the actor's member authored that are still
  `draft` or `submitted`, newest change first, with `reviewState` (a
  member-proposed transactional shows `pending_proponent`) and the
  `correctionNote`;
- `review`: for `document:manage` or `amendment:review`, per assembly with
  something pending, `documentsToValidate` and `documentsOverdue` (expected
  drafts past `dueAt`), which need `document:manage`, and
  `amendmentsToValidate` and `amendmentsToPublish` (the inbox's "to
  validate" and "to publish" sets: transactionals waiting for the presenter
  and late amendments waiting for the assembly's decision are not counted),
  which need `amendment:review`;
- `proponent`: the `published` documents the actor's member presents, not
  voted yet, with something to answer, in assembly order and then creation
  order. Over the amendments of the document the actor can see:
  `positionsPending` counts the `submitted` ones (not transactionals) that
  the Secretaría already checked (validated or published, not
  `pending_validation`) whose position is still `pending`;
  `transactionalsToApprove` counts the `submitted` transactionals whose
  presenter acceptance is `pending` (a rejected one does not count).
  Documents where both are 0 are left out.

An account without a member gets empty `documents`, `amendments` and
`proponent`.

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
  their `updatedAt`.
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
- labels come from the locale files.
