# Integración con la Intranet de CREUP

Qué tiene que implementar la Intranet (Laravel, `CREUP/Intranet`) para que la
plataforma de asambleas no necesite datos que la Intranet ya tiene, y cómo
proteger esos endpoints. Está escrito para quien decide (producto) y para quien
lo implementa en Laravel. Los identificadores de código van en inglés.

## Resumen

- La plataforma llama hoy a tres endpoints de la Intranet: `POST /api/user/role`
  en cada inicio de sesión y `GET /api/usuarios/asociados` y
  `GET /api/usuarios/sectoriales` cuando alguien pulsa "Sincronizar" en
  Miembros y cada día a las 05:00.
- `POST /api/user/role` es **público**: cualquiera que conozca un email sabe si
  tiene cuenta en la Intranet, su tipo, su nombre, sus siglas y su universidad.
  Es el problema principal.
- Los dos listados son públicos **a propósito**: los consume la web pública
  (`creup/web`, `server/utils/public/publicMembers.ts`). No hay que cerrarlos;
  hay que dejar de depender de ellos.
- Propuesta: un grupo nuevo, `/api/asambleas/v1`, con las mismas tres rutas
  relativas (`user/role`, `usuarios/asociados`, `usuarios/sectoriales`), token
  de servicio obligatorio, límite de peticiones propio, sin CORS y con solo
  los campos que la plataforma lee. Para pasar a él, la plataforma solo cambia
  variables de entorno.
- El grupo es accesible desde Internet y lo protege el token: la plataforma lo
  llama por `https://intranet.creup.es/api/asambleas/v1`, también desde el
  servidor de desarrollo de quien la programa, o por la red de Docker del VPS
  si comparte red con la Intranet. Sin lista de IP ni bloqueo en nginx: los
  listados ya son públicos en la web, y la consulta de rol solo responde a
  quien presenta el token (sección 5.8).
- Requisito previo: la cadena es Cloudflare → contenedor nginx (`proxy_pass`)
  → Apache en el contenedor `intranet`. nginx ya recupera la IP real de
  Cloudflare; falta que `TrustProxies` confíe solo en nginx
  (`TRUSTED_PROXIES`, la red de Docker que comparten). La fase 1 ya no confía
  en `'*'`: sin esa variable, todos los visitantes comparten la dirección de
  nginx y sus límites por IP (R6, sección 5.8).
- Estado: la fase 1 está implementada en la Intranet (commit `28d4579` de
  `master`, con las correcciones de la revisión). Ni él ni los dos commits que
  tiene debajo están publicados: hay que decidir qué commits salen con ella
  (sección 8).
- Despliegue (sección 8): Intranet con el grupo nuevo y `TRUSTED_PROXIES`
  (desplegado el 2026-11-06); la ruta vieja se elimina sin transición, porque
  la plataforma aún no está en producción; después, variables de la
  plataforma. Las variables de la Intranet se aplican recreando su
  contenedor, nunca con `config:cache` (sección 5.1).
- La plataforma ya usa lo que añade el grupo nuevo (sección 9): envía
  `Accept`, enlaza por `id`, retira el acceso a las cuentas borradas en la
  Intranet (un 404 autenticado) y sincroniza el listado cada día.
- Fase 2 opcional: áreas ejecutivas, derechos de cada miembro y aviso de
  cambios, para que la plataforma deje de pedir a mano lo que la Intranet ya
  sabe.

## 1. Qué usa hoy la plataforma

### Variables de entorno

| Variable                    | Uso                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NUXT_INTRANET_API_URL`     | Base de la API. La plataforma le añade `user/role`, `usuarios/asociados` y `usuarios/sectoriales`; sin ella no hay sincronización del listado. En producción (`NODE_ENV=production`) solo acepta `https:`, o `http:` hacia un nombre sin punto (un servicio de Docker como `http://intranet`); otro valor, o uno inválido, cuenta como ausente y se registra una vez (`intranet.config`). Para la Intranet: `https://intranet.creup.es/api/asambleas/v1` desde cualquier sitio (también el servidor de desarrollo), o `http://intranet/api/asambleas/v1` desde la red de Docker del VPS (sección 5.8). |
| `NUXT_INTRANET_API_TOKEN`   | Si tiene valor, cada llamada lleva `Authorization: Bearer <token>`. Un valor en blanco cuenta como ausente. Nunca se registra en logs (`intranetAuthHeaders`). Sin token, la plataforma nunca retira el acceso a nadie.                                                                                                                                                                                                                                                                                                                                                                                |
| `NUXT_ROLE_API_URL`         | Opcional, y lo normal es no definirla. URL completa de la consulta de rol; sin ella, `{NUXT_INTRANET_API_URL}/user/role`. **Si está definida tiene prioridad sobre la base**, aunque esta apunte a otro sitio (`getRoleApiUrl`). Sigue la misma regla de `http:`; si la rechaza, se usa la base. Si está en otro origen que `NUXT_INTRANET_API_URL`, se llama **sin token** (`isRoleLookupAuthenticated`, error `intranet.config` una vez): nunca retira el acceso a nadie, pero el token no sale hacia otro sitio.                                                                                    |
| `NUXT_INTRANET_ROSTER_SYNC` | Sincronización diaria del listado (05:00, Europe/Madrid). Opcional: solo la palabra `false` la apaga. Necesita `NUXT_INTRANET_API_URL`. No afecta a la revisión diaria de accesos (05:30), que corre siempre que la consulta de rol lleve token.                                                                                                                                                                                                                                                                                                                                                       |

El `.env` de producción de `DEPLOYMENT.md` usa ya el grupo nuevo
(`NUXT_INTRANET_API_URL`, `NUXT_INTRANET_API_TOKEN`, sin `NUXT_ROLE_API_URL`).
Un `.env` que siga la plantilla anterior
(`NUXT_ROLE_API_URL=https://intranet.creup.es/api/user/role`, sin base ni
token) consulta la ruta pública vieja: el rol se sincroniza, pero nadie pierde
el acceso y "Sincronizar" en Miembros responde 503 "no está configurada". Al
migrar hay que quitar `NUXT_ROLE_API_URL` (sección 8, paso 2).

### Consulta de rol (`server/utils/auth/roleSync.ts`)

- **Cuándo:** una vez en cada inicio de sesión con Google, antes de crear la
  sesión. El hook `databaseHooks.session.create.before` de
  `server/utils/auth/auth.ts` (`checkSignInAccess`) decide si la cuenta puede
  entrar, y la sincronización del rol, en `session.create.after`, reutiliza la
  misma respuesta. Un fallo de la Intranet nunca bloquea a quien tiene acceso;
  un error de base de datos al comprobarlo sí (`sign_in_unavailable`), para no
  dejar entrar a una cuenta borrada.
- **Petición:** `lookupIntranetRole` (`server/utils/members/intranet.ts`):
  `POST`, cuerpo `{"email": "<email de Google>"}`, cabeceras
  `Accept: application/json`, `Content-Type: application/json` y el token si
  existe. Tiempo máximo: 10 s.
- **Respuesta 200 que acepta (Zod):** un objeto JSON con
  - `id`: entero de 1 a 2^31-1 (el `users.id` de la Intranet), `null` o
    ausente (la ruta vieja no lo envía). Otro valor invalida la respuesta
    entera;
  - `role`: string no vacío tras `trim` (el `users.type` de la Intranet). Se
    compara literalmente, distinguiendo mayúsculas: solo `Asociado`, `CEA` y
    `Sectorial` tienen efecto; `asociado` o `ASOCIADO` contarían como
    cualquier otro tipo;
  - `name`, `initials`, `university`: string, `null` o ausente (un string
    vacío cuenta como `null`). Un número u otro tipo invalida la respuesta
    entera.

  Ignora cualquier otra clave, así que añadir campos es compatible.

- **Resultados.** Cada inicio de sesión guarda el suyo en `auth.sign_in`
  (`roleSync`):
  - `ok`: un 200 válido;
  - `not_found`: solo si la petición llevaba token y la respuesta es un 404,
    sin redirección, cuyo cuerpo es exactamente `{"error":"not_found"}`;
  - `failed`: todo lo demás: red, tiempo agotado, 5xx, JSON inválido, un 404
    sin token, el de la ruta vieja (`{"error":"Usuario no encontrado"}`), el
    de una ruta de Laravel que no existe (`{"message":"Not Found."}`), uno en
    HTML o un `not_found` con más claves;
  - `unconfigured`: no hay URL usable.
- **Con `ok`:** guarda `externalRole`, `externalName`, `externalInitials`,
  `university`, `intranetId` (solo si llega `id`: la ruta vieja nunca borra
  uno guardado) y `lastRoleSyncAt`, y decide el rol:
  - `Asociado` da el rol `Asociado`; `CEA` da `CEA`; cualquier otro tipo
    (`Sectorial`, `Invitado`, `Desasociado`, `CdG`, `CAI`, `Otros`) da
    `Invitado`.
  - Enlaza la cuenta con su miembro (`server/utils/members/link.ts`):
    `Asociado` con su consejo y `Sectorial` con su sectorial, primero por `id`
    (`users.intranet_id` igual a `members.intranet_id`) y si no por
    `initials`; `CEA` con un área ejecutiva solo por `initials` (el `id` de
    una cuenta CEA es una persona, no un área), que crea con las siglas como
    nombre si no existe. Un miembro encontrado por siglas cuyo `intranet_id`
    es de otra cuenta no se enlaza (aviso en el log).
  - `Admin`, `Secretaria`, `Presidencia` y `Moderador` nunca cambian por la
    sincronización.
- **Con `failed` o `unconfigured`:** `lookupIntranetRole` registra el aviso
  (`intranet.role`); una cuenta nueva queda como `Invitado` y sin miembro, y
  en una existente **no cambia nada**, ni siquiera `lastRoleSyncAt`, que así
  indica la última consulta con éxito. `fetch` sigue las redirecciones: un
  302 a una página HTML acaba en "JSON inválido". Por eso un 200 con un rol
  inventado sería peligroso (degradaría a un Asociado o CEA y le quitaría su
  miembro), y un 404 que no sea exactamente el del grupo nuevo no cambia
  nada.
- **Con `not_found` (cuenta borrada en la Intranet):**
  - si la Intranet no la conoció nunca (`externalRole` e `intranet_id`
    vacíos: alguien que entra con un Google sin cuenta en la Intranet), sigue
    como siempre, como `Invitado`;
  - si tiene un rol protegido (`Admin`, `Secretaria`, `Presidencia`,
    `Moderador`), lo conserva todo: solo se registran `user.intranet_missing`
    y un aviso en el log;
  - si no, **pierde el acceso**, en una transacción: `access_revoked_at` y
    `access_revoked_reason = intranet_deleted`, rol `Invitado`, sin miembro,
    todas sus sesiones borradas, las suplantaciones abiertas sobre ella
    cerradas (`revoked`) y `user.access_revoked` (origen `intranet`, sin
    actor). Conserva sus permisos individuales (`user_permissions`). El
    inicio de sesión se rechaza y vuelve a la página de entrada en el idioma
    de quien entra (`/login` o `/en/login`, con `?error=access_revoked` y el
    mismo `redirect`: el cliente lo pide como `errorCallbackURL`), que
    explica que la cuenta ya no existe en la Intranet.
- **Una cuenta sin acceso que vuelve a entrar** se consulta otra vez. Si la
  consulta con token la devuelve (200), recupera el acceso
  (`user.access_restored`) y sigue la sincronización normal, que le devuelve
  su rol y su miembro. Con cualquier otra respuesta, también si la Intranet
  no contesta, se rechaza. No hay forma de devolver el acceso a mano: manda
  la Intranet. Un Admin no puede suplantarla, su rol no se puede cambiar
  (409 `admin.users.errors.targetRevoked`) y un Admin sin acceso no cuenta
  como el último Admin. Administración > Usuarios la marca "Sin acceso"
  (`/admin/usuarios?access=revoked`).
- **Sesiones abiertas:** una sesión dura 7 días y se renueva cada día que
  se usa, así que el inicio de sesión no basta. Cada día a las 05:30
  (Europe/Madrid) una tarea de pg-boss (cola `users-access-recheck`,
  `server/utils/auth/accessRecheck.ts`) vuelve a consultar, una cada medio
  segundo (como mucho 120 por minuto, por debajo de los 300 del limitador),
  cada cuenta con sesión sin caducar, con acceso, con datos de la Intranet y
  sin rol protegido. Las que la Intranet ya no tiene (`not_found` con token)
  pierden el acceso como arriba; cualquier otra respuesta no cambia nada, y
  la revisión no toca el rol ni `lastRoleSyncAt`. Corre siempre que la
  consulta de rol lleve token, aunque `NUXT_INTRANET_ROSTER_SYNC` sea
  `false`. Salvaguardas:
  - si la Intranet dice no tener más de max(3, 30 %) de las cuentas por las
    que respondió, no retira el acceso a nadie: registra
    `users.access_recheck_blocked` (solo recuentos, visible para Admin) y un
    error en el log (`access.recheck`). Una Intranet apuntando a una base de
    datos vacía no echa a todo el mundo;
  - tras 5 fallos seguidos (Intranet caída) se detiene sin cambiar nada y
    pg-boss la reintenta dos veces cada 15 minutos.
- **En cada petición** se lee `access_revoked_at`: una cuenta sin acceso
  recibe 401 al momento en todos sus dispositivos, aunque better-auth aún
  sirva su sesión desde la caché de la cookie (5 minutos), y la página la
  lleva a `/login`.
- **Límites:** una cuenta borrada conserva el acceso, como mucho, hasta la
  revisión de las 05:30 siguiente. Y todo esto solo funciona con el grupo
  nuevo y su token (sección 4.3).
- **Logs:** nunca el email. Llevan `accountRef`, los 12 primeros caracteres
  hexadecimales de un HMAC-SHA256 del email en minúsculas con `APP_SECRET`
  (o `BETTER_AUTH_SECRET`, si está definida), para relacionar los avisos de
  una misma cuenta.

### Sincronización del listado (`server/utils/members/sync.ts`, `roster.ts`)

- **Cuándo:** a mano, con `POST /api/members/sync` (permiso `member:manage`,
  botón en Miembros), y cada día a las 05:00 (Europe/Madrid) con una tarea
  programada de pg-boss (cola `members-roster-sync`,
  `server/utils/members/schedule.ts`). La tarea solo corre si
  `NUXT_INTRANET_API_URL` es usable y `NUXT_INTRANET_ROSTER_SYNC` no vale
  `false`; si falla, reintenta dos veces cada 15 minutos, y si el servidor
  estaba parado a las 05:00, la hace una vez al arrancar. Sus filas de
  auditoría no tienen actor; las de la sincronización a mano llevan la cuenta
  que la lanzó. Dos sincronizaciones nunca se solapan (candado de
  PostgreSQL).
- **Petición:** `GET {base}/usuarios/asociados` y
  `GET {base}/usuarios/sectoriales` en paralelo, con
  `Accept: application/json` y el token si existe. 10 s cada una.
- **Respuesta que acepta:** `{ "data": Entry[], "generated_at"?: string | null }`
  con como mucho 5000 filas. Cada `Entry` es un objeto que puede traer `id`
  (entero de 1 a 2^31-1, `null` o ausente), `denomination`, `initials`,
  `university` y `autonomous_community` (string, número, `null` o ausente) y
  `order` (**solo número**, `null` o ausente). Un `id` u `order` de otro tipo
  invalida la lista entera. Ignora el resto de claves.
- **Qué hace:**
  - sin `NUXT_INTRANET_API_URL` responde 503 sin llamar a nada;
  - las dos listas se piden antes de escribir nada y, si cualquiera falla, no
    se toca la base de datos (502);
  - colapsa espacios y recorta las siglas a 20 caracteres; el nombre es
    `denomination` (o las siglas si falta), recortado a 200, igual que
    `university` y `autonomous_community`;
  - descarta filas sin `initials`; si unas siglas (sin distinguir mayúsculas)
    o un `id` se repiten, gana la primera (asociados antes que sectoriales);
  - empareja cada fila con el miembro guardado con su `id`
    (`members.intranet_id`) y, si no, con el de sus siglas: un cambio de
    siglas actualiza el miembro en lugar de crear otro. Emparejar por siglas
    guarda el `id`, y una fila sin `id` nunca borra el guardado. Si las siglas
    las tiene un miembro cuyo `id` ya no está en la lista, se reutiliza y se
    sustituye su `id` (aviso en el log);
  - nunca deja dos miembros con las mismas siglas: si un miembro pasa a unas
    siglas que otro conserva, se queda con las suyas y se avisa
    (`acronymConflicts` en `members.sync`);
  - nunca toca miembros creados a mano (las áreas ejecutivas que crea la
    consulta de rol son manuales);
  - reactiva los miembros de origen Intranet que vuelven a aparecer y
    **desactiva todo miembro de origen Intranet que no aparezca en la lista**;
  - **salvaguarda:** si eso desactivaría todos los miembros activos de un tipo
    (asociados o sectoriales), o más de max(3, 30 %) de ellos, no aplica
    nada: registra `members.sync_blocked` y responde 409 `large_deactivation`
    con los recuentos de cada tipo. Miembros los enseña y pide confirmación,
    que se envía con esos recuentos (`confirmDeactivation: true` y
    `confirmedKinds`). Si al repetirla la Intranet devuelve aún menos (por
    ejemplo, `data: []` después de una lista parcial), la confirmación no
    vale: vuelve a responder 409 con los recuentos nuevos. La tarea diaria
    nunca confirma: deja esa fila y un aviso en el log, y hay que sincronizar
    a mano;
  - deja constancia en `audit_log`: una fila por miembro que cambia y el
    resumen `members.sync`.

La salvaguarda frena el peor caso de una respuesta parcial (la primera página
de una lista paginada, o un `200` con `data: []` tras un error interno), pero
no unos pocos miembros que falten: la Intranet nunca debe devolver una lista
incompleta (sección 4.3).

## 2. Estado actual en la Intranet

| Ruta                            | Controlador                                 | Autenticación | Límite                                      | CORS | Devuelve                                                                                                                                                                                   | Quién la usa                    |
| ------------------------------- | ------------------------------------------- | ------------- | ------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `POST /api/user/role`           | `AdminController@getUserRoleByEmail`        | Ninguna       | `throttle:api`: 60/min por IP (no hay user) | `*`  | `{ role: users.type, name, initials, university }`, o 404 `{"error":"Usuario no encontrado"}`. Valida en línea con `$request->validate(['email' => 'required\|email'])`.                   | Solo la plataforma de asambleas |
| `GET /api/usuarios/asociados`   | `Api\OrganizationApiController@asociados`   | Ninguna       | El mismo                                    | `*`  | `order`, `denomination` (`users.designation`), `initials`, `university`, `autonomous_community`, `description`, `web_logo_light`, `web_logo_dark`, `social_networks` (con `contact_email`) | Web pública y plataforma        |
| `GET /api/usuarios/sectoriales` | `Api\OrganizationApiController@sectoriales` | Ninguna       | El mismo                                    | `*`  | Igual que asociados, sin `university` ni `autonomous_community`                                                                                                                            | Web pública y plataforma        |
| `GET /api/user`                 | Closure con `auth:sanctum`                  | Sanctum       | El mismo                                    | `*`  | El modelo `User` entero (salvo `password` y `remember_token`)                                                                                                                              | Nadie: no se emite ningún token |

Esta sección describe lo que hay hoy en producción. La fase 1 (secciones de la
4 a la 6) está implementada en el commit `28d4579` de `master` de la Intranet,
aún sin publicar ni desplegar (sección 8).

Otros datos relevantes:

- `routes/api.php` se carga desde `RouteServiceProvider` con el grupo `api`
  (`throttle:api` y `SubstituteBindings`). El limitador `api` es
  `Limit::perMinute(60)->by($request->user()?->id ?: $request->ip())`.
- La app usa la estructura clásica: middleware en `app/Http/Kernel.php`
  (alias en `$routeMiddleware`), limitadores en
  `RouteServiceProvider::configureRateLimiting()`. `bootstrap/app.php` es el
  clásico, sin `withMiddleware`. El middleware global incluye `TrustProxies`,
  `HandleCors`, `TrimStrings` y `ConvertEmptyStringsToNull`.
- `config/cors.php`: `paths => ['api/*', 'sanctum/csrf-cookie']`,
  `allowed_origins => ['*']`.
- `TrustProxies::$proxies = '*'`: Laravel confía en quien abre la conexión
  (`REMOTE_ADDR`), sea quien sea, y acepta de él `X-Forwarded-For`,
  `-Host`, `-Port` y `-Proto` (`HEADER_X_FORWARDED_AWS_ELB`, que también
  figura, no añade otras). `28d4579` lo cambia por las direcciones de
  `TRUSTED_PROXIES` (la red de Docker de nginx o su dirección fija) y solo
  `X-Forwarded-For` y `X-Forwarded-Proto`. Ver R6.
- Topología de producción:
  - `intranet.creup.es` está detrás de Cloudflare: resuelve a direcciones de
    Cloudflare (A `104.21.24.128` y `172.67.218.236`, AAAA en
    `2606:4700::/32`) y responde con `Server: cloudflare` y `CF-RAY`.
  - En el VPS (revisado el 2026-11-06), el contenedor `nginx` publica 80 y
    443, termina TLS con el certificado de Let's Encrypt de `creup.es`,
    redirige el 80 a HTTPS y recupera la IP real de Cloudflare para todos los
    sitios (`snippets/cloudflare-realip.conf`). Pasa las peticiones de la
    Intranet por `proxy_pass` al servicio `intranet`.
  - La imagen de la Intranet es `php:8.4-apache`: Apache escucha solo en el
    80, sin TLS, y el contenedor no publica ningún puerto. Tiene
    `mod_remoteip` activo pero sin `RemoteIPHeader`, así que `REMOTE_ADDR`
    es quien abre la conexión: nginx, en la red de Docker.
  - Todos los contenedores están en una sola red de Docker,
    `esternocleidomastoideo2003_default` (`172.18.0.0/16`); nginx no tiene
    dirección fija.
  - Las variables llegan por el `env_file` del servicio `intranet`
    (`config/intranet/.env` del directorio de compose); la imagen no lleva
    `.env`.
  - La web pública (`web-app`) llama a la Intranet por esa red
    (`NUXT_EXTERNAL_API_BASE_URL=http://intranet`), sin pasar por Cloudflare.
    La plataforma de asambleas aún no está desplegada en el VPS.
  - El vhost de nginx de producción
    (`config/nginx/conf.d/intranet.creup.es.conf`) no está en ningún
    repositorio. `docker/nginx/default.conf` de la Intranet (FastCGI a
    `intranet:9000`) es un resto de desarrollo, y la copia de `CREUP/VPS`
    (noviembre de 2025, PHP-FPM por FastCGI, `9001:9000` publicado) está
    desactualizada.
- Sanctum está instalado y existe la tabla `personal_access_tokens`, pero
  ningún código llama a `createToken`.
- No hay configuración de tokens para esta integración ni carpetas
  `app/Http/Requests` o `app/Http/Resources`.
- No hay tests de estos tres endpoints (solo de `/api/organigrama`). Los tests
  son PHPUnit 13 (sin Pest), con `RefreshDatabase`, `#[DataProvider]` y
  `Tests\TestCase`.
- `.env.example` trae `APP_DEBUG=true` y `LOG_LEVEL=debug`.
- En la Intranet, `users.type` toma `Asociado`, `Desasociado`, `Invitado`,
  `Sectorial`, `CEA`, `CdG`, `CAI` y `Otros` (columna nullable). Las siglas de
  las cuentas individuales (CEA y `Otros`; no `CAI` ni `CdG`) se recalculan del
  nombre de Google en cada acceso a la Intranet
  (`GoogleController::buildInitialsFromName`); las de asociados y sectoriales
  (cuentas multiusuario) las cura Administración, pero su `university` se
  sobrescribe con los apellidos de Google cuando Google los trae.
- `users` es `latin1_spanish_ci`: la búsqueda por email ya no distingue
  mayúsculas.

## 3. Riesgos actuales

| #   | Riesgo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Impacto                                                                                                                     | Gravedad                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| R1  | `POST /api/user/role` responde a cualquiera: confirma si un email tiene cuenta y devuelve tipo, nombre, siglas y universidad. Cualquier persona que haya entrado alguna vez con su Google personal está en `users` (como `Invitado`) con su nombre real.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Revelación de datos personales (RGPD) y de quién pertenece a qué órgano.                                                    | Alta                                                        |
| R2  | Enumeración: 60 consultas/min por IP sin más control; con varias IP no hay techo. Con CORS `*` cualquier web puede hacer que los navegadores de sus visitantes consulten la ruta y lean la respuesta, repartiendo el límite entre miles de IP.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Barrido masivo de emails.                                                                                                   | Alta                                                        |
| R3  | El límite `throttle:api` (60/min por IP) es compartido: toda la plataforma sale por una sola IP. Al abrirse una sesión entran muchas personas a la vez; pasadas 60 en un minuto, la Intranet responde 429.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Cuentas nuevas quedan como `Invitado`, las existentes con datos viejos; una sincronización del listado en ese minuto falla. | Media                                                       |
| R4  | La consulta de rol de la plataforma no enviaba `Accept: application/json` (ya lo envía, sección 9). Un error de validación en Laravel responde con una redirección 302 a HTML; `fetch` la sigue y la plataforma ve "respuesta inválida".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Fallos enmascarados y difíciles de diagnosticar.                                                                            | Baja                                                        |
| R5  | La plataforma depende de listados con forma de web pública (logos, redes, `contact_email`, orden de la web). Si la web pide paginar o renombrar campos, la plataforma se rompe; si se pagina, **desactiva en silencio** a los miembros de las páginas siguientes (la salvaguarda de la sección 1 ya frena las desactivaciones grandes).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Acoplamiento con otro producto y datos de más.                                                                              | Media                                                       |
| R6  | Las cabeceras de proxy no son fiables. En producción la cadena es Cloudflare → nginx → Apache por `proxy_pass`, así que Laravel siempre ve a nginx como quien abre la conexión, y `TrustProxies::$proxies = '*'` le cree todo `X-Forwarded-*`. Si nginx no recupera la IP real de Cloudflare, `ip()` es la IP del borde de Cloudflare para todo el mundo y el límite por IP se reparte entre todos los que salen por el mismo borde. Si nginx añade a lo que manda el cliente (`$proxy_add_x_forwarded_for`) o no fija las cabeceras, cualquiera elige su IP, su esquema y su host. Si el origen acepta conexiones que no vienen de Cloudflare (80/443 abiertos a todos, IPv6 incluida) o el contenedor `intranet` publica su puerto, se puede hablar con nginx o con Apache directamente. Revisado en el VPS: nginx ya recupera la IP real de Cloudflare, así que hoy Laravel ve a cada visitante. `28d4579` confía solo en `TRUSTED_PROXIES` (sección 5.8), y la API además pide el token. | Límites por IP de la Intranet compartidos o esquivables (`throttle:api`, formularios públicos, enlaces de la gestoría).     | Baja (nginx ya recupera la IP real; revisado el 2026-11-06) |
| R7  | `GET /api/user` devuelve el modelo `User` entero a quien tenga un token Sanctum. Hoy no se emite ninguno, pero si algún día se emite, expone `google_id`, email y todas las columnas visibles.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Exposición futura.                                                                                                          | Baja                                                        |

## 4. Diseño propuesto

### 4.1 Un grupo con token: `/api/asambleas/v1`

Tres rutas nuevas, con las mismas rutas relativas que la plataforma ya usa:

| Método | Ruta                                     | Sustituye a (para la plataforma) |
| ------ | ---------------------------------------- | -------------------------------- |
| `POST` | `/api/asambleas/v1/user/role`            | `POST /api/user/role`            |
| `GET`  | `/api/asambleas/v1/usuarios/asociados`   | `GET /api/usuarios/asociados`    |
| `GET`  | `/api/asambleas/v1/usuarios/sectoriales` | `GET /api/usuarios/sectoriales`  |

Con `NUXT_INTRANET_API_URL=https://intranet.creup.es/api/asambleas/v1` (o
`http://intranet/api/asambleas/v1` desde la red de Docker del VPS) la
plataforma llama a las rutas nuevas sin cambiar código (sección 5.8). Los
listados públicos de la web se quedan como están. La ruta pública
`POST /api/user/role` se elimina (solo la usaba esta plataforma, que aún no
está en producción; sección 8).

Todo el grupo:

- es accesible desde Internet y desde la red de Docker del VPS;
- exige el token de servicio (sección 4.2);
- no hereda `throttle:api` y tiene su propio limitador;
- responde siempre JSON y nunca redirige;
- queda fuera de CORS;
- envía `Cache-Control: no-store` en toda respuesta que pasa por su
  middleware, que son todas las que llevan datos (los 405 y los 429 del
  limitador se generan antes y no llevan datos);
- devuelve solo los campos de este contrato.

### 4.2 Autenticación de servicio

**Recomendado: token aleatorio con su hash SHA-256 en la configuración.**

- La plataforma guarda el token en claro en `NUXT_INTRANET_API_TOKEN` (tiene
  que enviarlo). La Intranet guarda solo su SHA-256 en hexadecimal: si se
  filtran sus variables de entorno (el `env_file`) o su caché de
  configuración, el hash no sirve para llamar a la API.
- 32 bytes aleatorios en base64url con el prefijo `asm_` (47 caracteres;
  sección 7, paso 1). Con esa entropía SHA-256 basta; no hace falta bcrypt ni
  Argon2. El prefijo hace que un token no se pueda confundir con un hash: si
  alguien lo pega por error en la ranura del hash, la configuración lo
  descarta (sección 5.1) y el grupo responde 503 en vez de guardar el token en
  claro en la Intranet.
- Un solo hash, `ASSEMBLIES_API_TOKEN_SHA256`: rotar el token supone un corte
  breve en la consulta de rol y el listado, que la plataforma aguanta sin
  bloquear a nadie (sección 7).
- Comparación en tiempo constante con `hash_equals`.
- Solo en la cabecera `Authorization: Bearer`. Nunca en la query string (acaba
  en logs de acceso) ni en el cuerpo. Por Internet viaja siempre por HTTPS; por
  HTTP, solo dentro de la red de Docker del VPS.
- Si no hay ningún hash configurado, el grupo responde 503 (falla cerrado).

**Alternativa aceptable: Sanctum** con un token de capacidad `assemblies:read`,
`auth:sanctum` y el middleware `abilities:assemblies:read` (hay que registrar
el alias `abilities` => `Laravel\Sanctum\Http\Middleware\CheckAbilities` en
`Kernel::$routeMiddleware`; hoy no está). Sanctum también guarda solo el
SHA-256 y compara con `hash_equals`, pero necesita un usuario "de servicio" al
que colgar el token (aparecería en listados y consultas por `type`) y escribe
`last_used_at` en cada petición. Rotar sin cortes también se puede (crear un
segundo token, cambiarlo en la plataforma, borrar el primero), pero desde
`tinker`, sin interfaz. Para un único cliente máquina a máquina, el hash en
configuración es más simple.

### 4.3 Contrato, endpoint por endpoint

#### Códigos comunes a todo el grupo

| Código | Cuándo                                                                                                                                  | Cuerpo                                                                 | Cabeceras                  |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------- |
| 200    | Éxito                                                                                                                                   | El de cada endpoint                                                    | `Cache-Control: no-store`  |
| 401    | Falta el token o no es válido (mismo cuerpo en ambos casos, sea cual sea el email)                                                      | `{"error": "unauthorized"}`                                            | `WWW-Authenticate: Bearer` |
| 403    | Petición no HTTPS con HTTPS exigido (por defecto), o IP fuera de la lista permitida si se configura una                                 | `{"error": "forbidden"}`                                               |                            |
| 404    | Solo en `user/role`, y solo con token válido: email sin cuenta o cuenta sin tipo                                                        | `{"error": "not_found"}`                                               | `Cache-Control: no-store`  |
| 405    | Método equivocado (lo da el framework)                                                                                                  | JSON del framework                                                     |                            |
| 422    | Cuerpo inválido                                                                                                                         | `{"message": "...", "errors": {"email": ["..."]}}`                     |                            |
| 429    | Límite superado, o token erróneo tras 10 tokens erróneos en un minuto desde la misma IP (un token válido nunca recibe este segundo 429) | `{"message": "Too Many Attempts."}` o `{"error": "too_many_requests"}` | `Retry-After`              |
| 500    | Error interno. **Nunca un 200 con datos parciales.** Sin traza (`APP_DEBUG=false`).                                                     | JSON genérico                                                          |                            |
| 503    | El grupo no tiene ningún hash de token configurado                                                                                      | `{"error": "service_unavailable"}`                                     |                            |

Toda respuesta que pasa por el middleware lleva `Cache-Control: no-store`
(sección 5.2); los 405 y los 429 del limitador se generan antes y no llevan
datos.

La plataforma trata cualquier código distinto de 2xx como "Intranet no
disponible": no cambia nada de las cuentas existentes y no escribe el
listado. La única excepción es el 404 `{"error": "not_found"}` de `user/role`
con token: para una cuenta que la Intranet ya conocía significa que se ha
borrado, y le retira el acceso a la plataforma (sección 1). Ese cuerpo tiene
que ser exactamente ese: con cualquier otra clave, la plataforma lo toma como
un fallo y no retira el acceso a nadie.

#### `POST /api/asambleas/v1/user/role`

Quién es una cuenta. Se llama en cada inicio de sesión. Es `POST` para que el
email no aparezca en URLs ni en logs de acceso.

Petición:

```http
POST /api/asambleas/v1/user/role HTTP/1.1
Host: intranet.creup.es
Authorization: Bearer <token>
Content-Type: application/json

{"email": "cdeub@ub.edu"}
```

- `email`: obligatorio, string, email RFC, como mucho 254 caracteres. Se
  normaliza con `trim` y minúsculas antes de validar y buscar.
- Cualquier otra clave se ignora.

Respuesta 200:

```json
{
  "id": 412,
  "role": "Asociado",
  "name": "Consell de l'Estudiantat Universitat de Barcelona UB",
  "initials": "CdEUB",
  "university": "Universitat de Barcelona"
}
```

| Campo        | Tipo            | Origen             | Notas                                                                                                                                                                       |
| ------------ | --------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | integer         | `users.id`         | Nuevo. La plataforma lo guarda en `users.intranet_id` y enlaza por él las cuentas Asociado y Sectorial con su miembro, aunque cambien las siglas. De 1 a 2^31-1.            |
| `role`       | string no vacío | `users.type`       | Valores actuales: `Asociado`, `Desasociado`, `Invitado`, `Sectorial`, `CEA`, `CdG`, `CAI`, `Otros`. Tal cual, con estas mayúsculas: la plataforma los compara literalmente. |
| `name`       | string \| null  | `users.name`       | Lo que ya devuelve hoy.                                                                                                                                                     |
| `initials`   | string \| null  | `users.initials`   | Como mucho 20 caracteres útiles: la plataforma recorta a 20 y empareja por ellas.                                                                                           |
| `university` | string \| null  | `users.university` |                                                                                                                                                                             |

No se devuelve nada más: ni email, ni `google_id`, ni teléfono, ni datos
personales de `personal_data`.

Errores: 404 `{"error": "not_found"}` si no hay cuenta con ese email **o** si
la cuenta tiene `type` nulo o vacío (mismo cuerpo, misma cabecera). 422 si el
email no es válido. El resto, según la tabla común.

Para la plataforma, ese 404 retira el acceso a una cuenta que ya conocía
(sección 1): vaciar el `type` de una cuenta en la Intranet tiene el mismo
efecto que borrarla. Las cuentas con un rol protegido en la plataforma
(`Admin`, `Secretaria`, `Presidencia`, `Moderador`) lo conservan.

#### `GET /api/asambleas/v1/usuarios/asociados`

Consejos con `users.type = 'Asociado'`.

Respuesta 200:

```json
{
  "data": [
    {
      "id": 412,
      "denomination": "CdEUB",
      "initials": "CdEUB",
      "university": "Universitat de Barcelona",
      "autonomous_community": "Cataluña"
    }
  ],
  "generated_at": "2026-11-05T10:15:00+01:00"
}
```

| Campo                  | Tipo           | Origen                                                                                         |
| ---------------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| `id`                   | integer        | `users.id` (nuevo). La plataforma lo guarda en `members.intranet_id` y empareja primero por él |
| `denomination`         | string \| null | `users.designation`                                                                            |
| `initials`             | string \| null | `users.initials`                                                                               |
| `university`           | string \| null | `users.university`                                                                             |
| `autonomous_community` | string \| null | `users.autonomous_community`                                                                   |
| `generated_at`         | string ISO8601 | Momento de la respuesta                                                                        |

Reglas:

- **Lista completa, sin paginación**, en una sola respuesta. No usar
  `paginate()`: la plataforma solo lee `data` y desactivaría lo que no venga.
  Hoy son del orden de un centenar de filas; el cliente admite hasta 5000.
- Orden estable (`initials`, `id`); la plataforma no usa el orden y no hace
  falta `order`.
- `id` estable y único: la plataforma empareja por él antes que por siglas.
  Un `id` que no sea un entero de 1 a 2^31-1 invalida la lista entera; uno
  repetido se descarta (gana la primera fila).
- Sin `description`, logos ni `social_networks`: eso es para la web.
- Ante cualquier fallo, error 5xx. Nunca `200` con `data: []` por un error
  (la plataforma pide confirmación antes de desactivar muchos miembros, pero
  la sincronización diaria no confirma nunca).
- Sin respuestas condicionales (ETag/304): la plataforma trata un 304 como
  fallo.

#### `GET /api/asambleas/v1/usuarios/sectoriales`

Igual que asociados, con `users.type = 'Sectorial'`. `university` y
`autonomous_community` van siempre a `null` (como hoy en la ruta pública, que
no las envía): para las cuentas sectoriales ese dato no es fiable.

### 4.4 Medidas de seguridad

| Medida               | Cómo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token dedicado       | Middleware `AuthenticateAssembliesService` en todo el grupo; hash SHA-256 en configuración, `hash_equals`, solo cabecera `Authorization`; token con prefijo `asm_` para que no se confunda con un hash.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Proxies de confianza | nginx ya recupera la IP real de Cloudflare (`real_ip_header CF-Connecting-IP` con todos sus rangos) y fija `X-Forwarded-Proto`; `TrustProxies` confía solo en `TRUSTED_PROXIES` (la red de Docker que comparte con nginx, o su dirección fija; sin ella, en nadie) y solo acepta `X-Forwarded-For` y `-Proto` (R6, sección 5.8).                                                                                                                                                                                                                                                                                                                                  |
| Lista de IP          | Opcional, y vacía: `ASSEMBLIES_API_ALLOWED_IPS` (admite CIDR, `IpUtils::checkIp`). No se usa porque la plataforma también llama desde el servidor de desarrollo, sin IP fija. Si algún día se usa, el `ip` que registra `assemblies_api.denied` dice desde qué dirección llega cada cliente.                                                                                                                                                                                                                                                                                                                                                                      |
| Solo HTTPS           | `ASSEMBLIES_API_REQUIRE_HTTPS` (por defecto `true`): el middleware responde 403 a peticiones no seguras, y así una URL mal configurada falla a la vista. Por Internet, Laravel sabe que la petición es HTTPS por el `X-Forwarded-Proto` de nginx, porque nginx está en `TRUSTED_PROXIES`. Solo se desactiva (`false`) si la plataforma llama por la red de Docker, que es HTTP; no abre nada hacia fuera, porque nginx redirige todo el puerto 80 a HTTPS (sección 5.8, punto 3).                                                                                                                                                                                 |
| Límite de peticiones | Sin `throttle:api`. Limitador `assemblies-api`: 300/min por token en `user/role`, 30/min por token en cada listado, 600/min por IP. La clave por token usa el hash completo, nunca la huella de 8 caracteres que sale en los logs. El token se compara primero y un token válido pasa siempre; tras 10 tokens erróneos en un minuto desde una IP, los siguientes tokens erróneos reciben 429 en vez de 401 y dejan de escribir `assemblies_api.denied`. No protege de fuerza bruta (un token de 256 bits no se adivina): solo limita el ruido en los logs. El límite de 600/min por IP corre antes de la autenticación y cuenta también las peticiones sin token. |
| Campos mínimos       | Recursos dedicados (`AssemblyAccountResource`, `AssemblyMemberResource`) con lista cerrada de claves. Sin emails, teléfonos, redes ni logos.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Sin enumeración      | Sin token, 401 idéntico para cualquier email (no se consulta la base de datos). Con token, 404 idéntico para email desconocido y cuenta sin tipo. CORS cerrado: ningún navegador puede leer el grupo.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Logs sin secretos    | Nunca la cabecera `Authorization`, el token ni el hash completo; como huella, los 8 primeros caracteres del hash. Nunca el email en claro: HMAC con `APP_KEY`, truncado. No registrar cuerpos de petición. `LOG_LEVEL=info` en producción: `role_lookup` y `roster` se registran en `info`, y las secciones 7 y 8 los leen; con `notice` o más alto no se escriben.                                                                                                                                                                                                                                                                                               |
| Rotación             | Procedimiento de la sección 7, con un solo hash: entre el cambio en la Intranet y el de la plataforma, sus consultas fallan sin bloquear a nadie. Cada cambio de variables recrea el contenedor de la Intranet (sección 5.1), que deja de responder unos segundos.                                                                                                                                                                                                                                                                                                                                                                                                |
| CORS cerrado         | `config/cors.php` deja de usar `api/*` y lista solo las rutas públicas. El grupo `api/asambleas/*` queda fuera: sin `Access-Control-Allow-Origin`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Validación           | `FormRequest` (`AssemblyRoleLookupRequest`) con normalización previa; JSON forzado para que un error sea 422 y no una redirección.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Falla cerrado        | Sin hash configurado, 503. Un error interno, 5xx y nunca datos parciales. `APP_DEBUG=false`, comprobado en el contenedor al desplegar (sección 8, paso 1): con `APP_DEBUG=true` cualquiera obtiene la traza completa de un error, también sin token. Interruptor de HTTPS estricto: un valor en blanco o mal escrito lo deja activo.                                                                                                                                                                                                                                                                                                                              |
| Tests                | Sección 6.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## 5. Implementación en Laravel

Implementado en el commit `28d4579` de la Intranet (Laravel 13 con `Kernel` y
`RouteServiceProvider` clásicos). Estos bocetos lo resumen; el código del
repositorio es la referencia.

### 5.1 Configuración

`config/services.php`:

```php
'assemblies' => [
    // SHA-256 (hex) of the token the assemblies platform presents; the
    // token itself never lives in the Intranet. Anything that is not 64
    // hex characters (a pasted token, which starts with "asm_", or a
    // truncated hash) is dropped, so a value set by mistake fails closed
    // (503) instead of quietly answering 401.
    'token_hash' => with(
        strtolower(trim((string) env('ASSEMBLIES_API_TOKEN_SHA256'))),
        fn (string $hash) => preg_match('/^[0-9a-f]{64}$/', $hash) === 1 ? $hash : null,
    ),

    // Optional allow-list (IPs or CIDR ranges), comma separated.
    'allowed_ips' => array_values(array_filter(array_map(
        'trim',
        explode(',', (string) env('ASSEMBLIES_API_ALLOWED_IPS', '')),
    ))),

    // Defaults to true and only the word false (which env() turns into a
    // boolean) turns it off. A blank value, "off", "0" or a typo keeps the
    // check instead of being cast: (bool) '' would quietly turn it off,
    // and FILTER_VALIDATE_BOOL also reads '' as false.
    'require_https' => env('ASSEMBLIES_API_REQUIRE_HTTPS') !== false,
],
```

`.env.example`:

```dotenv
# API for the assemblies platform (/api/asambleas/v1)
# SHA-256 hex of the token, never the token itself (asm_...):
# printf %s "$TOKEN" | sha256sum
ASSEMBLIES_API_TOKEN_SHA256=
# Optional, comma separated IPs or CIDR ranges the platform calls from
ASSEMBLIES_API_ALLOWED_IPS=
# Only the word false turns it off; blank or anything else keeps HTTPS required
ASSEMBLIES_API_REQUIRE_HTTPS=true

# The nginx container in front of Apache: its fixed address or the range of
# the Docker network it shares with the Intranet (CIDR, comma separated).
# Empty trusts nobody. In production, without it every visitor shares nginx's
# address (and its per-IP limits) and no request is seen as HTTPS.
TRUSTED_PROXIES=
```

`TRUSTED_PROXIES` la lee `config/trustedproxy.php` (sección 5.8).

En producción (VPS revisado el 2026-11-06), el `env_file` de la Intranet
(`config/intranet/.env`) lleva:

```dotenv
ASSEMBLIES_API_TOKEN_SHA256=<hash>
TRUSTED_PROXIES=172.18.0.0/16
```

`ASSEMBLIES_API_ALLOWED_IPS` se queda vacía, y `ASSEMBLIES_API_REQUIRE_HTTPS`
en su valor por defecto salvo que la plataforma llame por la red de Docker
(`false`; sección 5.8, punto 3).

**Aplicar un cambio de estas variables en producción.** La imagen no lleva
`.env` (`.dockerignore` lo excluye): las variables llegan al contenedor
`intranet` por el `env_file` de su servicio en el `docker-compose.yml` del VPS
(`config/intranet/.env` en el VPS). Docker las fija al **crear** el contenedor, y al arrancar
`docker/apache/entrypoint.sh` ejecuta `optimize:clear` y `config:cache` con
ese entorno. Por eso ni `php artisan config:cache` dentro del contenedor ni
`docker compose restart` aplican un cambio: vuelven a cachear los valores
viejos. El `.env` del directorio de compose es otro archivo: solo sustituye
variables dentro del `docker-compose.yml` (ahí `scripts/deploy.sh` fija
`INTRANET_IMAGE`) y no llega al contenedor.

1. Editar el `env_file` del servicio `intranet` en el VPS.
2. Desde el directorio de compose (`REMOTE_DIR` de `scripts/deploy.sh`, cuyo
   `.env` mantiene la imagen desplegada). Antes, comprobar que ese `.env` fija
   la imagen que está corriendo: `deploy.sh` solo escribe la línea tras un
   despliegue verificado, y sin ella el compose cae en `:latest`, que en el
   VPS puede ser una versión vieja, sin dar ningún error. Si falta, añadirla
   con la imagen que muestra `docker compose images intranet`.

   ```bash
   grep '^INTRANET_IMAGE=' .env
   docker compose images intranet    # the same image and tag
   docker compose up -d --force-recreate --no-deps intranet
   docker compose exec -T nginx nginx -s reload
   ```

   La recarga de nginx es la misma que hace `deploy.sh`: el contenedor nuevo
   puede tener otra dirección. Alternativa: editar el `env_file` y desplegar
   con `scripts/deploy.sh`, que también recrea el contenedor y recarga nginx.

3. Comprobar lo que ha cargado (si hay hash, nunca el hash):

   ```bash
   docker compose exec -T intranet php artisan tinker --execute="dump(config('services.assemblies.token_hash') !== null, config('services.assemblies.allowed_ips'), config('services.assemblies.require_https'), config('trustedproxy.proxies'))"
   ```

Efectos: la Intranet entera deja de responder unos segundos (hacerlo fuera de
los picos de inicio de sesión), y `optimize:clear` vacía la caché por defecto
y con ella los contadores de los limitadores, el bloqueo por tokens erróneos
incluido.

### 5.2 Middleware

`app/Http/Middleware/AuthenticateAssembliesService.php`:

```php
<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\RateLimiter;
use Symfony\Component\HttpFoundation\IpUtils;
use Symfony\Component\HttpFoundation\Response;

/**
 * Authenticates the assemblies platform on /api/asambleas/v1, server to
 * server. The token travels only in the Authorization header; the Intranet
 * keeps only its SHA-256 and compares it in constant time.
 */
class AuthenticateAssembliesService
{
    private const FAILURES_PER_MINUTE = 10;

    public function handle(Request $request, Closure $next): Response
    {
        // Every answer is JSON, even for a client that sends no Accept header:
        // otherwise a validation error would be a redirect to an HTML page.
        $request->headers->set('Accept', 'application/json');

        $config = config('services.assemblies');

        if ($config['require_https'] && ! $request->secure()) {
            return $this->deny($request, 403, 'https_required');
        }

        if ($config['allowed_ips'] !== []
            && ! IpUtils::checkIp((string) $request->ip(), $config['allowed_ips'])) {
            return $this->deny($request, 403, 'ip_not_allowed');
        }

        if ($config['token_hash'] === null) {
            Log::critical('assemblies_api.not_configured');

            return $this->noStore(response()->json(['error' => 'service_unavailable'], 503));
        }

        // The token is compared first and a valid one always passes: the
        // failure counter is never read for it, so nobody sharing an address
        // with the platform can lock it out by sending bad tokens.
        if ($this->matches((string) $request->bearerToken(), $config['token_hash'])) {
            // Covers whatever the controller answers, errors rendered by the
            // handler included (404, 422, 500).
            return $this->noStore($next($request));
        }

        // Not a brute-force guard (a 256-bit token cannot be guessed): it only
        // turns a stream of wrong tokens into 429 and stops logging each one.
        $failureKey = 'assemblies-api-auth-failures:'.$request->ip();
        if (RateLimiter::tooManyAttempts($failureKey, self::FAILURES_PER_MINUTE)) {
            return $this->noStore(response()->json(['error' => 'too_many_requests'], 429, [
                'Retry-After' => RateLimiter::availableIn($failureKey),
            ]));
        }

        RateLimiter::hit($failureKey, 60);

        return $this->deny($request, 401, 'invalid_token');
    }

    /** Nothing this group answers may be kept by a proxy or the client. */
    private function noStore(Response $response): Response
    {
        $response->headers->set('Cache-Control', 'no-store');

        return $response;
    }

    /** Whether the presented token hashes to the configured one, in constant time. */
    private function matches(string $presented, string $hash): bool
    {
        return $presented !== '' && hash_equals($hash, hash('sha256', $presented));
    }

    private function deny(Request $request, int $status, string $reason): Response
    {
        // Never the Authorization header, the token or the request body.
        Log::warning('assemblies_api.denied', [
            'reason' => $reason,
            'path' => $request->path(),
            'ip' => $request->ip(),
        ]);

        return $this->noStore(response()->json(
            ['error' => $status === 401 ? 'unauthorized' : 'forbidden'],
            $status,
            $status === 401 ? ['WWW-Authenticate' => 'Bearer'] : [],
        ));
    }
}
```

`app/Http/Kernel.php`, en `$routeMiddleware`:

```php
'assemblies.service' => \App\Http\Middleware\AuthenticateAssembliesService::class,
```

El `Accept` que fuerza el middleware solo cubre lo que ocurre después de él.
Un 405 se lanza al resolver la ruta y un 429 de `ThrottleRequests` llega antes
que `assemblies.service` (sección 5.3); a un cliente que no envíe `Accept`
(como la consulta de rol de la plataforma antes de enviarlo) le saldrían en
HTML. Para que todo el grupo responda JSON sin depender del orden ni del
cliente, en `app/Exceptions/Handler.php`:

```php
/**
 * The API for the assemblies platform always answers JSON, also for
 * errors raised before its middleware runs (405, 429).
 */
protected function shouldReturnJson($request, Throwable $e)
{
    return $request->is('api/asambleas/*') || parent::shouldReturnJson($request, $e);
}
```

### 5.3 Limitador

En `RouteServiceProvider::configureRateLimiting()`:

```php
// The assemblies platform calls from a single server, so the budget is per
// token, sized for everybody signing in when a session opens. Laravel's
// middleware priority sorts ThrottleRequests ahead of SubstituteBindings (from
// the api group), so it runs before assemblies.service: the key hashes the
// presented token itself instead of reading anything the service middleware
// sets. The key takes the full hash, never the 8-character fingerprint the
// logs show: with that prefix anyone reading the logs could build a junk
// token that shares, and drains, the platform's bucket. ThrottleRequests
// hashes the key again, so it never reaches the cache in clear.
RateLimiter::for('assemblies-api', function (Request $request) {
    $token = hash('sha256', (string) $request->bearerToken());
    $route = (string) $request->route()?->getName();
    $perMinute = $route === 'api.asambleas.role' ? 300 : 30;

    return [
        Limit::perMinute($perMinute)->by('assemblies-api:'.$route.':'.$token),
        Limit::perMinute(600)->by('assemblies-api:ip:'.$request->ip()),
    ];
});
```

Los 300/min de la consulta de rol cubren que toda una asamblea entre a la vez;
son ajustables. Un token filtrado sigue limitado y deja rastro en los logs.

### 5.4 Rutas

`routes/api.php`:

```php
use App\Http\Controllers\Api\AssembliesApiController;

// API for the assemblies platform, reachable from the internet so that its
// development server can call production: service token, its own rate limit
// (not the shared 60/min of the api group) and no CORS (see config/cors.php).
// It replaces the old public POST /api/user/role, which is gone.
Route::prefix('asambleas/v1')
    ->name('api.asambleas.')
    ->withoutMiddleware('throttle:api')
    ->middleware(['assemblies.service', 'throttle:assemblies-api'])
    ->group(function () {
        Route::post('user/role', [AssembliesApiController::class, 'role'])->name('role');
        Route::get('usuarios/asociados', [AssembliesApiController::class, 'asociados'])->name('asociados');
        Route::get('usuarios/sectoriales', [AssembliesApiController::class, 'sectoriales'])->name('sectoriales');
    });
```

La ruta pública vieja, `POST /api/user/role`, y su acción
`AdminController::getUserRoleByEmail` se han eliminado. No hubo ventana de
transición: la plataforma aún no estaba en producción (sección 8). Un test
comprueba que responde 404.

### 5.5 Validación

`app/Http/Requests/Api/AssemblyRoleLookupRequest.php`:

```php
<?php

namespace App\Http\Requests\Api;

use Illuminate\Foundation\Http\FormRequest;

class AssemblyRoleLookupRequest extends FormRequest
{
    /** The service was already authenticated by AuthenticateAssembliesService. */
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'email' => ['required', 'string', 'max:254', 'email:rfc'],
        ];
    }

    protected function prepareForValidation(): void
    {
        $email = $this->input('email');
        if (is_string($email)) {
            $this->merge(['email' => mb_strtolower(trim($email))]);
        }
    }
}
```

### 5.6 Controlador y recursos

`app/Http/Controllers/Api/AssembliesApiController.php`:

```php
<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Api\AssemblyRoleLookupRequest;
use App\Http\Resources\AssemblyAccountResource;
use App\Http\Resources\AssemblyMemberResource;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Log;

/**
 * Private API for the assemblies platform: who an account is (role sync on
 * every sign-in) and the councils and sectorials it can act for (roster
 * sync). Only the fields the platform reads.
 */
class AssembliesApiController extends Controller
{
    public function role(AssemblyRoleLookupRequest $request): JsonResponse
    {
        $email = $request->validated('email');
        $user = User::query()
            ->where('email', $email)
            ->first(['id', 'type', 'name', 'initials', 'university']);

        // An account without a type is answered like an unknown one: a 200
        // with any role would demote an existing Asociado or CEA on the
        // platform.
        $found = $user !== null && trim((string) $user->type) !== '';

        Log::info('assemblies_api.role_lookup', [
            'found' => $found,
            // Correlates repeated lookups without writing the address.
            'email_ref' => substr(hash_hmac('sha256', $email, (string) config('app.key')), 0, 12),
            'token' => substr(hash('sha256', (string) $request->bearerToken()), 0, 8),
        ]);

        if (! $found) {
            return response()->json(['error' => 'not_found'], 404);
        }

        return response()->json((new AssemblyAccountResource($user))->resolve($request));
    }

    public function asociados(): JsonResponse
    {
        return $this->roster('Asociado');
    }

    public function sectoriales(): JsonResponse
    {
        return $this->roster('Sectorial');
    }

    /**
     * The whole list in one answer, never paginated: the platform
     * deactivates every intranet member it does not receive.
     */
    private function roster(string $type): JsonResponse
    {
        $members = User::query()
            ->where('type', $type)
            ->orderBy('initials')
            ->orderBy('id')
            ->get(['id', 'type', 'designation', 'initials', 'university', 'autonomous_community']);

        Log::info('assemblies_api.roster', ['type' => $type, 'count' => $members->count()]);

        return AssemblyMemberResource::collection($members)
            ->additional(['generated_at' => now()->toIso8601String()])
            ->response();
    }
}
```

`app/Http/Resources/AssemblyAccountResource.php`:

```php
<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** One account as the assemblies platform reads it on sign-in. */
class AssemblyAccountResource extends JsonResource
{
    /** @return array<string, mixed> */
    public function toArray(Request $request): array
    {
        return [
            'id' => (int) $this->id,
            'role' => (string) $this->type,
            'name' => $this->name,
            'initials' => $this->initials,
            'university' => $this->university,
        ];
    }
}
```

`app/Http/Resources/AssemblyMemberResource.php`:

```php
<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** One council or sectorial of the roster. Fixed keys, nothing personal. */
class AssemblyMemberResource extends JsonResource
{
    /** @return array<string, mixed> */
    public function toArray(Request $request): array
    {
        // The university of a sectorial account is not reliable (Google login
        // fills it from the family name), so it is never sent.
        $isCouncil = $this->type === 'Asociado';

        return [
            'id' => (int) $this->id,
            'denomination' => $this->designation,
            'initials' => $this->initials,
            'university' => $isCouncil ? $this->university : null,
            'autonomous_community' => $isCouncil ? $this->autonomous_community : null,
        ];
    }
}
```

`AssemblyMemberResource::collection(...)` sobre una `Collection` (no un
paginador) produce exactamente `{"data": [...], "generated_at": "..."}`, sin
`links` ni `meta`, mientras nadie llame a `JsonResource::withoutWrapping()`
(hoy no se llama): sin la envoltura `data` la sincronización de la plataforma
fallaría con 502.

`Cache-Control: no-store` lo pone el middleware sobre cualquier respuesta del
controlador, también los errores que renderiza el `Handler` (404, 422, 500).

### 5.7 CORS

`config/cors.php`: sustituir `api/*` por la lista de rutas públicas. Laravel no
admite patrones negativos, así que hay que enumerarlas:

```php
'paths' => [
    // Public endpoints only, listed one by one because Laravel has no negative
    // patterns. The api/asambleas/* group of the assemblies platform is left
    // out on purpose: no browser may read it.
    'api/organigrama',
    'api/organigrama/*',
    'api/comites',
    'api/usuarios/*',
    'api/eventos',
    'api/posicionamientos',
    'api/resoluciones',
    'api/informes-ejecutivos',
    'api/normativa',
    'sanctum/csrf-cookie',
],
```

`api/usuarios/*` no casa con `api/asambleas/v1/usuarios/...` porque el patrón
se compara desde el inicio de la ruta. La plataforma llama desde el servidor,
así que CORS no le afecta.

### 5.8 Proxies, acceso de la plataforma y otros ajustes

**La API es accesible desde Internet y la protege el token.** La plataforma la
llama por la URL pública, `https://intranet.creup.es/api/asambleas/v1`, tanto
en producción como desde el servidor de desarrollo de quien la programa; si en
el VPS comparte red de Docker con la Intranet, también puede llamarla por
dentro (punto 3). No hay lista de IP ni bloqueo en nginx: los listados son
datos que ya publica la web, y la consulta de rol solo responde a quien
presenta el token.

Estado del VPS revisado el 2026-11-06. El vhost está en
`config/nginx/conf.d/intranet.creup.es.conf` del directorio de compose, y
`docker compose exec -T nginx nginx -T` muestra la configuración entera.

1. **nginx ya hace lo necesario.**
   - `snippets/cloudflare-realip.conf`, incluido en `nginx.conf` para todos
     los sitios, recupera la IP real con `real_ip_header CF-Connecting-IP` y
     todos los rangos de Cloudflare, IPv4 e IPv6. El log de acceso de la
     Intranet muestra IP reales de visitantes. Cuando Cloudflare cambie sus
     rangos (<https://www.cloudflare.com/ips/>), hay que actualizar ese
     archivo.
   - Termina TLS con el certificado de Let's Encrypt de `creup.es`, válido
     para `intranet.creup.es`, y el puerto 80 redirige todo a HTTPS.
   - El vhost de la Intranet hace `proxy_pass http://intranet:80` con
     `X-Forwarded-Proto $scheme` y
     `X-Forwarded-For $proxy_add_x_forwarded_for`.

   No hace falta cambiar nada. Recomendado, para que la cabecera lleve solo la
   dirección real: `proxy_set_header X-Forwarded-For $remote_addr;`. Con
   `$proxy_add_x_forwarded_for` también es seguro: nginx añade la IP real al
   final, y Laravel se queda con la última dirección que no es de confianza,
   así que lo que el cliente escriba delante nunca gana (lo prueba la sección
   6). `X-Forwarded-Host` y `-Port` sobran: Laravel ya no los lee (punto 4).

2. **`TRUSTED_PROXIES`: quién puede acreditar la IP y HTTPS.** `28d4579` deja
   de confiar en `'*'` (punto 4). En el VPS todos los contenedores están en una
   sola red de Docker, `esternocleidomastoideo2003_default` (`172.18.0.0/16`),
   y nginx tiene una dirección dinámica (`172.18.0.15` al revisarlo). Lo
   simple es confiar en esa red:

   ```dotenv
   TRUSTED_PROXIES=172.18.0.0/16
   ```

   - Confía en nginx esté donde esté dentro de la red. También en los demás
     contenedores (la web, WordPress, phpMyAdmin...): uno comprometido podría
     hablar con Apache directamente, declarar otra IP o HTTPS y saltarse los
     límites por IP. No le da acceso a la API, que pide el token.
   - Más estricto, para más adelante: dar a nginx una dirección fija en una
     red propia compartida con la Intranet, apuntar su `proxy_pass` a un alias
     de la Intranet que solo exista en esa red, y poner en `TRUSTED_PROXIES`
     solo esa dirección. Se aplica con
     `docker compose up -d --no-deps nginx intranet`, conservando las redes
     que ya tienen; un `docker compose up -d` sin nombres arrancaría o
     recrearía también el resto de servicios del VPS.
   - Sin `TRUSTED_PROXIES`, Laravel no confía en nadie: todos los visitantes
     comparten la dirección de nginx (y los límites por IP, los 60/min de
     `throttle:api` incluidos), ninguna petición se ve como HTTPS y la
     plataforma recibe 403 `https_required` por la URL pública. Por eso la
     variable entra en el `env_file` en el mismo despliegue que `28d4579`.
   - Si la red por defecto se recrea con otra subred, hay que actualizar la
     variable. Para comprobarla:
     `docker network inspect esternocleidomastoideo2003_default --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'`.

3. **Cómo llega la plataforma.**
   - **Por la URL pública**, `https://intranet.creup.es/api/asambleas/v1`:
     desde el servidor de desarrollo y, si se quiere, también desde
     producción. Pasa por Cloudflare y por nginx, que acredita HTTPS, así que
     vale con `ASSEMBLIES_API_REQUIRE_HTTPS` por defecto (`true`). Si
     Cloudflare desafía esas llamadas (Bot Fight Mode o una regla del WAF: un
     403 en HTML, con cabecera `cf-ray` y nada en los logs de la Intranet),
     añadir en Cloudflare una excepción para `/api/asambleas/`.
   - **Por la red de Docker**, `http://intranet/api/asambleas/v1`, si la
     plataforma se despliega en el VPS en una red que comparta con la
     Intranet, como la web, que ya llama a `http://intranet`. No pasa por
     Cloudflare. Es HTTP y no pasa por nginx, así que exige
     `ASSEMBLIES_API_REQUIRE_HTTPS=false`. Eso no abre nada hacia fuera: nginx
     redirige todo el puerto 80 a HTTPS, así que ninguna petición en claro de
     Internet llega a la Intranet. Desde otro proyecto de compose, la
     plataforma se une a la red de la Intranet así:

     ```yaml
     services:
       app:
         networks: [default, intranet]
     networks:
       intranet:
         external: true
         name: esternocleidomastoideo2003_default
     ```

     Cambiar de red exige recrear el contenedor (`up -d app`); `restart` no
     basta. La plataforma, en producción, solo acepta `http:` hacia nombres
     sin punto (sección 1): `http://intranet` vale.

   - En los dos casos, `ASSEMBLIES_API_ALLOWED_IPS` se queda vacía: el
     servidor de desarrollo no tiene una IP fija.

4. **`TrustProxies` confía solo en `TRUSTED_PROXIES`, y solo para la dirección
   y el esquema.** Lo implementa `28d4579`. `config/trustedproxy.php`:

   ```php
   <?php

   return [
       // The reverse proxy in front of Apache, the only peer allowed to vouch for
       // the client's IP and scheme (App\Http\Middleware\TrustProxies): the nginx
       // container's fixed address or, more simply, the range (CIDR) of the
       // Docker network it shares with the Intranet. Comma separated, blank
       // entries dropped. Unset trusts nobody (fails closed). Never '*': the
       // wildcards and REMOTE_ADDR, which would trust whoever opens the
       // connection, are dropped too.
       'proxies' => array_values(array_filter(
           array_map('trim', explode(',', (string) env('TRUSTED_PROXIES', ''))),
           fn (string $proxy) => $proxy !== '' && ! in_array($proxy, ['*', '**', 'REMOTE_ADDR'], true),
       )),
   ];
   ```

   `app/Http/Middleware/TrustProxies.php`, sin lista de `$proxies`:

   ```php
   /** Only what nginx sets: the client's address and the scheme. */
   protected $headers = Request::HEADER_X_FORWARDED_FOR | Request::HEADER_X_FORWARDED_PROTO;

   /** The addresses or ranges in config/trustedproxy.php; empty trusts nobody. */
   protected function proxies()
   {
       return config('trustedproxy.proxies');
   }
   ```

   - `X-Forwarded-Host` y `-Port` dejan de leerse. `URL::forceRootUrl` en
     `AppServiceProvider` ya fija las URL que genera la Intranet, y las que se
     leen de la petición (`$request->url()`, `fullUrl()`, las rutas del
     paginador) salen del `Host` que fija nginx.
   - Los tests de la sección 6 comprueban que solo quien está en
     `TRUSTED_PROXIES` acredita HTTPS, que con un rango de Docker se sigue
     viendo al cliente real y que `config/trustedproxy.php` nunca confía en
     quien abre la conexión.

5. **El contenedor `intranet` no publica ningún puerto** (comprobado:
   `docker compose ps intranet` muestra `80/tcp` sin dirección del host).
   Apache solo es accesible desde la red de Docker. No configurar
   `RemoteIPHeader` en Apache: Laravel tiene que seguir viendo a nginx como
   quien abre la conexión.

6. **Cloudflare en modo SSL/TLS Full (strict)** (recomendado). No puede estar
   en Flexible: como el 80 redirige a HTTPS, la web entraría en un bucle de
   redirecciones. Así que es Full o Full (strict), y con el certificado válido
   del origen se puede pasar a Full (strict) sin riesgo.

7. **El origen responde también sin Cloudflare** (comprobado: el 443 del VPS
   contesta a conexiones directas con el certificado válido). No afecta a las
   IP, porque nginx solo cree a Cloudflare, ni a la API, que pide el token,
   pero permite saltarse el WAF de Cloudflare. Opcional: abrir el 80 y el 443
   solo a los rangos de Cloudflare, con el cortafuegos del proveedor o con
   reglas en la cadena `DOCKER-USER` (`ufw` no filtra los puertos que publica
   Docker). **Antes**, comprobar que todos los dominios que sirve ese nginx
   (Moodle, encuestas...) pasan por el proxy de Cloudflare: uno en "solo DNS"
   dejaría de responder.

Otros ajustes:

- **`GET /api/user` (R7):** eliminarla si no la usa nadie (no se emite ningún
  token Sanctum). Si se mantiene, devolver un recurso con campos cerrados.
- **Producción:** `APP_DEBUG=false` (comprobado en el `env_file`).
  `LOG_LEVEL=info` (hoy es `debug`): `role_lookup` y `roster` se registran en
  `info` y la sección 8 los lee. Se comprueba con
  `config:show logging.channels.single.level` (el canal por defecto, `stack`,
  escribe en `single`).

## 6. Tests (PHPUnit)

La suite está en la Intranet, `tests/Feature/Api/AssembliesApiTest.php`, en el
estilo del repositorio (PHPUnit 13, `RefreshDatabase`, `#[DataProvider]`,
métodos `test_...`). Ese archivo es la referencia; esto es lo que cubre:

- **Token:** sin token o con uno erróneo, el mismo 401 en las tres rutas; un
  token en la query string no vale; sin hash configurado, 503.
- **Contrato:** la consulta de rol devuelve exactamente `id`, `role`, `name`,
  `initials` y `university`, con el email normalizado y
  `Cache-Control: no-store`; un email desconocido y una cuenta sin tipo dan el
  mismo 404; los listados traen solo `data` y `generated_at`, completos y sin
  otros tipos, y el de sectoriales sin universidad ni comunidad autónoma.
- **JSON sin `Accept`:** el 422, el 405 y el 429 del limitador salen en JSON
  aunque la petición no lo pida.
- **Límites:** no se aplica el de 60/min del grupo `api`; cada listado tiene
  su propio cupo por token; tras 10 tokens erróneos, los erróneos reciben 429
  y uno válido sigue pasando.
- **Lista de IP y proxies:** la lista de IP se aplica; HTTP se rechaza cuando
  se exige HTTPS; solo quien está en `TRUSTED_PROXIES` acredita HTTPS (con la
  dirección de nginx, ni la pasarela de Docker, ni un contenedor vecino, ni un
  cliente público); con el rango de la red de Docker se sigue viendo al
  cliente real aunque nginx añada a `X-Forwarded-For`; un `X-Forwarded-For`
  falsificado no gana, y `X-Forwarded-Host` se ignora.
- **Configuración:** `config/services.php` descarta un token pegado o un hash
  truncado, normaliza un hash con espacios o mayúsculas y solo desactiva
  HTTPS con la palabra `false`; `config/trustedproxy.php` descarta `*`, `**`
  y `REMOTE_ADDR`.
- **CORS:** el grupo no responde a un origen de navegador; los listados
  públicos siguen abiertos.
- **Logs:** nunca el token, su hash ni el email.
- **Ruta vieja:** `POST /api/user/role` ya no existe (404).

La red de Docker y nginx (sección 5.8) no se prueban aquí: se comprueban en el
despliegue (sección 8).

Notas:

- Los límites viven en la caché. `config/cache.php` lee `CACHE_DRIVER`, que
  `phpunit.xml` fija a `array` (el `CACHE_STORE=array` de `.env.testing` no lo
  lee nadie); esa caché empieza vacía en cada test, así que los contadores no
  se arrastran de un test a otro.
- Los tests de proxies fijan `trustedproxy.proxies` (una dirección de nginx
  o un rango de Docker) en vez de depender de la configuración. Sus URL son
  `http://` a propósito: con `https://` la petición sería segura por la
  variable `HTTPS` del servidor, sin pasar por `X-Forwarded-Proto`.
- Los tests de configuración cargan `config/services.php` y
  `config/trustedproxy.php` con variables de entorno reales, porque el resto
  fija la configuración ya calculada y no vería esos filtros.

## 7. Rotación del token

Cuándo: una vez al año, en cada relevo de la persona responsable de TIC y de
inmediato ante cualquier sospecha de filtración.

La Intranet guarda un solo hash, así que hay un corte breve: desde que tiene
el hash nuevo hasta que la plataforma envía el token nuevo, las consultas de la
plataforma reciben 401. Nadie pierde el acceso: las cuentas conservan su rol y
su miembro, las nuevas entran como `Invitado` hasta su siguiente inicio de
sesión y "Sincronizar" en Miembros da 502. Hacer los pasos 2 y 3 seguidos y
fuera de los picos de inicio de sesión.

1. Generar el token nuevo y su hash sin dejarlo en el historial de la shell:

   ```bash
   T="asm_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
   printf %s "$T" | sha256sum | cut -d' ' -f1   # hash for the Intranet
   printf %s "$T"                               # copy to the password manager, then: unset T
   ```

   El token sale con 47 caracteres (`asm_` y 43 de base64url). El prefijo
   evita confundirlo con su hash, que son 64 caracteres hexadecimales: si se
   pega el token en la Intranet por error, se descarta (sección 5.1).

2. Intranet: sustituir el valor de `ASSEMBLIES_API_TOKEN_SHA256` por el hash
   nuevo (que solo quede una línea con esa variable) y aplicarlo recreando el
   contenedor (sección 5.1, "Aplicar un cambio"; `config:cache` no basta). El
   token viejo deja de valer en ese momento.
3. Plataforma: poner el token nuevo en `NUXT_INTRANET_API_TOKEN`, en
   producción (recreando el contenedor:
   `docker compose -f docker-compose.prod.yml up -d app`; `restart` no relee
   el `.env`) y en el `.env` local del servidor de desarrollo.
4. Comprobar en los logs de la Intranet (`assemblies_api.role_lookup`) que la
   huella `token` coincide con los 8 primeros caracteres del hash nuevo, y que
   un inicio de sesión y una sincronización del listado funcionan.
5. Borrar el token viejo del gestor de contraseñas.

Mientras la plataforma siga con el token viejo, sus consultas reciben 401, y
429 a partir de la undécima en un minuto, pero pasan en cuanto envía el token
nuevo: el bloqueo solo afecta a tokens erróneos, así que no hay que esperar ni
borrar contadores. Ante una filtración, los mismos pasos, sin esperar.

Dónde vive el token: en el `.env` de producción de la plataforma, en el `.env`
local de su servidor de desarrollo y en el gestor de contraseñas de TIC. Nunca
en repositorios, correos ni chats. La Intranet solo guarda el hash.

## 8. Despliegue

Hacerlo fuera de una semana de asamblea.

**Estado (2026-11-06).** Desplegado `28d4579`, con los dos commits que tenía
debajo (`e57094b`, tesorería, y `c7e584f`, portafirmas), y el `env_file` del
paso 1: la API responde 401 sin token y la ruta vieja, 404. Falta desplegar el
commit `0e1badf`, que elimina la ruta vieja y la segunda ranura del token. No
necesita variables nuevas; después sobran `ASSEMBLIES_API_LEGACY_ROLE_ROUTE` y
`ASSEMBLIES_API_TOKEN_SHA256_NEXT` en el `env_file`.

`28d4579` cambia la Intranet entera, no solo la API: CORS pasa de `api/*` a
una lista de rutas y `TrustProxies` deja de confiar en `'*'`. Sin
`TRUSTED_PROXIES` no confía en nadie: todos los visitantes comparten la
dirección de nginx (y sus límites por IP) y ninguna petición se ve como HTTPS.
Por eso no se despliega sin `TRUSTED_PROXIES` en el `env_file`.

**Paso 0. Preparar.** Generar el token (sección 7, paso 1) y guardarlo en el
gestor de contraseñas.

**Paso 1. Intranet: grupo nuevo con token.**

1. En el `env_file` del servicio `intranet` (`config/intranet/.env` del
   directorio de compose; sección 5.1). `APP_DEBUG=false` ya está.

   ```dotenv
   LOG_LEVEL=info
   TRUSTED_PROXIES=172.18.0.0/16
   ASSEMBLIES_API_TOKEN_SHA256=<hash>
   ```

   Con el hash de verdad en lugar de `<hash>`, y una sola línea
   `ASSEMBLIES_API_TOKEN_SHA256=`: con dos, Docker se queda con la última.
   `ASSEMBLIES_API_ALLOWED_IPS` no se pone, y `ASSEMBLIES_API_REQUIRE_HTTPS`
   solo si la plataforma va a llamar por la red de Docker (`false`; sección
   5.8, punto 3).

   La ruta vieja desaparece sin ventana de transición: la plataforma aún no
   está en producción (no hay ningún contenedor suyo en el VPS) y los logs de
   nginx de unas dos semanas solo tenían 2 llamadas a `POST /api/user/role`.
   R1 desaparece con el despliegue.

2. Desplegar con `scripts/deploy.sh` (recrea el contenedor y recarga nginx).
3. Comprobar lo que ha cargado:

   ```bash
   docker compose exec -T intranet php artisan config:show trustedproxy.proxies           # 172.18.0.0/16
   docker compose exec -T intranet php artisan config:show logging.channels.single.level  # info
   docker compose exec -T intranet php artisan tinker --execute="var_dump(config('services.assemblies.token_hash') !== null);"   # true
   ```

4. Comprobar desde fuera, desde cualquier máquina, con el token leído con
   `read -rs TOKEN`, no escrito en la línea de órdenes:

   ```bash
   B=https://intranet.creup.es/api/asambleas/v1
   curl -s -o /dev/null -w '%{http_code}\n' -X POST "$B/user/role" \
     -H 'Content-Type: application/json' -d '{"email":"nadie@example.com"}'   # 401
   read -rs TOKEN
   curl -s -o /dev/null -w '%{http_code}\n' -X POST "$B/user/role" \
     -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' -d '{"email":"nadie@example.com"}'   # 404
   curl -s "$B/usuarios/asociados" -H "Authorization: Bearer $TOKEN" | jq '.data | length'
   unset TOKEN
   curl -s "$B/user/role" | jq 'has("trace")'                                  # false
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://intranet.creup.es/api/user/role \
     -H 'Content-Type: application/json' -d '{"email":"nadie@example.com"}'   # 404
   ```

   - La primera llamada deja en los logs de la Intranet un
     `assemblies_api.denied` con `ip`: tiene que ser la IP pública de la
     máquina desde la que se llama, no una de Cloudflare ni una `172.x`.
   - La de `has("trace")` es un `GET` a una ruta `POST` (405): con
     `APP_DEBUG=true` traería la traza completa del error.
   - La última es la ruta vieja: 404 porque ya no existe.
   - La web pública sigue mostrando los consejos y las sectoriales (los pide
     por la red de Docker; CORS no le afecta).

Si algo no cuadra:

- 403 en HTML, con cabecera `cf-ray` y nada en los logs de la Intranet: es
  Cloudflare (sección 5.8, punto 3).
- 403 `{"error": "forbidden"}` con `assemblies_api.denied` y `reason`
  `https_required`: Laravel no ve la petición como HTTPS. La dirección de
  nginx no está en `TRUSTED_PROXIES` (sección 5.8, punto 2):
  `docker inspect nginx --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'`.
- 403 con `reason` `ip_not_allowed`: `ASSEMBLIES_API_ALLOWED_IPS` no está
  vacía.
- 503: no hay ningún hash válido y `tinker` da `false`. Un token pegado en su
  lugar, un hash truncado o una segunda línea `ASSEMBLIES_API_TOKEN_SHA256=`
  más abajo que tapa la buena (pasó en el primer despliegue).

**Paso 2. Plataforma: cambiar variables.**

- Antes, en la base de datos de la Intranet: el listado nuevo ordena por
  siglas e id (el público, por nombre) y la plataforma se queda con la
  primera fila cuando dos siglas coinciden sin distinguir mayúsculas. Si esta
  consulta devuelve filas, corregir esas siglas primero, o la primera
  sincronización puede cambiar el nombre o la universidad de ese miembro:

  ```sql
  SELECT type, LOWER(TRIM(initials)) AS k, COUNT(*) AS n
  FROM users
  WHERE type IN ('Asociado', 'Sectorial')
  GROUP BY type, k
  HAVING n > 1;
  ```

- La plataforma tiene que llevar ya la versión que usa `id`, retira el acceso
  a las cuentas borradas y sincroniza cada día, con sus migraciones
  aplicadas (`DEPLOYMENT.md`).
- **Servidor de desarrollo**, en su `.env` local:
  `NUXT_INTRANET_API_URL=https://intranet.creup.es/api/asambleas/v1`,
  `NUXT_INTRANET_API_TOKEN=<token>` y sin `NUXT_ROLE_API_URL`. Trabaja con
  datos reales de producción: la consulta de rol y la sincronización escriben
  en la base de datos local, y una cuenta que la Intranet no conozca pierde
  el acceso en ella. El token vive solo en ese `.env`, nunca en el
  repositorio.
- **Producción**, cuando se despliegue: `NUXT_INTRANET_API_URL` con la URL
  pública o, si comparte red con la Intranet, `http://intranet/api/asambleas/v1`
  (sección 5.8, punto 3); `NUXT_INTRANET_API_TOKEN=<token>`; sin
  `NUXT_ROLE_API_URL`. `NUXT_INTRANET_ROSTER_SYNC` no hace falta: sin ella, la
  sincronización diaria queda activa; `false` la apaga. El servicio lee el
  `.env` con `env_file`, así que hay que recrear el contenedor
  (`docker compose -f docker-compose.prod.yml up -d app`): `restart` conserva
  las variables viejas.
- Verificar: entrar con una cuenta Asociado y una CEA (rol y miembro correctos
  en Administración), pulsar "Sincronizar" en Miembros (sin desactivaciones
  inesperadas; queda `members.sync` en el registro de auditoría), y en los
  logs de la Intranet ver `assemblies_api.role_lookup` con la huella del
  token. Esa primera sincronización da casi todos los miembros como
  actualizados, porque guarda su `id`; si pide confirmación para desactivar,
  revisar antes qué falta en la Intranet.
- Desde este paso, una cuenta que la Intranet haya borrado pierde el acceso
  la próxima vez que inicie sesión o, si tiene una sesión abierta, en la
  revisión de las 05:30. Administración > Usuarios, con "Solo cuentas sin
  acceso", las lista: revisarlas el primer día, y buscar en Actividad
  `users.access_recheck_blocked`, que indicaría que la revisión no retiró
  nada porque faltaban demasiadas cuentas.

Los listados públicos (`/api/usuarios/asociados` y
`/api/usuarios/sectoriales`) **no se cierran**: son de la web.

## 9. Cambios en la plataforma

Hechos a la par que la fase 1 de la Intranet (detalle en la sección 1):

- **Documentación y entorno:** `DEPLOYMENT.md` y `README.md` usan
  `NUXT_INTRANET_API_URL` y `NUXT_INTRANET_API_TOKEN`, sin
  `NUXT_ROLE_API_URL`. El compose de producción de `DEPLOYMENT.md` llama a la
  URL pública por defecto y, para llamar por dentro, se une a la red de la
  Intranet (`esternocleidomastoideo2003_default`, con
  `ASSEMBLIES_API_REQUIRE_HTTPS=false` en ella; sección 5.8, punto 3).
  `runtimeConfig.roleApiUrl` de `nuxt.config.ts` ya no apunta a la ruta vieja.
- **`Accept: application/json`** en la consulta de rol, como el listado.
- **`http:` solo hacia nombres sin punto en producción**
  (`isIntranetUrlAllowed`): el token nunca viaja en claro por internet.
- **Huella del email en los logs** (`accountRef`): se pueden relacionar los
  avisos de una cuenta sin escribir su email.
- **`lastRoleSyncAt`** se escribe solo cuando la consulta sale bien, así que
  Administración ve qué cuentas llevan tiempo sin actualizarse.
- **Defensa ante listas vacías:** una sincronización que desactivaría todos
  los miembros de un tipo, o más de max(3, 30 %), pide confirmación
  (`members.sync_blocked`).
- **Cuentas borradas en la Intranet:** pierden el acceso a la plataforma, con
  las excepciones de la sección 1 (cuentas que la Intranet nunca conoció y
  roles protegidos). Decisión de producto.
- **Enlazar por `id`** (`users.intranet_id`, `members.intranet_id`):
  sobrevive a un cambio de siglas.
- **Sincronización diaria** del listado (tarea programada de pg-boss).
- **Revisión diaria de accesos** (05:30, cola `users-access-recheck`): las
  cuentas con sesión abierta que la Intranet borró pierden el acceso aunque
  no vuelvan a iniciar sesión, con su propia salvaguarda ante bajas masivas
  (`users.access_recheck_blocked`).
- **`access_revoked_at` en cada petición:** una cuenta sin acceso recibe 401
  al momento, sin esperar a que caduque la caché de la cookie de sesión.
- **El token solo va a la Intranet:** un `NUXT_ROLE_API_URL` en otro origen
  que `NUXT_INTRANET_API_URL` se llama sin token.
- **Confirmación con recuentos:** confirmar una desactivación grande del
  listado vale solo para lo que se enseñó (`confirmedKinds`).
- **Aviso en el idioma de quien entra:** un inicio de sesión rechazado
  vuelve a `/login` o `/en/login` (`errorCallbackURL`).

Pendientes:

- **Áreas ejecutivas por `id`:** las cuentas CEA se siguen enlazando por
  siglas (fase 2, punto 1).

## 10. Fase 2 (opcional): menos datos a mano

Cada punto quita trabajo manual en la plataforma; los marcados con (P)
necesitan además cambios en la plataforma.

1. **Áreas ejecutivas (P).** Hoy la plataforma crea un área por cada cuenta
   CEA, con las siglas como nombre, y Administración la renombra a mano.
   `executive_areas` no tiene siglas. Propuesta:
   - `GET /api/asambleas/v1/areas-ejecutivas`: áreas del mandato vigente con
     `id`, `name` (es), `order` y sus cuentas CEA
     (`[{ "id", "initials", "designation", "place": "responsible" | "member" }]`);
   - en `user/role`, para cuentas CEA:
     `"executive_area": { "id": 3, "name": "Secretaría General" } | null`;
   - opcional, una columna `acronym` en `executive_areas` curada por
     Administración, si se quiere seguir enlazando por siglas.

   Tener en cuenta que las siglas de una cuenta CEA se recalculan del nombre de
   Google en cada acceso a la Intranet: el `id` es la clave estable.

2. **Derechos de cada miembro (P).** `rights_data` ya guarda por cuenta los
   derechos en la Asamblea General. Exponerlos en los listados y en
   `user/role` con nombres limpios (y sin la errata de la columna):

   ```json
   "rights": {
     "assembly_attendance": true,
     "assembly_voice": true,
     "assembly_vote": true,
     "amendment_submission": true,
     "motion_submission": true,
     "resolution_submission": true,
     "agenda_point_request": true
   }
   ```

   Origen: `ga_assistance`, `ga_intervention`, `ga_voting`,
   `ammendment_submission`, `motion_submission`, `resolution_submission` y
   `point_request`. La plataforma podría impedir presentar enmiendas o pedir
   puntos a quien no tenga el derecho, sin listas manuales.

3. **Estado activo o inactivo.** Hoy se deduce de estar en la lista: un consejo
   que pasa a `Desasociado` deja de aparecer y la plataforma lo desactiva. Es
   correcto y no hace falta más. Si se quiere explícito, un campo
   `status: "active"` y que el listado incluya los `Desasociado` con
   `status: "left"`; en ese caso la plataforma tendría que leerlo antes.

4. **Aviso de cambios (P).** Mejor que un endpoint de diferencias
   (`?updated_since=`), que necesitaría registrar bajas y cambios de tipo, y
   con listas de un centenar de filas no compensa:
   - un webhook de la Intranet a la plataforma cuando cambie una cuenta
     `Asociado`, `Sectorial` o `CEA` (tipo, siglas, denominación, universidad,
     derechos), **sin datos personales**: solo
     `{"event": "members.changed", "at": "..."}`, firmado con HMAC-SHA256 en
     una cabecera (`X-Intranet-Signature`) con un secreto distinto del token y
     con marca de tiempo para evitar reenvíos;
   - la plataforma, al recibirlo, vuelve a pedir el listado completo con su
     token; la sincronización diaria que ya hace (sección 1) cubre los avisos
     que se pierdan.

5. **Calidad de datos en la Intranet.** Validar en la edición de cuentas
   (`AdminController`) que las cuentas `Asociado`, `Sectorial` y `CEA` tienen
   siglas, de como mucho 20 caracteres y únicas entre los tres tipos (la
   plataforma descarta filas sin siglas y, si se repiten, se queda con la
   primera), y denominación. Si se quiere nombre largo y corto para los
   consejos, un campo nuevo (por ejemplo `official_name`); hoy la plataforma
   usa `designation`.

Los roles protegidos de la plataforma (`Admin`, `Secretaria`, `Presidencia`,
`Moderador`) se siguen asignando en la plataforma a propósito; no hace falta
exponer los roles internos de la Intranet.

## 11. Endurecer la suplantación de la Intranet

No afecta a la integración, pero salió al diseñar la suplantación de la
plataforma (ver `design.md`, "Impersonation"), que sí tiene estas medidas. La
Intranet permite a un administrador entrar como otro usuario
(`AdminController::startImpersonation` y `stopImpersonation`, rutas
`/administrar/impersonar` y `/administrar/impersonar/salir`). Tal como está:

- **Permite suplantar a otros administradores.** Solo rechaza suplantarse a uno
  mismo. Un administrador puede actuar como otro y sus actos quedan a nombre de
  ese otro.
- **No caduca.** La suplantación dura lo que dure la sesión de Laravel.
- **No deja rastro.** No se registra quién empezó, cuándo ni qué se hizo
  mientras tanto; todo queda a nombre de la cuenta suplantada.
- **Salir es un `GET` sin CSRF.** Cualquier enlace o imagen en otra web puede
  sacar a un administrador de la suplantación (molesto más que grave, pero un
  cambio de estado nunca debe ir por `GET`).
- **No vuelve a comprobar que quien suplanta siga siendo administrador.** Si
  pierde el rol en mitad, sigue actuando como la otra cuenta.
- **Solo lo indica el menú del avatar.** No hay un aviso fijo en todas las
  páginas, así que es fácil olvidar que se está actuando como otra persona.

Cambios propuestos:

1. Rechazar como destino a cualquier usuario con el rol `Administrador`
   (403).
2. Guardar en sesión el inicio y una caducidad fija (por ejemplo 60 minutos) y
   comprobarla en un middleware del grupo `auth`: al vencer, volver a la cuenta
   del administrador y avisar.
3. Pedir un motivo corto al empezar y registrar en una tabla propia
   (`impersonations`: administrador, usuario, motivo, inicio, fin, motivo de
   fin, IP, user agent) el inicio y el fin. Añadir el id de suplantación a los
   registros de actividad que ya haya mientras dure.
4. Convertir la salida en `POST` con `@csrf`.
5. En ese mismo middleware, comprobar en cada petición que el
   `impersonator_id` sigue teniendo el rol `Administrador`; si no, cerrar la
   suplantación.
6. Mostrar un aviso fijo en la cabecera de todas las páginas ("Estás actuando
   como X · Volver a mi cuenta") mientras dure.
7. Tests: no se puede suplantar a un administrador, caduca, la salida exige
   `POST` y CSRF, y queda registro de inicio y fin.

## 12. Checklist

Intranet, fase 1 (`28d4579`, desplegado; y `0e1badf`, que elimina la ruta vieja y la segunda ranura, pendiente de desplegar):

- [x] `config/services.php` (`assemblies`) y `.env.example` con el hash, la
      lista de IP y el interruptor de HTTPS, y `TRUSTED_PROXIES`
      (`config/trustedproxy.php`); interruptor estricto (en blanco o mal
      escrito queda en `true`).
- [x] `AuthenticateAssembliesService` registrado como `assemblies.service` en
      `Kernel::$routeMiddleware`; compara el token antes de mirar el bloqueo,
      y un token válido pasa siempre. Tras 10 tokens erróneos por minuto e IP,
      los siguientes erróneos reciben 429.
- [x] `Handler::shouldReturnJson` devuelve JSON para `api/asambleas/*` (405 y
      429 incluidos).
- [x] Limitador `assemblies-api` en `RouteServiceProvider` (por token, con el
      hash completo, y ruta; por IP).
- [x] Grupo `asambleas/v1` en `routes/api.php` con `withoutMiddleware('throttle:api')`.
- [x] `AssemblyRoleLookupRequest`, `AssembliesApiController`,
      `AssemblyAccountResource`, `AssemblyMemberResource`.
- [x] Listados completos, sin paginar, con 5xx ante cualquier error; 404
      idéntico para email desconocido y cuenta sin tipo.
- [x] `Cache-Control: no-store` puesto por el middleware en toda respuesta
      que pasa por él (datos y errores del controlador incluidos).
- [x] Un solo hash, validado como 64 caracteres hexadecimales; si no es
      válido, 503.
- [x] `config/cors.php` con rutas públicas explícitas; el grupo de la
      plataforma fuera.
- [x] Ruta vieja `POST /api/user/role` y
      `AdminController::getUserRoleByEmail` eliminadas.
- [x] Logs sin token, sin hash completo y sin emails en claro.
- [x] `TrustProxies` solo con `TRUSTED_PROXIES` (`config/trustedproxy.php`:
      la dirección de nginx o el rango de su red de Docker; sin ella, nadie;
      nunca `*` ni `REMOTE_ADDR`) y solo `X-Forwarded-For` y
      `X-Forwarded-Proto`.
- [x] `AssembliesApiTest` (sección 6) y la suite completa en verde con
      `composer test`; Pint en verde.

Despliegue:

- [x] Primer push de la Intranet con `28d4579`, `c7e584f` y `e57094b`.
- [x] Token generado con el formato `asm_` y guardado en el gestor de
      contraseñas (sección 7, paso 1).
- [x] `env_file` de la Intranet (`config/intranet/.env`) con
      `LOG_LEVEL=info`, `TRUSTED_PROXIES=172.18.0.0/16` y una sola línea con
      el hash del token.
- [x] Desplegado con `scripts/deploy.sh`; `trustedproxy.proxies`,
      `LOG_LEVEL` y el hash cargados; 401 sin token y la ruta vieja en 404.
- [ ] Desplegado `0e1badf`, que elimina la ruta vieja y la segunda ranura;
      quitadas `ASSEMBLIES_API_LEGACY_ROLE_ROUTE` y
      `ASSEMBLIES_API_TOKEN_SHA256_NEXT` del `env_file`.
- [ ] Desde fuera, con el token: 404 para un email desconocido, número de
      asociados y sin `trace`; `assemblies_api.denied` con la IP pública
      propia.
- [ ] La web pública sigue mostrando los consejos y las sectoriales.
- [x] Siglas sin duplicados entre asociados y entre sectoriales (paso 2): la
      primera sincronización desde el servidor de desarrollo (2026-11-06) no
      dio ningún conflicto de siglas.
- [x] Servidor de desarrollo de la plataforma con
      `NUXT_INTRANET_API_URL=https://intranet.creup.es/api/asambleas/v1`, el
      token y sin `NUXT_ROLE_API_URL` (2026-11-06: consulta de rol `ok` con
      `id` y listado de 40 asociados y 20 sectoriales).
- [ ] Plataforma en producción, cuando se despliegue: la versión que enlaza
      por `id` y sus migraciones, `NUXT_INTRANET_API_URL` (pública o
      `http://intranet/api/asambleas/v1`), `NUXT_INTRANET_API_TOKEN` y sin
      `NUXT_ROLE_API_URL`, con el contenedor recreado.
- [ ] Inicio de sesión Asociado y CEA correcto; sincronización del listado sin
      desactivaciones inesperadas.
- [ ] Cuentas sin acceso revisadas en Administración > Usuarios tras el
      primer día.
- [ ] Rotación anual apuntada en el calendario de TIC.

Recomendado (sección 5.8):

- [x] `proxy_set_header X-Forwarded-For $remote_addr;` en el vhost de la
      Intranet.
- [ ] Cloudflare en modo SSL/TLS Full (strict).
- [ ] nginx con dirección fija y `TRUSTED_PROXIES` solo con ella.
- [ ] 80/443 del VPS solo desde Cloudflare, tras comprobar que todos los
      dominios que sirve ese nginx pasan por el proxy de Cloudflare.

Opcional:

- [ ] `GET /api/user` eliminada o con campos cerrados.
- [ ] Fase 2 priorizada con producto (áreas ejecutivas, derechos, aviso de
      cambios, calidad de siglas).
