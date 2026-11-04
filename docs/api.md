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
- **Error messages.** Use `createError({ statusCode, message })` with Spanish
  messages. The client maps status codes to i18n keys.
- **History.** Every state change calls `recordEvent` inside the same
  transaction, with `documentId` set for document-scoped changes. Event
  `type` values are `snake_case` verbs, for example `amendment_submitted`,
  `vote_recorded` and `live_changed`.

## Members and me

| Method | Path                | Who             | Notes                                                                            |
| ------ | ------------------- | --------------- | -------------------------------------------------------------------------------- |
| GET    | `/api/me`           | any             | `MeDto`                                                                          |
| GET    | `/api/members`      | any             | `MemberDto[]`, active first, by acronym. `?all=1` also returns inactive members. |
| POST   | `/api/members`      | `member:manage` | Creates a member manually, typically an executive area.                          |
| PUT    | `/api/members/[id]` | `member:manage` | Edits name, kind or active, with `updatedAt`.                                    |
| POST   | `/api/members/sync` | `member:manage` | Syncs the intranet roster. Returns `MemberSyncResult`.                           |

## Assemblies and calendar

| Method | Path                                  | Who               | Notes                                                                                                     |
| ------ | ------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------- |
| GET    | `/api/assemblies`                     | any               | `AssemblyListDto`. Drafts are listed only for managers. Takes `?status=&type=&page=`.                     |
| POST   | `/api/assemblies`                     | `assembly:create` | `AssemblyCreateBody`. Seeds the milestones from `defaultMilestones` unless told not to.                   |
| GET    | `/api/assemblies/[assembly]`          | visible           | `AssemblyDto`, including the milestones and the warnings from `checkCalendar`.                            |
| PUT    | `/api/assemblies/[assembly]`          | `assembly:manage` | `AssemblyUpdateBody`. Settings are merged.                                                                |
| DELETE | `/api/assemblies/[assembly]`          | `assembly:manage` | Only in `draft`.                                                                                          |
| PUT    | `/api/assemblies/[assembly]/status`   | `assembly:manage` | Follows `ASSEMBLY_STATUS_TRANSITIONS`. Entering `in_session` creates the `live_state` row.                |
| PUT    | `/api/assemblies/[assembly]/calendar` | `assembly:manage` | `CalendarBody`. Upserts or deletes the milestones and toggles `agendaFinalizedAt`. Returns `AssemblyDto`. |

## Agenda

| Method | Path                                        | Who               | Notes                                                                                                      |
| ------ | ------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------- |
| GET    | `/api/assemblies/[assembly]/agenda`         | visible           | `AgendaDto`: flat items plus the documents the actor can see.                                              |
| POST   | `/api/assemblies/[assembly]/agenda`         | `assembly:manage` | `AgendaItemBody`.                                                                                          |
| PUT    | `/api/assemblies/[assembly]/agenda/[item]`  | `assembly:manage` | `AgendaItemBody` with `updatedAt`.                                                                         |
| DELETE | `/api/assemblies/[assembly]/agenda/[item]`  | `assembly:manage` | Children cascade. Returns 409 if the item or its children hold published documents.                        |
| PUT    | `/api/assemblies/[assembly]/agenda/reorder` | `assembly:manage` | `AgendaReorderBody`. Validates that every parent exists in the same assembly and that there are no cycles. |

Once the agenda is final (`agendaFinalizedAt`), root items cannot be created,
deleted or moved. Sub-items still can.

## Documents

| Method | Path                                                         | Who                            | Notes                                                                                                                         |
| ------ | ------------------------------------------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/assemblies/[assembly]/documents`                       | visible                        | `DocumentSummaryDto[]`                                                                                                        |
| POST   | `/api/assemblies/[assembly]/documents`                       | see below                      | `DocumentCreateBody`. Creates a draft and its working version.                                                                |
| GET    | `/api/assemblies/[assembly]/documents/[document]`            | visible                        | `DocumentDto`                                                                                                                 |
| PUT    | `/api/assemblies/[assembly]/documents/[document]`            | editor                         | `DocumentUpdateBody`                                                                                                          |
| DELETE | `/api/assemblies/[assembly]/documents/[document]`            | `document:manage`              | Only before publication.                                                                                                      |
| PUT    | `/api/assemblies/[assembly]/documents/[document]/content`    | editor                         | `DocumentContentBody`. Replaces the working draft. Returns 409 if `baseHash` is stale or the document is published.           |
| POST   | `/api/assemblies/[assembly]/documents/[document]/import`     | editor                         | Multipart DOCX up to 15 MB, with magic bytes checked. Returns `DocxImportDto` and saves nothing.                              |
| POST   | `/api/assemblies/[assembly]/documents/[document]/file`       | `document:manage` or proponent | PDF upload for the `file` format. Reuses the existing upload validation.                                                      |
| POST   | `/api/assemblies/[assembly]/documents/[document]/submit`     | proponent                      | A member submits a draft for admission (`submitted`). Respects the `documents_close` milestone unless the actor is a manager. |
| POST   | `/api/assemblies/[assembly]/documents/[document]/publish`    | `document:manage`              | See publishing rules below.                                                                                                   |
| GET    | `/api/assemblies/[assembly]/documents/[document]/history`    | visible                        | `EventDto[]` for the document and its amendments, respecting amendment visibility.                                            |
| POST   | `/api/assemblies/[assembly]/documents/[document]/final-vote` | `session:moderate`             | See final vote rules below.                                                                                                   |
| POST   | `/api/assemblies/[assembly]/documents/[document]/export`     | visible                        | Body `{ variant: "clean" \| "annotated", locale }`. Enqueues a PDF export and returns `{ jobId }`.                            |

**Who can create.** Managers (`document:manage`) can always create a document.
Members with `document:create` can create one under an agenda item that has
`acceptsSubmissions`, until the `documents_close` milestone. The proponent
then defaults to their member.

**Editor.** An editor holds `document:manage`, or acts for the proponent while
the document is a `draft`.

**Publishing.**

- Freezes the working draft as an immutable `base` version.
- Sets `status=published`, `publishedAt` and `baseVersionId`.
- Assigns the reference (`RES 012/2026`) for kinds that use one.
- Amendments open according to the window.
- A structured document needs at least one block.

**Final vote.**

- Records the vote on the whole text.
- When it is approved, consolidates the base with the approved amendments, in
  approval order, using `consolidate`.
- Stores the result as a `consolidated` version and sets
  `consolidatedVersionId` and `finalVoteId`.
- If `consolidate` reports conflicts, it returns 409 with the conflicts.

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
| POST   | `/admission`              | `amendment:review` or moderator                      | See admission rules below.                                                                                    |
| PUT    | `/[amendment]/position`   | proponent or moderator                               | `PositionBody`. Records an event.                                                                             |
| POST   | `/[amendment]/outcome`    | moderator                                            | See outcome rules below.                                                                                      |
| POST   | `/transactional`          | see below                                            | See transactional rules below.                                                                                |
| POST   | `/[amendment]/acceptance` | pending party, or a moderator for one                | See acceptance rules below.                                                                                   |
| POST   | `/relations`              | moderator, reviewer or proponent                     | `RelationBody`. Both amendments must belong to the document.                                                  |
| DELETE | `/relations/[relation]`   | the same roles                                       |                                                                                                               |
| GET    | `/[amendment]/history`    | visible                                              | `EventDto[]`                                                                                                  |

**Creating a draft.**

- `validateOps` runs against the base, and any error returns 422 with the
  reasons.
- Authors are the actor's member plus `authorMemberIds`. A moderator may use
  `onBehalfOfMemberId`.
- `positionKey` is computed with `positionKey`.

**Submitting.** Submission does several things at once:

- It sets `status=submitted`, `submittedAt` and `submittedByUserId`.
- It computes `late` from `amendmentWindow` and `isLateSubmission`.
- It assigns `number` (next free number per document) and `memberSeq` (next per
  first author within the document).
- It sets `code` to `"{ACRONYM} {memberSeq}"`.
- Amendments submitted on time get `admission=admitted` unless the assembly
  reviews admissions manually. Late amendments stay `pending`.
- It creates the `amendment_positions` row as `pending`.

**Admission.** The body is an `AdmissionBody`, usable one by one or in bulk.

- It creates a `decisions` row (`admit_late` or `inadmission`), with a vote
  when the method is `vote`.
- It sets `admission`. Inadmissible amendments also get
  `status=inadmissible`.

**Outcome.** The body is an `OutcomeBody`.

- `approve` sets `status=approved` with `approvalMethod`.
- `vote` records a vote with `computeVoteOutcome` (majority `simple` by
  default) and then approves or rejects. A tie under `tieRule=repeat` stores
  nothing and returns 409.
- `withdraw` and `lapse` set `withdrawn` and `lapsed`.
- `reopen` brings the amendment back to `submitted`.
- When approving a transactional, its parents become `transacted`.
- When approving any amendment, the response lists the ids of amendments with
  hard overlaps or an `incompatible` relation, so the client can offer to mark
  them as `lapse`.
- Requires the amendment to be admitted. A transactional also needs every
  acceptance to be `accepted`.

**Transactionals.** The body is a `TransactionalBody`.

- Who: authors of any source, the proponent, or a moderator.
- The sources must be submitted, admitted and undecided.
- The ops are validated against the same base.
- It creates `kind=transactional`, numbered `T1`, `T2` and so on per document,
  and fills `amendment_sources`.
- It creates `amendment_acceptances` for every author member of every source
  (`role=author`) and for the document proponent (`role=proponent`). The
  creator's own member is accepted at once.
- With `submit` it is submitted immediately: `late` is ignored and it is
  admitted.

**Acceptance.** The body is an `AcceptanceBody`, and it updates that party's
row.

## Votes, decisions and live session

| Method | Path                                    | Who                | Notes                                                                                                                                                                                                                                    |
| ------ | --------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/assemblies/[assembly]/decisions`  | visible            | `DecisionDto[]`                                                                                                                                                                                                                          |
| GET    | `/api/assemblies/[assembly]/live-state` | visible            | `LiveStateDto`                                                                                                                                                                                                                           |
| PUT    | `/api/assemblies/[assembly]/live-state` | `session:moderate` | `LiveStateBody`. Records a `live_changed` event.                                                                                                                                                                                         |
| GET    | `/api/assemblies/[assembly]/live`       | visible            | SSE stream. On connect it sends `event: ready`. Each `LiveMessage` from `subscribeToAssembly` goes out as `event: change` with a `LiveEventDto`. A comment heartbeat goes out every 25 s. The stream closes when the client disconnects. |

## Exports

Existing endpoints, now based on structured content:

- `GET /api/exports/[jobId]/status`
- `GET /api/exports/[jobId]/download`

The PDF builder renders blocks:

- headings, lists and emphasis are kept;
- the annotated variant marks every amended fragment with its amendment code
  and ends with an annex of all amendments and their outcomes;
- labels come from the locale files.
