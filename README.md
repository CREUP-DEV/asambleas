# CREUP Asambleas

Plataforma interna de CREUP (Coordinadora de Representantes de Estudiantes de Universidades Públicas) para gestionar asambleas, puntos del orden del día, documentación y enmiendas.

## Stack técnico

- **Framework:** Nuxt 4 + Nitro
- **UI:** Nuxt UI v4 + Tailwind CSS v4
- **Auth:** better-auth con OAuth de Google
- **Base de datos:** PostgreSQL + Drizzle ORM
- **Validación:** Zod
- **i18n:** @nuxtjs/i18n (español + inglés)
- **Accesibilidad:** @nuxt/a11y
- **Analítica:** nuxt-umami (self-hosted, sin cookies)
- **Trabajos en segundo plano:** pg-boss (cola sobre PostgreSQL)
- **Generación PDF:** pdfmake
- **Diffs:** diff-match-patch

## Requisitos

- [Node.js](https://nodejs.org/) 22+
- [pnpm](https://pnpm.io/) 10.33+
- [Docker](https://www.docker.com/) para PostgreSQL y Adminer

## Puesta en marcha

```bash
# Instalar dependencias
pnpm install

# Copiar variables de entorno y configurar credenciales
cp .env.example .env

# Levantar infraestructura (PostgreSQL + Adminer)
docker compose up -d

# Aplicar migraciones
pnpm db:migrate

# Sembrar roles y permisos de sistema
pnpm db:seed

# Arrancar servidor de desarrollo (puerto 3001)
pnpm dev
```

## Desarrollo

```bash
pnpm dev           # Arrancar servidor de desarrollo (puerto 3001)
pnpm build         # Compilar para producción
pnpm preview       # Previsualizar build de producción
pnpm lint          # Ejecutar ESLint
pnpm lint:fix      # Corregir problemas de lint
pnpm typecheck     # Ejecutar comprobación de tipos
```

### Base de datos

```bash
pnpm db:generate   # Generar migraciones Drizzle
pnpm db:migrate    # Aplicar migraciones
pnpm db:seed       # Sembrar roles y permisos de sistema
pnpm db:studio     # Abrir Drizzle Studio
```

### i18n

```bash
pnpm i18n:check             # Verificar paridad de claves entre locales
pnpm i18n:audit-identical   # Buscar traducciones idénticas
```

### Infraestructura

- **PostgreSQL:** localhost:5433
- **Adminer:** http://localhost:8089

## Licencia

[GPL-3.0](LICENSE)
