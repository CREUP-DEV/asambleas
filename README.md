# CREUP Asambleas

Plataforma interna de CREUP para gestionar asambleas, orden del día, documentos, enmiendas y exportaciones PDF.

Este repositorio está separado de la web pública `creup/web`, pero comparte identidad visual y parte de las decisiones de stack.

## Qué Incluye

- Autenticación obligatoria con Google mediante `better-auth`.
- Sincronización de rol y de miembros con la Intranet de CREUP (el listado, a mano y cada día); una cuenta borrada en la Intranet pierde el acceso.
- RBAC con roles de sistema y matriz de permisos editable.
- Asambleas con estados `draft`, `provisional` y `definitive`.
- Orden del día recursivo con rutas por slug legibles.
- Documentos de plataforma con editor TipTap y documentos PDF subidos.
- Enmiendas por patches `diff-match-patch`, incluidas transaccionales.
- Diff accesible con modo por color, modo por marcas y vista lado a lado.
- Exportación PDF asíncrona con `pg-boss` y almacenamiento persistente.
- UI en español e inglés mediante i18n.
- Preferencias de accesibilidad para contenido: Raleway, Atkinson Hyperlegible y OpenDyslexic.

## Stack

- Nuxt 4 + Nitro
- Nuxt UI v4 + Tailwind CSS v4
- PostgreSQL + Drizzle ORM
- `better-auth` con Google OAuth
- `@nuxtjs/i18n`, `@nuxt/a11y`, `nuxt-security` y `nuxt-umami`
- `pg-boss` para trabajos en segundo plano sobre PostgreSQL
- `pdfmake` para exportaciones PDF
- Zod v4 para validación

No hay Redis ni Mailpit en este proyecto. Sesiones, colas y datos persistentes usan PostgreSQL; la caché de permisos es en memoria.

## Desarrollo Local

Requisitos:

- Node.js 22+
- pnpm 10.33+
- Docker y Docker Compose

Arranque:

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Servicios locales por defecto:

| Servicio   | URL                     |
| ---------- | ----------------------- |
| Aplicación | `http://localhost:3000` |
| Adminer    | `http://localhost:8080` |
| PostgreSQL | `localhost:5432`        |

## Variables De Entorno

La referencia completa está en `.env.example`. Las variables que casi siempre hay que revisar son:

| Variable                                                  | Uso                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NUXT_SITE_URL`                                           | Origen público de la aplicación                                                                                                                                                                                                                                                               |
| `APP_SECRET`                                              | Secreto de sesiones, generar con `openssl rand -base64 32`                                                                                                                                                                                                                                    |
| `INITIAL_ADMIN_EMAIL`                                     | Cuenta que recibirá rol `Admin` en el primer acceso                                                                                                                                                                                                                                           |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`               | Credenciales OAuth de Google                                                                                                                                                                                                                                                                  |
| `NUXT_INTRANET_API_URL`                                   | Base de la API de la Intranet: rol al iniciar sesión y listado de miembros. `https://intranet.creup.es/api/asambleas/v1`, también en desarrollo (datos reales); en el VPS, también `http://intranet/api/asambleas/v1`. En producción solo admite `https:` o `http:` hacia un nombre sin punto |
| `NUXT_INTRANET_API_TOKEN`                                 | Token de servicio de la Intranet. Sin él, nadie pierde el acceso aunque la Intranet borre su cuenta                                                                                                                                                                                           |
| `NUXT_INTRANET_ROSTER_SYNC`                               | Opcional: `false` apaga la sincronización diaria del listado (05:00)                                                                                                                                                                                                                          |
| `NUXT_ROLE_API_URL`                                       | Opcional, normalmente vacía: sustituye a `${NUXT_INTRANET_API_URL}/user/role`                                                                                                                                                                                                                 |
| `DATABASE_URL`                                            | Conexión PostgreSQL                                                                                                                                                                                                                                                                           |
| `EXPORT_STORAGE_DIR`                                      | Directorio persistente para PDFs generados                                                                                                                                                                                                                                                    |
| `NUXT_PUBLIC_UMAMI_HOST` / `NUXT_PUBLIC_UMAMI_WEBSITE_ID` | Analítica Umami opcional                                                                                                                                                                                                                                                                      |

En local, las variables de la Intranet pueden quedar vacías: todas las cuentas entran como `Invitado` y no hay sincronización del listado. El contrato con la Intranet está en [docs/intranet.md](docs/intranet.md).

## Scripts

| Comando                       | Uso                                 |
| ----------------------------- | ----------------------------------- |
| `pnpm dev`                    | Servidor de desarrollo              |
| `pnpm build`                  | Build de producción                 |
| `pnpm preview`                | Previsualización del build          |
| `pnpm lint` / `pnpm lint:fix` | ESLint                              |
| `pnpm typecheck`              | Tipado de Nuxt/Vue                  |
| `pnpm db:generate`            | Generar migraciones Drizzle         |
| `pnpm db:migrate`             | Aplicar migraciones                 |
| `pnpm db:seed`                | Sembrar roles y permisos            |
| `pnpm db:studio`              | Drizzle Studio                      |
| `pnpm i18n:check`             | Paridad de claves de traducción     |
| `pnpm i18n:audit-identical`   | Auditoría de traducciones idénticas |

## Estructura

```text
app/              Frontend Nuxt: páginas, layouts, componentes y composables
server/           API Nitro, auth, workers, DB y utilidades de servidor
shared/           Constantes, schemas Zod y utilidades compartidas
i18n/locales/     Traducciones ES/EN
drizzle/          Migraciones y seed
ops/              Scripts operativos
scripts/          Checks auxiliares
server/assets/    Fuentes y assets empaquetados para servidor
```

## Documentación Relacionada

- [DEPLOYMENT.md](DEPLOYMENT.md): despliegue de producción, backups y operación.
- [docs/intranet.md](docs/intranet.md): integración con la Intranet de CREUP (rol, listado de miembros, cuentas borradas).
- [AGENTS.md](AGENTS.md): reglas obligatorias para agentes que editen el código.
- [PLAN.md](PLAN.md): plan histórico por fases. No sustituye a `AGENTS.md`.

## Verificación Antes De PR

```bash
pnpm lint
pnpm typecheck
pnpm i18n:check
pnpm i18n:audit-identical
pnpm build
```

## Licencia

[GPL-3.0](LICENSE)
