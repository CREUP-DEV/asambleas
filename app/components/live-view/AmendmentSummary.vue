<script setup lang="ts">
import type { AmendmentDto, DocumentDto } from "~~/shared/types/api";
import {
  LIVE_STATE_COLORS,
  liveAmendmentCode,
  liveNoteMentions,
  livePositionLine,
  type LiveAmendmentState,
} from "~/components/live-view/-model";

/**
 * One amendment as the live view reads it: its code and where it stands,
 * its kind and authors, a sentence on its state, how the document's main
 * presenter answered it (when the room may see it), its change in readable
 * type and its justification. The debate card (LiveViewDebate) shows the
 * amendment in debate with it, the justification folded; the preview
 * window (LiveViewAmendmentWindow) any amendment of the document.
 */
const props = withDefaults(
  defineProps<{
    amendment: AmendmentDto;
    /** The amended document: its base text and its main presenter. */
    document: DocumentDto | null;
    /** Where the amendment stands (see liveAmendmentState). */
    state: LiveAmendmentState | null;
    /**
     * What the badge alone does not explain (liveAmendmentNote), already
     * translated: who replaced it, that it is in the text without a vote,
     * or what a transactional replaced or still waits for.
     */
    note?: string | null;
    /** The room may see the main presenter's answer. Off by default. */
    showPosition?: boolean;
    /** The justification starts folded (the debate card). */
    foldJustification?: boolean;
    /** Heading level of the amendment's code. */
    headingLevel?: "h2" | "h3";
  }>(),
  {
    note: null,
    showPosition: false,
    foldJustification: false,
    headingLevel: "h3",
  },
);

const { t } = useI18n();

const base = computed(() => props.document?.baseVersion?.blocks ?? []);
const code = computed(() => liveAmendmentCode(props.amendment));
const justification = computed(
  () => props.amendment.justification.trim() || "",
);
const justificationOpen = ref(false);

watch(
  () => props.amendment.id,
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
  if (!props.showPosition) return null;
  // Its state sentence already says the presenter accepted it.
  if (props.state === "incorporated") return null;
  const line = livePositionLine(props.amendment, props.document?.proponent);
  return line ? t(line.key, line.params ?? {}) : null;
});
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center gap-2">
      <component
        :is="headingLevel"
        class="text-highlighted text-2xl leading-tight font-bold sm:text-3xl"
      >
        {{
          code
            ? t("projection.amendment", { code })
            : t(`session.enums.amendmentKind.${amendment.kind}`)
        }}
      </component>
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
    <!-- Codes of other amendments in it preview and open them, where the
         page provides the links. -->
    <p v-for="line in stateLines" :key="line" class="text-default">
      <AmendmentLinkedText :text="line" :ids="liveNoteMentions(amendment)" />
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

    <template v-if="justification">
      <UCollapsible v-if="foldJustification" v-model:open="justificationOpen">
        <UButton
          color="neutral"
          variant="link"
          size="lg"
          class="min-h-11 px-0"
          :icon="
            justificationOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'
          "
          :label="t('liveView.now.justification')"
        />
        <template #content>
          <p class="text-default mt-1 whitespace-pre-line">
            {{ justification }}
          </p>
        </template>
      </UCollapsible>
      <div v-else class="flex flex-col gap-1">
        <p class="text-highlighted font-semibold">
          {{ t("liveView.now.justification") }}
        </p>
        <p class="text-default whitespace-pre-line">
          {{ justification }}
        </p>
      </div>
    </template>
  </div>
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

@media (min-width: 640px) {
  .live-text :deep(.rich-text) {
    font-size: 1.25rem;
  }
}
</style>
