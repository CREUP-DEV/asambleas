<script setup lang="ts">
import type {
  AcceptanceBody,
  AcceptanceDto,
  AmendmentDto,
} from "~~/shared/types/api";
import { transactionalPartySources } from "~/composables/amendment/transactional";

/**
 * Who has to accept a transactional: the main author of each amendment it
 * would replace (design.md, "Transactionals"), with what each answered and
 * when, so co-authors always see what their main author decided. A pending
 * main author answers for itself here ("Aceptar" / "Rechazar",
 * `can.accept`); the Mesa records the answer one gives in the room. Rows
 * kept from before main authors existed (the document's presenter, role
 * "proponent") read as such. Where the transactional stands as a whole is
 * said once, by the review panel above, so this list does not repeat it.
 *
 * A rejection closes it for everyone and cannot be undone, so "Rechazar"
 * (and the Mesa's "Rechaza X") asks first. Only the viewer's own answer is
 * a primary button; recording someone else's answer is secondary.
 */
const props = withDefaults(
  defineProps<{
    amendment: AmendmentDto;
    /** URL of the amendment: .../amendments/{id}. */
    url: string;
    actorMemberId: string | null;
    /** The amendments it combines that the viewer sees. */
    sources?: AmendmentDto[];
    labelOf?: (id: string) => string;
  }>(),
  { sources: () => [], labelOf: undefined },
);

const emit = defineEmits<{
  updated: [amendment: AmendmentDto];
  conflict: [];
}>();

const { t, locale } = useI18n();
const api = useApi();
const toast = useToast();
const titleId = useId();

const busy = ref<string | null>(null);
/** The party whose rejection is being confirmed (its member id). */
const confirming = ref<string | null>(null);
const confirmId = useId();
/** Each party's "Rechazar", to give focus back on cancel (not reactive). */
const rejectButtons = new Map<string, HTMLElement>();
/** The confirming "Rechazar" (inside the list, so a function ref). */
let confirmButton: HTMLElement | null = null;

watch(
  () => props.amendment.id,
  () => {
    confirming.value = null;
  },
);

function elementOf(el: unknown): HTMLElement | null {
  return (el as { $el?: HTMLElement } | null)?.$el ?? null;
}

function rememberConfirmButton(el: unknown): void {
  confirmButton = elementOf(el);
}

function rememberRejectButton(id: string, el: unknown): void {
  const node = elementOf(el);
  if (node) rejectButtons.set(id, node);
  else rejectButtons.delete(id);
}

async function askReject(party: AcceptanceDto): Promise<void> {
  confirming.value = party.member.id;
  await nextTick();
  confirmButton?.focus();
}

async function cancelReject(): Promise<void> {
  const id = confirming.value;
  confirming.value = null;
  await nextTick();
  if (id) rejectButtons.get(id)?.focus();
}

const open = computed(() => props.amendment.status === "submitted");
const acceptedCount = computed(
  () =>
    props.amendment.acceptances.filter(
      (acceptance) => acceptance.decision === "accepted",
    ).length,
);
/** Nobody said no yet: a rejection would still close it. */
const showRule = computed(
  () =>
    open.value &&
    props.amendment.acceptances.some((party) => party.decision === "pending") &&
    !props.amendment.acceptances.some((party) => party.decision === "rejected"),
);

function isOwn(party: AcceptanceDto): boolean {
  return party.member.id === props.actorMemberId;
}

/** "autor principal de 12 · CEUM 4", or the role of an older row. */
function roleLabel(party: AcceptanceDto): string {
  if (party.role === "proponent") {
    return t("amendment.acceptances.roles.proponent");
  }
  const answersFor = transactionalPartySources(props.sources, party.member.id);
  if (answersFor.length === 0 || !props.labelOf) {
    return t("amendment.acceptances.roles.mainAuthor");
  }
  return t("amendment.acceptances.roles.mainAuthorOf", {
    list: answersFor.map((source) => props.labelOf!(source.id)).join(", "),
  });
}

const ANSWER_LOOK: Record<
  AcceptanceDto["decision"],
  { icon: string; class: string }
> = {
  pending: { icon: "i-lucide-hourglass", class: "text-muted" },
  accepted: { icon: "i-lucide-circle-check", class: "text-success" },
  rejected: { icon: "i-lucide-circle-x", class: "text-error" },
};

/**
 * What the party answered, as a sentence: "CEUM la ha aceptado". Once it is
 * closed, nobody waits for a missing answer any more: "CEUM no llegó a
 * responder".
 */
function answerLabel(party: AcceptanceDto): string {
  const key =
    party.decision === "pending" && !open.value
      ? "notAnswered"
      : party.decision;
  return t(`amendment.acceptances.answers.${key}`, {
    member: party.member.acronym,
  });
}

function canAnswer(party: AcceptanceDto): boolean {
  if (!open.value || party.decision !== "pending") return false;
  if (isOwn(party)) return props.amendment.can.accept;
  return props.amendment.can.moderate;
}

async function answer(
  party: AcceptanceDto,
  decision: AcceptanceBody["decision"],
): Promise<void> {
  busy.value = `${party.member.id}:${decision}`;
  try {
    const body: AcceptanceBody = {
      decision,
      ...(isOwn(party) ? {} : { memberId: party.member.id }),
    };
    const updated = await api.send<AmendmentDto>(`${props.url}/acceptance`, {
      body,
    });
    confirming.value = null;
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
      confirming.value = null;
      emit("conflict");
    }
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <section class="flex flex-col gap-3" :aria-labelledby="titleId">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h3 :id="titleId" class="text-highlighted text-sm font-semibold">
        {{ t("amendment.acceptances.title") }}
      </h3>
      <span
        v-if="amendment.acceptances.length > 0"
        class="text-muted text-xs tabular-nums"
      >
        {{
          t("amendment.acceptances.summary", {
            accepted: acceptedCount,
            total: amendment.acceptances.length,
          })
        }}
      </span>
    </div>

    <p v-if="showRule" class="text-muted text-sm">
      {{ t("amendment.acceptances.rule") }}
    </p>

    <p v-if="amendment.acceptances.length === 0" class="text-muted text-sm">
      {{ t("amendment.acceptances.none") }}
    </p>

    <ul v-else class="divide-default flex flex-col divide-y">
      <li
        v-for="party in amendment.acceptances"
        :key="party.member.id"
        class="flex flex-col gap-2 py-2"
      >
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <CommonMemberBadge :member="party.member" size="xs" show-name />
          <span class="text-dimmed text-xs">{{ roleLabel(party) }}</span>
        </div>
        <p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <UIcon
            :name="ANSWER_LOOK[party.decision].icon"
            class="size-4 shrink-0"
            :class="ANSWER_LOOK[party.decision].class"
            aria-hidden="true"
          />
          <span class="text-default">{{ answerLabel(party) }}</span>
          <span v-if="party.decidedAt" class="text-dimmed text-xs">
            {{ formatDateTime(party.decidedAt, { locale }) }}
          </span>
        </p>
        <!-- Rejecting closes it for everyone: confirm first. -->
        <div
          v-if="canAnswer(party) && confirming === party.member.id"
          class="flex flex-col gap-2"
          role="group"
          :aria-labelledby="confirmId"
        >
          <p :id="confirmId" class="text-default text-sm">
            {{
              isOwn(party)
                ? t("amendment.acceptances.rejectConfirm")
                : t("amendment.acceptances.recordRejectConfirm", {
                    member: party.member.acronym,
                  })
            }}
          </p>
          <div class="flex flex-wrap gap-2">
            <UButton
              :ref="rememberConfirmButton"
              icon="i-lucide-x"
              color="error"
              size="sm"
              :loading="busy === `${party.member.id}:rejected`"
              :disabled="busy !== null"
              :label="
                isOwn(party)
                  ? t('amendment.acceptances.reject')
                  : t('amendment.acceptances.recordReject', {
                      member: party.member.acronym,
                    })
              "
              @click="answer(party, 'rejected')"
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
        <div v-else-if="canAnswer(party)" class="flex flex-wrap gap-2">
          <!-- The viewer's own answer is the primary action. -->
          <UButton
            icon="i-lucide-check"
            size="sm"
            :color="isOwn(party) ? 'primary' : 'neutral'"
            :variant="isOwn(party) ? 'solid' : 'outline'"
            :loading="busy === `${party.member.id}:accepted`"
            :disabled="busy !== null || confirming !== null"
            :label="
              isOwn(party)
                ? t('amendment.acceptances.accept')
                : t('amendment.acceptances.recordAccept', {
                    member: party.member.acronym,
                  })
            "
            @click="answer(party, 'accepted')"
          />
          <UButton
            :ref="(el) => rememberRejectButton(party.member.id, el)"
            icon="i-lucide-x"
            color="neutral"
            variant="outline"
            size="sm"
            :disabled="busy !== null || confirming !== null"
            :label="
              isOwn(party)
                ? t('amendment.acceptances.reject')
                : t('amendment.acceptances.recordReject', {
                    member: party.member.acronym,
                  })
            "
            @click="askReject(party)"
          />
        </div>
      </li>
    </ul>
  </section>
</template>
