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
- Requisito previo: `TrustProxies` confía hoy en cualquiera (`'*'`). Según
  dónde termine TLS, cualquier cliente puede inventarse su IP y el esquema, lo
  que anularía los límites por IP y la comprobación de HTTPS (R6, sección
  5.8). Hay que confirmarlo en el servidor real.
- Despliegue en tres pasos: Intranet con el grupo nuevo (la ruta pública vieja
  sigue viva), cambio de variables en la plataforma, cierre de la ruta vieja.
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
  `-Host`, `-Port`, `-Proto` y las cabeceras de AWS ELB. Ver R6.
- La copia de despliegue en `CREUP/VPS` (noviembre de 2025, posiblemente
  desactualizada) sirve la Intranet con PHP-FPM detrás de nginx por FastCGI, y
  el contenedor `intranet` publica `9001:9000` en el host.
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

| #   | Riesgo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Impacto                                                                                                                     | Gravedad                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| R1  | `POST /api/user/role` responde a cualquiera: confirma si un email tiene cuenta y devuelve tipo, nombre, siglas y universidad. Cualquier persona que haya entrado alguna vez con su Google personal está en `users` (como `Invitado`) con su nombre real.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Revelación de datos personales (RGPD) y de quién pertenece a qué órgano.                                                    | Alta                                     |
| R2  | Enumeración: 60 consultas/min por IP sin más control; con varias IP no hay techo. Con CORS `*` cualquier web puede hacer que los navegadores de sus visitantes consulten la ruta y lean la respuesta, repartiendo el límite entre miles de IP.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Barrido masivo de emails.                                                                                                   | Alta                                     |
| R3  | El límite `throttle:api` (60/min por IP) es compartido: toda la plataforma sale por una sola IP. Al abrirse una sesión entran muchas personas a la vez; pasadas 60 en un minuto, la Intranet responde 429.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Cuentas nuevas quedan como `Invitado`, las existentes con datos viejos; una sincronización del listado en ese minuto falla. | Media                                    |
| R4  | La consulta de rol de la plataforma no envía `Accept: application/json`. Un error de validación en Laravel responde con una redirección 302 a HTML; `fetch` la sigue y la plataforma ve "respuesta inválida".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Fallos enmascarados y difíciles de diagnosticar.                                                                            | Baja                                     |
| R5  | La plataforma depende de listados con forma de web pública (logos, redes, `contact_email`, orden de la web). Si la web pide paginar o renombrar campos, la plataforma se rompe; si se pagina, **desactiva en silencio** a los miembros de las páginas siguientes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Acoplamiento con otro producto y datos de más.                                                                              | Media                                    |
| R6  | `TrustProxies::$proxies = '*'` confía en quien abre la conexión. Si nginx termina TLS y habla FastCGI directamente con PHP-FPM (lo que muestra la copia de `CREUP/VPS`), quien abre la conexión es el cliente final: cualquiera puede mandar su propio `X-Forwarded-For` o `X-Forwarded-Proto` y Laravel se lo cree, **aun pasando por nginx**. Hoy eso ya quita el techo al límite de 60/min de R2. Con el diseño nuevo anularía la lista de IP, el límite por IP y la comprobación de HTTPS, y quien se hiciera pasar por la IP de la plataforma la dejaría fuera minuto tras minuto con el bloqueo por fallos de token. Si además el puerto FastCGI publicado (`9001`) es accesible desde fuera, cualquiera puede hablar con PHP-FPM sin nginx y fijar cualquier parámetro. | Anula todas las medidas por IP.                                                                                             | Alta (a confirmar con la topología real) |
| R7  | `GET /api/user` devuelve el modelo `User` entero a quien tenga un token Sanctum. Hoy no se emite ninguno, pero si algún día se emite, expone `google_id`, email y todas las columnas visibles.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Exposición futura.                                                                                                          | Baja                                     |

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
  filtra el `.env` o la caché de configuración de la Intranet, el hash no
  sirve para llamar a la API.
- 32 bytes aleatorios (`openssl rand -hex 32`, 64 caracteres). Con esa
  entropía SHA-256 basta; no hace falta bcrypt ni Argon2.
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

| Código | Cuándo                                                                              | Cuerpo                                                                 | Cabeceras                  |
| ------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------- |
| 200    | Éxito                                                                               | El de cada endpoint                                                    | `Cache-Control: no-store`  |
| 401    | Falta el token o no es válido (mismo cuerpo en ambos casos, sea cual sea el email)  | `{"error": "unauthorized"}`                                            | `WWW-Authenticate: Bearer` |
| 403    | Petición no HTTPS con HTTPS exigido, o IP fuera de la lista permitida               | `{"error": "forbidden"}`                                               |                            |
| 404    | Solo en `user/role`, y solo con token válido: email sin cuenta o cuenta sin tipo    | `{"error": "not_found"}`                                               | `Cache-Control: no-store`  |
| 405    | Método equivocado (lo da el framework)                                              | JSON del framework                                                     |                            |
| 422    | Cuerpo inválido                                                                     | `{"message": "...", "errors": {"email": ["..."]}}`                     |                            |
| 429    | Límite superado                                                                     | `{"message": "Too Many Attempts."}` o `{"error": "too_many_requests"}` | `Retry-After`              |
| 500    | Error interno. **Nunca un 200 con datos parciales.** Sin traza (`APP_DEBUG=false`). | JSON genérico                                                          |                            |
| 503    | El grupo no tiene ningún hash de token configurado                                  | `{"error": "service_unavailable"}`                                     |                            |

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

| Medida                 | Cómo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token dedicado         | Middleware `AuthenticateAssembliesService` en todo el grupo; hash SHA-256 en configuración, dos ranuras, `hash_equals`, solo cabecera `Authorization`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Proxies de confianza   | **Requisito previo** de todas las medidas por IP y de la comprobación de HTTPS (R6, sección 5.8): `TrustProxies` deja de confiar en `'*'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Lista de IP (opcional) | `ASSEMBLIES_API_ALLOWED_IPS` con la IP con la que Laravel ve a la plataforma (admite CIDR, `IpUtils::checkIp`). No poner "la IP de salida" de memoria: copiar el `ip` que registra `assemblies_api.denied` tras la primera llamada sin token del paso 1 (sección 8); si la plataforma y la Intranet comparten servidor, puede ser la pasarela de una red Docker. Solo sirve con los proxies de confianza ya corregidos.                                                                                                                                                                                                                                                |
| Solo HTTPS             | `ASSEMBLIES_API_REQUIRE_HTTPS=true`: el middleware responde 403 a peticiones no seguras (`$request->secure()`). Si nginx termina TLS, Laravel lo sabe por el parámetro FastCGI `HTTPS` (`fastcgi_params` ya pasa `HTTPS $https if_not_empty`); si lo termina un proxy anterior, por su `X-Forwarded-Proto`, y solo si ese proxy es de confianza. Así una URL mal configurada falla a la vista en vez de funcionar en claro. HSTS en nginx. Si el token llegó a viajar por `http`, rotarlo. Excepción, solo si aplica: si la plataforma llegase a llamar por una red Docker interna que no sale del servidor, se puede desactivar HTTPS **y** limitar las IP a esa red. |
| Límite de peticiones   | Sin `throttle:api`. Limitador `assemblies-api`: 300/min por token en `user/role`, 30/min por token en cada listado, 600/min por IP. Además, 10 intentos fallidos de token por minuto e IP; después, 429.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Campos mínimos         | Recursos dedicados (`AssemblyAccountResource`, `AssemblyMemberResource`) con lista cerrada de claves. Sin emails, teléfonos, redes ni logos.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Sin enumeración        | Sin token, 401 idéntico para cualquier email (no se consulta la base de datos). Con token, 404 idéntico para email desconocido y cuenta sin tipo. CORS cerrado: ningún navegador puede leer el grupo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Logs sin secretos      | Nunca la cabecera `Authorization`, el token ni el hash completo; como huella, los 8 primeros caracteres del hash. Nunca el email en claro: HMAC con `APP_KEY`, truncado. `LOG_LEVEL=info` o superior en producción; no registrar cuerpos de petición.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Rotación               | Procedimiento de la sección 7, con dos ranuras y sin cortes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| CORS cerrado           | `config/cors.php` deja de usar `api/*` y lista solo las rutas públicas. El grupo `api/asambleas/*` queda fuera: sin `Access-Control-Allow-Origin`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Validación             | `FormRequest` (`AssemblyRoleLookupRequest`) con normalización previa; JSON forzado para que un error sea 422 y no una redirección.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Falla cerrado          | Sin hash configurado, 503. Un error interno, 5xx y nunca datos parciales. `APP_DEBUG=false`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Tests                  | Sección 6.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

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
    // Anything that is not 64 hex characters (a pasted token, a truncated
    // hash) is dropped, so a slot set by mistake fails closed (503 when no
    // slot is left) instead of quietly answering 401.
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

    'require_https' => (bool) env('ASSEMBLIES_API_REQUIRE_HTTPS', true),

    // Keeps the old public POST /api/user/role answering during the
    // transition window. Turn off once the platform uses /api/asambleas/v1.
    'legacy_role_route' => (bool) env('ASSEMBLIES_API_LEGACY_ROLE_ROUTE', true),
],
```

`.env.example`:

```dotenv
# Private API for the assemblies platform (/api/asambleas/v1)
# SHA-256 hex of the token: printf %s "$TOKEN" | sha256sum
ASSEMBLIES_API_TOKEN_SHA256=
ASSEMBLIES_API_TOKEN_SHA256_NEXT=
ASSEMBLIES_API_ALLOWED_IPS=
ASSEMBLIES_API_REQUIRE_HTTPS=true
ASSEMBLIES_API_LEGACY_ROLE_ROUTE=true
```

Si se usa `php artisan config:cache`, regenerarla tras cada cambio.

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

        $failureKey = 'assemblies-api-auth-failures:'.$request->ip();
        if (RateLimiter::tooManyAttempts($failureKey, self::FAILURES_PER_MINUTE)) {
            return $this->noStore(response()->json(['error' => 'too_many_requests'], 429, [
                'Retry-After' => RateLimiter::availableIn($failureKey),
            ]));
        }

        if (! $this->matches((string) $request->bearerToken(), $config['token_hashes'])) {
            RateLimiter::hit($failureKey, 60);

            return $this->deny($request, 401, 'invalid_token');
        }

        // Covers whatever the controller answers, errors rendered by the
        // handler included (404, 422, 500).
        return $this->noStore($next($request));
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
// sets.
RateLimiter::for('assemblies-api', function (Request $request) {
    $token = substr(hash('sha256', (string) $request->bearerToken()), 0, 8);
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

- **Proxies de confianza (R6), antes del paso 1 del despliegue.** Primero,
  comprobar en el servidor dónde termina TLS (la copia de `CREUP/VPS` no basta:
  su `intranet.creup.es.conf` solo escucha en el 80 y apunta a
  `127.0.0.1:9001` desde el contenedor de nginx). Después:
  - **nginx termina TLS y habla FastCGI con PHP-FPM, sin nada delante:** en
    `TrustProxies`, `protected $proxies = null;` (no confiar en nadie).
    `ip()` pasa a ser `REMOTE_ADDR`, que pone nginx, y `secure()` sale del
    parámetro FastCGI `HTTPS`, que ya envía `fastcgi_params`.
  - **Hay un proxy HTTP o CDN delante que termina TLS:** `$proxies` con solo
    sus IP o rangos, y ese proxy debe sobrescribir `X-Forwarded-For` y
    `X-Forwarded-Proto`. Con `null` en este caso, cada llamada de la
    plataforma recibiría 403 por "no HTTPS".

  En los dos casos, el puerto FastCGI de PHP-FPM no debe ser accesible desde
  fuera: la copia de `docker-compose.yml` publica `9001:9000` en todas las
  interfaces. Publicarlo solo en `127.0.0.1:9001:9000` (o usar una red Docker
  interna sin `ports`) o cerrarlo en el cortafuegos, y comprobarlo desde fuera
  del servidor. Con `'*'`, además, un cliente puede falsificar
  `X-Forwarded-Host`, que afecta a las URL absolutas que genere la Intranet.

- **`GET /api/user` (R7):** eliminarla si no la usa nadie (no se emite ningún
  token Sanctum). Si se mantiene, devolver un recurso con campos cerrados.
- **Producción:** `APP_DEBUG=false` y `LOG_LEVEL=info` o superior.

## 6. Tests (PHPUnit)

`tests/Feature/Api/AssembliesApiTest.php`, en el estilo del repositorio
(PHPUnit 13, `RefreshDatabase`, `#[DataProvider]`, métodos `test_...`):

```php
<?php

namespace Tests\Feature\Api;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Log\Events\MessageLogged;
use Illuminate\Support\Facades\Event;
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

    private const TOKEN = 'current-0123456789abcdef0123456789abcdef0123456789abcdef01234567';

    private const NEXT_TOKEN = 'next-fedcba9876543210fedcba9876543210fedcba9876543210fedcba98';

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

    public function test_repeated_bad_tokens_lock_the_ip_out_for_a_minute(): void
    {
        for ($i = 0; $i < 10; $i++) {
            $this->getJson('/api/asambleas/v1/usuarios/asociados', $this->auth('wrong'))->assertStatus(401);
        }

        $this->getJson('/api/asambleas/v1/usuarios/asociados', $this->auth())
            ->assertStatus(429)
            ->assertHeader('Retry-After');
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

    public function test_no_browser_origin_is_allowed(): void
    {
        $this->call('OPTIONS', '/api/asambleas/v1/user/role', [], [], [], [
            'HTTP_ORIGIN' => 'https://evil.example',
            'HTTP_ACCESS_CONTROL_REQUEST_METHOD' => 'POST',
        ])->assertHeaderMissing('Access-Control-Allow-Origin');
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

    public function test_the_legacy_route_closes_with_its_switch(): void
    {
        User::factory()->create(['email' => 'cdeub@ub.edu', 'type' => 'Asociado']);

        $this->postJson('/api/user/role', ['email' => 'cdeub@ub.edu'])->assertOk();

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
- Al cerrar la ventana de transición y borrar la ruta vieja, sustituir el
  último test por uno que compruebe que `POST /api/user/role` da 404.

## 7. Rotación del token

Cuándo: una vez al año, en cada relevo de la persona responsable de TIC y de
inmediato ante cualquier sospecha de filtración.

1. Generar el token nuevo y su hash sin dejarlo en el historial de la shell:

   ```bash
   T=$(openssl rand -hex 32)
   printf %s "$T" | sha256sum | cut -d' ' -f1   # hash for the Intranet
   printf %s "$T"                               # copy to the password manager, then: unset T
   ```

2. Intranet: poner el hash nuevo en `ASSEMBLIES_API_TOKEN_SHA256_NEXT`,
   desplegar o `php artisan config:cache`. Ahora valen los dos.
3. Plataforma: poner el token nuevo en `NUXT_INTRANET_API_TOKEN` y recrear el
   contenedor (`docker compose up -d app`; `restart` no relee el `.env`).
4. Comprobar en los logs de la Intranet (`assemblies_api.role_lookup`) que la
   huella `token` coincide con los 8 primeros caracteres del hash nuevo, y que
   un inicio de sesión y una sincronización del listado funcionan.
5. Intranet: mover el hash nuevo a `ASSEMBLIES_API_TOKEN_SHA256` y vaciar
   `_NEXT`. El token viejo deja de valer.
6. Borrar el token viejo del gestor de contraseñas.

Ante una filtración, saltar directamente a sustituir
`ASSEMBLIES_API_TOKEN_SHA256` (vaciando `_NEXT`) y el token de la plataforma,
lo más seguidos posible. Mientras la plataforma siga con el token viejo:

- los accesos siguen funcionando, pero no se refresca el rol: las cuentas
  nuevas entran como `Invitado` y sin miembro hasta su siguiente inicio de
  sesión, y "Sincronizar" en Miembros da 502;
- cada consulta fallida cuenta para el bloqueo por fallos de token de la IP de
  la plataforma, así que tras el cambio puede recibir 429 hasta un minuto. Para
  no esperar, en la Intranet:
  `php artisan tinker --execute="Illuminate\Support\Facades\RateLimiter::clear('assemblies-api-auth-failures:<ip>');"`
  con el `ip` que registra `assemblies_api.denied`.

Dónde vive el token: en el `.env` de producción de la plataforma y en el gestor
de contraseñas de TIC. Nunca en repositorios, correos ni chats. La Intranet
solo guarda el hash.

## 8. Despliegue

Hacerlo fuera de una semana de asamblea.

**Paso 0. Preparar.** Generar el token (sección 7, paso 1) y guardarlo en el
gestor de contraseñas.

**Paso 1. Intranet: grupo nuevo con token obligatorio; la ruta vieja sigue.**

- Requisito previo: `TrustProxies` corregido y el puerto FastCGI cerrado
  desde fuera (sección 5.8). Sin eso, el límite por IP, el bloqueo por fallos,
  la lista de IP y la comprobación de HTTPS se pueden esquivar.
- Desplegar middleware, rutas, controlador, recursos, limitador, CORS y tests,
  con `ASSEMBLIES_API_TOKEN_SHA256=<hash>`,
  `ASSEMBLIES_API_LEGACY_ROLE_ROUTE=true` y `ASSEMBLIES_API_ALLOWED_IPS` vacía
  de momento.
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

- Si la primera llamada da 403 en vez de 401, Laravel no ve la petición como
  HTTPS (`ASSEMBLIES_API_REQUIRE_HTTPS` está activo por defecto). Según dónde
  termine TLS, `$request->secure()` depende del parámetro FastCGI `HTTPS` de
  nginx o del `X-Forwarded-Proto` de un proxy de confianza (sección 5.8).
  Corregirlo antes de seguir: si no, cada consulta de rol de la plataforma
  recibiría 403 y fallaría sin aviso visible.
- La primera llamada deja en los logs de la Intranet un
  `assemblies_api.denied` con el `ip` con el que Laravel ve al servidor de la
  plataforma. Si se quiere lista de IP, ponerla en
  `ASSEMBLIES_API_ALLOWED_IPS`, regenerar la configuración y repetir las
  llamadas con token.

**Paso 2. Plataforma: cambiar variables.**

- `NUXT_INTRANET_API_URL=https://intranet.creup.es/api/asambleas/v1`
- `NUXT_INTRANET_API_TOKEN=<token>`
- **Quitar `NUXT_ROLE_API_URL`** (o ponerla a
  `https://intranet.creup.es/api/asambleas/v1/user/role`). Si se queda con el
  valor actual, la consulta de rol seguirá yendo a la ruta pública vieja y
  dejará de funcionar al cerrarla.
- Aplicar las tres a la vez. El servicio lee el `.env` con `env_file`, así
  que hay que recrear el contenedor (`docker compose up -d app`):
  `docker compose restart` conserva las variables viejas.
- Verificar: entrar con una cuenta Asociado y una CEA (rol y
  miembro correctos en Administración), pulsar "Sincronizar" en Miembros (sin
  desactivaciones inesperadas; queda `members.sync` en el registro de
  auditoría), y en los logs de la Intranet ver `assemblies_api.role_lookup` con
  la huella del token y ningún `legacy_role_lookup` nuevo.
- Marcha atrás: restaurar las variables anteriores; la ruta vieja sigue viva.

**Paso 3. Ventana de transición.** Vigilar
`assemblies_api.legacy_role_lookup`: las entradas con el `ip` de la
plataforma deben quedarse a cero; las de otras IP son terceros que consultan
la ruta pública (un motivo más para cerrarla). Mientras siga abierta, R1
sigue vivo, y volver atrás es solo cambiar el interruptor, así que basta con
un día con inicios de sesión reales, no una semana.

**Paso 4. Cerrar la ruta vieja.** `ASSEMBLIES_API_LEGACY_ROLE_ROUTE=false` y
regenerar la configuración (`php artisan config:cache` si se usa); responde 404. Si algo se rompe, volver a `true`. En un cambio posterior, borrar la ruta
y `AdminController::getUserRoleByEmail`.

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
  (`getIntranetApiBaseUrl` lo acepta hoy): el token viajaría en claro.
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
      variables.
- [ ] `AuthenticateAssembliesService` registrado como `assemblies.service` en
      `Kernel::$routeMiddleware`.
- [ ] `Handler::shouldReturnJson` devuelve JSON para `api/asambleas/*` (405 y
      429 incluidos).
- [ ] Limitador `assemblies-api` en `RouteServiceProvider` (por token y ruta,
      por IP) y bloqueo tras 10 fallos de token por IP.
- [ ] Grupo `asambleas/v1` en `routes/api.php` con `withoutMiddleware('throttle:api')`.
- [ ] `AssemblyRoleLookupRequest`, `AssembliesApiController`,
      `AssemblyAccountResource`, `AssemblyMemberResource`.
- [ ] Listados completos, sin paginar, con 5xx ante cualquier error; 404
      idéntico para email desconocido y cuenta sin tipo.
- [ ] `Cache-Control: no-store` puesto por el middleware en toda respuesta
      que pasa por él (datos y errores del controlador incluidos).
- [ ] Hashes de token validados como 64 caracteres hexadecimales; si no queda
      ninguno válido, 503.
- [ ] `config/cors.php` con rutas públicas explícitas; el grupo privado y
      `api/user/role` fuera.
- [ ] Interruptor `legacy_role_route` y aviso `legacy_role_lookup` en
      `getUserRoleByEmail`.
- [ ] Logs sin token, sin hash completo y sin emails en claro.
- [ ] **Antes del paso 1:** comprobado dónde termina TLS; `TrustProxies` sin
      `'*'` (`null` si nginx es el borde, solo las IP del proxy si hay uno
      delante); puerto FastCGI de PHP-FPM inaccesible desde fuera.
- [ ] `APP_DEBUG=false` y `LOG_LEVEL=info` en producción.
- [ ] `AssembliesApiTest` en verde con `composer test`; Pint en verde.

Despliegue:

- [ ] Token generado y guardado en el gestor de contraseñas; hash en el `.env`
      de la Intranet.
- [ ] Paso 1 verificado con `curl` (401, 404, número de asociados); `ip` de
      la plataforma anotado desde `assemblies_api.denied`.
- [ ] Plataforma con `NUXT_INTRANET_API_URL` nuevo, `NUXT_INTRANET_API_TOKEN` y
      **sin** `NUXT_ROLE_API_URL` viejo, con el contenedor recreado
      (`docker compose up -d app`).
- [ ] Inicio de sesión Asociado y CEA correcto; sincronización del listado sin
      desactivaciones inesperadas.
- [ ] Un día con inicios de sesión sin `legacy_role_lookup` desde la IP de la
      plataforma; ruta vieja cerrada.
- [ ] Rotación anual apuntada en el calendario de TIC.

Opcional:

- [ ] `GET /api/user` eliminada o con campos cerrados.
- [ ] Fase 2 priorizada con producto (áreas ejecutivas, derechos, aviso de
      cambios, calidad de siglas).
