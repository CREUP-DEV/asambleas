# Assembly platform redesign

Status: accepted direction, November 2026. Grounded in
[`proceso-asambleas.md`](./proceso-asambleas.md), which records how CREUP
assemblies handle documents, deadlines and amendments today.

## Goals

Make the whole amendment cycle comfortable for the Mesa de Moderación,
Secretaría, proponents and delegates:

- present amendments by editing the text in place, not by copying paragraphs
  into a Word template;
- see every change as a precise diff, and see where several amendments overlap;
- record incompatibilities and dependencies between amendments;
- create transactional amendments in seconds during the debate;
- admit late amendments with an explicit, recorded decision;
- keep a live consolidated text, ready before the final vote, with full
  traceability from every fragment to the amendment that produced it;
- follow the session live, both on a projector and on each delegate's device.

In scope for this iteration, besides that core: DOCX import, the assembly
calendar with regulatory checks, and convocatoria generation. Out of scope:
electronic voting (the Mesa enters counts), attendance and quorum, minutes.

## Members

Amendments and documents are presented by **members** (student councils,
sectorials, executive areas), not by people.

- `members`: `kind` (`asociado`, `sectorial`, `executive`, `other`),
  `acronym` (unique, canonical), `name`, `university`, `region`, `source`
  (`intranet`, `manual`), `active`.
- The intranet already exposes the roster: `GET {NUXT_INTRANET_API_URL}/usuarios/asociados`
  and `/usuarios/sectoriales` return `{ data: [{ denomination, initials,
university, autonomous_community, ... }] }`. Members are upserted by
  `initials` = `acronym`. Executive areas are created manually.
- In the intranet an `Asociado` account _is_ the member, and
  `POST /user/role` returns the same `initials`. Role sync therefore links
  `users.memberId` by acronym, creating the member if the roster has not been
  synced yet.
- Recommended intranet change: add a stable `id` to the roster payload, so a
  member that changes acronym keeps its link.

A user acts for the member in `users.memberId`. Users with moderation
permissions may act on behalf of any member; every such action records both.

## Documents

`documents` keep their place in the agenda tree and gain:

- `kind`: `positioning`, `resolution`, `internal_motion`, `executive_report`,
  `regulation`, `statutes`, `budget`, `accounts`, `work_plan`, `agreement`,
  `report`, `minutes`, `candidacy`, `venue`, `other`. Defaults per kind
  (`shared/constants/documentKinds.ts`) set whether it is amendable, whether it
  is voted and with which majority. All defaults are editable per document.
- `format`: `structured` (amendable text) or `file` (uploaded PDF).
- `proponentMemberId` (who presents it) and `submittedByUserId`.
- `reference` (`RES 012/2026`, `MI 003/2026`), assigned on admission.
- `status`: `draft`, `submitted`, `published`, `withdrawn`, `postponed`.
- Optional per-document amendment window overriding the assembly calendar.
- `carriedFromDocumentId` for documents postponed to a later assembly.

### Structured content

Structured text is a list of **blocks**, each with a stable id:

```ts
type Block = {
  id: string; // stable, never reused within a document
  type: "heading" | "paragraph" | "list_item" | "quote";
  level?: number; // heading level or list depth
  list?: "bullet" | "ordered";
  text: string; // plain text
  marks: Mark[]; // bold/italic/underline/strike/link ranges over `text`
};
```

Versions live in `document_versions` (`blocks` jsonb, `kind`: `draft`,
`base`, `consolidated`, `published`, content hash, author, note). The document
points to its working version, to the **base** version frozen when the
amendment window opens, and to the published consolidated version. Visible
numbering (articles, sections) is computed when rendering, never stored.

The editor is Nuxt UI `UEditor` (TipTap) with a small extension that keeps a
`blockId` attribute on every block node. DOCX import goes through `mammoth`,
is sanitized, converted to blocks, and warns about unaccepted tracked changes.

## Amendments

An amendment is a **set of operations anchored to the frozen base version**.
This is the "patches, never full HTML copies" rule applied at block level:

```ts
type AmendmentOp =
  | {
      op: "replace";
      blockId: string;
      from: number;
      to: number;
      text: string;
      baseText: string;
    }
  | { op: "insert"; afterBlockId: string | null; blocks: NewBlock[] }
  | { op: "delete"; blockIds: string[] };
```

`replace` covers suppression (`text: ""`), addition (`from === to`) and
modification. A global term replacement is stored as a group of `replace`
operations with the search term recorded for display. The change typology
(supresión, adición, modificación) is derived from the operations.

- `kind`: `partial`, `formal`, `totality_return`, `totality_alternative`,
  `transactional`.
- Authors: `amendment_authors` (member ids; joint amendments have several).
- Numbering: `number` per document, assigned on submission without gaps, and a
  per-member counter, shown as `12 · CEUM 4`. Transactionals are `T1`, `T2`...
- `submittedAt` is set by the server. `late` is computed from the window, never
  typed by hand.
- `status`: `draft`, `submitted`, `inadmissible`, `withdrawn`, `transacted`
  (absorbed by a transactional), `lapsed` (decae), `approved`, `rejected`.
  `approved` records how: proponent acceptance, assent, vote, or formal.

Separate, append-friendly records keep each decision with its own actor and
time, even when one office plays several roles:

- **Admission**: `admission` (`pending`, `admitted`, `inadmissible`) plus the
  decision that settled it. Late amendments stay `pending` until a recorded
  decision admits them, one by one or in bulk.
- **Proponent position**: `amendment_positions` (`pending`, `accept`,
  `reject`, `transact`), comment, visibility.
- **Votes**: `votes` with method (assent, show of hands, secret, roll call,
  portal), counts, majority, denominator and the computed result. Ties follow
  the assembly's tie rule; a closed vote always has a result.
- **Relations**: `amendment_relations` with `incompatible`, `duplicate`,
  `depends_on`, `consequence_of`, `subsumed_by`, `same_in_other_document`,
  plus note, author and visibility.
- **Transactionals**: `amendment_sources` links a transactional to 1..N parent
  amendments. `amendment_acceptances` holds one row per party (each parent's
  authors and, by default, the document proponent). It can be voted only once
  every party accepted. Approving it marks its parents `transacted` and, when
  it is built over another transactional, everything that one absorbs too.
  Its whole lineage must still be open when it is approved, so a parent and
  its transactional never both end up approved.
- **Events**: `events` is an append-only log (`entity`, `type`, `payload`,
  `actor`, `at`) that gives the immutable history and feeds live updates.

## Engine (`shared/utils/amendments/`)

Pure, unit-tested functions shared by server and client:

- `diffBlocks(base, edited)`: turns an edited passage into minimal operations
  (word-level diff via `diff-match-patch`).
- `findOverlaps(amendments)`: clusters amendments whose operations intersect
  in the base: intersecting ranges in a block, a deletion of a block another
  edits, or insertions at the same anchor. Clusters drive the "same passage"
  grouping in every view.
- `consolidate(base, approved)`: applies the approved operations to the base.
  It returns the consolidated blocks, a **provenance map** (each text segment
  tagged `base` or with its amendment id) and the **conflicts** that prevent
  applying two approved amendments together. It never applies fuzzily.
- `renderBlocks`, `renderDiff`: HTML for the text, the inline diff and the
  provenance view. They support both the color mode and the marks mode.

Tests run with Vitest.

## Calendar and convocatoria

`assembly_milestones` store dated milestones per assembly: convocatoria, final
agenda, documents deadline, documents publication, amendment window
open/close, candidacies. Defaults come from rules per assembly type
(`shared/constants/calendarRules.ts`, RFAG/RRI 2026). Every value stays
editable. `checkCalendar` warns when the calendar breaks a regulatory minimum
or is inconsistent, for example when amendments close before documents are
published. The convocatoria is generated from the assembly data, the agenda and
the milestones as a print view and a PDF.

## Assemblies and session

- Assembly `status`: `draft`, `convened`, `in_session`, `closed`.
  `agendaFinalizedAt` marks the final agenda.
- Per-assembly policies, with defaults from the research: who sees presented
  amendments (default: authors, reviewers and the Mesa until the window
  closes, then everyone; they are also public when there is no close date and
  once the session starts), who sees proponent positions, whether accepted
  amendments need a vote, the tie rule, and the majority denominator. Drafts
  of documents and amendments stay private to their authors and managers.
- `live_state` (one row per assembly): current agenda item, document and
  amendment under debate, plus the last recorded vote. The server projects
  every vote it records (amendment outcome, admission, final vote) and stops
  projecting it when it is voided (amendment reopened, final vote annulled).
- A wrongly recorded final vote can be annulled while the assembly is open:
  the vote row and the consolidated version stay for the record.
- Live updates: mutations `pg_notify('assembly_events', ...)`. A Nitro plugin
  `LISTEN`s and fans out to SSE streams at `GET /api/assemblies/[id]/live`.
  Events carry ids only; clients refetch through the normal, permission-checked
  endpoints. If the stream drops, clients fall back to polling. No Redis.

## Validation by the Secretaría and documentation tracking

Every document and every amendment is presented by the user who wrote it,
acting for their member: a council or sectorial (Asociado accounts), or a CEA
area (CEA accounts, intranet type `CEA`, linked to an `executive` member by
their intranet initials). Nothing a member presents is visible to the rest of
the assembly until the Secretaría has checked it.

**Documents.** A presenter writes or uploads the draft and presents it
(`submitted`). The Secretaría then either:

- validates it, which publishes it (`published`, reference assigned, base
  version frozen); or
- asks for a correction (`POST .../correction` with a note): the document goes
  back to `draft`, the note is shown to its presenters, and they present it
  again.

**Expected documentation.** The Secretaría can create a document in advance
for the member that has to provide it (a CEA report, a resolution) with an
internal deadline (`dueAt`). It starts as an empty draft that the member fills
in. The tracking panel lists, per agenda item, every document with who presents
it, its deadline and where it stands: to do (no content yet), in preparation,
presented (waiting for validation), correction requested, or published.
Overdue ones stand out.

**Amendments.** Presenting an amendment no longer admits it. The Secretaría
reviews each presented amendment and:

- validates it. An on-time amendment is admitted at the same time; a late one
  still needs the Mesa's admission decision. When validating, the Secretaría
  chooses per amendment whether it becomes visible to everyone right away or
  stays private until it publishes it later (`POST .../amendments/publish`);
- or asks for a correction: the amendment goes back to draft with a note for
  its authors.

Until it is published, an amendment is visible only to its authors, its
creator, the parties of a transactional and the Secretaría and Mesa. A
transactional created by the Mesa in session is validated and published at
once. `reviewState` on `AmendmentDto` tells authors where their amendment
stands. The time-based `amendmentVisibility` setting is gone.

**Where people see their work.** The home page (`GET /api/me/work`) lists what
each user has to do (expected documents, corrections requested) and where
their documents and amendments stand. The Secretaría gets a validation inbox
per assembly (`GET .../review`) and the tracking panel.

## Permissions

The existing keys stay, plus:

- `member:manage`: sync and edit members;
- `session:moderate`: Mesa actions such as live state, admissions, votes,
  decisions and transactionals on behalf of parties.

The default `Moderador` role gets `session:moderate`. The `CEA` role (synced
from the intranet type `CEA`) gets `document:create` and `amendment:create`,
like `Asociado`. Validating documents needs `document:manage`; validating and
publishing amendments needs `amendment:review` (both held by the Secretaría).

## Interface

The people using the platform are not technical. Every screen follows these
rules:

- plain language, no internal terms (say "Enviar a Secretaría", not
  "Presentar (submitted)"; "Quién lo presenta", not "Proponente");
- one primary action per screen, secondary actions in a "Más" menu, advanced
  options folded away;
- every status is a sentence that says what happens next ("Secretaría lo está
  revisando", "Tienes que corregirlo: …");
- lists stay clean: editing controls appear in an explicit edit mode, not on
  every row;
- empty states explain what to do.

One authenticated shell built on Nuxt UI dashboard components
(`UDashboardGroup`, `UDashboardSidebar`, `UDashboardPanel`) with the CREUP
identity. The sidebar becomes a drawer on mobile.

- **Home**: upcoming assemblies, open deadlines with countdowns, my drafts, the
  amendments waiting for my position, and a live-session banner.
- **Assembly** (`/asambleas/[slug]`): overview with the calendar timeline and
  warnings, agenda, documents, calendar and convocatoria, session console,
  projection and settings. Nested routes go through a parent page with
  `<NuxtPage />`.
- **Document workspace**: resizable panels.
  - The text has a gutter marking how many amendments touch each block, with
    overlaps highlighted.
  - View modes: original, with amendments, consolidated with provenance, and
    side by side.
  - To amend, select a passage and edit it in place, then add a justification
    and co-authors. Adding a paragraph, suppressing one, global replacement
    and totality amendments are also available.
  - The amendment list is ordered by position, filterable, and grouped by
    overlap cluster.
- **Session console** (Mesa): agenda progress, the current document's
  amendments in text order and grouped by overlap, one-click outcomes, vote
  entry with the computed result, the transactional composer, late admissions,
  relations, and the live consolidated preview with conflicts.
- **Projection**: chrome-free large text showing the passage under debate and
  its diff, then the vote result. It updates live.
- **Consolidated view and exports**: clean and annotated PDF, plus an annex of
  every amendment and its outcome.

Content accessibility preferences (fonts, diff color or marks) keep applying to
document content only.
