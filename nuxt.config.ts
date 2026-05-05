import tailwindcss from "@tailwindcss/vite";
import type { NitroRouteConfig } from "nitropack/types";
import type { NuxtSecurityRouteRules } from "nuxt-security";
import { getOptionalConfigUrl } from "./shared/utils/config";

const isDev = process.env.NODE_ENV !== "production";

const siteUrl =
  getOptionalConfigUrl(process.env.NUXT_SITE_URL, "NUXT_SITE_URL") ||
  "http://localhost:3001";
const canonicalSiteUrl = siteUrl;
const umamiHost = getOptionalConfigUrl(
  process.env.NUXT_PUBLIC_UMAMI_HOST,
  "NUXT_PUBLIC_UMAMI_HOST",
);
const umamiId = process.env.NUXT_PUBLIC_UMAMI_WEBSITE_ID?.trim() || "";
const isUmamiConfigured = Boolean(umamiId && umamiHost);

const routeRules = {
  "/admin/**": {
    headers: {
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  },
  "/api/**": {
    headers: {
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  },
  "/_nuxt/**": {
    headers: {
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  },
} satisfies Record<
  string,
  NitroRouteConfig & { security?: NuxtSecurityRouteRules }
>;

const authHandler = "./server/handlers/auth.ts";

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: "2026-04-09",
  devtools: { enabled: isDev },
  future: { compatibilityVersion: 4 },
  vite: {
    plugins: [tailwindcss()],
    server: {
      allowedHosts: isDev
        ? ["localhost", "127.0.0.1", ".trycloudflare.com"]
        : undefined,
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (!id.includes("node_modules")) {
              return;
            }

            if (
              id.includes("node_modules/.pnpm/reka-ui") ||
              id.includes("node_modules/reka-ui/") ||
              id.includes("node_modules/.pnpm/@floating-ui") ||
              id.includes("node_modules/@floating-ui/")
            ) {
              return "vendor_reka";
            }

            if (
              id.includes("node_modules/.pnpm/tailwind-variants") ||
              id.includes("node_modules/tailwind-variants/") ||
              id.includes("node_modules/.pnpm/tailwind-merge") ||
              id.includes("node_modules/tailwind-merge/") ||
              id.includes("node_modules/.pnpm/class-variance-authority") ||
              id.includes("node_modules/class-variance-authority/")
            ) {
              return "vendor_ui_styles";
            }
          },
        },
      },
    },
  },
  alias: {
    "@/composables": "./app/composables",
  },
  imports: {
    dirs: ["composables/**"],
  },
  modules: [
    "nuxt-security",
    "@nuxt/ui",
    "@nuxt/fonts",
    "@nuxt/eslint",
    "@nuxtjs/i18n",
    "@nuxt/icon",
    "@vueuse/nuxt",
    "@nuxt/a11y",
    ...(isUmamiConfigured ? ["nuxt-umami"] : []),
  ],

  security: {
    nonce: true,
    rateLimiter: {
      tokensPerInterval: 500,
      interval: 300000,
    },
    headers: {
      contentSecurityPolicy: {
        "default-src": ["'self'"],
        "script-src": ["'self'", "'nonce-{{nonce}}'", "'strict-dynamic'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "style-src-attr": ["'unsafe-inline'"],
        "img-src": [
          "'self'",
          "data:",
          "blob:",
          "https://lh3.googleusercontent.com",
        ],
        "font-src": ["'self'", "data:"],
        "connect-src": ["'self'"],
        "frame-src": ["'none'"],
        "frame-ancestors": ["'none'"],
        "object-src": ["'none'"],
        "base-uri": ["'self'"],
        "form-action": ["'self'"],
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: "cross-origin",
      strictTransportSecurity: {
        maxAge: 31536000,
        includeSubdomains: true,
      },
      xContentTypeOptions: "nosniff",
      xFrameOptions: "DENY",
      referrerPolicy: "strict-origin-when-cross-origin",
      permissionsPolicy: {
        camera: [],
        microphone: [],
        geolocation: [],
      },
    },
  },

  icon: {
    provider: "server",
    fallbackToApi: false,
    collections: ["tabler", "circle-flags", "lucide"],
    serverBundle: {
      collections: ["tabler", "circle-flags", "lucide"],
    },
  },

  runtimeConfig: {
    siteUrl: siteUrl,
    roleApiUrl:
      process.env.NUXT_ROLE_API_URL ||
      "https://intranet.creup.es/api/user/role",
    initialAdminEmail: process.env.INITIAL_ADMIN_EMAIL || "tic@creup.es",
    appSecret: process.env.APP_SECRET || "",
    googleClientId: process.env.GOOGLE_CLIENT_ID || "",
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    public: {
      siteUrl: siteUrl,
    },
  },

  nitro: {
    compressPublicAssets: true,
  },

  css: ["~/assets/css/main.css"],

  routeRules,

  serverHandlers: [
    {
      route: "/api/admin/**",
      middleware: true,
      handler: authHandler,
    },
  ],

  i18n: {
    vueI18n: "./i18n.config.ts",
    locales: [
      {
        code: "es",
        language: "es-ES",
        file: "es.json",
        name: "Español",
      },
      {
        code: "en",
        language: "en-GB",
        file: "en.json",
        name: "English",
      },
    ],
    defaultLocale: "es",
    baseUrl: canonicalSiteUrl,
    strategy: "prefix_except_default",
    detectBrowserLanguage: {
      useCookie: true,
      cookieKey: "user-locale",
      fallbackLocale: "es",
      redirectOn: "root",
    },
  },

  experimental: {
    payloadExtraction: true,
    renderJsonPayloads: true,
    componentIslands: true,
  },

  fonts: {
    defaults: {
      subsets: ["latin"],
    },
    families: [
      {
        name: "Raleway",
        provider: "google",
        global: true,
        weights: [400, 700],
        styles: ["normal", "italic"],
        subsets: ["latin"],
      },
      {
        name: "Red Rose",
        provider: "none",
      },
      {
        name: "Fira Code",
        provider: "none",
      },
      {
        name: "Atkinson Hyperlegible",
        provider: "google",
        weights: [400, 700],
        styles: ["normal", "italic"],
        subsets: ["latin"],
      },
      {
        name: "OpenDyslexic",
        provider: "google",
        weights: [400, 700],
        styles: ["normal", "italic"],
        subsets: ["latin"],
      },
    ],
  },

  a11y: {
    enabled: isDev,
    defaultHighlight: false,
    logIssues: true,
  },

  ...(isUmamiConfigured
    ? {
        umami: {
          id: umamiId,
          host: umamiHost,
          autoTrack: true,
          ignoreLocalhost: true,
          enabled: true,
        },
      }
    : {}),
});
