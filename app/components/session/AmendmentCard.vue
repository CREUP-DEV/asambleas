<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import type { AmendmentDto } from "~~/shared/types/api";
import {
  isSessionAwaitingAuthors,
  isSessionAwaitingValidation,
  isSessionDebatable,
  isSessionIncorporated,
  isSessionOpen,
  isSessionPendingAdmission,
  isSessionProjectable,
  isSessionPublishable,
  isSessionReopenable,
  isSessionTransactable,
  isSessionUnpublished,
  isSessionValidatable,
  sessionClosingSourceIds,
  sessionLapsingTransactionalIds,
  sessionMissingAcceptances,
  sessionReplacedIds,
  sessionReplacingIds,
  sessionSupersededSourceIds,
  sessionTransactionalRejectors,
} from "~/composables/session/sessionModel";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";
import { useSessionPosition } from "~/composables/session/useSessionPosition";

/**
 * One amendment of the console queue: who presents it, its kind, the
 * proponent's position, admission and status, and the Mesa's actions. The
 * amendment under debate shows its changes and, for a transactional, the
 * answers of its parties. Focusing anything inside the card (click or Tab)
 * makes it the target of the keyboard shortcuts.
 *
 * An amendment the Secretaría has not validated yet only says so, offers
 * "Validar y publicar" to whoever can, and shows its changes: the Mesa
 * cannot debate or decide it. A transactional proposed by a member says it
 * waits for the main authors of the amendments it would replace, and the
 * Mesa can withdraw it from "Más". One a main author turned down says who:
 * it is closed and those amendments carry on. One the server closed on its
 * own because an amendment it groups was settled first says which, and one
 * that lapsed because another transactional replaced them first names that
 * transactional. One
 * another transactional got ahead of (an amendment it would replace is no
 * longer open) says so and offers only its withdrawal. One drafted in the
 * room that still waits for some main author offers no decision: its
 * parties' answers come first (shown with its changes). A transactional
 * says which amendments it already replaced, and a replaced amendment
 * names the transactional debated in its place. A validated one that is not public
 * yet says who can read it, and nobody decides it until it is. A late one
 * waiting for the assembly's decision to treat it offers only that
 * decision (and its withdrawal): it cannot be debated or decided before.
 * One the main presenter accepted in a document that incorporates
 * accepted amendments is already in the text: until the final vote,
 * changing that answer (from "Más") is what takes it out again. The answer
 * says who gave it, or that the Mesa recorded it on the main presenter's
 * behalf; only published amendments are answered (useSessionPosition), and
 * a private one the Mesa could otherwise answer says on the card that the
 * answer waits for the Secretaría to publish it.
 *
 * In the queue it opens under its compact row (`embedded`): the row
 * already shows the code and who presents it, and carries the anchor the
 * shortcuts and the consolidated text focus.
 */
const props = withDefaults(
  defineProps<{ amendment: AmendmentDto; embedded?: boolean }>(),
  { embedded: false },
);

const session = useSessionConsoleContext();
const answer = useSessionPosition(session);
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
/** A member's transactional the main authors have not accepted yet. */
const awaitingAuthors = computed(() =>
  isSessionAwaitingAuthors(props.amendment),
);
/** Main authors that turned this transactional down: it is closed. */
const rejectors = computed(() =>
  sessionTransactionalRejectors(props.amendment)
    .map((member) => member.acronym)
    .join(", "),
);
/**
 * Sources another transactional replaced first (or that were decided): this
 * one can never go ahead, only be withdrawn.
 */
const supersededCodes = computed(() =>
  sessionSupersededSourceIds(props.amendment, session.byId.value)
    .map(session.label)
    .join(", "),
);
/** Closed by the server because one of these was settled first. */
const closedCodes = computed(() =>
  sessionClosingSourceIds(props.amendment, session.byId.value)
    .map(session.label)
    .join(", "),
);
/** Lapsed on its own because this transactional replaced its sources first. */
const lapsedByCodes = computed(() =>
  sessionLapsingTransactionalIds(props.amendment, session.byId.value)
    .map(session.label)
    .join(", "),
);
/** In the text because the main presenter accepted it, without a vote. */
const incorporated = computed(() => isSessionIncorporated(props.amendment));
/** After the final vote nothing about its amendments changes. */
const voted = computed(() => Boolean(session.document.value?.finalVote));
/** Its authors or the Mesa may withdraw a presented, undecided amendment. */
const withdrawable = computed(
  () =>
    props.amendment.status === "submitted" &&
    (props.amendment.can.moderate || props.amendment.can.withdraw),
);
const correctionRequested = computed(
  () => props.amendment.reviewState === "correction_requested",
);
const validatable = computed(() => isSessionValidatable(props.amendment));
const unpublished = computed(() => isSessionUnpublished(props.amendment));
const publishable = computed(() => isSessionPublishable(props.amendment));
const open = computed(() => isSessionOpen(props.amendment));
/** This actor can put it on the projection (public, or they can publish it). */
const debatable = computed(() => isSessionDebatable(props.amendment));
const projectable = computed(() => isSessionProjectable(props.amendment));
const pendingAdmission = computed(() =>
  isSessionPendingAdmission(props.amendment),
);
const missing = computed(() => sessionMissingAcceptances(props.amendment));
const transactable = computed(() => isSessionTransactable(props.amendment));
const inadmissible = computed(() => props.amendment.status === "inadmissible");
const decided = computed(() => props.amendment.status !== "submitted");

const expandedByUser = ref<boolean | null>(null);
const expanded = computed(
  () => expandedByUser.value ?? (props.embedded || debated.value),
);

const codes = (ids: string[]) => ids.map(session.label).join(", ");
/** What a transactional combines, and which of those it already replaced. */
const sourceCodes = computed(() => codes(props.amendment.sourceIds));
const replacedCodes = computed(() =>
  codes(sessionReplacedIds(props.amendment, session.byId.value)),
);
/** The transactional that replaced it, or those proposed over it. */
const replacingCodes = computed(() =>
  codes(sessionReplacingIds(props.amendment, session.byId.value)),
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
/** Withdrawn on behalf of whoever presented it (POST .../withdraw). */
const withdrawSubmissionItem = computed<DropdownMenuItem>(() => ({
  label: t("session.actions.withdrawProposal"),
  icon: "i-lucide-undo-2",
  onSelect: () => void session.withdrawSubmission(props.amendment),
}));
const relateItem = computed<DropdownMenuItem>(() => ({
  label: t("session.actions.relate"),
  icon: "i-lucide-link",
  onSelect: () => session.openRelation(props.amendment),
}));

/**
 * The main presenter's answer as stated in the room (feeds bulk assent).
 * An incorporated amendment keeps it: changing the answer reopens it. Only
 * published amendments are answered, and never after the final vote: the
 * text is fixed and the server refuses it.
 */
const positionItem = computed(() => answer.menuItem(props.amendment));
/** Who gave the answer shown: the main presenter, or the Mesa for it. */
const positionLabel = computed(() => answer.label(props.amendment));
/**
 * Private, so nobody can answer it yet: said on the card too, since the
 * disabled entry in "Más" cannot be reached by keyboard.
 */
const positionWait = computed(() => answer.waitHint(props.amendment));

/**
 * An incorporated amendment is taken out by changing the main presenter's
 * answer (in "Más"), not reopened, whenever that answer can be recorded. A
 * transactional a main author turned down is closed, one another
 * transactional got ahead of would come back stuck (isSessionReopenable),
 * and after the final vote nothing changes: nothing to reopen.
 */
const reopenable = computed(
  () =>
    isSessionReopenable(props.amendment, session.byId.value) &&
    !(incorporated.value && positionItem.value) &&
    !voted.value,
);

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
  // Another transactional got ahead of it: withdrawing it (the footer's
  // action) is all that is left.
  if (supersededCodes.value) return [];
  // Still with the main authors: the Mesa may withdraw it on the
  // proposer's behalf.
  if (awaitingAuthors.value) {
    return withdrawable.value && !rejectors.value
      ? [[withdrawSubmissionItem.value]]
      : [];
  }
  if (awaiting.value) return [];
  if (open.value && missing.value > 0) {
    // Drafted in the room, some main author has not answered: nothing is
    // decided or transacted before they all accept it.
    return [
      [
        {
          label: t("session.actions.withdraw"),
          icon: "i-lucide-undo-2",
          onSelect: () => void session.withdraw(props.amendment),
        },
        relateItem.value,
      ],
    ];
  }
  if (open.value) {
    return [
      [
        {
          label: t("session.actions.formal"),
          icon: "i-lucide-spell-check",
          disabled: unpublished.value,
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
          // Delegates must be able to read what a transactional merges.
          disabled: !transactable.value,
          onSelect: () => session.openComposer([id.value]),
        },
      ],
    ];
  }
  if (pendingAdmission.value) {
    // Not debated nor decided before the assembly agrees to treat it, but
    // its authors may still withdraw it (the Mesa records it for them).
    return [
      ...(position.length > 0 ? [position] : []),
      [
        ...(withdrawable.value
          ? [
              {
                label: t("session.actions.withdraw"),
                icon: "i-lucide-undo-2",
                onSelect: () =>
                  void session.withdrawSubmission(props.amendment),
              },
            ]
          : []),
        relateItem.value,
        ...publishItem.value,
      ],
    ];
  }
  // Only what the projection can show is put under debate.
  const debate = debated.value || projectable.value ? [debateItem.value] : [];
  return [
    ...(incorporated.value && position.length > 0 ? [position] : []),
    [...debate, relateItem.value, ...publishItem.value],
  ];
});
</script>

<template>
  <article
    :id="embedded ? undefined : `session-amendment-${amendment.id}`"
    :tabindex="embedded ? undefined : -1"
    :aria-label="t('session.card.label', { code })"
    :aria-current="debated && !embedded ? 'true' : undefined"
    class="outline-none"
    :class="
      embedded
        ? ''
        : [
            'bg-default focus-visible:ring-primary rounded-lg border p-3 focus-visible:ring-2',
            debated ? 'border-primary bg-primary/5' : 'border-default',
            focused ? 'ring-primary/70 ring-2' : '',
            decided ? 'opacity-80' : '',
          ]
    "
    :data-status="amendment.status"
    @click="focusCard"
    @focusin="focusCard"
  >
    <header class="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <h3
        v-if="!embedded"
        class="text-highlighted text-base font-bold tabular-nums"
      >
        {{ code }}
      </h3>
      <span class="text-muted text-xs">
        {{ t(`session.enums.amendmentKind.${amendment.kind}`) }}
      </span>
      <span v-if="!embedded" class="inline-flex flex-wrap items-center gap-1">
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
            supersededCodes
              ? 'i-lucide-git-pull-request-closed'
              : correctionRequested
                ? 'i-lucide-pencil-line'
                : rejectors
                  ? 'i-lucide-user-round-x'
                  : awaitingAuthors
                    ? 'i-lucide-user-round-check'
                    : 'i-lucide-hourglass'
          "
          :label="
            supersededCodes
              ? t('session.stage.superseded')
              : correctionRequested
                ? t('session.card.correctionBadge')
                : rejectors
                  ? t('session.stage.turned_down', { members: rejectors })
                  : awaitingAuthors
                    ? t('session.card.authorsBadge')
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
          <!-- Closed by a main author or by the server, or left behind by
               another transactional: say that, not the status it carries. -->
          <UBadge
            v-if="rejectors || closedCodes || supersededCodes"
            :color="rejectors || closedCodes ? 'neutral' : 'warning'"
            variant="subtle"
            size="sm"
            :icon="
              rejectors
                ? 'i-lucide-user-round-x'
                : 'i-lucide-git-pull-request-closed'
            "
            :label="
              rejectors
                ? t('session.stage.turned_down', { members: rejectors })
                : closedCodes
                  ? t('session.stage.closed')
                  : t('session.stage.superseded')
            "
          />
          <CommonStatusBadge
            v-else
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
          supersededCodes
            ? t("session.now.stage.superseded", { codes: supersededCodes })
            : correctionRequested
              ? t("session.card.correctionRequested")
              : rejectors
                ? t("session.now.stage.turned_down", { members: rejectors })
                : awaitingAuthors
                  ? t("session.card.awaitingAuthors", { codes: sourceCodes })
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

    <!-- Settled without the Mesa: turned down by a main author, closed or
         lapsed on its own, left behind by another transactional, or in the
         text because the main presenter accepted it. -->
    <p v-if="!awaiting && rejectors" class="text-default mt-1.5 text-sm">
      {{ t("session.now.stage.turned_down", { members: rejectors }) }}
    </p>
    <p v-else-if="closedCodes" class="text-default mt-1.5 text-sm">
      {{ t("session.now.stage.closed", { codes: closedCodes }) }}
    </p>
    <p v-else-if="lapsedByCodes" class="text-default mt-1.5 text-sm">
      {{ t("session.now.stage.lapsedBy", { codes: lapsedByCodes }) }}
    </p>
    <p
      v-else-if="!awaiting && supersededCodes"
      class="text-default mt-1.5 text-sm"
    >
      {{ t("session.now.stage.superseded", { codes: supersededCodes }) }}
    </p>
    <p v-else-if="incorporated" class="text-default mt-1.5 text-sm">
      {{ t("session.card.incorporated") }}
    </p>

    <div
      class="text-muted mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
    >
      <span
        v-if="amendment.position && !awaiting"
        class="inline-flex items-center gap-1"
      >
        {{ positionLabel }}
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
      <span v-if="positionWait" class="inline-flex items-center gap-1">
        <UIcon
          name="i-lucide-eye-off"
          class="size-3.5 shrink-0"
          aria-hidden="true"
        />
        {{ positionWait }}
      </span>
      <span v-if="amendment.changeKinds.length > 0">
        {{
          amendment.changeKinds
            .map((kind) => t(`session.enums.changeKind.${kind}`))
            .join(" · ")
        }}
      </span>
      <span v-if="replacedCodes">
        {{ t("session.card.replaces", { codes: replacedCodes }) }}
      </span>
      <span v-else-if="amendment.sourceIds.length > 0">
        {{ t("session.card.sources", { codes: sourceCodes }) }}
      </span>
      <span v-if="replacingCodes">
        {{
          amendment.status === "transacted"
            ? t("session.card.replacedBy", { codes: replacingCodes })
            : t("session.card.transactionals", { codes: replacingCodes })
        }}
      </span>
      <span
        v-if="missing > 0 && !rejectors && !supersededCodes"
        class="text-warning"
      >
        {{ t("session.card.missingAcceptances", { count: missing }, missing) }}
      </span>
      <span v-if="amendment.approvalMethod && !incorporated">
        {{ t(`session.enums.approvalMethod.${amendment.approvalMethod}`) }}
      </span>
      <span v-if="voteSummary" class="tabular-nums">{{ voteSummary }}</span>
      <!-- Turned down or closed by the server: the sentence above already
           says who or why, and what follows. -->
      <span
        v-if="amendment.outcomeNote && !rejectors && !closedCodes"
        class="italic"
      >
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
      <!-- Another transactional got ahead of it: only withdrawing settles it. -->
      <template v-if="supersededCodes">
        <UButton
          v-if="withdrawable"
          size="xs"
          color="warning"
          variant="soft"
          icon="i-lucide-undo-2"
          :label="t('session.actions.withdraw')"
          :loading="busy"
          @click="session.withdrawSubmission(amendment)"
        />
      </template>
      <template v-else-if="awaiting">
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
        <!-- Under its row, which already offers "Debatir": only the way out. -->
        <UButton
          v-if="debated || (debatable && !embedded)"
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
        <!-- Nothing private is decided: it has to be public first. -->
        <template v-if="unpublished">
          <UButton
            v-if="publishable"
            size="xs"
            color="primary"
            variant="soft"
            icon="i-lucide-eye"
            :label="t('session.actions.publish')"
            :loading="busy"
            @click="session.publishAmendments([amendment.id])"
          />
          <span v-else class="text-muted text-xs">
            {{ t("session.card.publishFirst") }}
          </span>
        </template>
        <!-- Some main author has not answered: their answers come first
             (with its changes), no decision yet. -->
        <span v-else-if="missing > 0" class="text-muted text-xs">
          {{ t("session.card.needsAcceptances") }}
        </span>
        <template v-else>
          <UTooltip :text="t('session.actions.assentHint')" :kbds="['a']">
            <UButton
              size="xs"
              color="success"
              variant="soft"
              icon="i-lucide-check"
              :label="t('session.actions.assent')"
              :loading="busy"
              :disabled="busy"
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
              :disabled="busy"
              @click="session.openVote(amendment)"
            />
          </UTooltip>
        </template>
      </template>
      <UButton
        v-else-if="pendingAdmission"
        size="xs"
        color="warning"
        variant="soft"
        icon="i-lucide-gavel"
        :label="t('session.actions.decideTreat')"
        :disabled="busy"
        @click="session.openAdmission([amendment.id], 'admitted')"
      />
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
        v-if="
          !embedded && (amendment.ops.length > 0 || amendment.justification)
        "
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
