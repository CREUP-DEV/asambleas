<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import type { AmendmentDto } from "~~/shared/types/api";
import type { Block } from "~~/shared/types/content";
import {
  canRecordAdmission,
  isAwaitingAssembly,
  isAwaitingProponent,
  isAwaitingPublication,
  isAwaitingValidation,
  proponentAcceptance,
  type ReviewAmendmentAction,
} from "./-queue";

/**
 * One amendment in the validation inbox: who presents it, a sentence saying
 * where it stands, its changes over the published text and its
 * justification. The actions depend on where it stands:
 * - waiting for validation: "Validar y publicar" (main), "Pedir corrección"
 *   and, under "Más", "Validar sin publicar";
 * - validated but kept private: "Publicar";
 * - a transactional waiting for the document's presenter: none, it says who
 *   has to approve it first;
 * - late and waiting for the assembly: "La asamblea decide tratarla" (main),
 *   "No la trata" and, under "Más", "Publicar ya" while it is private.
 * The parent runs every action. The selection checkbox shows only when the
 * list has several amendments to act on.
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
    /** Several amendments of the list can be acted on at once. */
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

type Stage = "validate" | "proponent" | "publish" | "late" | null;

const stage = computed<Stage>(() => {
  if (isAwaitingAssembly(props.amendment)) return "late";
  if (isAwaitingValidation(props.amendment)) return "validate";
  if (isAwaitingProponent(props.amendment)) return "proponent";
  if (isAwaitingPublication(props.amendment)) return "publish";
  return null;
});

const canAct = computed(() => {
  switch (stage.value) {
    case "validate":
      return props.amendment.can.validate;
    case "publish":
      return props.amendment.can.publish;
    case "late":
      return canRecordAdmission(props.amendment);
    default:
      return false;
  }
});

const isPublic = computed(() => props.amendment.publishedAt !== null);
const presenter = computed(() => proponentAcceptance(props.amendment));

/** What happens next, in one sentence. */
const stateSentence = computed(() => {
  switch (stage.value) {
    case "publish":
      return t("review.amendments.validatedHidden");
    case "proponent":
      if (!presenter.value) return t("review.amendments.awaitingProponent");
      return presenter.value.decision === "rejected"
        ? t("review.amendments.rejectedByProponent", {
            member: presenter.value.member.acronym,
          })
        : t("review.amendments.awaitingProponentNamed", {
            member: presenter.value.member.acronym,
          });
    case "late":
      return isPublic.value
        ? t("review.late.waitingPublic")
        : t("review.late.waitingPrivate");
    default:
      return t("review.amendments.waiting");
  }
});

const stateIcon = computed(() => {
  switch (stage.value) {
    case "publish":
      return "i-lucide-lock";
    case "proponent":
      return presenter.value?.decision === "rejected"
        ? "i-lucide-circle-x"
        : "i-lucide-hourglass";
    case "late":
      return "i-lucide-scale";
    default:
      return "i-lucide-eye-off";
  }
});

/** Late ones still need the assembly's decision once validated. */
const lateNote = computed(
  () =>
    props.amendment.late &&
    props.amendment.admission === "pending" &&
    stage.value === "validate",
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

const moreItems = computed<DropdownMenuItem[]>(() => {
  if (stage.value === "validate") {
    return [
      {
        label: t("review.amendments.validateOnly"),
        description: t("review.amendments.validateOnlyHelp"),
        icon: "i-lucide-check",
        disabled: props.disabled,
        onSelect: () => emit("action", "validate_only"),
      },
    ];
  }
  if (
    stage.value === "late" &&
    !isPublic.value &&
    props.amendment.can.publish
  ) {
    return [
      {
        label: t("review.late.publishNow"),
        description: t("review.late.publishNowHelp"),
        icon: "i-lucide-megaphone",
        disabled: props.disabled,
        onSelect: () => emit("action", "publish"),
      },
    ];
  }
  return [];
});

const moreBusy = computed(
  () =>
    props.busy === "validate_only" ||
    (stage.value === "late" && props.busy === "publish"),
);
</script>

<template>
  <article
    class="border-default bg-default space-y-3 rounded-lg border p-4"
    :class="selected ? 'ring-primary border-primary ring-1' : ''"
    :aria-labelledby="titleId"
  >
    <div class="flex items-start gap-3">
      <UCheckbox
        v-if="multiSelect && canAct"
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
          <UBadge
            v-if="stage === 'late' && isPublic"
            color="neutral"
            variant="subtle"
            size="sm"
            icon="i-lucide-eye"
            :label="t('review.late.public')"
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
        <p
          v-if="
            amendment.kind === 'transactional' && amendment.sourceIds.length
          "
          class="text-muted text-sm"
        >
          {{
            t(
              "review.amendments.groupsAmendments",
              { count: amendment.sourceIds.length },
              amendment.sourceIds.length,
            )
          }}
        </p>
        <p v-if="amendment.submittedAt" class="text-muted text-sm">
          {{ t("review.amendments.sent") }}
          <time :datetime="amendment.submittedAt" :title="sentAbsolute">{{
            sentRelative
          }}</time>
        </p>
      </div>
    </div>

    <p
      class="flex items-start gap-1.5 text-sm"
      :class="stage === 'late' ? 'text-highlighted font-medium' : 'text-muted'"
    >
      <UIcon
        :name="stateIcon"
        class="mt-0.5 size-4 shrink-0"
        :class="stage === 'late' ? 'text-warning' : ''"
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

    <div v-if="canAct" class="flex flex-wrap gap-2">
      <template v-if="stage === 'validate'">
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
      </template>
      <UButton
        v-else-if="stage === 'publish'"
        icon="i-lucide-megaphone"
        :label="t('review.amendments.publish')"
        :loading="busy === 'publish'"
        :disabled="disabled && busy !== 'publish'"
        @click="emit('action', 'publish')"
      />
      <template v-else-if="stage === 'late'">
        <UButton
          icon="i-lucide-check"
          :label="t('review.late.treat')"
          :loading="busy === 'admit'"
          :disabled="disabled && busy !== 'admit'"
          @click="emit('action', 'admit')"
        />
        <UButton
          color="neutral"
          variant="outline"
          icon="i-lucide-x"
          :label="t('review.late.notTreat')"
          :loading="busy === 'inadmit'"
          :disabled="disabled && busy !== 'inadmit'"
          @click="emit('action', 'inadmit')"
        />
      </template>
      <UDropdownMenu
        v-if="moreItems.length > 0"
        :items="moreItems"
        :content="{ align: 'start' }"
      >
        <UButton
          color="neutral"
          variant="ghost"
          icon="i-lucide-ellipsis"
          :label="t('review.more')"
          :loading="moreBusy"
          :disabled="disabled && !moreBusy"
        />
      </UDropdownMenu>
    </div>
  </article>
</template>
