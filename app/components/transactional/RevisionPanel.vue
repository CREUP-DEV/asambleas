<script setup lang="ts">
import type { AmendmentDto } from "~~/shared/types/api";
import type { Block } from "~~/shared/types/content";

/**
 * An inclusion proposed on a transactional and not resolved yet (user's
 * decision of 2026-11-19): the amendments it adds, the new text against the
 * original, and every party's answer. Its parties accept or reject it (the
 * Mesa records answers given in the room), the Secretaría validates a
 * member's once all accept, and whoever proposed it, the Mesa or the
 * Secretaría withdraw it. A rejection leaves the transactional as it was.
 */
const props = defineProps<{
  amendment: AmendmentDto;
  base: Block[];
  /** Base URL of the document's amendments: .../amendments. */
  amendmentsUrl: string;
  labelOf: (id: string) => string;
}>();

const emit = defineEmits<{ updated: [amendment: AmendmentDto] }>();

const { t } = useI18n();
const api = useApi();
const toast = useToast();
const { member } = useMe();

const revision = computed(() => props.amendment.openRevision ?? null);
const added = computed(() =>
  (revision.value?.addedSourceIds ?? []).map((id) => props.labelOf(id)),
);
const pending = computed(
  () =>
    revision.value?.acceptances.filter(
      (party) => party.decision === "pending",
    ) ?? [],
);
const moderate = computed(() => props.amendment.can.moderate);

/** Who may record each pending answer: the party itself, or the Mesa. */
function answerable(memberId: string): boolean {
  if (!revision.value?.can.answer) return false;
  return moderate.value || member.value?.id === memberId;
}

const busy = ref<string | null>(null);

async function post(
  path: string,
  body: Record<string, unknown> | undefined,
  key: string,
  done: string,
): Promise<void> {
  if (!revision.value || busy.value) return;
  busy.value = key;
  try {
    const result = await api.send<AmendmentDto>(
      `${props.amendmentsUrl}/${encodeURIComponent(props.amendment.id)}/revisions/${encodeURIComponent(revision.value.id)}/${path}`,
      body ? { body } : {},
    );
    emit("updated", result);
    toast.add({ title: done, color: "success", icon: "i-lucide-check" });
  } catch (error) {
    api.notifyError(error, "transactional.revision.failed");
  } finally {
    busy.value = null;
  }
}

function answer(memberId: string, decision: "accepted" | "rejected"): void {
  void post(
    "acceptance",
    {
      decision,
      ...(memberId !== member.value?.id ? { memberId } : {}),
    },
    `${memberId}:${decision}`,
    decision === "accepted"
      ? t("transactional.revision.accepted")
      : t("transactional.revision.rejected"),
  );
}
</script>

<template>
  <section
    v-if="revision"
    class="border-warning/40 bg-warning/5 flex flex-col gap-3 rounded-md border p-3 sm:p-4"
    :aria-label="t('transactional.revision.title')"
  >
    <div class="flex items-start gap-2">
      <UIcon
        name="i-lucide-git-pull-request-arrow"
        class="text-warning mt-0.5 size-4 shrink-0"
        aria-hidden="true"
      />
      <div class="min-w-0 space-y-1">
        <h3 class="text-highlighted text-sm font-semibold">
          {{ t("transactional.revision.title") }}
        </h3>
        <p class="text-default text-sm">
          {{
            t("transactional.revision.adds", {
              list: added.join(", ") || t("transactional.revision.addsNone"),
            })
          }}
        </p>
        <p class="text-muted text-sm">
          {{
            revision.status === "pending_validation"
              ? t("transactional.revision.awaitsValidation")
              : t("transactional.revision.awaitsParties", {
                  members: pending
                    .map((party) => party.member.acronym)
                    .join(", "),
                })
          }}
        </p>
      </div>
    </div>

    <div class="border-default bg-default rounded-md border p-3">
      <p class="text-muted mb-2 text-xs">
        {{ t("transactional.revision.newText") }}
      </p>
      <ContentAmendmentDiff
        :id="`${amendment.id}-revision`"
        :base="base"
        :ops="revision.ops"
        :context="1"
      />
    </div>
    <p
      v-if="
        revision.justification &&
        revision.justification !== amendment.justification
      "
      class="text-default text-sm whitespace-pre-line"
    >
      {{ revision.justification }}
    </p>

    <ul class="flex flex-col gap-1.5">
      <li
        v-for="party in revision.acceptances"
        :key="party.member.id"
        class="flex flex-wrap items-center gap-2 text-sm"
      >
        <CommonMemberBadge :member="party.member" />
        <span class="text-muted">
          {{ t(`transactional.revision.decision.${party.decision}`) }}
        </span>
        <template
          v-if="party.decision === 'pending' && answerable(party.member.id)"
        >
          <UButton
            size="xs"
            color="success"
            variant="soft"
            icon="i-lucide-check"
            :label="t('transactional.revision.accept')"
            :loading="busy === `${party.member.id}:accepted`"
            :disabled="busy !== null"
            @click="answer(party.member.id, 'accepted')"
          />
          <UButton
            size="xs"
            color="error"
            variant="soft"
            icon="i-lucide-x"
            :label="t('transactional.revision.reject')"
            :loading="busy === `${party.member.id}:rejected`"
            :disabled="busy !== null"
            @click="answer(party.member.id, 'rejected')"
          />
        </template>
      </li>
    </ul>

    <div
      v-if="revision.can.validate || revision.can.cancel"
      class="flex flex-wrap gap-2"
    >
      <UButton
        v-if="revision.can.validate"
        size="sm"
        icon="i-lucide-badge-check"
        :label="t('transactional.revision.validate')"
        :loading="busy === 'validate'"
        :disabled="busy !== null"
        @click="
          post(
            'validate',
            undefined,
            'validate',
            t('transactional.revision.validated'),
          )
        "
      />
      <UButton
        v-if="revision.can.cancel"
        size="sm"
        color="neutral"
        variant="outline"
        icon="i-lucide-undo-2"
        :label="t('transactional.revision.cancel')"
        :loading="busy === 'cancel'"
        :disabled="busy !== null"
        @click="
          post(
            'cancel',
            undefined,
            'cancel',
            t('transactional.revision.cancelled'),
          )
        "
      />
    </div>
  </section>
</template>
