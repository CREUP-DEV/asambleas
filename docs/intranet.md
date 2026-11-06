# Integración con la Intranet de CREUP

Qué tiene que implementar la Intranet (Laravel, `CREUP/Intranet`) para que la
plataforma de asambleas no necesite datos que la Intranet ya tiene, y cómo
proteger esos endpoints. Está escrito para quien decide (producto) y para quien
lo implementa en Laravel. Los identificadores de código van en inglés.

## Resumen

- La plataforma llama hoy a tres endpoints de la Intranet: `POST /api/user/role`
  en cada inicio de sesión y `GET /api/usuarios/asociados` y
  `GET /api/usuarios/sectoriales` cuando alguien pulsa "Sincronizar" en
  Miembros.
- `POST /api/user/role` es **público**: cualquiera que conozca un email sabe si
  tiene cuenta en la Intranet, su tipo, su nombre, sus siglas y su universidad.
  Es el problema principal.
- Los dos listados son públicos **a propósito**: los consume la web pública
  (`creup/web`, `server/utils/public/publicMembers.ts`). No hay que cerrarlos;
  hay que dejar de depender de ellos.
- Propuesta: un grupo nuevo y privado, `/api/asambleas/v1`, con las mismas tres
  rutas relativas (`user/role`, `usuarios/asociados`, `usuarios/sectoriales`),
  token de servicio obligatorio, límite de peticiones propio, sin CORS y con
  solo los campos que la plataforma lee. La plataforma no cambia código: solo
  variables de entorno.
- Requisito previo: en producción la cadena es Cloudflare → contenedor nginx
  (`proxy_pass`) → Apache en el contenedor `intranet`. nginx tiene que
  recuperar la IP real que le pasa Cloudflare y sobrescribir las cabeceras
  `X-Forwarded-*`, y `TrustProxies` (hoy `'*'`) tiene que confiar solo en
  nginx. Sin eso, Laravel ve la IP del borde de Cloudflare o una inventada, y
  los límites por IP, la lista de IP y la comprobación de HTTPS no sirven (R6,
  sección 5.8). Hay que revisarlo en el VPS y en Cloudflare.
- Estado: la fase 1 está implementada en la Intranet (commit `eb92083` de
  `master`). Ni él ni los dos commits que tiene debajo están publicados. Antes
  de publicarla hay que añadir las correcciones de este documento que el
  commit no incluye y decidir qué commits salen con ella (sección 8).
- Despliegue en tres pasos (1, 2 y 4 de la sección 8): Intranet con el grupo
  nuevo (la ruta pública vieja sigue viva), cambio de variables en la
  plataforma, cierre de la ruta vieja.
  Las variables de la Intranet se aplican recreando su contenedor, nunca con
  `config:cache` (sección 5.1).
- Fase 2 opcional: id estable, áreas ejecutivas, derechos de cada miembro y
  aviso de cambios, para que la plataforma deje de pedir a mano lo que la
  Intranet ya sabe.

## 1. Qué usa hoy la plataforma

### Variables de entorno

| Variable                  | Uso                                                                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NUXT_INTRANET_API_URL`   | Base de la API. La plataforma le añade `user/role`, `usuarios/asociados` y `usuarios/sectoriales`. Acepta `https:` y `http:`; sin ella no hay sincronización del listado.                |
| `NUXT_INTRANET_API_TOKEN` | Si tiene valor, cada llamada lleva `Authorization: Bearer <token>`. Un valor en blanco cuenta como ausente. Nunca se registra en logs (`intranetAuthHeaders`).                           |
| `NUXT_ROLE_API_URL`       | URL completa de la consulta de rol. **Tiene prioridad sobre la base**: si está definida, la consulta de rol va ahí aunque `NUXT_INTRANET_API_URL` apunte a otro sitio (`getRoleApiUrl`). |

El `.env` de producción de `DEPLOYMENT.md` fija hoy
`NUXT_ROLE_API_URL=https://intranet.creup.es/api/user/role` y no define
`NUXT_INTRANET_API_URL` ni `NUXT_INTRANET_API_TOKEN` (si producción sigue esa
plantilla, "Sincronizar" en Miembros responde 503 "no está configurada").
`.env.example` solo trae un marcador (`https://example.com/api/user/role`). Al
migrar hay que quitar `NUXT_ROLE_API_URL` o cambiarla (ver el despliegue).

### Consulta de rol (`server/utils/auth/roleSync.ts`)

- **Cuándo:** al crearse cada sesión (cada inicio de sesión con Google), en el
  hook `databaseHooks.session.create.after` de `server/utils/auth/auth.ts`.
  Un fallo nunca bloquea el acceso.
- **Petición:** `POST`, cuerpo `{"email": "<email de Google>"}`, cabeceras
  `Content-Type: application/json` y el token si existe. **No envía
  `Accept: application/json`.** Tiempo máximo: 10 s.
- **Respuesta que acepta (Zod):** un objeto JSON con
  - `role`: string no vacío tras `trim` (el `users.type` de la Intranet). Se
    compara literalmente, distinguiendo mayúsculas: solo `Asociado`, `CEA` y
    `Sectorial` tienen efecto; `asociado` o `ASOCIADO` contarían como
    cualquier otro tipo;
  - `name`, `initials`, `university`: string, `null` o ausente (un string
    vacío cuenta como `null`). Un número u otro tipo invalida la respuesta
    entera.

  Ignora cualquier otra clave, así que añadir campos es compatible.

- **Qué hace con ella:** guarda `externalRole`, `externalName`,
  `externalInitials`, `university` y `lastRoleSyncAt`, y decide el rol:
  - `Asociado` da el rol `Asociado`; `CEA` da `CEA`; cualquier otro tipo
    (`Sectorial`, `Invitado`, `Desasociado`, `CdG`, `CAI`, `Otros`) da
    `Invitado`.
  - Enlaza la cuenta con su miembro por `initials`: `Asociado` con su consejo,
    `Sectorial` con su sectorial y `CEA` con un área ejecutiva (que crea, con
    las siglas como nombre, si no existe).
  - `Admin`, `Secretaria`, `Presidencia` y `Moderador` nunca cambian por la
    sincronización.
- **Si falla** (cualquier respuesta no 2xx, JSON inválido, `role` ausente o
  vacío, tiempo agotado): registra un aviso; una cuenta nueva queda como
  `Invitado` y sin miembro, y en una existente **no cambia ni el rol, ni el
  miembro, ni los datos externos**; solo se escribe `lastRoleSyncAt`, que por
  eso no indica la última consulta con éxito. `fetch` sigue las redirecciones:
  un 302 a una página HTML acaba en "JSON inválido". Por eso un 404 para un email
  desconocido es seguro y un 200 con un rol inventado no lo sería (degradaría a
  un Asociado o CEA y le quitaría su miembro).

### Sincronización del listado (`server/utils/members/sync.ts`, `roster.ts`)

- **Cuándo:** a mano, con `POST /api/members/sync` (permiso `member:manage`,
  botón en Miembros). No hay sincronización periódica.
- **Petición:** `GET {base}/usuarios/asociados` y
  `GET {base}/usuarios/sectoriales` en paralelo, con
  `Accept: application/json` y el token si existe. 10 s cada una.
- **Respuesta que acepta:** `{ "data": Entry[], "generated_at"?: string | null }`
  con como mucho 5000 filas. Cada `Entry` es un objeto que puede traer
  `denomination`, `initials`, `university` y `autonomous_community` (string,
  número, `null` o ausente) y `order` (**solo número**, `null` o ausente: un
  `order` en texto invalida la lista entera). Ignora el resto de claves.
- **Qué hace:**
  - sin `NUXT_INTRANET_API_URL` responde 503 sin llamar a nada;
  - las dos listas se piden antes de escribir nada y, si cualquiera falla, no
    se toca la base de datos (502);
  - colapsa espacios y empareja por `initials` sin distinguir mayúsculas,
    recortadas a 20 caracteres; el nombre es `denomination` (o las siglas si
    falta), recortado a 200, igual que `university` y `autonomous_community`;
  - descarta filas sin `initials`; si unas siglas se repiten, gana la primera
    (asociados antes que sectoriales);
  - nunca toca miembros creados a mano (las áreas ejecutivas que crea la
    consulta de rol son manuales);
  - reactiva los miembros de origen Intranet que vuelven a aparecer y
    **desactiva todo miembro de origen Intranet que no aparezca en la lista**;
  - deja constancia en `audit_log` (`members.sync`).

La última regla es la que hace peligrosa cualquier respuesta parcial: una
primera página de una lista paginada, o un `200` con `data: []` tras un error
interno, desactivaría miembros en bloque.

## 2. Estado actual en la Intranet

| Ruta                            | Controlador                                 | Autenticación | Límite                                      | CORS | Devuelve                                                                                                                                                                                   | Quién la usa                    |
| ------------------------------- | ------------------------------------------- | ------------- | ------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `POST /api/user/role`           | `AdminController@getUserRoleByEmail`        | Ninguna       | `throttle:api`: 60/min por IP (no hay user) | `*`  | `{ role: users.type, name, initials, university }`, o 404 `{"error":"Usuario no encontrado"}`. Valida en línea con `$request->validate(['email' => 'required\|email'])`.                   | Solo la plataforma de asambleas |
| `GET /api/usuarios/asociados`   | `Api\OrganizationApiController@asociados`   | Ninguna       | El mismo                                    | `*`  | `order`, `denomination` (`users.designation`), `initials`, `university`, `autonomous_community`, `description`, `web_logo_light`, `web_logo_dark`, `social_networks` (con `contact_email`) | Web pública y plataforma        |
| `GET /api/usuarios/sectoriales` | `Api\OrganizationApiController@sectoriales` | Ninguna       | El mismo                                    | `*`  | Igual que asociados, sin `university` ni `autonomous_community`                                                                                                                            | Web pública y plataforma        |
| `GET /api/user`                 | Closure con `auth:sanctum`                  | Sanctum       | El mismo                                    | `*`  | El modelo `User` entero (salvo `password` y `remember_token`)                                                                                                                              | Nadie: no se emite ningún token |

Esta sección describe lo que hay hoy en producción. La fase 1 (secciones de la
4 a la 6) está implementada en el commit `eb92083` de `master` de la Intranet,
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
  figura, no añade otras). `eb92083` lo cambia por loopback y los rangos
  privados, sin tocar las cabeceras. Ver R6.
- Topología de producción:
  - `intranet.creup.es` está detrás de Cloudflare: resuelve a direcciones de
    Cloudflare (A `104.21.24.128` y `172.67.218.236`, AAAA en
    `2606:4700::/32`) y responde con `Server: cloudflare` y `CF-RAY`.
  - En el VPS, un contenedor `nginx` publica 80 y 443 (ejemplo de
    `docker-compose.yml` en el `README.md` de la Intranet) y, como la imagen
    solo sirve HTTP en el 80, pasa las peticiones por `proxy_pass` al
    servicio `intranet`. Que nginx termine TLS no está confirmado: el ejemplo
    monta `/etc/letsencrypt`, pero la copia vieja del vhost en `CREUP/VPS`
    solo escucha en el 80, con el certificado comentado, y así solo funciona
    con Cloudflare en modo Flexible (sección 5.8, punto 2).
  - La imagen de la Intranet es `php:8.4-apache`: Apache escucha solo en el
    80, sin TLS. Tiene `mod_remoteip` activo pero sin `RemoteIPHeader`, así
    que `REMOTE_ADDR` es quien abre la conexión: nginx, en la red de Docker.
  - Las variables llegan por el `env_file` del servicio `intranet`
    (`intranet.env` en el ejemplo); la imagen no lleva `.env`.
  - El vhost de nginx de producción no está en ningún repositorio.
    `docker/nginx/default.conf` de la Intranet (FastCGI a `intranet:9000`) es
    un resto de desarrollo que no corresponde a esta imagen, y la copia de
    `CREUP/VPS` (noviembre de 2025, PHP-FPM por FastCGI, `9001:9000`
    publicado) está desactualizada.
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

| #   | Riesgo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Impacto                                                                                                                     | Gravedad                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| R1  | `POST /api/user/role` responde a cualquiera: confirma si un email tiene cuenta y devuelve tipo, nombre, siglas y universidad. Cualquier persona que haya entrado alguna vez con su Google personal está en `users` (como `Invitado`) con su nombre real.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Revelación de datos personales (RGPD) y de quién pertenece a qué órgano.                                                    | Alta                                                               |
| R2  | Enumeración: 60 consultas/min por IP sin más control; con varias IP no hay techo. Con CORS `*` cualquier web puede hacer que los navegadores de sus visitantes consulten la ruta y lean la respuesta, repartiendo el límite entre miles de IP.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Barrido masivo de emails.                                                                                                   | Alta                                                               |
| R3  | El límite `throttle:api` (60/min por IP) es compartido: toda la plataforma sale por una sola IP. Al abrirse una sesión entran muchas personas a la vez; pasadas 60 en un minuto, la Intranet responde 429.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Cuentas nuevas quedan como `Invitado`, las existentes con datos viejos; una sincronización del listado en ese minuto falla. | Media                                                              |
| R4  | La consulta de rol de la plataforma no envía `Accept: application/json`. Un error de validación en Laravel responde con una redirección 302 a HTML; `fetch` la sigue y la plataforma ve "respuesta inválida".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Fallos enmascarados y difíciles de diagnosticar.                                                                            | Baja                                                               |
| R5  | La plataforma depende de listados con forma de web pública (logos, redes, `contact_email`, orden de la web). Si la web pide paginar o renombrar campos, la plataforma se rompe; si se pagina, **desactiva en silencio** a los miembros de las páginas siguientes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Acoplamiento con otro producto y datos de más.                                                                              | Media                                                              |
| R6  | Las cabeceras de proxy no son fiables. En producción la cadena es Cloudflare → nginx → Apache por `proxy_pass`, así que Laravel siempre ve a nginx como quien abre la conexión, y `TrustProxies::$proxies = '*'` le cree todo `X-Forwarded-*`. Si nginx no recupera la IP real de Cloudflare, `ip()` es la IP del borde de Cloudflare para todo el mundo: el límite por IP se reparte entre todos los que salen por el mismo borde y una lista de IP con la de la plataforma respondería 403 a todas sus llamadas. Si nginx añade a lo que manda el cliente (`$proxy_add_x_forwarded_for`) o no fija las cabeceras, cualquiera elige su IP, su esquema y su host. Si el origen acepta conexiones que no vienen de Cloudflare (80/443 abiertos a todos, IPv6 incluida) o el contenedor `intranet` publica su puerto, se puede hablar con nginx o con Apache directamente. El cambio de `eb92083` (loopback y rangos privados) cierra el acceso directo desde fuera, pero confía también en la pasarela de Docker y en los contenedores vecinos. | Anula todas las medidas por IP; con Cloudflare en modo Flexible, el token viaja en claro entre Cloudflare y el VPS.         | Alta (a confirmar con la configuración real de nginx y Cloudflare) |
| R7  | `GET /api/user` devuelve el modelo `User` entero a quien tenga un token Sanctum. Hoy no se emite ninguno, pero si algún día se emite, expone `google_id`, email y todas las columnas visibles.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Exposición futura.                                                                                                          | Baja                                                               |

## 4. Diseño propuesto

### 4.1 Un grupo privado: `/api/asambleas/v1`

Tres rutas nuevas, con las mismas rutas relativas que la plataforma ya usa:

| Método | Ruta                                     | Sustituye a (para la plataforma) |
| ------ | ---------------------------------------- | -------------------------------- |
| `POST` | `/api/asambleas/v1/user/role`            | `POST /api/user/role`            |
| `GET`  | `/api/asambleas/v1/usuarios/asociados`   | `GET /api/usuarios/asociados`    |
| `GET`  | `/api/asambleas/v1/usuarios/sectoriales` | `GET /api/usuarios/sectoriales`  |

Con `NUXT_INTRANET_API_URL=https://intranet.creup.es/api/asambleas/v1` la
plataforma llama a las rutas nuevas sin cambiar código. Los listados públicos
de la web se quedan como están. La ruta pública `POST /api/user/role` se
mantiene solo durante la transición y después se cierra (solo la usa esta
plataforma).

Todo el grupo:

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
- Dos ranuras, `ASSEMBLIES_API_TOKEN_SHA256` y
  `ASSEMBLIES_API_TOKEN_SHA256_NEXT`, para rotar sin cortes (sección 7).
- Comparación en tiempo constante con `hash_equals`, recorriendo todas las
  ranuras sin salir antes.
- Solo en la cabecera `Authorization: Bearer`. Nunca en la query string (acaba
  en logs de acceso) ni en el cuerpo.
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
| 403    | Petición no HTTPS con HTTPS exigido, o IP fuera de la lista permitida                                                                   | `{"error": "forbidden"}`                                               |                            |
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
disponible": no cambia el rol, el miembro ni los datos externos de las cuentas
existentes (solo `lastRoleSyncAt`) y no escribe el listado.

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
| `id`         | integer         | `users.id`         | Nuevo. La plataforma lo ignora hoy; servirá para enlazar por id y no por siglas (fase 2).                                                                                   |
| `role`       | string no vacío | `users.type`       | Valores actuales: `Asociado`, `Desasociado`, `Invitado`, `Sectorial`, `CEA`, `CdG`, `CAI`, `Otros`. Tal cual, con estas mayúsculas: la plataforma los compara literalmente. |
| `name`       | string \| null  | `users.name`       | Lo que ya devuelve hoy.                                                                                                                                                     |
| `initials`   | string \| null  | `users.initials`   | Como mucho 20 caracteres útiles: la plataforma recorta a 20 y empareja por ellas.                                                                                           |
| `university` | string \| null  | `users.university` |                                                                                                                                                                             |

No se devuelve nada más: ni email, ni `google_id`, ni teléfono, ni datos
personales de `personal_data`.

Errores: 404 `{"error": "not_found"}` si no hay cuenta con ese email **o** si
la cuenta tiene `type` nulo o vacío (mismo cuerpo, misma cabecera). 422 si el
email no es válido. El resto, según la tabla común.

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

| Campo                  | Tipo           | Origen                       |
| ---------------------- | -------------- | ---------------------------- |
| `id`                   | integer        | `users.id` (nuevo)           |
| `denomination`         | string \| null | `users.designation`          |
| `initials`             | string \| null | `users.initials`             |
| `university`           | string \| null | `users.university`           |
| `autonomous_community` | string \| null | `users.autonomous_community` |
| `generated_at`         | string ISO8601 | Momento de la respuesta      |

Reglas:

- **Lista completa, sin paginación**, en una sola respuesta. No usar
  `paginate()`: la plataforma solo lee `data` y desactivaría lo que no venga.
  Hoy son del orden de un centenar de filas; el cliente admite hasta 5000.
- Orden estable (`initials`, `id`); la plataforma no usa el orden y no hace
  falta `order`.
- Sin `description`, logos ni `social_networks`: eso es para la web.
- Ante cualquier fallo, error 5xx. Nunca `200` con `data: []` por un error.
- Sin respuestas condicionales (ETag/304): la plataforma trata un 304 como
  fallo.

#### `GET /api/asambleas/v1/usuarios/sectoriales`

Igual que asociados, con `users.type = 'Sectorial'`. `university` y
`autonomous_community` van siempre a `null` (como hoy en la ruta pública, que
no las envía): para las cuentas sectoriales ese dato no es fiable.

### 4.4 Medidas de seguridad

| Medida                 | Cómo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token dedicado         | Middleware `AuthenticateAssembliesService` en todo el grupo; hash SHA-256 en configuración, dos ranuras, `hash_equals`, solo cabecera `Authorization`; token con prefijo `asm_` para que no se confunda con un hash.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Proxies de confianza   | **Requisito previo** de todas las medidas por IP y de la comprobación de HTTPS (R6, sección 5.8). nginx recupera la IP real de Cloudflare (`real_ip_header CF-Connecting-IP` con todos sus rangos) y sobrescribe `X-Forwarded-For`, `-Proto`, `-Host` y `-Port`. `TrustProxies` confía solo en la dirección fija de nginx (`TRUSTED_PROXIES`; sin ella, en nadie) y solo acepta `X-Forwarded-For` y `X-Forwarded-Proto`.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Lista de IP (opcional) | `ASSEMBLIES_API_ALLOWED_IPS` con la IP con la que Laravel ve a la plataforma (admite CIDR, `IpUtils::checkIp`). No poner "la IP de salida" de memoria: copiar el `ip` que registra `assemblies_api.denied` tras la primera llamada sin token del paso 1 (sección 8), y solo cuando sea la IP pública real del servidor de la plataforma, no una de Cloudflare ni una privada `172.x`. Si ese servidor tiene IPv4 e IPv6, puede llegar por cualquiera de las dos: poner las dos. Si la plataforma corre en el mismo VPS y llama al nombre público, sale por Cloudflare y vuelve con la IP pública del VPS. Solo sirve con la sección 5.8 hecha.                                                                                                                                                                                                                            |
| Solo HTTPS             | `ASSEMBLIES_API_REQUIRE_HTTPS=true`: el middleware responde 403 a peticiones no seguras (`$request->secure()`), y con eso una URL mal configurada falla a la vista en vez de funcionar en claro. Apache no termina TLS, así que Laravel solo sabe que la petición es HTTPS por el `X-Forwarded-Proto` que fija nginx (`$scheme`), y solo porque nginx es proxy de confianza. Cloudflare tiene que estar en modo SSL **Full (strict)**: en Flexible llega al origen por HTTP, el token cruza internet en claro, `$scheme` es `http` y cada llamada recibe 403. HSTS en nginx. Si el token llegó a viajar por `http`, rotarlo. Excepción, solo si aplica: si la plataforma corre en el mismo VPS y llama por una red Docker interna que no sale del servidor, se puede desactivar HTTPS **y** limitar las IP a la dirección fija de la plataforma en esa red (sección 5.8). |
| Límite de peticiones   | Sin `throttle:api`. Limitador `assemblies-api`: 300/min por token en `user/role`, 30/min por token en cada listado, 600/min por IP. La clave por token usa el hash completo, nunca la huella de 8 caracteres que sale en los logs. El token se compara primero y un token válido pasa siempre; tras 10 tokens erróneos en un minuto desde una IP, los siguientes tokens erróneos reciben 429 en vez de 401 y dejan de escribir `assemblies_api.denied`. No protege de fuerza bruta (un token de 256 bits no se adivina): solo limita el ruido en los logs. El límite de 600/min por IP corre antes de la autenticación y cuenta también las peticiones sin token.                                                                                                                                                                                                         |
| Campos mínimos         | Recursos dedicados (`AssemblyAccountResource`, `AssemblyMemberResource`) con lista cerrada de claves. Sin emails, teléfonos, redes ni logos.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Sin enumeración        | Sin token, 401 idéntico para cualquier email (no se consulta la base de datos). Con token, 404 idéntico para email desconocido y cuenta sin tipo. CORS cerrado: ningún navegador puede leer el grupo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Logs sin secretos      | Nunca la cabecera `Authorization`, el token ni el hash completo; como huella, los 8 primeros caracteres del hash. Nunca el email en claro: HMAC con `APP_KEY`, truncado. No registrar cuerpos de petición. `LOG_LEVEL=info` exactamente durante la transición: `role_lookup` y `roster` se registran en `info` y `legacy_role_lookup` en `notice`, y las secciones 7 y 8 los leen. Con `notice` faltan los dos primeros, y con `warning` o más alto, los tres.                                                                                                                                                                                                                                                                                                                                                                                                            |
| Rotación               | Procedimiento de la sección 7, con dos ranuras: ningún token válido se rechaza durante el cambio. Cada cambio de variables recrea el contenedor de la Intranet (sección 5.1), que deja de responder unos segundos.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| CORS cerrado           | `config/cors.php` deja de usar `api/*` y lista solo las rutas públicas. El grupo `api/asambleas/*` queda fuera: sin `Access-Control-Allow-Origin`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Validación             | `FormRequest` (`AssemblyRoleLookupRequest`) con normalización previa; JSON forzado para que un error sea 422 y no una redirección.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Falla cerrado          | Sin hash configurado, 503. Un error interno, 5xx y nunca datos parciales. `APP_DEBUG=false`, comprobado en el contenedor antes de poner el hash (sección 8, paso 1): con `APP_DEBUG=true` cualquiera obtiene la traza completa de un error, también sin token. Interruptores booleanos estrictos: un valor en blanco o mal escrito deja el valor seguro por defecto.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Tests                  | Sección 6.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## 5. Implementación en Laravel

Bocetos pensados para la estructura actual de la Intranet (Laravel 13 con
`Kernel` y `RouteServiceProvider` clásicos). Ajustar nombres al estilo del
repositorio y pasar Pint.

### 5.1 Configuración

`config/services.php`:

```php
'assemblies' => [
    // SHA-256 (hex) of the tokens the assemblies platform may present. Two
    // slots so a rotation never needs downtime. The token itself never
    // lives in the Intranet.
    // Anything that is not 64 hex characters (a pasted token, which starts
    // with "asm_", or a truncated hash) is dropped, so a slot set by mistake
    // fails closed (503 when no slot is left) instead of quietly answering
    // 401.
    'token_hashes' => array_values(array_filter(
        array_map(
            fn ($hash) => strtolower(trim((string) $hash)),
            [env('ASSEMBLIES_API_TOKEN_SHA256'), env('ASSEMBLIES_API_TOKEN_SHA256_NEXT')],
        ),
        fn (string $hash) => preg_match('/^[0-9a-f]{64}$/', $hash) === 1,
    )),

    // Optional allow-list (IPs or CIDR ranges), comma separated.
    'allowed_ips' => array_values(array_filter(array_map(
        'trim',
        explode(',', (string) env('ASSEMBLIES_API_ALLOWED_IPS', '')),
    ))),

    // Both switches default to true and only the word false (which env()
    // turns into a boolean) turns them off. A blank value, "off", "0" or a
    // typo keeps the default instead of being cast: (bool) '' would quietly
    // turn the HTTPS check off or close the old route, and
    // FILTER_VALIDATE_BOOL also reads '' as false.
    'require_https' => env('ASSEMBLIES_API_REQUIRE_HTTPS') !== false,

    // Keeps the old public POST /api/user/role answering during the
    // transition window. Turn off once the platform uses /api/asambleas/v1.
    'legacy_role_route' => env('ASSEMBLIES_API_LEGACY_ROLE_ROUTE') !== false,
],
```

`.env.example`:

```dotenv
# Private API for the assemblies platform (/api/asambleas/v1)
# SHA-256 hex of the token, never the token itself (asm_...):
# printf %s "$TOKEN" | sha256sum
ASSEMBLIES_API_TOKEN_SHA256=
ASSEMBLIES_API_TOKEN_SHA256_NEXT=
ASSEMBLIES_API_ALLOWED_IPS=
# Only the word false turns a switch off; blank or anything else keeps true
ASSEMBLIES_API_REQUIRE_HTTPS=true
ASSEMBLIES_API_LEGACY_ROLE_ROUTE=true

# Fixed address of the nginx container (comma separated); empty trusts nobody
TRUSTED_PROXIES=
```

`TRUSTED_PROXIES` la lee `config/trustedproxy.php` (sección 5.8).

**Aplicar un cambio de estas variables en producción.** La imagen no lleva
`.env` (`.dockerignore` lo excluye): las variables llegan al contenedor
`intranet` por el `env_file` de su servicio en el `docker-compose.yml` del VPS
(`intranet.env` en el ejemplo del `README.md` de la Intranet; comprobar el
nombre real). Docker las fija al **crear** el contenedor, y al arrancar
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

3. Comprobar lo que ha cargado (el recuento, nunca los hashes):

   ```bash
   docker compose exec -T intranet php artisan tinker --execute="dump(count(config('services.assemblies.token_hashes')), config('services.assemblies.allowed_ips'), config('services.assemblies.require_https'), config('services.assemblies.legacy_role_route'), config('trustedproxy.proxies'))"
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

        if ($config['token_hashes'] === []) {
            Log::critical('assemblies_api.not_configured');

            return $this->noStore(response()->json(['error' => 'service_unavailable'], 503));
        }

        // The token is compared first and a valid one always passes: the
        // failure counter is never read for it, so nobody sharing an address
        // with the platform can lock it out by sending bad tokens.
        if ($this->matches((string) $request->bearerToken(), $config['token_hashes'])) {
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

    /**
     * Whether the presented token hashes to one of the configured slots.
     * Every slot is compared, so timing does not tell which one matched.
     *
     * @param  array<int, string>  $hashes
     */
    private function matches(string $presented, array $hashes): bool
    {
        if ($presented === '') {
            return false;
        }

        $candidate = hash('sha256', $presented);
        $matched = false;
        foreach ($hashes as $hash) {
            $matched = hash_equals($hash, $candidate) || $matched;
        }

        return $matched;
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
que `assemblies.service` (sección 5.3); como la consulta de rol no envía
`Accept`, saldrían en HTML. Para que todo el grupo responda JSON sin depender
del orden, en `app/Exceptions/Handler.php`:

```php
/**
 * The private API for the assemblies platform always answers JSON, also for
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

// Private API for the assemblies platform. Server to server only: service
// token, its own rate limit (not the shared 60/min of the api group) and no
// CORS (see config/cors.php).
Route::prefix('asambleas/v1')
    ->name('api.asambleas.')
    ->withoutMiddleware('throttle:api')
    ->middleware(['assemblies.service', 'throttle:assemblies-api'])
    ->group(function () {
        Route::post('user/role', [AssembliesApiController::class, 'role'])->name('role');
        Route::get('usuarios/asociados', [AssembliesApiController::class, 'asociados'])->name('asociados');
        Route::get('usuarios/sectoriales', [AssembliesApiController::class, 'sectoriales'])->name('sectoriales');
    });

// Old public lookup: answers only during the transition window
// (services.assemblies.legacy_role_route), then 404. Remove afterwards.
Route::post('/user/role', [AdminController::class, 'getUserRoleByEmail']);
```

En `AdminController::getUserRoleByEmail`, al principio:

```php
abort_unless(config('services.assemblies.legacy_role_route'), 404);

Log::notice('assemblies_api.legacy_role_lookup', ['ip' => $request->ip()]);
```

El interruptor se lee en tiempo de petición (no al cargar rutas), así que no
depende de `route:cache` y se puede probar.

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
    // Public endpoints. The private api/asambleas/* group and the old
    // api/user/role are left out on purpose: no browser may read them.
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
se compara desde el inicio de la ruta. Este cambio ya corta el riesgo R2 sobre
la ruta vieja desde el primer despliegue (la plataforma llama desde el
servidor y no le afecta).

### 5.8 Otros ajustes en la Intranet

**Cadena de proxies (R6), antes del paso 1 del despliegue.** La cadena es
Cloudflare → contenedor `nginx` → Apache por `proxy_pass` (sección 2).
El vhost de producción no está en ningún repositorio: revisarlo en el VPS
(`docker compose exec -T nginx nginx -T`). Laravel solo ve la dirección real
del visitante y el esquema si se cumplen los cinco puntos siguientes.

1. **nginx recupera la IP real de Cloudflare y sobrescribe las cabeceras.** En
   el `server` de la Intranet:

   ```nginx
   # Real visitor address. One line per range Cloudflare publishes, IPv4 and
   # IPv6 (https://www.cloudflare.com/ips/); the list changes now and then.
   set_real_ip_from 173.245.48.0/20;
   set_real_ip_from 2400:cb00::/32;
   # ...every other range
   real_ip_header CF-Connecting-IP;

   location / {
       proxy_pass http://intranet:80;
       proxy_set_header Host $host;
       # Overwrite, never append: $proxy_add_x_forwarded_for would keep
       # whatever the client sent in front of the real address.
       proxy_set_header X-Forwarded-For $remote_addr;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_set_header X-Forwarded-Host $host;
       proxy_set_header X-Forwarded-Port $server_port;
   }
   ```

   `real_ip_header` solo cambia `$remote_addr` cuando la conexión llega desde
   un rango de Cloudflare; quien conecte directamente con un `CF-Connecting-IP`
   inventado se queda con su propia dirección. Nada de
   `$proxy_add_x_forwarded_for` en este vhost. Comprobar en el log de acceso de
   nginx (`docker compose logs --tail 20 nginx` con el log por defecto de la
   imagen oficial, o el archivo que fije `access_log` en el vhost) que, tras
   cargar una página, aparece la IP propia y no una de Cloudflare ni una
   `172.x.0.1`.

2. **Cloudflare en modo SSL/TLS Full (strict)**, con un certificado válido en
   el origen (el de Let's Encrypt que monta el ejemplo del `README.md`, o uno
   de origen de Cloudflare). En Flexible, Cloudflare llega al origen por HTTP:
   el token cruza internet en claro, `$scheme` es `http` y cada llamada de la
   plataforma recibe 403. Mirar el modo antes que nada: la copia vieja del
   vhost en `CREUP/VPS` solo escucha en el 80, con el certificado comentado,
   y así solo funciona en Flexible.

3. **El origen solo acepta a Cloudflare.** Los puertos 80 y 443 del VPS se
   abren solo a los rangos de Cloudflare, IPv4 **e IPv6**, con el cortafuegos
   del proveedor o con reglas en la cadena `DOCKER-USER` (`ufw` no filtra los
   puertos que publica Docker). Opcional: Authenticated Origin Pulls.
   Comprobar desde una máquina de fuera que no responde (código `000` tras el
   tiempo máximo):

   ```bash
   curl -m 10 -sk -o /dev/null -w '%{http_code}\n' \
     --resolve intranet.creup.es:443:<IPv4 del VPS> https://intranet.creup.es/
   curl -m 10 -sk -o /dev/null -w '%{http_code}\n' \
     --resolve 'intranet.creup.es:443:[<IPv6 del VPS>]' https://intranet.creup.es/
   ```

4. **El contenedor `intranet` no publica ningún puerto** (sin `ports:` en su
   servicio, como en el ejemplo): `docker compose ps intranet` muestra `80/tcp`
   sin dirección del host. Apache solo es accesible desde la red de Docker. No
   configurar `RemoteIPHeader` en Apache: Laravel tiene que seguir viendo a
   nginx como quien abre la conexión.

5. **`TrustProxies` confía solo en nginx, y solo para la dirección y el
   esquema.** `eb92083` cambia `'*'` por loopback y los rangos privados
   (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`). Funciona
   detrás de nginx, pero también confía en la pasarela de cada red de Docker
   (por la que entra, por ejemplo, el tráfico IPv6 que reenvía `docker-proxy`)
   y en cualquier contenedor vecino (`mariadb`, phpMyAdmin...), que puede
   llamar a `intranet:80` directamente y declarar cualquier IP o HTTPS. Y
   sigue aceptando `X-Forwarded-Host` y `X-Forwarded-Port`. Recomendado:
   - nginx con una dirección fija en una red propia, `edge`, que sea la única
     que comparte con la Intranet, para que llegue siempre desde esa
     dirección. nginx sigue en `default` para lo demás que sirva; la Intranet
     sale de `default` y habla con la base de datos por otra red, `db`. En el
     `docker-compose.yml` del VPS:

     ```yaml
     services:
       nginx:
         networks:
           default: {} # other services it proxies
           edge:
             ipv4_address: 172.30.0.10
       intranet:
         networks: [edge, db] # not on default
       mariadb:
         networks: [db]
     networks:
       edge:
         ipam:
           config:
             - subnet: 172.30.0.0/24 # any free subnet
       db: {}
     ```

     Dejar `edge` sin IPv6 (como viene por defecto) o fijar también
     `ipv6_address` y añadirla a la lista. Cualquier otro servicio que use la
     base de datos (phpMyAdmin, por ejemplo) tiene que unirse a `db`.

     Aplicarlo **antes del paso 1, por separado** y fuera de horas punta:
     desde el directorio de compose, `docker compose up -d`, que recrea nginx,
     la Intranet y la base de datos con la imagen ya desplegada (la que fija
     el `.env` de ese directorio; comprobarlo antes como en la sección 5.1,
     paso 2). Esa imagen confía en `'*'`, así que la red
     nueva no le cambia nada. Se cortan unos segundos todos los sitios que
     sirve nginx; después, comprobar que la Intranet carga.
     `scripts/deploy.sh` no sirve para esto: solo recrea `intranet`, así que
     nginx no entraría en `edge` y dejaría de llegar a ella.

   - `TRUSTED_PROXIES=172.30.0.10` en el `env_file` de la Intranet, leída de
     la configuración. `config/trustedproxy.php`:

     ```php
     <?php

     return [
         // The nginx container's fixed address, the only peer allowed to vouch
         // for the client's IP and scheme. Comma separated, blank entries
         // dropped. Unset trusts nobody (fails closed). Never '*'.
         'proxies' => array_values(array_filter(array_map(
             'trim',
             explode(',', (string) env('TRUSTED_PROXIES', '')),
         ))),
     ];
     ```

     `app/Http/Middleware/TrustProxies.php`, sin la lista de `$proxies`:

     ```php
     /** Only what nginx overwrites: the client's address and the scheme. */
     protected $headers = Request::HEADER_X_FORWARDED_FOR | Request::HEADER_X_FORWARDED_PROTO;

     /** The nginx container only (config/trustedproxy.php). */
     protected function proxies()
     {
         return config('trustedproxy.proxies');
     }
     ```

   - Sin `TRUSTED_PROXIES`, Laravel no confía en nadie: la API responde 403
     `https_required` (falla cerrado; el paso 1 lo detecta) y el resto de la
     Intranet ve a todos los visitantes con la dirección de nginx, así que los
     límites por IP (los 60/min de `throttle:api` incluidos) se comparten
     entre todos. Por eso `TRUSTED_PROXIES` entra en el `env_file` con el
     despliegue del paso 1, el del código que la lee, cuando la red fija ya
     existe.
   - `X-Forwarded-Host` y `-Port` dejan de leerse. `URL::forceRootUrl` en
     `AppServiceProvider` ya fija las URL que genera la Intranet; esto cubre
     además lo que se lee de la petición (`$request->url()`, `fullUrl()`, las
     rutas del paginador).
   - Los tests de la sección 6 fijan `trustedproxy.proxies` y comprueban que
     nginx acredita HTTPS y que nadie más lo hace, para que un cambio de
     `TrustProxies` (por ejemplo, a `null`) no deje a la plataforma en 403 con
     la suite en verde.

**Si la plataforma corre en el mismo VPS**, puede llamar por una red Docker
interna sin pasar por Cloudflare: unir su contenedor a `edge` con dirección
fija (por ejemplo `172.30.0.20`; en su compose, `edge` como red `external`
con el nombre completo que le da Compose, `<proyecto>_edge`),
usar `NUXT_INTRANET_API_URL=http://intranet/api/asambleas/v1` y poner en la
Intranet `ASSEMBLIES_API_REQUIRE_HTTPS=false` **y**
`ASSEMBLIES_API_ALLOWED_IPS=172.30.0.20`. La plataforma no es proxy de
confianza, así que Laravel ve su dirección real, y el token no sale del
servidor. Es la excepción de la sección 4.4. Si no, la plataforma llama al
nombre público como cualquier otro cliente.

Otros ajustes:

- **`GET /api/user` (R7):** eliminarla si no la usa nadie (no se emite ningún
  token Sanctum). Si se mantiene, devolver un recurso con campos cerrados.
- **Producción:** `APP_DEBUG=false`, comprobado con
  `docker compose exec -T intranet php artisan config:show app.debug` después
  de recrear el contenedor y antes de poner el hash del token (sección 8, paso
  1). `LOG_LEVEL=info` exactamente durante la transición (sección 4.4),
  comprobado con `config:show logging.channels.single.level` (el canal por
  defecto, `stack`, escribe en `single`).

## 6. Tests (PHPUnit)

`tests/Feature/Api/AssembliesApiTest.php`, en el estilo del repositorio
(PHPUnit 13, `RefreshDatabase`, `#[DataProvider]`, métodos `test_...`):

```php
<?php

namespace Tests\Feature\Api;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Request;
use Illuminate\Log\Events\MessageLogged;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Route;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

/**
 * The private API for the assemblies platform: service token on every route,
 * its own rate limit, no CORS, only the fields the platform reads, and logs
 * that never carry the token or an email.
 */
class AssembliesApiTest extends TestCase
{
    use RefreshDatabase;

    // Same shape as real tokens (section 7): "asm_" and base64url.
    private const TOKEN = 'asm_current-token-for-the-tests-0123456789abcdef';

    private const NEXT_TOKEN = 'asm_next-token-for-the-tests-0123456789abcdefgh';

    /** The nginx container's fixed address (section 5.8). */
    private const NGINX = '172.30.0.10';

    protected function setUp(): void
    {
        parent::setUp();

        config([
            'services.assemblies.token_hashes' => [hash('sha256', self::TOKEN), hash('sha256', self::NEXT_TOKEN)],
            'services.assemblies.allowed_ips' => [],
            'services.assemblies.require_https' => false,
            'services.assemblies.legacy_role_route' => true,
        ]);
    }

    /** @return array<string, array{string, string}> */
    public static function routes(): array
    {
        return [
            'role' => ['POST', '/api/asambleas/v1/user/role'],
            'asociados' => ['GET', '/api/asambleas/v1/usuarios/asociados'],
            'sectoriales' => ['GET', '/api/asambleas/v1/usuarios/sectoriales'],
        ];
    }

    #[DataProvider('routes')]
    public function test_every_route_refuses_a_missing_or_wrong_token_the_same_way(string $method, string $uri): void
    {
        User::factory()->create(['email' => 'cdeub@ub.edu', 'type' => 'Asociado']);

        foreach ([[], $this->auth('wrong-token')] as $headers) {
            $this->json($method, $uri, ['email' => 'cdeub@ub.edu'], $headers)
                ->assertStatus(401)
                ->assertHeader('WWW-Authenticate', 'Bearer')
                ->assertExactJson(['error' => 'unauthorized']);
        }
    }

    #[DataProvider('routes')]
    public function test_a_token_in_the_query_string_is_not_accepted(string $method, string $uri): void
    {
        $this->json($method, $uri.'?token='.self::TOKEN, ['email' => 'x@example.com'])->assertStatus(401);
    }

    #[DataProvider('routes')]
    public function test_the_api_fails_closed_without_a_configured_token(string $method, string $uri): void
    {
        config(['services.assemblies.token_hashes' => []]);

        $this->json($method, $uri, ['email' => 'x@example.com'], $this->auth())->assertStatus(503);
    }

    public function test_both_rotation_slots_are_accepted(): void
    {
        foreach ([self::TOKEN, self::NEXT_TOKEN] as $token) {
            $this->getJson('/api/asambleas/v1/usuarios/asociados', $this->auth($token))->assertOk();
        }
    }

    public function test_the_role_lookup_returns_only_what_the_platform_reads(): void
    {
        $user = User::factory()->create([
            'email' => 'cdeub@ub.edu',
            'type' => 'Asociado',
            'name' => 'Consell de l\'Estudiantat UB',
            'initials' => 'CdEUB',
            'university' => 'Universitat de Barcelona',
        ]);

        $response = $this->postJson('/api/asambleas/v1/user/role', ['email' => '  CdEUB@UB.edu '], $this->auth())
            ->assertOk()
            ->assertExactJson([
                'id' => $user->id,
                'role' => 'Asociado',
                'name' => 'Consell de l\'Estudiantat UB',
                'initials' => 'CdEUB',
                'university' => 'Universitat de Barcelona',
            ]);

        $this->assertStringContainsString('no-store', (string) $response->headers->get('Cache-Control'));
    }

    public function test_an_unknown_email_and_an_account_without_type_answer_the_same_404(): void
    {
        User::factory()->create(['email' => 'sin-tipo@example.com', 'type' => null]);

        foreach (['nadie@example.com', 'sin-tipo@example.com'] as $email) {
            $this->postJson('/api/asambleas/v1/user/role', ['email' => $email], $this->auth())
                ->assertNotFound()
                ->assertExactJson(['error' => 'not_found']);
        }
    }

    public function test_an_invalid_email_is_a_json_422_even_without_an_accept_header(): void
    {
        // The platform's role call sends Content-Type but no Accept.
        $this->call('POST', '/api/asambleas/v1/user/role', [], [], [], [
            'CONTENT_TYPE' => 'application/json',
            'HTTP_AUTHORIZATION' => 'Bearer '.self::TOKEN,
        ], json_encode(['email' => 'no-es-un-email']))
            ->assertStatus(422)
            ->assertJsonValidationErrors('email');
    }

    public function test_a_wrong_method_is_answered_in_json_without_an_accept_header(): void
    {
        // Raised while resolving the route, before the service middleware.
        $response = $this->call('GET', '/api/asambleas/v1/user/role', [], [], [], [
            'HTTP_AUTHORIZATION' => 'Bearer '.self::TOKEN,
        ]);

        $response->assertStatus(405);
        $this->assertStringContainsString('application/json', (string) $response->headers->get('Content-Type'));
    }

    public function test_a_rate_limit_answer_is_json_without_an_accept_header(): void
    {
        for ($i = 0; $i < 30; $i++) {
            $this->getJson('/api/asambleas/v1/usuarios/asociados', $this->auth())->assertOk();
        }

        // Raised by ThrottleRequests, before the service middleware forces JSON.
        $response = $this->call('GET', '/api/asambleas/v1/usuarios/asociados', [], [], [], [
            'HTTP_AUTHORIZATION' => 'Bearer '.self::TOKEN,
        ]);

        $response->assertStatus(429)->assertHeader('Retry-After');
        $this->assertStringContainsString('application/json', (string) $response->headers->get('Content-Type'));
    }

    public function test_the_asociados_roster_is_complete_minimal_and_unpaginated(): void
    {
        User::factory()->create(['type' => 'Asociado', 'initials' => 'CdEUB', 'designation' => 'CdEUB',
            'university' => 'Universitat de Barcelona', 'autonomous_community' => 'Cataluña']);
        User::factory()->create(['type' => 'Desasociado', 'initials' => 'OLD']);
        User::factory()->create(['type' => 'Sectorial', 'initials' => 'CEEM']);

        $response = $this->getJson('/api/asambleas/v1/usuarios/asociados', $this->auth())->assertOk();

        $this->assertSame(['data', 'generated_at'], array_keys($response->json()));
        $this->assertSame(['CdEUB'], array_column($response->json('data'), 'initials'));
        $this->assertSame(
            ['id', 'denomination', 'initials', 'university', 'autonomous_community'],
            array_keys($response->json('data.0')),
        );
    }

    public function test_the_sectoriales_roster_never_sends_a_university(): void
    {
        User::factory()->create(['type' => 'Sectorial', 'initials' => 'CEEM', 'university' => 'Ruido de Google']);

        $this->getJson('/api/asambleas/v1/usuarios/sectoriales', $this->auth())
            ->assertOk()
            ->assertJsonPath('data.0.initials', 'CEEM')
            ->assertJsonPath('data.0.university', null);
    }

    public function test_the_shared_api_limit_does_not_apply(): void
    {
        // More than the api group's 60/min, within the role lookup's 300/min.
        User::factory()->create(['email' => 'cdeub@ub.edu', 'type' => 'Asociado']);

        for ($i = 0; $i < 70; $i++) {
            $this->postJson('/api/asambleas/v1/user/role', ['email' => 'cdeub@ub.edu'], $this->auth())->assertOk();
        }
    }

    public function test_each_roster_has_its_own_budget_per_token(): void
    {
        for ($i = 0; $i < 30; $i++) {
            $this->getJson('/api/asambleas/v1/usuarios/asociados', $this->auth())->assertOk();
        }

        $this->getJson('/api/asambleas/v1/usuarios/asociados', $this->auth())->assertStatus(429);
        $this->getJson('/api/asambleas/v1/usuarios/sectoriales', $this->auth())->assertOk();
    }

    public function test_repeated_bad_tokens_get_429_but_a_valid_token_still_passes(): void
    {
        for ($i = 0; $i < 10; $i++) {
            $this->getJson('/api/asambleas/v1/usuarios/asociados', $this->auth('wrong'))->assertStatus(401);
        }

        $this->getJson('/api/asambleas/v1/usuarios/asociados', $this->auth('wrong'))
            ->assertStatus(429)
            ->assertHeader('Retry-After');

        // Same address: whoever shares it with the platform cannot lock it out.
        $this->getJson('/api/asambleas/v1/usuarios/asociados', $this->auth())->assertOk();
    }

    public function test_the_ip_allow_list_is_enforced_when_set(): void
    {
        config(['services.assemblies.allowed_ips' => ['10.0.0.0/8']]);

        $this->getJson('/api/asambleas/v1/usuarios/asociados', $this->auth())->assertForbidden();
        $this->withServerVariables(['REMOTE_ADDR' => '10.1.2.3'])
            ->getJson('/api/asambleas/v1/usuarios/asociados', $this->auth())
            ->assertOk();
    }

    public function test_plain_http_is_refused_when_https_is_required(): void
    {
        config(['services.assemblies.require_https' => true]);

        $this->getJson('http://localhost/api/asambleas/v1/usuarios/asociados', $this->auth())->assertForbidden();
        $this->getJson('https://localhost/api/asambleas/v1/usuarios/asociados', $this->auth())->assertOk();
    }

    public function test_only_the_nginx_peer_vouches_for_https(): void
    {
        // Production: Cloudflare (Full strict), nginx (TLS), then Apache over
        // plain HTTP. The URL stays http:// so only X-Forwarded-Proto can make
        // it secure.
        config([
            'trustedproxy.proxies' => [self::NGINX],
            'services.assemblies.require_https' => true,
        ]);
        $uri = 'http://localhost/api/asambleas/v1/usuarios/asociados';
        $headers = $this->auth() + ['X-Forwarded-Proto' => 'https'];

        $this->withServerVariables(['REMOTE_ADDR' => self::NGINX])->getJson($uri, $headers)->assertOk();

        // The Docker gateway, a neighbour container, a public client.
        foreach (['172.30.0.1', '172.30.0.20', '203.0.113.7'] as $peer) {
            $this->withServerVariables(['REMOTE_ADDR' => $peer])->getJson($uri, $headers)->assertForbidden();
        }
    }

    public function test_a_forged_first_forwarded_address_never_wins(): void
    {
        config([
            'trustedproxy.proxies' => [self::NGINX],
            'services.assemblies.allowed_ips' => ['6.6.6.6'],
        ]);
        $uri = '/api/asambleas/v1/usuarios/asociados';

        // nginx overwrites X-Forwarded-For; were it ever to append, the
        // rightmost untrusted hop (here the gateway) is the client, not
        // whatever the client wrote first.
        $this->withServerVariables(['REMOTE_ADDR' => self::NGINX])
            ->getJson($uri, $this->auth() + ['X-Forwarded-For' => '6.6.6.6, 172.30.0.1'])
            ->assertForbidden();
        $this->withServerVariables(['REMOTE_ADDR' => self::NGINX])
            ->getJson($uri, $this->auth() + ['X-Forwarded-For' => '6.6.6.6'])
            ->assertOk();
    }

    public function test_a_forwarded_host_is_ignored_even_from_nginx(): void
    {
        config(['trustedproxy.proxies' => [self::NGINX]]);
        Route::get('/_probe/host', fn (Request $request) => $request->getHttpHost());

        $this->withServerVariables(['REMOTE_ADDR' => self::NGINX])
            ->get('/_probe/host', ['X-Forwarded-Host' => 'evil.example', 'X-Forwarded-Port' => '8443'])
            ->assertOk()
            ->assertDontSee('evil.example')
            ->assertDontSee('8443');
    }

    public function test_the_config_keeps_only_well_formed_hashes_and_strict_switches(): void
    {
        $vars = [
            // A pasted token and a truncated hash are dropped: 503, not 401.
            'ASSEMBLIES_API_TOKEN_SHA256' => self::TOKEN,
            'ASSEMBLIES_API_TOKEN_SHA256_NEXT' => substr(hash('sha256', self::TOKEN), 0, 63),
            // A blank switch keeps its default instead of turning off.
            'ASSEMBLIES_API_REQUIRE_HTTPS' => '',
            'ASSEMBLIES_API_LEGACY_ROLE_ROUTE' => '',
        ];

        try {
            foreach ($vars as $key => $value) {
                $_SERVER[$key] = $_ENV[$key] = $value;
            }
            $config = (require config_path('services.php'))['assemblies'];
            $this->assertSame([], $config['token_hashes']);
            $this->assertTrue($config['require_https']);
            $this->assertTrue($config['legacy_role_route']);

            // A hash with stray spaces or capitals is normalised and kept.
            $_SERVER['ASSEMBLIES_API_TOKEN_SHA256'] = $_ENV['ASSEMBLIES_API_TOKEN_SHA256']
                = ' '.strtoupper(hash('sha256', self::TOKEN));
            $config = (require config_path('services.php'))['assemblies'];
            $this->assertSame([hash('sha256', self::TOKEN)], $config['token_hashes']);
        } finally {
            foreach (array_keys($vars) as $key) {
                unset($_SERVER[$key], $_ENV[$key]);
            }
        }
    }

    /** @return array<string, array{string}> */
    public static function privateRoutes(): array
    {
        return [
            'role lookup' => ['/api/asambleas/v1/user/role'],
            'legacy role lookup' => ['/api/user/role'],
        ];
    }

    #[DataProvider('privateRoutes')]
    public function test_no_browser_origin_is_allowed(string $uri): void
    {
        $this->call('OPTIONS', $uri, [], [], [], [
            'HTTP_ORIGIN' => 'https://evil.example',
            'HTTP_ACCESS_CONTROL_REQUEST_METHOD' => 'POST',
        ])->assertHeaderMissing('Access-Control-Allow-Origin');
    }

    public function test_the_public_listings_stay_readable_by_browsers(): void
    {
        // The website reads these from the visitor's browser.
        $this->call('OPTIONS', '/api/usuarios/asociados', [], [], [], [
            'HTTP_ORIGIN' => 'https://creup.es',
            'HTTP_ACCESS_CONTROL_REQUEST_METHOD' => 'GET',
        ])->assertHeader('Access-Control-Allow-Origin', '*');
    }

    public function test_logs_never_carry_the_token_or_the_email(): void
    {
        $logged = [];
        Event::listen(MessageLogged::class, function (MessageLogged $event) use (&$logged) {
            $logged[] = $event->message.' '.json_encode($event->context);
        });
        User::factory()->create(['email' => 'cdeub@ub.edu', 'type' => 'Asociado']);

        $this->postJson('/api/asambleas/v1/user/role', ['email' => 'cdeub@ub.edu'], $this->auth());
        $this->postJson('/api/asambleas/v1/user/role', ['email' => 'cdeub@ub.edu'], $this->auth('wrong'));

        $this->assertNotEmpty($logged);
        foreach ($logged as $line) {
            $this->assertStringNotContainsString(self::TOKEN, $line);
            $this->assertStringNotContainsString(hash('sha256', self::TOKEN), $line);
            $this->assertStringNotContainsString('cdeub@ub.edu', $line);
        }
    }

    public function test_the_legacy_route_answers_as_before_until_its_switch_closes_it(): void
    {
        User::factory()->create(['email' => 'cdeub@ub.edu', 'type' => 'Asociado', 'name' => 'CdEUB',
            'initials' => 'CdEUB', 'university' => 'Universitat de Barcelona']);

        // Exactly what the platform in production reads today.
        $this->postJson('/api/user/role', ['email' => 'cdeub@ub.edu'])
            ->assertOk()
            ->assertExactJson(['role' => 'Asociado', 'name' => 'CdEUB', 'initials' => 'CdEUB',
                'university' => 'Universitat de Barcelona']);
        $this->postJson('/api/user/role', ['email' => 'nadie@example.com'])
            ->assertNotFound()
            ->assertExactJson(['error' => 'Usuario no encontrado']);

        config(['services.assemblies.legacy_role_route' => false]);
        $this->postJson('/api/user/role', ['email' => 'cdeub@ub.edu'])->assertNotFound();
    }

    /** @return array<string, string> */
    private function auth(string $token = self::TOKEN): array
    {
        return ['Authorization' => 'Bearer '.$token];
    }
}
```

Notas:

- `users.type` es nullable desde la migración inicial, así que la cuenta sin
  tipo se crea tal cual.
- `UserFactory` no fija `type`, así que cada test lo da explícitamente.
- Los límites viven en la caché. `config/cache.php` lee `CACHE_DRIVER`, que
  `phpunit.xml` fija a `array` (el `CACHE_STORE=array` de `.env.testing` no lo
  lee nadie); esa caché empieza vacía en cada test, así que los contadores no
  se arrastran de un test a otro.
- Los tests de proxies fijan `trustedproxy.proxies` en vez de depender de la
  lista que tenga `TrustProxies`; `NGINX` es la dirección de ejemplo de la
  sección 5.8. La URL `http://` del test de nginx es a propósito: con
  `https://` la petición sería segura por la variable `HTTPS` del servidor,
  sin pasar por `X-Forwarded-Proto`.
- El test de configuración carga `config/services.php` con variables de
  entorno reales, porque el resto fija la configuración ya calculada y no
  vería el filtro de 64 caracteres hexadecimales ni los interruptores.
- Al cerrar la ventana de transición y borrar la ruta vieja, sustituir el
  último test por uno que compruebe que `POST /api/user/role` da 404.

## 7. Rotación del token

Cuándo: una vez al año, en cada relevo de la persona responsable de TIC y de
inmediato ante cualquier sospecha de filtración.

1. Generar el token nuevo y su hash sin dejarlo en el historial de la shell:

   ```bash
   T="asm_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
   printf %s "$T" | sha256sum | cut -d' ' -f1   # hash for the Intranet
   printf %s "$T"                               # copy to the password manager, then: unset T
   ```

   El token sale con 47 caracteres (`asm_` y 43 de base64url). El prefijo
   evita confundirlo con su hash, que son 64 caracteres hexadecimales: si se
   pega el token en la Intranet por error, la ranura se descarta (sección
   5.1).

2. Intranet: poner el hash nuevo en `ASSEMBLIES_API_TOKEN_SHA256_NEXT` y
   aplicarlo recreando el contenedor (sección 5.1, "Aplicar un cambio";
   `config:cache` no basta). La comprobación con `tinker` da 2 hashes. Ahora
   valen los dos.
3. Plataforma: poner el token nuevo en `NUXT_INTRANET_API_TOKEN` y recrear el
   contenedor (`docker compose -f docker-compose.prod.yml up -d app`, con el
   compose de `DEPLOYMENT.md`; `restart` no relee el `.env`).
4. Comprobar en los logs de la Intranet (`assemblies_api.role_lookup`) que la
   huella `token` coincide con los 8 primeros caracteres del hash nuevo, y que
   un inicio de sesión y una sincronización del listado funcionan.
5. Intranet: mover el hash nuevo a `ASSEMBLIES_API_TOKEN_SHA256`, vaciar
   `_NEXT` y aplicarlo igual (sección 5.1). La comprobación con `tinker` da 1
   hash. Solo entonces deja de valer el token viejo: mientras el contenedor no
   se recrea, la configuración cargada sigue aceptándolo.
6. Borrar el token viejo del gestor de contraseñas.

Ante una filtración, saltar directamente a sustituir
`ASSEMBLIES_API_TOKEN_SHA256` (vaciando `_NEXT`) y el token de la plataforma,
lo más seguidos posible, y aplicar los dos recreando sus contenedores (sección
5.1 en la Intranet). El token filtrado sigue valiendo hasta que se recrea el
contenedor de la Intranet: confirmar con `tinker` que solo queda 1 hash.
Mientras la plataforma siga con el token viejo:

- los accesos siguen funcionando, pero no se refresca el rol: las cuentas
  nuevas entran como `Invitado` y sin miembro hasta su siguiente inicio de
  sesión, y "Sincronizar" en Miembros da 502;
- sus consultas reciben 401, y 429 a partir de la undécima en un minuto, pero
  pasan en cuanto envía el token nuevo: el bloqueo solo afecta a tokens
  erróneos, así que no hay que esperar ni borrar contadores.

Dónde vive el token: en el `.env` de producción de la plataforma y en el gestor
de contraseñas de TIC. Nunca en repositorios, correos ni chats. La Intranet
solo guarda el hash.

## 8. Despliegue

Hacerlo fuera de una semana de asamblea.

**Antes del primer push de la Intranet.** El código de la fase 1 es el commit
`eb92083` de `master` en la Intranet. No está publicado, y entre él y
`origin/master` (`2f0b417`) hay otros dos commits sin publicar: `e57094b`
(exportación de tesorería) y `c7e584f` (portafirmas). `scripts/deploy.sh`
exige que `HEAD` coincida con `origin/master` (salvo `--skip-push-check`) y
construye la imagen con el árbol de trabajo, así que hacer push de `master` y
desplegar publica los tres. Decidirlo antes del primer push:

- o salen los tres juntos, si portafirmas y tesorería están listos;
- o sale solo la API: `eb92083` no comparte archivos con los otros dos, así
  que se puede reordenar para que quede justo encima de `2f0b417`, publicar
  solo ese commit (`git push origin <sha>:master`) y desplegar desde él (con
  ese commit en `HEAD` y el árbol limpio; desde `master`, con los otros dos
  encima, `deploy.sh` se niega).

`eb92083` sigue el diseño anterior a la revisión y **no incluye** estas
correcciones del documento, que hay que añadir antes (en el mismo commit, que
aún no está publicado, o en uno siguiente):

- el token se compara antes que el bloqueo por tokens erróneos (sección 5.2);
- la clave por token del limitador usa el hash completo (sección 5.3);
- interruptores booleanos estrictos y el comentario del filtro de hashes
  coherente con el formato `asm_` (sección 5.1);
- `TrustProxies` solo con la dirección fija de nginx (`TRUSTED_PROXIES`) y
  solo `X-Forwarded-For` y `X-Forwarded-Proto` (sección 5.8);
- los tests de la sección 6: los que faltan, y dos que cambian.
  `test_repeated_bad_tokens_lock_the_ip_out_for_a_minute` exige hoy que un
  token válido reciba 429 y pasa a ser
  `test_repeated_bad_tokens_get_429_but_a_valid_token_still_passes`;
  `test_the_legacy_route_closes_with_its_switch` pasa a ser
  `test_the_legacy_route_answers_as_before_until_its_switch_closes_it`, con
  el JSON exacto de la ruta vieja.
  `test_a_client_reaching_the_app_directly_cannot_claim_https` queda cubierto
  por `test_only_the_nginx_peer_vouches_for_https`.

Además, `eb92083` cambia la Intranet entera, no solo la API: CORS pasa de
`api/*` a una lista de rutas y `TrustProxies` deja de ser `'*'`. Tras
desplegar, comprobar que la web pública sigue leyendo los listados y que el
log de acceso de nginx muestra IP reales.

**Paso 0. Preparar.** Generar el token (sección 7, paso 1) y guardarlo en el
gestor de contraseñas.

**Paso 1. Intranet: grupo nuevo con token obligatorio; la ruta vieja sigue.**

1. Requisito previo: la sección 5.8 hecha y comprobada (nginx con la IP real
   de Cloudflare y las cabeceras sobrescritas, Cloudflare en Full (strict),
   80/443 solo desde Cloudflare con IPv6 incluida, contenedor `intranet` sin
   puertos publicados, red `edge` con la dirección fija de nginx, aplicada
   por separado). Sin eso, el
   límite por IP y la lista de IP ven la IP del borde de Cloudflare o una
   inventada, y la comprobación de HTTPS puede rechazar todo o creerse
   cualquier cosa.
2. En el `env_file` del servicio `intranet` (sección 5.1):
   `APP_DEBUG=false`, `LOG_LEVEL=info`, `TRUSTED_PROXIES=<dirección de nginx>`,
   `ASSEMBLIES_API_LEGACY_ROLE_ROUTE=true`, `ASSEMBLIES_API_REQUIRE_HTTPS=true`,
   `ASSEMBLIES_API_ALLOWED_IPS` vacía de momento y **sin** hash de token
   todavía.
3. Desplegar con `scripts/deploy.sh` (recrea el contenedor y recarga nginx).
   Sin hash, el grupo nuevo responde 503 a todo: el hash es la llave que lo
   abre.
4. Antes de poner el hash, comprobar en el contenedor lo que ha cargado:

   ```bash
   docker compose exec -T intranet php artisan config:show app.debug                    # false
   docker compose exec -T intranet php artisan config:show logging.channels.single.level  # info
   ```

   Con `APP_DEBUG=true`, cualquiera obtiene la traza completa de un error
   (también de un 405 sin token, y un error de base de datos incluye la
   consulta con el email). Desde fuera,
   `curl -s https://intranet.creup.es/api/asambleas/v1/user/role | jq 'has("trace")'`
   tiene que dar `false`.

5. Poner `ASSEMBLIES_API_TOKEN_SHA256=<hash>` en el `env_file` y aplicarlo
   (sección 5.1). La comprobación con `tinker` da 1 hash.

Después:

- La ruta pública `POST /api/user/role` sigue respondiendo (ya sin CORS) y
  registra cada uso como `assemblies_api.legacy_role_lookup`. La plataforma
  ya envía el token a la ruta vieja si lo tiene; eso es inocuo.
- Comprobar desde el servidor de la plataforma (con el token en una variable
  leída con `read -rs TOKEN`, no escrito en la línea de órdenes):

  ```bash
  B=https://intranet.creup.es/api/asambleas/v1
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "$B/user/role" \
    -H 'Content-Type: application/json' -d '{"email":"nadie@example.com"}'   # 401
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "$B/user/role" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' -d '{"email":"nadie@example.com"}'   # 404
  curl -s "$B/usuarios/asociados" -H "Authorization: Bearer $TOKEN" | jq '.data | length'
  ```

- Si la primera llamada da 403 en vez de 401, mirar quién responde:
  - Cuerpo HTML, cabecera `cf-ray` y nada en los logs de la Intranet: es
    Cloudflare (WAF, Bot Fight Mode o un desafío a un cliente sin navegador).
    Añadir en Cloudflare una excepción para `/api/asambleas/` desde el
    servidor de la plataforma.
  - `{"error": "forbidden"}` con `assemblies_api.denied` y `reason`
    `https_required`: Laravel no ve la petición como HTTPS
    (`ASSEMBLIES_API_REQUIRE_HTTPS` está activo por defecto). Apache no
    termina TLS, así que `$request->secure()` sale solo del
    `X-Forwarded-Proto` de nginx: o Cloudflare está en Flexible (`$scheme` es
    `http`), o nginx no fija la cabecera, o su dirección no está en
    `TRUSTED_PROXIES` (sección 5.8).
  - `reason` `ip_not_allowed`: la lista de IP (siguiente punto).

  Corregirlo antes de seguir: si no, cada consulta de rol de la plataforma
  recibiría 403 y fallaría sin aviso visible.

- La primera llamada deja en los logs de la Intranet un
  `assemblies_api.denied` con el `ip` con el que Laravel ve al servidor de la
  plataforma. **No poner lista de IP hasta que ese `ip` sea la IP pública
  real de ese servidor** (`curl -s https://www.cloudflare.com/cdn-cgi/trace`
  en él la muestra en `ip=`). Si es una dirección de Cloudflare o una privada
  `172.x`, nginx no está recuperando la IP real (sección 5.8, punto 1), y la
  lista dejaría fuera a la plataforma. Cuando coincida, ponerla en
  `ASSEMBLIES_API_ALLOWED_IPS` (las dos si el servidor tiene IPv4 e IPv6),
  aplicarlo (sección 5.1), comprobar la lista con `tinker` y repetir las
  llamadas con token.

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

- `NUXT_INTRANET_API_URL=https://intranet.creup.es/api/asambleas/v1`
- `NUXT_INTRANET_API_TOKEN=<token>`
- **Quitar `NUXT_ROLE_API_URL`** (o ponerla a
  `https://intranet.creup.es/api/asambleas/v1/user/role`). Si se queda con el
  valor actual, la consulta de rol seguirá yendo a la ruta pública vieja y
  dejará de funcionar al cerrarla.
- Aplicar las tres a la vez. El servicio lee el `.env` con `env_file`, así
  que hay que recrear el contenedor
  (`docker compose -f docker-compose.prod.yml up -d app`, con el compose de
  `DEPLOYMENT.md`): `restart` conserva las variables viejas.
- Verificar: entrar con una cuenta Asociado y una CEA (rol y
  miembro correctos en Administración), pulsar "Sincronizar" en Miembros (sin
  desactivaciones inesperadas; queda `members.sync` en el registro de
  auditoría), y en los logs de la Intranet ver `assemblies_api.role_lookup` con
  la huella del token y ningún `legacy_role_lookup` nuevo.
- Marcha atrás: restaurar las variables anteriores; la ruta vieja sigue viva.

**Paso 3. Ventana de transición.** Vigilar
`assemblies_api.legacy_role_lookup`: las entradas con el `ip` de la
plataforma deben quedarse a cero; las de otras IP son terceros que consultan
la ruta pública (un motivo más para cerrarla). En el mismo periodo tiene que
haber entradas `assemblies_api.role_lookup`: así "cero `legacy_role_lookup`"
significa que nadie usó la ruta vieja y no que los logs no se escriben (con
`LOG_LEVEL` por encima de `info`, `role_lookup` no se escribe). Mientras siga
abierta, R1
sigue vivo, y volver atrás es solo cambiar el interruptor y recrear el
contenedor, así que basta con un día con inicios de sesión reales, no una
semana.

**Paso 4. Cerrar la ruta vieja.** Poner
`ASSEMBLIES_API_LEGACY_ROLE_ROUTE=false` en el `env_file` y aplicarlo
(sección 5.1; con `config:cache` o `restart` la ruta seguiría abierta). La
comprobación con `tinker` da `false` y la ruta responde 404:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://intranet.creup.es/api/user/role \
  -H 'Content-Type: application/json' -d '{"email":"nadie@example.com"}'   # 404
```

Si algo se rompe, volver a `true` y aplicarlo igual (unos segundos de corte de
la Intranet). En un cambio posterior, borrar la ruta y
`AdminController::getUserRoleByEmail`.

Los listados públicos (`/api/usuarios/asociados` y
`/api/usuarios/sectoriales`) **no se cierran**: son de la web.

## 9. Cambios pendientes en la plataforma

No forman parte del trabajo de la Intranet, pero conviene hacerlos a la par:

- **Documentación y ejemplo de entorno:** `DEPLOYMENT.md` fija
  `NUXT_ROLE_API_URL` a la ruta pública vieja, `.env.example` trae un
  marcador de esa misma variable, y ninguno de los dos (ni `README.md`)
  menciona `NUXT_INTRANET_API_URL` ni `NUXT_INTRANET_API_TOKEN`. El valor por
  defecto de `runtimeConfig.roleApiUrl` en `nuxt.config.ts` apunta también a
  la ruta vieja (no se usa: `roleSync.ts` lee `process.env`, pero confunde).
- **`Accept: application/json`** en la consulta de rol, como ya hace el
  listado (la Intranet lo fuerza igualmente).
- **Rechazar `http:`** en `NUXT_INTRANET_API_URL` en producción
  (`getIntranetApiBaseUrl` lo acepta hoy): el token viajaría en claro. La
  única excepción sería la red Docker interna de la sección 5.8 (por ejemplo,
  permitiendo `http:` solo hacia nombres sin punto como `intranet`).
- **Emails en logs:** `roleSync` pasa el email a sus avisos, pero el logger
  (`server/utils/core/logger.ts`) ya sustituye toda clave `email` y todo valor
  con forma de email por `[REDACTED]`, igual que las claves `token` o
  `authorization`: no hay fuga. Lo que falta es poder correlacionar; una
  huella (HMAC truncado) lo permitiría.
- **`lastRoleSyncAt`** se escribe también cuando la consulta falla. Separar
  "último intento" de "última consulta con éxito", o escribirlo solo con
  éxito, para que Administración vea qué cuentas llevan tiempo sin
  actualizarse.
- **Defensa ante listas vacías:** la plataforma desactiva todo lo que no
  recibe. Aunque la Intranet nunca debería devolver una lista parcial, negarse
  a aplicar una sincronización que desactivaría todos (o una gran parte de)
  los miembros de un tipo, y pedir confirmación, evita un desastre por un
  error ajeno.
- **Cuentas borradas en la Intranet:** hoy un 404 cuenta como fallo y la cuenta
  conserva su rol (un Asociado borrado en la Intranet sigue siendo Asociado en
  la plataforma). Con el grupo nuevo, un 404 autenticado sí significa "no
  existe", así que la plataforma podría tratarlo como `Invitado`. Decisión de
  producto.
- **Enlazar por `id`** cuando la Intranet lo envíe (fase 1 ya lo incluye):
  sobrevive a un cambio de siglas.
- **Sincronización periódica** del listado (tarea programada de pg-boss), en
  vez de solo a mano.

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
     token, y además lo sincroniza de forma periódica por si se pierde un
     aviso.

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

Intranet, fase 1:

- [ ] `config/services.php` (`assemblies`) y `.env.example` con las cinco
      variables y `TRUSTED_PROXIES` (`config/trustedproxy.php`); interruptores
      booleanos estrictos (en blanco o mal escritos quedan en `true`).
- [ ] `AuthenticateAssembliesService` registrado como `assemblies.service` en
      `Kernel::$routeMiddleware`; compara el token antes de mirar el bloqueo,
      y un token válido pasa siempre. Tras 10 tokens erróneos por minuto e IP,
      los siguientes erróneos reciben 429.
- [ ] `Handler::shouldReturnJson` devuelve JSON para `api/asambleas/*` (405 y
      429 incluidos).
- [ ] Limitador `assemblies-api` en `RouteServiceProvider` (por token, con el
      hash completo, y ruta; por IP).
- [ ] Grupo `asambleas/v1` en `routes/api.php` con `withoutMiddleware('throttle:api')`.
- [ ] `AssemblyRoleLookupRequest`, `AssembliesApiController`,
      `AssemblyAccountResource`, `AssemblyMemberResource`.
- [ ] Listados completos, sin paginar, con 5xx ante cualquier error; 404
      idéntico para email desconocido y cuenta sin tipo.
- [ ] `Cache-Control: no-store` puesto por el middleware en toda respuesta
      que pasa por él (datos y errores del controlador incluidos).
- [ ] Hashes de token validados como 64 caracteres hexadecimales; si no queda
      ninguno válido, 503. Tokens con el formato `asm_` y base64url.
- [ ] `config/cors.php` con rutas públicas explícitas; el grupo privado y
      `api/user/role` fuera.
- [ ] Interruptor `legacy_role_route` y aviso `legacy_role_lookup` en
      `getUserRoleByEmail`.
- [ ] Logs sin token, sin hash completo y sin emails en claro.
- [ ] `TrustProxies` solo con la dirección fija de nginx
      (`config/trustedproxy.php`, `TRUSTED_PROXIES`; sin ella, nadie) y solo
      `X-Forwarded-For` y `X-Forwarded-Proto`.
- [ ] `AssembliesApiTest` en verde con `composer test`, con los tests nuevos
      (bloqueo que deja pasar un token válido, 429 en JSON sin `Accept`,
      filtro de hashes e interruptores, nginx acredita HTTPS y nadie más,
      `X-Forwarded-For` falsificado, `X-Forwarded-Host` ignorado, JSON exacto
      de la ruta vieja, CORS de la ruta vieja y de los listados públicos);
      Pint en verde.

Despliegue:

- [ ] Decidido qué sale con el primer push de la Intranet (`eb92083` con
      `c7e584f` y `e57094b`, o solo `eb92083`) y añadidas las correcciones
      que `eb92083` no incluye (sección 8).
- [ ] **Antes del paso 1** (sección 5.8): nginx con `set_real_ip_from` para
      todos los rangos de Cloudflare (IPv4 e IPv6), `CF-Connecting-IP` como
      `real_ip_header` y `X-Forwarded-For`, `-Proto`, `-Host` y `-Port`
      sobrescritas (nada de `$proxy_add_x_forwarded_for`); Cloudflare en Full
      (strict); 80/443 del VPS solo desde Cloudflare, IPv6 incluida; contenedor
      `intranet` sin puertos publicados; nginx con dirección fija en `edge`,
      aplicada por separado con `docker compose up -d` y con la Intranet
      cargando después; el log de acceso de nginx muestra IP reales de
      visitantes.
- [ ] `APP_DEBUG=false` y `LOG_LEVEL=info` en el `env_file` de la Intranet,
      comprobados con `config:show` tras recrear el contenedor y antes de
      poner el hash.
- [ ] Token generado y guardado en el gestor de contraseñas; hash en el
      `env_file` del servicio `intranet`, aplicado recreando el contenedor
      (sección 5.1) y comprobado con `tinker` (1 hash).
- [ ] Paso 1 verificado con `curl` (401, 404, número de asociados); `ip` de
      la plataforma anotado desde `assemblies_api.denied` y, si se usa lista
      de IP, solo cuando es su IP pública real.
- [ ] Siglas sin duplicados entre asociados y entre sectoriales (paso 2).
- [ ] Plataforma con `NUXT_INTRANET_API_URL` nuevo, `NUXT_INTRANET_API_TOKEN` y
      **sin** `NUXT_ROLE_API_URL` viejo, con el contenedor recreado
      (`docker compose -f docker-compose.prod.yml up -d app`).
- [ ] Inicio de sesión Asociado y CEA correcto; sincronización del listado sin
      desactivaciones inesperadas.
- [ ] Un día con inicios de sesión sin `legacy_role_lookup` desde la IP de la
      plataforma y con `role_lookup` en el mismo periodo; ruta vieja cerrada
      en el `env_file` y con el contenedor recreado (`tinker` da `false`).
- [ ] Rotación anual apuntada en el calendario de TIC.

Opcional:

- [ ] `GET /api/user` eliminada o con campos cerrados.
- [ ] Fase 2 priorizada con producto (áreas ejecutivas, derechos, aviso de
      cambios, calidad de siglas).
