# Control sheet ("Hoja de control"): implementation plan

Revised draft, 2026-11-14, after a review from four angles (requirements,
security, data model, UX). Not committed. It replaces the Excel control
sheet kept during an assembly (79.ª AGO: `General`, one row per agenda
item; one tab per amended document). Requirement R-SES-01, and partly
R-SES-04, R-VOT-01/03/04, R-TRZ-03/04 and R-OTR-02 in
`docs/proceso-asambleas.md`.

## What the user asked (2026-11-14)

- A hub section for the CEA, the Mesa (Moderador), Presidencia and
  Secretaría, with separate view and edit permissions so the CEA may later
  be limited to viewing. Everyone with access edits by default.
- Votes belong to agenda items and sub-items, not documents. An item can
  get more votes: a vote on an item without documents, or a procedural
  motion (a present asociado asks for it; record who, what is voted, the
  sense of the vote and the result). Suggested motives: «Solicitud de voto
  registrado», «Solicitud de voto secreto», «Cambio del orden de la sesión».
- Every vote records its method: assent (unanimity may be asked for
  afterwards and is granted if nobody objects), show of hands, registered
  (each asociado's vote) or secret.
- The Mesa may treat items out of order.
- The sheet lists the items that are voted, in principle those with
  documents; a vote of an item without documents can be added from the
  sheet, and a vote the assembly records later shows there.
- Treated: a voted item or amendment is treated when its vote is recorded;
  otherwise the Mesa marks it.
- Observations per item and per amendment, editable by everyone with
  access, recording who edited.
- Speakers per item and per amendment, written down from the Mesa console,
  plus a way for someone outside the Mesa to write them down («esto puedes
  proponerme algo mejor»).
- «Posición CEA» per amendment, new and shared: Aceptar, Transaccionar,
  Rechazar, Decae.
- Used live and afterwards for the minutes. Excel download.

## Decisions taken from the user's words

- Sheet editors (`control_sheet:edit`) may record votes of items without
  voted documents and procedural motions from the sheet, set unanimity on
  them and void them. Document final votes and amendment outcomes stay Mesa
  acts in the console. Only the console moves the projection.
- Motions show in «Votaciones», marked as motions, and never count for the
  item's result or treated state.
- A registered vote records «No vota» too. A missing or old headcount warns
  and never blocks.
- Sheet fields stay editable after the assembly closes (for the minutes).
  Recording or voiding votes after closing stays refused, as today.
- An item with several voted documents (the accounts: three documents) is
  voted once, and that vote becomes the final vote of each of them; the
  Mesa may still vote them one by one.
- `portal` is offered only in AGETs (they vote through the portal); the
  other types get the four methods the user named.
- The CAS (role `CAS`) gets no access: the user did not list it.
- «Decae» goes into the CEA position only. The presenter's answer stays as
  it is; an amendment that lapses is already a Mesa outcome.
- The Mesa may withdraw a document, or postpone it to another assembly,
  during the session (its real status), from the console and the sheet
  (user, 2026-11-14).
- A motion records when it was voted and where: during an item, or between
  two items (asked after one item ends and before the next starts) (user,
  2026-11-14).
- Jumping ahead needs no marking: the items skipped stay pending (user
  asked, 2026-11-14).

## 1. Permissions

- `control_sheet:view` (`CONTROL_SHEET_VIEW`), «Ver la hoja de control»;
  `control_sheet:edit` (`CONTROL_SHEET_EDIT`), «Editar la hoja de control»
  (implies view); `session:record_speakers` (`SESSION_RECORD_SPEAKERS`),
  «Anotar turnos de palabra».
- Defaults: CEA and Moderador get view and edit; Secretaría and Presidencia
  get every key already. Nobody gets `session:record_speakers` by default.
- Helpers in `actor.ts`: `canViewControlSheet` (view or edit),
  `canEditControlSheet`, `canRecordSpeakers` (moderate or record_speakers).
  The console never depends on the sheet keys.
- The three keys join `EXECUTIVE_VISIBLE_PERMISSIONS` (the minutes name the
  office that presents or speaks), with tests.
- Rollout: `deploy.sh --seed`. Limiting the CEA later means taking the key
  from the role at /admin/roles and out of `DEFAULT_ROLE_PERMISSIONS`, since
  the seed adds back the defaults a role lacks.
- Never in the welcome's `SECRETARIAT_PERMISSIONS`; the welcome mentions
  the sheet to whoever holds the view key.

## 2. Data model

All additive. One migration per release; the previous release must keep
running on it.

- `vote_subject` gains `agenda_item` and `procedural_motion`, appended.
  No migration of the same release references them (the migrator runs a
  deploy's migrations in one transaction): no partial index, CHECK, default
  or backfill names them.
- `votes` gains `unanimous` (default false), `updated_at` (lock token, set
  explicitly), `voided_at`, `voided_by_user_id` and `question` (what an
  item vote decides). Built in phase 3 (migration 0035).
- `agenda_items` gains `voted` («Se vota el punto», default false): the
  item is voted by itself, so the sheet lists it and reads it «Pendiente»
  instead of «No aplica» until its vote. Ignored while a document of the
  item is voted (`itemHasVotedDocuments`). Decided with the user on
  2026-11-15; built in phase 3.
- Which votes are valid: an amendment, document or admission vote only
  while `amendments.outcome_vote_id`, `documents.final_vote_id` or
  `decisions.vote_id` points at it; `voided_at` is the truth only for the
  `agenda_item` and `procedural_motion` subjects. Every new reader follows
  this rule.
- `vote_ballots`: `vote_id` (cascade), `member_id` (restrict),
  `cast_by_member_id` (the delegate), `choice` (`in_favor`, `against`,
  `abstention`, `not_voting`); PK (`vote_id`, `member_id`).
- `procedural_motions`: `id` (cuid, made before the vote so both point at
  each other), `assembly_id` (cascade), `placement` (`during`: inside
  `agenda_item_id`; `after`: between items, after `agenda_item_id` ended
  and before the next one started; `start`: before the first item, item
  null), `agenda_item_id` (restrict), `amendment_id` (null; set null),
  `requester_member_id`, `motive` (`registered_vote`, `secret_vote`,
  `session_order`, `other`), `motive_text`, `question`, `sense`, `vote_id`
  (set null), `voided_at`, `voided_by_user_id`, `created_by_user_id`,
  `created_at`, `updated_at`.
- `control_sheet_items`: `id` (cuid, the entityId of its events),
  `agenda_item_id` (unique), `assembly_id`, `listed` with
  `listed_updated_at`, `manual_result` (`withdrawn`, `lapsed`,
  `not_applicable`), the Mesa's marks (`treated_at`, `treated_by_user_id`,
  `postponed_at`, `postponed_by_user_id`, `postponed_after_item_id`,
  `postponed_motion_id`) with `progress_updated_at`, the observations
  (`observations`, `observations_updated_at`,
  `observations_updated_by_user_id`), `result_updated_at`, `updated_at`
  (bookkeeping, never compared).
- `control_sheet_amendments`: `id` (cuid), `amendment_id` (unique),
  `assembly_id`, `cea_position` (`accept`, `transact`, `reject`, `lapse`)
  with `cea_position_updated_at` and `_by_user_id`, the observations, the
  manual treated mark with `treated_updated_at`, `updated_at`.
- `control_sheet_observation_revisions`: every saved text with who and
  when (and the impersonation), readable with the view key, so an earlier
  text can be brought back. Text never goes into an event.
- `speaking_turns` gains `amendment_id` (set null).
- Writes to sheet rows: `shareLockAssembly`, then `INSERT ... ON CONFLICT
DO NOTHING` of an empty row (assembly taken from the item or amendment,
  never the route), then `SELECT ... FOR NO KEY UPDATE`, then compare the
  field's own token (a null token matches a row never written). Add the
  sheet rows to the documented lock order: after the assembly, and after the
  amendment rows.
- Agenda writes keep sheet data: an automatic sub-item that holds item
  votes, motions, sheet content or finished turns is never removed. When
  its document moves, those rows, motions and turns move with the document
  to its new sub-item in the same transaction. The agenda delete answers 409
  when anything in the subtree holds votes, motions, sheet content or
  finished turns. Finished turns are repointed like open ones.
- Zod limits in `shared/utils/schemas/controlSheet.ts`: observations up to
  5,000 characters, each motion text up to 500, under the Excel cell limit.

## 3. Votes

### Methods

- Pickers offer assent, show of hands, registered (`roll_call`, relabelled
  «Registrada» / «Registered» in both label sets) and secret; `portal` only
  in AGETs. Stored `portal` votes still read right.

### Assent and unanimity

- `votes.unanimous`, only on assent votes, set when recording or later.
  `PATCH .../votes/[vote]/unanimity` `{ unanimous, updatedAt }` locks the
  vote, refuses a vote that is voided or no longer pointed at (409), and
  records `vote_unanimity_changed`. The Mesa may set it on any assent vote;
  sheet editors on item and motion votes.
- An amendment approved by assent (the console's «a», bulk assent) now
  also stores a vote row (method assent, zero counts) pointed at by
  `outcomeVoteId`; `approvalMethod` stays `assent`. Admissions by assent
  keep storing no vote. These paths take `shareLockAssembly` before
  `lockDocument` whenever they write a vote. A single «a» shows «Aprobada
  por asentimiento» on the projection without counts; bulk assent sends
  `project: false`. The `amendment_approved` payload keeps `method: assent`
  and no zero counts.
- Wording everywhere: «por asentimiento» or «por unanimidad», never
  0 / 0 / 0: `approvedBy`, the PDF annex (`AnnexAmendment.vote` gains
  `method` and `unanimous`) and the final-vote line (closes I18N-2),
  `VoteResult`, `VoteSummary`, `liveVoteCounts`, the console's
  `AmendmentCard` and `NowAmendment`, and `History.vue` (`admissionDetail`
  decides on the decision's method). A counted vote with every valid ballot
  in favour reads «Aprobado (unanimidad)», as `approvedBy` already words it.
- `VoteDto` gains `unanimous`, `updatedAt`, `voidedAt` and `ballots`; the
  two `toVoteDto` and `voteInputSchema` copies become one.
- Readers that word assent rows ship before or with the writes; a rollback
  to a release older than that would show 0 / 0 / 0 on assent approvals
  (accepted risk, noted in DEPLOYMENT.md).

### Registered votes

- With method `roll_call`, `SessionVoteFields` shows the roll call: the
  voters at the latest headcount (asociados in the room, and delegated ones
  whose delegate is in the room, shown «CEUAM (vota CEUIB)»), in
  `compareRollCall` order, one segmented control per row (A favor, En
  contra, Abstención, No vota), the focus moving on after each choice,
  «Todos a favor» to start, live totals. Without a headcount, every active
  asociado, with the warning the form already gives.
- The body carries the `headcountId` and its `updatedAt`. Inside the
  transaction, after `shareLockAssembly`, the server re-reads the latest
  headcount (409 «El recuento ha cambiado» if it moved; the client keeps the
  ballots), rebuilds the voters, refuses unknown or repeated members (422),
  derives the counts from the ballots and `present` without the «No vota».
  Secret votes never store ballots. Every vote dialog offers it.

### Votes on an agenda item

- `POST /api/assemblies/[assembly]/agenda/[item]/votes`, for the Mesa and
  sheet editors: what is voted (required), the vote, optional note. Subject
  `agenda_item`. Refused (422 `item_has_voted_documents`) on an item with a
  document whose `voted` is true: its documents' final votes are the item's
  votes. `shareLockAssembly`, the item re-read under it (404 if gone), its
  documents locked FOR SHARE, insert. Repeated votes are allowed; the
  latest one not voided gives the result.
- The console records it from «Ahora en debate» in item mode and projects
  it (`project: true`, checked against the live item under
  `lockLiveState`); the sheet never projects.
- `DELETE .../votes/[vote]` `{ updatedAt }` voids an item vote
  (`vote_voided`, clears the projection if it shows it). Motion votes are
  voided with their motion. Votes that decided an amendment or a document
  keep going through reopen and annul.
- An item with several voted documents: the console's final-vote dialog
  offers «Aplicar a todos los documentos del punto» (on by default). It is
  all or nothing: if any document fails the `recordFinalVote` conditions,
  nothing is stored.

## 4. Procedural motions

- Recorded from the console (the «Más» of item, document and amendment
  modes, and each agenda row) and from the sheet's row panel, by the Mesa
  and sheet editors.
- Dialog: motive first (the three suggestions or «Otra»). A suggestion
  fills «Qué se vota» and «A favor significa» from what is in debate
  («Votar por voto secreto la enmienda UGR3» / «La votación será secreta»),
  both editable. Then who asks (asociados in the room first; one outside the
  latest headcount warns, never refuses) and the vote (show of hands,
  simple majority by default, editable). One transaction: motion row, vote
  row (subject `procedural_motion`), events `procedural_motion_recorded`
  and `vote_recorded`.
- When and where: the time is the vote's `recordedAt` (shown with
  `formatMoment`, so another day says its day). The place defaults from the
  console: with an item in debate, «Durante el punto X»; with nothing in
  debate, «Entre puntos, después del X» (the last item treated or
  debated). The dialog shows it as one line the Mesa can change (during an
  item, after an item, before the first item).
- In the sheet, a motion during an item sits in that item's «Votaciones»;
  a motion between items is a row of its own, placed after the item it
  followed, reading «Moción de procedimiento entre el 9 y el 10» with its
  time. The Excel's «Mociones» sheet lists every motion with its time and
  place.
- Scope: a motion with an amendment applies to that amendment's vote;
  without one, to the item vote or its documents' final vote. Approved
  «voto registrado» or «voto secreto»: the vote dialog preselects that
  method and says why; «a» on that amendment asks first, naming the motion;
  bulk assent leaves it out with a reason. Approved «Cambio del orden»: the
  same dialog postpones the chosen items, optionally until after a given
  item.
- `DELETE .../procedural-motions/[motion]` `{ updatedAt }` voids the motion
  and its vote together (`procedural_motion_voided`). Postponements it led
  to stay; the Mesa takes them back by hand.
- The projection and the live view head it «Moción de procedimiento» with
  its question; an item vote shows the item as the room may read it.

## 5. Order of the session

- The agenda tree is never reordered; numbers stay as convoked.
- The Mesa postpones an item («Aplazar»; optionally «hasta después del
  punto X») and takes it back («Retomar»). «Aplazado» is the word for this;
  «Pospuesto a otra asamblea» stays the document status.
- «Siguiente punto» offers the first item, counted from the top in agenda
  order, that is neither treated nor postponed, skipping containers (a
  container counts as treated once all its children are). Postponed items
  come after, labelled «(aplazado)»; one postponed until after X comes back
  once X is treated.
- Jumping ahead needs no marking. The Mesa opens any item from the agenda
  panel (as today); the items it skips stay pending, and since «Siguiente
  punto» counts from the top, it comes back to them once the jumped-to item
  is done. Its label names the target («Siguiente: 10. …»). After a jump
  over pending items, «Ahora en debate» shows one quiet line («Has saltado
  del 10 al 19: vuelven después de este punto») with «Aplazarlos al final»,
  which postpones all of them in one step (one event per item, one undo).
  The agenda panel also lets the Mesa select several rows and postpone or
  take them back at once.
- Leaving an item through «Siguiente punto» marks it treated, with undo in
  the toast, only when it needs no vote. An item that needs a vote and is
  left without one stays pending: skipping never treats it. Tests in
  `sessionModel.test.ts`: jump forward, containers, a forgotten report, a
  voted item skipped.
- The console reads this state from a progress read open to
  `session:moderate` (`GET .../session-progress`: per item treated,
  postponed, the latest item vote, approved method motions) and refetches it
  on sheet progress, motion and item-vote events. The progress bar counts
  the sheet's rows without containers.

## 6. Treated and result

- Item treated: a manual mark by the Mesa, a valid item vote, every voted
  document with a final vote, or leaving it through «Siguiente punto» when
  it needs no vote. Motion votes never count.
- Amendment treated: a manual mark, or an outcome the Mesa records while
  the assembly is in session (vote, assent, de forma, withdrawn, lapsed).
  Decisions before the session (withdrawn by its authors, replaced by a
  transactional) and the presenter's incorporation are marked by hand.
  Admission votes never count.
- Item result, in order: the decisive vote (the item's latest valid vote,
  or its documents' final votes: «Aprobado», «Aprobado (unanimidad)»,
  «Rechazado»); then the manual result (Decaído, No aplica, and Retirado for
  items without documents; the Mesa, since it counts as treated); then derived values
  (a withdrawn document gives Retirado, a postponed one «Pospuesto a otra
  asamblea», a document that is not voted «No aplica», or «Pendiente» when
  the item has «Se vota el punto»). While postponed in
  the session it reads «Aplazado».
- Withdrawing a document or postponing it to another assembly in the
  session is a Mesa act on its real status: «Retirar documento» and
  «Posponer a otra asamblea» in the console (document mode and the agenda
  row) and in the sheet's row panel, each confirmed in a dialog. `POST
.../documents/[document]/session-status` `{ status: withdrawn | postponed,
updatedAt }`, `session:moderate`, the same `assertStatusChange` checks
  (published, no final vote; refused once the assembly is closed), the
  document's usual status event, live refresh for every reader of the
  document. The item it hangs from counts as treated. The Secretaría keeps
  its own path through `document:manage`.
- Amendment result: its status as the live view words it, plus automatic
  notes: «Transaccionada en T1», «Decae por la T1», «Fuera de plazo», «De
  forma».
- The rules live in one pure module in `shared/utils`, used by the page,
  the console and the Excel.

## 7. Speakers

- The speaking turns are the one source. A turn records the item and now
  the amendment, re-stamped from the live state when the floor is given,
  inside the speakers transaction under the assembly lock (the queue carries
  over between items). A turn may only point at a published amendment of the
  assembly (422 otherwise), as the live state does.
- Proposal for the extra person:
  - the live queue (writing requests down, giving and ending the floor) is
    for the Mesa and for whoever holds `session:record_speakers`, granted
    per user in Usuarios;
  - that person gets a section «Turnos de palabra» (shown only with the key
    and without the console): what is in debate on top and the console's
    speakers panel below (the same component behind a smaller context),
    with the members in the room as quick buttons. Turns written there link
    themselves to what is on screen, so the sheet fills itself;
  - afterwards, every sheet editor can correct «Intervinientes» from the
    row: add someone who spoke without the queue, move a turn to another
    item or amendment, or remove a mistaken one.
- Corrections are their own endpoints: a hand-added turn is `done` with
  `startedAt` = `endedAt` = the time given (or now), outside the queue;
  removal sets `cancelled` with reason `correction`, never deletes. They
  work after the assembly closes (no `assertOpen`), still under the assembly
  lock and the turn's `updatedAt`. Queue operations stay refused after
  closing.
- Showing the list on the projection stays a Mesa switch.
- `loadSpeakers` gives the full list and the name suggestions to
  `canRecordSpeakers`; the activity «speakers» case honours it.

## 8. The page

- Section `controlSheet` at `hoja-de-control`, group `mesa`, icon
  `i-lucide-sheet`, visible with the view key, outside `STAFF_SECTIONS` (a
  CEA account keeps its single list). `AssemblySectionAccess` gains
  `controlSheet` and `recordSpeakers`, each with an explicit case.
- Two tabs: «General» / «Overview», and «Enmiendas» with a document
  selector (title and pending count) instead of one tab per document.
  A «Seguir el debate» switch (on during the session) opens the document in
  debate and marks the live row (aria-current and a ring) and scrolls to it.
- General rows: items with documents, listed items and items with votes or
  motions, under their parent items as headings. Numbers from
  `numberAgendaItems` over every item before filtering; unlisted ones read
  «Sin publicar»; withheld titles stay masked. «Añadir punto» (sheet
  editors) lists items without documents.
- General columns: Nº, Punto (its documents as links), Tratado, Resultado,
  Votaciones (method, every non-zero count, unanimity, motions marked as
  such, the roll call in a popover), Intervinientes, Observaciones.
- Enmiendas columns: Nº (code or «Sin número»), Presenta, Posición CEA,
  Posición del proponente (read only, when the reader may see it), Tratado,
  Resultado, Votaciones, Intervinientes, Observaciones, in the console's
  order (`sortSessionAmendments`).
- The table is compact and read only but for «Tratado», a box the Mesa
  ticks right there (`ControlSheetTreated`, with the panel's lock token:
  `itemTreatedControl`, `amendmentTreatedControl`); a row that counts as
  treated by itself stays ticked and locked, the reason in a tooltip, and
  everyone else reads the box disabled. A row opens a side panel
  (`USlideover`) with everything that row edits: CEA position, observations,
  the Mesa's marks, manual result, item votes and motions, speaker
  corrections, history (who and when, with earlier texts to bring back) and
  the 409 merge view. Observations: Enter makes a new line; saved with
  «Guardar» or Ctrl/Cmd+Enter, and on blur or after a short pause; a draft
  kept apart from fetched data, so a refetch never replaces it (it shows
  «X lo ha cambiado»); a leave guard while unsaved. Times through
  `formatMoment`.
- Below `lg`, each row is a card with the same fields.
- First plane: title, one line, «Descargar Excel» as the one button.
- Speakers' names: a focusable popover, never only on hover.
- Live: the hub's stream with a pure allowlist filter and its test;
  refetches debounced; speakers events refresh only «Intervinientes».
  `control_sheet` joins `IGNORED_LIVE_ENTITIES`; sheet events never carry
  the live `documentId`.
- Every new 409 or 422 has a `data.reason` with a `REASON_KEYS` entry in
  both locales.

## 9. Server

- `server/utils/domain/controlSheet.ts` `loadControlSheet(actor,
assembly)` composes the existing readers: agenda items and
  `agendaItemDtos`, visible documents with co-presenters, per amended
  document `buildDocumentAmendmentContext` and `buildAmendmentDtos(ctx,
rows, visibleIds)` with a new exported finder (no drafts), final votes in
  one query, item votes, motions, ballots, sheet rows of visible items and
  amendments only, turns through `toTurnDto`. A document whose amendments
  are all hidden from the reader gets no entry.
- CEA positions, observations, marks and their editors live only in
  `ControlSheetDto` and the Excel, never in a shared DTO (amendment, agenda,
  live state, turns).
- Every sheet endpoint resolves its subject with the reader's visibility
  (item: in the assembly, in `visibleAgendaItems`, title readable when
  shown; amendment: in the assembly, not a draft, `canSeeDocument` and
  `canSeeAmendment`) and answers 404 otherwise. The sheet GETs and the
  export call `requireViewer`, so `?view=room` answers 403.
- Endpoints:
  - `GET .../control-sheet` (view);
  - `GET .../control-sheet/history?subjectType=&subjectId=` (view), built
    like `amendmentHistory` (`redactEventActor`, the impersonator only to
    the account acted as and to Admins);
  - `PATCH .../control-sheet/items/[item]` (edit: observations, listed;
    Mesa: manual result, treated, postponed; a «Retirado» by hand only
    without documents), each field with its own
    permission and token, the whole body refused if one fails;
  - `PATCH .../control-sheet/amendments/[amendment]` (edit: CEA position,
    observations; Mesa: treated);
  - `GET .../session-progress` (moderate);
  - the vote and motion endpoints of sections 3 and 4.
- Events:
  - entity `control_sheet`, entityId the sheet row's own id (so the stream
    never tells which amendment the CEA is setting), payload `subjectType`
    plus `titleDocumentPayload(item)` for items:
    `control_sheet_observations_updated` (`cleared` only),
    `control_sheet_cea_position_changed` (changes),
    `control_sheet_treated_changed`, `control_sheet_postponed_changed`,
    `control_sheet_result_changed`, `control_sheet_listed_changed`;
  - entity `procedural_motion`: `procedural_motion_recorded` and
    `procedural_motion_voided`, payload `{ motive, voteId,
...titleDocumentPayload(item) }`, never the free texts;
  - votes: `vote_recorded`, `vote_unanimity_changed` and `vote_voided`
    always carry `subjectType` and `subjectId`, plus the item's
    `titleDocumentPayload` for item votes.
- Activity: a `control_sheet` case (view key and the row's own
  visibility), vote branches for `agenda_item` (the agenda item rule) and
  `procedural_motion` (the item rule, plus `canSeeAmendment` when it names
  one), a `procedural_motion` case, `collectActivityIds` branches, catalog
  entries, icons, i18n and a test per branch.

## 10. Excel

- `GET .../control-sheet/export?locale=es`, built on the fly from
  `loadControlSheet` for the requester; not stored, and the docs say so.
  `Cache-Control: private, no-store`, `nosniff`, RFC 6266 filename from
  `formatAssemblyLabel`.
- A small OOXML writer over `jszip` (already a dependency):
  `server/utils/export/xlsx.ts`. Text as inline strings, a `quotePrefix`
  style for text starting with = + - @, XML-illegal characters stripped,
  cells capped at 32,767 characters, sheet names sanitized (31 characters,
  unique). Agenda numbers and codes as text, counts as numbers, times in
  Madrid.
- Sheets: General; one per amended document (its title, cut to 31 characters); «Votaciones»
  (one row per vote: item, subject, method, majority, present, each count
  as a number, result, unanimity, time); «Votaciones registradas» (one row
  per asociado and vote); «Mociones». A title row with the assembly; Sí/No
  for treated. Labels under a new `export.xlsx` namespace (namespaced
  translator, no plurals).
- Its own rate-limit rule (`EXPORT_RATE_LIMIT`, `securityRules.test.ts`)
  and an audit row (`export.request` with variant `control_sheet`, or a new
  action with its catalog entries).

## 11. Phases (one commit each, verified)

1. Permissions, section, read-only sheet from today's data, live.
2. Sheet edits: observations with revisions, CEA position, listed items,
   manual result, the Mesa's marks, history, activity.
   Phases 1 and 2 can ship on their own, ready for the next assembly.
3. Votes: item votes (console and sheet), methods, assent rows and
   unanimity with every reader, voiding, one vote for several documents.
   Built on 2026-11-15: «Se vota el punto», item votes from the console
   (projected) and the sheet, «Registrada» for `roll_call`, unanimity on
   assent votes (item votes and documents' final votes), voiding, the
   projection and live view wording, and sorting and filtering in both
   tabs of the sheet. Left for later: assent vote rows for amendments
   approved by «a», «Aplicar a todos los documentos del punto».
4. Registered votes with ballots.
5. Procedural motions and the order of the session in the console.
6. Speakers: amendment link, corrections, the new key and «Turnos de
   palabra».
7. Excel download.
8. Docs (AGENTS.md, design.md, api.md, DEPLOYMENT.md: the `--seed` note
   and the rollback caveat), full verification, deploy with `--seed`.

## Known limits

- Withdrawing a document leaves its undecided amendments as they are, as
  the Secretaría's path does today (`assertStatusChange` does not touch
  them). To check when building the Mesa's action whether they should lapse.

- Elections are recorded as an item vote with the per-candidate result in
  the observations.
- A tied round under the `repeat` rule is not stored (the server answers
  409); the Mesa notes it in the observations.
