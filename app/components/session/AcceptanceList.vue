<script setup lang="ts">
import type { AcceptanceDto, AmendmentDto } from "~~/shared/types/api";
import {
  isSessionReplacing,
  isSessionSuperseded,
  sessionPartySourceIds,
} from "~/composables/session/sessionModel";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";

/**
 * The parties of a transactional and their answers: the main author of each
 * amendment it would replace, named with the amendments it answers for.
 *
 * While it waits for them, the Mesa records the answer each one gives in
 * the room with an explicit accept or reject button (every button names
 * its party), and a line says what accepting does. Two answers cannot be
 * taken back, so the Mesa confirms them first: a rejection closes the
 * transactional for good (its amendments carry on), and the acceptance that
 * completes a validated one replaces those amendments for good. An
 * acceptance that leaves it waiting can still be corrected.
 *
 * Once it replaced them, the answers are final: the list folds into one
 * read-only line (who accepted it, and when), and the parent says what it
 * replaced. A transactional another one got ahead of shows the answers
 * without buttons: only its withdrawal settles it.
 */
const props = defineProps<{ amendment: AmendmentDto }>();

const session = useSessionConsoleContext();
const { t, locale } = useI18n();

/** It replaced what it groups: the answers that made it happen are final. */
const replacing = computed(
  () =>
    props.amendment.status === "submitted" &&
    isSessionReplacing(props.amendment),
);
const superseded = computed(() =>
  isSessionSuperseded(props.amendment, session.byId.value),
);
/** No answer can be recorded or changed any more. */
const locked = computed(
  () =>
    props.amendment.status !== "submitted" ||
    replacing.value ||
    superseded.value,
);
const accepted = computed(
  () =>
    props.amendment.acceptances.filter((party) => party.decision === "accepted")
      .length,
);

const codes = (ids: string[]) => ids.map(session.label).join(", ");
const code = computed(() => session.label(props.amendment.id));
const sourceCodes = computed(() => codes(props.amendment.sourceIds));

/** Which amendments a party answers for, or its role when unknown. */
function answersFor(party: AcceptanceDto): string {
  const ids = sessionPartySourceIds(
    props.amendment,
    party.member.id,
    session.byId.value,
  );
  return ids.length > 0
    ? t("session.acceptance.mainAuthorOf", { codes: codes(ids) })
    : t(`session.enums.acceptanceRole.${party.role}`);
}

/** Who accepted it, for the folded line, and the time of the last answer. */
const acceptedBy = computed(() =>
  props.amendment.acceptances.map((party) => party.member.acronym).join(", "),
);
const lastAnswerAt = computed(() => {
  const times = props.amendment.acceptances
    .map((party) => (party.decidedAt ? new Date(party.decidedAt).getTime() : 0))
    .filter((time) => Number.isFinite(time) && time > 0);
  return times.length > 0 ? new Date(Math.max(...times)).toISOString() : null;
});

function busyFor(memberId: string): boolean {
  return Boolean(
    session.busy.value[`acceptance-${props.amendment.id}-${memberId}`],
  );
}

type Answer = "accepted" | "rejected";

/** The answer being recorded for each party, to show it as loading. */
const sending = ref<Record<string, Answer>>({});

/**
 * Whether this acceptance is the last one a validated transactional waits
 * for: recording it replaces the amendments it groups.
 */
function completes(party: AcceptanceDto): boolean {
  return (
    props.amendment.validatedAt !== null &&
    props.amendment.acceptances.every(
      (other) =>
        other.member.id === party.member.id || other.decision === "accepted",
    )
  );
}

/** Asks before an answer that cannot be taken back; true to go on. */
async function confirmed(
  party: AcceptanceDto,
  decision: Answer,
): Promise<boolean> {
  const params = {
    member: party.member.acronym,
    code: code.value,
    codes: sourceCodes.value,
  };
  const items = props.amendment.sourceIds.map(session.label);
  if (decision === "rejected") {
    return session.confirm({
      title: t("session.acceptance.confirmReject.title", params),
      description: t("session.acceptance.confirmReject.description", params),
      items,
      confirmLabel: t("session.acceptance.confirmReject.confirm"),
      confirmIcon: "i-lucide-x",
      confirmColor: "error",
    });
  }
  if (!completes(party)) return true;
  return session.confirm({
    title: t("session.acceptance.confirmComplete.title", params),
    description: t("session.acceptance.confirmComplete.description", params),
    items,
    confirmLabel: t("session.acceptance.confirmComplete.confirm"),
    confirmIcon: "i-lucide-check",
    confirmColor: "primary",
  });
}

async function answer(party: AcceptanceDto, decision: Answer): Promise<void> {
  const memberId = party.member.id;
  if (locked.value || party.decision === decision || busyFor(memberId)) {
    return;
  }
  if (!(await confirmed(party, decision))) return;
  sending.value = { ...sending.value, [memberId]: decision };
  try {
    await session.recordAcceptance(props.amendment.id, memberId, decision);
  } finally {
    const { [memberId]: _done, ...rest } = sending.value;
    sending.value = rest;
  }
}
</script>

<template>
  <!-- Replaced what it groups: the answers are final, one line says so. -->
  <p
    v-if="replacing"
    class="text-default flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm"
  >
    <UIcon
      name="i-lucide-handshake"
      class="text-success size-4 shrink-0"
      aria-hidden="true"
    />
    <span>
      {{
        amendment.acceptances.length > 0
          ? t("session.acceptance.acceptedBy", { members: acceptedBy })
          : t("session.acceptance.none")
      }}
    </span>
    <time
      v-if="lastAnswerAt"
      :datetime="lastAnswerAt"
      class="text-muted tabular-nums"
    >
      {{ formatTime(lastAnswerAt, { locale }) }}
    </time>
  </p>

  <section v-else class="space-y-2">
    <h4 class="text-highlighted flex items-center gap-2 text-sm font-medium">
      <UIcon name="i-lucide-handshake" class="size-4" aria-hidden="true" />
      {{
        t("session.acceptance.title", {
          accepted,
          total: amendment.acceptances.length,
        })
      }}
    </h4>
    <p
      v-if="!locked && amendment.sourceIds.length > 0"
      class="text-muted text-sm"
    >
      {{ t("session.acceptance.willReplace", { codes: sourceCodes }) }}
    </p>
    <p v-if="amendment.acceptances.length === 0" class="text-muted text-sm">
      {{ t("session.acceptance.none") }}
    </p>
    <ul v-else class="border-default divide-default divide-y rounded-lg border">
      <li
        v-for="party in amendment.acceptances"
        :key="party.member.id"
        class="flex flex-wrap items-center gap-2 px-3 py-2"
      >
        <CommonMemberBadge :member="party.member" size="sm" />
        <span class="text-muted text-xs">{{ answersFor(party) }}</span>
        <CommonStatusBadge
          kind="acceptance"
          :value="party.decision"
          size="sm"
          class="ms-auto"
        />
        <UFieldGroup
          v-if="!locked"
          size="xs"
          role="group"
          :aria-label="
            t('session.acceptance.answerFor', { member: party.member.acronym })
          "
        >
          <UButton
            icon="i-lucide-check"
            color="success"
            :variant="party.decision === 'accepted' ? 'solid' : 'outline'"
            :aria-pressed="party.decision === 'accepted'"
            :label="
              t('amendment.acceptances.recordAccept', {
                member: party.member.acronym,
              })
            "
            :loading="sending[party.member.id] === 'accepted'"
            :disabled="busyFor(party.member.id)"
            @click="answer(party, 'accepted')"
          />
          <UButton
            icon="i-lucide-x"
            color="error"
            :variant="party.decision === 'rejected' ? 'solid' : 'outline'"
            :aria-pressed="party.decision === 'rejected'"
            :label="
              t('amendment.acceptances.recordReject', {
                member: party.member.acronym,
              })
            "
            :loading="sending[party.member.id] === 'rejected'"
            :disabled="busyFor(party.member.id)"
            @click="answer(party, 'rejected')"
          />
        </UFieldGroup>
      </li>
    </ul>
  </section>
</template>
