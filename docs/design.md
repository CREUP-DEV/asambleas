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
calendar with regulatory checks, convocatoria generation, and the Mesa's
headcounts with their quorum. Out of scope: electronic voting (the Mesa
enters counts), credentials and per-person attendance, minutes.

## Members

Amendments and documents are presented by **members** (student councils,
sectorials, executive offices), not by people. An executive office is a single-person office ("cargo unipersonal", such as
PRES or SE) of the Comisión Ejecutiva Ampliada: the interface labels its kind
"CEA" (and says "cargo de la CEA" in sentences about one office), never an area, and
the `CEA` role "Comisión Ejecutiva Ampliada (CEA)". Interface and PDF texts
never say "Comisión Ejecutiva" alone.

- `members`: `kind` (`asociado`, `sectorial`, `executive`, `other`),
  `acronym` (unique, canonical), `intranet_id` (the intranet's `users.id`,
  unique when set: partial index `members_intranet_id_unique`), `email`
  (that account's sign-in address, lowercased, unique when set; never sent
  to a client, an audit row or a log), `name`, `university`, `region`,
  `source` (`intranet`, `manual`), `active`.
- The intranet exposes the roster: `GET {NUXT_INTRANET_API_URL}/usuarios/asociados`,
  `/usuarios/sectoriales`, `/usuarios/cea` (one account per place in the
  CEA) and `/usuarios/cas` (the Coordinación del CAS, the responsible of
  the committee with the acronym `CAS` in the Intranet's committee
  management, under the committee's name: initials `CAS`) return
  `{ data: [{ id, email, denomination, initials, university, autonomous_community }] }`
  (a university only for councils; an older Intranet sends no `email`).
  The roster sync matches an asociado, a sectorial or an office by
  `intranet_id` first, so a change of acronym updates the member instead
  of creating another, then by `email`, so an account recreated with a new
  id keeps its member, and deactivates those the Intranet no longer lists.
  Initials only match a member that stores no other id or email (members
  from before, manual offices): a council that leaves never hands its
  documents to a new one with the same acronym, which is not created
  while the old one keeps it. Offices sync like the rest, so the
  Secretaría can assign them documents before anyone signs in; a manual
  office the CEA list names is adopted. The CAS list gives the member
  `CAS` (kind `other`), which adopts a manual `other` member `CAS`; the
  Coordinación del CAS leaves the CEA list for it, so the office it was
  becomes that member (same Intranet id). Without the CEA or the CAS list
  (an Intranet without that route) the sync goes on and leaves those
  members as they were. An acronym listed twice or held by another member, and an
  account without initials, are not synced, and the sync says so
  (`MemberSyncResult.ignored`, shown on the members page and kept in the
  `members.sync` audit row). It runs by hand from Miembros and daily at 05:00 Europe/Madrid (a
  pg-boss schedule, `server/utils/members/schedule.ts`, off with
  `NUXT_INTRANET_ROSTER_SYNC=false`). A sync that would deactivate every
  active member of a kind, or more than max(3, 30%) of them, is not applied
  unless the request confirms those counts (`confirmedKinds`; a retry that
  would deactivate more asks again): it records `members.sync_blocked`, and
  the daily run never confirms.
- In the intranet an `Asociado` account _is_ the member, and
  `POST /user/role` returns its `id` (stored in `users.intranet_id`) and the
  same `initials`. Role sync therefore links the `users.memberId` of Asociado
  and Sectorial accounts by `intranet_id`, then by email, then by acronym
  (refused when the member stores another account's id or email), creating the
  member if the roster has not been synced yet. CEA accounts link to their
  executive office the same way: the account is the office's place, which
  outlives whoever holds it.

A user acts for the member in `users.memberId`. Users with moderation
permissions may act on behalf of any member; every such action records both.

### Who sees the executive offices

Everyone knows the CEA presents a document or an amendment; which of its
offices does is for the CEA and those who run the assembly. The rule is one
predicate, `canSeeExecutiveMembers` (`server/utils/domain/visibility.ts`):
an account sees the offices when its role is Admin, Secretaría, Presidencia,
Moderador (the Mesa gives them the floor) or CEA, when it holds a management
permission (`document:manage`, `amendment:review`, `amendment:manage`,
`assembly:manage`, `session:moderate`, `member:manage`,
`user:manage_roles`), or when it acts for an office itself
(`Actor.memberKind`). Everyone else (Asociado, Sectorial, Invitado, Otro) gets one
generic presenter instead of any office:
`{ id: GENERIC_EXECUTIVE_MEMBER_ID, acronym: "CEA", name: "Comisión Ejecutiva Ampliada", kind: "executive" }`.
Members of the other kinds read the same for everyone.

- It is done in the server, in the answer, never by hiding things on
  screen. Every place a member leaves the server goes through the helpers
  of `visibility.ts`: `redactMember`, `redactMembers` (several offices
  collapse into one entry), `redactPresenters`, `redactAuthors`
  (`mainAuthorId` follows its author), `redactAcceptances` (the offices answer
  as one party), `redactEventActor` (the person who acted for an office is not
  named either, since the name says which office), `redactPayloadMembers`
  (member ids in event and audit payloads, with the mask of
  `loadExecutiveMask`), `collapseExecutive` (the members list) and
  `visibleAcronym` (the PDFs, built with the requester's actor). A new
  answer that carries a member uses them. In a list in acronym order (the
  co-presenters, the members list, the presenters of a PDF) the generic
  entry goes where "CEA" sorts (`placeGenericByAcronym`), never where the
  office was, which would narrow down which office it is.
- The generic id is a constant with the shape of an entity id and is never
  a `members` row. The server never reads it as a member: in the body of a
  document it only stands for the offices already there, and in the body of
  an amendment it stands for nothing (422 `executive_author`).
- On a document, an account that does not see the offices neither adds nor
  removes one (`planListedMembers`, `planNamedMember` in
  `server/utils/domain/executiveMembers.ts`): naming an office by its real
  id, there or not, or the generic one with no office there, answers 422
  `executive_member`, and the offices already there stay whatever its list
  says, since it reads them all as one and could not tell which it drops.
  The generic id as main presenter, with several offices there and none of
  them in that place, answers 422 `executive_main`. The CEA itself or the
  Secretaría add and remove offices.
- Amendments and transactionals are the exception, because the CEA
  presents them too and any member may present one with it. Only in the
  composer are the real offices read by accounts that do not see them: an
  account that presents amendments for a member
  (`canNameExecutiveAuthors`) reads the list to pick from
  (`GET /api/members?for=amendment`) and, since 2026-11-10, whoever may
  edit a draft reads its real authors and main author
  (`GET .../amendments/[amendment]/authors`, `amendmentComposerAuthors`):
  while it composes, whoever may edit a draft always sees which offices
  present it. Both carry members only, never who acts for them, and the
  second answers under exactly the checks of the edit: an author, a draft
  (one sent back for correction included), and a document that still takes
  amendments (published, not voted, assembly not closed). Every office is
  therefore named by its real id (`planAmendmentBodyMembers`): the generic
  id is never an author (422 `executive_author`), an office as main author
  follows the rule of any member, and an office taken out of the list
  stops presenting the draft like any other member. An author that may
  not name the offices (it lost its member or `amendment:create`) still
  edits its draft: it keeps or drops the offices already there, which it
  reads in the composer, and cannot add another (422 `executive_member`).
  Outside the composer those accounts read
  the generic "CEA", its own draft included: lists, the detail, history,
  news, activity and PDFs. A list of member ids in a payload always
  carries the generic id last (`redactPayloadMembers`), so its place never
  tells which office it is.
  Parties of a transactional come from the database, so such an
  account still proposes one over an office's amendment.
- If an amendment was presented wrong, whoever reviews amendments
  (`amendment:review`) corrects its authors and its main author while it
  is presented and undecided (`changeAmendmentAuthors`,
  `amendment_authors_changed`). The code of a published amendment follows
  the new main author as after a correction (`numberingToKeep`), so it never
  names an office, and a code given up once public is never handed to
  another amendment (`nextMemberSeq`). One not published yet has no code to
  follow.
- Amendment codes never name the office: an amendment whose main author is an
  office is coded `CEA n` for everyone, numbered per document across all the
  offices (`amendmentCodePrefix`). Migration `0017` renumbered the existing
  ones and rewrote the codes kept in event payloads; an older code that
  named an office and has no amendment to follow (deleted since, or no longer
  an office's) was removed from them.

## Documents

`documents` keep their place in the agenda tree and gain:

- `kind`: `positioning`, `resolution`, `internal_motion`, `executive_report`,
  `regulation`, `statutes`, `budget`, `accounts`, `work_plan`, `agreement`,
  `report`, `minutes`, `candidacy`, `venue`, `other`. Defaults per kind
  (`shared/constants/documentKinds.ts`) set whether it is amendable, whether it
  is voted and with which majority. All defaults are editable per document.
- `format`: `structured` (amendable text) or `file` (uploaded PDF). It can change until the document is published; the draft text and the PDF both stay, so a switch back loses nothing. Only managers use a PDF for a kind that takes amendments by default; members present those as text (`fileFormatRefused`).
- `proponentMemberId` (who presents it) and `submittedByUserId`.
- `reference` (`RES 012/2026`, `MI 003/2026`), assigned on admission.
- `status`: `draft`, `submitted`, `published`, `withdrawn`, `postponed`.
- Optional per-document amendment window overriding the assembly calendar.
- `carriedFromDocumentId` for documents postponed to a later assembly.

The assembly overview and the agenda offer "Añadir documento" to managers
until the assembly closes, whatever the calendar says, and "Presentar
documento" to members while documents can be presented (the assembly is not
closed and `documents_close` has not passed). The modal starts with the
agenda item and proposes the kind and the title from it (`proposeFromItem`:
"Aprobación, si procede, del Posicionamiento sobre X" gives a positioning
titled "Posicionamiento sobre X"; an item that names several documents gets
no title). The editor opened from there leads back, and "Publicar y añadir
otro", "Enviar y presentar otro" or "Guardar y añadir otro" return with the
modal open on the next item without documents.

### Structured content

Structured text is a list of **blocks**, each with a stable id:

```ts
type Block = {
  id: string; // stable, never reused within a document
  type: "heading" | "paragraph" | "list_item" | "quote" | "image";
  level?: number; // heading level or list depth
  list?: "bullet" | "ordered";
  marker?: ListMarker; // ordered items: "1." (default), "1)", "a.", "a)", "A.", "A)", "i.", "i)", "I.", "I)"
  start?: number; // ordered items: the list starts again here, at this number
  cell?: BlockCell; // inside a table: { table, row, cell, header?, fill?, shade? (legacy), colspan?, rowspan? }
  align?: "center" | "right"; // start when absent; never justified (WCAG 1.4.8)
  image?: BlockImage; // image blocks: { asset, width, height, alt }; text stays ""
  text: string; // plain text
  marks: Mark[]; // bold/italic/underline/strike/link ranges over `text`
};
```

Versions live in `document_versions` (`blocks` jsonb, `kind`: `draft`,
`base`, `consolidated`, `published`, content hash, author, note). The document
points to its working version, to the **base** version frozen when the
amendment window opens, and to the published consolidated version. Visible
numbering of headings (articles, sections) is meant to be computed when
rendering (R-DOC-02 in `proceso-asambleas.md`); nothing computes it yet, so
the DOCX import writes those numbers into the text, where they stay as typed
text. Ordered lists do number themselves: consecutive items of a level with
one marker form a list, and `start` begins one again ("c)" after a paragraph
that interrupts "a)", "b)"). `orderedListNumbers` in
`shared/utils/content/lists.ts` is that rule; the web view, the editor and
the PDF group items the same way.

Tables are blocks too: every block inside one carries its cell
(`BlockCell`: table, row and cell ids as stable as block ids, header,
fill and spans). A cell's fill (`fill`) is the name of one of the seven
colours of CREUP's palette (burgundy, blue, beige, darkGrey, lightGrey,
green, purple), never a colour code; `shared/constants/cellFills.ts` is the
one list of them, with the text colour the platform sets on each (white, or
near-black on beige and light grey), and the editor's swatches, the view
(`cx-fill-<name>`, coloured in `main.css`, which a test keeps equal to the
list), the PDF export and the Word import all read it. The fill is only how
the cell looks: a header cell stays its own toggle (`header`, which makes
the `<th>` and the rows the PDF repeats), keeps the template's burgundy
without a fill and takes the fill when it has one. Content saved before the
palette marks a beige body cell with `shade: true`; that still validates, is
read as "beige" (`cellFillOf`) and is never rewritten in stored versions:
the schema hands it back as it came, so saving an untouched text keeps its
content hash, and only what the editor writes anew names the fill. An
amendment never changes a fill. Consecutive blocks of one table form it, of one row a row, of one
cell a cell (`groupTables`, `tableGrid` in `shared/utils/content/tables.ts`),
and a blank cell holds an empty paragraph. Amendments need no new
operations: a cell's text changes like any block's, and rows and columns
are added or removed by inserting or deleting the blocks of their cells.
The editor uses TipTap's tables with the ids kept on their nodes
(`TableIdsExtension`), and a table menu in the toolbar.

Images are blocks too (`type: "image"`, `image: { asset, width, height,
alt }`, empty text): a picture stored for the document in `document_images`
and on disk under `UPLOAD_STORAGE_DIR/images/`, never a link to anything
outside the platform. Uploads (PNG or JPEG, 10 MB) are checked by signature
and written again by `sharp`: turned upright, without metadata (no location
or camera details), at most 2,400 px a side. The editor inserts one from its
toolbar, or when a picture alone is pasted (a screenshot) or dropped, and
asks for its description, which is required; it sits on a line of its own,
outside tables and lists. Pasted HTML keeps its text only: pictures in it
that are not the platform's own are left out, and the editor says so once.
An image's id is a hash of its document and the bytes received
(`imageAssetId`), so the same picture given twice to one document (a Word
file imported again) is stored once. Saving the text and every amendment
operation check that each image is one stored for that document
(`assertImagesBelong`). Images are served to whoever can see their document
(`/api/uploads/images/[id]`), drawn in the PDF at their size within the text
width, and amendments insert or delete them like any block (a diff marks
an added or removed one with its border and says it to screen readers).
Draft edits never remove an image's file, since a published version may
still show it; files go with their document. Images nothing uses (uploaded
or imported and never saved) are removed by a daily job at 04:45 Madrid
time (`server/utils/domain/imageCleanup.ts`, queue
`document-images-cleanup`) once 14 days old: one still shown by any
version of its document or by any of its amendments stays. It records
`document_images.cleanup` per document (source `system`), and also removes
files left with no row.

The editor is Nuxt UI `UEditor` (TipTap) with a small extension that keeps a
`blockId` attribute on every block node, and offers heading levels 1 to 4
(shown as h2 to h5). DOCX import goes through `mammoth` in a child process,
is sanitized and converted to blocks (`server/utils/content/docx.ts`):

- Heading 1 to 4 become levels 1 to 4 (5 and 6 become 4). The Word title is
  dropped when it repeats the document's title, and kept as a bold paragraph
  otherwise; a subtitle is a paragraph. Quote styles become quote blocks.
- Numbered list items whose number blocks can show (their own level's number
  as 1, a, A, i or I, then "." or ")") stay list items, with Word's marker
  and, where Word continues or restarts the count, its `start`. Any other
  numbered paragraph (headings, "Artículo 5.", "1.1", legal numbering) gets
  the number Word shows written at its start. Bulleted ones stay lists.
- A table whose rows have one cell each (a framed signature or note) is read
  as its content. Any other table stays a table: its cells' blocks carry
  their cell, with header cells (Word's header rows and cells on a dark
  fill; in a table without fills, cells all in bold), fills (each Word fill
  becomes the nearest colour of the palette by RGB distance, white none)
  and spans. A table of contents is left out: the view offers its own
  index of the headings. A table nested inside a cell becomes a
  paragraph per row, cells joined by " | ".
- Footnotes and endnotes become paragraphs at the end that start with their
  reference ("[1]"); ordinals typed as a superscript letter become "ª"/"º";
  text in all caps is written in capitals. Centred and right-aligned
  paragraphs keep their alignment; justified ones go back to the start.
- Pictures become image blocks, stored for the document as they are read
  (the import stores them even though it saves no text; unused ones go with
  the daily clean-up). A picture inside a paragraph is lifted out to a
  block of its own between the two halves; Word's description becomes its
  alt text. PNG and JPEG stay as they are; GIF, WebP and TIFF become PNG.
  Pictures in tables of several columns or in lists, Office's EMF and WMF,
  charts, SmartArt and linked pictures are left out, as are those past 100
  per file or 32 MB in all; pictures in headers and footers never reach the
  text.
- The template's approval line ("Aprobada por [Mayoría] en la 80.ª Asamblea
  General Ordinaria el [Día] de noviembre de 2026.", or a regulation's
  "Modificado parcialmente en la … el XX de xxxxxxxxx de 202x.") is
  recognised by `shared/utils/content/approvalLine.ts`. The import dialog
  drops it with the repeated title by default (`templateHeader.ts`; kept in
  regulations and the Estatutos, where the history belongs to the text), says
  that a kept unfilled one fills itself in, and lists any other placeholder
  left in the text ("[Nº]", "XX", "202x"). The PDF of a document whose final
  vote approved it writes such a line with the vote's data ("Aprobada por
  mayoría simple en la 80.ª Asamblea General Ordinaria el 21 de noviembre de
  2026.", always in Spanish, as the text is) instead of the separate vote line
  under the title, and leaves an unfilled one out before that; the stored
  text never changes.
- It warns about tracked changes, comments, dropped images, images in
  tables, images without a description, flattened tables and highlighting,
  whose meaning is lost.

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
      marks?: Mark[]; // formatting of the new text, offsets inside `text`
      block?: BlockFormat; // new format of the whole block
    }
  | { op: "insert"; afterBlockId: string | null; blocks: NewBlock[] }
  | { op: "delete"; blockIds: string[] };
```

`replace` covers suppression (`text: ""`), addition (`from === to`) and
modification. A global term replacement is stored as a group of `replace`
operations with the search term recorded for display. The change typology
(supresión, adición, modificación) is derived from the operations.

A `replace` also amends the formatting of text that is already there, still
anchored to the base (`shared/utils/content/format.ts`):

- `marks` is the inline formatting (bold, italic, underline, strike, link)
  of the operation's new text, with offsets inside `text`. It takes the place
  of the base marks over `[from, to)`. With `text` equal to `baseText` the
  operation changes formatting only (new bold on a word). Without `marks`
  the base marks follow the text as they always did.
- `block` is the new format of the whole block (`BlockFormat`: `type`
  paragraph, heading, list item or quote, with `level`, `list`, `marker`,
  `start` and `align`). It travels alone, on an operation with `from` and
  `to` at 0 and empty `text` and `baseText`, one per block at most. Images
  and the table cell a block sits in are not amended this way.

Both fields are optional: amendments stored before them stay valid as they
are, with no migration, and consolidate to the same blocks and hashes.
`diffPassage` emits them for a block edited in place; what the editor does
by itself to a passage out of its document (a nested list item alone comes
back at the first level, a line break carries no marks) is not taken for a
change. A change of format counts as a modification. In overlaps a change
of marks takes its range like a change of text, and a change of `block`
takes the whole block: it collides (`same_text`) with any other change
inside it. Moving a block is still a deletion and an insertion.

A formatting change shows its text once, in its new format, with words that
say what changes ("pasa a negrita", "pasa a título de nivel 2";
`common.content.format.*`, from the `FormatChange` codes the engine attaches
to the segment or the block), on screen and in the PDF: never a strike and a
rewrite, and never colour alone. On screen the text carries a dotted line of
its own hue (`--cx-fmt-line`, neither the green of added text nor the red of
removed text) and the words go in a note at the end of its block ("Cambia el
formato: «de» deja de estar tachado"; `cx-fmt-label`, also the text's title
on hover), never inside the line. A change of format on blank text alone (a
space) is told only when it is its block's one change
(`isShownFormatSegment`); it is still applied.

- `kind`: `partial`, `formal`, `totality_return`, `totality_alternative`,
  `transactional`.
- Authors: `amendment_authors` (member ids; joint amendments have several).
- Numbering: `number` per document and a counter per code prefix, shown as
  `12 · CEUM 4`, both given on the amendment's first publication
  (`numberOnPublication`), in publication order. What everyone reads runs
  without gaps: an amendment withdrawn, declared inadmissible or abandoned
  before it was published never takes a number, and until then its authors,
  the Secretaría and the Mesa read it without one ("Sin número"). The
  executive offices share the prefix `CEA` (`12 · CEA 4`), so a code never
  names the office; a member whose prefix changed starts its own counter at 1
  (the CAS, an office before, presents `CAS 1`). Transactionals are `T1`,
  `T2`..., numbered when published too (a member's waits for its parties
  without one). A code names one amendment of the document
  (`amendments_document_code_unique`). Amendments numbered on presentation,
  before this rule, keep their numbers.
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
open/close, candidacies. Every date stays editable per assembly.

The calendar rules of each assembly type live in `calendar_rules` (one row
per type, `CalendarRules` in `shared/utils/calendar.ts`), because the
regulations change often. Managers edit them at `/admin/calendario`
(`CALENDAR_RULES_PERMISSION`, today `assembly:manage`). A rule set has:

- `defaults`: offsets before the start that fill a new calendar and the
  "Apply default deadlines" button (`defaultMilestones`);
- `minimums`: the latest each milestone may fall, as an offset before the
  start (notice of the convocatoria, final agenda, documents, the 72 hours the
  amendment window may be extended to, candidacies);
- `documentsWithConvocationBelow`: an assembly convened with less notice
  than this must publish its documents with the convocation (RRI art.
  13.1.a, extraordinary assemblies; null: no such rule);
- `regulationWindowDays`: the shortest amendment window of an amendable
  `regulation` or `statutes` document, its own window or else the assembly's
  (null: no minimum).

An offset is whole `days` or calendar `months` in Europe/Madrid (same
wall-clock time; a month back from the 31st clamps to the end of the shorter
month, so a notice is never under a month), or exact `hours`. `pnpm db:seed`
stores `INITIAL_CALENDAR_RULES` (`shared/constants/calendarRules.ts`, with
the article each value comes from) for a type with no row and never
overwrites a stored one. Without it the server falls back to them with a
warning, and the first save from the admin page stores the row, so a deploy
needs no `--seed` for this. Changing the rules never
moves existing dates.

`checkCalendar(rules, start, milestones, documents)` warns when the calendar
breaks a minimum (`short_notice`, `below_minimum`,
`documents_not_with_convocation`, `regulation_window_short`)
or is inconsistent, for example when amendments close before documents are
published. Minimums in days or months count calendar days in Europe/Madrid,
whatever the hour (`respectsNotice`): a convocation sent on 18 October at any
time gives a month's notice for an assembly starting on 18 November. Minimums
in hours count exactly. Warnings are computed on read, so past assemblies are checked
against the rules in force. The convocatoria is generated from the assembly
data, the agenda and the milestones (`ConvocationSheet`). Its page is a
section of the hub like any other (`convocatoria/index.vue`); "Imprimir"
opens the generated one alone, outside the shell, ready to print
(`convocatoria/imprimir.vue`). Once Secretaría uploads the signed
convocatoria (a PDF in `assemblies.convocation_file_url`, served by
`/api/uploads/convocations/[filename]` to whoever sees the assembly), that PDF
leads the convocatoria page for everyone, in the viewer of any uploaded
document (`DocumentPdfViewer`); managers still reach the generated one, and
replace or remove the PDF, from its "Más" menu.

## Assemblies and session

- Assembly `status`: `draft`, `convened`, `in_session`, `closed`.
  The agenda turns final (ODD definitivo, `agendaFinalizedAt`) on its own when
  the calendar's `agenda_final` date comes (`agendaFinalSince`); nobody marks
  it by hand, and moving that date moves it. Only a provisional agenda shows
  a badge. A final agenda
  does not lock anything: a manager still creates, renames, moves and deletes
  root items after confirming it (`confirmFinal`), and the event of that
  change carries `afterFinal: true`, which the activity shows. Sub-items are
  outside this: changing them is not changing the final agenda.
- Agenda items where members present ("containers"): `acceptsSubmissions`
  with `submissionKinds`, the document kinds the item takes (empty means
  every kind; it binds members, not the Secretaría). Each document created
  under one gets its own automatic sub-item (`generatedForDocumentId`),
  titled like the document. The sub-item follows the document's title until
  a manager renames it (`titleCustom`) and goes when the document is deleted
  or moved away, unless it holds something else by then; kept after a move,
  it is an ordinary item that remembers the document
  (`hiddenWithDocumentId`) until the document is deleted or a manager
  renames the item, unless a manager had already renamed it. Either way the
  item may carry the document's title, so a viewer who cannot see the
  document (another member's draft) does not get the item, or gets it
  without its title when something that viewer sees hangs from it, until
  the document is published. If the document is deleted before it was
  public, the items that carried its title and stay keep it withheld
  (`titleWithheld`): only document managers read it until one of them
  renames the item. A title a manager wrote (`titleCustom`) is never
  hidden once the item is no longer the document's. Agenda numbers are not
  stored, and everyone reads the same one for the same item: the numbers
  are those of an account that sees only what is public, so an item such
  an account does not receive (`AgendaItemDto.unlisted`) has no number for
  those who do receive it, shows as "Sin publicar" and never shifts its
  siblings (`numberAgendaItems`). A
  document in an automatic sub-item is not "expected" for that reason alone:
  `documents_close` binds it like any document a member chose to present.
- Deleting an agenda item removes its sub-items and every document under
  them, each with its own event and the same clean-up as a single delete
  (votes, projection, PDF and images). Only amendments keep it: one
  amendment of any status on any of those documents refuses the delete.
  During the session it is also refused while the item, a sub-item or one of
  their documents is being debated. The Secretaría adds several documents
  to one item in one step (`POST .../agenda/[item]/documents`).
- Per-assembly policies, with defaults from the research: who sees proponent
  positions, whether accepted amendments need a vote, the tie rule, and the
  majority denominator. Who sees a presented amendment is not a policy: the
  Secretaría publishes each one (see "Validation by the Secretaría"). Drafts
  of documents and amendments stay private to their authors and managers.
- `live_state` (one row per assembly): current agenda item, document and
  amendment under debate, plus the last recorded vote. The server projects
  every vote it records (amendment outcome, admission, final vote) and stops
  projecting it when it is voided (amendment reopened, final vote annulled).
- A wrongly recorded final vote can be annulled while the assembly is open:
  the vote row and the consolidated version stay for the record.
- Majorities are counted on the members present by default
  (`DEFAULT_ASSEMBLY_SETTINGS.denominator`), as RRI art. 18.2 counts two
  thirds "de los miembros representados" (RFAG art. 23.1 says valid votes;
  the RRI prevails). Each assembly may switch to valid votes.

### Headcounts and quorum

The Mesa takes a headcount at the start of each day, after a break or
whenever it decides (`headcounts`, `headcount_entries`). Each one marks every
asociado with a vote (the active `asociado` members, synced from the
Intranet) as in the room or not, and a member not in the room may delegate
its vote to another. The active sectorials are marked too, only as in the
room: they never vote, delegate, receive a delegation nor count for quorum
or `present`, and each entry stores whether it had a vote
(`headcount_entries.voting`), so a correction never turns one into a vote.
So are the guests: the accounts given the role `Invitado` here, by hand,
and the members of the Comité de Asuntos Internacionales and the Comité de
Garantías (roles `CAI` and `CdG`, from their intranet types;
`HEADCOUNT_GUEST_ROLES`) (`headcount_guests`, with the account's name at the count, so the record
survives a rename or a deletion). Every other account has the role `Otro`,
which only reads and appears in no count. The list of guests a new count
offers reaches only the Mesa; who was in the room is public, without
emails. The form and every list of a count follow the roll call
(`compareRollCall` and `compareGuests`, the one exception to
`orderMembers`): asociados, then sectorials, then guests, each in reverse
alphabetical order of its denomination and, for a council, its university
("Consejo de Estudiantes" + "Universidad de ..."), or of a guest's name. A delegated vote counts for quorum and for every vote
(RRI art. 19.3, RFAG art. 9.4) only while its receiver is in the room; the
delegation is kept otherwise, so it counts again when the receiver is back.
Each member receives at most one (Estatutos art. 17.1, RFAG art. 8.5).
`tallyHeadcount` (`shared/utils/headcount.ts`) counts and checks both on the
server and in the form.

The form is built for speed: a new count starts from the previous one, each
member is one checkbox under the heading of its group, and the delegation is
a quiet searchable menu on the asociados not in the room. "Marcar presentes
todos los asociados" ticks the asociados only. Until it is saved, the form stays as a draft in
the browser of that device (`localStorage`), so closing it by mistake or
reloading loses nothing.

A count stores a snapshot: the asociados with a vote at that moment
(`eligible`), those in the room, those delegated, the total (`present`) and
the members needed for quorum (`required`). Later roster syncs or rule
changes never rewrite a count; a correction keeps `eligible` and
`required`.

The quorum is data, part of each type's calendar rules (`quorum`, edited at
`/admin/calendario`): one share of the asociados with a vote, "at least" or
"more than". It is the quorum of the call a session opens in: an AGO
always starts in second call, so a third (Estatutos art. 14.1, RFAG art.
9.1; the half of the first call is never used and not kept), and an AGE or
AGET, with a single call, more than half (`INITIAL_CALENDAR_RULES` cites the
articles). The Mesa never picks a call. The Presidencia and the Secretaría Ejecutiva must also be present to
constitute the assembly; the form reminds the Mesa, the count does not check
it. The regulations are silent on re-checking quorum during the session; the
counts at the start of each day and after breaks follow the practice of the
assemblies and the delegations "antes del comienzo de cada jornada" (RFAG
art. 8.2).

The latest count is the base of majorities on "present": the vote forms
fill `present` from it (the Mesa may correct it for one vote) and the server
does the same when a vote leaves it out (`withHeadcount`). Every vote records
the count in force (`votes.headcountId`). A count without quorum, or none at
all, only warns: the Mesa may still record votes.

The counts are public, for transparency (GET `.../headcounts` for everyone
who sees the assembly). The live view (`LiveViewAttendance`) shows the
latest one: members present out of those with a vote, delegated votes,
whether there is quorum and, with majorities on the members present, the
votes in favour an absolute and a two-thirds majority need
(`majorityThreshold`), with who is in the room with a vote, the sectorials
and guests in the room, the delegations (and which do not count) and the
earlier counts folded away. The projection's header
carries the same figures on one line during the session.

- Live updates: mutations `pg_notify('assembly_events', ...)`. A Nitro plugin
  `LISTEN`s and fans out to SSE streams at `GET /api/assemblies/[id]/live`.
  Events carry ids only; clients refetch through the normal, permission-checked
  endpoints. If the stream drops, clients fall back to polling. No Redis.

## Validation by the Secretaría and documentation tracking

Every document and every amendment is presented by the user who wrote it,
acting for their member: a council (Asociado accounts), a sectorial
(Sectorial accounts, which never present an internal motion), a CEA
office (CEA accounts, intranet type `CEA`, linked to an `executive` member by
their intranet id) or the CAS (the Coordinación del CAS, role `CAS`, linked
to the `other` member `CAS`, which never presents an internal motion
either). Nothing a member presents is visible to the rest of
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
  its authors. On the document page the Secretaría finds the ones it sent back
  under "N devueltas para corregir", next to what it still has to validate or
  publish, until the authors send them again.

Until it is published, an amendment is visible only to its authors, its
creator, the parties of a transactional and the Secretaría and Mesa. A
transactional created by the Mesa in session is validated and published at
once. `reviewState` on `AmendmentDto` tells authors where their amendment
stands. The time-based `amendmentVisibility` setting is gone.

**Where people see their work.** The home page (`GET /api/me/work`) lists what
each user has to do (expected documents, corrections requested) and where
their documents and amendments stand. The Secretaría gets a validation inbox
per assembly (`GET .../review`) and the tracking panel.

## Reviewing amendments, transactionals and the session

**Main presenter and main author.** A document can have co-presenters
(`document_proponents`); when it has several presenters one of them must be
the main presenter (`documents.proponentMemberId`), and only that member (or
the Mesa on its behalf) answers the amendments to the document. Likewise an
amendment with co-authors must name its main author (`mainAuthorId`), and only
that member answers the transactionals proposed over it. Co-presenters and
co-authors always see what the main one decided (who, what, when) on the
document or amendment and in the "Novedades" of their home page. Only the main
presenter itself or the Secretaría changes who the main presenter is.

**Amendment flow.**

1. It is presented, on time or late.
2. The Secretaría validates it (or asks for a correction) and publishes it,
   now or later.
3. If it is late, the assembly decides whether to treat it; the Secretaría
   (or the Mesa) records that decision. Until then it cannot go further.
4. The document's main presenter accepts or rejects it (its position, with an
   optional comment), only once it is validated, published and, if late,
   admitted, and never after the document's final vote. The Mesa can record
   the answer on its behalf, and everyone sees who recorded it.
5. The assembly votes it. Each document has a rule for accepted amendments
   (`documents.acceptedAmendments`, default from its kind): with
   "incorporate" (regulations by default) an amendment the main presenter
   accepts is approved at once without a vote (approval method
   "proponent"); if the presenter changes its answer before the final vote,
   the amendment goes back to undecided. With "vote" every amendment is
   voted.

**Proponent review.** The main presenter goes through the amendments it has
to answer one by one in a review mode: the change in large type, its
justification, and Aceptar, Rechazar or Transaccionar with an optional
comment. A progress line shows how many are left.

**Transactionals.** Once amendments are published, any member (CEA or
assembly), before or during the session, can propose a transactional over one
or more of them:

1. it is presented ("pending_authors");
2. the main author of each amendment it would replace accepts or rejects it;
   if any of them rejects it, it is closed and the originals carry on;
3. the Secretaría validates it, which always publishes it (it builds on
   amendments that are already public);
4. once validated and accepted by every main author, it replaces those
   amendments (they become `transacted`) and follows the normal amendment
   flow: the document's main presenter answers it and the assembly votes it
   (or it is incorporated, per the document's rule).

The Mesa can still draft one live in the console: it is validated and
published at once, and it replaces the originals as soon as their main
authors accept it in the room. Transactionals build only on published,
admitted, undecided amendments.

When a transactional replaces its originals, any other transactional still
open over any of them lapses. When an original is settled another way
(withdrawn, lapsed, declared inadmissible, voted, or incorporated by the main
presenter's acceptance) before the transactional replaces it, the
transactional closes by itself, and its authors see why in their news.

**Session console.** Several people use it at once (Presidencia moderates,
Secretaría records results), all live. It leads with what is being debated
now, in large type, with the actions that fit it; the queue, the agenda and
the consolidated text are secondary and foldable.

**Speaking turns.** The Mesa writes down who asks to speak (a member and,
optionally, the person's name), gives and ends the floor, and reorders the
queue. Attendees see who has the floor and who is next only while the Mesa
makes it visible (`live_state.speakersVisible`), in the live view and on the
projection.

**Live view for attendees.** A phone-friendly page that follows the session:
the item, document and amendment under debate with its change, the last
result, who has the floor when visible, and the status of every amendment of
the current document with the provisional consolidated text. Under the
amendment in debate it says in one line how the document's main presenter
answered it ("Respuesta de CEUM: la acepta"), or that the Mesa recorded the
answer on its behalf, without the comment. It shows this only when the
assembly does not keep answers to the Mesa (`positionVisibility` other than
"mesa"), since the page shows what the room sees.

**Roles and per-user permissions.** The association's Secretaría and
Presidencia hold every permission, users and roles included. The Mesa's
Vocalía and Presidencia use the `Moderador` role (`session:moderate`). The
admin pages open by permission (`user:manage_roles` for users and their
grants, `role:manage_permissions` for roles), and only an Admin can give or
take the Admin role. Only an Admin changes the access of Secretaría and
Presidencia: giving or taking either role, what either grants, and the
individual grants of whoever holds one, so neither can change the other's.
Nobody but an Admin raises their own access or locks themselves out of the
admin pages, and the last Admin cannot leave the role. Besides role
permissions, a user can be granted individual permissions
(`user_permissions`); a user's permissions are the union of both.

**Intranet.** Calls to the intranet API send `Authorization: Bearer
<NUXT_INTRANET_API_TOKEN>` when the token is configured, and the role lookup
sends `Accept: application/json`. The Intranet removed its old public
`POST /api/user/role`, which revealed a user's type, name, initials and
university to anyone who knew an email. Its group `/api/asambleas/v1`
requires that token and answers only what this app needs; it is reachable
from the internet (`https://intranet.creup.es/api/asambleas/v1`, which the
development server also uses, with real data) and, on the VPS, over the
Intranet's Docker network (`http://intranet/api/asambleas/v1`). In production the base URL must be `https:`, or `http:` to a
host with no dot (`http://intranet`); anything else counts as unconfigured.
Logs never carry an email, only `accountRef` (a keyed HMAC of it). What the
Intranet has to implement, and how, is in [`intranet.md`](intranet.md).

**Access and deleted accounts.** Every Google account may sign in, except one
the Intranet deleted. The role lookup runs once per sign-in, before the
session exists (better-auth `session.create.before`, `checkSignInAccess` in
`server/utils/auth/roleSync.ts`), and role sync reuses its answer. Only a
successful lookup writes the intranet data, `users.intranet_id` and
`lastRoleSyncAt`. An authenticated 404 `{"error":"not_found"}` for an
account the Intranet knew before (`externalRole` or `intranet_id` set)
revokes its access in one transaction: `users.access_revoked_at` and
`access_revoked_reason` (`intranet_deleted`, from `ACCESS_REVOKED_REASONS`;
the CHECK `users_access_revoked_consistent` keeps both set or both null),
role `Otro`, no member, every session deleted, its open impersonations
closed (`revoked`), and `user.access_revoked`. The sign-in is refused and
lands on the login page of the user's language with `?error=access_revoked`
(the client sends it as `errorCallbackURL`). Per-user grants are kept and
apply again on restore.

- Protected roles (Admin, Secretaría, Presidencia, Moderador) keep
  everything and get `user.intranet_missing` and a warning instead; an
  account the Intranet never knew stays as it is (a new one is an
  `Otro`).
- A revoked account gets access back only at a sign-in whose authenticated
  lookup returns it (`user.access_restored`); role sync then gives back its
  role and member. There is no manual restore: the Intranet is the source of
  truth. Any other answer, an unreachable Intranet included, refuses it. Its
  role cannot be changed by hand either (409
  `admin.users.errors.targetRevoked`), and an Admin without access does not
  count as the last Admin.
- Intranet failures never block anyone with access, but a database error
  while checking refuses the sign-in (`sign_in_unavailable`).
- Open sessions: sessions last 7 days and renew each day they are used, so
  sign-in alone would never catch an account that keeps its session alive.
  A daily re-check (05:30 Europe/Madrid, pg-boss queue
  `users-access-recheck`, `server/utils/auth/accessRecheck.ts`) looks up
  again, one every half second, every account with a live session, access,
  intranet data and no protected role, and revokes those the Intranet
  deleted. It never touches role sync data. It runs whenever the role
  lookup is authenticated, whatever `NUXT_INTRANET_ROSTER_SYNC` says. If the
  Intranet no longer has more than max(3, 30%) of the accounts it answered
  for, it revokes nobody, records `users.access_recheck_blocked` and logs
  an error; after 5 failed lookups in a row it stops and pg-boss retries.
- Every request reads `access_revoked_at` (`getAuthUserWithRole`): an
  account without access gets 401 at once, even on devices whose session
  better-auth still serves from its 5-minute cookie cache.
- The token only travels to the Intranet it is for: a `NUXT_ROLE_API_URL`
  on another origin than `NUXT_INTRANET_API_URL` is called without it
  (`isRoleLookupAuthenticated`), so it can never revoke anyone.
- The users page marks such accounts "Sin acceso" with the reason and the
  date, filters them with `/admin/usuarios?access=revoked`, and never offers
  "Acceder como" on them.

## Read marks

Going through the documentation of an assembly is linear work: every
published document, then every amendment to it. Each account keeps its own
marks of what it has read (`document_reads`, `amendment_reads`, one row per
account and document or amendment).

- **By hand.** Opening a document or an amendment never marks it: reading it
  and having opened it are different things. "Marcar como leído" does, and
  the same button takes the mark back.
- **Per account.** A council's account is the council, so its delegation
  shares the marks. Nobody else reads them: no endpoint returns another
  account's.
- **What takes a mark.** Published documents (`status` `published`) and the
  amendments to them that are presented and published. Everyone who sees
  the assembly reads those, so the marks need no visibility rule of their
  own, and nothing else can be marked (404).
- **Changed since.** A mark stores the revision it was made on: a document's
  frozen base version and its PDF, an amendment's operations and
  justification. When the current revision differs (the document was
  published again after a correction, its PDF was replaced, the amendment
  came back corrected) the mark reads as `changed` ("Con cambios") until the
  account marks it again.
- **What is left.** Everything not read as it is now, except what the
  account's member presents (`own`) and the amendments already decided
  (`open` false). The pure rules are in `shared/utils/readMarks.ts`.

The hub fetches the marks once (`provideReadMarks`, client only) and every
page under it reads the same state (`useReadMarks`): the overview's agenda
block says how much is left and opens the first document with something
left ("Empezar a leer" / "Seguir leyendo"), each agenda item says how much
of that is under it, rows and amendment cards carry a dot ("Sin leer"),
"Con cambios" or a tick, and the documents list filters by what is left.

A published document's page starts with the reading bar (`DocumentReadBar`):
"Documento 3 de 25", the documents before and after it in the order of the
agenda (`documentsInAgendaOrder`), what is left in the whole assembly (which
opens the next document with something left) and "Marcar como leído". With
the breadcrumb, which leads back to the document's agenda item, the whole
documentation can be read without going back to a list.

Every change of marks is recorded (`read_marks.set`, counts only), like any
other mutation.

## Private notes

Reading a document to prepare an assembly means writing things down: what
to ask, what to amend, what one thinks of a paragraph. Each
account keeps private notes on the published documents (`document_notes`).

- **Two kinds.** About the whole document (no anchor), or on a stretch of
  one block of its text: the block id, the stretch as character offsets
  into the block's text as it shows, and the text it covered (`quote`). A
  selection that runs over several paragraphs is cut at the end of the one
  it starts in.
- **Per account.** A council's account is the council, so everyone who uses it
  shares the notes. Nobody else reads them: every read and write is keyed by
  the account. An Admin acting as the account is that account here as
  everywhere else: it reads its notes, and what it writes is recorded
  under the impersonation.
- **Never recorded.** The activity keeps that a note was written, changed
  or deleted (`document_note.created`, `.updated`, `.deleted`, with
  `anchored`), never its text nor where in the document it is.
- **The text may change.** Nothing here follows the document. When it is
  published again after a correction, `locateNote`
  (`shared/utils/documentNotes.ts`) finds the note where it was written if
  the text there is still the quote, else at the first place the quote
  shows in the block. One that cannot be placed is kept and listed with its
  quote ("Sin ubicación").
- **Limits.** 4000 characters a note, 2000 a quote, 200 notes per account
  and document; only its text can be changed, with an optimistic lock on
  `updatedAt` (the account may be open in several places).

On screen (`DocumentNotes`, on the document page and in the reader of an
agenda item) "Notas" opens the list in a side panel, in the order of the
text; "Añadir nota aquí" in the text's right-click menu writes one on the
selection, or on the whole paragraph without one. A note on the text shows
as a soft highlight with a dotted line, drawn with the CSS Custom Highlight
API over the rendered text (its HTML is never changed); pointing at it or
pressing it shows the note. A browser without that API shows no marks, and
the notes stay in the panel.

## Traceability

Every change leaves a record of who did it, acting for which member, when,
from where and, while an Admin impersonates, who really did it.

**Two tables, two writers.**

- `events` holds the proceedings of an assembly: agenda, documents,
  amendments, votes, decisions, live state, speakers. Only `recordEvent`
  (`server/utils/domain/events.ts`) writes it, which also notifies live
  listeners.
- `audit_log` holds everything else: accounts, roles, permissions, members,
  calendar rules, sign-ins, exports, assembly deletion, imports and
  impersonations. Only
  `recordAudit` (`server/utils/domain/audit.ts`) writes it. It fills the actor,
  the impersonation, the IP (`getRequestIP` with X-Forwarded-For, trustworthy
  only behind a proxy that overwrites that header) and the user agent, keeps
  `source` (`user`, `intranet`, `auth`, `seed`, `system`, `import`) and
  `assembly_id` (no FK, so it survives the assembly), and writes nothing when
  `before` equals `after`.
- Both carry `impersonation_id`. The actor columns keep the account acted as,
  so authorship and visibility stay its own.
- `server/utils/domain/traceability.test.ts` fails when a file other than
  `audit.ts` inserts into `audit_log`, when a mutation endpoint reaches neither
  writer (the DOCX import, which writes no state, is the only listed
  exception), or when server code reads `session.user`.

**What is recorded beyond the domain events.**

- Accounts: `user.created`; `auth.sign_in` (with the role sync outcome),
  `auth.sign_out` and `auth.session_ended`, with IP and user agent.
- Role sync, in the transaction of the users update: `user.role_sync` with
  before and after (role, external fields, intranet id, member),
  `user.initial_admin`, and the automatic `user.member_link` and
  `member.create`, source `intranet`.
- Access, source `intranet` and no actor: `user.access_revoked` (before and
  after: role, member, reason, plus the sessions and impersonations it
  ended), `user.access_restored`, `user.intranet_missing` for a protected
  role the Intranet no longer has, and `users.access_recheck_blocked`
  (target `users`/`intranet`, counts only, Admins only) when the daily
  re-check refused a mass revocation.
- Admin section: `role.assign`, `user.permissions_set`, `user.member_link`,
  `permissions.set`, with the caller as actor and no row when nothing changed.
- Members: `member.create`, `member.update`, and for each roster sync one row
  per created, updated or deactivated member plus the `members.sync` summary,
  sharing a `batchId`; `members.sync_blocked` when a large deactivation was
  not confirmed. The daily sync's rows have no actor; a manual one's keep the
  account that ran it.
- Exports: `export.request` (no job without its row) and `export.download`.
- `rbac.seed` when the seed adds grants; `assembly.import` when data is loaded
  outside the app (source `import`, no actor).
- `assembly.delete` keeps a compact copy of the deleted draft's history.

**Event payloads.** Update events carry `payload.changes = { field: { from,
to } }`, built only with `diffChanges` (`server/utils/domain/changes.ts`) from
the stored row against what was written: never content blocks or correction
notes, texts cut to 500 characters. Delete events carry an explicit allowlist
that names the entity and its insiders (presenters, authors, creator) after
the row is gone.

**Reading the activity.** `server/utils/domain/activity.ts` is the only
reader: one `UNION ALL` over `events`, `audit_log` and `impersonations`, keyset
pagination on `(created_at, id)`, labels loaded per page. Every row is judged
again with the current actor using the visibility helpers; payloads pass
through per-action allowlists (`EVENT_PAYLOAD_KEYS`, `AUDIT_PAYLOAD_KEYS`, and
`CHANGE_FIELDS` for edits), so a new payload key is hidden until it is listed.

- **Mi actividad** (`/actividad`, from the user menu), for every account:
  what it did, changes to the account (role, permissions, member link, role
  sync, grants of its role while it held it), its accesses (sign-ins and
  sign-outs with its own IP, access lost or given back) and, when linked,
  what other accounts did for its
  member. A notice says when an Admin acted as the account in the last 30
  days. Rows about something the account can no longer see keep their type and
  time and say so. Others' IPs and emails are never shown.
- **Actividad** (`/admin/actividad`), Admin only (the real role, never a
  permission key): every row unredacted, with IP and user agent, filters in the
  URL (account, member, assembly, category, source, impersonations, dates,
  text) and the list of impersonations.

**Personal data.** IP addresses and user agents in `audit_log` and
`impersonations` are personal data (GDPR, LOPDGDD). There is no retention
policy yet: plan a job that clears them after a period, and include both
tables in access and erasure requests and in backups.

## Impersonation

An Admin can act as another account to see and do what it sees and does, for
support and testing. It is a server-side pointer, not a second session: the
browser keeps the Admin's own better-auth session, and the table
`impersonations` (admin, target, Admin session id, reason, start, end, end
reason, IP, user agent) says that this session acts as another account.
better-auth's admin plugin is not used.

- **Who.** Only a user whose real role is Admin (never a permission key:
  Secretaría and Presidencia hold every key). Never as oneself, never as
  another Admin, never as an account without access, never nested. A reason
  is required.
- **How long.** Fixed 60 minutes, never renewed, capped by the Admin's own
  session. Signing out, losing the Admin role, the target becoming Admin or
  the target losing access ends it (`stopped`, `expired`, `signed_out`,
  `revoked`), each with an audit row.
- **Effective identity.** `getAuthUserWithRole` loads the real user and, only
  for Admins, the open row of the session. While it applies, the request runs
  entirely as the target: permissions, member, visibility, authorship, exports,
  news. Role sync never runs for the target, because no session is created for
  it.
- **Safeguards.** The admin section, `/api/members` and
  `/api/calendar-rules` are read-only. Every
  unsafe request carries `x-acting-user` with the account the page acts as;
  for a real Admin it is required, and a mismatch (an expiry, or a stop in
  another tab) answers 409 and the page reloads, so a form opened as the target
  is never submitted as the Admin. A banner on every page, the error page
  included, says "Estás actuando como …" with "Volver a mi cuenta", which also
  replaces "Cerrar sesión" in the user menu.
- **Visibility.** Every act carries the impersonation. That an act was done by
  an Admin as the account is shown only to that account (in Mi actividad, its
  news and histories) and to Admins; everyone else sees the act as the
  account's.

## Permissions

The existing keys stay, plus:

- `member:manage`: sync and edit members;
- `session:moderate`: Mesa actions such as live state, admissions, votes,
  decisions and transactionals on behalf of parties.

The default `Moderador` role gets `session:moderate`. The `CEA`, `CAS` and
`Sectorial` roles (synced from the intranet types `CEA` and `Sectorial`, and
from the role lookup's `CAS` for the Coordinación del CAS) get
`document:create` and `amendment:create`, like `Asociado`; `CAI` and `CdG`
(intranet types `CAI` and `CdG`) get nothing, like `Invitado`. Sectorials
and the CAS present everything but internal motions; they may amend one. That is a rule of the
member, not a permission: it follows the member a document is presented for
(`memberMayPresent`), so it binds managers and accounts linked by hand too.
Validating documents needs `document:manage`; validating and
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

Every page of the shell shows a breadcrumb row under its navbar
(`ShellBreadcrumbs`): `Asambleas › 80.ª AGO › Documentos › R-3 › Editar`.
The administration pages have none: they hang straight from the sidebar,
which names the section, and their navbar names the page. The last crumb is the page on show; below `lg` the
row is a single link to the level above. The trail comes from the route
(`app/composables/shell/-trail.ts`), so pages do not link "back" up the
hierarchy themselves. Every agenda item and sub-item has its own page
(`orden-del-dia/[item]`, keyed by the slug of its title, `AgendaItemDto.slug`
from `agendaItemSlugs`, never stored and so renamed with the item; its number
is no key because it changes when the agenda is reordered; an item whose
title the viewer may not read goes by its id, and an older link by id moves
to the slug): number, title and description, its documents
in full, its sub-items as links and "Anterior" / "Siguiente" in reading
order, all from the agenda the hub already loads. Its trail names the items
above it: `Asambleas › 80.ª AGO › Orden del día › 3. Resoluciones › 3.2 …`.
A document hangs from an agenda item, and its trail goes through it whatever
page it was opened from: `Asambleas › 80.ª AGO › Orden del día › 3.
Resoluciones › RES 4` (`useDocumentBreadcrumb` registers the items from the
agenda; a document whose item the viewer does not get keeps the route's
trail, `Documentos › RES 4`). So the way back from a document is the item it
belongs to.
The sections of an assembly come from one list
(`app/composables/assembly/-sections.ts`, `useAssemblySections`) for the
sidebar and the phone toolbar of the hub; whoever has a section of the
Secretaría or the Mesa sees them under "Asamblea", "Secretaría" and "Mesa".

The first time an account reaches the shell, a welcome opens by itself
(`ShellWelcome`, mounted client only by the default layout): five short steps,
one idea each, with a drawing made of icons.

1. What the platform is and what this account can do.
2. Where it sees what it has to do (the home page) and how to reach an
   assembly.
3. Its main task: presenting a document or an amendment, validating and
   organising (Secretaría), running the session (Mesa) or reading (Otro, Invitado).
4. How to go back (the breadcrumb row) and where the help is.
5. "Ponlo a tu gusto": language, theme, content font and how changes are
   marked, chosen right there.

The wording follows what the account can do, not the name of its role
(`welcomeAudience` in `app/components/shell/-welcome.ts`): whoever manages
assemblies, documents or amendments reads the Secretaría's text, whoever only
moderates the Mesa's, a presenter the text of the member it acts for (office of
the CEA, council or sectorial) and anyone else the guest's. Closing it at any
step records in the browser that it was seen (`localStorage`), so it never
opens by itself there again. It is per browser, not per account, like the
language, the theme and the content preferences: an account may be shared by
several people (a council's account is the council), and each one should see
the welcome once on their own device. "Ayuda", in the user menu next to
"Preferencias", opens it again at any time. While an Admin acts as another
account the welcome never opens by itself and nothing is recorded.

Language, theme and the content accessibility preferences live together in one
component (`ShellPreferences`), as radio groups in plain sight: the last step
of the welcome shows it, and so does "Preferencias", the single entry of the
user menu that replaced the language and theme submenus. The choices
themselves stay per browser (the locale cookie, the colour mode and
`localStorage`).

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
  - To amend, one button ("Presentar enmienda") opens the composer in place
    of the text and the list (the whole width; the whole screen on a phone):
    - the whole base version in the block editor, opened at the paragraph the
      reader had at the top of the text (or had selected); a stored draft
      opens with its operations applied, at its first change;
    - the author edits it like any text. Nobody says whether a change
      modifies, adds or suppresses: `diffPassage` over the whole document
      derives the operations, formatting included, a moment after the author
      stops typing. Everything changed in one go is one amendment with one
      justification;
    - the editor offers what an amendment can express: text, marks, links,
      headings, lists and their numbering, quotes, alignment, new blocks and
      tables, and rows and columns of a table. It leaves out what the engine
      does not compare on a table of the base (the fill of a cell, header
      cells, merged cells) and new images. Moving a paragraph is removing it
      and adding it;
    - a panel that stays in view asks three things: content or form
      (content for a new amendment), who presents it (alone or with other
      members, and then the main author; the Mesa may present it on behalf of
      a member) and why (optional, except for sending the document back,
      whose justification is all it says). Under them, how many paragraphs
      change and "Revisar y enviar";
    - "Revisar y enviar" shows the changes as everybody will see them
      (`ContentAmendmentDiff`), then the justification, which may run to
      several paragraphs, what is missing in plain words, the late and
      correction notices, and "Guardar borrador" and "Enviar". The document's
      reading bar (previous, next, "Marcar como leído") hides while it is
      open. Leaving with changes that were not saved asks first, going to
      another document of the assembly included.
  - Changing a word everywhere, sending the document back and proposing an
    alternative text are links under that button, each with a sentence, and
    open the same composer with their own form in place of the editor.
  - The amendment list is ordered by position, filterable, and grouped by
    overlap cluster.
- **Session console** (Mesa): agenda progress, the current document's
  amendments in text order and grouped by overlap, one-click outcomes, vote
  entry with the computed result, the transactional composer, late admissions,
  relations, and the live consolidated preview with conflicts.
- **Projection**: chrome-free large text showing the passage under debate and
  its diff, then the vote result. It updates live.
- **Consolidated view and exports**: clean and annotated PDF, plus an annex of
  every amendment and its outcome. Exports use CREUP's document template:
  CREUP and ESU logos, a band down the left edge naming the kind of document
  ("Documentación interna", "Moción Interna", "Normativa propia",
  "Posicionamiento", "Resolución"), website, email and page count in the
  footer, Raleway 11 pt and the title alone above the text. Level 1
  headings sit on a burgundy bar and level 3 in a burgundy box, as they do
  in the platform's viewer and editor; positionings open with a cover page. Links are blue, clickable and
  numbered, with their addresses listed at the end for print.

Content accessibility preferences (fonts, diff color or marks) keep applying to
document content only.
