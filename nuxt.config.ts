import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import type { NitroRouteConfig } from "nitropack/types";
import type { NuxtSecurityRouteRules } from "nuxt-security";
import { getOptionalConfigUrl } from "./shared/utils/config";

const isDev = process.env.NODE_ENV !== "production";

const siteUrl =
  getOptionalConfigUrl(process.env.NUXT_SITE_URL, "NUXT_SITE_URL") ||
  "http://localhost:3000";
const canonicalSiteUrl = siteUrl;
const umamiHost = getOptionalConfigUrl(
  process.env.NUXT_PUBLIC_UMAMI_HOST,
  "NUXT_PUBLIC_UMAMI_HOST",
);
const umamiId = process.env.NUXT_PUBLIC_UMAMI_WEBSITE_ID?.trim() || "";
const isUmamiConfigured = Boolean(umamiId && umamiHost);

// nuxt-security keys its rate limiter on the client IP plus the route rule
// that matches (not the path), with a fixed window per bucket. The venue's
// whole room comes out of one public IP (eduroam NAT, behind Cloudflare), so
// a per-IP budget on the assembly API is a budget for the whole room, Mesa
// included: one burst of votes or a wave of SSE reconnections would answer
// 429 to everyone until the window ends. Those routes go without it (they
// all need a Google session first, `server/handlers/protected.ts`).
//
// A route-level `false` wins over the global object: nuxt-security merges
// every matching rule with defu, most specific first (radix3 `matchAll`,
// reversed), and defu keeps the first non-null value. A rule under
// `/api/assemblies/**` that sets no `rateLimiter` inherits its `false`, and
// `/**` cannot bring the limiter back; one that sets an object overrides it,
// is completed from the global options (driver, headers) and counts in a
// bucket of its own (ip + that rule's pattern, shared by every assembly and
// document). `server/securityRules.test.ts` replays that resolution.
//
// The expensive endpoints keep a separate, generous bucket. Uploads (PDFs,
// DOCX imports, images, the signed convocatoria) are read whole into memory
// and only presenters and the Secretaría send them, never the whole room at
// once: 300 per 5 minutes is room for every council uploading together.
// Exports queue a PDF job each and anyone who sees the assembly may ask for
// one; the room may do it at once ("descargad el PDF"), and the bucket is
// shared by every document of every assembly, so it allows 1,000 per
// 5 minutes (about ten each for a hundred devices).
const UPLOAD_RATE_LIMIT = {
  tokensPerInterval: 300,
  interval: 300_000,
};
const EXPORT_RATE_LIMIT = {
  tokensPerInterval: 1000,
  interval: 300_000,
};

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
  // Whole documents travel as JSON blocks (drafts, totality amendments), and
  // DOCX imports and PDFs go up as multipart. nuxt-security's defaults (2 MB
  // JSON, 8 MB uploads) would answer 413 before the handlers' own limits.
  "/api/assemblies/**": {
    security: {
      rateLimiter: false,
      requestSizeLimiter: {
        maxRequestSizeInBytes: 6_000_000,
        maxUploadFileRequestInBytes: 8_000_000,
      },
    },
  },
  "/api/assemblies/*/documents/*/import": {
    security: {
      rateLimiter: UPLOAD_RATE_LIMIT,
      requestSizeLimiter: {
        maxRequestSizeInBytes: 6_000_000,
        maxUploadFileRequestInBytes: 16_000_000,
      },
    },
  },
  "/api/assemblies/*/documents/*/file": {
    security: {
      rateLimiter: UPLOAD_RATE_LIMIT,
      requestSizeLimiter: {
        maxRequestSizeInBytes: 6_000_000,
        maxUploadFileRequestInBytes: 21_000_000,
      },
    },
  },
  "/api/assemblies/*/documents/*/images": {
    security: {
      rateLimiter: UPLOAD_RATE_LIMIT,
    },
  },
  "/api/assemblies/*/convocation": {
    security: {
      rateLimiter: UPLOAD_RATE_LIMIT,
      requestSizeLimiter: {
        maxRequestSizeInBytes: 6_000_000,
        maxUploadFileRequestInBytes: 21_000_000,
      },
    },
  },
  "/api/assemblies/*/export": {
    security: {
      rateLimiter: EXPORT_RATE_LIMIT,
    },
  },
  "/api/assemblies/*/documents/*/export": {
    security: {
      rateLimiter: EXPORT_RATE_LIMIT,
    },
  },
  // Export status polling and downloads: authenticated and owner-checked,
  // and polled by every device that asked for a PDF.
  "/api/exports/**": {
    security: {
      rateLimiter: false,
    },
  },
  // The account's own data (`/api/me`, `/api/me/work`, `/api/me/activity`):
  // every device in the room reads it on each page and the overview refetches
  // `/api/me/work` on live events, so it goes without the per-IP limiter too.
  // radix3 matches `/api/me` itself here, never `/api/members`.
  "/api/me/**": {
    security: {
      rateLimiter: false,
    },
  },
  // Uploaded PDFs are shown inside the document page and the convocatoria
  // (DocumentPdfViewer): only these routes may be framed, and only by the
  // platform itself.
  "/api/uploads/documents/**": {
    security: {
      headers: {
        contentSecurityPolicy: {
          "frame-ancestors": ["'self'"],
        },
        xFrameOptions: "SAMEORIGIN",
      },
    },
  },
  "/api/uploads/convocations/**": {
    security: {
      headers: {
        contentSecurityPolicy: {
          "frame-ancestors": ["'self'"],
        },
        xFrameOptions: "SAMEORIGIN",
      },
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

const adminHandler = "./server/handlers/auth.ts";
const protectedHandler = "./server/handlers/protected.ts";

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
    // What keeps the per-IP limiter: pages, `/api/auth` and the smaller
    // authenticated sections (`/api/members`, uploaded images), all in one
    // bucket per IP. Generous, since a room shares one IP; the assembly API,
    // exports and `/api/me` go without it (see the route rules above).
    rateLimiter: {
      tokensPerInterval: 12000,
      interval: 300000,
    },
    // Off on purpose. It runs FilterXSS over JSON.stringify of every GET
    // query and POST body (multipart files included, as arrays of numbers)
    // and answers 400 when anything changes: it refused plain text such as
    // "<<Ley>>", ">50 %" or "a -> b" in amendments and notes while letting
    // "<b>hola</b>" through, and froze the server for seconds on each large
    // upload. Input is validated with Zod, content is stored as blocks
    // (`blocksSchema`) and rendered escaped (`shared/utils/content/render.ts`).
    xssValidator: false,
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
        // The document page frames its uploaded PDF; every other page still
        // refuses to be framed (frame-ancestors).
        "frame-src": ["'self'"],
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
    // Not read by the server: the role lookup reads process.env through
    // getRoleApiUrl (server/utils/members/intranet.ts), which defaults to
    // `${NUXT_INTRANET_API_URL}/user/role`. Empty by default: the old public
    // Intranet route (/api/user/role) no longer exists (docs/intranet.md,
    // section 8).
    roleApiUrl: process.env.NUXT_ROLE_API_URL || "",
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
    // Raleway for the UI, from the files the PDF exports embed (fonts.css).
    publicAssets: [
      {
        baseURL: "/fonts/raleway",
        dir: fileURLToPath(new URL("./server/assets/fonts", import.meta.url)),
        maxAge: 7 * 24 * 60 * 60,
      },
    ],
  },

  css: ["~/assets/css/fonts.css", "~/assets/css/main.css"],

  routeRules,

  // Nitro registers `middleware: true` handlers with `h3App.use(route, ...)`,
  // which prefix-matches literally: a `/**` suffix never matches and the
  // middleware silently never runs. `/api/auth` is deliberately absent, since
  // the Google OAuth callback is a cross-origin POST.
  serverHandlers: [
    {
      route: "/api/admin",
      middleware: true,
      handler: adminHandler,
    },
    ...[
      "/api/assemblies",
      "/api/exports",
      "/api/uploads",
      "/api/members",
      "/api/calendar-rules",
      "/api/me",
    ].map((route) => ({
      route,
      middleware: true,
      handler: protectedHandler,
    })),
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
        // Self-hosted with its metrics pinned (app/assets/css/fonts.css).
        name: "Raleway",
        provider: "none",
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
        provider: "none",
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
