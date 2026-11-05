<script setup lang="ts">
import type { AmendmentStatus } from "~~/shared/constants/domain";
import type { AcceptanceBody, AmendmentDto } from "~~/shared/types/api";
import {
  transactionalAnswerOf,
  transactionalAuthorTurn,
  transactionalRejectedByAuthors,
} from "~/composables/amendment/transactional";
import { amendmentMainAuthor } from "~/composables/amendment/workspace";

/**
 * A transactional proposed over the amendment being read, from that
 * amendment's side: which one it is, where it stands, and what the
 * amendment's main author answered (who, what, when), so its co-authors see
 * it too, also once the transactional was decided. The main author answers
 * it right here ("Aceptar" / "Rechazar", POST .../{transactional}/acceptance)
 * while it waits for them. A rejection closes it for everyone and cannot be
 * undone, so "Rechazar" asks first. Only one card on the screen gets the
 * primary button (`primary`). The Mesa records answers given in the room
 * from the transactional's own detail.
 */
const props = withDefaults(
  defineProps<{
    transactional: AmendmentDto;
    /** The amendment it would replace (the one being read). */
    source: AmendmentDto;
    /** Base URL of the document's amendments: .../amendments. */
    amendmentsUrl: string;
    actorMemberId: string | null;
    labelOf: (id: string) => string;
    statusOf?: (id: string) => AmendmentStatus | undefined;
    /** "Aceptar" is the screen's primary action (the first card to answer). */
    primary?: boolean;
  }>(),
  { statusOf: undefined, primary: false },
);

const emit = defineEmits<{
  /** The transactional, as the acceptance left it. */
  updated: [amendment: AmendmentDto];
  conflict: [];
  select: [id: string];
}>();

const { t, locale } = useI18n();
const api = useApi();
const toast = useToast();
const confirmId = useId();

const busy = ref<AcceptanceBody["decision"] | null>(null);
const confirming = ref(false);
const rejectButton = useTemplateRef<{ $el?: HTMLElement }>("rejectButton");
const confirmButton = useTemplateRef<{ $el?: HTMLElement }>("confirmButton");

watch(
  () => props.transactional.id,
  () => {
    confirming.value = false;
  },
);

const mainAuthor = computed(() => amendmentMainAuthor(props.source));
/** The main author's row among the transactional's parties. */
const party = computed(() =>
  transactionalAnswerOf(
    props.transactional.acceptances,
    mainAuthor.value?.id ?? null,
  ),
);
const label = computed(() => props.labelOf(props.transactional.id));
/** The viewer's member is the main author, and it is its turn. */
const canAnswer = computed(() =>
  transactionalAuthorTurn(
    props.transactional,
    props.source,
    props.actorMemberId,
  ),
);
/**
 * What the main author answered, for everyone else. Once another main
 * author's rejection closed it, an answer never given is not news: the
 * progress line already says it is closed.
 */
const showState = computed(
  () =>
    party.value !== null &&
    (party.value.decision !== "pending" ||
      props.transactional.status === "submitted"),
);
/**
 * Decided otherwise (voted, lapsed...): the progress line says nothing
 * then, so its outcome is shown.
 */
const showOutcome = computed(
  () =>
    props.transactional.status !== "submitted" &&
    !transactionalRejectedByAuthors(props.transactional),
);

async function askReject(): Promise<void> {
  confirming.value = true;
  await nextTick();
  confirmButton.value?.$el?.focus();
}

async function cancelReject(): Promise<void> {
  confirming.value = false;
  await nextTick();
  rejectButton.value?.$el?.focus();
}

async function answer(decision: AcceptanceBody["decision"]): Promise<void> {
  busy.value = decision;
  try {
    const body: AcceptanceBody = { decision };
    const updated = await api.send<AmendmentDto>(
      `${props.amendmentsUrl}/${props.transactional.id}/acceptance`,
      { body },
    );
    confirming.value = false;
    toast.add({
      title: t("amendment.acceptances.recorded"),
      description:
        decision === "rejected"
          ? t("amendment.acceptances.rejectedDescription")
          : undefined,
      color: "success",
      icon: "i-lucide-check",
    });
    emit("updated", updated);
  } catch (error) {
    api.notifyError(error, "amendment.acceptances.failed");
    if (api.isConflict(error)) {
      confirming.value = false;
      emit("conflict");
    }
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <div class="border-default flex flex-col gap-2 rounded-md border p-3">
    <div class="flex flex-wrap items-center gap-2">
      <UButton
        size="xs"
        color="secondary"
        variant="soft"
        icon="i-lucide-git-merge"
        :label="label"
        :aria-label="t('transactional.answer.open', { label })"
        @click="emit('select', transactional.id)"
      />
      <CommonStatusBadge
        v-if="showOutcome"
        kind="amendment"
        :value="transactional.status"
        size="xs"
      />
      <TransactionalProgress
        :amendment="transactional"
        :label-of="labelOf"
        :status-of="statusOf"
      />
    </div>

    <template v-if="party && mainAuthor">
      <!-- The main author's turn: answer here. -->
      <template v-if="canAnswer">
        <p class="text-highlighted text-sm font-medium">
          {{ t("transactional.answer.question", { label }) }}
        </p>
        <!-- Rejecting closes it for everyone: confirm first. -->
        <div
          v-if="confirming"
          class="flex flex-col gap-2"
          role="group"
          :aria-labelledby="confirmId"
        >
          <p :id="confirmId" class="text-default text-sm">
            {{ t("transactional.answer.rejectConfirm") }}
          </p>
          <div class="flex flex-wrap gap-2">
            <UButton
              ref="confirmButton"
              icon="i-lucide-x"
              color="error"
              size="sm"
              :loading="busy === 'rejected'"
              :disabled="busy !== null"
              :label="t('amendment.acceptances.reject')"
              @click="answer('rejected')"
            />
            <UButton
              color="neutral"
              variant="ghost"
              size="sm"
              :disabled="busy !== null"
              :label="t('amendment.actions.cancel')"
              @click="cancelReject"
            />
          </div>
        </div>
        <template v-else>
          <p class="text-muted text-sm">
            {{ t("transactional.answer.hint") }}
          </p>
          <div class="flex flex-wrap gap-2">
            <UButton
              icon="i-lucide-check"
              size="sm"
              :color="primary ? 'primary' : 'neutral'"
              :variant="primary ? 'solid' : 'outline'"
              :loading="busy === 'accepted'"
              :disabled="busy !== null"
              :label="t('amendment.acceptances.accept')"
              @click="answer('accepted')"
            />
            <UButton
              ref="rejectButton"
              icon="i-lucide-x"
              color="neutral"
              variant="outline"
              size="sm"
              :disabled="busy !== null"
              :label="t('amendment.acceptances.reject')"
              @click="askReject"
            />
          </div>
        </template>
      </template>
      <!-- Everyone else (co-authors included): who answered, what, when. -->
      <p v-else-if="showState" class="text-default text-sm">
        {{
          t(`transactional.answer.state.${party.decision}`, {
            member: party.member.acronym,
          })
        }}
        <span v-if="party.decidedAt" class="text-dimmed text-xs">
          · {{ formatDateTime(party.decidedAt, { locale }) }}
        </span>
      </p>
    </template>
  </div>
</template>
