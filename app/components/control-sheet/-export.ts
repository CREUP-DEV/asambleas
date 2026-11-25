import type { VoteDto } from "~~/shared/types/api";
import { assemblyClockKey, assemblyDayKey } from "~~/shared/utils/dates";
import { formatDate, formatTime } from "~/utils/format";
import { isUnanimousVote } from "~~/shared/utils/controlSheet";
import { shownVoteCounts } from "~~/shared/utils/votes";
import type {
  XlsxCell,
  XlsxCellStyle,
  XlsxColumn,
  XlsxSheet,
  XlsxWorkbook,
} from "~~/shared/utils/xlsx";
import type { ControlSheetResult } from "~~/shared/utils/controlSheet";
import {
  amendmentNoVoteKey,
  amendmentSheetKind,
  amendmentTreatedControl,
  itemTreatedControl,
  itemVoteNeedsLabel,
  rowVoteEntries,
  type AmendmentSheetRow,
  type GeneralSheetRow,
} from "./-model";
import {
  CONTROL_SHEET_RESULT_COLORS,
  CONTROL_SHEET_STATE_COLORS,
  XLSX_STYLE_OF_COLOR,
} from "~/utils/statusColors";

/**
 * The control sheet as an Excel workbook (user's decision of 2026-11-21):
 * «General», then one sheet per document with amendments, each saying when
 * it was exported. Without who spoke nor the history. Each cell says what
 * the page shows (the same rows, the same words), so the file holds only
 * what the reader reads: the observations only with a sheet key, the
 * presenter's answers only where the page shows them.
 */

/** A document with amendments, as its sheet lists them. */
export interface ControlSheetExportDocument {
  title: string;
  /** Its agenda number, null when unlisted. */
  number: string | null;
  rows: AmendmentSheetRow[];
  /** The page shows the presenter's answers to its amendments. */
  showPositions: boolean;
}

export interface ControlSheetExportInput {
  /** «80.ª AGO». */
  assemblyLabel: string;
  exportedAt: Date;
  /** A sheet key: the observations are there. */
  internal: boolean;
  general: GeneralSheetRow[];
  documents: ControlSheetExportDocument[];
}

/** CREUP's burgundy, for the «General» tab; grey for the documents'. */
const TAB_GENERAL = "7B1E22";
const TAB_DOCUMENT = "8C8C8C";

/** The colour of a result of «General», as its badge has it. */
export function resultCellStyle(
  result: ControlSheetResult | null,
): XlsxCellStyle {
  return XLSX_STYLE_OF_COLOR[CONTROL_SHEET_RESULT_COLORS[result ?? "pending"]];
}

/**
 * The colour of an amendment's state, as its badge in «Enmiendas» has it
 * (CONTROL_SHEET_STATE_COLORS: pending amber and lapsed grey).
 */
export function amendmentStateCellStyle(
  state: AmendmentSheetRow["state"],
): XlsxCellStyle {
  return XLSX_STYLE_OF_COLOR[CONTROL_SHEET_STATE_COLORS[state]];
}

/** The colour of a presenter's answer. */
export function positionCellStyle(position: string | null): XlsxCellStyle {
  switch (position) {
    case "accept":
      return "success";
    case "reject":
      return "danger";
    case "transact":
      return "info";
    default:
      return "neutral";
  }
}

export function useControlSheetExport() {
  const { t, locale } = useI18n();
  const electionText = useElectionText();
  const alternativesText = useAlternativesVoteText();

  /**
   * «21 de noviembre de 2026» and «16:40», in Madrid, as the page writes
   * them («21 November 2026» in English).
   */
  function moment(at: Date): { date: string; time: string } {
    return {
      date: formatDate(at, { locale: locale.value }),
      time: formatTime(at, { locale: locale.value }),
    };
  }

  /** A vote as its line in the sheet reads it, on one or more lines. */
  function voteText(vote: VoteDto): string {
    const lines: string[] = [];
    const head = vote.election
      ? t("amendment.vote.election.title")
      : alternativesText.isAlternatives(vote)
        ? t("amendment.vote.alternatives.title")
        : isUnanimousVote(vote)
          ? t("controlSheet.result.approved_unanimous")
          : t(`common.status.vote.${vote.result}`);
    lines.push(`${head} · ${t(`amendment.vote.methods.${vote.method}`)}`);
    if (vote.election) lines.push(electionText.outcome(vote.election));
    if (vote.method !== "assent") {
      let counts: string;
      if (vote.election) {
        counts = [
          electionText.counts(vote.election),
          ...shownVoteCounts(vote)
            .filter((row) => row.key !== "inFavor" && row.key !== "against")
            .map(({ key, value }) => `${t(`amendment.vote.${key}`)} ${value}`),
        ].join(" · ");
      } else if (alternativesText.isAlternatives(vote)) {
        counts = `${alternativesText.counts(vote)} · ${alternativesText.outcome(vote)}`;
      } else {
        counts = shownVoteCounts(vote)
          .map(({ key, value }) => `${t(`amendment.vote.${key}`)} ${value}`)
          .join(" · ");
      }
      if (counts) lines.push(counts);
    }
    return lines.join("\n");
  }

  function generalVotes(row: GeneralSheetRow): string {
    const entries = rowVoteEntries(row);
    if (entries.length === 0) return t("controlSheet.noVote");
    const ownInForce = entries.filter((entry) => entry.ownVote).length;
    return entries
      .map((entry) => {
        const label = entry.ownVote
          ? itemVoteNeedsLabel(entry.label, row.title, ownInForce)
            ? (entry.label ?? t("controlSheet.itemVotes.fallbackQuestion"))
            : null
          : entry.label;
        const lines = [label, voteText(entry.vote)];
        if (entry.decides && ownInForce > 1) {
          lines.push(t("controlSheet.itemVotes.decides"));
        }
        return lines.filter(Boolean).join("\n");
      })
      .join("\n\n");
  }

  function proponents(row: GeneralSheetRow): string {
    if (row.documents.length === 0) return "";
    const acronyms: string[] = [];
    for (const document of row.documents) {
      for (const member of [document.proponent, ...document.coProponents]) {
        if (member && !acronyms.includes(member.acronym)) {
          acronyms.push(member.acronym);
        }
      }
    }
    return acronyms.length > 0
      ? acronyms.join(", ")
      : t("controlSheet.proponentNone");
  }

  function generalSheet(input: ControlSheetExportInput, lines: string[]) {
    const columns: XlsxColumn[] = [
      { header: t("controlSheet.columns.number"), width: 7, style: "strong" },
      { header: t("controlSheet.columns.item"), width: 48, style: "strong" },
      { header: t("controlSheet.export.documents"), width: 42 },
      {
        header: t("controlSheet.columns.proponent"),
        width: 16,
        style: "center",
      },
      { header: t("controlSheet.columns.treated"), width: 13 },
      { header: t("controlSheet.columns.result"), width: 20 },
      { header: t("controlSheet.columns.votes"), width: 36 },
    ];
    if (input.internal) {
      columns.push({
        header: t("controlSheet.columns.observations"),
        width: 48,
      });
    }
    const rows = input.general.map((row) => {
      const treated = itemTreatedControl(row).treated;
      const values: XlsxCell[] = [
        row.number ?? t("agenda.unlisted.label"),
        row.title,
        row.documents.map((document) => document.title).join("\n"),
        proponents(row),
        {
          text: treated
            ? t("controlSheet.export.treatedItem")
            : t("controlSheet.export.untreated"),
          style: treated ? "success" : "neutral",
        },
        {
          text: t(`controlSheet.result.${row.outcome.result ?? "pending"}`),
          style: resultCellStyle(row.outcome.result),
        },
        generalVotes(row),
      ];
      if (input.internal) values.push(row.sheet?.observations ?? "");
      return values;
    });
    return {
      name: t("controlSheet.tabs.general"),
      lines,
      columns,
      rows,
      tabColor: TAB_GENERAL,
    } satisfies XlsxSheet;
  }

  function amendmentVote(row: AmendmentSheetRow): string {
    const { amendment } = row;
    if (amendment.outcomeVote) return voteText(amendment.outcomeVote);
    const key = amendmentNoVoteKey(amendment);
    return key ? t(key) : t("controlSheet.noVote");
  }

  function amendmentSheet(
    input: ControlSheetExportInput,
    document: ControlSheetExportDocument,
    exported: string,
  ): XlsxSheet {
    const columns: XlsxColumn[] = [
      { header: t("controlSheet.columns.code"), width: 14, style: "strong" },
      { header: t("controlSheet.columns.authors"), width: 22, style: "center" },
      { header: t("controlSheet.columns.kind"), width: 14, style: "center" },
    ];
    if (document.showPositions) {
      columns.push({ header: t("controlSheet.columns.position"), width: 22 });
    }
    columns.push(
      { header: t("controlSheet.columns.treated"), width: 13 },
      { header: t("controlSheet.columns.result"), width: 30 },
      { header: t("controlSheet.columns.vote"), width: 34 },
    );
    if (input.internal) {
      columns.push({
        header: t("controlSheet.columns.observations"),
        width: 48,
      });
    }
    const rows = document.rows.map((row) => {
      const { amendment } = row;
      const main =
        amendment.authors.find(
          (author) => author.id === amendment.mainAuthorId,
        ) ?? amendment.authors[0];
      const authors = [
        main,
        ...amendment.authors.filter((author) => author.id !== main?.id),
      ]
        .filter((author) => author !== undefined)
        .map((author) => author.acronym)
        .join(", ");
      const values: XlsxCell[] = [
        amendment.code ?? t("amendment.unnumberedLabel"),
        authors,
        t(`controlSheet.kind.${amendmentSheetKind(amendment)}`),
      ];
      if (document.showPositions) {
        values.push(
          row.awaitsAnswer
            ? { text: t("controlSheet.answer.pending"), style: "warning" }
            : row.position
              ? {
                  text: t(`common.status.position.${row.position.position}`),
                  style: positionCellStyle(row.position.position),
                }
              : { text: t("controlSheet.positionNone"), style: "neutral" },
        );
      }
      const treated = amendmentTreatedControl(row).treated;
      values.push(
        {
          text: treated
            ? t("controlSheet.export.treatedAmendment")
            : t("controlSheet.export.untreated"),
          style: treated ? "success" : "neutral",
        },
        {
          text: [
            t(`liveView.state.${row.state}.label`),
            row.note ? t(row.note.key, row.note.params ?? {}) : "",
          ]
            .filter(Boolean)
            .join("\n"),
          style: amendmentStateCellStyle(row.state),
        },
        amendmentVote(row),
      );
      if (input.internal) values.push(row.sheet?.observations ?? "");
      return values;
    });
    const item = document.number
      ? t("controlSheet.export.item", { number: document.number })
      : null;
    return {
      name: document.title,
      lines: [document.title, ...(item ? [item] : []), exported],
      columns,
      rows,
      tabColor: TAB_DOCUMENT,
    };
  }

  /** The whole workbook, «General» first. */
  function workbook(input: ControlSheetExportInput): XlsxWorkbook {
    const { date, time } = moment(input.exportedAt);
    const exported = t("controlSheet.export.exportedAt", { date, time });
    const title = t("controlSheet.export.title", {
      assembly: input.assemblyLabel,
    });
    return {
      title,
      created: input.exportedAt,
      sheets: [
        generalSheet(input, [title, exported]),
        ...input.documents.map((document) =>
          amendmentSheet(input, document, exported),
        ),
      ],
    };
  }

  /** «hoja-de-control-80-ago-2026-11-21-1640.xlsx», in Madrid time. */
  function fileName(input: ControlSheetExportInput): string {
    const assembly = input.assemblyLabel
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    return `${t("controlSheet.export.filePrefix")}-${assembly}-${assemblyDayKey(input.exportedAt)}-${assemblyClockKey(input.exportedAt)}.xlsx`;
  }

  return { workbook, fileName, voteText };
}
