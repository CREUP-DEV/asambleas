<script setup lang="ts">
/**
 * A side section of the console that folds away: a heading button with an
 * optional short summary (shown folded or not, up to two lines, so an
 * agenda item's title is not cut where it differs), and its content. Each
 * Mesa member's device remembers which sections they keep open. Folded
 * content stays mounted, so a half-written turn or an open list survives.
 */
const props = withDefaults(
  defineProps<{
    /** Unique per console; also the storage key of the open state. */
    id: string;
    title: string;
    icon: string;
    /** A short summary under the title (up to two lines), e.g. who has the floor. */
    summary?: string | null;
    defaultOpen?: boolean;
  }>(),
  { summary: null, defaultOpen: true },
);

defineSlots<{ default?: () => unknown }>();

const stored = useLocalStorage<boolean>(
  `session-fold-${props.id}`,
  props.defaultOpen,
);
const open = computed({
  get: () => stored.value !== false,
  set: (value: boolean) => {
    stored.value = value;
  },
});

const titleId = computed(() => `session-fold-${props.id}-title`);
const contentId = computed(() => `session-fold-${props.id}-content`);
</script>

<template>
  <section
    class="border-default bg-default rounded-xl border"
    :aria-labelledby="titleId"
  >
    <h2 :id="titleId" class="m-0">
      <UButton
        color="neutral"
        variant="ghost"
        block
        :icon="icon"
        trailing-icon="i-lucide-chevron-down"
        class="justify-start rounded-xl px-3 py-2.5"
        :ui="{
          leadingIcon: 'self-start mt-0.5',
          trailingIcon: [
            'ms-auto self-start mt-0.5 transition-transform duration-200 motion-reduce:transition-none',
            open ? 'rotate-180' : '',
          ].join(' '),
        }"
        :aria-expanded="open"
        :aria-controls="contentId"
        @click="open = !open"
      >
        <span class="flex min-w-0 flex-col items-start text-start">
          <span class="text-highlighted font-semibold">{{ title }}</span>
          <span
            v-if="summary"
            class="text-muted line-clamp-2 max-w-full text-xs font-normal break-words"
          >
            {{ summary }}
          </span>
        </span>
      </UButton>
    </h2>
    <div v-show="open" :id="contentId" class="px-3 pb-3">
      <slot />
    </div>
  </section>
</template>
