import { xlsxParts, type XlsxWorkbook } from "~~/shared/utils/xlsx";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Zips a workbook (shared/utils/xlsx.ts) and hands it to the browser as a
 * download. JSZip is loaded only when someone exports.
 */
export async function downloadXlsx(
  book: XlsxWorkbook,
  fileName: string,
): Promise<void> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  for (const [path, content] of Object.entries(xlsxParts(book))) {
    zip.file(path, content, { date: book.created });
  }
  const blob = await zip.generateAsync({
    type: "blob",
    mimeType: XLSX_MIME,
    compression: "DEFLATE",
  });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    // Some browsers read the URL after the click returns.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
