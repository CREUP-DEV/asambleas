<script setup lang="ts">
import type { MemberKind } from "~~/shared/constants/domain";
import { accountAvatarText } from "~~/shared/utils/accountAvatar";
import { useMemberDirectory } from "~/composables/members/useMemberDirectory";

/**
 * One tile of the Mesa's member grids (the headcount and who asks for the
 * floor): the member's avatar, its acronym in the colour of its kind and,
 * in bold, what tells it apart (a council's university, any other member's
 * denomination: memberHighlight), never cut. A guest, an account without a
 * member, shows its name and initials. The whole tile is one button that
 * says whether it is chosen (`aria-pressed`): a ring and a check mark, the
 * text staying neutral. Where the order of the choices matters (who asks
 * for the floor first), `order` puts the number in place of the check.
 * `expected` (the headcount: somebody registered in the Intranet) adds the
 * mark «Inscrito» under the name. What else the tile offers (a delegation menu) goes
 * in the `extra` slot, under the button and never inside it.
 */
const props = withDefaults(
  defineProps<{
    member?: {
      id: string;
      acronym: string;
      name: string;
      kind: MemberKind;
      university?: string | null;
    } | null;
    /** A guest: an account with no member, by its name. */
    guest?: string | null;
    selected: boolean;
    /** A quiet line under the name ("2 turnos"). */
    note?: string | null;
    disabled?: boolean;
    /** Its place among the chosen ones, shown instead of the check. */
    order?: number | null;
    /** What `order` means, for screen readers ("2.º en pedir la palabra"). */
    orderLabel?: string | null;
    /** Somebody registered for the assembly: expected in the room. */
    expected?: boolean;
  }>(),
  {
    member: null,
    guest: null,
    note: null,
    disabled: false,
    order: null,
    orderLabel: null,
    expected: false,
  },
);

const emit = defineEmits<{ toggle: [] }>();

const { t } = useI18n();

const directory = useMemberDirectory();
onMounted(() => {
  if (props.member) void directory.load();
});

const full = computed(() =>
  props.member ? directory.byId.value.get(props.member.id) : undefined,
);

const highlight = computed(() =>
  props.member
    ? memberHighlight(
        props.member,
        props.member.university ?? full.value?.university,
      )
    : props.guest,
);

/** The text of the avatar without a photo, as its accounts read it. */
const avatarText = computed(() =>
  props.member
    ? accountAvatarText(
        { universityAcronym: null },
        {
          acronym: props.member.acronym,
          kind: props.member.kind,
          universityAcronym: full.value?.universityAcronym ?? null,
        },
      )
    : null,
);
</script>

<template>
  <div
    class="flex flex-col rounded-lg border transition-colors"
    :class="
      selected
        ? 'border-primary ring-primary bg-primary/5 ring-1'
        : 'border-default bg-default'
    "
  >
    <button
      type="button"
      class="focus-visible:ring-primary flex min-h-16 w-full flex-1 items-start gap-2.5 rounded-lg p-2 text-start outline-none focus-visible:ring-2 enabled:hover:bg-elevated/60 disabled:cursor-not-allowed disabled:opacity-60"
      :aria-pressed="selected"
      :disabled="disabled"
      @click="emit('toggle')"
    >
      <CommonAccountAvatar
        :src="full?.image"
        :alt="member?.name ?? guest ?? ''"
        :text="avatarText"
        size="md"
      />
      <span class="flex min-w-0 flex-1 flex-col gap-1">
        <span class="flex items-center gap-1.5">
          <CommonMemberBadge
            v-if="member"
            :member="member"
            size="sm"
            :tooltip="false"
            class="min-w-0"
          />
          <span
            v-if="selected && order !== null"
            class="bg-primary text-inverted ms-auto flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-bold tabular-nums"
          >
            <span aria-hidden="true">{{ order }}</span>
            <span v-if="orderLabel" class="sr-only">{{ orderLabel }}</span>
          </span>
          <UIcon
            v-else
            :name="selected ? 'i-lucide-circle-check' : 'i-lucide-circle'"
            class="ms-auto size-4 shrink-0"
            :class="selected ? 'text-primary' : 'text-dimmed'"
            aria-hidden="true"
          />
        </span>
        <span
          v-if="highlight"
          class="text-highlighted text-xs leading-snug font-semibold break-words"
        >
          {{ highlight }}
        </span>
        <span
          v-if="expected"
          class="text-default flex items-center gap-1 text-xs font-medium"
        >
          <UIcon
            name="i-lucide-ticket-check"
            class="text-info size-3.5 shrink-0"
            aria-hidden="true"
          />
          {{ t("session.headcount.expected") }}
        </span>
        <span v-if="note" class="text-muted text-xs">{{ note }}</span>
      </span>
    </button>
    <slot name="extra" />
  </div>
</template>
