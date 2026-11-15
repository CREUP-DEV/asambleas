<script setup lang="ts">
/**
 * A seat's menu in «Colocar» (docs/seating-plan.md, section 7: right click,
 * long press, the context menu key or Shift+F10): «Mover a…»,
 * «Intercambiar con…», «Quitar», «No necesita asiento» and «Detalles». It
 * is the content of the popover anchored to the seat (a drawer on a phone),
 * worded as a menu: the focus starts on its first item, the arrows, Home and
 * End move it, and Escape closes the popover.
 */

defineProps<{
  /** What the menu is about: «Asiento 12, U exterior: UGR, Ana Pérez». */
  title: string;
  items: readonly {
    key: string;
    label: string;
    icon: string;
    danger?: boolean;
  }[];
}>();

const emit = defineEmits<{ select: [key: string] }>();

const list = useTemplateRef<HTMLElement>("list");

function buttons(): HTMLButtonElement[] {
  return Array.from(
    list.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
  );
}

function onKeydown(event: KeyboardEvent): void {
  const all = buttons();
  if (all.length === 0) return;
  const at = all.indexOf(document.activeElement as HTMLButtonElement);
  let next: number | null = null;
  switch (event.key) {
    case "ArrowDown":
      next = (at + 1) % all.length;
      break;
    case "ArrowUp":
      next = (at - 1 + all.length) % all.length;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = all.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  all[next]?.focus();
}

// The popover settles its own focus first; the first item takes it then.
onMounted(() => {
  setTimeout(() => buttons()[0]?.focus({ preventScroll: true }), 0);
});

const titleId = useId();
</script>

<template>
  <div class="w-64 max-w-full p-1">
    <p :id="titleId" class="text-muted px-2 pt-1 pb-1.5 text-xs break-words">
      {{ title }}
    </p>
    <ul ref="list" role="menu" :aria-labelledby="titleId" @keydown="onKeydown">
      <li v-for="item in items" :key="item.key" role="none">
        <button
          type="button"
          role="menuitem"
          tabindex="-1"
          class="text-default hover:bg-elevated focus-visible:bg-elevated flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-(--ui-primary)"
          @click="emit('select', item.key)"
        >
          <UIcon
            :name="item.icon"
            class="size-4 shrink-0"
            :class="item.danger ? 'text-error' : 'text-muted'"
            aria-hidden="true"
          />
          <span>{{ item.label }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>
