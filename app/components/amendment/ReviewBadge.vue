<script setup lang="ts">
import type { AmendmentDto } from "~~/shared/types/api";
import {
  amendmentReviewView,
  isAmendmentPresenter,
  isAmendmentPrivate,
} from "~/composables/amendment/workspace";

/**
 * Compact review state of an amendment for lists: a short badge ("En
 * revisión", "Corrección pedida", "Validada, sin publicar") and, whenever a
 * presented amendment is not public, who can see it. That line also covers
 * decided or withdrawn amendments that were never published, which have no
 * badge. Published amendments show nothing unless `showPublished`, so the
 * main list stays quiet.
 */
const props = withDefaults(
  defineProps<{
    amendment: AmendmentDto;
    showPublished?: boolean;
    /** Add the "who can see it" line under the badge. */
    showAudience?: boolean;
    /** Off when something else says where it stands (a transactional's progress). */
    showBadge?: boolean;
  }>(),
  { showPublished: false, showAudience: true, showBadge: true },
);

const { t } = useI18n();
const { member } = useMe();

const view = computed(() => amendmentReviewView(props.amendment));
const badge = computed(() =>
  props.showBadge &&
  view.value &&
  (props.showPublished || view.value.key !== "published")
    ? view.value
    : null,
);
/** Drafts say so in their badge; presented ones say who sees them. */
const showAudienceLine = computed(
  () =>
    props.showAudience &&
    props.amendment.status !== "draft" &&
    isAmendmentPrivate(props.amendment),
);
/** Once validated, the CEA and the document's presenters read it too. */
const audience = computed(() => {
  if (!isAmendmentPresenter(props.amendment, member.value?.id ?? null)) {
    return t("amendment.review.audience.others");
  }
  return props.amendment.validatedAt
    ? t("amendment.review.audience.authorValidated")
    : t("amendment.review.audience.author");
});
</script>

<template>
  <span
    v-if="badge || showAudienceLine"
    class="flex flex-col items-start gap-1"
  >
    <UBadge
      v-if="badge"
      :color="badge.color"
      variant="subtle"
      size="xs"
      :icon="badge.icon"
      :label="t(`amendment.review.badges.${badge.key}`)"
      class="whitespace-nowrap"
    />
    <span
      v-if="showAudienceLine"
      class="text-muted flex items-center gap-1 text-xs"
    >
      <UIcon
        name="i-lucide-eye-off"
        class="size-3.5 shrink-0"
        aria-hidden="true"
      />
      {{ audience }}
    </span>
  </span>
</template>
