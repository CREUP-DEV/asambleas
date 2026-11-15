# Room seating ("Sala"): implementation plan

Draft, 2026-11-14. Not committed. Built on five read-only research passes
(the Intranet's events, attendees and images; its `asambleas/v1` API; this
platform; the sibling projects `asistencia`, `attendance`, `recuento`, `qr`
and `web`; UX and rendering options) and a completeness review. Requirement
R-ROL-03 (roles per assembly, the Mesa) and partly R-SES-02 in
`docs/proceso-asambleas.md`.

## What the user asked (2026-11-14)

- A new view for the CEA, the Mesa, Presidencia and Secretaría: the layout of
  the assembly room and who sits where.
- Usually a **double U**, as in the photo of the 79.ª AGO room: the Mesa at
  the far end by the windows, facing the room, and two nested U shapes open
  towards it, everyone on the outer side of the tables facing inwards. The
  CEA normally sits **opposite the Mesa** (the base of the U). Somebody may
  sit loose somewhere else. Other layouts must be possible.
- First the tables and seats are laid out, then each attendee is placed.
- Attendees come from the Intranet (the event registration); its API will
  have to change. Some accounts are one person (CEA offices), others group
  several attendees (asociados, sectoriales). Seats are given per account,
  taking into account how many people it brings.
- People not registered in the Intranet must be placeable too: the Mesa
  (Presidencia and Vocalía) usually does not register.
- Very intuitive: dragging to build everything; better alternatives welcome.
- Two views: **accounts** (each account's logo from the Intranet) and
  **attendees** (everyone, with the public image each person set in the
  Intranet, if any), drawn as bubbles.

Answers to the first questions (2026-11-14):

| Question                                  | Answer                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deadline                                  | **Everything now** (the 80.ª AGO starts on 18 November).                                                                                                                                                                                                                                                         |
| Personal data                             | **Name, surnames and photo** of each attendee.                                                                                                                                                                                                                                                                   |
| Permissions                               | **Own keys, everyone edits**: `seating:view` and `seating:edit`, both by default for the CEA, the Mesa (Moderador), Presidencia and Secretaría.                                                                                                                                                                  |
| Linking an assembly to its Intranet event | **Structured fields in the Intranet** (assembly type and number on the event), with a migration that fills them in for every past assembly. Careful: other things in the Intranet work with the current name by coincidence.                                                                                     |
| Double U                                  | As described; the CEA usually opposite the Mesa; somebody may sit loose.                                                                                                                                                                                                                                         |
| Colours                                   | The place cards: **burgundy for the CEA (and the Mesa), green for sectoriales, blue for asociados**. Then (2026-11-15): **the CAS green like the sectoriales, the CAI blue, the CdG beige** (if it looks good), **and the guests and other accounts beige like the CdG**; **the CAS sits with the sectoriales**. |
| Who enters from the Intranet              | **Confirmed and pending** registrations (pending ones marked). Anyone can be marked "no necesita asiento" (volunteers, organisation), and seats without a name can be added.                                                                                                                                     |
| Automatic placement                       | **By blocks, in roll-call order**: the Mesa at the presiding table, the CEA together, then the asociados in the order the Mesa calls them at headcounts (`compareRollCall`), then sectoriales and guests. A delegation is never split without saying so.                                                         |

## Facts that shape the design

- **The Intranet event carries no assembly identity today**: only
  `events.event_category = 'Asamblea'` and a free-text name ("80.ª Asamblea
  General Ordinaria", "74 Asamblea General Ordinaria", "XXXIV Asamblea
  General Extraordinaria"). The 80.ª AGO is event 98 (public, 18 to 22
  November, León). An AGE next to an AGO has been a separate event.
- **Every Intranet attendee hangs off an account** (`attendees.user_id`).
  An asociado or sectorial account registers N people (N rows sharing
  `user_id`); a CEA account registers itself. Status is `Pendiente`,
  `Confirmada` or `Rechazada` (nothing sets the last one today). There is no
  delegate/observer flag, no cargo and no check-in.
- **The Mesa does not exist in the Intranet.** Presidencia and Vocalía de la
  Mesa must be added on the platform. The Secretaría Ejecutiva is a member of
  the Mesa at an AGO and is a CEA attendee; at an AGE and AGET the Mesa is
  CREUP's Presidencia and Secretaría, both CEA attendees. A person is placed
  once: seating SE at the presiding table is just a seat, never a copy.
- **Real size (80.ª AGO badge list, 2026-11-04):** 105 rows, 12 of them
  volunteers. Delegations are 1 to 4 people (12 of 1, 7 of 2, 13 of 3, 1 of
  4); about 24 single-person rows are offices, committees and the Mesa. Plan
  for up to 250 seats.
- **Photos.** Each attendee may upload a face photo for the Intranet's public
  attendee directory (`attendees.public_profile_photo_path`, jpeg, png, webp
  or avif, up to 3000 px and 5 MB). A CEA account's photo is copied onto its
  attendee at registration. The existing photo route answers a server only
  for public events inside the directory window (start minus 1 day to end
  plus 1 week). `attendees.image_consent` is not a usable flag (the
  self-registration form never sends it). The consent is the directory's own
  notice ("se mostrarán en la página pública de asistentes del evento"); this
  view is narrower than that page.
- **Logos.** A multiuser account's logo is `users.profile_photo_path` (any
  format, SVG included, no size limit). For an individual account (CEA, CdG,
  CAI, Otros) the same column is the holder's face. No office, area or
  committee has a logo of its own. No thumbnails exist anywhere.
- **The `asambleas/v1` group** is token-only, closed CORS, `no-store`, 30
  requests a minute per route and token (300 for `user/role`), closed key
  lists, never paginated, and so far carries nothing personal
  (`docs/intranet.md` §4.3 and §4.4). This plan changes that last point on
  the user's decision.
- **This platform** has no person, attendee, seat or Intranet event concept;
  members carry no image; the CSP `img-src` is `'self'`, `data:`, `blob:`
  and Google. `@vueuse/core` 14.4 is installed; no drag, zoom or canvas
  library is; `sortablejs` is unused and slated for removal
  (`docs/informe-mejoras-2026-11.md`). No SVG drawing exists in `app/`.
- **The control sheet** (committed in `f8abfc4`, not deployed yet) takes
  migration 0033 and touches `-sections.ts`, `permissions.ts`, `actor.ts` and
  `visibility.ts`. It is deployed before this view (user, 2026-11-15); this
  plan's migration is 0034.

## Decisions taken from the user's words

- One plan per assembly ("Sala"), editable at any time, before and during
  the session. Not per day: who comes and goes is the headcount's business.
- The section is hidden for an AGET (held online).
- The grouping unit is the **Intranet account** that registered the
  attendees, linked to a platform member when there is one
  (`members.intranetId`). CdG, CAI, Invitado, Otros, Desasociado and the host
  account have no member; they are groups all the same.
- **The colours of the room's place cards**, only in this view:
  - `primary` (burgundy): the CEA and the Mesa;
  - `sectorial` (green): the sectoriales and the CAS;
  - `info` (blue): the asociados and the CAI;
  - beige: the CdG, and (user, 2026-11-15) the guests and every other
    account, groups made by hand included (a pale beige tint with a darker
    tan ring, so the ring still stands out at 3:1 against the floor; the
    user asked for it "if it looks good", so check it in light and dark);
  - `neutral` (grey): only a seat whose group the plan lost, never in
    practice.

  The colour comes from the group's `kind` and its Intranet type
  (`seatingGroupColour`), never from `kind` alone: the CAS keeps the kind
  `cea` from the Intranet's type but is green, and the CAI is `other` but
  blue.

  Text stays neutral; colour goes on rings, borders and tints (AGENTS.md).
  `MemberBadge` keeps its colours elsewhere.

- The accounts view shows what the Intranet gives as the account's image:
  a council's logo, an office holder's face. Without one, the acronym in a
  bubble of the account's colour.
- An attendee without a photo shows initials with a ring of the account's
  colour.
- Pending registrations are drawn with a dashed ring and say "Pendiente" in
  the details. A person the Intranet stops listing is kept, marked "Ya no
  inscrito", and never leaves a seat without a person saying so.
- The Mesa group exists from the start with its usual seats for the type
  (AGO: Presidencia de la Mesa and Vocalía de la Mesa as people to add by
  name; the Secretaría is the SE attendee). A Mesa person may be linked to
  their platform account.
- The CAS (a CEA account in the Intranet, the member `CAS` here) sits with
  the sectoriales (user, 2026-11-15): "Proponer reparto" places it right
  after them, never in the `cea` zone.

## 1. Permissions

- New keys `seating:view` and `seating:edit` (`PERMISSION_KEYS.SEATING_VIEW`,
  `SEATING_EDIT`), with description keys and icons
  (`i-lucide-armchair`, `i-lucide-move`). Defaults: CEA and Moderador get
  both; Secretaría and Presidencia get them through every key; `pnpm db:seed`
  (`deploy.sh --seed`) adds missing grants. CAS, CAI, CdG, Invitado and Otro
  get neither.
- Both go into `EXECUTIVE_VISIBLE_PERMISSIONS`: the view names offices and
  people who act for them.
- `canViewSeating(actor)` (view or edit) and `canEditSeating(actor)` in
  `server/utils/domain/actor.ts`; `requireSeatingReader` / `requireSeatingEditor`
  in the domain module. Every read calls `requireViewer` first, so
  `?view=room` is refused (403): the room never reads this.
- Attendee names and photos are personal data: they leave the server only to
  seating readers, never in an event payload, an audit row, a log, a live
  message, an export of another section or a notification.

## 2. Intranet changes (`CREUP/Intranet`, deployed first)

### 2.1 Assembly identity on events

- Columns on `events`, named and typed as in `assembly_minutes` so a later
  join is trivial: `assembly_type` (`string(4)` null) and `assembly_number`
  (`integer` null), after `event_category`; in `$fillable`, the number cast
  to integer. Unique index `events_assembly_type_number_unique` on the pair
  (MariaDB allows any number of null pairs).
- Types: `Event::ASSEMBLY_TYPES = ['AGO', 'AGE', 'AGET']`, the three separate
  numberings and exactly this platform's types. **AGOT is left out**: the
  Library shows it is an AGO held online on the AGO numbering (the 68th is
  "68 AGO" in minutes, agreements and regulations and "68 AGOT" in motions,
  positionings and resolutions), and a unique index could not stop "68 AGO"
  and "68 AGOT" being two events. A comment says so.
- Both set or both null. Only an `Asamblea` event carries them; saving writes
  null for any other category, whatever was posted (hidden inputs still
  post with the script off).
- **Never inferred from the name**, at creation or later: `duplicateForm`
  copies last year's economic event name ("79.ª Asamblea General
  Ordinaria"), so a value derived from it would be wrong until someone edits
  it.
- Form (create and update): "Tipo de asamblea" (select) and "Número de
  asamblea" (number, min 1) in a `data-assembly-fields` row after the
  category, shown and enabled only when the category is Asamblea (the
  `data-public-only-section` pattern). They stay editable when the event is
  linked to an economic event (they belong to Organización, unlike the
  name). Rules in `getEventFormValidationRules()` mirror
  `LibraryController.php:1402-1406`: required when the category that will be
  stored is Asamblea, type in the list, number integer ≥ 1, unique per type
  ignoring the event itself. Spanish messages ("Ya existe un evento para esa
  asamblea."). The category `<select>` gets its missing
  `id="event-category"`, which also fixes its label.
- **The name and the slug stay as they are.** Nothing that reads them today
  changes (section 2.4).
- `/api/eventos` gains `assembly_type` and `assembly_number` (the web's
  schema strips unknown keys).
- Backfill in the same migration (section 2.5): guarded by
  `Schema::hasColumn` as `2026_11_12_100000_add_university_acronym…`; reads
  the name people see (`economic_events.name` for a linked event, else
  `events.name`, compared in PHP because the collations differ); skips rows
  already filled; an override map keyed by id **and** exact name (the
  `EXPECTED_NAMES` precedent of `2026_07_06_110000`); then three anchored
  regexes (ordinal "80.ª", plain "74", canonical Roman numerals) over
  "Asamblea General Ordinaria|Extraordinaria( Telemática)?": Ordinaria is
  AGO, Extraordinaria AGE, "Extraordinaria Telemática" AGET, "Ordinaria
  Telemática" nothing. A pair claimed twice or already taken leaves every
  claimant null with a warning; it never dies on the constraint; anything
  unread is logged for a person to fill in the form. Never writes a name,
  slug or category, nor touches another category. `down()` drops the index
  and the columns.
- Tests (`DatabaseTransactions`, since `events` is a legacy table):
  `EventAssemblyFieldsMigrationTest` (each pattern by data provider, numbers
  from 900; non-canonical numerals, "Ordinaria Telemática" and combined names
  stay null; a linked event is read through its economic event; filled rows
  and names untouched; a double claim leaves both null; id 2 with another
  name does not take AGO 73; another category stays null) and
  `EventAssemblyFieldsFormTest` (required together for an Asamblea, invalid
  values, duplicates refused, own pair accepted on edit, other categories
  store null, a linked event's form still submits the pair).
- Separate small fix in the same pull: on update, a POST without
  `event-category` keeps the stored category instead of clearing it (today
  it would also clear the pair).

### 2.2 Attendees of an assembly

`GET /api/asambleas/v1/asambleas/{type}/{number}/asistentes`
(`api.asambleas.attendees`), same middleware and conventions as the group
(token, `no-store`, JSON only, closed key lists, whole list, counts-only
logs, out of CORS).

- `{type}` in `AGO|AGE|AGET`, `{number}` 1 to 999. 404
  `{"error":"not_found"}` when no event has those fields. Drafts and private
  events included (the plan is made before publication).
- Answer:

```json
{
  "event": {
    "id": 98,
    "name": "80.ª Asamblea General Ordinaria",
    "start_date": "2026-11-18",
    "end_date": "2026-11-22"
  },
  "accounts": [
    {
      "id": 412,
      "type": "Asociado",
      "category": "Multiusuario",
      "initials": "CdEUB",
      "designation": "…",
      "university_acronym": "UB",
      "order": null,
      "logo_version": "9f2c…"
    }
  ],
  "attendees": [
    {
      "id": 5012,
      "account_id": 412,
      "name": "…",
      "surname": "…",
      "status": "Confirmada",
      "photo_version": "1be0…"
    }
  ],
  "generated_at": "2026-11-14T18:00:00+01:00"
}
```

- `accounts`: every account with at least one listed attendee. `type` is
  `users.type`, except the Coordinación del CAS, sent as `CAS` with initials
  `CAS` (the same remap as `user/role` and `usuarios/cas`). `order` is the
  canonical CEA order (`CeaSortingService`) for CEA accounts, null
  otherwise. `logo_version` is the md5 of the stored path (the Intranet's own
  `?v=`), null without a logo.
- `attendees`: `Pendiente` and `Confirmada` only. `name` and `surname` only:
  never DNI, email, phone, birthdate, diet, needs, travel or accreditation.
  `photo_version` is the md5 of `public_profile_photo_path`, null without a
  photo or after a removal.
- Resource classes `AssemblyEventAttendeesResource` and friends with fixed
  keys; the docblock and `docs/intranet.md` say plainly that this route
  carries personal data, on the platform's request, for the seating view.

### 2.3 Images

- `GET /api/asambleas/v1/asistentes/{attendee}/foto`
  (`api.asambleas.attendee_photo`): the attendee's photo bytes when the
  attendee is `Pendiente` or `Confirmada` in an event with assembly fields
  and has a photo; 404 otherwise. Raster only (jpeg, png, webp, avif), with
  `X-Content-Type-Options: nosniff`.
- `GET /api/asambleas/v1/cuentas/{user}/logo` (`api.asambleas.account_logo`):
  the account's `profile_photo_path` (SVG allowed) when the account has an
  attendee in an event with assembly fields; 404 otherwise.
- Both get their own limiter branch (600 a minute per token) and a
  per-address budget of their own (600 a minute), apart from the one the role
  lookup, the rosters and the list share, so a burst of images never starves
  sign-ins: the platform fetches a photo per attendee and a logo per account
  when a plan is first synced.
- Both serve a file only when its bytes are an allowed type, never by its
  extension. `photo_version` and `logo_version` in the list are non-null only
  when the route would serve the image.
- Tests: the data provider of `AssembliesApiTest` gains the three routes;
  exact-keys contract test; personal fields never present; Rechazada and
  non-assembly attendees 404; the CAS remap; logs never carry names.

### 2.4 Code that reads assembly events by name

Reviewed across `app/`, views, routes, migrations, tests, the public web and
17 production dumps (July to October 2026). **Nothing at run time reads an
assembly's number or type out of an event's name or slug**, and nothing
joins `events` to the Library's tables. What makes an event an assembly is
only `event_category === 'Asamblea'`. What does use the name or slug, and
stays as it is:

| What                                                                                                                                          | Where                                                                                                       | With the new fields                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| The name a linked event shows is its economic event's (`Event::name()`); `events.name` is frozen or null meanwhile                            | `Event.php:218-225`, `EconomicEventController.php:296,725`                                                  | The backfill reads the resolved name                                                                                    |
| Billing view strips the **current** name off bill lines stored with the name at billing time                                                  | `event/partials/billing.blade.php:31-37`                                                                    | Unchanged; the one "works by coincidence" spot (a rename shows the full reference)                                      |
| Bill concepts, budget labels, certificate titles, mail subjects copy the name                                                                 | `EventsController.php` 4614-4942, 5980-6284, 3729…; `BudgetsController.php`; `ServiceCommission*`           | Unchanged (stored text, display)                                                                                        |
| The slug is made from the name once and is a public key: attendee directory, emailed links, the web's `/conocenos/eventos/{slug}` and sitemap | `EventsController.php:892,923,2714`; `routes/web.php:85-101`; `web/server/utils/external/events.ts:220-227` | Never regenerated from the fields; the Intranet slug (`80-asamblea-general-ordinaria`) is not the platform's (`80-ago`) |
| Applied migrations look events up by name (seed idempotency and `down()`, CEA events, the 79.ª link)                                          | `2026_05_05_000001…:29,93-97`; `2026_07_06_110000…:72-76`                                                   | No rename, so they keep working on a restored database                                                                  |
| Rules keyed on the category (first-registration discount, accreditation, the web's `types=Asamblea` filter)                                   | `EventsController.php:692,4719`; `2026_05_14_100003…:28-30`                                                 | Unchanged                                                                                                               |
| The Library's own "{n} {TYPE}" strings (motions, resolutions, agreements, minutes, Doc. Asamblea)                                             | `LibraryController.php`, `AgreementsController.php:586-593`                                                 | A separate vocabulary, not linked to events; a later join can use the fields                                            |

Seen on the way, out of scope: the Doc. Asamblea Drive lookup uses
`str_contains($folder, "{n} {TYPE}")`, so "8 AGO" also matches "68 AGO" and
"78 AGO" (`LibraryController.php:174-177`); the Library mixes "68 AGO" and
"68 AGOT" for the same assembly.

### 2.5 Backfill mapping

All 63 `Asamblea` events of the public list (2026-11-14) and of the
2026-10-27 dump map to a distinct pair; the dump holds no private or draft
assembly event, and **no event exists for any AGET**.

- 55 canonical Roman numerals: 28 AGO (the archive seed plus id 19, "I
  Asamblea General Ordinaria", added by hand) and 27 AGE.
- 6 ordinals (ids 8, 10, 12, 15, 18 and 98: AGO 75 to 80) and 1 plain number
  (id 6: AGO 74).
- 1 override: id 2, "XX Aniversario CREUP y 73 Asamblea General Ordinaria",
  AGO 73. It is checked against the exact name, because the id alone means
  this event only in production: a database built from the schema dump has no
  events, and any other database may hold another event under id 2. An id 2
  with another name falls through to the patterns.
- Id 27, "LXVIII Asamblea General Ordinaria" (2020, online), is AGO 68.
- 14 AGEs held next to or inside an AGO are already events of their own
  (ids 20 and 10 for the XXXIV AGE and the 76.ª AGO, 2024-11-21).
- Linked events 18 (79.ª) and 98 (80.ª) are read through their economic
  events (same names today).
- Expected in production: 63 rows filled, 0 warnings. The 80.ª AGO is event
  98 → (AGO, 80) → this platform's `80-ago`.
- Left as they are (dates and numbers in the data, not in this change): II
  AGE (id 70, 2011) dated after the III and IV AGE of 2010 (its name and PDF
  say 2), and XXX AGE (id 30) ending a day after its AGO.

The full table (id, name, slug, dates, place, pair, pattern) is the review's
working file; the migration's test covers each pattern.

## 3. Data model (migration 0034)

### `seating_plans`

One per assembly.

- `id`, `assemblyId` (unique, FK cascade).
- `layout` jsonb, `SeatingLayout` (section 4), validated with Zod on every
  write; `layoutUpdatedAt` (the optimistic-lock token) and
  `layoutUpdatedByUserId` (set null).
- `intranetEventId` integer null and `intranetEventName` text null: what the
  last sync found, for the header.
- `sourceAssemblyId` text null (FK set null): read the attendees of another
  assembly (an AGE held next to an AGO without its own Intranet event).
- `syncedAt` (the last call, whatever it answered: the throttle reads it),
  `syncStatus` (`ok | not_found | unavailable | failed | unconfigured`;
  `unavailable` is any other 404, the Intranet without the route yet).
- `createdAt`, `updatedAt`.

### `seating_groups`

What the tray lists: an Intranet account, the Mesa, or a manual group.

- `id`, `planId` (FK cascade).
- `source` `intranet | manual`; `intranetAccountId` integer null, unique per
  plan when set; `memberId` null (FK set null) by `members.intranetId`.
- `kind` `cea | asociado | sectorial | mesa | other` (order and zone);
  `intranetType`, `category` (`individual | multiuser`) as received. The
  colour comes from `kind` and `intranetType` together (`seatingGroupColour`,
  in "Decisions taken from the user's words").
- `acronym`, `name` (snapshots, Zod limits 20 and 200).
- `logoVersion`, `logoFile` null (the cached file, section 6).
- `order` integer null (the Intranet's CEA order).
- `goneAt` null: the Intranet no longer lists it.
- `createdAt`, `updatedAt`.

### `seating_people`

One per person who may take a seat.

- `id`, `planId`, `groupId` (FK cascade).
- `source` `intranet | manual | placeholder`; `intranetAttendeeId` integer
  null, unique per plan when set.
- `firstName`, `surname` (null for a placeholder, "Plaza sin nombre"),
  `label` null (a cargo such as "Presidencia de la Mesa").
- `status` `confirmed | pending | manual`; `goneAt` null.
- `needsSeat` boolean, default true ("No necesita asiento").
- `userId` null (FK set null): a platform account, for the Mesa.
- `photoVersion`, `photoFile` null.
- `position` integer: order inside the group (the Intranet's, then by hand).
- `updatedAt` (lock token for PATCH).

### `seating_assignments`

- PK (`planId`, `seatId`); `personId` (FK cascade), unique per plan.
- `updatedAt`, `updatedByUserId`.
- A batch never updates rows in place: it deletes every seat it touches and
  then inserts the new occupants, in one transaction, so a swap of A and B
  never meets the unique (`planId`, `personId`) index halfway (no deferrable
  constraint, which drizzle cannot emit).
- A seat id is a stable id stored in the layout (section 4). Every write
  checks that the seat exists and is not disabled in the current layout.

Not in `assemblies.settings` (it drops unknown keys) and nothing on
`members`. The layout's JSON carries `schemaVersion` from day one (the
two-release rule for JSON shapes).

## 4. The layout

Pure module `shared/utils/seating/` (unit-tested; the server validates with
it).

- Units are centimetres on a 10 cm grid. Defaults: table 180 × 60, seat pitch
  60, seat circle 45.
- `SeatingLayout` v1:
  - `tables[]`: `id`, `shape` (`rect | round`), `x`, `y`, `w`, `h`,
    `rotation` (90° steps; 15° by hand), `zone`
    (`presiding | cea | delegates | free`), `run` (id of the row it belongs
    to) and `seats[]`: `id` (stable, cuid2), `side`
    (`front | back | left | right | around`), `index`, `disabled?`,
    `label?`.
  - `chairs[]`: a loose seat anywhere ("alguien suelto"): `id` (it is the
    seat id), `x`, `y`, `rotation`, `label?`.
  - `fixtures[]`: landmarks that are not seats (screen, door, windows,
    banner, lectern, free label).
  - `template`: the kind and parameters it was generated from, so the
    parameters can be changed later.
- **Seat ids are stored, never derived.** Regenerating keeps the id of every
  seat whose (table, side, index) survives and mints ids only for new seats.
  A change that would remove occupied seats is refused (409
  `seating_seats_occupied`, with the people affected) unless the request
  confirms it, and then those people go back to the tray in the same
  transaction.
- **Runs.** Seats are walked in order along each run: one per U (arm, base,
  arm), one for the Mesa, one per row of tables; chained tables keep one run.
  Runs drive automatic placement, filling N seats in a row and keyboard
  navigation.
- **Templates:**
  - **Doble U** (default): Mesa table at the top, facing the room; outer U
    and inner U open towards it; seats on the outer side facing inwards; the
    base of the outer U is the `cea` zone. Parameters: tables per arm and on
    the base of each U, seats per table (2 or 3), Mesa seats (3 to 5), the
    gap between the Us.
  - **U**, **Filas** (classroom, rows facing the Mesa) and **Islas** (round
    tables). Plus **Vacía**.
- Limits (Zod): 200 tables, 600 seats, 60 fixtures, coordinates within
  ±100 m, labels up to 60 characters.

## 5. Synchronising with the Intranet

- `POST /api/assemblies/[assembly]/seating/sync` (`seating:edit`): calls
  `GET asambleas/{type}/{number}/asistentes` for the assembly's type and
  number, or for `sourceAssemblyId`'s. The page calls it when it opens and
  the last sync is older than 10 minutes (editors only), and from a
  "Sincronizar" button. The server enforces the throttle too: within a
  minute of the last sync it answers the stored state without calling the
  Intranet, so several editors' tabs never spend its 30 requests a minute.
- In one transaction (assembly locked for share, the plan row for update):
  upsert groups by `intranetAccountId` and people by `intranetAttendeeId`;
  link `memberId`; set `goneAt` on what is missing (clear it when it comes
  back); never touch manual groups, manual people or placeholders; keep
  every assignment. Records `seating_synced` with counts only.
- Platform AGO, AGE and AGET map to the Intranet's same codes.
- Client in `server/utils/members/intranet.ts` style: Zod schema with limits
  (5000 rows), 10 s timeout, `IntranetUnavailableError`. A 404 `not_found`
  says "No hay evento de la Intranet con esta asamblea" and offers to read
  another assembly's attendees. Until the Intranet has the route, the plan
  works with manual groups only (the `fetchOptionalRoster` pattern).
- A people count per group shows "3 inscritos (1 pendiente)". "Añadir plaza
  sin nombre" adds a placeholder to a group; "No necesita asiento" takes a
  person out of every count.

## 6. Images

- pg-boss queue `seating-images`, created on boot, filled by each sync with
  the logos and photos whose version changed. It fetches each image from the
  Intranet with the token (never from the browser), at most 4 at a time,
  caps the bytes (5 MB), and with `sharp` (`limitInputPixels`, SVG
  rasterised) writes a 192 × 192 WebP: photos cropped to a square, logos
  fitted on white. Files go to `UPLOAD_STORAGE_DIR/seating/<planId>/`,
  named by kind, id and version, under the git-ignored `private/` locally.
- **A photo taken down leaves the cache at the next sync.** When an
  attendee's `photo_version` turns null (removed by Intranet staff or by the
  person), changes, or the person gets `goneAt`, the sync deletes the cached
  file in the same pass; the same for an account's logo. The platform never
  serves an image the Intranet no longer gives.
- `GET /api/assemblies/[assembly]/seating/images/[file]`: `requireSeatingReader`,
  file name pattern, `Cache-Control: private, max-age=31536000, immutable`
  (the name carries the version), `nosniff`, `Content-Disposition: inline`.
  Its own `rateLimiter` rule in `nuxt.config.ts` (the prefix inherits
  `false`), mirrored in `server/securityRules.test.ts`.
- Same origin, so the CSP does not change, the token never reaches a browser
  and print includes the images.
- **Retention:** a daily job removes the cached photos of attendees (not the
  logos) 30 days after the assembly closes. Names stay with the plan as the
  record of the room.
- The development server reads the production Intranet: real names and
  photos land in the local database and in `private/`, never in git.

## 7. The page

`app/pages/asambleas/[assembly]/sala.vue`, section `seating` (segment `sala`,
label "Sala", icon `i-lucide-armchair`, group `mesa` next to the control
sheet), hidden for an AGET. Sized to the viewport like the amendments
workspace (no page scroll besides the plan).

### Header

- Title "Sala", the counts ("93 personas · 88 sentadas · 5 sin asiento") and
  the sync line ("Intranet: 80.ª Asamblea General Ordinaria, hace 3 min",
  "Sincronizar").
- View: **Cuentas | Asistentes** (`UTabs`).
- Mode: **Ver | Colocar | Editar sala** (editors only see the last two).
- "Más": Imprimir, Leer inscritos de otra asamblea, Copiar la sala de otra
  asamblea, Lista.
- "¿Dónde está…?" search: dims everything else and centres the match. The
  Mesa's main use during the session.

### First time

An empty plan opens on a template gallery ("Elige la disposición"): Doble U,
U, Filas, Islas, Vacía, each with a thumbnail and its few numbers next to a
live preview. "Copiar la sala de otra asamblea" sits there too.

### Editar sala

- The template's numbers stay editable on the side (a new number
  regenerates, keeping seat ids).
- Select a table, a chair or a fixture: buttons "Girar 90°", "Duplicar",
  "Eliminar", "Asientos por lado", "Zona" (Mesa, CEA, delegaciones, libre);
  drag to move with a 10 cm snap; arrow keys nudge. A seat can be disabled
  (a pillar, an aisle).
- "Añadir mesa", "Añadir silla suelta", "Añadir referencia" (pantalla,
  puerta, ventanas, pancarta, atril, texto).
- Undo and redo (Ctrl+Z, Ctrl+Shift+Z), "Guardar sala". Several editors:
  optimistic lock with a recovery panel, and a notice of who else is editing
  the room (the presence heartbeat of `server/utils/live/presence.ts`).

### Colocar

- **Tray** (left at `lg`, a bottom drawer on phones): search, filter by kind,
  sections "Sin sentar", "En parte" and "Sentados" (folded). Each row: image,
  acronym and name below (as `memberMenuItem`), a badge "2/3". In Asistentes
  a row opens to its people. "Añadir persona" (to the Mesa, to a group or to
  a new manual group such as "Prensa").
- **Placing an account** with N people: drag the row onto a seat. While
  dragging, the N seats it would take light up: from the target forwards
  along the run, else a window of N around it; green when they fit, red when
  not; on a red drop, "Colocar los que caben" (the rest stay in the tray) or
  cancel.
- **Without dragging** (WCAG 2.5.7, and the phone's way): tap a row to pick
  it ("Colocando UGR (3) · Esc para cancelar"), then tap a seat; the same
  preview shows on hover or focus.
- **Moving:** in Cuentas a drag moves the account's block; in Asistentes it
  moves one person. Dropping on an occupied seat swaps blocks of the same
  size and asks otherwise ("Intercambiar", "Desplazar", "Cancelar").
  Dragging back to the tray, Supr or "Quitar" unseats.
- Seat menu (right click, long press, Shift+F10): "Mover a…", "Intercambiar
  con…", "Quitar", "No necesita asiento", "Detalles".
- **"Proponer reparto"**: a ghost preview to apply or discard; it fills only
  empty seats unless "Rehacer todo" is ticked. The Mesa group and the Mesa
  people (SE at an AGO; PRES and SE at an AGE) at the presiding table; the
  CEA (Intranet order) in the `cea` zone; the asociados in roll-call order
  (`compareRollCall`), then sectoriales, then the CAS, then the rest,
  along the delegate runs. Delegations stay together; when space is broken,
  the largest go first and every split is listed.
- **Warnings** panel: accounts not seated or seated in part, split
  delegations, people no longer registered, seats lost by an edit, more
  seats than people.

### The bubbles

- **Cuentas:** each contiguous block of an account is a capsule along the
  table edge: a pale tint of its colour, a 2 px border, the image in a circle
  at its centre, the acronym and "×3". A single seat is a circle. Hovering
  or focusing one block lights up the account's other blocks.
- **Asistentes:** one circle per seat: the photo, or initials; a ring of the
  account's colour (dashed while pending); the acronym on the table side;
  "Plaza sin nombre" as a silhouette.
- Detail follows the zoom (the size of a seat on screen): dots, then acronyms
  or initials, then images, then names under the seats.
- Legend: one entry per kind present in the room, with its own count
  ("Asociados 48/52", "CAI 1/1"); kinds that share a colour share its
  swatch, never a count.
- Tapping a seat opens its details (a popover anchored to the seat; a drawer
  on phones).

### Lista

The accessible equivalent and the phone fallback: seats grouped by run and
table, each with its occupant and an "Asignar…" picker; or people grouped by
account with their seat.

### Imprimir

`sala/imprimir.vue` (`print: true, layout: false`, as
`convocatoria/imprimir.vue`): A3 landscape, the plan fitted to the page in
the current view, legend and an index account → seats. Place cards (the
folded name cards of the photo) later.

### Rendering and interaction

- One SVG drawn by Vue templates (about 1,500 nodes for 250 seats): focus and
  ARIA per seat, theme tokens in light and dark, crisp print. Not Canvas (no
  focus, raster print), not a DOM overlay (two coordinate systems).
- Pointer Events written here (no library): `setPointerCapture`,
  `requestAnimationFrame`, screen to room through
  `getScreenCTM().inverse()`, hit-testing against the seat centres, a 4 px
  threshold so a tap stays a tap. VueUse's `useDraggable` does not handle a
  zoomed SVG. Nothing based on `sortablejs`.
- Pan and zoom in a composable (`useSvgViewport`, pure maths in
  `-viewport.ts`): wheel and trackpad pinch at the cursor, two-finger pinch,
  drag the empty floor, buttons "+", "−", "Ajustar" and "100 %".
- Keyboard: the plan is one tab stop with a roving focus over the seats;
  arrows walk the run and jump to the nearest seat of the next run; Enter
  picks and places; Esc cancels; Supr unseats; an `aria-live` region says
  "UGR colocada en los asientos 12 a 14". Each seat has a label such as
  "Asiento 12, U exterior: UGR, Ana Pérez" or "libre". Single-letter keys
  only through `useSingleKeyShortcuts()`.
- The layout lives in `shallowRef` and only the drag ghost moves per frame.

## 8. Server

- `GET /api/assemblies/[assembly]/seating`: `requireViewer`,
  `requireSeatingReader`; `SeatingPlanDto` with the plan, layout, groups,
  people (names, labels, status, image URLs), assignments, sync status and
  `can.edit`. Creates nothing: an assembly without a plan answers an empty
  one.
- **Lock order, everywhere:** the assembly (`shareLockAssembly`), then the
  plan row, then the assignment rows. A layout PUT and a sync take the plan
  row `FOR UPDATE`; an assignment batch takes it `FOR SHARE`, so a layout
  save can never remove a seat between a batch's check and its insert.
- `PUT .../seating/layout` (`seating:edit`): body with `layout`, `updatedAt`
  and the optional `releaseSeats`; optimistic lock (409 with the current
  layout); `seating_seats_occupied` as in section 4; records
  `seating_layout_updated` (table, seat and fixture counts, template kind).
- `POST .../seating/assignments` (`seating:edit`): body `ops`, up to 600,
  each with `seatId`, `expected` (the person the client saw there, or null)
  and `next`; atomic compare-and-set per seat (`SELECT … FOR NO KEY UPDATE`
  on the touched seats, then delete and insert as in section 3); 409
  `seating_stale` with the current occupants of the conflicting seats;
  records one `seating_assignments_changed` per request (placed, moved and
  removed counts, member ids).
- `POST .../seating/sync` (section 5).
- `POST`, `PATCH` and `DELETE .../seating/groups[/[group]]` and
  `.../seating/people[/[person]]` for manual groups, people and placeholders
  (`needsSeat`, `label`, `position`, names of manual people, `userId`);
  Intranet people only take `needsSeat`, `label` and `position`. Optimistic
  lock on PATCH. Events `seating_person_*` and `seating_group_*` carry ids
  and kinds, never names.
- `PUT .../seating/source` (`seating:edit`): `sourceAssemblyId`.
- `POST .../seating/copy` (`seating:edit`): copy another assembly's layout
  (and, optionally, its manual groups and people).
- `GET .../seating/images/[file]` (section 6).
- Live: `EntityType` gains `seating`, added to `IGNORED_LIVE_ENTITIES`
  (`-liveFilters.ts`) so a move never refetches the hub; the page refetches,
  debounced, on `seating` events. Activity: event types in
  `shared/constants/activity.ts`, `EVENT_PAYLOAD_KEYS`, an `eventTarget` case
  that shows them only to seating readers, icons and `activity.actions.*` in
  both locales. Reason keys `seating_stale`, `seating_seats_occupied`,
  `seating_not_found` in `useApi`.
- Handlers small; logic in `server/utils/domain/seating.ts` and the pure
  `shared/utils/seating/*`; Zod v4 schemas in
  `shared/utils/schemas/seating.ts`; DTOs in `shared/types/api.ts`; docs in
  `docs/api.md`, `docs/design.md` and `docs/intranet.md`.

## 9. Phases (one commit each, verified)

The 80.ª AGO starts on 18 November, two repositories deploy, and
`deploy.sh` asks before deploying while an assembly is in session. The work
is cut in two so that something useful ships before the 18th.

**Prerequisite.** The control sheet owns migration 0033 and 0034 chains onto
it: seating cannot deploy unless the control sheet deploys with it or
before it.

**Before 18 November** (the first day's room):

1. **Intranet: assembly identity** on events, form, backfill and the
   category fix (2.1, 2.4, 2.5). Tests, Pint. Intranet commits carry no
   `Co-Authored-By` trailer (its `CLAUDE.md`).
2. **Intranet: attendees and images routes** (2.2, 2.3), limiter branch,
   tests, Intranet `AGENTS.md`. Deploy the Intranet and check the 80.ª AGO
   answers with the token.

   Phases 1 and 2 were built in the Intranet's working tree on
   2026-11-14/15. They are not committed or deployed yet. The contract is in
   `docs/intranet.md` ("Rutas de la vista de la sala").

3. **Platform: data and server**: migration 0034, permissions and seed,
   section, DTOs, schemas, sync (optional route: it works with manual groups
   while the Intranet deploys, so the Intranet is never the critical path),
   people and groups, assignments, layout PUT, images queue and route,
   activity, live filter, docs.
4. **Platform: the room**: layout model (Doble U and its parameters, seat ids
   kept on regeneration, runs; pure, tested), the SVG viewport, loose chairs
   and disabling a seat.
5. **Platform: placing**: tray, pick-and-tap, Proponer reparto (pure,
   tested), seat menu, warnings, Lista.
6. **Platform: bubbles**: both views at one level of detail, colours and
   legend, search, details. Deploy.

**After** (as soon as it is ready, the session included):

7. Free editing in Editar sala (move and rotate tables, add tables,
   fixtures, undo and redo), the other templates (U, Filas, Islas).
8. Dragging with the N-seat preview and swaps by dragging; level of detail by
   zoom.
9. Print (A3 plan with index) and "Copiar la sala de otra asamblea".
10. Retention job, presence notice, undo in Colocar.

## Known limits

- The Intranet is the only source of names: a person who comes unregistered
  is a manual person or a placeholder.
- One plan per assembly: who is absent on a given day shows only through the
  headcount, not on the plan.
- The plan is never projected to the room.
- Images refresh on sync, not live.
- Place cards, check-in and per-day plans are out of scope.
