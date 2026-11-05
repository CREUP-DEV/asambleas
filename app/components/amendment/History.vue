<script setup lang="ts">
import type { TimelineItem } from "@nuxt/ui";
import type { DecisionKind } from "~~/shared/constants/domain";
import type { DecisionDto, EventDto, MemberRef } from "~~/shared/types/api";

/**
 * Immutable history of one amendment (GET .../amendments/{id}/history) as a
 * timeline. It reloads when `version` changes (see amendmentHistoryVersion).
 * Admission decisions show how they were taken; with `decisionsUrl`, a vote's
 * counts and the decision note are looked up in the assembly's decisions.
 *
 * On a transactional, each answer of a main author names who answered,
 * also when the Mesa recorded it in the room (the event's actor is then the
 * Mesa), and a transactional closed by a main author's rejection says so
 * instead of "Retirada". Events carry only the member's id: `members` (the
 * transactional's parties and authors) names it.
 */
const props = withDefaults(
  defineProps<{
    /** URL of the amendment: .../amendments/{id}. */
    url: string;
    version?: string;
    /** GET /api/assemblies/{assembly}/decisions, for admission vote counts. */
    decisionsUrl?: string;
    /** Members the events may name by id (parties, authors). */
    members?: MemberRef[];
  }>(),
  { version: undefined, decisionsUrl: undefined, members: () => [] },
);

const { t, te, locale } = useI18n();
const api = useApi();
const titleId = useId();

const events = ref<EventDto[]>([]);
const loading = ref(false);
const failed = ref(false);
let request = 0;

/** Admission decisions by id, as GET .../decisions returns them. */
const decisionsById = shallowRef(new Map<string, DecisionDto>());
/** Decision ids already looked up, so a missing one is not fetched again. */
const lookedUp = new Set<string>();

function admissionDecisionId(event: EventDto): string | null {
  if (
    event.type !== "amendment_admitted" &&
    event.type !== "amendment_inadmissible"
  ) {
    return null;
  }
  return text(event.payload?.decisionId);
}

async function loadDecisions(list: EventDto[]): Promise<void> {
  const url = props.decisionsUrl;
  if (!url) return;
  const missing = list
    .map(admissionDecisionId)
    .filter((id): id is string => id !== null && !lookedUp.has(id));
  if (missing.length === 0) return;
  missing.forEach((id) => lookedUp.add(id));
  try {
    const decisions = await api.get<DecisionDto[]>(url);
    // Merge: an older response resolving last must not drop newer decisions.
    decisionsById.value = new Map([
      ...decisionsById.value,
      ...decisions.map((decision) => [decision.id, decision] as const),
    ]);
  } catch {
    // Method and result come with the event; counts are a bonus.
    missing.forEach((id) => lookedUp.delete(id));
  }
}

async function load(): Promise<void> {
  const current = ++request;
  loading.value = true;
  failed.value = false;
  try {
    const result = await api.get<EventDto[]>(`${props.url}/history`);
    if (current === request) {
      events.value = result;
      void loadDecisions(result);
    }
  } catch {
    if (current === request) failed.value = true;
  } finally {
    if (current === request) loading.value = false;
  }
}

onMounted(load);
watch(() => [props.url, props.version], load);

const ICONS: Record<string, string> = {
  amendment_created: "i-lucide-file-plus",
  amendment_updated: "i-lucide-pencil",
  amendment_submitted: "i-lucide-send",
  amendment_validated: "i-lucide-badge-check",
  amendment_published: "i-lucide-eye",
  amendment_correction_requested: "i-lucide-message-square-warning",
  amendment_admitted: "i-lucide-badge-check",
  amendment_inadmissible: "i-lucide-ban",
  amendment_withdrawn: "i-lucide-undo-2",
  amendment_lapsed: "i-lucide-hourglass",
  amendment_transacted: "i-lucide-git-merge",
  amendment_approved: "i-lucide-circle-check",
  amendment_rejected: "i-lucide-circle-x",
  amendment_reopened: "i-lucide-rotate-ccw",
  position_changed: "i-lucide-message-square",
  acceptance_recorded: "i-lucide-handshake",
  relation_created: "i-lucide-link-2",
  relation_deleted: "i-lucide-unlink",
};

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** The acronym of a member an event names by id, when it can be told. */
function memberAcronym(event: EventDto, id: string | null): string | null {
  if (!id) return null;
  if (event.actorMember?.id === id) return event.actorMember.acronym;
  return props.members.find((member) => member.id === id)?.acronym ?? null;
}

/** A transactional closed because a main author rejected it. */
function closedByRejection(event: EventDto): boolean {
  return (
    event.type === "amendment_withdrawn" &&
    event.payload?.by === "author_rejection"
  );
}

type AdmissionMotion = Extract<DecisionKind, "admit_late" | "inadmission">;

/**
 * The motion an admission vote was on. A defeated vote applies the opposite
 * outcome (a failed vote to declare an amendment inadmissible admits it), so
 * the event type alone does not say what was voted: the decision does, and
 * without it the motion is the event's outcome, flipped when the vote failed.
 */
function admissionMotion(
  type: EventDto["type"],
  decision: DecisionDto | undefined,
  result: string | null,
): AdmissionMotion {
  if (decision?.kind === "admit_late" || decision?.kind === "inadmission") {
    return decision.kind;
  }
  const admitted = type === "amendment_admitted";
  // As the server does: only a carried vote keeps the motion's own outcome.
  const failed = result !== null && result !== "approved";
  const motionWasAdmit = failed ? !admitted : admitted;
  return motionWasAdmit ? "admit_late" : "inadmission";
}

/**
 * "By assent · note", or for a vote "Vote to declare it inadmissible ·
 * Defeated · 10 in favour, 20 against, 3 abstentions · note": a vote names
 * its motion, so a defeated one does not read as contradicting the outcome.
 */
function admissionDetail(
  type: EventDto["type"],
  payload: Record<string, unknown>,
): string | null {
  const method = text(payload.method);
  const decisionId = text(payload.decisionId);
  const decision = decisionId ? decisionsById.value.get(decisionId) : undefined;
  const vote = decision?.vote ?? null;
  const result = vote?.result ?? text(payload.voteResult);
  const voted = method === "vote" || result !== null;
  const parts = [
    voted
      ? t(
          `amendment.history.admissionMotion.${admissionMotion(type, decision, result)}`,
        )
      : method
        ? t(`amendment.history.admissionMethods.${method}`)
        : null,
    result ? t(`common.status.vote.${result}`) : null,
    vote && vote.method !== "assent"
      ? t("amendment.vote.inline", {
          inFavor: vote.inFavor,
          against: vote.against,
          abstentions: vote.abstentions,
        })
      : null,
    decision?.note?.trim() || null,
  ];
  return parts.filter(Boolean).join(" · ") || null;
}

function detailOf(event: EventDto): string | null {
  const payload = event.payload ?? {};
  switch (event.type) {
    case "position_changed": {
      const position = text(payload.position);
      return position ? t(`amendment.position.options.${position}`) : null;
    }
    case "acceptance_recorded": {
      const decision = text(payload.decision);
      if (!decision) return null;
      // Recorded by the Mesa for a main author: name who answered.
      const party = memberAcronym(event, text(payload.recordedForMemberId));
      return party
        ? t(`amendment.acceptances.answers.${decision}`, { member: party })
        : t(`common.status.acceptance.${decision}`);
    }
    case "amendment_withdrawn": {
      if (!closedByRejection(event)) return null;
      const party = memberAcronym(event, text(payload.memberId));
      return party
        ? t("amendment.acceptances.answers.rejected", { member: party })
        : null;
    }
    case "amendment_approved": {
      const method = text(payload.method);
      // Accepted by the main presenter under the "incorporate" rule.
      if (method === "proponent") return t("amendment.history.byPresenter");
      return method ? t(`amendment.approvalMethods.${method}`) : null;
    }
    case "amendment_submitted":
      return payload.late === true ? t("amendment.late") : null;
    case "amendment_admitted":
    case "amendment_inadmissible":
      return admissionDetail(event.type, payload);
    case "relation_created":
    case "relation_deleted": {
      const kind = text(payload.kind);
      return kind ? t(`amendment.relations.kinds.${kind}`) : null;
    }
    default:
      return null;
  }
}

function actorOf(event: EventDto): string | null {
  if (event.actorMember && event.actorName) {
    return `${event.actorMember.acronym} · ${event.actorName}`;
  }
  return event.actorMember?.acronym ?? event.actorName ?? null;
}

const items = computed<TimelineItem[]>(() =>
  events.value.map((event) => {
    const key = closedByRejection(event)
      ? "amendment.history.closedByRejection"
      : `amendment.history.events.${event.type}`;
    const detail = detailOf(event);
    const actor = actorOf(event);
    return {
      value: event.id,
      date: formatDateTime(event.createdAt, { locale: locale.value }),
      title: te(key) ? t(key) : t("amendment.history.events.other"),
      description: [detail, actor ? t("amendment.history.by", { actor }) : null]
        .filter(Boolean)
        .join(" · "),
      icon: ICONS[event.type] ?? "i-lucide-circle-dot",
    };
  }),
);
</script>

<template>
  <section class="flex flex-col gap-3" :aria-labelledby="titleId">
    <h3 :id="titleId" class="text-highlighted text-sm font-semibold">
      {{ t("amendment.history.title") }}
    </h3>

    <div v-if="loading && events.length === 0" class="flex flex-col gap-3">
      <USkeleton v-for="i in 3" :key="i" class="h-10 w-full" />
    </div>

    <UAlert
      v-else-if="failed"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :title="t('amendment.history.error')"
      :actions="[
        {
          label: t('amendment.actions.retry'),
          color: 'neutral',
          variant: 'outline',
          onClick: load,
        },
      ]"
    />

    <p v-else-if="events.length === 0" class="text-muted text-sm">
      {{ t("amendment.history.empty") }}
    </p>

    <UTimeline
      v-else
      :items="items"
      :default-value="items.length - 1"
      size="xs"
      color="neutral"
      :ui="{ description: 'text-xs' }"
    />
  </section>
</template>
