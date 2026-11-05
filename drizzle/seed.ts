/**
 * Seeds the RBAC catalog (roles, every permission key and the default role
 * permissions). Idempotent: safe to run on every deploy.
 *
 * With SEED_DEMO=1 it also loads a demo dataset so every screen has data:
 * members, an 80.ª AGO convened with its amendment window open, a structured
 * positioning with amendments (overlapping, transactional, related), a
 * resolution with a late amendment validated and published that waits for
 * the assembly's decision to treat it, and a 35.ª AGE draft.
 * The Secretaría's review shows too: most amendments validated and
 * published, one validated and kept private, one waiting for validation, one
 * sent back for correction, a resolution waiting for validation, and two
 * expected CEA reports (one due soon, one overdue).
 * Main presenters and main authors: the mental health resolution has a
 * co-presenter (CEUM) besides its main presenter (CEUAM), who already
 * answered one amendment; CAUB 2 has a co-author (CEUAM) and a main author
 * (CAUB); T1, accepted by the main authors of what it groups and validated,
 * has replaced them (transacted) and waits for the presenter's answer; T2,
 * proposed by a member that wrote neither source, waits for their main
 * authors (pending_authors); and a regulation incorporates the amendments its
 * presenter accepts ("incorporate"): one already incorporated, one to answer.
 * The Mesa's list of speaking turns has a finished turn, one speaking and two
 * waiting.
 * The demo is skipped when the 80.ª AGO already exists: a database seeded
 * before these were added keeps its demo as it was (reset it to get them).
 *
 * Runs under tsx, outside Nuxt: import only from `shared/**` and
 * `server/db/schema`, with relative paths.
 */
import "dotenv/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createId } from "@paralleldrive/cuid2";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../server/db/schema";
import type { AmendmentMeta } from "../server/db/schema";
import { requireConfigString } from "../shared/utils/config";
import { SYSTEM_ROLES, SYSTEM_ROLE_NAMES } from "../shared/constants/roles";
import {
  ALL_PERMISSION_KEYS,
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_DESCRIPTION_I18N_KEYS,
} from "../shared/constants/permissions";
import {
  DEFAULT_ASSEMBLY_SETTINGS,
  DOCUMENT_KIND_DEFAULTS,
  MILESTONE_KEYS,
  type AmendmentKind,
  type DocumentKind,
  type MemberKind,
  type MemberSource,
  type ProponentPosition,
} from "../shared/constants/domain";
import type { AssemblyType } from "../shared/constants/assemblyTypes";
import type {
  AmendmentOp,
  Block,
  Mark,
  MarkType,
} from "../shared/types/content";
import { defaultMilestones, type Milestones } from "../shared/utils/calendar";
import { diffText } from "../shared/utils/content/diff";
import {
  globalReplaceOps,
  positionKey,
  validateOps,
} from "../shared/utils/content/ops";
import { findOverlaps } from "../shared/utils/content/overlaps";
import { hashContent } from "../shared/utils/diff";
import { blocksSchema } from "../shared/utils/schemas/content";
import { slugify } from "../shared/utils/slug";

type Db = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// RBAC ------------------------------------------------------------------------

const ROLE_DESCRIPTIONS: Record<string, string> = {
  [SYSTEM_ROLES.ADMIN]: "Acceso completo a todas las funciones del sistema",
  [SYSTEM_ROLES.SECRETARIA]:
    "Gestiona todo: asambleas, documentos, enmiendas, miembros, usuarios y roles",
  [SYSTEM_ROLES.MODERADOR]:
    "Modera el desarrollo de las sesiones (Vocalía y Presidencia de la Mesa)",
  [SYSTEM_ROLES.PRESIDENCIA]:
    "Gestiona todo, como la Secretaría: asambleas, documentos, enmiendas, miembros, usuarios y roles",
  [SYSTEM_ROLES.CEA]:
    "Presenta la documentación de su área de la Comisión Ejecutiva y enmiendas",
  [SYSTEM_ROLES.ASOCIADO]: "Presenta documentos y enmiendas",
  [SYSTEM_ROLES.INVITADO]: "Solo lectura de contenido publicado",
};

async function seedRbac(db: Db): Promise<void> {
  console.log("Seeding roles...");
  const roleRecords = await db
    .insert(schema.roles)
    .values(
      SYSTEM_ROLE_NAMES.map((name) => ({
        name,
        description: ROLE_DESCRIPTIONS[name] ?? null,
        isSystem: true,
      })),
    )
    .onConflictDoUpdate({
      target: schema.roles.name,
      set: {
        description: sql`excluded.description`,
        isSystem: sql`excluded.is_system`,
      },
    })
    .returning({ id: schema.roles.id });
  console.log(`  ${roleRecords.length} roles upserted`);

  console.log("Seeding permissions...");
  const permissionRecords = await db
    .insert(schema.permissions)
    .values(
      ALL_PERMISSION_KEYS.map((key) => ({
        key,
        description: PERMISSION_DESCRIPTION_I18N_KEYS[key] ?? null,
      })),
    )
    .onConflictDoUpdate({
      target: schema.permissions.key,
      set: { description: sql`excluded.description` },
    })
    .returning({ id: schema.permissions.id });
  console.log(`  ${permissionRecords.length} permissions upserted`);

  console.log("Seeding role-permission assignments...");
  const allRoles = await db.query.roles.findMany({
    columns: { id: true, name: true },
  });
  const allPermissions = await db.query.permissions.findMany({
    columns: { id: true, key: true },
  });
  const roleByName = new Map(allRoles.map((role) => [role.name, role.id]));
  const permissionByKey = new Map(
    allPermissions.map((permission) => [permission.key, permission.id]),
  );

  const assignments: { roleId: string; permissionId: string }[] = [];
  for (const [roleName, keys] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    const roleId = roleByName.get(roleName);
    if (!roleId) continue;
    for (const key of keys) {
      const permissionId = permissionByKey.get(key);
      if (permissionId) assignments.push({ roleId, permissionId });
    }
  }

  if (assignments.length > 0) {
    const inserted = await db
      .insert(schema.rolePermissions)
      .values(assignments)
      .onConflictDoNothing()
      .returning({ id: schema.rolePermissions.id });
    console.log(
      `  ${inserted.length} role-permission assignments created (skipped existing)`,
    );
  } else {
    console.log("  No assignments to create");
  }
}

// Demo content (pure) -----------------------------------------------------------

interface DemoMember {
  acronym: string;
  kind: MemberKind;
  name: string;
  university: string | null;
  region: string | null;
  source: MemberSource;
}

const DEMO_MEMBERS: DemoMember[] = [
  {
    acronym: "CEUM",
    kind: "asociado",
    name: "Consejo de Estudiantes de la Universidad de Murcia",
    university: "Universidad de Murcia",
    region: "Región de Murcia",
    source: "intranet",
  },
  {
    acronym: "CEULE",
    kind: "asociado",
    name: "Consejo de Estudiantes de la Universidad de León",
    university: "Universidad de León",
    region: "Castilla y León",
    source: "intranet",
  },
  {
    acronym: "UPV",
    kind: "asociado",
    name: "Delegación de Alumnos de la Universitat Politècnica de València",
    university: "Universitat Politècnica de València",
    region: "Comunitat Valenciana",
    source: "intranet",
  },
  {
    acronym: "CAUB",
    kind: "asociado",
    name: "Consell de l'Alumnat de la Universitat de Barcelona",
    university: "Universitat de Barcelona",
    region: "Cataluña",
    source: "intranet",
  },
  {
    acronym: "CEUAM",
    kind: "asociado",
    name: "Consejo de Estudiantes de la Universidad Autónoma de Madrid",
    university: "Universidad Autónoma de Madrid",
    region: "Comunidad de Madrid",
    source: "intranet",
  },
  {
    acronym: "UGR",
    kind: "asociado",
    name: "Delegación General de Estudiantes de la Universidad de Granada",
    university: "Universidad de Granada",
    region: "Andalucía",
    source: "intranet",
  },
  {
    acronym: "CEEM",
    kind: "sectorial",
    name: "Consejo Estatal de Estudiantes de Medicina",
    university: null,
    region: null,
    source: "intranet",
  },
  {
    acronym: "VPU",
    kind: "executive",
    name: "Vicepresidencia de Política Universitaria",
    university: null,
    region: null,
    source: "manual",
  },
  {
    acronym: "PRES",
    kind: "executive",
    name: "Presidencia",
    university: null,
    region: null,
    source: "manual",
  },
];

type BlockSpec = Omit<Block, "id" | "marks"> & { marks?: Mark[] };

const heading = (level: number, text: string): BlockSpec => ({
  type: "heading",
  level,
  text,
});
const paragraph = (text: string, marks: Mark[] = []): BlockSpec => ({
  type: "paragraph",
  text,
  marks,
});
const listItem = (
  text: string,
  list: "bullet" | "ordered" = "bullet",
): BlockSpec => ({
  type: "list_item",
  level: 0,
  list,
  text,
});
const quote = (text: string, marks: Mark[] = []): BlockSpec => ({
  type: "quote",
  text,
  marks,
});

function markOver(
  text: string,
  fragment: string,
  type: MarkType,
  href?: string,
): Mark {
  const from = text.indexOf(fragment);
  if (from < 0) throw new Error(`Mark fragment not found: ${fragment}`);
  return { type, from, to: from + fragment.length, ...(href ? { href } : {}) };
}

function withMark(
  text: string,
  fragment: string,
  type: MarkType,
  href?: string,
): [string, Mark[]] {
  return [text, [markOver(text, fragment, type, href)]];
}

/** Gives every block a fresh id and runs it through the same schema as the API. */
function buildBlocks(specs: BlockSpec[], newId: () => string): Block[] {
  return blocksSchema.parse(
    specs.map((spec) => ({ id: newId(), marks: [], ...spec })),
  );
}

function positioningBlocks(newId: () => string): Block[] {
  const motive = withMark(
    "Según los últimos datos publicados por el Ministerio, cerca de un tercio del estudiantado universitario percibe alguna beca, pero la cuantía media apenas cubre una parte del coste real de estudiar fuera del domicilio familiar, sobre todo en las ciudades con mayor presión sobre el alquiler.",
    "Ministerio",
    "link",
    "https://www.universidades.gob.es",
  );
  const demand = withMark(
    "CREUP exige la actualización anual de los umbrales de renta y patrimonio conforme al índice de precios de consumo, de manera que ninguna familia pierda el derecho a beca por efecto de la inflación.",
    "CREUP exige",
    "bold",
  );
  const covenant = withMark(
    "«La enseñanza superior debe hacerse igualmente accesible a todos, sobre la base de la capacidad de cada uno». Pacto Internacional de Derechos Económicos, Sociales y Culturales, artículo 13.",
    "«La enseñanza superior debe hacerse igualmente accesible a todos, sobre la base de la capacidad de cada uno».",
    "italic",
  );
  return buildBlocks(
    [
      heading(
        1,
        "Posicionamiento sobre el sistema de becas y ayudas al estudio",
      ),
      heading(2, "1. Exposición de motivos"),
      paragraph(
        "Las becas y ayudas al estudio son la principal herramienta para garantizar la igualdad de oportunidades en el acceso a la universidad y en la permanencia en ella. Sin embargo, el sistema estatal arrastra desde hace más de una década umbrales de renta que no se actualizan, una cuantía fija insuficiente y plazos de resolución que obligan a muchas familias a adelantar el coste de la matrícula.",
      ),
      paragraph(...motive),
      paragraph(
        "Por ello, la Coordinadora de Representantes de Estudiantes de Universidades Públicas (CREUP) considera imprescindible una reforma integral que sitúe al estudiantado en el centro del sistema y dé estabilidad a las convocatorias.",
      ),
      heading(2, "2. Umbrales y cuantías"),
      paragraph(...demand),
      paragraph(
        "Asimismo, la cuantía fija ligada a la residencia debe incrementarse hasta cubrir el coste medio del alquiler de una habitación en la comunidad autónoma donde se cursan los estudios.",
      ),
      listItem(
        "Gratuidad de la primera matrícula para todo el estudiantado becario.",
      ),
      listItem("Incremento de la cuantía variable mínima hasta los 150 euros."),
      listItem(
        "Creación de una cuantía específica para estudiantes con discapacidad.",
      ),
      heading(2, "3. Requisitos académicos"),
      paragraph(
        "Los requisitos académicos para obtener o renovar la beca deben ser iguales en todas las ramas de conocimiento, sin penalizar al alumnado que cursa titulaciones con mayor tasa de suspensos.",
      ),
      paragraph(
        "En el caso de los másteres habilitantes, CREUP propone exigir el mismo rendimiento académico que en el grado, puesto que constituyen la continuación necesaria para ejercer la profesión.",
      ),
      heading(2, "4. Gestión y plazos"),
      paragraph(
        "La convocatoria debe publicarse antes del inicio del curso académico y resolverse en un plazo máximo de tres meses desde la finalización del periodo de solicitud.",
      ),
      paragraph(
        "El pago de la beca debe realizarse en un único abono antes del 31 de diciembre, evitando que el alumnado tenga que adelantar los gastos del primer cuatrimestre.",
      ),
      paragraph(
        "Las universidades deberán habilitar oficinas de atención al alumnado becario y publicar estadísticas anuales sobre solicitudes, concesiones y denegaciones.",
      ),
      heading(2, "5. Conclusiones"),
      paragraph(
        "Por todo lo anterior, CREUP insta al Ministerio de Ciencia, Innovación y Universidades y a las comunidades autónomas a abordar de forma urgente una reforma del sistema de becas y ayudas al estudio que garantice la equidad, la suficiencia y la previsibilidad.",
      ),
      quote(...covenant),
    ],
    newId,
  );
}

function mentalHealthBlocks(newId: () => string): Block[] {
  return buildBlocks(
    [
      heading(
        1,
        "Resolución sobre la atención a la salud mental en las universidades públicas",
      ),
      paragraph(
        "La Asamblea General de CREUP constata el aumento sostenido de la demanda de atención psicológica entre el estudiantado universitario y la insuficiencia de los servicios disponibles en muchas universidades.",
      ),
      paragraph("Por ello, la Asamblea General resuelve:"),
      listItem(
        "Instar a las universidades públicas a dotar sus servicios de atención psicológica con, al menos, un profesional por cada 3.000 estudiantes.",
        "ordered",
      ),
      listItem(
        "Solicitar al Ministerio una línea de financiación específica para programas de prevención y acompañamiento.",
        "ordered",
      ),
      listItem(
        "Promover la formación del personal docente en la detección temprana de situaciones de riesgo.",
        "ordered",
      ),
    ],
    newId,
  );
}

function transportBlocks(newId: () => string): Block[] {
  return buildBlocks(
    [
      heading(1, "Resolución sobre el transporte público para estudiantes"),
      paragraph(
        "La Asamblea General de CREUP considera que el coste del transporte es una barrera de acceso a la educación superior, especialmente para el estudiantado que se desplaza a diario desde zonas rurales.",
      ),
      paragraph(
        "Por ello, la Asamblea General insta a las administraciones competentes a implantar un abono de transporte joven de ámbito estatal, con tarifa reducida para estudiantes universitarios.",
      ),
    ],
    newId,
  );
}

function regulationBlocks(newId: () => string): Block[] {
  return buildBlocks(
    [
      heading(1, "Reglamento de Régimen Interno de la Asamblea General"),
      heading(2, "Artículo 1. Convocatoria"),
      paragraph(
        "La Asamblea General se convocará con una antelación mínima de treinta días naturales, mediante comunicación a todos los miembros.",
      ),
      heading(2, "Artículo 2. Documentación"),
      paragraph(
        "La documentación de cada punto del orden del día se publicará en la plataforma de asambleas al menos quince días antes de la sesión.",
      ),
      heading(2, "Artículo 3. Enmiendas"),
      paragraph(
        "Los miembros podrán presentar enmiendas a los documentos publicados dentro del plazo fijado en el calendario de la asamblea.",
      ),
      paragraph(
        "Las enmiendas que acepte quien presenta el reglamento se incorporarán al texto sin necesidad de votación.",
      ),
    ],
    newId,
  );
}

/** Replace operations for one textual edit of a base block, through the engine. */
function editOps(
  base: Block[],
  index: number,
  find: string,
  replacement: string,
): AmendmentOp[] {
  const block = base[index];
  if (!block?.text.includes(find)) {
    throw new Error(`Demo edit target not found in block ${index}: ${find}`);
  }
  const ops = diffText(block, block.text.replace(find, replacement));
  if (ops.length === 0)
    throw new Error(`Demo edit produced no operations: ${find}`);
  return ops;
}

export type DemoDocumentKey = "positioning" | "mentalHealth" | "regulation";

export interface DemoAmendment {
  id: string;
  document: DemoDocumentKey;
  kind: AmendmentKind;
  /** Acronyms; the first one is the main author and presents the amendment. */
  authors: string[];
  ops: AmendmentOp[];
  justification: string;
  globalReplace?: { find: string; replace: string };
  submittedAt: Date;
  late: boolean;
  admission: "admitted" | "pending";
  /**
   * The Secretaría's review: validated (and published, when it was shown to
   * everyone) at these times, or sent back to draft with a note.
   */
  validatedAt: Date | null;
  publishedAt: Date | null;
  correction: { note: string; at: Date } | null;
  position: {
    position: ProponentPosition;
    comment: string | null;
    at: Date;
  } | null;
  /**
   * Decided already: replaced by a transactional (transacted), or approved
   * by the presenter's acceptance under the "incorporate" rule.
   */
  outcome?:
    | { status: "transacted"; at: Date; transactionalId: string }
    | { status: "approved"; at: Date; approvalMethod: "proponent" };
  /** Filled by numberAmendments for regular amendments. */
  number: number | null;
  memberSeq: number | null;
  code: string | null;
  positionKey: number;
}

export interface DemoTransactional extends DemoAmendment {
  sourceIds: string[];
  /** Its parties: the main authors of the amendments it replaces. */
  acceptances: {
    acronym: string;
    decidedAt: Date | null;
  }[];
}

/** A request to speak the Mesa wrote down (speaking_turns). */
export interface DemoSpeakingTurn {
  acronym: string;
  /** The person's name, when the Mesa wrote it. */
  speaker: string | null;
  status: "waiting" | "speaking" | "done";
  position: number;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
}

export interface DemoContent {
  now: Date;
  ago: { start: Date; end: Date; milestones: Milestones };
  age: { start: Date; end: Date; milestones: Milestones };
  positioning: Block[];
  mentalHealth: Block[];
  transport: Block[];
  /** A regulation: what its presenter accepts is incorporated without a vote. */
  regulation: Block[];
  /** Per-document amendment window of the resolution, already closed. */
  mentalHealthWindow: { opensAt: Date; closesAt: Date };
  amendments: DemoAmendment[];
  /**
   * T1: proposed by a party, accepted by the main authors, validated and
   * published: it replaced CEUM 1 and CAUB 1 (transacted).
   */
  transactional: DemoTransactional;
  /**
   * T2: proposed by a member that wrote neither source, presented and
   * waiting for their main authors (reviewState pending_authors).
   */
  memberTransactional: DemoTransactional;
  relation: { fromId: string; toId: string; note: string; at: Date };
  /** Turns on the positioning's agenda item. */
  speakingTurns: DemoSpeakingTurn[];
  /** Reports the Secretaría expects from CEA areas: empty drafts with an internal deadline. */
  expectedReports: {
    acronym: string;
    title: string;
    summary: string;
    format: "structured" | "file";
    dueAt: Date;
  }[];
}

function atUtcHour(base: Date, days: number, hour: number): Date {
  const date = new Date(base.getTime() + days * DAY);
  date.setUTCHours(hour, 0, 0, 0);
  return date;
}

/** Assigns number, memberSeq and code per document in submission order, as on submit. */
function numberAmendments(amendments: DemoAmendment[]): void {
  const byDocument = new Map<DemoDocumentKey, DemoAmendment[]>();
  for (const amendment of amendments) {
    const list = byDocument.get(amendment.document) ?? [];
    list.push(amendment);
    byDocument.set(amendment.document, list);
  }
  for (const list of byDocument.values()) {
    const seqByMember = new Map<string, number>();
    [...list]
      .sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime())
      .forEach((amendment, index) => {
        const presenting = amendment.authors[0]!;
        const seq = (seqByMember.get(presenting) ?? 0) + 1;
        seqByMember.set(presenting, seq);
        amendment.number = index + 1;
        amendment.memberSeq = seq;
        amendment.code = `${presenting} ${seq}`;
      });
  }
}

function assertValid(base: Block[], amendment: DemoAmendment): void {
  const errors = validateOps(base, amendment.ops);
  if (errors.length > 0) {
    throw new Error(
      `Demo amendment ${amendment.authors[0]} is invalid: ${JSON.stringify(errors)}`,
    );
  }
}

/**
 * Builds every demo text and amendment with the amendment engine and checks
 * them: valid operations, exactly one overlap cluster (the two amendments on
 * the residence allowance and their transactional), a non-empty global
 * replacement and a late amendment that really is late.
 */
export function buildDemoContent(
  now = new Date(),
  newId: () => string = createId,
): DemoContent {
  const agoStart = atUtcHour(now, 7, 9);
  const agoMilestones = defaultMilestones("AGO", agoStart);
  const ageStart = atUtcHour(now, 40, 9);

  const positioning = positioningBlocks(newId);
  const mentalHealth = mentalHealthBlocks(newId);
  const transport = transportBlocks(newId);
  const regulation = regulationBlocks(newId);
  const baseOf: Record<DemoDocumentKey, Block[]> = {
    positioning,
    mentalHealth,
    regulation,
  };
  const ago = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * HOUR);

  // By default the Secretaría validated and published an amendment six hours
  // after it was presented.
  const amendment = (
    input: Omit<
      DemoAmendment,
      | "id"
      | "number"
      | "memberSeq"
      | "code"
      | "positionKey"
      | "late"
      | "admission"
      | "validatedAt"
      | "publishedAt"
      | "correction"
    > &
      Partial<
        Pick<
          DemoAmendment,
          "late" | "admission" | "validatedAt" | "publishedAt" | "correction"
        >
      >,
  ): DemoAmendment => {
    const base = baseOf[input.document];
    const validatedAt = new Date(input.submittedAt.getTime() + 6 * HOUR);
    const built: DemoAmendment = {
      id: newId(),
      late: false,
      admission: "admitted",
      validatedAt,
      publishedAt: validatedAt,
      correction: null,
      number: null,
      memberSeq: null,
      code: null,
      positionKey: positionKey(input.ops, base),
      ...input,
    };
    assertValid(base, built);
    return built;
  };

  const residenceFull = amendment({
    document: "positioning",
    kind: "partial",
    authors: ["CEUM"],
    ops: editOps(positioning, 7, "coste medio", "coste íntegro"),
    justification:
      "Una cuantía que solo cubre el coste medio deja fuera a quienes estudian en las ciudades más caras. La beca de residencia debe cubrir el alquiler real.",
    submittedAt: ago(96),
    position: {
      position: "transact",
      comment: "Proponemos una transaccional junto con CAUB 1.",
      at: ago(30),
    },
  });
  const residenceReference = amendment({
    document: "positioning",
    kind: "partial",
    authors: ["CAUB"],
    ops: editOps(positioning, 7, "coste medio", "precio de referencia"),
    justification:
      "El coste medio autonómico no refleja las diferencias entre municipios. Proponemos usar el precio de referencia del alquiler que publican las administraciones.",
    submittedAt: ago(90),
    position: { position: "transact", comment: null, at: ago(30) },
  });
  const globalReplace = { find: "alumnado", replace: "estudiantado" };
  const inclusiveLanguage = amendment({
    document: "positioning",
    kind: "formal",
    authors: ["UPV"],
    ops: globalReplaceOps(
      positioning,
      globalReplace.find,
      globalReplace.replace,
    ),
    globalReplace,
    justification:
      "Unificar la terminología del documento con el resto de posicionamientos de CREUP.",
    submittedAt: ago(80),
    position: { position: "accept", comment: null, at: ago(28) },
  });
  if (inclusiveLanguage.ops.length < 2) {
    throw new Error(
      "The demo global replacement should match several passages",
    );
  }
  const mobility = amendment({
    document: "positioning",
    kind: "partial",
    authors: ["CEUAM"],
    ops: [
      {
        op: "insert",
        afterBlockId: positioning[10]!.id,
        blocks: buildBlocks(
          [
            listItem(
              "Ampliación de las ayudas de movilidad para quienes cursen estudios fuera de su comunidad autónoma.",
            ),
          ],
          newId,
        ),
      },
    ],
    justification:
      "Las ayudas de movilidad entre comunidades autónomas desaparecieron con la reforma de 2012 y siguen siendo necesarias.",
    submittedAt: ago(72),
    position: { position: "accept", comment: null, at: ago(26) },
  });
  const removeMasters = amendment({
    document: "positioning",
    kind: "partial",
    authors: ["UGR"],
    ops: [{ op: "delete", blockIds: [positioning[13]!.id] }],
    justification:
      "Los másteres habilitantes no deben tener un régimen propio: el párrafo anterior ya fija requisitos iguales para todas las enseñanzas.",
    submittedAt: ago(66),
    position: {
      position: "reject",
      comment:
        "El párrafo recoge una demanda aprobada en la 79.ª AGO que queremos mantener.",
      at: ago(24),
    },
  });
  const resolutionTerm = amendment({
    document: "positioning",
    kind: "partial",
    authors: ["CEEM"],
    ops: editOps(positioning, 15, "tres meses", "dos meses"),
    justification:
      "Con tres meses de plazo, muchas resoluciones llegan en pleno segundo cuatrimestre. Dos meses permiten cobrar antes de las vacaciones de invierno.",
    submittedAt: ago(60),
    // Sent back by the Secretaría: CEEM has to fix it and present it again.
    admission: "pending",
    validatedAt: null,
    publishedAt: null,
    correction: {
      note: "Indica en la justificación de dónde sale el plazo de dos meses (norma o estudio) para que la Mesa pueda valorarlo.",
      at: ago(55),
    },
    position: null,
  });
  const paymentDate = amendment({
    document: "positioning",
    kind: "partial",
    authors: ["CEULE"],
    ops: editOps(
      positioning,
      16,
      "antes del 31 de diciembre",
      "antes del 30 de noviembre",
    ),
    justification:
      "El pago en noviembre llega antes de que venza el segundo plazo de la matrícula en la mayoría de universidades.",
    submittedAt: ago(50),
    position: { position: "accept", comment: null, at: ago(20) },
  });
  const universities = amendment({
    document: "positioning",
    kind: "partial",
    authors: ["CAUB", "CEUAM"],
    ops: editOps(
      positioning,
      19,
      " y a las comunidades autónomas",
      ", a las comunidades autónomas y a las universidades públicas",
    ),
    justification:
      "Las universidades gestionan las becas propias y las exenciones de precios públicos: también deben ser destinatarias del posicionamiento.",
    submittedAt: ago(40),
    // Validated (and admitted) but kept private: the Secretaría publishes it later.
    publishedAt: null,
    position: null,
  });
  const decade = amendment({
    document: "positioning",
    kind: "partial",
    authors: ["CEUM"],
    ops: editOps(positioning, 2, "más de una década", "más de quince años"),
    justification:
      "Los umbrales no se actualizan con el IPC desde el curso 2010-2011.",
    submittedAt: ago(30),
    // Waiting for the Secretaría to validate it.
    admission: "pending",
    validatedAt: null,
    publishedAt: null,
    position: null,
  });
  const mastersReference = amendment({
    document: "positioning",
    kind: "partial",
    authors: ["CEUAM"],
    ops: editOps(
      positioning,
      12,
      "con mayor tasa de suspensos.",
      "con mayor tasa de suspensos, salvo en los másteres habilitantes, que se rigen por lo dispuesto en el párrafo siguiente.",
    ),
    justification:
      "Conviene dejar claro que la regla general no se aplica a los másteres habilitantes, que tienen su propio párrafo.",
    submittedAt: ago(20),
    position: null,
  });

  const mentalHealthWindow = { opensAt: ago(5 * 24), closesAt: ago(24) };
  const ratio = amendment({
    document: "mentalHealth",
    kind: "partial",
    authors: ["CEULE"],
    ops: editOps(
      mentalHealth,
      3,
      "cada 3.000 estudiantes",
      "cada 1.500 estudiantes",
    ),
    justification:
      "La ratio de 3.000 estudiantes por profesional sigue muy por encima de las recomendaciones internacionales.",
    submittedAt: ago(48),
    // CEUAM, the main presenter, answered it; CEUM, its co-presenter, sees
    // it in its news.
    position: {
      position: "accept",
      comment: "Asumimos la ratio de 1.500 estudiantes.",
      at: ago(20),
    },
  });
  const confidentiality = amendment({
    document: "mentalHealth",
    kind: "partial",
    authors: ["UGR"],
    ops: [
      {
        op: "insert",
        afterBlockId: mentalHealth[5]!.id,
        blocks: buildBlocks(
          [
            listItem(
              "Garantizar la confidencialidad de las consultas y su compatibilidad con el horario lectivo.",
              "ordered",
            ),
          ],
          newId,
        ),
      },
    ],
    justification:
      "Sin confidencialidad ni horarios compatibles, muchos estudiantes no acuden al servicio aunque exista.",
    submittedAt: ago(3),
    late: true,
    // Validated and published by the Secretaría: everyone sees it "fuera de
    // plazo" until the assembly decides whether to treat it (admission).
    admission: "pending",
    validatedAt: ago(1),
    publishedAt: ago(1),
    position: null,
  });
  if (confidentiality.submittedAt <= mentalHealthWindow.closesAt) {
    throw new Error(
      "The demo late amendment must be submitted after its window closed",
    );
  }

  // The regulation incorporates what its presenter (PRES) accepts.
  const notice = amendment({
    document: "regulation",
    kind: "partial",
    authors: ["CEULE"],
    ops: editOps(
      regulation,
      2,
      "treinta días naturales",
      "cuarenta y cinco días naturales",
    ),
    justification:
      "Treinta días no bastan para que los consejos organicen el viaje y consulten a sus plenos.",
    submittedAt: ago(70),
    position: { position: "accept", comment: null, at: ago(22) },
    outcome: { status: "approved", at: ago(22), approvalMethod: "proponent" },
  });
  const publicationTerm = amendment({
    document: "regulation",
    kind: "partial",
    authors: ["UPV"],
    ops: editOps(regulation, 4, "quince días", "veinte días"),
    justification:
      "Veinte días permiten leer la documentación y preparar enmiendas con calma.",
    submittedAt: ago(44),
    position: null,
  });

  const amendments = [
    residenceFull,
    residenceReference,
    inclusiveLanguage,
    mobility,
    removeMasters,
    resolutionTerm,
    paymentDate,
    universities,
    decade,
    mastersReference,
    ratio,
    confidentiality,
    notice,
    publicationTerm,
  ];
  numberAmendments(amendments);

  const transactionalOps = editOps(
    positioning,
    7,
    "el coste medio",
    "íntegramente el precio de referencia",
  );
  // T1: CEUM proposes it with CAUB (CEUM is its main author). CEUM accepts
  // it on creation as main author of CEUM 1, CAUB accepts it, the Secretaría
  // validates it and it replaces both: from then on it waits for VPU's answer.
  const transactional: DemoTransactional = {
    id: newId(),
    document: "positioning",
    kind: "transactional",
    authors: ["CEUM", "CAUB"],
    ops: transactionalOps,
    justification:
      "Transaccional de CEUM 1 y CAUB 1: la cuantía cubre el alquiler completo, calculado con el precio de referencia.",
    submittedAt: ago(18),
    late: false,
    admission: "admitted",
    validatedAt: ago(16),
    publishedAt: ago(16),
    correction: null,
    position: null,
    number: null,
    memberSeq: null,
    code: "T1",
    positionKey: positionKey(transactionalOps, positioning),
    sourceIds: [residenceFull.id, residenceReference.id],
    acceptances: [
      { acronym: "CEUM", decidedAt: ago(18) },
      { acronym: "CAUB", decidedAt: ago(17) },
    ],
  };
  assertValid(positioning, transactional);
  for (const source of [residenceFull, residenceReference]) {
    source.outcome = {
      status: "transacted",
      at: transactional.validatedAt!,
      transactionalId: transactional.id,
    };
  }

  // T2: CEULE, which wrote neither source, proposes merging the masters
  // paragraph into the general rule instead of UGR 1 (delete it) and CEUAM 2
  // (refer to it). Presented, it waits for UGR and CEUAM, their main authors.
  const memberTransactionalOps: AmendmentOp[] = [
    ...editOps(
      positioning,
      12,
      "con mayor tasa de suspensos.",
      "con mayor tasa de suspensos, también en los másteres habilitantes.",
    ),
    { op: "delete", blockIds: [positioning[13]!.id] },
  ];
  const memberTransactional: DemoTransactional = {
    id: newId(),
    document: "positioning",
    kind: "transactional",
    authors: ["CEULE"],
    ops: memberTransactionalOps,
    justification:
      "Transaccional de UGR 1 y CEUAM 2: los másteres habilitantes siguen la regla general y el párrafo propio desaparece.",
    submittedAt: ago(4),
    late: false,
    admission: "pending",
    validatedAt: null,
    publishedAt: null,
    correction: null,
    position: null,
    number: null,
    memberSeq: null,
    code: "T2",
    positionKey: positionKey(memberTransactionalOps, positioning),
    sourceIds: [removeMasters.id, mastersReference.id],
    acceptances: [
      { acronym: "UGR", decidedAt: null },
      { acronym: "CEUAM", decidedAt: null },
    ],
  };
  assertValid(positioning, memberTransactional);

  const overlaps = findOverlaps(
    [
      ...amendments.filter((item) => item.document === "positioning"),
      transactional,
      memberTransactional,
    ].map((item) => ({ id: item.id, ops: item.ops })),
  );
  // Two passages in debate: the residence allowance (CEUM 1, CAUB 1, T1)
  // and the masters paragraph (UGR 1, CEUAM 2, T2).
  const expected = [
    new Set([residenceFull.id, residenceReference.id, transactional.id]),
    new Set([removeMasters.id, mastersReference.id, memberTransactional.id]),
  ];
  const matches = (cluster: string[]) =>
    expected.some(
      (set) =>
        cluster.length === set.size && cluster.every((id) => set.has(id)),
    );
  if (
    overlaps.clusters.length !== expected.length ||
    !overlaps.clusters.every(matches)
  ) {
    throw new Error(`Unexpected demo overlaps: ${JSON.stringify(overlaps)}`);
  }

  const minutesAgo = (minutes: number) =>
    new Date(now.getTime() - minutes * 60_000);
  const speakingTurns: DemoSpeakingTurn[] = [
    {
      acronym: "VPU",
      speaker: null,
      status: "done",
      position: 0,
      createdAt: minutesAgo(30),
      startedAt: minutesAgo(25),
      endedAt: minutesAgo(15),
    },
    // Not in session yet, so nobody has the floor: the Mesa prepares the list.
    {
      acronym: "CEUM",
      speaker: "Marta Gil",
      status: "waiting",
      position: 0,
      createdAt: minutesAgo(20),
      startedAt: null,
      endedAt: null,
    },
    {
      acronym: "CAUB",
      speaker: null,
      status: "waiting",
      position: 1,
      createdAt: minutesAgo(12),
      startedAt: null,
      endedAt: null,
    },
    {
      acronym: "CEEM",
      speaker: "Javier Ruiz",
      status: "waiting",
      position: 2,
      createdAt: minutesAgo(8),
      startedAt: null,
      endedAt: null,
    },
  ];

  return {
    now,
    ago: {
      start: agoStart,
      end: new Date(agoStart.getTime() + 2 * DAY + 9 * HOUR),
      milestones: agoMilestones,
    },
    age: {
      start: ageStart,
      end: new Date(ageStart.getTime() + 8 * HOUR),
      milestones: defaultMilestones("AGE", ageStart),
    },
    positioning,
    mentalHealth,
    transport,
    regulation,
    mentalHealthWindow,
    amendments,
    transactional,
    memberTransactional,
    relation: {
      fromId: removeMasters.id,
      toId: mastersReference.id,
      note: "Si se suprime el párrafo sobre los másteres habilitantes, la remisión que introduce CEUAM 2 queda sin contenido.",
      at: ago(12),
    },
    speakingTurns,
    expectedReports: [
      {
        acronym: "VPU",
        title:
          "Informe de gestión de la Vicepresidencia de Política Universitaria",
        summary:
          "Actividad de la Vicepresidencia desde la última Asamblea General.",
        format: "structured",
        dueAt: atUtcHour(now, 3, 21),
      },
      {
        acronym: "PRES",
        title: "Informe de gestión de la Presidencia",
        summary:
          "Actividad de la Presidencia desde la última Asamblea General.",
        format: "file",
        dueAt: atUtcHour(now, -1, 21),
      },
    ],
  };
}

// Demo seeding (database) ---------------------------------------------------------

type EventRow = typeof schema.events.$inferInsert;

function referenceYear(at: Date): string {
  return new Intl.DateTimeFormat("en", {
    timeZone: "Europe/Madrid",
    year: "numeric",
  }).format(at);
}

/** Next free reference for the kind, numbered per prefix and year as on publication. */
async function nextReference(
  tx: Tx,
  kind: DocumentKind,
  at: Date,
): Promise<string | null> {
  const prefix = DOCUMENT_KIND_DEFAULTS[kind].referencePrefix;
  if (!prefix) return null;
  const year = referenceYear(at);
  const rows = await tx
    .select({ reference: schema.documents.reference })
    .from(schema.documents)
    .where(like(schema.documents.reference, `${prefix} %/${year}`));
  const pattern = new RegExp(`^${prefix} (\\d+)/${year}$`);
  const last = rows.reduce((max, row) => {
    const match = row.reference?.match(pattern);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `${prefix} ${String(last + 1).padStart(3, "0")}/${year}`;
}

async function upsertMembers(tx: Tx, now: Date): Promise<Map<string, string>> {
  await tx
    .insert(schema.members)
    .values(
      DEMO_MEMBERS.map((member) => ({
        ...member,
        active: true,
        syncedAt: member.source === "intranet" ? now : null,
      })),
    )
    .onConflictDoNothing({ target: schema.members.acronym });
  const rows = await tx
    .select({ id: schema.members.id, acronym: schema.members.acronym })
    .from(schema.members)
    .where(
      inArray(
        schema.members.acronym,
        DEMO_MEMBERS.map((member) => member.acronym),
      ),
    );
  const ids = new Map(rows.map((row) => [row.acronym, row.id]));
  for (const member of DEMO_MEMBERS) {
    if (!ids.has(member.acronym))
      throw new Error(`Demo member missing: ${member.acronym}`);
  }
  return ids;
}

async function insertAssembly(
  tx: Tx,
  input: {
    type: AssemblyType;
    number: number;
    status: "draft" | "convened";
    start: Date;
    end: Date;
    location: string;
    convocationIntro: string | null;
    agendaFinalizedAt: Date | null;
    milestones: Milestones;
    createdAt: Date;
  },
): Promise<string> {
  const id = createId();
  await tx.insert(schema.assemblies).values({
    id,
    type: input.type,
    number: input.number,
    status: input.status,
    startDate: input.start,
    endDate: input.end,
    location: input.location,
    convocationIntro: input.convocationIntro,
    agendaFinalizedAt: input.agendaFinalizedAt,
    settings: { ...DEFAULT_ASSEMBLY_SETTINGS },
    createdAt: input.createdAt,
  });
  const milestoneRows = MILESTONE_KEYS.flatMap((key) => {
    const at = input.milestones[key];
    return at ? [{ assemblyId: id, key, at }] : [];
  });
  if (milestoneRows.length > 0)
    await tx.insert(schema.assemblyMilestones).values(milestoneRows);
  return id;
}

interface AgendaSpec {
  title: string;
  description?: string;
  acceptsSubmissions?: boolean;
  children?: AgendaSpec[];
}

/** Inserts an agenda tree and returns the ids by title. */
async function insertAgenda(
  tx: Tx,
  assemblyId: string,
  specs: AgendaSpec[],
  parentId: string | null = null,
  ids = new Map<string, string>(),
): Promise<Map<string, string>> {
  for (const [order, spec] of specs.entries()) {
    const id = createId();
    await tx.insert(schema.agendaItems).values({
      id,
      assemblyId,
      parentId,
      title: spec.title,
      description: spec.description ?? null,
      acceptsSubmissions: spec.acceptsSubmissions ?? false,
      order,
    });
    ids.set(spec.title, id);
    if (spec.children)
      await insertAgenda(tx, assemblyId, spec.children, id, ids);
  }
  return ids;
}

async function insertStructuredDocument(
  tx: Tx,
  input: {
    assemblyId: string;
    agendaItemId: string;
    kind: DocumentKind;
    title: string;
    summary: string;
    proponentMemberId: string;
    /** Members presenting it with the main presenter. */
    coProponentMemberIds?: string[];
    blocks: Block[];
    submittedAt: Date;
    publishedAt: Date | null;
    window?: { opensAt: Date; closesAt: Date };
  },
): Promise<{
  id: string;
  baseVersionId: string | null;
  reference: string | null;
}> {
  const id = createId();
  const defaults = DOCUMENT_KIND_DEFAULTS[input.kind];
  const published = input.publishedAt !== null;
  const reference = published
    ? await nextReference(tx, input.kind, input.publishedAt!)
    : null;
  await tx.insert(schema.documents).values({
    id,
    assemblyId: input.assemblyId,
    agendaItemId: input.agendaItemId,
    slug: slugify(input.title) || id,
    kind: input.kind,
    format: "structured",
    title: input.title,
    summary: input.summary,
    reference,
    status: published ? "published" : "submitted",
    proponentMemberId: input.proponentMemberId,
    amendable: defaults.amendable,
    acceptedAmendments: defaults.acceptedAmendments,
    voted: defaults.voted,
    majority: defaults.majority,
    amendmentsOpenAt: input.window?.opensAt ?? null,
    amendmentsCloseAt: input.window?.closesAt ?? null,
    submittedAt: input.submittedAt,
    publishedAt: input.publishedAt,
    createdAt: new Date(input.submittedAt.getTime() - DAY),
  });
  if (input.coProponentMemberIds?.length) {
    await tx.insert(schema.documentProponents).values(
      input.coProponentMemberIds.map((memberId) => ({
        documentId: id,
        memberId,
      })),
    );
  }

  const contentHash = await hashContent(JSON.stringify(input.blocks));
  const workingVersionId = createId();
  await tx.insert(schema.documentVersions).values({
    id: workingVersionId,
    documentId: id,
    number: 1,
    kind: "draft",
    blocks: input.blocks,
    contentHash,
    createdAt: new Date(input.submittedAt.getTime() - DAY),
  });
  let baseVersionId: string | null = null;
  if (published) {
    baseVersionId = createId();
    await tx.insert(schema.documentVersions).values({
      id: baseVersionId,
      documentId: id,
      number: 2,
      kind: "base",
      blocks: input.blocks,
      contentHash,
      note: "Texto base publicado",
      createdAt: input.publishedAt!,
    });
  }
  await tx
    .update(schema.documents)
    .set({ workingVersionId, baseVersionId })
    .where(eq(schema.documents.id, id));
  return { id, baseVersionId, reference };
}

/**
 * A document the Secretaría expects from a member: an empty draft with an
 * internal deadline (`dueAt`) that the member fills in and presents.
 */
async function insertExpectedDocument(
  tx: Tx,
  input: {
    assemblyId: string;
    agendaItemId: string;
    proponentMemberId: string;
    title: string;
    summary: string;
    format: "structured" | "file";
    dueAt: Date;
    createdAt: Date;
  },
): Promise<string> {
  const id = createId();
  const defaults = DOCUMENT_KIND_DEFAULTS.executive_report;
  const structured = input.format === "structured";
  await tx.insert(schema.documents).values({
    id,
    assemblyId: input.assemblyId,
    agendaItemId: input.agendaItemId,
    slug: slugify(input.title) || id,
    kind: "executive_report",
    format: input.format,
    title: input.title,
    summary: input.summary,
    status: "draft",
    proponentMemberId: input.proponentMemberId,
    amendable: structured && defaults.amendable,
    acceptedAmendments: defaults.acceptedAmendments,
    voted: defaults.voted,
    majority: defaults.majority,
    dueAt: input.dueAt,
    createdAt: input.createdAt,
  });
  if (structured) {
    const workingVersionId = createId();
    await tx.insert(schema.documentVersions).values({
      id: workingVersionId,
      documentId: id,
      number: 1,
      kind: "draft",
      blocks: [],
      contentHash: await hashContent(JSON.stringify([])),
      createdAt: input.createdAt,
    });
    await tx
      .update(schema.documents)
      .set({ workingVersionId })
      .where(eq(schema.documents.id, id));
  }
  return id;
}

async function seedDemo(db: Db, content: DemoContent): Promise<void> {
  const existing = await db.query.assemblies.findFirst({
    where: and(
      eq(schema.assemblies.type, "AGO"),
      eq(schema.assemblies.number, 80),
    ),
    columns: { id: true },
  });
  if (existing) {
    console.log("Demo data skipped: the 80.ª AGO already exists.");
    return;
  }

  await db.transaction(async (tx) => {
    const { now } = content;
    const memberIds = await upsertMembers(tx, now);
    const member = (acronym: string) => memberIds.get(acronym)!;
    const events: EventRow[] = [];

    // 80.ª AGO, convened, amendment window open ------------------------------
    const agoMilestones = content.ago.milestones;
    const convocation = agoMilestones.convocation!;
    const agendaFinal = agoMilestones.agenda_final!;
    const publication = agoMilestones.documents_publish!;
    const agoId = await insertAssembly(tx, {
      type: "AGO",
      number: 80,
      status: "convened",
      start: content.ago.start,
      end: content.ago.end,
      location: "Universidad de Murcia, Campus de Espinardo",
      convocationIntro:
        "Por la presente, y a petición de la Presidencia, se convoca a todos los miembros de CREUP a la 80.ª Asamblea General Ordinaria, que se celebrará en la Universidad de Murcia en las fechas indicadas, con el orden del día que figura a continuación.\n\nLa documentación se publicará en la plataforma de asambleas, donde también se presentarán las enmiendas dentro de los plazos establecidos.",
      agendaFinalizedAt: agendaFinal,
      milestones: agoMilestones,
      createdAt: new Date(convocation.getTime() - DAY),
    });
    const assemblyEvent = (
      type: string,
      at: Date,
      payload: Record<string, unknown> = {},
    ) =>
      events.push({
        assemblyId: agoId,
        entityType: "assembly",
        entityId: agoId,
        type,
        payload,
        createdAt: at,
      });
    assemblyEvent("assembly_created", new Date(convocation.getTime() - DAY), {
      number: 80,
      type: "AGO",
      defaultCalendar: true,
    });
    assemblyEvent("assembly_status_changed", convocation, {
      from: "draft",
      to: "convened",
    });
    assemblyEvent("agenda_finalized", agendaFinal);

    const items = await insertAgenda(tx, agoId, [
      { title: "Aprobación de las actas de las asambleas anteriores" },
      { title: "Informes de la Comisión Ejecutiva y de los comités" },
      {
        title: "Posicionamientos",
        children: [
          {
            title:
              "Posicionamiento sobre el sistema de becas y ayudas al estudio",
          },
        ],
      },
      {
        title: "Reglamentos",
        children: [{ title: "Reforma del Reglamento de Régimen Interno" }],
      },
      {
        title: "Resoluciones",
        description:
          "Resoluciones presentadas por los miembros dentro de plazo.",
        acceptsSubmissions: true,
        children: [
          {
            title:
              "Resolución sobre la salud mental en las universidades públicas",
          },
          { title: "Resolución sobre el transporte público para estudiantes" },
        ],
      },
    ]);

    const positioning = await insertStructuredDocument(tx, {
      assemblyId: agoId,
      agendaItemId: items.get(
        "Posicionamiento sobre el sistema de becas y ayudas al estudio",
      )!,
      kind: "positioning",
      title: "Posicionamiento sobre el sistema de becas y ayudas al estudio",
      summary:
        "Propuesta de la Vicepresidencia de Política Universitaria para reformar umbrales, cuantías, requisitos y plazos del sistema estatal de becas.",
      proponentMemberId: member("VPU"),
      blocks: content.positioning,
      submittedAt: new Date(publication.getTime() - 6 * DAY),
      publishedAt: publication,
    });
    const mentalHealth = await insertStructuredDocument(tx, {
      assemblyId: agoId,
      agendaItemId: items.get(
        "Resolución sobre la salud mental en las universidades públicas",
      )!,
      kind: "resolution",
      title:
        "Resolución sobre la atención a la salud mental en las universidades públicas",
      summary:
        "Medidas para reforzar los servicios de atención psicológica de las universidades.",
      proponentMemberId: member("CEUAM"),
      // CEUM presents it too; CEUAM is the main presenter and answers.
      coProponentMemberIds: [member("CEUM")],
      blocks: content.mentalHealth,
      submittedAt: new Date(publication.getTime() - 4 * DAY),
      publishedAt: publication,
      window: content.mentalHealthWindow,
    });
    const regulation = await insertStructuredDocument(tx, {
      assemblyId: agoId,
      agendaItemId: items.get("Reforma del Reglamento de Régimen Interno")!,
      kind: "regulation",
      title: "Reforma del Reglamento de Régimen Interno",
      summary:
        "Propuesta de la Presidencia para actualizar los plazos de convocatoria, documentación y enmiendas.",
      proponentMemberId: member("PRES"),
      blocks: content.regulation,
      submittedAt: new Date(publication.getTime() - 5 * DAY),
      publishedAt: publication,
    });
    const transport = await insertStructuredDocument(tx, {
      assemblyId: agoId,
      agendaItemId: items.get(
        "Resolución sobre el transporte público para estudiantes",
      )!,
      kind: "resolution",
      title: "Resolución sobre el transporte público para estudiantes",
      summary: "Propuesta de un abono de transporte joven de ámbito estatal.",
      proponentMemberId: member("UPV"),
      blocks: content.transport,
      submittedAt: new Date(now.getTime() - 2 * DAY),
      publishedAt: null,
    });

    for (const [inserted, proponent] of [
      [positioning, "VPU"],
      [mentalHealth, "CEUAM"],
      [regulation, "PRES"],
      [transport, "UPV"],
    ] as const) {
      const row = await tx.query.documents.findFirst({
        where: eq(schema.documents.id, inserted.id),
      });
      const base = {
        assemblyId: agoId,
        entityType: "document",
        entityId: inserted.id,
      };
      events.push({
        ...base,
        type: "document_created",
        payload: {
          documentId: inserted.id,
          title: row!.title,
          kind: row!.kind,
          format: "structured",
          proponentMemberId: member(proponent),
          ...(inserted === mentalHealth
            ? { coProponentMemberIds: [member("CEUM")] }
            : {}),
          acceptedAmendments: row!.acceptedAmendments,
        },
        actorMemberId: member(proponent),
        createdAt: row!.createdAt,
      });
      events.push({
        ...base,
        type: "document_submitted",
        payload: {},
        actorMemberId: member(proponent),
        createdAt: row!.submittedAt!,
      });
      if (row!.publishedAt) {
        events.push({
          ...base,
          type: "document_published",
          payload: {
            reference: inserted.reference,
            baseVersionId: inserted.baseVersionId,
          },
          createdAt: row!.publishedAt,
        });
      }
    }

    // Expected CEA reports: empty drafts the Secretaría created with a deadline.
    const reportsItem = items.get(
      "Informes de la Comisión Ejecutiva y de los comités",
    )!;
    for (const report of content.expectedReports) {
      const createdAt = new Date(agendaFinal.getTime() + HOUR);
      const id = await insertExpectedDocument(tx, {
        assemblyId: agoId,
        agendaItemId: reportsItem,
        proponentMemberId: member(report.acronym),
        title: report.title,
        summary: report.summary,
        format: report.format,
        dueAt: report.dueAt,
        createdAt,
      });
      events.push({
        assemblyId: agoId,
        entityType: "document",
        entityId: id,
        type: "document_created",
        payload: {
          documentId: id,
          title: report.title,
          kind: "executive_report",
          format: report.format,
          agendaItemId: reportsItem,
          proponentMemberId: member(report.acronym),
          dueAt: report.dueAt.toISOString(),
        },
        createdAt,
      });
    }

    // Amendments ---------------------------------------------------------------
    const documentOf = { positioning, mentalHealth, regulation } as const;
    const proponentOf = {
      positioning: "VPU",
      mentalHealth: "CEUAM",
      regulation: "PRES",
    } as const;

    const transactionals = [content.transactional, content.memberTransactional];
    for (const item of [...content.amendments, ...transactionals]) {
      const document = documentOf[item.document];
      const sourceIds = "sourceIds" in item ? item.sourceIds : null;
      // T2 waits for the main authors of what it replaces before the Secretaría.
      const awaitsAuthors =
        sourceIds !== null && item.validatedAt === null && !item.correction;
      const authorIds = item.authors.map(member);
      const createdAt = new Date(item.submittedAt.getTime() - HOUR);
      // Same shape as submitAmendment: the presenting member drives memberSeq and the code.
      const meta: AmendmentMeta & { presentingMemberId?: string } = {
        presentingMemberId: authorIds[0],
        ...(item.globalReplace ? { globalReplace: item.globalReplace } : {}),
      };
      // Sent back for correction: a draft again, keeping its number and code.
      const { correction, outcome } = item;
      await tx.insert(schema.amendments).values({
        id: item.id,
        documentId: document.id,
        baseVersionId: document.baseVersionId!,
        number: item.number,
        memberSeq: item.memberSeq,
        code: item.code,
        kind: item.kind,
        status: correction ? "draft" : (outcome?.status ?? "submitted"),
        approvalMethod:
          outcome?.status === "approved" ? outcome.approvalMethod : null,
        decidedAt: outcome?.at ?? null,
        admission: item.admission,
        late: item.late,
        ops: item.ops,
        meta,
        justification: item.justification,
        positionKey: item.positionKey,
        submittedAt: correction ? null : item.submittedAt,
        validatedAt: item.validatedAt,
        publishedAt: item.publishedAt,
        correctionNote: correction?.note ?? null,
        correctionRequestedAt: correction?.at ?? null,
        createdAt,
      });
      await tx
        .insert(schema.amendmentAuthors)
        .values(
          authorIds.map((memberId) => ({ amendmentId: item.id, memberId })),
        );
      await tx.insert(schema.amendmentPositions).values({
        amendmentId: item.id,
        position: item.position?.position ?? "pending",
        comment: item.position?.comment ?? null,
        updatedAt: item.position?.at ?? item.submittedAt,
      });

      const base = {
        assemblyId: agoId,
        entityType: "amendment",
        entityId: item.id,
      };
      events.push({
        ...base,
        type: "amendment_created",
        payload: {
          kind: item.kind,
          authorMemberIds: authorIds,
          ...(sourceIds ? { code: item.code, sourceIds } : {}),
        },
        actorMemberId: authorIds[0],
        createdAt,
      });
      events.push({
        ...base,
        type: "amendment_submitted",
        // Presenting never admits: the Secretaría's validation does.
        payload: {
          ...(item.number !== null ? { number: item.number } : {}),
          code: item.code,
          late: item.late,
          admission: "pending",
          ...(awaitsAuthors ? { awaitsAuthors: true } : {}),
        },
        actorMemberId: authorIds[0],
        createdAt: item.submittedAt,
      });
      if (correction) {
        events.push({
          ...base,
          type: "amendment_correction_requested",
          payload: { note: correction.note },
          createdAt: correction.at,
        });
      }
      if (item.validatedAt) {
        const publishedAtOnce =
          item.publishedAt?.getTime() === item.validatedAt.getTime();
        events.push({
          ...base,
          type: "amendment_validated",
          payload: {
            publish: publishedAtOnce,
            admission: item.admission,
            ...(item.admission === "admitted" ? { method: "secretaria" } : {}),
          },
          createdAt: item.validatedAt,
        });
        if (item.publishedAt && !publishedAtOnce) {
          events.push({
            ...base,
            type: "amendment_published",
            payload: {},
            createdAt: item.publishedAt,
          });
        }
      }
      if (item.position) {
        events.push({
          ...base,
          type: "position_changed",
          payload: {
            position: item.position.position,
            by: "proponent",
            memberId: member(proponentOf[item.document]),
          },
          actorMemberId: member(proponentOf[item.document]),
          createdAt: item.position.at,
        });
      }
      if (outcome?.status === "approved") {
        // Accepted by the presenter of a regulation: incorporated at once.
        events.push({
          ...base,
          type: "amendment_approved",
          // Whose acceptance incorporated it, as setAmendmentPosition says.
          payload: {
            method: outcome.approvalMethod,
            byPosition: true,
            memberId: member(proponentOf[item.document]),
          },
          actorMemberId: member(proponentOf[item.document]),
          createdAt: outcome.at,
        });
      }
      if (outcome?.status === "transacted") {
        const by = transactionals.find(
          (candidate) => candidate.id === outcome.transactionalId,
        )!;
        events.push({
          ...base,
          type: "amendment_transacted",
          payload: { transactionalId: by.id, code: by.code },
          createdAt: outcome.at,
        });
      }
    }

    for (const transactional of transactionals) {
      await tx.insert(schema.amendmentSources).values(
        transactional.sourceIds.map((sourceId) => ({
          transactionalId: transactional.id,
          sourceId,
        })),
      );
      await tx.insert(schema.amendmentAcceptances).values(
        transactional.acceptances.map((party) => ({
          amendmentId: transactional.id,
          memberId: member(party.acronym),
          role: "author" as const,
          decision: party.decidedAt
            ? ("accepted" as const)
            : ("pending" as const),
          decidedAt: party.decidedAt,
        })),
      );
      for (const party of transactional.acceptances) {
        // The creator's acceptance is implicit; later answers are recorded.
        if (!party.decidedAt || party.acronym === transactional.authors[0])
          continue;
        events.push({
          assemblyId: agoId,
          entityType: "amendment",
          entityId: transactional.id,
          type: "acceptance_recorded",
          payload: {
            memberId: member(party.acronym),
            role: "author",
            decision: "accepted",
          },
          actorMemberId: member(party.acronym),
          createdAt: party.decidedAt,
        });
      }
    }

    const relationId = createId();
    const { relation } = content;
    await tx.insert(schema.amendmentRelations).values({
      id: relationId,
      fromId: relation.fromId,
      toId: relation.toId,
      kind: "incompatible",
      note: relation.note,
      createdAt: relation.at,
    });
    for (const [entityId, otherId, direction] of [
      [relation.fromId, relation.toId, "from"],
      [relation.toId, relation.fromId, "to"],
    ] as const) {
      events.push({
        assemblyId: agoId,
        entityType: "amendment",
        entityId,
        type: "relation_created",
        payload: { relationId, kind: "incompatible", otherId, direction },
        // Noted by the document's presenter, so the history says by whom.
        actorMemberId: member(proponentOf.positioning),
        createdAt: relation.at,
      });
    }

    // Speaking turns on the positioning's item. No live_state row: the
    // assembly is convened, not in session, so the list stays for the Mesa
    // (attendees see it only once a session makes it visible).
    const positioningItem = items.get(
      "Posicionamiento sobre el sistema de becas y ayudas al estudio",
    )!;
    for (const turn of content.speakingTurns) {
      const id = createId();
      await tx.insert(schema.speakingTurns).values({
        id,
        assemblyId: agoId,
        agendaItemId: positioningItem,
        memberId: member(turn.acronym),
        speaker: turn.speaker,
        status: turn.status,
        position: turn.position,
        startedAt: turn.startedAt,
        endedAt: turn.endedAt,
        createdAt: turn.createdAt,
        updatedAt: turn.endedAt ?? turn.startedAt ?? turn.createdAt,
      });
      events.push({
        assemblyId: agoId,
        entityType: "speakers",
        entityId: id,
        type: "speaking_turn_added",
        payload: {
          memberId: member(turn.acronym),
          agendaItemId: positioningItem,
          position: turn.position,
        },
        createdAt: turn.createdAt,
      });
    }

    // 35.ª AGE, still a draft ------------------------------------------------------
    const age = await tx.query.assemblies.findFirst({
      where: and(
        eq(schema.assemblies.type, "AGE"),
        eq(schema.assemblies.number, 35),
      ),
      columns: { id: true },
    });
    if (!age) {
      const ageId = await insertAssembly(tx, {
        type: "AGE",
        number: 35,
        status: "draft",
        start: content.age.start,
        end: content.age.end,
        location: "Madrid",
        convocationIntro: null,
        agendaFinalizedAt: null,
        milestones: content.age.milestones,
        createdAt: now,
      });
      await insertAgenda(tx, ageId, [
        { title: "Ratificación de la urgencia" },
        { title: "Reforma de los Estatutos" },
      ]);
      events.push({
        assemblyId: ageId,
        entityType: "assembly",
        entityId: ageId,
        type: "assembly_created",
        payload: { number: 35, type: "AGE", defaultCalendar: true },
        createdAt: now,
      });
    }

    await tx.insert(schema.events).values(events);
    console.log(
      `  Demo: ${DEMO_MEMBERS.length} members, 80.ª AGO with ${content.amendments.length + transactionals.length} amendments, ${content.expectedReports.length} expected reports and ${content.speakingTurns.length} speaking turns, 35.ª AGE draft`,
    );
  });
}

// Entry point -------------------------------------------------------------------

async function main(): Promise<void> {
  const db = drizzle(
    requireConfigString(process.env.DATABASE_URL, "DATABASE_URL"),
    { schema },
  );
  try {
    await seedRbac(db);
    if (process.env.SEED_DEMO === "1") {
      console.log("Seeding demo data...");
      await seedDemo(db, buildDemoContent());
    }
    console.log("Seed complete.");
  } finally {
    await db.$client.end();
  }
}

/** True when run as `tsx drizzle/seed.ts`, false when imported (e.g. to check the demo content). */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalize = (path: string) => {
    const absolute = resolve(path).replace(/\.[cm]?[jt]s$/, "");
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  };
  return normalize(fileURLToPath(import.meta.url)) === normalize(entry);
}

if (isEntryPoint()) {
  main().catch((error) => {
    console.error("Seed failed:", error);
    process.exit(1);
  });
}
