import {
  transactionalAfterSecretaria,
  transactionalProgressMessage,
  type TransactionalProgressMessage,
  type TransactionalProgressView,
} from "./transactional";

/**
 * Words for where a transactional stands (transactionalProgressOf): a short
 * line for cards and lists, and a sentence with the next step for the
 * detail. While the Secretaría has it, the detail keeps its own review
 * sentence, so `sentence` is null there and `afterSecretaria` says who will
 * still have to accept it. Which words apply is decided by the pure
 * transactionalProgressMessage; this only translates them.
 */
export function useTransactionalProgressText() {
  const { t } = useI18n();

  function translate(message: TransactionalProgressMessage | null) {
    return message ? t(message.key, message.params) : null;
  }

  function summary(view: TransactionalProgressView): string {
    return translate(transactionalProgressMessage(view, "short")) ?? "";
  }

  function sentence(view: TransactionalProgressView): string | null {
    return translate(transactionalProgressMessage(view, "long"));
  }

  function afterSecretaria(view: TransactionalProgressView): string | null {
    return translate(transactionalAfterSecretaria(view));
  }

  return { summary, sentence, afterSecretaria };
}
