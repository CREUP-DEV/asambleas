<script setup lang="ts">
import type { AmendmentDto, DocumentDto } from "~~/shared/types/api";
import type { SessionAgendaRow } from "~/composables/session/sessionModel";
import type { LiveAmendmentState } from "~/components/live-view/-model";

/**
 * What the Mesa has in debate, for the live view: the agenda item, the
 * document (with who presents it: the main presenter, then at most two
 * co-presenters before "N más") and, when there is one, the amendment with
 * its change in readable type, a sentence on where it stands, how the
 * document's main presenter answered it (when the room may see it) and its
 * justification, folded away (LiveViewAmendmentSummary). «Ver el
 * documento» opens the document in a floating window that follows the
 * projection (LiveViewDocumentWindow), without leaving the page. Nothing
 * here is announced by itself: the page keeps one short aria-live line for
 * that, so a refresh never reads the passage aloud.
 */
const props = defineProps<{
  row: SessionAgendaRow | null;
  document: DocumentDto | null;
  amendment: AmendmentDto | null;
  /** Where the amendment stands (see liveAmendmentState). */
  state: LiveAmendmentState | null;
  /**
   * What the badge alone does not explain (liveAmendmentNote), already
   * translated: who replaced it, that it is in the text without a vote, or
   * what a transactional replaced or still waits for.
   */
  note?: string | null;
  /** The Mesa debates an amendment the viewer cannot read yet. */
  amendmentHidden: boolean;
  /**
   * The room may see the main presenter's answer to each amendment (the
   * assembly does not keep answers to the Mesa). Off by default.
   */
  showPosition?: boolean;
  /** Localized path of the document workspace. */
  documentPath: string | null;
  /**
   * The agenda that names the item is still on its way: a placeholder
   * stands for its line.
   */
  itemLoading?: boolean;
  /**
   * The document or the amendment in debate is still on its way:
   * placeholders stand for them, rather than saying that only the item, or
   * the whole document, is debated.
   */
  loading?: boolean;
}>();

/** «Ver el documento»: the page opens it in its floating window. */
const emit = defineEmits<{ viewDocument: [] }>();

const { t } = useI18n();

const amendmentLink = computed(() =>
  props.amendment && props.documentPath
    ? `${props.documentPath}?enmienda=${encodeURIComponent(props.amendment.id)}`
    : null,
);
</script>

<template>
  <section aria-labelledby="live-now-title" class="flex flex-col gap-3">
    <h2
      id="live-now-title"
      class="text-highlighted flex items-center gap-2 text-lg font-semibold"
    >
      <span class="relative flex size-2.5" aria-hidden="true">
        <span
          class="bg-error absolute inline-flex size-full animate-ping rounded-full opacity-75 motion-reduce:animate-none"
        />
        <span class="bg-error relative inline-flex size-2.5 rounded-full" />
      </span>
      {{ t("liveView.now.title") }}
    </h2>

    <div class="ring-default flex flex-col gap-4 rounded-lg p-4 ring sm:p-5">
      <!-- Agenda item and document -->
      <div class="flex flex-col gap-1">
        <p v-if="row" class="text-muted text-sm">
          {{
            t("liveView.now.item", {
              number: agendaNumberInText(
                row.number,
                t("agenda.unlisted.inText"),
              ),
            })
          }}
          <span class="text-default">{{ row.item.title }}</span>
        </p>
        <USkeleton
          v-else-if="itemLoading"
          aria-hidden="true"
          class="h-5 w-2/3"
        />
        <p
          v-if="document"
          class="text-highlighted font-semibold break-words"
          :class="amendment ? 'text-base' : 'text-2xl leading-tight'"
        >
          <span v-if="document.reference" class="text-muted font-medium"
            >{{ document.reference }} ·
          </span>
          {{ document.title }}
        </p>
        <USkeleton v-else-if="loading" aria-hidden="true" class="h-8 w-full" />
        <div
          v-if="document?.proponent && !amendment"
          class="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-sm"
        >
          <span class="text-muted">{{ t("liveView.now.presentedBy") }}</span>
          <DocumentPresenters :document="document" :max-others="2" show-name />
        </div>
      </div>

      <!-- The amendment in debate -->
      <LiveViewAmendmentSummary
        v-if="amendment"
        :amendment="amendment"
        :document="document"
        :state="state"
        :note="note"
        :show-position="showPosition"
        fold-justification
      />
      <div v-else-if="loading" aria-hidden="true" class="flex flex-col gap-2">
        <USkeleton class="h-5 w-full" />
        <USkeleton class="h-5 w-5/6" />
      </div>
      <p v-else-if="amendmentHidden" class="text-muted">
        {{ t("projection.amendmentHidden") }}
      </p>
      <p v-else-if="document" class="text-default">
        {{ t("liveView.now.wholeDocument") }}
      </p>
      <p v-else class="text-default">
        {{ t("liveView.now.itemOnly") }}
      </p>

      <!-- The ways on from here: full-width targets on phones -->
      <div
        v-if="document"
        class="border-default flex flex-col gap-2 border-t pt-3 sm:flex-row sm:flex-wrap"
      >
        <UButton
          color="neutral"
          :variant="amendmentLink ? 'outline' : 'solid'"
          size="lg"
          block
          class="sm:w-auto"
          icon="i-lucide-book-open"
          :label="t('liveView.document.view')"
          @click="emit('viewDocument')"
        />
        <UButton
          v-if="amendmentLink"
          :to="amendmentLink"
          color="neutral"
          variant="outline"
          size="lg"
          block
          class="sm:w-auto"
          trailing-icon="i-lucide-arrow-right"
          :label="t('liveView.now.openAmendment')"
        />
      </div>
    </div>
  </section>
</template>
