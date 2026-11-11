import type { ReadProgress } from "~~/shared/utils/readMarks";

/**
 * What is left to read, in words: "3 documentos y 2 enmiendas". Empty when
 * nothing is left.
 */
export function useReadLeftText(progress: () => ReadProgress) {
  const { t } = useI18n();
  return computed(() => {
    const { documentsLeft, amendmentsLeft } = progress();
    return [
      documentsLeft > 0
        ? t(
            "readMarks.count.documents",
            { count: documentsLeft },
            documentsLeft,
          )
        : null,
      amendmentsLeft > 0
        ? t(
            "readMarks.count.amendments",
            { count: amendmentsLeft },
            amendmentsLeft,
          )
        : null,
    ]
      .filter((part) => part !== null)
      .join(t("readMarks.count.and"));
  });
}
