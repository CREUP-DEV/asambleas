import type { ShallowRef } from "vue";
import {
  pointerStateActive,
  prunePointerState,
  type PointerState,
} from "~/composables/session/pointerState";

/**
 * Lets what the pointer drew go as it fades (prunePointerState), with a
 * timer that runs only while something is on show. For the Mesa's preview
 * and the projection alike.
 */
export function usePointerFade(state: ShallowRef<PointerState>): void {
  let timer: ReturnType<typeof setInterval> | undefined;
  function stop(): void {
    clearInterval(timer);
    timer = undefined;
  }
  watch(state, (value) => {
    if (!pointerStateActive(value) || timer) return;
    timer = setInterval(() => {
      const next = prunePointerState(state.value, Date.now());
      if (next !== state.value) state.value = next;
      if (!pointerStateActive(next)) stop();
    }, 250);
  });
  onBeforeUnmount(stop);
}
