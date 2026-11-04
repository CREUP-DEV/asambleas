<script setup lang="ts">
import type { AcceptanceDto, AmendmentDto } from "~~/shared/types/api";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";

/**
 * Parties of a transactional and their answers. The Mesa records the answer
 * each party gives in the room with an explicit accept or reject button, so
 * a pending party can be recorded as rejecting it directly, and a recorded
 * answer can be corrected. Every button names its party.
 */
const props = defineProps<{ amendment: AmendmentDto }>();

const session = useSessionConsoleContext();
const { t } = useI18n();

const decided = computed(() => props.amendment.status !== "submitted");
const accepted = computed(
  () =>
    props.amendment.acceptances.filter((party) => party.decision === "accepted")
      .length,
);

function busyFor(memberId: string): boolean {
  return Boolean(
    session.busy.value[`acceptance-${props.amendment.id}-${memberId}`],
  );
}

type Answer = "accepted" | "rejected";

/** The answer being recorded for each party, to show it as loading. */
const sending = ref<Record<string, Answer>>({});

async function answer(party: AcceptanceDto, decision: Answer): Promise<void> {
  const memberId = party.member.id;
  if (party.decision === decision || busyFor(memberId)) return;
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
  <section class="space-y-2">
    <h4 class="text-highlighted flex items-center gap-2 text-sm font-medium">
      <UIcon name="i-lucide-handshake" class="size-4" aria-hidden="true" />
      {{
        t("session.acceptance.title", {
          accepted,
          total: amendment.acceptances.length,
        })
      }}
    </h4>
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
        <span class="text-muted text-xs">
          {{ t(`session.enums.acceptanceRole.${party.role}`) }}
        </span>
        <CommonStatusBadge
          kind="acceptance"
          :value="party.decision"
          size="sm"
          class="ms-auto"
        />
        <UFieldGroup
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
            :disabled="decided || busyFor(party.member.id)"
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
            :disabled="decided || busyFor(party.member.id)"
            @click="answer(party, 'rejected')"
          />
        </UFieldGroup>
      </li>
    </ul>
  </section>
</template>
