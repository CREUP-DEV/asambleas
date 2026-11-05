import type { InputProps } from "@nuxt/ui";

/**
 * Accessible names for USelectMenu. reka-ui names every combobox trigger
 * "Show popup", in English, which hides both the field's label and the value
 * the menu shows, so each menu passes this name as its `aria-label`.
 */

interface SelectMenuItem {
  label?: string;
  value?: unknown;
  type?: string;
}

/**
 * "Quién lo presenta: PRES · Presidencia": the field's label, then what the
 * menu shows (the chosen items, or the placeholder when none is chosen).
 * Takes flat or grouped items and single or multiple values.
 */
export function selectMenuLabel(
  field: string,
  items: readonly (SelectMenuItem | readonly SelectMenuItem[])[],
  value: unknown,
  placeholder?: string,
): string {
  const chosen = Array.isArray(value)
    ? (value as unknown[])
    : value === undefined || value === null
      ? []
      : [value];
  const options = items.flatMap((item) =>
    Array.isArray(item) ? item : [item as SelectMenuItem],
  );
  const labels = chosen
    .map(
      (one) =>
        options.find(
          (option) =>
            option.type !== "label" &&
            option.type !== "separator" &&
            option.value === one,
        )?.label,
    )
    .filter((label): label is string => Boolean(label));
  if (labels.length > 0) return `${field}: ${labels.join(", ")}`;
  return chosen.length === 0 && placeholder
    ? `${field}: ${placeholder}`
    : field;
}

/**
 * The `search-input` of a USelectMenu with an accessible name: the same text
 * as placeholder and as `aria-label`, so the search box is not named by its
 * placeholder alone. USelectMenu binds these props onto UInput, which passes
 * `aria-label` on to the input, but the prop's type only lists UInput's own
 * props, hence the cast.
 */
export function labelledSearch(text: string): InputProps {
  return { placeholder: text, "aria-label": text } as InputProps;
}
