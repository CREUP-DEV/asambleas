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
- `pg-boss` usa la misma base de datos, para las exportaciones y para la sincronización diaria del listado de miembros (05:00, Europe/Madrid).
- La plataforma llama a la API de la Intranet por su URL pública, `https://intranet.creup.es/api/asambleas/v1`, con el token. Si se despliega en el mismo VPS, puede llamarla por dentro, `http://intranet/api/asambleas/v1`, uniéndose a la red de Docker de la Intranet (abajo). Cómo y por qué: [docs/intranet.md](docs/intranet.md), sección 5.8.
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

NUXT_INTRANET_API_URL=https://intranet.creup.es/api/asambleas/v1
# o, unida a la red de la Intranet: http://intranet/api/asambleas/v1
NUXT_INTRANET_API_TOKEN=<token asm_... del gestor de contraseñas>
# NUXT_INTRANET_ROSTER_SYNC=false

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
- `NUXT_INTRANET_API_TOKEN` es el token en claro; la Intranet solo guarda su hash. Sin token, la plataforma no puede saber si una cuenta se ha borrado en la Intranet y no retira el acceso a nadie.
- No definas `NUXT_ROLE_API_URL`: la consulta de rol usa `${NUXT_INTRANET_API_URL}/user/role`. La ruta pública vieja (`https://intranet.creup.es/api/user/role`) ya no existe: con ese valor, cada consulta de rol fallaría (nadie pierde el acceso, pero no se actualizan roles ni miembros).
- Con `NODE_ENV=production`, las URL de la Intranet solo admiten `https:` o `http:` hacia un nombre sin punto (`http://intranet`). Cualquier otra cuenta como no configurada y deja un error `intranet.config` en los logs.
- `NUXT_INTRANET_ROSTER_SYNC=false` apaga la sincronización diaria del listado; sin ella, o con otro valor, queda activa.
- Para pasar de la configuración vieja a esta, seguir el orden de [docs/intranet.md](docs/intranet.md), sección 8.

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
    # To call the Intranet as http://intranet instead of its public URL,
    # also join its network (see below):
    # networks: [default, intranet]

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

# Only with the networks line of app above:
# networks:
#   intranet:
#     external: true
#     name: esternocleidomastoideo2003_default
```

Por defecto, `app` llama a la URL pública de la Intranet: pasa por Cloudflare y por nginx, y no hace falta nada más. Para llamarla por dentro (`http://intranet/api/asambleas/v1`, sin salir del VPS), descomentar la red `intranet` en `app` y al final del compose: es la red de Docker de la Intranet (`esternocleidomastoideo2003_default`) y tiene que existir antes de levantar `app`. Por esa red la llamada es HTTP, así que la Intranet necesita `ASSEMBLIES_API_REQUIRE_HTTPS=false` en su `env_file` ([docs/intranet.md](docs/intranet.md), sección 5.8, punto 3). Cambiar de red o de variables exige recrear el contenedor (`up -d app`); `restart` no basta.

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

Si hay migraciones nuevas, aplícalas antes de reiniciar o antes de enrutar tráfico a la nueva versión. Si cambian el `.env` o las redes del compose, `restart` conserva lo de antes: usa `docker compose -f docker-compose.prod.yml up -d app`.

Tras desplegar la versión que guarda el id de la Intranet (migración `0012`), es normal que la primera sincronización del listado dé casi todos los miembros como actualizados, y que el primer inicio de sesión de cada cuenta deje un `user.role_sync` en Actividad: los dos guardan ese id.

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

Sincronización diaria del listado (cola `members-roster-sync`, cada día a las 05:00, Europe/Madrid):

```sql
SELECT id, state, createdon, completedon
FROM pgboss.job
WHERE name = 'members-roster-sync'
ORDER BY createdon DESC
LIMIT 7;
```

- Corre en su propia instancia de `pg-boss`, que abre hasta 2 conexiones más con PostgreSQL.
- Si falla (la Intranet no responde), reintenta dos veces cada 15 minutos. Si el servidor estaba parado a las 05:00, la hace una vez al arrancar.
- Nunca desactiva muchos miembros de golpe: si la Intranet devolviera una lista incompleta, deja `members.sync_blocked` en Actividad y un aviso `members.schedule` en los logs. Revisar la Intranet y, si la baja es real, sincronizar a mano desde Miembros, que pide confirmación.

Revisión diaria de accesos (cola `users-access-recheck`, cada día a las 05:30, Europe/Madrid): vuelve a consultar en la Intranet, una cada medio segundo, las cuentas con sesión abierta, y retira el acceso a las que ya no existen. Corre siempre que haya `NUXT_INTRANET_API_TOKEN`, aunque `NUXT_INTRANET_ROSTER_SYNC=false`. Si la Intranet dijera no tener más de max(3, 30 %) de las cuentas, no retira nada: deja `users.access_recheck_blocked` en Actividad y un error `access.recheck` en los logs; revisar entonces `NUXT_INTRANET_API_URL` y la Intranet. Tras 5 fallos seguidos se detiene y reintenta dos veces cada 15 minutos.

```sql
SELECT id, state, createdon, completedon
FROM pgboss.job
WHERE name = 'users-access-recheck'
ORDER BY createdon DESC
LIMIT 7;
```

Cuentas sin acceso: una cuenta borrada en la Intranet pierde el acceso la próxima vez que inicia sesión o, si mantiene una sesión abierta, en la revisión de las 05:30; desde ese momento cada petición suya recibe 401 en todos sus dispositivos ([docs/intranet.md](docs/intranet.md), sección 1). Administración > Usuarios, con "Solo cuentas sin acceso", las lista. No hay forma de devolver el acceso a mano: lo recupera sola cuando la Intranet vuelve a tener la cuenta. Las cuentas `Admin`, `Secretaria`, `Presidencia` y `Moderador` nunca lo pierden; en su lugar queda `user.intranet_missing` en Actividad.

## Problemas Frecuentes

| Síntoma                                                   | Revisión                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| La app no arranca                                         | Logs de `app`, `APP_SECRET`, `DATABASE_URL`, credenciales OAuth                                                                                                                                                                                                                                                                             |
| OAuth falla                                               | Callback en Google, `NUXT_SITE_URL`, cabecera `X-Forwarded-Proto`                                                                                                                                                                                                                                                                           |
| No conectan migraciones                                   | Host correcto: `postgres` dentro de Compose, `localhost` desde host                                                                                                                                                                                                                                                                         |
| Export PDF falla                                          | `EXPORT_STORAGE_DIR` existe y es escribible; fuentes en `server/assets/fonts` empaquetadas                                                                                                                                                                                                                                                  |
| Jobs no avanzan                                           | Logs del worker, tabla `pgboss.job`, conexión PostgreSQL                                                                                                                                                                                                                                                                                    |
| Descarga 404 tras reinicio                                | Confirmar que `storage/exports` está montado como volumen persistente                                                                                                                                                                                                                                                                       |
| "Sincronizar" responde 503                                | `NUXT_INTRANET_API_URL` falta o se rechaza (en producción, solo `https:` o `http://intranet`); buscar `intranet.config` en los logs                                                                                                                                                                                                         |
| "Sincronizar" responde 502                                | La Intranet no responde o rechaza la llamada: token erróneo, URL mal puesta, Cloudflare desafiando la llamada (403 en HTML con `cf-ray`: excepción para `/api/asambleas/`) o, por dentro, `app` fuera de la red de la Intranet o sin `ASSEMBLIES_API_REQUIRE_HTTPS=false` en ella ([docs/intranet.md](docs/intranet.md), secciones 5.8 y 8) |
| Miembros pide confirmar la sincronización                 | Desactivaría todos los miembros de un tipo o más de max(3, 30 %): revisar el listado de la Intranet antes de confirmar                                                                                                                                                                                                                      |
| Una cuenta no puede entrar: "ya no existe en la Intranet" | La Intranet la ha borrado o la ha dejado sin tipo o, si ya estaba sin acceso, la Intranet no responde. Recupera el acceso sola cuando la Intranet vuelve a devolverla                                                                                                                                                                       |
| Nadie puede entrar y los logs muestran `auth.hook.access` | Error de base de datos al comprobar el acceso: el inicio de sesión se rechaza para no dejar entrar a una cuenta borrada. Revisar PostgreSQL                                                                                                                                                                                                 |
