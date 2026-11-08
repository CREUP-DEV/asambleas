/**
 * Status boxes (success, info, warning, error) keep their text neutral: the
 * colour goes on the icon, the tint and the ring only, since coloured text
 * on a tint of the same colour does not read (AGENTS.md, "Language, i18n And
 * Accessibility").
 */
const statusBox = (icon: string) => ({
  root: "text-default",
  title: "text-highlighted",
  icon,
});

/**
 * Short status labels (badges, buttons) keep their colour, one step darker
 * in light mode: the 700 token reads on white but not always on its own 10%
 * tint (yellow 4.3:1). Tailwind only generates classes it finds written out,
 * so every class is spelled in full.
 */
const ON_TINT = {
  success: "text-success-800 dark:text-success",
  info: "text-info-800 dark:text-info",
  warning: "text-warning-800 dark:text-warning",
  error: "text-error-800 dark:text-error",
} as const;

const BOX_ICON = {
  success: "text-success",
  info: "text-info",
  warning: "text-warning",
  error: "text-error",
} as const;

type StatusColor = keyof typeof ON_TINT;
const STATUS_COLORS = Object.keys(ON_TINT) as StatusColor[];

export default defineAppConfig({
  ui: {
    colors: {
      primary: "creup-red",
      secondary: "creup-blue",
    },
    toast: {
      slots: {
        title: "text-sm font-medium text-highlighted select-text",
        description: "text-sm text-muted select-text",
      },
    },
    alert: {
      compoundVariants: STATUS_COLORS.map((color) => ({
        color,
        variant: ["subtle", "soft", "outline"],
        class: statusBox(BOX_ICON[color]),
      })),
    },
    badge: {
      compoundVariants: STATUS_COLORS.map((color) => ({
        color,
        variant: ["subtle", "soft"],
        class: ON_TINT[color],
      })),
    },
    button: {
      compoundVariants: STATUS_COLORS.map((color) => ({
        color,
        variant: ["subtle", "soft", "outline", "ghost"],
        class: ON_TINT[color],
      })),
    },
  },
});
