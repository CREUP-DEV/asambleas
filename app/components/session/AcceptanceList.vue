<script setup lang="ts">
import type { AmendmentDto } from "~~/shared/types/api";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";

/**
 * Parties of a transactional and their answers. The Mesa records an answer
 * given in the room with the "accepted in the room" switch; switching it off
 * records a rejection.
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

function onToggle(memberId: string, value: boolean): void {
  void session.recordAcceptance(
    props.amendment.id,
    memberId,
    value ? "accepted" : "rejected",
  );
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
        <USwitch
          :model-value="party.decision === 'accepted'"
          :label="t('session.acceptance.inRoom')"
          :loading="busyFor(party.member.id)"
          :disabled="decided || busyFor(party.member.id)"
          size="sm"
          @update:model-value="(value) => onToggle(party.member.id, value)"
        />
      </li>
    </ul>
  </section>
</template>
