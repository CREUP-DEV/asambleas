import type { AmendmentStatus } from "~~/shared/constants/domain";
import {
  transactionalAfterSecretaria,
  transactionalProgressMessage,
  transactionalSourcesReplaced,
  type TransactionalProgressMessage,
  type TransactionalProgressView,
  type TransactionalProgressWords,
} from "./transactional";

/**
 * Words for where a transactional stands (transactionalProgressOf): a short
 * line for cards and lists, and a sentence with the next step for the
 * detail. While the Secretaría has it, the detail keeps its own review
 * sentence, so `sentence` is null there and `afterSecretaria` says what
 * checking it will do (replace the amendments it combines). Which words
 * apply is decided by the pure transactionalProgressMessage; this only
 * names the amendments (`labelOf`), joins lists the way the locale does
 * ("CEUM 1 y CAUB 1") and translates.
 */
export function useTransactionalProgressText() {
  const { t, locale } = useI18n();

  function join(items: string[]): string {
    try {
      return new Intl.ListFormat(locale.value, {
        style: "long",
        type: "conjunction",
      }).format(items);
    } catch {
      return items.join(", ");
    }
  }

  function words(
    view: TransactionalProgressView,
    labelOf?: (id: string) => string,
  ): TransactionalProgressWords {
    return {
      sources: labelOf ? view.sourceIds.map((id) => labelOf(id)) : [],
      join,
    };
  }

  function translate(message: TransactionalProgressMessage | null) {
    return message ? t(message.key, message.params) : null;
  }

  function summary(
    view: TransactionalProgressView,
    labelOf?: (id: string) => string,
  ): string {
    return (
      translate(
        transactionalProgressMessage(view, "short", words(view, labelOf)),
      ) ?? ""
    );
  }

  function sentence(
    view: TransactionalProgressView,
    labelOf?: (id: string) => string,
  ): string | null {
    return translate(
      transactionalProgressMessage(view, "long", words(view, labelOf)),
    );
  }

  function afterSecretaria(
    view: TransactionalProgressView,
    labelOf?: (id: string) => string,
    statusOf?: (id: string) => AmendmentStatus | undefined,
  ): string | null {
    return translate(
      transactionalAfterSecretaria(
        view,
        words(view, labelOf),
        transactionalSourcesReplaced(view.sourceIds, statusOf),
      ),
    );
  }

  return { summary, sentence, afterSecretaria, join };
}
