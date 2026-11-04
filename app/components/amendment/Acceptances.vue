<script setup lang="ts">
import type { AcceptanceDto, AmendmentDto } from "~~/shared/types/api";

/**
 * Parties of a transactional (the authors of its sources and the document
 * proponent) and their answers. A pending party answers for itself
 * (`can.accept`); the Mesa records the answer a party gives in the room.
 * The transactional can be voted only once every party accepted.
 */
const props = defineProps<{
  amendment: AmendmentDto;
  /** URL of the amendment: .../amendments/{id}. */
  url: string;
  actorMemberId: string | null;
}>();

const emit = defineEmits<{
  updated: [amendment: AmendmentDto];
  conflict: [];
}>();

const { t, locale } = useI18n();
const api = useApi();
const toast = useToast();
const titleId = useId();

const busy = ref<string | null>(null);

const open = computed(
  () =>
    props.amendment.status === "draft" ||
    props.amendment.status === "submitted",
);
const acceptedCount = computed(
  () =>
    props.amendment.acceptances.filter(
      (acceptance) => acceptance.decision === "accepted",
    ).length,
);
const allAccepted = computed(
  () =>
    props.amendment.acceptances.length > 0 &&
    acceptedCount.value === props.amendment.acceptances.length,
);

function isOwn(party: AcceptanceDto): boolean {
  return party.member.id === props.actorMemberId;
}

function canAnswer(party: AcceptanceDto): boolean {
  if (!open.value) return false;
  if (isOwn(party)) return props.amendment.can.accept;
  return props.amendment.can.moderate && party.decision === "pending";
}

async function answer(
  party: AcceptanceDto,
  decision: "accepted" | "rejected",
): Promise<void> {
  busy.value = `${party.member.id}:${decision}`;
  try {
    const updated = await api.send<AmendmentDto>(`${props.url}/acceptance`, {
      body: {
        decision,
        ...(isOwn(party) ? {} : { memberId: party.member.id }),
      },
    });
    toast.add({
      title: t("amendment.acceptances.recorded"),
      color: "success",
      icon: "i-lucide-check",
    });
    emit("updated", updated);
  } catch (error) {
    api.notifyError(error, "amendment.acceptances.failed");
    if (api.isConflict(error)) emit("conflict");
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
      <span class="text-muted text-xs tabular-nums">
        {{
          t("amendment.acceptances.summary", {
            accepted: acceptedCount,
            total: amendment.acceptances.length,
          })
        }}
      </span>
    </div>

    <p v-if="amendment.acceptances.length === 0" class="text-muted text-sm">
      {{ t("amendment.acceptances.none") }}
    </p>

    <ul v-else class="divide-default flex flex-col divide-y">
      <li
        v-for="party in amendment.acceptances"
        :key="party.member.id"
        class="flex flex-wrap items-center gap-2 py-2"
      >
        <CommonMemberBadge :member="party.member" size="xs" show-name />
        <span class="text-dimmed text-xs">
          {{ t(`amendment.acceptances.roles.${party.role}`) }}
        </span>
        <span class="ms-auto flex flex-wrap items-center gap-1.5">
          <CommonStatusBadge
            kind="acceptance"
            :value="party.decision"
            size="xs"
          />
          <span v-if="party.decidedAt" class="text-dimmed text-xs">
            {{ formatDateTime(party.decidedAt, { locale }) }}
          </span>
        </span>
        <div v-if="canAnswer(party)" class="flex w-full flex-wrap gap-2">
          <UButton
            icon="i-lucide-check"
            color="success"
            variant="soft"
            size="xs"
            :loading="busy === `${party.member.id}:accepted`"
            :disabled="busy !== null"
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
            icon="i-lucide-x"
            color="error"
            variant="soft"
            size="xs"
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
        </div>
      </li>
    </ul>

    <p
      v-if="open && amendment.acceptances.length > 0"
      class="text-muted text-xs"
    >
      {{
        allAccepted
          ? t("amendment.acceptances.ready")
          : t("amendment.acceptances.waiting")
      }}
    </p>
  </section>
</template>
