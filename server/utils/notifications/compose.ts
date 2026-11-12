import { eq, inArray } from "drizzle-orm";
import esMessages from "../../../i18n/locales/es.json";
import { db } from "../../db";
import { assemblies, documents, members } from "../../db/schema";
import {
  canManageDocuments,
  canReviewAmendments,
  type Actor,
} from "../domain/actor";
import {
  canSeeLoadedAmendment,
  findAmendmentsByIds,
  loadedMainAuthor,
  type LoadedAmendment,
} from "../domain/amendments";
import { loadCoProponentIds } from "../domain/presenters";
import {
  canSeeAssembly,
  canSeeDocument,
  visibleAcronym,
} from "../domain/visibility";
import { formatExportDateTime } from "../export/labels";
import type {
  EmailSkipReason,
  NotificationKind,
} from "~~/shared/constants/notifications";
import { buildAssemblySlug, formatAssemblyLabel } from "~~/shared/utils/slug";
import type { NotifyingEvent } from "./plan";
import type { EmailDetail, EmailNotice } from "./template";

/**
 * What one notice says to one account (docs/design.md, "Email
 * notifications"). It is composed when the email goes, as that account
 * sees things then: the same visibility rules as the platform
 * (canSeeAssembly, canSeeDocument, canSeeLoadedAmendment) and the
 * executive offices as "CEA" for whoever may not see them
 * (visibleAcronym). Never the text of a document or an amendment: the code,
 * the title, who presents it and a link. Spanish only.
 */

export type ComposeResult =
  { notice: EmailNotice; reason: string } | { skip: EmailSkipReason };

const AMENDMENT_KIND_LABELS = (
  esMessages as { amendment: { kinds: Record<string, string> } }
).amendment.kinds;

interface MemberLite {
  id: string;
  acronym: string;
  kind: string;
}

interface Context {
  actor: Actor;
  event: NotifyingEvent;
  origin: string;
  assembly: {
    id: string;
    number: number;
    type: string;
    status: (typeof assemblies.$inferSelect)["status"];
  };
  document: typeof documents.$inferSelect & {
    coProponentMemberIds: string[];
  };
  amendment: LoadedAmendment | null;
  members: Map<string, MemberLite>;
  /** Codes of what a transactional groups, only those the account sees. */
  sourceCodes: Map<string, string>;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function quoted(title: string): string {
  return `«${title}»`;
}

function acronyms(ctx: Context, ids: readonly string[]): string {
  const names = [
    ...new Set(
      ids
        .map((id) => ctx.members.get(id))
        .filter((member): member is MemberLite => Boolean(member))
        .map((member) =>
          visibleAcronym(ctx.actor, {
            acronym: member.acronym,
            kind: member.kind as never,
          }),
        ),
    ),
  ];
  return names.join(", ");
}

function code(amendment: { code: string | null }): string {
  return amendment.code ?? "sin número";
}

function documentPresenterIds(ctx: Context): string[] {
  return [
    ...(ctx.document.proponentMemberId ? [ctx.document.proponentMemberId] : []),
    ...ctx.document.coProponentMemberIds,
  ];
}

function amendmentAuthorIds(amendment: LoadedAmendment): string[] {
  const main = loadedMainAuthor(amendment);
  const ids = amendment.authors.map((author) => author.memberId);
  return main ? [main, ...ids.filter((id) => id !== main)] : ids;
}

function base(ctx: Context): {
  assemblyPath: string;
  documentPath: string;
  details: EmailDetail[];
} {
  const assemblyPath = `${ctx.origin}/asambleas/${buildAssemblySlug(ctx.assembly)}`;
  return {
    assemblyPath,
    documentPath: `${assemblyPath}/documentos/${encodeURIComponent(ctx.document.slug)}`,
    details: [
      { label: "Asamblea", value: formatAssemblyLabel(ctx.assembly) },
      { label: "Documento", value: ctx.document.title },
    ],
  };
}

function amendmentLink(documentPath: string, amendment: { id: string }) {
  return `${documentPath}?enmienda=${encodeURIComponent(amendment.id)}`;
}

function amendmentDetails(
  ctx: Context,
  amendment: LoadedAmendment,
): EmailDetail[] {
  const details: EmailDetail[] = [
    { label: "Enmienda", value: code(amendment) },
    {
      label: amendment.authors.length > 1 ? "Presentan" : "Presenta",
      value: acronyms(ctx, amendmentAuthorIds(amendment)),
    },
  ];
  if (amendment.kind !== "transactional") {
    details.push({
      label: "Tipo",
      value: AMENDMENT_KIND_LABELS[amendment.kind] ?? amendment.kind,
    });
  } else if (amendment.sources.length > 0) {
    details.push({
      label: "Agrupa",
      value: amendment.sources
        .map((source) => ctx.sourceCodes.get(source.sourceId) ?? "sin número")
        .join(", "),
    });
  }
  return details;
}

/** Where a notice about submissions points: the inbox, for who reviews. */
function reviewLink(ctx: Context, paths: ReturnType<typeof base>): string {
  return canReviewAmendments(ctx.actor) || canManageDocuments(ctx.actor)
    ? `${paths.assemblyPath}/validacion`
    : ctx.amendment
      ? amendmentLink(paths.documentPath, ctx.amendment)
      : paths.documentPath;
}

function deadline(date: Date | null): string | null {
  return date ? formatExportDateTime(date, "es") : null;
}

type Composer = (ctx: Context) => Omit<EmailNotice, "tag"> | null;

const COMPOSERS: Record<NotificationKind, Composer> = {
  document_submitted(ctx) {
    const paths = base(ctx);
    const by = acronyms(ctx, documentPresenterIds(ctx));
    return {
      subject: `Documento enviado a validar: ${quoted(ctx.document.title)}`,
      heading: "Nuevo documento para validar",
      lead: by
        ? `${by} ha enviado el documento ${quoted(ctx.document.title)} a la Secretaría.`
        : `Se ha enviado el documento ${quoted(ctx.document.title)} a la Secretaría.`,
      details: [
        ...paths.details,
        ...(by ? [{ label: "Presenta", value: by }] : []),
        ...(ctx.event.payload.afterCorrection === true
          ? [{ label: "Envío", value: "Tras una corrección" }]
          : []),
      ],
      note: null,
      action: {
        label: "Revisar en la plataforma",
        url: reviewLink(ctx, paths),
      },
    };
  },

  amendment_submitted(ctx) {
    const amendment = ctx.amendment;
    if (!amendment) return null;
    const paths = base(ctx);
    const by = acronyms(ctx, amendmentAuthorIds(amendment));
    const details = [...paths.details, ...amendmentDetails(ctx, amendment)];
    if (amendment.late) {
      details.push({
        label: "Plazo",
        value:
          "Fuera de plazo: tras validarla, la asamblea decide si la admite",
      });
    }
    if (ctx.event.payload.afterCorrection === true) {
      details.push({ label: "Envío", value: "Tras una corrección" });
    }
    return {
      subject: `Enmienda presentada al documento ${quoted(ctx.document.title)}`,
      heading: "Nueva enmienda para validar",
      lead: `${by} ha presentado una enmienda al documento ${quoted(ctx.document.title)}.`,
      details,
      note: null,
      action: {
        label: "Revisar en la plataforma",
        url: reviewLink(ctx, paths),
      },
    };
  },

  transactional_ready(ctx) {
    const amendment = ctx.amendment;
    if (!amendment) return null;
    const paths = base(ctx);
    const by = acronyms(ctx, amendmentAuthorIds(amendment));
    return {
      subject: `Transaccional lista para validar: ${quoted(ctx.document.title)}`,
      heading: "Transaccional lista para validar",
      lead: `Todas las partes han aceptado la transaccional que propone ${by} al documento ${quoted(ctx.document.title)}. Ya puede validarse.`,
      details: [...paths.details, ...amendmentDetails(ctx, amendment)],
      note: null,
      action: {
        label: "Revisar en la plataforma",
        url: reviewLink(ctx, paths),
      },
    };
  },

  submission_validated(ctx) {
    const paths = base(ctx);
    const amendment = ctx.amendment;
    if (!amendment) {
      const by = acronyms(ctx, documentPresenterIds(ctx));
      return {
        subject: `Documento publicado: ${quoted(ctx.document.title)}`,
        heading: "Documento validado",
        lead: by
          ? `La Secretaría ha validado y publicado el documento ${quoted(ctx.document.title)}, que presenta ${by}.`
          : `La Secretaría ha validado y publicado el documento ${quoted(ctx.document.title)}.`,
        details: [
          ...paths.details,
          ...(by ? [{ label: "Presenta", value: by }] : []),
        ],
        note: null,
        action: { label: "Ver el documento", url: paths.documentPath },
      };
    }
    const details = [...paths.details, ...amendmentDetails(ctx, amendment)];
    if (amendment.late && amendment.admission === "pending") {
      details.push({
        label: "Plazo",
        value: "Fuera de plazo: la Mesa debe recoger si la asamblea la admite",
      });
    }
    if (!amendment.publishedAt) {
      details.push({ label: "Publicada", value: "Todavía no" });
    }
    return {
      subject: `Enmienda validada al documento ${quoted(ctx.document.title)}`,
      heading:
        amendment.kind === "transactional"
          ? "Transaccional validada"
          : "Enmienda validada",
      lead: `La Secretaría ha validado la ${amendment.kind === "transactional" ? "transaccional" : "enmienda"} ${code(amendment)} al documento ${quoted(ctx.document.title)}.`,
      details,
      note: null,
      action: {
        label: "Ver la enmienda",
        url: amendmentLink(paths.documentPath, amendment),
      },
    };
  },

  transactional_acceptance_requested(ctx) {
    const amendment = ctx.amendment;
    if (!amendment) return null;
    const paths = base(ctx);
    const by = acronyms(ctx, amendmentAuthorIds(amendment));
    return {
      subject: `Transaccional pendiente de tu respuesta: ${quoted(ctx.document.title)}`,
      heading: "Te piden aceptar una transaccional",
      lead: `${by} propone una transaccional al documento ${quoted(ctx.document.title)} que sustituiría a tu enmienda. Solo sigue adelante si todas las partes la aceptan.`,
      details: [
        ...paths.details,
        { label: "Propone", value: by },
        ...amendmentDetails(ctx, amendment).filter(
          (detail) => detail.label === "Agrupa",
        ),
      ],
      note: null,
      action: {
        label: "Responder en la plataforma",
        url: amendmentLink(paths.documentPath, amendment),
      },
    };
  },

  presenter_assigned(ctx) {
    const paths = base(ctx);
    const own = ctx.actor.memberId;
    const member = own ? ctx.members.get(own) : undefined;
    const name = member?.acronym ?? "tu miembro";
    const main = own !== null && ctx.document.proponentMemberId === own;
    const due = deadline(ctx.document.dueAt);
    return {
      subject: `Documento asignado: ${quoted(ctx.document.title)}`,
      heading: "Te han asignado un documento",
      lead: main
        ? `Se ha asignado a ${name} el documento ${quoted(ctx.document.title)}.`
        : `Se ha añadido a ${name} como copresentador del documento ${quoted(ctx.document.title)}.`,
      details: [
        ...paths.details,
        ...(due ? [{ label: "Plazo interno", value: due }] : []),
      ],
      note: null,
      action:
        ctx.document.status === "draft"
          ? {
              label: "Preparar el documento",
              url: `${paths.documentPath}/editar`,
            }
          : { label: "Ver el documento", url: paths.documentPath },
    };
  },

  presenter_correction(ctx) {
    const paths = base(ctx);
    const note = text(ctx.event.payload.note);
    const amendment = ctx.amendment;
    return {
      subject: amendment
        ? `Corrección pedida en tu enmienda al documento ${quoted(ctx.document.title)}`
        : `Corrección pedida: ${quoted(ctx.document.title)}`,
      heading: "Te piden una corrección",
      lead: amendment
        ? `La Secretaría ha devuelto tu enmienda ${code(amendment)} al documento ${quoted(ctx.document.title)} para que la corrijas.`
        : `La Secretaría ha devuelto el documento ${quoted(ctx.document.title)} para que lo corrijas.`,
      details: [
        ...paths.details,
        ...(amendment ? amendmentDetails(ctx, amendment) : []),
      ],
      note: note ? { label: "Nota de la Secretaría", text: note } : null,
      action: amendment
        ? {
            label: "Corregir la enmienda",
            url: amendmentLink(paths.documentPath, amendment),
          }
        : {
            label: "Corregir el documento",
            url: `${paths.documentPath}/editar`,
          },
    };
  },

  presenter_validated(ctx) {
    const paths = base(ctx);
    const amendment = ctx.amendment;
    if (!amendment) {
      return {
        subject: `Documento publicado: ${quoted(ctx.document.title)}`,
        heading: "Tu documento está publicado",
        lead: `La Secretaría ha validado y publicado tu documento ${quoted(ctx.document.title)}.`,
        details: paths.details,
        note: null,
        action: { label: "Ver el documento", url: paths.documentPath },
      };
    }
    let lead: string;
    if (ctx.event.type === "amendment_admitted") {
      lead = `La asamblea ha admitido tu enmienda ${code(amendment)} al documento ${quoted(ctx.document.title)}, presentada fuera de plazo.`;
    } else {
      lead = `La Secretaría ha validado tu ${amendment.kind === "transactional" ? "transaccional" : "enmienda"} ${code(amendment)} al documento ${quoted(ctx.document.title)}.`;
      if (amendment.late && amendment.admission === "pending") {
        lead += " Al estar fuera de plazo, la asamblea decidirá si la admite.";
      } else if (amendment.publishedAt) {
        lead += " Ya es pública.";
      }
    }
    return {
      subject: `Enmienda validada al documento ${quoted(ctx.document.title)}`,
      heading:
        ctx.event.type === "amendment_admitted"
          ? "Tu enmienda está admitida"
          : "Tu enmienda está validada",
      lead,
      details: [...paths.details, ...amendmentDetails(ctx, amendment)],
      note: null,
      action: {
        label: "Ver la enmienda",
        url: amendmentLink(paths.documentPath, amendment),
      },
    };
  },

  presenter_decided(ctx) {
    const paths = base(ctx);
    const amendment = ctx.amendment;
    const payload = ctx.event.payload;
    if (!amendment) {
      const result = payload.result;
      const lead =
        result === "approved"
          ? `La asamblea ha aprobado tu documento ${quoted(ctx.document.title)}.`
          : result === "rejected"
            ? `La asamblea ha rechazado tu documento ${quoted(ctx.document.title)}.`
            : `La asamblea ha votado tu documento ${quoted(ctx.document.title)}.`;
      return {
        subject: `Votación de tu documento: ${quoted(ctx.document.title)}`,
        heading: "Tu documento se ha votado",
        lead,
        details: paths.details,
        note: null,
        action: { label: "Ver el documento", url: paths.documentPath },
      };
    }
    const c = code(amendment);
    const of = `al documento ${quoted(ctx.document.title)}`;
    let heading = "Tu enmienda se ha resuelto";
    let lead: string;
    switch (ctx.event.type) {
      case "amendment_approved":
        heading = "Tu enmienda está aprobada";
        lead =
          payload.method === "proponent"
            ? `Quien presenta el documento ha aceptado tu enmienda ${c} ${of}, que queda incorporada al texto.`
            : `La asamblea ha aprobado tu enmienda ${c} ${of}.`;
        break;
      case "amendment_rejected":
        heading = "Tu enmienda está rechazada";
        lead = `La asamblea ha rechazado tu enmienda ${c} ${of}.`;
        break;
      case "amendment_inadmissible":
        heading = "Tu enmienda no se ha admitido";
        lead = `Tu enmienda ${c} ${of} no ha sido admitida.`;
        break;
      case "amendment_transacted":
        heading = "Tu enmienda está transada";
        lead = `Tu enmienda ${c} ${of} queda sustituida por la transaccional ${text(payload.code) ?? "aceptada"}.`;
        break;
      case "amendment_lapsed":
        heading = "Tu enmienda ha decaído";
        lead =
          payload.reason === "sources_transacted"
            ? `Tu transaccional ${c} ${of} ha decaído: otra transaccional sustituye ya a las enmiendas que agrupaba.`
            : `Tu enmienda ${c} ${of} ha decaído.`;
        break;
      case "amendment_withdrawn":
        if (payload.by === "sources_closed") {
          heading = "Transaccional cerrada";
          lead = `La transaccional ${c} ${of} se ha cerrado porque las enmiendas que agrupaba ya se han resuelto.`;
        } else if (payload.by === "author_rejection") {
          heading = "Transaccional cerrada";
          lead = `La transaccional ${c} ${of} se ha cerrado porque una de las partes la ha rechazado.`;
        } else {
          heading = "Tu enmienda se ha retirado";
          lead = `Se ha retirado tu enmienda ${c} ${of}.`;
        }
        break;
      default:
        lead = `Tu enmienda ${c} ${of} se ha resuelto.`;
    }
    return {
      subject: `${heading}: ${quoted(ctx.document.title)}`,
      heading,
      lead,
      details: [...paths.details, ...amendmentDetails(ctx, amendment)],
      note: text(payload.outcomeNote)
        ? { label: "Nota", text: text(payload.outcomeNote)! }
        : null,
      action: {
        label: "Ver la enmienda",
        url: amendmentLink(paths.documentPath, amendment),
      },
    };
  },

  presenter_changed(ctx) {
    const paths = base(ctx);
    const amendment = ctx.amendment;
    const payload = ctx.event.payload;
    if (!amendment) {
      const due = deadline(ctx.document.dueAt);
      return {
        subject: `Nuevo plazo interno: ${quoted(ctx.document.title)}`,
        heading: "Ha cambiado el plazo de tu documento",
        lead: due
          ? `El plazo interno de tu documento ${quoted(ctx.document.title)} es ahora el ${due}.`
          : `Tu documento ${quoted(ctx.document.title)} ya no tiene plazo interno.`,
        details: paths.details,
        note: null,
        action:
          ctx.document.status === "draft"
            ? {
                label: "Preparar el documento",
                url: `${paths.documentPath}/editar`,
              }
            : { label: "Ver el documento", url: paths.documentPath },
      };
    }
    const c = code(amendment);
    let heading: string;
    let lead: string;
    if (ctx.event.type === "amendment_reclassified") {
      const from = AMENDMENT_KIND_LABELS[String(payload.from)] ?? "";
      const to = AMENDMENT_KIND_LABELS[String(payload.to)] ?? "";
      heading = "Ha cambiado el tipo de tu enmienda";
      lead =
        from && to
          ? `La Secretaría ha cambiado el tipo de tu enmienda ${c} al documento ${quoted(ctx.document.title)}: de «${from}» a «${to}».`
          : `La Secretaría ha cambiado el tipo de tu enmienda ${c} al documento ${quoted(ctx.document.title)}.`;
    } else {
      heading = "Ha cambiado quién presenta tu enmienda";
      lead = `La Secretaría ha corregido quién presenta la enmienda ${c} al documento ${quoted(ctx.document.title)}.`;
    }
    return {
      subject: `${heading}: ${quoted(ctx.document.title)}`,
      heading,
      lead,
      details: [...paths.details, ...amendmentDetails(ctx, amendment)],
      note: null,
      action: {
        label: "Ver la enmienda",
        url: amendmentLink(paths.documentPath, amendment),
      },
    };
  },
};

/** Why the account gets it: the footer's sentence. */
function reasonFor(kind: NotificationKind, ctx: Context): string {
  if (
    kind === "document_submitted" ||
    kind === "amendment_submitted" ||
    kind === "transactional_ready" ||
    kind === "submission_validated"
  ) {
    const role = ctx.actor.user.role?.name;
    return role
      ? `Recibes este correo por tu rol en la plataforma (${role}).`
      : "Recibes este correo por tu rol en la plataforma.";
  }
  const own = ctx.actor.memberId ? ctx.members.get(ctx.actor.memberId) : null;
  return own
    ? `Recibes este correo porque tu cuenta actúa por ${own.acronym}.`
    : "Recibes este correo porque tu cuenta actúa por quien presenta.";
}

/**
 * The notice of one delivery for its account, or why it is not sent:
 * `gone` when what it was about no longer exists, `not_visible` when the
 * account may not see it now.
 */
export async function composeNotice(input: {
  kind: NotificationKind;
  event: NotifyingEvent;
  actor: Actor;
  origin: string;
}): Promise<ComposeResult> {
  const { event, actor } = input;
  let amendment: LoadedAmendment | null = null;
  let documentId: string;
  if (event.entityType === "amendment") {
    [amendment = null] = await findAmendmentsByIds([event.entityId]);
    if (!amendment) return { skip: "gone" };
    documentId = amendment.documentId;
  } else if (event.entityType === "document") {
    documentId = event.entityId;
  } else {
    return { skip: "gone" };
  }

  const [[assembly], [documentRow], coIds] = await Promise.all([
    db
      .select({
        id: assemblies.id,
        number: assemblies.number,
        type: assemblies.type,
        status: assemblies.status,
      })
      .from(assemblies)
      .where(eq(assemblies.id, event.assemblyId)),
    db.select().from(documents).where(eq(documents.id, documentId)),
    loadCoProponentIds([documentId]),
  ]);
  if (!assembly || !documentRow) return { skip: "gone" };
  const document = {
    ...documentRow,
    coProponentMemberIds: coIds.get(documentId) ?? [],
  };

  if (!canSeeAssembly(actor, assembly)) return { skip: "not_visible" };
  if (!canSeeDocument(actor, document)) return { skip: "not_visible" };
  if (amendment && !canSeeLoadedAmendment(actor, amendment)) {
    return { skip: "not_visible" };
  }

  const sourceIds = amendment?.sources.map((source) => source.sourceId) ?? [];
  const memberIds = new Set<string>([
    ...(document.proponentMemberId ? [document.proponentMemberId] : []),
    ...document.coProponentMemberIds,
    ...(amendment?.authors.map((author) => author.memberId) ?? []),
    ...(actor.memberId ? [actor.memberId] : []),
  ]);
  const [memberRows, sources] = await Promise.all([
    db
      .select({ id: members.id, acronym: members.acronym, kind: members.kind })
      .from(members)
      .where(inArray(members.id, [...memberIds])),
    sourceIds.length > 0 ? findAmendmentsByIds(sourceIds) : [],
  ]);

  const ctx: Context = {
    actor,
    event,
    origin: input.origin,
    assembly,
    document,
    amendment,
    members: new Map(memberRows.map((row) => [row.id, row])),
    sourceCodes: new Map(
      sources
        .filter((source) => canSeeLoadedAmendment(actor, source))
        .map((source) => [source.id, code(source)]),
    ),
  };
  const composed = COMPOSERS[input.kind](ctx);
  if (!composed) return { skip: "gone" };
  return {
    notice: { ...composed, tag: formatAssemblyLabel(assembly) },
    reason: reasonFor(input.kind, ctx),
  };
}
