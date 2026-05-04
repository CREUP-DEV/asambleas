#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = resolve(__dirname, "../i18n/locales");

type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

function flattenLeaves(
  obj: JSONValue,
  prefix = "",
): Array<[string, JSONValue]> {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return [[prefix, obj]];
  }

  return Object.entries(obj).flatMap(([key, value]) =>
    flattenLeaves(value, prefix ? `${prefix}.${key}` : key),
  );
}

function loadLocale(file: string): Map<string, JSONValue> {
  const raw = readFileSync(resolve(LOCALES_DIR, file), "utf-8");
  const parsed = JSON.parse(raw) as JSONValue;
  return new Map(flattenLeaves(parsed));
}

function extractPlaceholders(value: string): string[] {
  const matches = value.matchAll(/\{([a-zA-Z0-9_]+)\}/g);

  return [...new Set([...matches].map((match) => match[1]))].sort();
}

const BASE = "es.json";
const localeFiles = ["en.json"];

const baseKeys = loadLocale(BASE);
let hasErrors = false;

for (const file of localeFiles) {
  const targetLocale = loadLocale(file);
  const targetKeys = new Set(targetLocale.keys());
  const baseKeySet = new Set(baseKeys.keys());

  const missingInTarget = [...baseKeySet].filter((k) => !targetKeys.has(k));
  const extraInTarget = [...targetKeys].filter((k) => !baseKeySet.has(k));
  const placeholderMismatches = [...baseKeys.entries()]
    .filter(([key]) => targetLocale.has(key))
    .flatMap(([key, baseValue]) => {
      const targetValue = targetLocale.get(key);

      if (typeof baseValue !== "string" || typeof targetValue !== "string") {
        return [];
      }

      const basePlaceholders = extractPlaceholders(baseValue);
      const targetPlaceholders = extractPlaceholders(targetValue);

      if (basePlaceholders.join(",") === targetPlaceholders.join(",")) {
        return [];
      }

      return [
        {
          key,
          basePlaceholders,
          targetPlaceholders,
        },
      ];
    });

  if (
    missingInTarget.length === 0 &&
    extraInTarget.length === 0 &&
    placeholderMismatches.length === 0
  ) {
    console.log(`✓ ${file} — keys and placeholders match ${BASE}`);
    continue;
  }

  hasErrors = true;
  console.error(`\n✗ ${file} — key mismatch with ${BASE}`);

  if (missingInTarget.length > 0) {
    console.error(`  Missing keys (in ${BASE} but not in ${file}):`);
    for (const key of missingInTarget) {
      console.error(`    - ${key}`);
    }
  }

  if (extraInTarget.length > 0) {
    console.error(`  Extra keys (in ${file} but not in ${BASE}):`);
    for (const key of extraInTarget) {
      console.error(`    + ${key}`);
    }
  }

  if (placeholderMismatches.length > 0) {
    console.error(`  Placeholder mismatches:`);
    for (const mismatch of placeholderMismatches) {
      console.error(
        `    ! ${mismatch.key} — ${BASE}: {${mismatch.basePlaceholders.join(", ")}} | ${file}: {${mismatch.targetPlaceholders.join(", ")}}`,
      );
    }
  }
}

if (hasErrors) {
  process.exit(1);
}
