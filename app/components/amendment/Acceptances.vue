<script setup lang="ts">
import type { AcceptanceDto, AmendmentDto } from "~~/shared/types/api";
import { transactionalPresenterParty } from "~/composables/amendment/transactional";

/**
 * Parties of a transactional (the authors of its sources and the document's
 * presenter) and their answers. A pending party answers for itself
 * (`can.accept`): the presenter approves it, the authors accept it. The
 * presenter is found by member (`proponentMemberId`): when it also wrote a
 * source its row has the role "author", but it is still the presenter. The
 * Mesa records the answer a party gives in the room. Where the
 * transactional stands as a whole (and whether it can be voted) is said
 * once, by the review panel above, so this list does not repeat it.
 */
const props = defineProps<{
  amendment: AmendmentDto;
  /** URL of the amendment: .../amendments/{id}. */
  url: string;
  actorMemberId: string | null;
  /** The document's presenter (document.proponent). */
  proponentMemberId?: string | null;
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

function isOwn(party: AcceptanceDto): boolean {
  return party.member.id === props.actorMemberId;
}

/** The presenter's row, whatever its role. */
const presenterId = computed(
  () =>
    transactionalPresenterParty(
      props.amendment.acceptances,
      props.proponentMemberId ?? null,
    )?.member.id ?? null,
);

function isPresenter(party: AcceptanceDto): boolean {
  return party.member.id === presenterId.value;
}

/** Said of the presenter as such, also when it wrote a source. */
function roleLabel(party: AcceptanceDto): string {
  return t(
    `amendment.acceptances.roles.${isPresenter(party) ? "proponent" : party.role}`,
  );
}

/**
 * The presenter "approves" it while that is the step it waits for (as the
 * status sentence says); otherwise every party "accepts" it.
 */
function acceptLabel(party: AcceptanceDto): string {
  if (!isOwn(party)) {
    return t("amendment.acceptances.recordAccept", {
      member: party.member.acronym,
    });
  }
  return isPresenter(party) &&
    props.amendment.reviewState === "pending_proponent"
    ? t("amendment.acceptances.approve")
    : t("amendment.acceptances.accept");
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
          {{ roleLabel(party) }}
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
            :label="acceptLabel(party)"
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
  </section>
</template>
