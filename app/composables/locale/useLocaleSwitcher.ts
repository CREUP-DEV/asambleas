import type { DropdownMenuItem } from "@nuxt/ui";

type SupportedLocale = "es" | "en";

type LocaleItem = {
  value: SupportedLocale;
  label: string;
  icon: string;
};

const isSupportedLocale = (value: string): value is SupportedLocale =>
  value === "es" || value === "en";

/**
 * A language's name in that language ("Español", "English"), as nuxt.config
 * declares it, so anyone finds their own language whatever the UI shows.
 */
export function nativeLocaleName(
  locales: readonly { code: string; name?: string }[],
  code: SupportedLocale,
): string {
  return locales.find((entry) => entry.code === code)?.name ?? code;
}

export const useLocaleSwitcher = () => {
  const { locale, locales, setLocaleCookie } = useI18n();
  const switchLocalePath = useSwitchLocalePath();
  const route = useRoute();

  const localeItems = computed<LocaleItem[]>(() => [
    {
      value: "es",
      label: nativeLocaleName(locales.value, "es"),
      icon: "i-circle-flags-es",
    },
    {
      value: "en",
      label: nativeLocaleName(locales.value, "en"),
      icon: "i-circle-flags-gb",
    },
  ]);

  const switchToLocale = (newLocale: string) => {
    if (!isSupportedLocale(newLocale) || newLocale === locale.value) return;

    setLocaleCookie(newLocale);

    const targetPath = switchLocalePath(newLocale);
    if (!targetPath || targetPath === route.fullPath) return;

    void navigateTo(targetPath);
  };

  const currentLocale = computed(() => {
    return (
      localeItems.value.find((item) => item.value === locale.value) ??
      localeItems.value[0]
    );
  });

  const localeMenuItems = computed<DropdownMenuItem[][]>(() => [
    localeItems.value.map((item) => ({
      label: item.label,
      icon: item.icon,
      type: "checkbox",
      checked: item.value === locale.value,
      onSelect: () => switchToLocale(item.value),
    })),
  ]);

  return {
    currentLocale,
    localeMenuItems,
  };
};
