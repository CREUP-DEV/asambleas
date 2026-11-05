<script setup lang="ts">
import type { AmendmentDto, DocumentDto } from "~~/shared/types/api";
import type { SessionAgendaRow } from "~/composables/session/sessionModel";
import {
  LIVE_STATE_COLORS,
  liveAmendmentCode,
  livePositionLine,
  type LiveAmendmentState,
} from "~/components/live-view/-model";

/**
 * What the Mesa has in debate, for the live view: the agenda item, the
 * document (with who presents it: the main presenter, then at most two
 * co-presenters before "N más") and, when there is one, the amendment with
 * its change in readable type, a sentence on where it stands, how the
 * document's main presenter answered it (when the room may see it) and its
 * justification
 * (folded away, unless the amendment changes no text and the justification
 * is all there is to read). Nothing here is announced by itself: the page keeps one
 * short aria-live line for that, so a refresh never reads the passage aloud.
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
}>();

const { t } = useI18n();

const base = computed(() => props.document?.baseVersion?.blocks ?? []);
const code = computed(() => liveAmendmentCode(props.amendment));
const justification = computed(
  () => props.amendment?.justification.trim() || "",
);
/**
 * No text to compare (a totality amendment returning the document): the
 * diff box only says so, and the justification is the whole substance of
 * the amendment, so it shows unfolded instead of behind a toggle.
 */
const noTextChange = computed(() => (props.amendment?.ops.length ?? 0) === 0);
const justificationOpen = ref(false);

watch(
  () => props.amendment?.id,
  () => {
    justificationOpen.value = false;
  },
);

/** States whose note says it better than the state sentence. */
const NOTE_REPLACES: ReadonlySet<LiveAmendmentState> = new Set([
  "late",
  "transacted",
  "incorporated",
  "turned_down",
]);

/**
 * Where it stands, one sentence per line. A late, replaced, incorporated
 * or turned-down amendment has its own sentence (the note names who or
 * what); anything else keeps the state sentence and adds the note under it.
 */
const stateLines = computed(() => {
  const state = props.state;
  if (!state) return [];
  const note = props.note?.trim() || null;
  if (note && NOTE_REPLACES.has(state)) return [note];
  const sentence = t(`liveView.state.${state}.sentence`);
  return note ? [sentence, note] : [sentence];
});

/**
 * How the main presenter answered it, in one plain sentence ("Respuesta de
 * CEUM: la acepta"), without its comment, to keep the phone view light.
 */
const positionLine = computed(() => {
  if (!props.showPosition || !props.amendment) return null;
  // Its state sentence already says the presenter accepted it.
  if (props.state === "incorporated") return null;
  const line = livePositionLine(props.amendment, props.document?.proponent);
  return line ? t(line.key, line.params ?? {}) : null;
});

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
          {{ t("liveView.now.item", { number: row.number }) }}
          <span class="text-default">{{ row.item.title }}</span>
        </p>
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
        <div
          v-if="document?.proponent && !amendment"
          class="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-sm"
        >
          <span class="text-muted">{{ t("liveView.now.presentedBy") }}</span>
          <DocumentPresenters :document="document" :max-others="2" show-name />
        </div>
      </div>

      <!-- The amendment in debate -->
      <div v-if="amendment" class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center gap-2">
          <h3
            class="text-highlighted text-2xl leading-tight font-bold sm:text-3xl"
          >
            {{
              code
                ? t("projection.amendment", { code })
                : t(`session.enums.amendmentKind.${amendment.kind}`)
            }}
          </h3>
          <UBadge
            v-if="state"
            :color="LIVE_STATE_COLORS[state]"
            :variant="state === 'debating' ? 'solid' : 'subtle'"
            size="lg"
            :label="t(`liveView.state.${state}.label`)"
          />
        </div>
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <UBadge
            color="neutral"
            variant="outline"
            :label="t(`session.enums.amendmentKind.${amendment.kind}`)"
          />
          <CommonMemberBadge
            v-for="author in amendment.authors"
            :key="author.id"
            :member="author"
            :show-name="amendment.authors.length === 1"
          />
        </div>
        <p v-for="line in stateLines" :key="line" class="text-default">
          {{ line }}
        </p>
        <p v-if="positionLine" class="text-default">
          {{ positionLine }}
        </p>

        <div class="live-text border-default rounded-lg border p-3 sm:p-4">
          <ContentAmendmentDiff
            :id="amendment.id"
            :base="base"
            :ops="amendment.ops"
            :context="1"
          />
        </div>

        <div v-if="justification && noTextChange" class="flex flex-col gap-1">
          <h4 class="text-highlighted font-semibold">
            {{ t("liveView.now.justification") }}
          </h4>
          <p class="live-justification text-default whitespace-pre-line">
            {{ justification }}
          </p>
        </div>
        <UCollapsible
          v-else-if="justification"
          v-model:open="justificationOpen"
        >
          <UButton
            color="neutral"
            variant="link"
            size="lg"
            class="min-h-11 px-0"
            :icon="
              justificationOpen
                ? 'i-lucide-chevron-up'
                : 'i-lucide-chevron-down'
            "
            :label="t('liveView.now.justification')"
          />
          <template #content>
            <p class="text-default mt-1 whitespace-pre-line">
              {{ justification }}
            </p>
          </template>
        </UCollapsible>
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

      <!-- The only way on from here: a full-width target on phones -->
      <div v-if="documentPath" class="border-default flex border-t pt-3">
        <UButton
          :to="amendmentLink ?? documentPath"
          color="neutral"
          variant="outline"
          size="lg"
          block
          class="sm:w-auto"
          trailing-icon="i-lucide-arrow-right"
          :label="
            amendmentLink
              ? t('liveView.now.openAmendment')
              : t('liveView.now.openDocument')
          "
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
/* The change, large enough to read on a phone held at arm's length. */
.live-text :deep(.rich-text) {
  font-size: 1.125rem;
  line-height: 1.65;
}

.live-text :deep(.rich-text > * + *) {
  margin-top: 0.75em;
}

/* Unfolded justification of a totality return: the same reading size. */
.live-justification {
  font-size: 1.125rem;
  line-height: 1.65;
}

@media (min-width: 640px) {
  .live-text :deep(.rich-text),
  .live-justification {
    font-size: 1.25rem;
  }
}
</style>
