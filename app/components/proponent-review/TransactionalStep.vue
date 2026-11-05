<script setup lang="ts">
import type { AcceptanceDecision } from "~~/shared/constants/domain";
import type { AmendmentDto } from "~~/shared/types/api";
import type { Block } from "~~/shared/types/content";
import type { AcceptanceTarget } from "./-review";

type Decision = Exclude<AcceptanceDecision, "pending">;

/**
 * A transactional waiting for the document's presenter: who proposes it,
 * which amendments it groups (their changes fold away), the text it
 * proposes over the published one in large type, its justification, and
 * "Aprobar" or "Rechazar". The Mesa records the presenter's answer instead
 * ("Registrar que CEA-AC la aprueba"). Rejecting asks for confirmation: the
 * presenter cannot change its answer afterwards.
 */
const props = withDefaults(
  defineProps<{
    amendment: AmendmentDto;
    base: Block[];
    /** The amendments it groups, as the actor sees them. */
    sources: AmendmentDto[];
    /** "12 · CEUM 4" for an amendment id. */
    labelOf: (id: string) => string;
    target: AcceptanceTarget;
    /** The answer being saved, if any. */
    busy?: Decision | null;
    disabled?: boolean;
  }>(),
  { busy: null, disabled: false },
);

const emit = defineEmits<{ answer: [decision: Decision] }>();

const { t } = useI18n();
const titleId = useId();
const answerId = useId();
const heading = useTemplateRef<HTMLElement>("heading");

const label = computed(
  () => amendmentDisplayLabel(props.amendment) ?? t("proponentReview.noCode"),
);
/** The Mesa answers for the presenter's member. */
const forMember = computed(() =>
  props.target.memberId ? props.target.party.member : null,
);
/** Proposed by a member: once approved, the Secretaría checks it. */
const beforeSecretaria = computed(
  () => props.amendment.reviewState === "pending_proponent",
);

const stateSentence = computed(() => {
  const next = beforeSecretaria.value ? "toSecretaria" : "toParties";
  return forMember.value
    ? t(`proponentReview.transactional.waitingFor.${next}`, {
        member: forMember.value.acronym,
      })
    : t(`proponentReview.transactional.waiting.${next}`);
});

const sourcesOpen = ref(false);
const confirmOpen = ref(false);

function approve(): void {
  if (props.busy === null) emit("answer", "accepted");
}

function confirmReject(): void {
  confirmOpen.value = false;
  if (props.busy === null) emit("answer", "rejected");
}

defineExpose({
  focus: () => heading.value?.focus(),
});
</script>

<template>
  <article class="space-y-6" :aria-labelledby="titleId">
    <header class="space-y-2">
      <div class="flex flex-wrap items-center gap-2">
        <h3
          :id="titleId"
          ref="heading"
          tabindex="-1"
          class="text-highlighted text-2xl font-bold tabular-nums outline-none"
        >
          {{ label }}
        </h3>
        <UBadge
          color="neutral"
          variant="outline"
          :label="t('amendment.kinds.transactional')"
        />
      </div>

      <div class="flex flex-wrap items-center gap-1.5 text-sm">
        <span class="text-muted">{{
          t("proponentReview.transactional.proposedBy")
        }}</span>
        <CommonMemberBadge
          v-for="author in amendment.authors"
          :key="author.id"
          :member="author"
          :show-name="amendment.authors.length === 1"
        />
      </div>

      <p class="text-default flex items-start gap-1.5 text-sm">
        <UIcon
          name="i-lucide-hourglass"
          class="text-warning mt-0.5 size-4 shrink-0"
          aria-hidden="true"
        />
        <span>{{ stateSentence }}</span>
      </p>
    </header>

    <section v-if="amendment.sourceIds.length > 0" class="space-y-2">
      <h4 class="text-highlighted text-sm font-semibold">
        {{ t("proponentReview.transactional.groups") }}
      </h4>
      <ul class="flex flex-wrap gap-1.5">
        <li v-for="id in amendment.sourceIds" :key="id">
          <UBadge
            color="neutral"
            variant="subtle"
            class="tabular-nums"
            :label="labelOf(id)"
          />
        </li>
      </ul>
      <UCollapsible
        v-if="sources.length > 0"
        v-model:open="sourcesOpen"
        class="space-y-3"
      >
        <UButton
          color="neutral"
          variant="link"
          size="sm"
          class="px-0"
          :trailing-icon="
            sourcesOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'
          "
          :label="
            sourcesOpen
              ? t('proponentReview.transactional.hideSources')
              : t('proponentReview.transactional.showSources')
          "
        />
        <template #content>
          <div class="space-y-4">
            <ProponentReviewChange
              v-for="source in sources"
              :key="source.id"
              :amendment="source"
              :base="base"
              :title="labelOf(source.id)"
              compact
            />
          </div>
        </template>
      </UCollapsible>
    </section>

    <ProponentReviewChange
      :amendment="amendment"
      :base="base"
      :title="t('proponentReview.transactional.proposal')"
    />

    <section class="space-y-1">
      <h4 class="text-highlighted text-sm font-semibold">
        {{ t("amendment.detail.justification") }}
      </h4>
      <p
        v-if="amendment.justification"
        class="content-font text-default whitespace-pre-line"
      >
        {{ amendment.justification }}
      </p>
      <p v-else class="text-muted text-sm">
        {{ t("amendment.detail.noJustification") }}
      </p>
    </section>

    <section
      class="border-default bg-elevated/40 space-y-3 rounded-lg border p-4"
      :aria-labelledby="answerId"
    >
      <h4 :id="answerId" class="text-highlighted font-semibold">
        {{ t("proponentReview.answer.title") }}
      </h4>
      <p v-if="!forMember" class="text-muted text-sm">
        {{ t("proponentReview.transactional.final") }}
      </p>
      <div class="flex flex-col gap-2 sm:flex-row">
        <UButton
          color="success"
          size="lg"
          icon="i-lucide-check"
          class="justify-center"
          :loading="busy === 'accepted'"
          :disabled="disabled || busy === 'rejected'"
          :label="
            forMember
              ? t('proponentReview.transactional.approveFor', {
                  member: forMember.acronym,
                })
              : t('proponentReview.transactional.approve')
          "
          @click="approve"
        />
        <UButton
          color="error"
          variant="outline"
          size="lg"
          icon="i-lucide-x"
          class="justify-center"
          :loading="busy === 'rejected'"
          :disabled="disabled || busy === 'accepted'"
          :label="
            forMember
              ? t('proponentReview.transactional.rejectFor', {
                  member: forMember.acronym,
                })
              : t('proponentReview.transactional.reject')
          "
          @click="confirmOpen = true"
        />
      </div>
    </section>

    <UModal
      v-model:open="confirmOpen"
      :title="t('proponentReview.transactional.rejectTitle', { label })"
      :description="
        forMember
          ? t('proponentReview.transactional.rejectDescriptionFor', {
              member: forMember.acronym,
            })
          : t('proponentReview.transactional.rejectDescription')
      "
    >
      <template #footer>
        <div class="flex w-full flex-wrap justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            :label="t('common.cancel')"
            @click="confirmOpen = false"
          />
          <UButton
            color="error"
            icon="i-lucide-x"
            :label="t('proponentReview.transactional.rejectConfirm')"
            @click="confirmReject"
          />
        </div>
      </template>
    </UModal>
  </article>
</template>
