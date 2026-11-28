<script setup lang="ts">
import type { DocumentDto } from "~~/shared/types/api";

/**
 * A signed document's signing panel (SigningPanel; user's decisions of
 * 2026-11-26 and 2026-11-28), for whoever signs it: an acta's managers, as
 * the Secretaría Ejecutiva, on its «Consolidado»; any other document's main
 * presenter, on its «Consolidado» once voted, on its own page when nothing
 * votes it (a report). The texts follow who signs: an acta says «el acta»
 * and names the Secretaría Ejecutiva, any other «el documento» and «Y por
 * tanto firmo».
 */
const props = defineProps<{
  document: DocumentDto;
  /** The document's API route. */
  documentApi: string;
}>();
const emit = defineEmits<{ changed: [] }>();

const { t } = useI18n();

const signing = computed(() => props.document.signing!);
const acta = computed(() => props.document.kind === "minutes");

const notYet = computed(() => {
  if (acta.value) {
    return signing.value.signer
      ? t("documentSigning.notYet")
      : t("documentSigning.noSigner");
  }
  return signing.value.signer
    ? t("documentSigning.document.notYet")
    : t("documentSigning.document.noSigner");
});

const intro = computed(() => {
  const name = signing.value.signer ?? "";
  if (acta.value) return t("documentSigning.intro", { name });
  return signing.value.image
    ? t("documentSigning.document.intro", { name })
    : t("documentSigning.document.introNoImage", { name });
});

const warning = computed(() => {
  if (!signing.value.closingInText) return null;
  return acta.value
    ? t("documentSigning.closingInText")
    : t("documentSigning.document.closingInText");
});
</script>

<template>
  <SigningPanel
    :signing="signing.state"
    :approved="signing.ready"
    :title="document.title"
    :base="`${documentApi}/signing`"
    :not-yet="notYet"
    :intro="intro"
    :warning="warning"
    :texts="acta ? 'agreementsRecord.signing' : 'documentSigning.panel'"
    :image="signing.image"
    @update="emit('changed')"
    @stale="emit('changed')"
  />
</template>
