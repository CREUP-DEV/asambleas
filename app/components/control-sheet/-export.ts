import type { VoteDto } from "~~/shared/types/api";
import { isUnanimousVote } from "~~/shared/utils/controlSheet";
import { shownVoteCounts } from "~~/shared/utils/votes";
import type { XlsxSheet, XlsxWorkbook } from "~~/shared/utils/xlsx";
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

export function useControlSheetExport() {
  const { t, locale } = useI18n();
  const electionText = useElectionText();
  const alternativesText = useAlternativesVoteText();

  /** «21 de noviembre de 2026» and «16:40», in Madrid. */
  function moment(at: Date): { date: string; time: string } {
    const zone = "Europe/Madrid";
    return {
      date: new Intl.DateTimeFormat(locale.value, {
        timeZone: zone,
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(at),
      time: new Intl.DateTimeFormat(locale.value, {
        timeZone: zone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(at),
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
    const columns = [
      { header: t("controlSheet.columns.number"), width: 7 },
      { header: t("controlSheet.columns.item"), width: 48 },
      { header: t("controlSheet.export.documents"), width: 42 },
      { header: t("controlSheet.columns.proponent"), width: 16 },
      { header: t("controlSheet.columns.treated"), width: 12 },
      { header: t("controlSheet.columns.result"), width: 18 },
      { header: t("controlSheet.columns.votes"), width: 36 },
    ];
    if (input.internal) {
      columns.push({
        header: t("controlSheet.columns.observations"),
        width: 48,
      });
    }
    const rows = input.general.map((row) => {
      const values = [
        row.number ?? t("agenda.unlisted.label"),
        row.title,
        row.documents.map((document) => document.title).join("\n"),
        proponents(row),
        itemTreatedControl(row).treated
          ? t("controlSheet.export.treatedItem")
          : t("controlSheet.export.untreated"),
        t(`controlSheet.result.${row.outcome.result ?? "pending"}`),
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
    const columns = [
      { header: t("controlSheet.columns.code"), width: 14 },
      { header: t("controlSheet.columns.authors"), width: 22 },
      { header: t("controlSheet.columns.kind"), width: 13 },
    ];
    if (document.showPositions) {
      columns.push({ header: t("controlSheet.columns.position"), width: 22 });
    }
    columns.push(
      { header: t("controlSheet.columns.treated"), width: 12 },
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
      const values = [
        amendment.code ?? t("amendment.unnumberedLabel"),
        authors,
        t(`controlSheet.kind.${amendmentSheetKind(amendment)}`),
      ];
      if (document.showPositions) {
        values.push(
          row.awaitsAnswer
            ? t("controlSheet.answer.pending")
            : row.position
              ? t(`common.status.position.${row.position.position}`)
              : t("controlSheet.positionNone"),
        );
      }
      values.push(
        amendmentTreatedControl(row).treated
          ? t("controlSheet.export.treatedAmendment")
          : t("controlSheet.export.untreated"),
        [
          t(`liveView.state.${row.state}.label`),
          row.note ? t(row.note.key, row.note.params ?? {}) : "",
        ]
          .filter(Boolean)
          .join("\n"),
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
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Madrid",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(input.exportedAt);
    const part = (type: string) =>
      parts.find((entry) => entry.type === type)?.value ?? "";
    const assembly = input.assemblyLabel
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    return `${t("controlSheet.export.filePrefix")}-${assembly}-${part("year")}-${part("month")}-${part("day")}-${part("hour")}${part("minute")}.xlsx`;
  }

  return { workbook, fileName, voteText };
}
