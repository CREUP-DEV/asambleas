#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = resolve(__dirname, "../i18n/locales");
const BASE_LOCALE = "es.json";
const TARGET_LOCALE = "en.json";

type JSONValue =
  string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

type IdenticalMatch = {
  key: string;
  value: string;
};

type AllowlistEntry = {
  pattern: RegExp;
  reason: string;
};

const ALLOWLIST: AllowlistEntry[] = [
  {
    pattern: /^assembly\.dateRangeShort$/,
    reason: "Arrow-only format string for numeric date ranges.",
  },
  {
    pattern: /^app\.title$/,
    reason: "Brand name stays the same across locales.",
  },
  {
    pattern: /^common\.no$/,
    reason: "Short negative answer is identical in Spanish and English.",
  },
  {
    pattern: /^assembly\.typesShort\.(AGO|AGE|AGET)$/,
    reason: "Assembly type acronyms are official names.",
  },
  {
    pattern: /^assembly\.statuses\.provisional$/,
    reason: "Workflow status term is identical in Spanish and English.",
  },
  {
    pattern: /^document\.types\.pdf$/,
    reason: "File format acronym stays the same across locales.",
  },
  {
    pattern: /^admin\.roles\.title$/,
    reason: "Role management label is identical in Spanish and English.",
  },
];

function loadLocale(file: string): JSONValue {
  const raw = readFileSync(resolve(LOCALES_DIR, file), "utf-8");
  return JSON.parse(raw) as JSONValue;
}

function collectIdenticalStrings(
  base: JSONValue,
  target: JSONValue,
  prefix = "",
): IdenticalMatch[] {
  if (typeof base === "string" && typeof target === "string") {
    return base === target ? [{ key: prefix, value: base }] : [];
  }

  if (
    !base ||
    !target ||
    typeof base !== "object" ||
    typeof target !== "object" ||
    Array.isArray(base) ||
    Array.isArray(target)
  ) {
    return [];
  }

  return Object.entries(base).flatMap(([key, value]) => {
    const targetValue = (target as Record<string, JSONValue>)[key];
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    return collectIdenticalStrings(value, targetValue, nextPrefix);
  });
}

function isAllowed(key: string): AllowlistEntry | undefined {
  return ALLOWLIST.find((entry) => entry.pattern.test(key));
}

const base = loadLocale(BASE_LOCALE);
const target = loadLocale(TARGET_LOCALE);
const matches = collectIdenticalStrings(base, target);
const allowedMatches = matches.filter((match) => isAllowed(match.key));
const reviewCandidates = matches.filter((match) => !isAllowed(match.key));

console.log(`Locale identical-value audit: ${TARGET_LOCALE} vs ${BASE_LOCALE}`);
console.log("");

if (allowedMatches.length > 0) {
  console.log(`Allowed identical strings (${allowedMatches.length}):`);
  for (const match of allowedMatches) {
    const entry = isAllowed(match.key);
    console.log(`  - ${match.key}: ${match.value}`);
    if (entry) {
      console.log(`    reason: ${entry.reason}`);
    }
  }
  console.log("");
}

if (reviewCandidates.length > 0) {
  console.log(`Review candidates (${reviewCandidates.length}):`);
  for (const match of reviewCandidates) {
    console.log(`  - ${match.key}: ${match.value}`);
  }
  console.log("");
  console.log("One or more identical strings need translation review.");
  process.exit(1);
}

console.log("No review candidates found.");
