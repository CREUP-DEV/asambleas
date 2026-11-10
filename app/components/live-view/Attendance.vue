<script setup lang="ts">
import type { HeadcountDto } from "~~/shared/types/api";
import type { LiveAttendance } from "~/components/live-view/-attendance";

/**
 * Attendance and quorum for everyone, for transparency: the Mesa's latest
 * headcount (who is in the room with a vote, the delegated votes and
 * whether they count, the sectorials and guests in the room), whether there is quorum, the majorities it gives when the
 * assembly counts them on the members present, and the earlier counts.
 * The lists fold away: on a phone the figures come first.
 */
const props = defineProps<{
  /** Null before the Mesa's first count. */
  attendance: LiveAttendance | null;
}>();

const { t, locale } = useI18n();

function when(headcount: HeadcountDto): string {
  return formatTime(headcount.takenAt, { locale: locale.value });
}

const latest = computed(() => props.attendance?.latest ?? null);
</script>

<template>
  <section aria-labelledby="live-attendance-title" class="flex flex-col gap-3">
    <h2
      id="live-attendance-title"
      class="text-highlighted text-lg font-semibold"
    >
      {{ t("liveView.attendance.title") }}
    </h2>

    <p v-if="!attendance || !latest" class="text-muted">
      {{ t("liveView.attendance.none") }}
    </p>

    <div v-else class="ring-default flex flex-col gap-4 rounded-lg p-4 ring">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <UBadge
          :color="latest.quorum ? 'success' : 'error'"
          variant="subtle"
          size="lg"
          :icon="latest.quorum ? 'i-lucide-circle-check' : 'i-lucide-circle-x'"
          :label="
            latest.quorum
              ? t('session.headcount.quorum')
              : t('session.headcount.noQuorum')
          "
        />
        <p class="text-muted text-sm tabular-nums">
          {{
            t("liveView.attendance.takenAt", {
              time: when(latest),
              required: latest.required,
            })
          }}
          <template v-if="latest.note"> · {{ latest.note }}</template>
        </p>
      </div>

      <dl class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <dt class="text-muted text-sm">
            {{ t("liveView.attendance.present") }}
          </dt>
          <dd class="text-highlighted text-2xl font-bold tabular-nums">
            {{ latest.present }}
            <span class="text-muted text-base font-normal">
              / {{ latest.eligible }}
            </span>
          </dd>
        </div>
        <div>
          <dt class="text-muted text-sm">
            {{ t("liveView.attendance.delegated") }}
          </dt>
          <dd class="text-highlighted text-2xl font-bold tabular-nums">
            {{ latest.delegated }}
          </dd>
        </div>
        <template v-if="attendance.majorities">
          <div>
            <dt class="text-muted text-sm">
              {{ t("session.enums.majority.absolute") }}
            </dt>
            <dd class="text-highlighted text-2xl font-bold tabular-nums">
              {{ attendance.majorities.absolute }}
            </dd>
          </div>
          <div>
            <dt class="text-muted text-sm">
              {{ t("session.enums.majority.two_thirds") }}
            </dt>
            <dd class="text-highlighted text-2xl font-bold tabular-nums">
              {{ attendance.majorities.twoThirds }}
            </dd>
          </div>
        </template>
      </dl>
      <p v-if="attendance.majorities" class="text-muted text-sm">
        {{ t("liveView.attendance.majoritiesHint") }}
      </p>
      <p v-else class="text-muted text-sm">
        {{ t("liveView.attendance.validVotesHint") }}
      </p>

      <details class="group">
        <summary class="text-default cursor-pointer text-sm font-medium">
          {{
            t(
              "liveView.attendance.inRoom",
              { count: attendance.inRoom.length },
              attendance.inRoom.length,
            )
          }}
        </summary>
        <ul class="mt-2 flex flex-wrap gap-1.5">
          <li v-for="member in attendance.inRoom" :key="member.id">
            <CommonMemberBadge :member="member" />
          </li>
        </ul>
      </details>

      <details
        v-if="attendance.attending.length + attendance.guests.length > 0"
      >
        <summary class="text-default cursor-pointer text-sm font-medium">
          {{
            t(
              "liveView.attendance.attending",
              { count: attendance.attending.length + attendance.guests.length },
              attendance.attending.length + attendance.guests.length,
            )
          }}
        </summary>
        <ul class="mt-2 flex flex-wrap gap-1.5">
          <li v-for="member in attendance.attending" :key="member.id">
            <CommonMemberBadge :member="member" />
          </li>
          <li
            v-for="(name, index) in attendance.guests"
            :key="'guest-' + index"
          >
            <UBadge color="neutral" variant="subtle" size="sm" :label="name" />
          </li>
        </ul>
      </details>

      <details v-if="attendance.delegations.length > 0">
        <summary class="text-default cursor-pointer text-sm font-medium">
          {{
            t(
              "liveView.attendance.delegations",
              { count: attendance.delegations.length },
              attendance.delegations.length,
            )
          }}
        </summary>
        <ul class="mt-2 flex flex-col gap-1.5 text-sm">
          <li
            v-for="delegation in attendance.delegations"
            :key="delegation.from.id"
            class="flex flex-wrap items-center gap-x-2 gap-y-1"
          >
            <CommonMemberBadge :member="delegation.from" />
            <UIcon
              name="i-lucide-arrow-right"
              class="text-muted size-4 shrink-0"
              aria-hidden="true"
            />
            <span class="sr-only">
              {{ t("liveView.attendance.votesThrough") }}
            </span>
            <CommonMemberBadge :member="delegation.to" />
            <span v-if="!delegation.counts" class="text-muted">
              {{ t("liveView.attendance.notCounted") }}
            </span>
          </li>
        </ul>
      </details>

      <details v-if="attendance.earlier.length > 0">
        <summary class="text-default cursor-pointer text-sm font-medium">
          {{
            t(
              "session.headcount.earlier",
              { count: attendance.earlier.length },
              attendance.earlier.length,
            )
          }}
        </summary>
        <ul class="mt-2 flex flex-col gap-1 text-sm tabular-nums">
          <li v-for="count in attendance.earlier" :key="count.id">
            {{ when(count) }} ·
            {{
              t(
                "session.headcount.figures",
                {
                  present: count.present,
                  eligible: count.eligible,
                  delegated: count.delegated,
                },
                count.delegated,
              )
            }}
            ·
            {{
              count.quorum
                ? t("session.headcount.quorum")
                : t("session.headcount.noQuorum")
            }}
            <template v-if="count.note"> · {{ count.note }}</template>
          </li>
        </ul>
      </details>
    </div>
  </section>
</template>
