<script setup lang="ts">
import {
  PROPONENT_POSITIONS,
  type ProponentPosition,
} from "~~/shared/constants/domain";
import type {
  AmendmentDto,
  DocumentSummaryDto,
  PositionBody,
} from "~~/shared/types/api";
import {
  amendmentPositionBlocker,
  presenterSeesValidated,
} from "~/composables/amendment/workspace";
import { answerableAfterDecision } from "~~/shared/utils/positions";
import { sessionPositionMenu } from "~/composables/session/sessionModel";
import type { AmendmentSheetRow } from "./-model";

/**
 * «Respuesta del proponente» in a row's side panel: who answered and what,
 * and, for whoever may answer it (`can.position`: a presenter of the
 * document, main or co-presenter, or the Mesa, the Secretaría and the
 * Presidencia for them), the answers to choose from. The choice is a
 * draft, saved with the rest of the panel by its one «Guardar» (RowPanel
 * calls `save`, and reads `editable`, `dirty` and `saving`). The same answer as the document's and the console's, through the same
 * endpoint and lock (`positionUpdatedAt`), so it is recorded like any other
 * (position_changed, with who gave it). «Propone una transaccional» is not
 * offered here (it only notes the intent: the transactional is proposed
 * from the document), though an answer already given so still shows.
 * Nothing is offered once the document is voted; while the amendment
 * cannot be answered yet the panel says what it waits for (validation,
 * the main authors of a transactional, the assembly's admission,
 * publication). Accepting
 * where accepted amendments are incorporated says so under the option, and
 * saving is the confirmation. One the assembly already approved (by a vote,
 * by assent or as a formal one: answerableAfterDecision) can still be
 * answered until the final vote, but changing its answer changes nothing
 * else: its options say nothing about what they do and one line says the
 * approval stays.
 */
const props = defineProps<{
  row: AmendmentSheetRow;
  document: DocumentSummaryDto | null;
  apiBase: string;
}>();
const emit = defineEmits<{ saved: [amendment: AmendmentDto] }>();

const { t } = useI18n();
const api = useApi();
const toast = useToast();
const { member } = useMe();

const amendment = computed(() => props.row.amendment);
const position = computed(() => props.row.position);
const current = computed<ProponentPosition>(
  () => position.value?.position ?? "pending",
);

/** The main presenter, by its name: whom the Mesa answers for. */
const presenter = computed(() =>
  props.document?.proponent
    ? memberSpokenName(props.document.proponent)
    : t("amendment.position.thePresenter"),
);
/** The presenter who gave a presenter's answer, as the document names it. */
const answerer = computed(() => {
  const id = position.value?.answeredBy;
  const document = props.document;
  const found =
    id && document
      ? [document.proponent, ...document.coProponents].find(
          (entry) => entry?.id === id,
        )
      : null;
  return found ? memberSpokenName(found) : presenter.value;
});
/** Who said it: a presenter, the Mesa for it, or nobody (formal, by itself). */
const answerText = computed(() => {
  const value = current.value;
  const answer = position.value;
  if (value === "pending" || !answer) return null;
  if (answer.recordedBy === "auto" && value === "accept") {
    return t("amendment.position.answerAuto");
  }
  return answer.recordedBy === "mesa"
    ? t(`amendment.position.answersBy${positionRecorderKey(answer)}.${value}`, {
        member: presenter.value,
      })
    : t(`amendment.position.answers.${value}`, { member: answerer.value });
});

const menu = computed(() =>
  props.document
    ? sessionPositionMenu(
        amendment.value,
        props.document.acceptedAmendments,
        false,
      )
    : null,
);
const editable = computed(
  () => Boolean(menu.value) && !menu.value?.waitsPublication,
);
/** What an undecided amendment waits for before anyone can answer it. */
const blocker = computed(() =>
  props.document && !editable.value && !menu.value?.waitsPublication
    ? amendmentPositionBlocker(
        amendment.value,
        props.document.acceptedAmendments,
        { presenterSeesValidated: presenterSeesValidated(props.document) },
      )
    : null,
);
/** The viewer presents the document itself, or answers for its presenters. */
const forPresenters = computed(() => {
  const id = member.value?.id;
  const document = props.document;
  if (!id || !document) return true;
  return !(
    document.proponent?.id === id ||
    document.coProponents.some((entry) => entry.id === id)
  );
});

const busy = ref(false);
const choice = ref<ProponentPosition>(current.value);
/** A choice not saved yet, while the amendment can be answered. */
const dirty = computed(() => editable.value && choice.value !== current.value);
// Another amendment starts over; a new answer from elsewhere is taken
// unless the reader has chosen another one meanwhile.
watch(
  () => amendment.value.id,
  () => {
    choice.value = current.value;
  },
);
watch(current, (value, previous) => {
  if (!busy.value && choice.value === previous) choice.value = value;
});

const incorporates = computed(
  () => props.document?.acceptedAmendments === "incorporate",
);
/**
 * Approved by the assembly: the answer is recorded and the approval and
 * the text stay (not one the acceptance incorporated, which follows it).
 */
const afterDecision = computed(() => answerableAfterDecision(amendment.value));
const items = computed(() =>
  PROPONENT_POSITIONS.filter(
    (value) => value !== "transact" || current.value === "transact",
  ).map((value) => ({
    value,
    label: t(`amendment.position.options.${value}`),
    description: afterDecision.value
      ? undefined
      : value === "accept" && incorporates.value
        ? t("amendment.position.descriptions.acceptIncorporate")
        : t(`amendment.position.descriptions.${value}`),
    disabled: value === "accept" && Boolean(menu.value?.acceptBlocked),
  })),
);

/** Saves the chosen answer; true when there was nothing to save or it saved. */
async function save(): Promise<boolean> {
  const document = props.document;
  if (!document || busy.value || !dirty.value) return true;
  busy.value = true;
  const body: PositionBody = {
    position: choice.value,
    comment: amendment.value.position?.comment ?? null,
    positionUpdatedAt:
      amendment.value.position?.updatedAt ?? position.value?.updatedAt ?? null,
  };
  try {
    const updated = await api.send<AmendmentDto>(
      `${props.apiBase}/documents/${encodeURIComponent(document.id)}/amendments/${encodeURIComponent(amendment.value.id)}/position`,
      { method: "PUT", body },
    );
    toast.add({
      title: t("amendment.position.saved"),
      description: afterDecision.value
        ? t("amendment.position.savedDecided")
        : undefined,
      icon: "i-lucide-check",
    });
    emit("saved", updated);
    return true;
  } catch (error) {
    choice.value = current.value;
    api.notifyError(error, "amendment.position.saveFailed");
    return false;
  } finally {
    busy.value = false;
  }
}

defineExpose({ editable, dirty, saving: busy, save });
</script>

<template>
  <section
    class="space-y-2"
    aria-labelledby="control-sheet-position-title"
    :aria-busy="busy || undefined"
  >
    <h3
      id="control-sheet-position-title"
      class="text-highlighted text-sm font-medium"
    >
      {{ t("controlSheet.columns.position") }}
    </h3>
    <p class="text-default text-sm">
      {{ answerText ?? t("controlSheet.positionNone") }}
    </p>

    <p v-if="menu?.waitsPublication" class="text-muted text-xs">
      {{ t("session.position.waitsPublicationFor", { member: presenter }) }}
    </p>
    <p v-else-if="blocker" class="text-muted text-xs">
      {{ t(`amendment.position.blocked.${blocker}`) }}
    </p>

    <template v-else-if="editable">
      <p class="text-muted text-xs">
        {{
          forPresenters
            ? t("controlSheet.panel.positionFor", { member: presenter })
            : t("controlSheet.panel.positionHint")
        }}
      </p>
      <p v-if="afterDecision" class="text-muted text-xs">
        {{ t("amendment.position.next.decided") }}
      </p>
      <URadioGroup
        v-model="choice"
        :items="items"
        :legend="t('amendment.position.label')"
        :disabled="busy"
        :ui="{ legend: 'sr-only' }"
      />
    </template>
  </section>
</template>
