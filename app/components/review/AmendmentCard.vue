<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import type { AmendmentDto } from "~~/shared/types/api";
import type { Block } from "~~/shared/types/content";
import {
  isAwaitingPublication,
  isAwaitingValidation,
  type ReviewAmendmentAction,
} from "./-queue";

/**
 * One amendment in the validation inbox: who presents it, a sentence saying
 * where it stands, its changes over the published text and its
 * justification. Waiting for validation: "Validar y publicar" (main),
 * "Pedir corrección" and, under "Más", "Validar sin publicar". Validated but
 * kept private: "Publicar". The parent runs every action. The selection
 * checkbox shows only when the document has several amendments to act on.
 */
const props = withDefaults(
  defineProps<{
    amendment: AmendmentDto;
    /** Blocks of the document's published text; null while loading. */
    base: Block[] | null;
    baseLoading?: boolean;
    /** The action running on this amendment, if any. */
    busy?: ReviewAmendmentAction | null;
    /** Another action is running elsewhere: keep the buttons quiet. */
    disabled?: boolean;
    /** Several amendments of the document can be acted on at once. */
    multiSelect?: boolean;
  }>(),
  { baseLoading: false, busy: null, disabled: false, multiSelect: false },
);

const selected = defineModel<boolean>("selected", { default: false });
const emit = defineEmits<{ action: [action: ReviewAmendmentAction] }>();

const { t, locale } = useI18n();
const now = useAppNow();

const titleId = useId();

const label = computed(
  () => amendmentDisplayLabel(props.amendment) ?? t("review.amendments.noCode"),
);

const toValidate = computed(() => isAwaitingValidation(props.amendment));
const toPublish = computed(() => isAwaitingPublication(props.amendment));
const selectable = computed(
  () =>
    (toValidate.value && props.amendment.can.validate) ||
    (toPublish.value && props.amendment.can.publish),
);

/** What happens next, in one sentence. */
const stateSentence = computed(() => {
  if (toPublish.value) return t("review.amendments.validatedHidden");
  return t("review.amendments.waiting");
});

/** Late ones still need the Mesa's admission once validated. */
const lateNote = computed(
  () =>
    props.amendment.late &&
    props.amendment.admission === "pending" &&
    (toValidate.value || toPublish.value),
);

const sentRelative = computed(() =>
  props.amendment.submittedAt
    ? formatRelative(props.amendment.submittedAt, {
        locale: locale.value,
        now: now.value,
      })
    : "",
);
const sentAbsolute = computed(() =>
  formatDateTime(props.amendment.submittedAt, {
    locale: locale.value,
    style: "long",
  }),
);

// The changes start open, except a whole alternative text, which is long.
const changesOpen = ref(props.amendment.kind !== "totality_alternative");

const moreItems = computed<DropdownMenuItem[]>(() => [
  {
    label: t("review.amendments.validateOnly"),
    description: t("review.amendments.validateOnlyHelp"),
    icon: "i-lucide-check",
    disabled: props.disabled,
    onSelect: () => emit("action", "validate_only"),
  },
]);
</script>

<template>
  <article
    class="border-default bg-default space-y-3 rounded-lg border p-4"
    :class="selected ? 'ring-primary border-primary ring-1' : ''"
    :aria-labelledby="titleId"
  >
    <div class="flex items-start gap-3">
      <UCheckbox
        v-if="multiSelect && selectable"
        v-model="selected"
        class="mt-0.5"
        :aria-label="t('review.amendments.select', { label })"
      />
      <div class="min-w-0 flex-1 space-y-1">
        <div class="flex flex-wrap items-center gap-1.5">
          <h5 :id="titleId" class="text-highlighted font-semibold tabular-nums">
            {{ label }}
          </h5>
          <UBadge
            v-if="amendment.kind !== 'partial'"
            color="neutral"
            variant="outline"
            size="sm"
            :label="t(`amendment.kinds.${amendment.kind}`)"
          />
          <UBadge
            v-if="amendment.late"
            color="warning"
            variant="subtle"
            size="sm"
            icon="i-lucide-clock-alert"
            :label="t('amendment.late')"
          />
        </div>
        <div class="flex flex-wrap items-center gap-1.5 text-sm">
          <span class="text-muted">{{
            t("review.amendments.presentedBy")
          }}</span>
          <template v-if="amendment.authors.length > 0">
            <CommonMemberBadge
              v-for="author in amendment.authors"
              :key="author.id"
              :member="author"
              :show-name="amendment.authors.length === 1"
            />
          </template>
          <span v-else class="text-dimmed">{{ t("review.noPresenter") }}</span>
        </div>
        <p v-if="amendment.submittedAt" class="text-muted text-sm">
          {{ t("review.amendments.sent") }}
          <time :datetime="amendment.submittedAt" :title="sentAbsolute">{{
            sentRelative
          }}</time>
        </p>
      </div>
    </div>

    <p class="text-muted flex items-start gap-1.5 text-sm">
      <UIcon
        :name="toPublish ? 'i-lucide-lock' : 'i-lucide-eye-off'"
        class="mt-0.5 size-4 shrink-0"
        aria-hidden="true"
      />
      <span>{{ stateSentence }}</span>
    </p>
    <p
      v-if="lateNote"
      class="text-warning flex items-start gap-1.5 text-sm font-medium"
    >
      <UIcon
        name="i-lucide-clock-alert"
        class="mt-0.5 size-4 shrink-0"
        aria-hidden="true"
      />
      <span>{{ t("review.amendments.lateNote") }}</span>
    </p>

    <UCollapsible v-model:open="changesOpen" class="space-y-2">
      <UButton
        color="neutral"
        variant="link"
        size="sm"
        class="px-0"
        :trailing-icon="
          changesOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'
        "
        :label="t('amendment.detail.changes')"
      />
      <template #content>
        <div class="space-y-2">
          <p v-if="amendment.globalReplace" class="text-sm">
            <UIcon
              name="i-lucide-replace-all"
              class="text-muted me-1 size-4 align-text-bottom"
              aria-hidden="true"
            />{{
              t("amendment.detail.globalReplace", {
                find: amendment.globalReplace.find,
                replace: amendment.globalReplace.replace,
              })
            }}
          </p>
          <div class="border-default rounded-md border p-3">
            <div
              v-if="base === null && baseLoading"
              class="space-y-2"
              aria-busy="true"
              :aria-label="t('review.amendments.loadingText')"
            >
              <USkeleton class="h-4 w-full" />
              <USkeleton class="h-4 w-3/4" />
            </div>
            <p v-else-if="base === null" class="text-muted text-sm">
              {{ t("review.amendments.textUnavailable") }}
            </p>
            <ContentAmendmentDiff
              v-else
              :id="amendment.id"
              :base="base"
              :ops="amendment.ops"
              :focus="amendment.id"
            >
              <template v-if="amendment.kind === 'totality_return'" #note>
                <UAlert
                  color="neutral"
                  variant="subtle"
                  icon="i-lucide-file-x"
                  :title="t('amendment.kinds.totality_return')"
                  :description="t('amendment.detail.returnNote')"
                />
              </template>
            </ContentAmendmentDiff>
          </div>
        </div>
      </template>
    </UCollapsible>

    <div class="space-y-1">
      <p class="text-highlighted text-sm font-medium">
        {{ t("amendment.detail.justification") }}
      </p>
      <p
        v-if="amendment.justification"
        class="content-font text-default text-sm whitespace-pre-line"
      >
        {{ amendment.justification }}
      </p>
      <p v-else class="text-muted text-sm">
        {{ t("amendment.detail.noJustification") }}
      </p>
    </div>

    <div
      v-if="
        (toValidate && amendment.can.validate) ||
        (toPublish && amendment.can.publish)
      "
      class="flex flex-wrap gap-2"
    >
      <template v-if="toValidate">
        <UButton
          icon="i-lucide-check-check"
          :label="t('review.amendments.validatePublish')"
          :loading="busy === 'validate_publish'"
          :disabled="disabled && busy !== 'validate_publish'"
          @click="emit('action', 'validate_publish')"
        />
        <UButton
          color="neutral"
          variant="outline"
          icon="i-lucide-undo-2"
          :label="t('review.askCorrection')"
          :loading="busy === 'correction'"
          :disabled="disabled && busy !== 'correction'"
          @click="emit('action', 'correction')"
        />
        <UDropdownMenu :items="moreItems" :content="{ align: 'start' }">
          <UButton
            color="neutral"
            variant="ghost"
            icon="i-lucide-ellipsis"
            :label="t('review.more')"
            :loading="busy === 'validate_only'"
            :disabled="disabled && busy !== 'validate_only'"
          />
        </UDropdownMenu>
      </template>
      <UButton
        v-else
        icon="i-lucide-megaphone"
        :label="t('review.amendments.publish')"
        :loading="busy === 'publish'"
        :disabled="disabled && busy !== 'publish'"
        @click="emit('action', 'publish')"
      />
    </div>
  </article>
</template>
