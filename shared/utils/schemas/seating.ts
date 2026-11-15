import { z } from "zod/v4";
import { SEATING_MANUAL_GROUP_KINDS } from "../../constants/domain";
import type {
  SeatingAssignmentsBody,
  SeatingGroupCreateBody,
  SeatingGroupUpdateBody,
  SeatingLayoutBody,
  SeatingPersonCreateBody,
  SeatingPersonUpdateBody,
  SeatingSourceBody,
} from "../../types/api";
import {
  SEATING_FIXTURE_KINDS,
  SEATING_LAYOUT_SCHEMA_VERSION,
  SEATING_SIDES,
  SEATING_TABLE_SHAPES,
  SEATING_ZONES,
  type SeatingLayout,
} from "../seating/layout";
import { LOOSE_CHAIRS_RUN } from "../seating/runs";
import { DOUBLE_U_LIMITS, doubleUParamsProblem } from "../seating/templates";
import { intranetIdSchema } from "./member";

/**
 * Bodies of the seating endpoints (docs/seating-plan.md, section 8) and the
 * Intranet's attendees of an assembly (docs/intranet.md, «Rutas de la vista
 * de la sala»). They mirror the types in shared/types/api.ts.
 */

/** The limits of a layout (docs/seating-plan.md, section 4). */
export const SEATING_LIMITS = {
  tables: 200,
  /** Tables' seats and loose chairs together. */
  seats: 600,
  fixtures: 60,
  /** ±100 m. */
  coordinate: 10_000,
  /** The longest side of a table or a landmark. */
  size: 5_000,
  label: 60,
  seatIndex: 99,
  /** Seat changes in one batch. */
  ops: 600,
  acronym: 20,
  groupName: 200,
  firstName: 100,
  surname: 150,
  position: 9_999,
  /** Rows of each list the Intranet sends. */
  intranetRows: 5_000,
} as const;

/** Ids the server and the layout mint (cuid2). */
const entityId = z.string().regex(/^[a-z0-9]{20,32}$/);

/** better-auth's user ids. */
const userId = z.string().regex(/^[a-zA-Z0-9]{32}$/);

const isoDate = z.iso.datetime({ offset: true });

/**
 * Control characters, which Postgres refuses in a text column (NUL) or
 * which have no place in a name: a write that carried one would fail, and
 * only its error would say why. They go, as in the content schemas.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const clean = (value: string) =>
  value.replace(CONTROL_CHARS, "").replace(/\s+/g, " ").trim();

/** Control characters out, whitespace collapsed and trimmed. */
const text = (max: number) =>
  z.string().transform(clean).pipe(z.string().min(1).max(max));

const label = text(SEATING_LIMITS.label);
const coordinate = z
  .number()
  .min(-SEATING_LIMITS.coordinate)
  .max(SEATING_LIMITS.coordinate);
const size = z.number().positive().max(SEATING_LIMITS.size);
/** Clockwise, in steps of 15°. */
const rotation = z
  .number()
  .int()
  .min(0)
  .max(345)
  .refine((value) => value % 15 === 0, { message: "Giro de 15 en 15 grados" });

const seatSchema = z.strictObject({
  id: entityId,
  side: z.enum(SEATING_SIDES),
  index: z.number().int().min(0).max(SEATING_LIMITS.seatIndex),
  disabled: z.boolean().optional(),
  label: label.optional(),
});

const tableSchema = z.strictObject({
  id: entityId,
  slot: z
    .string()
    .regex(/^[a-z0-9:-]{1,60}$/)
    .optional(),
  shape: z.enum(SEATING_TABLE_SHAPES),
  x: coordinate,
  y: coordinate,
  w: size,
  h: size,
  rotation,
  zone: z.enum(SEATING_ZONES),
  run: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,39}$/)
    .refine((value) => value !== LOOSE_CHAIRS_RUN, {
      message: "Fila reservada a las sillas sueltas",
    }),
  seats: z.array(seatSchema).max(SEATING_LIMITS.seats),
});

const chairSchema = z.strictObject({
  id: entityId,
  x: coordinate,
  y: coordinate,
  rotation,
  label: label.optional(),
});

const fixtureSchema = z.strictObject({
  id: entityId,
  kind: z.enum(SEATING_FIXTURE_KINDS),
  x: coordinate,
  y: coordinate,
  w: size,
  h: size,
  rotation,
  label: label.optional(),
});

const count = (limit: { min: number; max: number }) =>
  z.number().int().min(limit.min).max(limit.max);

export const doubleUParamsSchema = z
  .strictObject({
    outerArmTables: count(DOUBLE_U_LIMITS.outerArmTables),
    outerBaseTables: count(DOUBLE_U_LIMITS.outerBaseTables),
    innerArmTables: count(DOUBLE_U_LIMITS.innerArmTables),
    innerBaseTables: count(DOUBLE_U_LIMITS.innerBaseTables),
    seatsPerTable: z.union([z.literal(2), z.literal(3)]),
    mesaSeats: count(DOUBLE_U_LIMITS.mesaSeats),
    gap: count(DOUBLE_U_LIMITS.gap),
  })
  .superRefine((params, context) => {
    const problem = doubleUParamsProblem(params);
    if (problem) context.addIssue({ code: "custom", message: problem });
  });

const templateSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("double_u"), params: doubleUParamsSchema }),
  z.strictObject({ kind: z.literal("empty"), params: z.strictObject({}) }),
  // Templates a later release generates: accepted with loose parameters, so
  // a layout it saved still parses after a rollback.
  z.strictObject({
    kind: z.enum(["u", "rows", "islands"]),
    params: z
      .record(
        z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,39}$/),
        z.union([z.number(), z.boolean(), z.string().max(60)]),
      )
      .refine((params) => Object.keys(params).length <= 30, {
        message: "Demasiados parámetros",
      }),
  }),
]);

/** A room (SeatingLayout v1), with every limit of section 4. */
export const seatingLayoutSchema = z
  .strictObject({
    schemaVersion: z.literal(SEATING_LAYOUT_SCHEMA_VERSION),
    tables: z.array(tableSchema).max(SEATING_LIMITS.tables),
    chairs: z.array(chairSchema).max(SEATING_LIMITS.seats),
    fixtures: z.array(fixtureSchema).max(SEATING_LIMITS.fixtures),
    template: templateSchema,
  })
  .superRefine((layout, context) => {
    const issue = (message: string) =>
      context.addIssue({ code: "custom", message });
    const seats =
      layout.tables.reduce((sum, table) => sum + table.seats.length, 0) +
      layout.chairs.length;
    if (seats > SEATING_LIMITS.seats) {
      issue(`Más de ${SEATING_LIMITS.seats} asientos`);
    }
    const unique = (ids: readonly string[], message: string) => {
      if (new Set(ids).size !== ids.length) issue(message);
    };
    unique(
      layout.tables.map((table) => table.id),
      "Dos mesas con el mismo id",
    );
    unique(
      layout.tables.flatMap((table) => (table.slot ? [table.slot] : [])),
      "Dos mesas en el mismo sitio de la plantilla",
    );
    unique(
      layout.fixtures.map((fixture) => fixture.id),
      "Dos referencias con el mismo id",
    );
    unique(
      [
        ...layout.tables.flatMap((table) => table.seats.map((seat) => seat.id)),
        ...layout.chairs.map((chair) => chair.id),
      ],
      "Dos asientos con el mismo id",
    );
    for (const table of layout.tables) {
      unique(
        table.seats.map((seat) => `${seat.side}:${seat.index}`),
        "Dos asientos en el mismo sitio de una mesa",
      );
      const around = (seat: { side: string }) => seat.side === "around";
      if (table.shape === "round" && !table.seats.every(around)) {
        issue("Una mesa redonda solo tiene asientos alrededor");
      }
      if (table.shape === "rect" && table.seats.some(around)) {
        issue("Una mesa rectangular no tiene asientos alrededor");
      }
    }
  });

// Compile-time check: a parsed layout is a SeatingLayout.
export type _SeatingLayoutSchemaCheck = Assignable<
  SeatingLayout,
  z.output<typeof seatingLayoutSchema>
>;

/** PUT .../seating/layout (SeatingLayoutBody). */
export const seatingLayoutBodySchema = z.strictObject({
  layout: seatingLayoutSchema,
  updatedAt: isoDate.nullable(),
  /** The seats and people a 409 `seating_seats_occupied` named, confirmed. */
  releaseSeats: z
    .array(z.strictObject({ seatId: entityId, personId: entityId }))
    .max(SEATING_LIMITS.seats)
    .optional(),
});

/** POST .../seating/assignments (SeatingAssignmentsBody): all or none. */
export const seatingAssignmentsBodySchema = z
  .strictObject({
    ops: z
      .array(
        z.strictObject({
          seatId: entityId,
          expected: entityId.nullable(),
          next: entityId.nullable(),
        }),
      )
      .min(1)
      .max(SEATING_LIMITS.ops),
  })
  .superRefine((body, context) => {
    const seatIds = body.ops.map((op) => op.seatId);
    if (new Set(seatIds).size !== seatIds.length) {
      context.addIssue({ code: "custom", message: "Un asiento dos veces" });
    }
    const next = body.ops.flatMap((op) => (op.next ? [op.next] : []));
    if (new Set(next).size !== next.length) {
      context.addIssue({
        code: "custom",
        message: "Una persona en dos asientos",
      });
    }
  });

const atLeastOne = (value: Record<string, unknown>) =>
  Object.entries(value).some(
    ([key, entry]) => key !== "updatedAt" && entry !== undefined,
  );

/** POST .../seating/groups (SeatingGroupCreateBody). */
export const seatingGroupCreateBodySchema = z.strictObject({
  acronym: text(SEATING_LIMITS.acronym),
  name: text(SEATING_LIMITS.groupName),
  kind: z.enum(SEATING_MANUAL_GROUP_KINDS).optional(),
  memberId: entityId.nullable().optional(),
});

/** PATCH .../seating/groups/[group] (SeatingGroupUpdateBody). */
export const seatingGroupUpdateBodySchema = z
  .strictObject({
    updatedAt: isoDate,
    acronym: text(SEATING_LIMITS.acronym).optional(),
    name: text(SEATING_LIMITS.groupName).optional(),
    kind: z.enum(SEATING_MANUAL_GROUP_KINDS).optional(),
    memberId: entityId.nullable().optional(),
  })
  .refine(atLeastOne, { message: "Nada que cambiar" });

const firstName = text(SEATING_LIMITS.firstName);
const surname = text(SEATING_LIMITS.surname).nullable();

/** POST .../seating/people (SeatingPersonCreateBody). */
export const seatingPersonCreateBodySchema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("manual"),
    groupId: entityId,
    firstName,
    surname: surname.optional(),
    label: label.nullable().optional(),
    needsSeat: z.boolean().optional(),
    userId: userId.nullable().optional(),
  }),
  z.strictObject({
    source: z.literal("placeholder"),
    groupId: entityId,
    label: label.nullable().optional(),
    needsSeat: z.boolean().optional(),
  }),
]);

/** PATCH .../seating/people/[person] (SeatingPersonUpdateBody). */
export const seatingPersonUpdateBodySchema = z
  .strictObject({
    updatedAt: isoDate,
    needsSeat: z.boolean().optional(),
    label: label.nullable().optional(),
    position: z.number().int().min(0).max(SEATING_LIMITS.position).optional(),
    firstName: firstName.optional(),
    surname: surname.optional(),
    userId: userId.nullable().optional(),
  })
  .refine(atLeastOne, { message: "Nada que cambiar" });

/** PUT .../seating/source (SeatingSourceBody). */
export const seatingSourceBodySchema = z.strictObject({
  sourceAssemblyId: entityId.nullable(),
  expected: entityId.nullable(),
});

// The Intranet ------------------------------------------------------------------

/**
 * A text the Intranet may send as null, a number or blank: whitespace
 * collapsed, null when empty, cut to `max` (it is a snapshot, never worth
 * failing a sync for).
 */
const intranetText = (max: number) =>
  z
    .union([z.string(), z.number()])
    .nullish()
    .transform((value) => {
      if (value === null || value === undefined) return null;
      const cleaned = clean(String(value));
      return cleaned === "" ? null : cleaned.slice(0, max);
    });

/**
 * An image's version (the md5 the Intranet puts in `?v=`). It names the
 * cached file, so anything but letters and digits counts as no image.
 */
const intranetImageVersion = z
  .unknown()
  .optional()
  .transform((value) => {
    if (typeof value !== "string") return null;
    const version = value.trim().toLowerCase();
    return /^[a-z0-9]{1,64}$/.test(version) ? version : null;
  });

const intranetDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullish()
  .transform((value) => value ?? null);

const intranetAccountSchema = z.object({
  id: intranetIdSchema,
  /** `users.type` as it is: Asociado, Sectorial, CEA, CAS, CAI, CdG... */
  type: intranetText(40),
  /** `Individual` or `Multiusuario`. */
  category: intranetText(40),
  initials: intranetText(SEATING_LIMITS.acronym),
  designation: intranetText(SEATING_LIMITS.groupName),
  university_acronym: intranetText(SEATING_LIMITS.acronym),
  /** The CEA's order (CeaSortingService); null for everyone else. */
  order: z
    .number()
    .int()
    .min(1)
    .max(9_999)
    .nullish()
    .transform((value) => value ?? null),
  logo_version: intranetImageVersion,
});

/**
 * An attendee: name, surnames and photo only. The modality the Intranet
 * also sends is dropped here, so it never reaches the database.
 */
const intranetAttendeeSchema = z.object({
  id: intranetIdSchema,
  account_id: intranetIdSchema,
  name: intranetText(SEATING_LIMITS.firstName),
  surname: intranetText(SEATING_LIMITS.surname),
  status: z.enum(["Pendiente", "Confirmada"]),
  photo_version: intranetImageVersion,
});

/**
 * GET {base}/asambleas/{type}/{number}/asistentes. Keys it does not know are
 * dropped. The whole answer is refused, so the sync writes nothing, when a
 * row is malformed (an id that is not a positive integer, a status other than
 * Pendiente or Confirmada), when a list is longer than 5000 rows or when an
 * attendee's account is not among the accounts. An id listed twice keeps its
 * first row.
 */
export const intranetAttendeesResponseSchema = z
  .object({
    event: z.object({
      id: intranetIdSchema,
      name: intranetText(300),
      start_date: intranetDate,
      end_date: intranetDate,
    }),
    accounts: z.array(intranetAccountSchema).max(SEATING_LIMITS.intranetRows),
    attendees: z.array(intranetAttendeeSchema).max(SEATING_LIMITS.intranetRows),
    generated_at: z.string().nullish(),
  })
  .superRefine((response, context) => {
    const accounts = new Set(response.accounts.map((account) => account.id));
    if (
      response.attendees.some((attendee) => !accounts.has(attendee.account_id))
    ) {
      context.addIssue({
        code: "custom",
        message: "Un asistente de una cuenta que no está en la lista",
      });
    }
  })
  .transform((response) => ({
    ...response,
    accounts: firstById(response.accounts),
    attendees: firstById(response.attendees),
  }));

export type IntranetAttendeesResponse = z.output<
  typeof intranetAttendeesResponseSchema
>;
export type IntranetSeatingAccount =
  IntranetAttendeesResponse["accounts"][number];
export type IntranetSeatingAttendee =
  IntranetAttendeesResponse["attendees"][number];

function firstById<T extends { id: number }>(rows: readonly T[]): T[] {
  const seen = new Set<number>();
  return rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}

// Compile-time check: the parsed bodies are assignable to their API types.
type Assignable<T, U extends T> = U;
export type _SeatingSchemaChecks = [
  Assignable<SeatingLayoutBody, z.output<typeof seatingLayoutBodySchema>>,
  Assignable<
    SeatingAssignmentsBody,
    z.output<typeof seatingAssignmentsBodySchema>
  >,
  Assignable<
    SeatingGroupCreateBody,
    z.output<typeof seatingGroupCreateBodySchema>
  >,
  Assignable<
    SeatingGroupUpdateBody,
    z.output<typeof seatingGroupUpdateBodySchema>
  >,
  Assignable<
    SeatingPersonCreateBody,
    z.output<typeof seatingPersonCreateBodySchema>
  >,
  Assignable<
    SeatingPersonUpdateBody,
    z.output<typeof seatingPersonUpdateBodySchema>
  >,
  Assignable<SeatingSourceBody, z.output<typeof seatingSourceBodySchema>>,
];
