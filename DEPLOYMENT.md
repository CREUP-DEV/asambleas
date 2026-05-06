# CREUP Asambleas - Despliegue

Runbook de producción para CREUP Asambleas. El README cubre desarrollo local; este documento solo cubre operación y despliegue.

## Arquitectura

```text
Internet
  |
  v
NGINX con TLS
  |
  v
Nitro / Node 22 en puerto 3000
  |
  v
PostgreSQL 5432
```

- El build se genera en local o CI.
- El servidor ejecuta `.output/server/index.mjs`.
- PostgreSQL no debe exponerse a internet.
- `pg-boss` usa la misma base de datos.
- Los PDFs generados se guardan en `EXPORT_STORAGE_DIR`; ese directorio debe ser persistente.
- No hay Redis ni Mailpit.

## Requisitos Del VPS

- Ubuntu 22.04+ o Debian 12+.
- Docker Engine y Docker Compose v2.
- NGINX y Certbot.
- 1 GB de RAM mínimo, 2 GB recomendado.
- Dominio apuntando al VPS.

## Directorios

Ejemplo con `/opt/creup-asambleas`:

```bash
sudo mkdir -p /opt/creup-asambleas
sudo chown "$USER:$USER" /opt/creup-asambleas
cd /opt/creup-asambleas
mkdir -p app/.output storage/exports backups
```

## Entorno De Producción

Crear `/opt/creup-asambleas/.env`:

```env
NUXT_SITE_URL=https://asambleas.creup.es
TZ=Europe/Madrid
NODE_ENV=production

APP_SECRET=<openssl rand -base64 32>

INITIAL_ADMIN_EMAIL=tic@creup.es
GOOGLE_CLIENT_ID=<client-id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<client-secret>
NUXT_ROLE_API_URL=https://intranet.creup.es/api/user/role

POSTGRES_USER=creup_asambleas
POSTGRES_PASSWORD=<password>
POSTGRES_DB=creup_asambleas
DATABASE_URL=postgresql://creup_asambleas:<password>@postgres:5432/creup_asambleas?schema=public
DATABASE_MAX_CONNECTIONS=20

EXPORT_STORAGE_DIR=/app/storage/exports

NUXT_PUBLIC_UMAMI_HOST=
NUXT_PUBLIC_UMAMI_WEBSITE_ID=
```

Notas:

- En Compose, `DATABASE_URL` usa host `postgres`, no `localhost`.
- `NUXT_SITE_URL` debe coincidir con el dominio real usado por OAuth.
- Google OAuth debe registrar `https://asambleas.creup.es/api/auth/callback/google`.

## Compose De Producción

Ejemplo mínimo:

```yaml
services:
  app:
    image: node:22-alpine
    working_dir: /app
    command: node .output/server/index.mjs
    restart: unless-stopped
    env_file: .env
    ports:
      - "127.0.0.1:3000:3000"
    depends_on:
      postgres:
        condition: service_healthy
    volumes:
      - ./app/.output:/app/.output:ro
      - ./storage/exports:/app/storage/exports

  postgres:
    image: postgres:18-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  pgdata:
```

## NGINX

Configurar TLS con Certbot y hacer proxy a `127.0.0.1:3000`:

```nginx
server {
    listen 80;
    server_name asambleas.creup.es;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name asambleas.creup.es;

    ssl_certificate /etc/letsencrypt/live/asambleas.creup.es/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/asambleas.creup.es/privkey.pem;

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

No dupliques CSP/HSTS en NGINX si los gestiona `nuxt-security`.

## Primer Despliegue

En local o CI:

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm i18n:check
pnpm build
rsync -az --delete .output/ user@vps:/opt/creup-asambleas/app/.output/
```

En el VPS:

```bash
cd /opt/creup-asambleas
docker compose -f docker-compose.prod.yml up -d
```

Aplicar migraciones antes de abrir el servicio al público. La forma más simple es ejecutar `pnpm db:migrate` desde un entorno con acceso a la base de datos y `DATABASE_URL` de producción. Ejecuta `pnpm db:seed` solo en el primer despliegue o cuando cambien roles/permisos de sistema.

Comprobación rápida:

```bash
curl -I https://asambleas.creup.es
```

Sin sesión, la app debe redirigir a `/login`.

## Actualizaciones

```bash
pnpm lint
pnpm typecheck
pnpm i18n:check
pnpm build
rsync -az --delete .output/ user@vps:/opt/creup-asambleas/app/.output/
ssh user@vps "cd /opt/creup-asambleas && docker compose -f docker-compose.prod.yml restart app"
```

Si hay migraciones nuevas, aplícalas antes de reiniciar o antes de enrutar tráfico a la nueva versión.

## Backups

PostgreSQL:

```bash
cd /opt/creup-asambleas
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
  | gzip > "backups/db-$(date +%Y%m%d-%H%M%S).sql.gz"
```

PDFs exportados:

```bash
tar -czf "backups/exports-$(date +%Y%m%d-%H%M%S).tar.gz" storage/exports
```

Retención básica:

```bash
find /opt/creup-asambleas/backups -type f -mtime +30 -delete
```

## Operación

Logs:

```bash
docker compose -f docker-compose.prod.yml logs -f app
docker compose -f docker-compose.prod.yml logs -f postgres
```

Estado:

```bash
docker compose -f docker-compose.prod.yml ps
```

Jobs `pg-boss`:

```sql
SELECT state, COUNT(*) FROM pgboss.job GROUP BY state;
SELECT id, name, state, createdon, completedon
FROM pgboss.job
ORDER BY createdon DESC
LIMIT 20;
```

## Problemas Frecuentes

| Síntoma | Revisión |
| --- | --- |
| La app no arranca | Logs de `app`, `APP_SECRET`, `DATABASE_URL`, credenciales OAuth |
| OAuth falla | Callback en Google, `NUXT_SITE_URL`, cabecera `X-Forwarded-Proto` |
| No conectan migraciones | Host correcto: `postgres` dentro de Compose, `localhost` desde host |
| Export PDF falla | `EXPORT_STORAGE_DIR` existe y es escribible; fuentes en `server/assets/fonts` empaquetadas |
| Jobs no avanzan | Logs del worker, tabla `pgboss.job`, conexión PostgreSQL |
| Descarga 404 tras reinicio | Confirmar que `storage/exports` está montado como volumen persistente |

