<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import type { AmendmentDto } from "~~/shared/types/api";
import { PROPONENT_POSITIONS } from "~~/shared/constants/domain";
import {
  SESSION_REOPENABLE,
  isSessionAwaitingValidation,
  isSessionOpen,
  isSessionPendingAdmission,
  isSessionPublishable,
  isSessionUnpublished,
  isSessionValidatable,
  sessionMissingAcceptances,
} from "~/composables/session/sessionModel";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";

/**
 * One amendment of the console queue: who presents it, its kind, the
 * proponent's position, admission and status, and the Mesa's actions. The
 * amendment under debate shows its changes and, for a transactional, the
 * answers of its parties. Focusing anything inside the card (click or Tab)
 * makes it the target of the keyboard shortcuts.
 *
 * An amendment the Secretaría has not validated yet only says so, offers
 * "Validar y publicar" to whoever can, and shows its changes: the Mesa
 * cannot debate or decide it. A validated one that is not public yet says
 * who can read it.
 */
const props = defineProps<{ amendment: AmendmentDto }>();

const session = useSessionConsoleContext();
const { t } = useI18n();

const id = computed(() => props.amendment.id);
const code = computed(() => session.label(id.value));
const focused = computed(() => session.focusedId.value === id.value);
const debated = computed(
  () => session.liveState.value?.amendmentId === id.value,
);
const busy = computed(() => Boolean(session.busy.value[id.value]));
/** This amendment, or a bulk validation that includes it, is being sent. */
const reviewBusy = computed(
  () => busy.value || Boolean(session.busy.value.validate),
);
const awaiting = computed(() => isSessionAwaitingValidation(props.amendment));
const correctionRequested = computed(
  () => props.amendment.reviewState === "correction_requested",
);
const validatable = computed(() => isSessionValidatable(props.amendment));
const unpublished = computed(() => isSessionUnpublished(props.amendment));
const publishable = computed(() => isSessionPublishable(props.amendment));
const open = computed(() => isSessionOpen(props.amendment));
const pendingAdmission = computed(() =>
  isSessionPendingAdmission(props.amendment),
);
const missing = computed(() => sessionMissingAcceptances(props.amendment));
const reopenable = computed(() =>
  SESSION_REOPENABLE.includes(props.amendment.status),
);
const inadmissible = computed(() => props.amendment.status === "inadmissible");
const decided = computed(() => props.amendment.status !== "submitted");

const expandedByUser = ref<boolean | null>(null);
const expanded = computed(() => expandedByUser.value ?? debated.value);

const sourceCodes = computed(() =>
  props.amendment.sourceIds.map(session.label).join(", "),
);
const transactionalCodes = computed(() =>
  props.amendment.transactionalIds.map(session.label).join(", "),
);

const voteSummary = computed(() => {
  const vote = props.amendment.outcomeVote;
  if (!vote) return null;
  return t("session.card.voteCounts", {
    inFavor: vote.inFavor,
    against: vote.against,
    abstentions: vote.abstentions,
  });
});

/**
 * Makes this card the target of the shortcuts. A card waiting for the
 * Secretaría clears the target instead: nothing in it can be decided, and a
 * key pressed after clicking it must not act on another card.
 */
function focusCard(): void {
  session.focusedId.value = awaiting.value ? null : id.value;
}

/** Debating a validated amendment that is not public yet asks first. */
function toggleDebate(): void {
  if (debated.value) void session.clearDebatedAmendment();
  else void session.requestDebate(props.amendment);
}

const debateItem = computed<DropdownMenuItem>(() => ({
  label: debated.value
    ? t("session.actions.undebate")
    : t("session.actions.debate"),
  icon: debated.value ? "i-lucide-radio-tower" : "i-lucide-radio",
  onSelect: toggleDebate,
}));
const relateItem = computed<DropdownMenuItem>(() => ({
  label: t("session.actions.relate"),
  icon: "i-lucide-link",
  onSelect: () => session.openRelation(props.amendment),
}));

const POSITION_ICONS = {
  pending: "i-lucide-circle-dashed",
  accept: "i-lucide-thumbs-up",
  reject: "i-lucide-thumbs-down",
  transact: "i-lucide-git-merge",
} as const;

/** The proponent's position as stated in the room (feeds bulk assent). */
const positionItem = computed<DropdownMenuItem | null>(() => {
  if (props.amendment.status !== "submitted" || !props.amendment.can.position)
    return null;
  const current = props.amendment.position?.position ?? "pending";
  return {
    label: t("amendment.position.title"),
    icon: "i-lucide-user-round-check",
    children: PROPONENT_POSITIONS.map((position) => ({
      type: "checkbox" as const,
      label: t(`amendment.position.options.${position}`),
      icon: POSITION_ICONS[position],
      checked: current === position,
      onSelect: () => {
        if (current !== position) {
          void session.setPosition(props.amendment, position);
        }
      },
    })),
  };
});

/** Validated but private: the Secretaría or the Mesa may make it public. */
const publishItem = computed<DropdownMenuItem[]>(() =>
  publishable.value
    ? [
        {
          label: t("session.actions.publish"),
          icon: "i-lucide-eye",
          onSelect: () => void session.publishAmendments([id.value]),
        },
      ]
    : [],
);

const menuItems = computed<DropdownMenuItem[][]>(() => {
  const position = positionItem.value ? [positionItem.value] : [];
  if (awaiting.value) return [];
  if (open.value) {
    return [
      [
        {
          label: t("session.actions.proponent"),
          icon: "i-lucide-user-check",
          disabled: missing.value > 0,
          onSelect: () => void session.approve(props.amendment, "proponent"),
        },
        {
          label: t("session.actions.formal"),
          icon: "i-lucide-spell-check",
          disabled: missing.value > 0,
          onSelect: () => void session.approve(props.amendment, "formal"),
        },
        ...position,
      ],
      [
        {
          label: t("session.actions.withdraw"),
          icon: "i-lucide-undo-2",
          onSelect: () => void session.withdraw(props.amendment),
        },
        {
          label: t("session.actions.lapse"),
          icon: "i-lucide-circle-slash",
          kbds: ["l"],
          onSelect: () => void session.lapse(props.amendment),
        },
        {
          label: t("session.actions.inadmit"),
          icon: "i-lucide-octagon-x",
          color: "error",
          onSelect: () => session.openAdmission([id.value], "inadmissible"),
        },
      ],
      [
        relateItem.value,
        {
          label: t("session.actions.transact"),
          icon: "i-lucide-git-merge",
          kbds: ["t"],
          onSelect: () => session.openComposer([id.value]),
        },
        ...publishItem.value,
      ],
    ];
  }
  if (pendingAdmission.value) {
    return [
      [debateItem.value, ...position],
      [
        {
          label: t("session.actions.withdraw"),
          icon: "i-lucide-undo-2",
          onSelect: () => void session.withdraw(props.amendment),
        },
        relateItem.value,
        ...publishItem.value,
      ],
    ];
  }
  return [[debateItem.value, relateItem.value, ...publishItem.value]];
});
</script>

<template>
  <article
    :id="`session-amendment-${amendment.id}`"
    tabindex="-1"
    :aria-label="t('session.card.label', { code })"
    :aria-current="debated ? 'true' : undefined"
    class="bg-default rounded-lg border p-3 outline-none focus-visible:ring-2 focus-visible:ring-primary"
    :class="[
      debated ? 'border-primary bg-primary/5' : 'border-default',
      focused ? 'ring-primary/70 ring-2' : '',
      decided ? 'opacity-80' : '',
    ]"
    :data-status="amendment.status"
    @click="focusCard"
    @focusin="focusCard"
  >
    <header class="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <h3 class="text-highlighted text-base font-bold tabular-nums">
        {{ code }}
      </h3>
      <span class="text-muted text-xs">
        {{ t(`session.enums.amendmentKind.${amendment.kind}`) }}
      </span>
      <span class="inline-flex flex-wrap items-center gap-1">
        <CommonMemberBadge
          v-for="author in amendment.authors"
          :key="author.id"
          :member="author"
          size="xs"
        />
      </span>
      <span class="ms-auto inline-flex flex-wrap items-center gap-1">
        <UBadge
          v-if="awaiting"
          color="warning"
          variant="subtle"
          size="sm"
          :icon="
            correctionRequested ? 'i-lucide-pencil-line' : 'i-lucide-hourglass'
          "
          :label="
            correctionRequested
              ? t('session.card.correctionBadge')
              : t('session.card.awaitingBadge')
          "
        />
        <template v-else>
          <UBadge
            v-if="debated"
            color="primary"
            variant="solid"
            size="sm"
            icon="i-lucide-radio"
            :label="t('session.card.inDebate')"
          />
          <UTooltip v-if="unpublished" :text="t('session.card.notPublicHint')">
            <UBadge
              color="neutral"
              variant="outline"
              size="sm"
              icon="i-lucide-eye-off"
            >
              {{ t("session.card.notPublic") }}
              <span class="sr-only">{{ t("session.card.notPublicHint") }}</span>
            </UBadge>
          </UTooltip>
          <UBadge
            v-if="amendment.late"
            color="warning"
            variant="outline"
            size="sm"
            :label="t('session.queue.late')"
          />
          <CommonStatusBadge
            v-if="amendment.admission !== 'admitted'"
            kind="admission"
            :value="amendment.admission"
            size="sm"
          />
          <CommonStatusBadge
            kind="amendment"
            :value="amendment.status"
            size="sm"
          />
        </template>
      </span>
    </header>

    <!-- What happens next with an amendment outside the debate. -->
    <div v-if="awaiting" class="mt-1.5 space-y-1 text-sm">
      <p class="text-default">
        {{
          correctionRequested
            ? t("session.card.correctionRequested")
            : validatable
              ? t("session.card.awaitingCanValidate")
              : t("session.card.awaiting")
        }}
      </p>
      <p
        v-if="correctionRequested && amendment.correctionNote"
        class="text-muted border-default border-s-2 ps-2 whitespace-pre-line"
      >
        <span class="text-highlighted font-medium">{{
          t("session.card.correctionNote")
        }}</span>
        {{ amendment.correctionNote }}
      </p>
    </div>

    <div
      class="text-muted mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
    >
      <span
        v-if="amendment.position && !awaiting"
        class="inline-flex items-center gap-1"
      >
        {{ t("session.card.position") }}
        <UTooltip
          :text="amendment.position.comment ?? undefined"
          :disabled="!amendment.position.comment"
        >
          <CommonStatusBadge
            kind="position"
            :value="amendment.position.position"
            size="xs"
            :icon="
              amendment.position.comment ? 'i-lucide-message-square' : undefined
            "
          />
        </UTooltip>
      </span>
      <span v-if="amendment.changeKinds.length > 0">
        {{
          amendment.changeKinds
            .map((kind) => t(`session.enums.changeKind.${kind}`))
            .join(" · ")
        }}
      </span>
      <span v-if="amendment.sourceIds.length > 0">
        {{ t("session.card.sources", { codes: sourceCodes }) }}
      </span>
      <span v-if="amendment.transactionalIds.length > 0">
        {{ t("session.card.transactionals", { codes: transactionalCodes }) }}
      </span>
      <span v-if="missing > 0" class="text-warning">
        {{ t("session.card.missingAcceptances", { count: missing }, missing) }}
      </span>
      <span v-if="amendment.approvalMethod">
        {{ t(`session.enums.approvalMethod.${amendment.approvalMethod}`) }}
      </span>
      <span v-if="voteSummary" class="tabular-nums">{{ voteSummary }}</span>
      <span v-if="amendment.outcomeNote" class="italic">
        {{ amendment.outcomeNote }}
      </span>
    </div>

    <div v-if="expanded" class="mt-3 space-y-3">
      <p
        v-if="amendment.justification"
        class="content-font text-default line-clamp-6 text-sm whitespace-pre-line"
      >
        {{ amendment.justification }}
      </p>
      <ContentAmendmentDiff
        :id="amendment.id"
        :base="session.base.value"
        :ops="amendment.ops"
        class="text-sm"
      />
      <SessionAcceptanceList
        v-if="amendment.kind === 'transactional' && !decided"
        :amendment="amendment"
      />
    </div>

    <footer class="mt-3 flex flex-wrap items-center gap-1.5">
      <template v-if="awaiting">
        <UTooltip v-if="validatable" :text="t('session.actions.validateHint')">
          <UButton
            size="xs"
            color="primary"
            variant="soft"
            icon="i-lucide-badge-check"
            :label="t('session.actions.validate')"
            :loading="busy"
            :disabled="reviewBusy"
            @click="session.validateAmendments([amendment.id])"
          />
        </UTooltip>
      </template>
      <template v-else-if="open">
        <UButton
          size="xs"
          :color="debated ? 'primary' : 'neutral'"
          :variant="debated ? 'solid' : 'outline'"
          :icon="debated ? 'i-lucide-radio-tower' : 'i-lucide-radio'"
          :label="
            debated
              ? t('session.actions.undebate')
              : t('session.actions.debate')
          "
          :loading="Boolean(session.busy.value.live) && !busy"
          :disabled="busy"
          @click="toggleDebate"
        />
        <UTooltip
          :text="
            missing > 0
              ? t('session.card.needsAcceptances')
              : t('session.actions.assentHint')
          "
          :kbds="['a']"
        >
          <UButton
            size="xs"
            color="success"
            variant="soft"
            icon="i-lucide-check"
            :label="t('session.actions.assent')"
            :loading="busy"
            :disabled="busy || missing > 0"
            @click="session.approve(amendment, 'assent')"
          />
        </UTooltip>
        <UTooltip :text="t('session.actions.voteHint')" :kbds="['v']">
          <UButton
            size="xs"
            color="primary"
            variant="soft"
            icon="i-lucide-gavel"
            :label="t('session.actions.vote')"
            :disabled="busy || missing > 0"
            @click="session.openVote(amendment)"
          />
        </UTooltip>
      </template>
      <template v-else-if="pendingAdmission">
        <UButton
          size="xs"
          color="success"
          variant="soft"
          icon="i-lucide-check"
          :label="t('session.actions.admit')"
          :disabled="busy"
          @click="session.openAdmission([amendment.id], 'admitted')"
        />
        <UButton
          size="xs"
          color="error"
          variant="soft"
          icon="i-lucide-octagon-x"
          :label="t('session.actions.inadmit')"
          :disabled="busy"
          @click="session.openAdmission([amendment.id], 'inadmissible')"
        />
      </template>
      <UButton
        v-else-if="inadmissible"
        size="xs"
        color="neutral"
        variant="outline"
        icon="i-lucide-rotate-ccw"
        :label="t('session.actions.readmit')"
        :disabled="busy"
        @click="session.openAdmission([amendment.id], 'admitted')"
      />
      <UButton
        v-else-if="reopenable"
        size="xs"
        color="neutral"
        variant="outline"
        icon="i-lucide-rotate-ccw"
        :label="t('session.actions.reopen')"
        :loading="busy"
        @click="session.reopen(amendment)"
      />

      <UDropdownMenu
        v-if="menuItems.length > 0"
        :items="menuItems"
        :content="{ align: 'end' }"
      >
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-ellipsis"
          :aria-label="t('session.actions.more', { code })"
          :disabled="busy"
        />
      </UDropdownMenu>

      <UButton
        v-if="amendment.ops.length > 0 || amendment.justification"
        size="xs"
        color="neutral"
        variant="link"
        class="ms-auto"
        :icon="expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
        :label="expanded ? t('session.card.hide') : t('session.card.show')"
        :aria-expanded="expanded"
        @click="expandedByUser = !expanded"
      />
    </footer>
  </article>
</template>
