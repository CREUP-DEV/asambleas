# CREUP Asambleas - Despliegue

Runbook de producción para CREUP Asambleas. El README cubre desarrollo local; este documento solo cubre operación y despliegue.

El build ocurre siempre en local: `scripts/deploy.sh` construye la imagen, la publica en GHCR y el VPS solo la descarga y la ejecuta, igual que la web.

## Arquitectura

```text
Internet
  |
  v
Cloudflare (proxy, Full strict)
  |
  v
nginx (contenedor del compose raíz, certificado *.creup.es)
  |
  v
asambleas-app (Nitro / Node 22, puerto 3000, sin publicar)
  |
  v
postgresql (PostgreSQL 18 compartido, base de datos asambleas)
```

- En el VPS, todos los proyectos viven bajo un compose raíz compartido, `/home/esternocleidomastoideo2003` (`COMPOSE_DIR`), que incluye el de cada proyecto (`include:`). La plataforma está en `asambleas/` (`REMOTE_DIR`) y usa los servicios `postgresql` y `nginx` del compose raíz.
- Todo comparte la red de Docker `esternocleidomastoideo2003_default`: nginx llega a la app como `asambleas-app:3000`, y la app puede llamar a la Intranet como `http://intranet`.
- La imagen es `ghcr.io/creup-dev/asambleas:<commit>`. El compose la lee de `ASAMBLEAS_IMAGE`, en el `.env` del compose raíz, que escriben `scripts/deploy.sh` y `scripts/rollback.sh`.
- `pg-boss` usa la misma base de datos para las exportaciones, para la sincronización diaria del listado de miembros (05:00, Europe/Madrid) y para la revisión diaria de accesos (05:30).
- Los PDFs generados (`EXPORT_STORAGE_DIR`) y los PDFs e imágenes subidos a los documentos (`UPLOAD_STORAGE_DIR`, las imágenes en `images/`) viven en `asambleas/data/`, montado en el contenedor. Sin esos montajes se pierden al recrearlo.
- La plataforma llama a la API de la Intranet por su URL pública, `https://intranet.creup.es/api/asambleas/v1`, con el token. También puede llamarla por dentro (más abajo). Cómo y por qué: [docs/intranet.md](docs/intranet.md), sección 5.8.
- Los avisos por correo salen por SMTP hacia el servidor de correo del VPS (docker-mailserver), con una dirección de `creup.org` (sección «Correo»).

## Requisitos

En tu máquina:

- Docker con Buildx (Docker Desktop).
- `bash`: Git Bash o WSL. Bajo WSL los scripts usan el `ssh.exe` de Windows, así que valen las claves de `%USERPROFILE%\.ssh`.
- `git` y acceso SSH al VPS.
- Permiso para publicar en `ghcr.io/creup-dev` (un PAT con `write:packages`).

En el VPS: el compose raíz con `postgresql` y `nginx`, y `docker login ghcr.io` hecho con un token que pueda leer los paquetes de `creup-dev` (el mismo que usan la web y la Intranet).

## Primer Despliegue

### 1. Cloudflare y Google

- DNS: `asambleas` como registro `A` (o `CNAME`) al VPS, con proxy. SSL/TLS ya está en Full (strict) para la zona.
- Rocket Loader desactivado para `asambleas.creup.es`: la CSP usa nonce y `strict-dynamic`, y Rocket Loader rompe los scripts.
- Google OAuth (cliente web): origen `https://asambleas.creup.es` y redirección `https://asambleas.creup.es/api/auth/callback/google`.

### 2. Base de datos en el PostgreSQL compartido

En el VPS, con una contraseña sin caracteres especiales (`openssl rand -hex 24`), para no tener que escaparla en `DATABASE_URL`:

```bash
cd ~
docker compose exec postgresql sh -c 'psql -U "$POSTGRES_USER" -d postgres'
```

```sql
CREATE ROLE asambleas LOGIN PASSWORD '<password>';
CREATE DATABASE asambleas OWNER asambleas;
```

La base de datos hereda la configuración regional del clúster (ICU `es-ES`). Las migraciones las aplica `scripts/deploy.sh`.

### 3. Directorio del proyecto en el VPS

```bash
mkdir -p ~/asambleas/data/exports ~/asambleas/data/uploads
```

Desde tu máquina, el compose del servicio:

```bash
scp docker-compose.production.example.yml esternocleidomastoideo2003@creup.org:asambleas/docker-compose.yml
```

`~/asambleas/.env` (con `chmod 600`):

```env
NUXT_SITE_URL=https://asambleas.creup.es
APP_SECRET=<openssl rand -base64 32>

INITIAL_ADMIN_EMAIL=tic@creup.es
GOOGLE_CLIENT_ID=<client-id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<client-secret>

NUXT_INTRANET_API_URL=https://intranet.creup.es/api/asambleas/v1
NUXT_INTRANET_API_TOKEN=<token asm_... del gestor de contraseñas>
# NUXT_INTRANET_ROSTER_SYNC=false

DATABASE_URL=postgresql://asambleas:<password>@postgresql:5432/asambleas
DATABASE_MAX_CONNECTIONS=10

# Avisos por correo (sección «Correo»)
NUXT_SMTP_HOST=<host del servidor de correo>
NUXT_SMTP_PORT=587
NUXT_SMTP_SECURE=false
NUXT_SMTP_USER=asambleas@creup.org
NUXT_SMTP_PASS=<contraseña del buzón>
NUXT_SMTP_FROM_EMAIL=asambleas@creup.org
```

Notas:

- `NODE_ENV`, `TZ`, `EXPORT_STORAGE_DIR` y `UPLOAD_STORAGE_DIR` los fija el compose; no hace falta repetirlos.
- `DATABASE_URL` usa el host `postgresql`, el servicio compartido. El clúster admite 100 conexiones para todos los proyectos. La app abre como mucho unas 18: `DATABASE_MAX_CONNECTIONS`, 3 de la cola de exportaciones, 2 de los trabajos diarios de la Intranet, 2 del resumen diario de avisos y 1 de las actualizaciones en directo. Durante un despliegue, las migraciones abren otra más.
- No pongas `SEED_DEMO`: el seed de producción cargaría los datos de demostración.
- `NUXT_SITE_URL` debe coincidir con el dominio real usado por OAuth.
- `NUXT_INTRANET_API_TOKEN` es el token en claro; la Intranet solo guarda su hash. Sin token, la plataforma no puede saber si una cuenta se ha borrado en la Intranet y no retira el acceso a nadie.
- No definas `NUXT_ROLE_API_URL`: la consulta de rol usa `${NUXT_INTRANET_API_URL}/user/role`. La ruta pública vieja (`https://intranet.creup.es/api/user/role`) ya no existe: con ese valor, cada consulta de rol fallaría (nadie pierde el acceso, pero no se actualizan roles ni miembros).
- Con `NODE_ENV=production`, las URL de la Intranet solo admiten `https:` o `http:` hacia un nombre sin punto (`http://intranet`). Cualquier otra cuenta como no configurada y deja un error `intranet.config` en los logs.
- `NUXT_INTRANET_ROSTER_SYNC=false` apaga la sincronización diaria del listado; sin ella, o con otro valor, queda activa.
- Para pasar de la configuración vieja a esta, seguir el orden de [docs/intranet.md](docs/intranet.md), sección 8.

### 4. Compose raíz

En `~/docker-compose.yml`, añadir el proyecto a `include:`:

```yaml
include:
  - postgresql/docker-compose.yml
  - umami/docker-compose.yml
  - web/docker-compose.yml
  - recuento/docker-compose.yml
  - asambleas/docker-compose.yml
```

La lista de arriba es un ejemplo: añade solo la línea de `asambleas`, sin tocar las demás. Hazlo después de crear `asambleas/.env` y `asambleas/docker-compose.yml` (paso 3), y haz antes una copia del compose raíz.

Opcional, para tener todos los límites a la vista: repetir en `~/docker-compose.override.yml` los de `asambleas-app` (640M de límite y 192M de reserva). Si no se repiten, rigen los del compose del proyecto.

Comprobar al momento que el conjunto es válido, sin arrancar nada, y volver a la copia si no lo es:

```bash
cd ~ && docker compose config --quiet && docker compose config --services
```

No ejecutes `docker compose up -d` sin nombres de servicio: arrancaría o recrearía todo el VPS.

### 5. Vhost de nginx

Desde tu máquina:

```bash
scp deploy/nginx/asambleas.creup.es.conf esternocleidomastoideo2003@creup.org:config/nginx/conf.d/
```

El vhost usa el certificado comodín `*.creup.es` (`/etc/letsencrypt/live/creup.es`), y el servidor por defecto de `creup.es.conf` ya redirige el puerto 80 a HTTPS. Resuelve `asambleas-app` en cada petición, así que nginx carga aunque la app no exista todavía; mientras tanto el sitio responde 502. Para aplicarlo:

```bash
cd ~ && docker compose exec nginx nginx -t && docker compose exec nginx nginx -s reload
```

Si `nginx -t` falla, borra el fichero en el momento: un vhost roto en `conf.d` tumba todos los sitios en el siguiente reinicio de nginx.

Lo que hace el vhost:

- No duplica CSP ni HSTS: las pone `nuxt-security`.
- Bloquea `/api/health` desde fuera.
- No guarda en búfer las actualizaciones en directo (`/api/assemblies/<asamblea>/live`, eventos SSE con latido cada 25 s, por debajo de los 100 s de Cloudflare).
- Deja pasar cuerpos de hasta 25 MB, por encima del límite de la propia app (21 MB para un PDF y 16 MB para importar un DOCX), que es la que responde con un error claro.
- No toca la IP del visitante: la recupera el `nginx.conf` compartido (`snippets/cloudflare-realip.conf`, en el bloque `http`), así que `X-Forwarded-For` ya lleva la del visitante y no la de Cloudflare. Por eso toda una sede tras un mismo NAT comparte IP, y el límite por IP de nuxt-security está apagado en `/api/assemblies/**`, `/api/exports/**` y `/api/me/**`. Lo que sigue limitado tiene un cupo por IP y regla: subidas (importar, PDF, imágenes, convocatoria) 300 cada 5 min; peticiones de exportación 1.000 cada 5 min; páginas, `/api/auth`, `/api/members` y ficheros subidos 12.000 cada 5 min entre todos.

### 6. Variables de despliegue en tu `.env` local

Junto a las de desarrollo:

```env
VPS_HOST=esternocleidomastoideo2003@creup.org
COMPOSE_DIR=/home/esternocleidomastoideo2003
REMOTE_DIR=/home/esternocleidomastoideo2003/asambleas
GHCR_USERNAME=<usuario de GitHub>
GHCR_TOKEN=<PAT con write:packages>
# Opcionales:
# NUXT_DEPLOY_SITE_URL=https://asambleas.creup.es
# NUXT_DEPLOY_UMAMI_HOST=https://umami.creup.es
# NUXT_DEPLOY_UMAMI_WEBSITE_ID=<id>
# DEPLOY_IMAGE_RETENTION=2
```

- La URL pública y Umami se incrustan en el bundle al compilar (`nuxt.config.ts`), así que salen de `NUXT_DEPLOY_*`, no del `NUXT_SITE_URL` local, que sigue en `localhost`. Sin `NUXT_DEPLOY_SITE_URL` se usa `https://asambleas.creup.es`.
- Umami solo se activa con las dos `NUXT_DEPLOY_UMAMI_*`; sin ellas la imagen sale sin analítica, sin aviso. El id es el de un sitio de `asambleas.creup.es` creado en Umami (Configuración, Sitios web). Con ellas, la CSP deja que la página envíe los datos a ese origen (`connect-src`).
- Si ya has hecho `docker login ghcr.io` en tu máquina, `GHCR_USERNAME` y `GHCR_TOKEN` sobran.

### 7. Desplegar

La primera vez, con el seed de roles y permisos (la base de datos está vacía):

```bash
bash ./scripts/deploy.sh --seed
```

Con la primera imagen publicada, el paquete `ghcr.io/creup-dev/asambleas` aparece en GitHub. La imagen lleva la etiqueta `org.opencontainers.image.source`, que lo enlaza al repositorio `CREUP-DEV/asambleas` y le da sus permisos. Si el VPS no puede descargarlo, el despliegue se para antes de las migraciones: dale acceso al token del VPS desde la configuración del paquete y repite.

## Qué Hace scripts/deploy.sh

1. Carga el `.env` local. Con cambios sin confirmar se para, salvo con `--allow-dirty` (`bash ./scripts/deploy.sh --allow-dirty`): entonces la etiqueta es `<commit>-dirty-<fecha y hora UTC>`, distinta en cada build, y no mueve `latest`, que solo nombra builds confirmados. Mejor desplegar siempre un commit.
2. Pregunta al VPS si hay una asamblea `in_session`. Si la hay, la nombra y pide confirmación (`[y/N]`; cualquier otra respuesta cancela). Sin terminal (un script, una tarea programada) no puede preguntar y se para, salvo con `DEPLOY_ALLOW_IN_SESSION=1`, que despliega igualmente: a propósito, porque una sesión es el único momento en que desplegar hace daño. Si la consulta falla (primer despliegue, sin tablas), avisa y sigue. El VPS vuelve a mirarlo antes de migrar (paso 5.5).
3. Ejecuta `pnpm verify`: la lista de verificación de `AGENTS.md` menos el build (lint, formato, tipos, i18n y tests). Si algo falla, no construye ni despliega nada. Bajo WSL la ejecuta el `pnpm` de Windows, el que instaló `node_modules`. Solo `DEPLOY_SKIP_VERIFY=1` la salta; `DEPLOY_SKIP_BUILD=1` no.
4. Construye la imagen para `linux/amd64`, etiquetada con el commit, y la publica en GHCR.
5. Por SSH, en `COMPOSE_DIR`:
   1. Crea `asambleas/data/exports` y `asambleas/data/uploads` si faltan, como el usuario de despliegue, y se para si no son del uid 1000, el de la app: no podría escribir los PDFs.
   2. Comprueba que `postgresql` está en marcha y sano. Si estuviera parado lo arranca, pero nunca lo recrea: lo comparten todos los proyectos.
   3. Si la app en marcha está sana, guarda su imagen en `.last_asambleas_image`, por digest (`repo@sha256:...`), para el rollback. Si no lo está (un despliegue anterior falló), conserva la guardada.
   4. Descarga la imagen nueva si el VPS no la tiene.
   5. Vuelve a buscar una asamblea `in_session`: verificar y construir pueden tardar lo bastante para que se abra una. Si la hay y nadie lo había permitido (la confirmación del paso 2 o `DEPLOY_ALLOW_IN_SESSION=1`), se para sin migrar nada; al repetir el despliegue pregunta.
   6. Vuelca la base de datos `asambleas` con `pg_dump -Fc` en `backups/db/asambleas-predeploy-<fecha y hora UTC>.dump` y borra los volcados `asambleas-predeploy-*` más viejos que los 10 últimos (`DEPLOY_DUMP_RETENTION`), y los `.dump.partial` que haya dejado un volcado interrumpido; no toca los demás ficheros de `backups/db`. Si el volcado falla o queda vacío, se detiene sin migrar nada.
   7. Aplica las migraciones en un contenedor efímero (`/app/ops/migrate.mjs`, con un advisory lock). Si una falla, se detiene y sigue la imagen anterior.
   8. Solo con `--seed`, ejecuta el seed de roles y permisos (`/app/ops/seed.mjs`). Vuelve a dar todos los permisos por defecto, también los que se hayan quitado a mano en Administración, y deja `rbac.seed` en el registro de auditoría. Hace falta en el primer despliegue y cuando el código añade una clave de permiso o un rol de sistema. Nunca carga datos de demo.
   9. Recrea solo `asambleas-app` y espera hasta 120 s a que esté `healthy`. Si no lo está, muestra los últimos logs, el volcado previo y cómo volver: `scripts/rollback.sh` si no se aplicó ninguna migración; si se aplicó alguna, `scripts/rollback.sh` se negaría, así que dice cuántas y que hay que restaurar antes ese volcado (sección «Restaurar») o usar `--force`.
   10. Ya sana, guarda `ASAMBLEAS_IMAGE` en el `.env` raíz, para que un `up -d` posterior no vuelva a un `latest` viejo.
   11. Comprueba y recarga nginx, y borra las imágenes viejas del proyecto. Conserva la nueva, la del rollback y hasta `DEPLOY_IMAGE_RETENTION` (2 por defecto).
6. Si el lado remoto no llega al final, el script termina con error aunque la conexión no lo diga.

Para volver a desplegar una imagen ya publicada sin compilar: `DEPLOY_SKIP_BUILD=1 DEPLOY_SKIP_VERIFY=1 IMAGE=ghcr.io/creup-dev/asambleas:<etiqueta> bash ./scripts/deploy.sh`. Sin `DEPLOY_SKIP_VERIFY=1` verifica el árbol local, aunque no sea el de esa imagen.

Recrear el contenedor corta el servicio unos segundos. Evita desplegar durante una sesión de asamblea: por eso `scripts/deploy.sh` pregunta antes, y el VPS lo vuelve a comprobar antes de migrar.

### Rollback

```bash
bash ./scripts/rollback.sh                   # vuelve a la imagen guardada por el último despliegue
bash ./scripts/rollback.sh <commit>          # o a una etiqueta concreta
bash ./scripts/rollback.sh --force [<tag>]   # aunque la base tenga migraciones que la imagen no conoce
```

Recrea la app con esa imagen, espera a que esté sana y la deja en `ASAMBLEAS_IMAGE`.

Las migraciones no se revierten: son de un solo sentido. Si una migración hay que deshacerla, se escribe otra que la deshaga.

Antes de recrear nada, compara el diario de migraciones de la imagen (`drizzle/meta/_journal.json`) con `drizzle.__drizzle_migrations`. Si la base tiene migraciones posteriores a la última que conoce la imagen, se para sin tocar nada: esa versión leería un esquema que no es el suyo (tras la `0021`, por ejemplo, la anterior leía una columna borrada y la forma vieja del quórum, y rompía los recuentos en plena sesión). Entonces hay dos salidas: restaurar antes el volcado previo al despliegue (más abajo, «Restaurar») o, si se sabe que la versión anterior convive con esas migraciones, `--force`. También se para si no puede leer alguno de los dos lados.

## Comprobaciones

```bash
curl -I https://asambleas.creup.es    # 302 a /login
```

- Entra con `tic@creup.es`: queda como `Admin`.
- Entra con una cuenta Asociado y otra CEA, y comprueba en Administración que tienen el rol y el miembro correctos.
- Pulsa "Sincronizar" en Miembros.
- Sube un PDF a un documento y exporta otro. Tras otro `bash ./scripts/deploy.sh`, los dos siguen ahí.

Tras desplegar por primera vez la versión que guarda el id de la Intranet (migración `0012`), es normal que la primera sincronización del listado dé casi todos los miembros como actualizados, y que el primer inicio de sesión de cada cuenta deje un `user.role_sync` en Actividad: los dos guardan ese id.

## Llamar a la Intranet por dentro

Como `asambleas-app` está en la red de la Intranet, puede usar `NUXT_INTRANET_API_URL=http://intranet/api/asambleas/v1`, sin pasar por Cloudflare. Por esa red la llamada es HTTP, así que la Intranet necesita `ASSEMBLIES_API_REQUIRE_HTTPS=false` en su `env_file` ([docs/intranet.md](docs/intranet.md), sección 5.8, punto 3). Cambiar el `.env` exige recrear el contenedor:

```bash
cd ~ && docker compose up -d --no-deps asambleas-app
```

`restart` conserva las variables viejas.

## Correo

Los avisos por correo (`/admin/notificaciones`, docs/design.md, «Email notifications») salen por SMTP con `nodemailer`, como los de la web. Sin `NUXT_SMTP_HOST` o sin `NUXT_SMTP_FROM_EMAIL` no se envía nada: los avisos quedan en el registro de envíos como «Sin servidor de correo», y no se acumulan para salir de golpe cuando se configure.

En producción se usa el docker-mailserver del VPS, con un buzón propio de `creup.org`:

1. Crea el buzón (el nombre del contenedor puede ser otro; `docker ps` lo dice):

   ```bash
   docker exec -it mailserver setup email add asambleas@creup.org
   ```

2. Pon en `~/asambleas/.env` las variables `NUXT_SMTP_*` de arriba: puerto 587 con STARTTLS (`NUXT_SMTP_SECURE=false`) o 465 con TLS directo (`NUXT_SMTP_SECURE=true`). Usa como host el nombre del certificado del servidor de correo (el `mail.` del dominio): si llamas al contenedor por su nombre de la red de Docker, el certificado no coincide y la conexión TLS falla.
3. Comprueba que `creup.org` tiene SPF, DKIM y DMARC que cubran ese servidor, o los avisos acabarán en spam.
4. Recrea el contenedor (`restart` conserva las variables viejas):

   ```bash
   cd ~ && docker compose up -d --no-deps asambleas-app
   ```

5. En `/admin/notificaciones`, «Enviarme una prueba» manda un correo a tu cuenta y lo anota en el registro. Si falla, el registro muestra el primer renglón del error del servidor (sin direcciones).

Una carga masiva en producción por la API (como la recreación de la 80.ª AGO) dispara los avisos como cualquier otro cambio: «Documento asignado», «Documento publicado»… a cada miembro. Antes de una carga así, apaga el interruptor general en `/admin/notificaciones` y vuelve a encenderlo después; lo que se haga con el interruptor apagado no se avisa nunca.

La versión que trae los avisos añade el permiso `notification:manage`: despliégala con `bash ./scripts/deploy.sh --seed` para que Secretaría y Presidencia lo reciban.

Operación:

```sql
-- Eventos pendientes de repartir y envíos por estado
SELECT count(*) FROM notification_outbox WHERE processed_at IS NULL;
SELECT status, reason, count(*) FROM email_deliveries GROUP BY 1, 2;
```

En los logs, `email.sent`, `email.send_failed` y `email.digest` (el resumen diario, cola `notifications-digest` a las 08:00, Europe/Madrid) identifican la cuenta por `accountRef`, nunca por la dirección.

## Backups

No hace falta nada propio: `~/ops/db-dump.sh` vuelca el clúster entero de PostgreSQL con `pg_dumpall` (incluida la base de datos `asambleas` y su rol) en `~/backups/`, y restic se lleva fuera esa carpeta y los ficheros del host, `~/asambleas/data/` incluido. Restic no entra en `/var/lib/docker`: los datos de la plataforma no pueden vivir en volúmenes de Docker.

Además, cada `scripts/deploy.sh` vuelca la base de datos `asambleas` antes de migrar (`backups/db/asambleas-predeploy-<fecha>.dump`, formato custom de `pg_dump`, los 10 últimos), y restic se los lleva con el resto de `~/backups/`.

Copia manual solo de esta base de datos:

```bash
cd ~
docker compose exec -T postgresql pg_dump -U asambleas asambleas | zstd > "backups/db/asambleas-$(date +%Y%m%d-%H%M%S).sql.zst"
```

## Restaurar

Para volver la base de datos al momento anterior a un despliegue (una migración que terminó bien pero dejó mal los datos), con el volcado que `scripts/deploy.sh` hizo antes de migrar. Se pierde todo lo escrito después en la plataforma: anota antes lo que haya pasado en la sala (votaciones, recuentos) para volver a registrarlo.

```bash
cd ~
ls -1 backups/db/asambleas-predeploy-*.dump | tail -n 3   # el último es el de este despliegue
docker compose stop asambleas-app
```

Recrear la base vacía y restaurar en ella. `pg_restore --clean` solo borra lo que está en el volcado: las tablas que crearon las migraciones nuevas se quedarían y el siguiente despliegue fallaría al crearlas otra vez.

```bash
docker compose exec -T postgresql sh -c 'psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE asambleas WITH (FORCE)" -c "CREATE DATABASE asambleas OWNER asambleas"'
docker compose exec -T postgresql pg_restore -U asambleas -d asambleas --clean --if-exists < backups/db/asambleas-predeploy-<fecha>.dump
```

`pg_restore` sigue ante un error y al final dice cuántos hubo: revisa los que imprima antes de seguir.

Después, desde tu máquina, vuelve a la imagen anterior; con la base restaurada, `scripts/rollback.sh` ya no encuentra migraciones que la imagen desconozca:

```bash
bash ./scripts/rollback.sh
```

Si lo que se perdió son ficheros (PDFs subidos, imágenes, exportaciones), se recuperan de restic, con su configuración del VPS, en un directorio aparte para copiar solo lo que falte:

```bash
restic restore latest --include /home/esternocleidomastoideo2003/asambleas/data --target /tmp/asambleas-restore
```

Los ficheros quedan en `/tmp/asambleas-restore/home/esternocleidomastoideo2003/asambleas/data/`. Cópialos a `~/asambleas/data/` conservando el uid 1000.

Un volcado del clúster entero (`~/ops/db-dump.sh`) es SQL de `pg_dumpall`: de él se restaura solo la base `asambleas` recortando su parte, así que para un despliegue es mejor el volcado previo.

## Clonar producción en local

`scripts/clone-prod-db.sh` sustituye la base de datos local y los PDF e imágenes subidos en local por los de producción, para probar con datos reales:

```bash
bash ./scripts/clone-prod-db.sh                 # base de datos y ficheros subidos
bash ./scripts/clone-prod-db.sh --skip-uploads  # solo la base de datos
bash ./scripts/clone-prod-db.sh --skip-migrate  # sin pnpm db:migrate al final
```

1. Guarda la base local (`backups/local-<fecha>.dump`) y los ficheros subidos en local (`backups/local-uploads-<fecha>.tar.gz`).
2. Por SSH, vuelca la base `asambleas` de producción con `pg_dump -Fc` dentro de su contenedor (`backups/prod-<fecha>.dump`) y empaqueta `asambleas/data/uploads` (`backups/prod-uploads-<fecha>.tar.gz`). Si alguno sale vacío, se para sin tocar nada.
3. Recrea vacía la base local (`DROP DATABASE … WITH (FORCE)`, que corta las conexiones del servidor de desarrollo) y restaura en ella el volcado, sin dueños ni permisos de producción. Nunca restaura con `--clean` sobre la vieja: las tablas de migraciones aún no desplegadas se quedarían y `pnpm db:migrate` fallaría al crearlas.
4. Sustituye los ficheros subidos en local (`UPLOAD_STORAGE_DIR`, o `private/uploads/documents`).
5. Borra todas las sesiones (son las de producción) y aplica las migraciones aún no desplegadas. Hay que volver a iniciar sesión.

Usa las mismas variables del `.env` local que `scripts/deploy.sh` (`VPS_HOST`, `COMPOSE_DIR`, `REMOTE_DIR`, `COMPOSE_POSTGRES_SERVICE`, `DEPLOY_DB_NAME`, `DEPLOY_DB_USER`) y, para el lado local, `POSTGRES_USER` y `POSTGRES_DB`. Ninguna contraseña: los volcados y la restauración corren dentro de sus contenedores. La cola de pg-boss viaja con la base, así que el servidor de desarrollo puede retomar trabajos pendientes de producción, como exportaciones.

Lo que trae son datos personales: correos, IP y navegadores del registro de actividad, y qué ha leído y abierto cada cuenta. `backups/` está en `.gitignore`. Los volcados no deben salir de tu máquina; bórralos cuando ya no los necesites.

## Operación

Logs y estado:

```bash
cd ~
docker compose logs -f asambleas-app
docker compose ps asambleas-app
```

Base de datos:

```bash
docker compose exec postgresql psql -U asambleas -d asambleas
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

Recalcular los enlaces de los documentos (`/app/ops/reslug-documents.mjs`, en local `pnpm db:reslug`): da a cada documento el enlace de su título actual con la regla de hoy, por ejemplo tras ampliar el límite de longitud. Los enlaces anteriores dejan de funcionar. Deja `documents.reslug` en Actividad por cada asamblea que cambie y, si se repite, no cambia nada. No va en `scripts/deploy.sh`: se lanza a mano una vez, primero con `--dry-run`, que solo enseña qué cambiaría.

```bash
cd ~
docker compose run -T --rm --no-deps asambleas-app /app/ops/reslug-documents.mjs --dry-run </dev/null
docker compose run -T --rm --no-deps asambleas-app /app/ops/reslug-documents.mjs </dev/null
```

Cuentas sin acceso: una cuenta borrada en la Intranet pierde el acceso la próxima vez que inicia sesión o, si mantiene una sesión abierta, en la revisión de las 05:30; desde ese momento cada petición suya recibe 401 en todos sus dispositivos ([docs/intranet.md](docs/intranet.md), sección 1). Administración > Usuarios, con "Solo cuentas sin acceso", las lista. No hay forma de devolver el acceso a mano: lo recupera sola cuando la Intranet vuelve a tener la cuenta. Las cuentas `Admin`, `Secretaria`, `Presidencia` y `Moderador` nunca lo pierden; en su lugar queda `user.intranet_missing` en Actividad.

## Problemas Frecuentes

| Síntoma                                                         | Revisión                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/deploy.sh` falla en el push                            | `docker login ghcr.io` en tu máquina, o `GHCR_USERNAME` y `GHCR_TOKEN` con `write:packages`                                                                                                                                                                                                                                          |
| `scripts/deploy.sh` falla en el pull del VPS                    | El token del `docker login` del VPS no puede leer `ghcr.io/creup-dev/asambleas`: darle acceso al paquete                                                                                                                                                                                                                             |
| `scripts/deploy.sh` falla en las migraciones                    | `DATABASE_URL` en `asambleas/.env` (host `postgresql`, rol y base `asambleas`). Un lock atascado: `SELECT pid FROM pg_locks WHERE locktype = 'advisory';` y `pg_terminate_backend(pid)`                                                                                                                                              |
| `scripts/deploy.sh` se para: "belongs to uid"                   | `sudo chown -R 1000:1000 ~/asambleas/data`: la app corre con el uid 1000 y no podría escribir los PDFs                                                                                                                                                                                                                               |
| `scripts/deploy.sh` se para: "uncommitted changes"              | Confirma los cambios o, si de verdad hay que desplegarlos así, `--allow-dirty`                                                                                                                                                                                                                                                       |
| `scripts/deploy.sh` se para en "Verify"                         | Lo que falle de `pnpm verify`: arréglalo antes de desplegar. Solo en una emergencia, `DEPLOY_SKIP_VERIFY=1`                                                                                                                                                                                                                          |
| `scripts/deploy.sh` se para: "pg_dump of asambleas failed"      | Espacio en disco (`df -h ~`) y que `backups/db` sea del usuario de despliegue. No se ha migrado nada                                                                                                                                                                                                                                 |
| `scripts/rollback.sh` se para: "migration(s) newer than"        | La imagen es anterior a migraciones ya aplicadas: restaurar el volcado previo (sección «Restaurar») o, si la versión convive con ellas, `--force`                                                                                                                                                                                    |
| "the remote deploy stopped before its last step"                | El script remoto terminó antes de tiempo (conexión cortada o un comando que se comió la entrada): revisar la salida y repetir                                                                                                                                                                                                        |
| La app no llega a `healthy`                                     | Los logs que imprime el script: `APP_SECRET`, `DATABASE_URL`, credenciales OAuth. Para volver, lo que diga el script: `scripts/rollback.sh` si no se migró nada; si se aplicó alguna migración, restaurar antes el volcado que nombra (sección «Restaurar») o `scripts/rollback.sh --force` si la versión anterior convive con ellas |
| `scripts/deploy.sh` se para: "entered session during the build" | Se abrió una sesión mientras se verificaba y construía; no se ha migrado nada. Repetir el despliegue (la imagen ya está publicada: `DEPLOY_SKIP_BUILD=1 DEPLOY_SKIP_VERIFY=1 IMAGE=...`) y confirmar, o esperar a que acabe la sesión                                                                                                |
| 502 en `asambleas.creup.es`                                     | `docker compose ps asambleas-app`; el contenedor tiene que estar en la red del compose raíz                                                                                                                                                                                                                                          |
| OAuth falla                                                     | Callback en Google, `NUXT_SITE_URL`, cabecera `X-Forwarded-Proto` en el vhost                                                                                                                                                                                                                                                        |
| Las actualizaciones en directo no llegan                        | El `location` de `/live` del vhost (`proxy_buffering off`) y que Cloudflare no lo esté desafiando                                                                                                                                                                                                                                    |
| Export PDF falla                                                | `asambleas/data/exports` existe y es del uid 1000                                                                                                                                                                                                                                                                                    |
| Jobs no avanzan                                                 | Logs del worker, tabla `pgboss.job`, conexión PostgreSQL                                                                                                                                                                                                                                                                             |
| PDFs o descargas 404 tras recrear                               | Los dos montajes de `asambleas/docker-compose.yml`: `docker inspect asambleas-app -f '{{range .Mounts}}{{.Destination}} {{end}}'`                                                                                                                                                                                                    |
| "Sincronizar" responde 503                                      | `NUXT_INTRANET_API_URL` falta o se rechaza (en producción, solo `https:` o `http://intranet`); buscar `intranet.config` en los logs                                                                                                                                                                                                  |
| "Sincronizar" responde 502                                      | La Intranet no responde o rechaza la llamada: token erróneo, URL mal puesta, Cloudflare desafiando la llamada (403 en HTML con `cf-ray`: excepción para `/api/asambleas/`) o, por dentro, sin `ASSEMBLIES_API_REQUIRE_HTTPS=false` en la Intranet ([docs/intranet.md](docs/intranet.md), secciones 5.8 y 8)                          |
| Miembros pide confirmar la sincronización                       | Desactivaría todos los miembros de un tipo o más de max(3, 30 %): revisar el listado de la Intranet antes de confirmar                                                                                                                                                                                                               |
| Una cuenta no puede entrar: "ya no existe en la Intranet"       | La Intranet la ha borrado o la ha dejado sin tipo o, si ya estaba sin acceso, la Intranet no responde. Recupera el acceso sola cuando la Intranet vuelve a devolverla                                                                                                                                                                |
| Nadie puede entrar y los logs muestran `auth.hook.access`       | Error de base de datos al comprobar el acceso: el inicio de sesión se rechaza para no dejar entrar a una cuenta borrada. Revisar PostgreSQL                                                                                                                                                                                          |
