<script setup lang="ts">
/**
 * A section of the home page or the assembly overview that stays folded
 * until the reader opens it: what is worth having at hand but is not the
 * next thing to do (news, the reader's documents and amendments, the full
 * calendar, figures, administration shortcuts). Closed by default; each
 * browser remembers what its user keeps open. The stored state is read
 * after mounting, so the server and the first client render agree. Folded
 * content stays mounted.
 */
const props = withDefaults(
  defineProps<{
    /** Unique per page; also the storage key of the open state. */
    id: string;
    title: string;
    icon: string;
    /** How many things are inside, shown next to the title when above 0. */
    count?: number;
    headingLevel?: 2 | 3 | 4;
  }>(),
  { count: 0, headingLevel: 2 },
);

defineSlots<{ default?: () => unknown }>();

const storageKey = computed(() => `home-fold-${props.id}`);
const open = ref(false);

onMounted(() => {
  try {
    open.value = window.localStorage.getItem(storageKey.value) === "1";
  } catch {
    // No storage (private mode, blocked): it just starts folded.
  }
});

function toggle(): void {
  open.value = !open.value;
  try {
    window.localStorage.setItem(storageKey.value, open.value ? "1" : "0");
  } catch {
    // Not remembered; the section still opens and closes.
  }
}

const headingTag = computed(() => `h${props.headingLevel}`);
const titleId = computed(() => `home-fold-${props.id}-title`);
const contentId = computed(() => `home-fold-${props.id}-content`);
</script>

<template>
  <section
    class="border-default bg-default rounded-lg border"
    :aria-labelledby="titleId"
    :data-testid="`fold-${id}`"
  >
    <component :is="headingTag" :id="titleId" class="m-0">
      <UButton
        color="neutral"
        variant="ghost"
        block
        :icon="icon"
        trailing-icon="i-lucide-chevron-down"
        class="justify-start rounded-lg px-4 py-3"
        :ui="{
          trailingIcon: [
            'ms-auto transition-transform duration-200 motion-reduce:transition-none',
            open ? 'rotate-180' : '',
          ].join(' '),
        }"
        :aria-expanded="open"
        :aria-controls="contentId"
        @click="toggle"
      >
        <span class="flex min-w-0 items-center gap-2 text-start">
          <span class="text-highlighted font-semibold">{{ title }}</span>
          <UBadge
            v-if="count > 0"
            :label="String(count)"
            color="neutral"
            variant="subtle"
            size="sm"
          />
        </span>
      </UButton>
    </component>
    <div v-show="open" :id="contentId" class="px-4 pb-4">
      <slot />
    </div>
  </section>
</template>
