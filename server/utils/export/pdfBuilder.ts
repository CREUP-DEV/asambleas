import type { TDocumentDefinitions, Content } from "pdfmake/interfaces";
import { formatAssemblyLabel } from "~~/shared/utils/slug";

const CREUP_RED = "#792225";
export type ExportLocale = "es" | "en";

interface AssemblyData {
  number: number;
  type: string;
  startDate: string;
  endDate: string;
  location: string;
}

interface AgendaItemData {
  numbering: string;
  title: string;
  documents: DocumentData[];
  children: AgendaItemData[];
}

interface DocumentData {
  title: string;
  type: string;
  content: string | null;
  amendments: AmendmentData[];
}

interface AmendmentData {
  status: string;
  type: string;
  authorName: string;
  justification: string;
}

export interface ExportData {
  assembly: AssemblyData;
  agendaItems: AgendaItemData[];
}

export interface DocumentExportData {
  assembly: AssemblyData;
  agendaItemTitle: string;
  document: DocumentData;
}

const EXPORT_LABELS = {
  es: {
    title: "Gestión de Asambleas",
    amendments: "Enmiendas",
    locationDateSeparator: "-",
    assemblyTypes: {
      AGO: "Asamblea General Ordinaria",
      AGE: "Asamblea General Extraordinaria",
      AGET: "Asamblea General Extraordinaria Telemática",
    },
    statuses: {
      draft: "Borrador",
      pending_review: "Pendiente de revisión",
      rejected_secretaria: "Rechazada por Secretaría",
      formal: "De forma",
      accepted_secretaria: "Validada por Secretaría",
      accepted_proponent: "Aceptada por proponente",
      rejected_proponent: "Rechazada por proponente",
      approved_vote: "Aprobada en votación",
      rejected_vote: "Rechazada en votación",
    },
    documentType: {
      platform: "Plataforma",
      pdf: "PDF",
    },
  },
  en: {
    title: "Assembly Management",
    amendments: "Amendments",
    locationDateSeparator: "-",
    assemblyTypes: {
      AGO: "Ordinary General Assembly",
      AGE: "Extraordinary General Assembly",
      AGET: "Online Extraordinary General Assembly",
    },
    statuses: {
      draft: "Draft",
      pending_review: "Pending review",
      rejected_secretaria: "Rejected by Secretariat",
      formal: "Formal",
      accepted_secretaria: "Validated by Secretariat",
      accepted_proponent: "Accepted by proponent",
      rejected_proponent: "Rejected by proponent",
      approved_vote: "Approved in vote",
      rejected_vote: "Rejected in vote",
    },
    documentType: {
      platform: "Platform",
      pdf: "PDF",
    },
  },
} as const;

function htmlToText(html: string | null): string {
  if (!html) return "";
  // Strip HTML tags for plain text PDF content
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .trim();
}

function getLabels(locale: ExportLocale) {
  return EXPORT_LABELS[locale];
}

function statusLabel(status: string, locale: ExportLocale) {
  const labels = getLabels(locale).statuses as Record<string, string>;
  return labels[status] ?? status;
}

function documentTypeLabel(type: string, locale: ExportLocale) {
  const labels = getLabels(locale).documentType as Record<string, string>;
  return labels[type] ?? type;
}

function assemblyTitle(assembly: AssemblyData, locale: ExportLocale) {
  const labels = getLabels(locale).assemblyTypes as Record<string, string>;
  const formatted = formatAssemblyLabel(assembly);
  return `${formatted} - ${labels[assembly.type] ?? assembly.type}`;
}

function buildDocumentContent(
  doc: DocumentData,
  locale: ExportLocale,
  marginLeft: number,
): Content[] {
  const content: Content[] = [
    {
      text: `${doc.title} (${documentTypeLabel(doc.type, locale)})`,
      style: "docTitle",
      margin: [marginLeft, 6, 0, 2],
    },
  ];

  if (doc.content) {
    content.push({
      text: htmlToText(doc.content),
      style: "body",
      margin: [marginLeft, 2, 0, 6],
    });
  }

  if (doc.amendments.length > 0) {
    content.push({
      text: `${getLabels(locale).amendments}:`,
      bold: true,
      fontSize: 10,
      margin: [marginLeft, 4, 0, 2],
    });

    for (const amendment of doc.amendments) {
      content.push({
        text: [
          {
            text: `[${statusLabel(amendment.status, locale)}] `,
            bold: true,
            fontSize: 9,
          },
          { text: `${amendment.authorName}: `, italics: true, fontSize: 9 },
          { text: amendment.justification, fontSize: 9 },
        ],
        margin: [marginLeft + 10, 1, 0, 1],
      });
    }
  }

  return content;
}

function buildAgendaContent(
  items: AgendaItemData[],
  locale: ExportLocale,
  depth = 0,
): Content[] {
  const content: Content[] = [];

  for (const item of items) {
    content.push({
      text: `${item.numbering} ${item.title}`,
      style: depth === 0 ? "h2" : "h3",
      margin: [depth * 10, depth === 0 ? 16 : 10, 0, 4],
    });

    for (const doc of item.documents) {
      content.push({
        text: doc.title,
        style: "docTitle",
        margin: [(depth + 1) * 10, 6, 0, 2],
      });

      content.push(...buildDocumentContent(doc, locale, (depth + 1) * 10));
    }

    if (item.children.length > 0) {
      content.push(...buildAgendaContent(item.children, locale, depth + 1));
    }
  }

  return content;
}

function basePdfDefinition(
  content: Content[],
  locale: ExportLocale,
): TDocumentDefinitions {
  return {
    content,
    styles: {
      h1: {
        fontSize: 18,
        bold: true,
        color: CREUP_RED,
        margin: [0, 0, 0, 4],
      },
      h2: {
        fontSize: 14,
        bold: true,
        color: CREUP_RED,
      },
      h3: {
        fontSize: 12,
        bold: true,
        color: CREUP_RED,
      },
      subtitle: {
        fontSize: 11,
        italics: true,
        color: "#555555",
      },
      docTitle: {
        fontSize: 11,
        bold: true,
      },
      body: {
        fontSize: 10,
        lineHeight: 1.4,
      },
    },
    defaultStyle: {
      font: "Raleway",
      fontSize: 10,
    },
    pageMargins: [40, 60, 40, 40],
    header: {
      text: `CREUP - ${getLabels(locale).title}`,
      alignment: "center",
      fontSize: 8,
      color: CREUP_RED,
      margin: [0, 20, 0, 0],
    },
    footer: (currentPage: number, pageCount: number) => ({
      text: `${currentPage} / ${pageCount}`,
      alignment: "center",
      fontSize: 8,
      margin: [0, 10, 0, 0],
    }),
  };
}

export function buildAssemblyPdf(
  data: ExportData,
  locale: ExportLocale,
): TDocumentDefinitions {
  const { assembly, agendaItems } = data;
  return basePdfDefinition(
    [
      {
        text: assemblyTitle(assembly, locale),
        style: "h1",
      },
      {
        text: `${assembly.location} ${getLabels(locale).locationDateSeparator} ${assembly.startDate} - ${assembly.endDate}`,
        style: "subtitle",
        margin: [0, 0, 0, 20],
      },
      ...buildAgendaContent(agendaItems, locale),
    ],
    locale,
  );
}

export function buildDocumentPdf(
  data: DocumentExportData,
  locale: ExportLocale,
): TDocumentDefinitions {
  const { assembly, agendaItemTitle, document } = data;
  return basePdfDefinition(
    [
      {
        text: assemblyTitle(assembly, locale),
        style: "h1",
      },
      {
        text: agendaItemTitle,
        style: "h2",
        margin: [0, 12, 0, 8],
      },
      ...buildDocumentContent(document, locale, 0),
    ],
    locale,
  );
}
