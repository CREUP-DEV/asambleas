# Integración con la Intranet

La plataforma no decide quién es quién. Lo pregunta a la Intranet de CREUP, un
sistema aparte que guarda las cuentas, los miembros de la asociación y las
inscripciones a cada asamblea. Este documento es el contrato entre las dos:
qué rutas llama la plataforma, qué respuestas acepta y qué tiene que
garantizar quien las sirve. Cualquier servicio que lo cumpla sirve igual.

Lo que la plataforma hace con cada respuesta (roles, enlace con los miembros,
retirada del acceso) son reglas suyas y están en `AGENTS.md`, secciones
«Authentication And Role Sync» y «Members». Aquí solo va lo que cruza la
frontera.

## 1. Configuración de la plataforma

| Variable                    | Uso                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NUXT_INTRANET_API_URL`     | Base de la API (en CREUP, `https://intranet.creup.es/api/asambleas/v1`). La plataforma le añade cada ruta de la sección 3. Sin ella no hay sincronización del listado. En producción solo acepta `https:`, o `http:` hacia un nombre sin punto (un servicio de una red interna, como `http://intranet`); cualquier otro valor cuenta como ausente y se registra una vez (`intranet.config`, `isIntranetUrlAllowed`). |
| `NUXT_INTRANET_API_TOKEN`   | Si tiene valor, cada llamada lleva `Authorization: Bearer <token>`. Un valor en blanco cuenta como ausente. Nunca se registra (`intranetAuthHeaders`). Sin token, la plataforma nunca retira el acceso a nadie.                                                                                                                                                                                                      |
| `NUXT_ROLE_API_URL`         | Opcional, y lo normal es no definirla: URL completa de la consulta de rol, en lugar de `{NUXT_INTRANET_API_URL}/user/role` (`getRoleApiUrl`). En otro origen que la base se llama sin token (`isRoleLookupAuthenticated`): nunca retira el acceso, pero el token no sale hacia otro sitio.                                                                                                                           |
| `NUXT_INTRANET_ROSTER_SYNC` | Sincronización diaria del listado (05:00, Europe/Madrid). Solo la palabra `false` la apaga. No afecta a la revisión diaria de accesos (05:30), que corre siempre que la consulta de rol lleve token.                                                                                                                                                                                                                 |

En local las variables pueden quedar vacías: todas las cuentas entran como
`Otro` y no hay sincronización del listado.

## 2. Cuándo llama la plataforma

| Llamada                                                   | Cuándo                                                                                                                                                                                        | Código                                                     |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `POST user/role`                                          | Una vez en cada inicio de sesión con Google, antes de crear la sesión; la sincronización del rol reutiliza esa respuesta. Y en la revisión diaria de accesos (05:30), una cuenta cada 500 ms. | `server/utils/auth/roleSync.ts`, `accessRecheck.ts`        |
| `GET usuarios/asociados`, `sectoriales`, `cea`, `cas`     | «Sincronizar» en Miembros (`POST /api/members/sync`) y cada día a las 05:00. Las cuatro se piden antes de escribir nada.                                                                      | `server/utils/members/sync.ts`, `roster.ts`, `schedule.ts` |
| `GET asambleas/{type}/{number}/asistentes` y sus imágenes | Al abrir la sala o pulsar «Sincronizar» en ella, como mucho una vez por minuto y asamblea.                                                                                                    | `server/utils/seating/intranet.ts`, `images.ts`            |
| `GET asambleas/{type}/{number}/inscritos`                 | Al abrir el formulario de recuento, como mucho una vez por minuto y asamblea.                                                                                                                 | `server/utils/domain/headcountExpected.ts`                 |
| `GET firma-secretaria`                                    | Al preparar para firmar el acta de acuerdos (Secretaría), una vez por preparación.                                                                                                            | `server/utils/domain/agreementsSigning.ts`                 |

Todas llevan `Accept: application/json` y el token, con un tiempo máximo de
10 s. La plataforma trata cualquier respuesta que no sea un 2xx válido como
«Intranet no disponible»: no cambia nada de las cuentas ni de los miembros
existentes. La única excepción es el 404 de `user/role` (sección 3.3).

### Salvaguardas de la plataforma

- **Consulta de rol.** Un fallo nunca bloquea a quien ya tiene acceso. Una
  cuenta nueva entra como `Otro`. En una existente no cambia nada, ni
  siquiera `lastRoleSyncAt`.
- **Listado.** Si una sincronización desactivaría todos los miembros activos
  de un tipo, o más de max(3, 30 %) de ellos, no aplica nada y pide
  confirmación (`members.sync_blocked`, 409 `large_deactivation`). La
  sincronización diaria nunca confirma.
- **Revisión de accesos.** Si la Intranet dice no tener más de max(3, 30 %)
  de las cuentas por las que respondió, no retira el acceso a nadie
  (`users.access_recheck_blocked`). Tras 5 fallos seguidos se detiene.
- **Logs.** Nunca el email ni el token: la cuenta va como `accountRef`, una
  huella HMAC del email.

## 3. Contrato

Todas las rutas cuelgan de la base (`NUXT_INTRANET_API_URL`).

### 3.1 Requisitos para quien sirve la API

- **Token de servicio obligatorio** en `Authorization: Bearer`, nunca en la
  query string ni en el cuerpo. Quien sirve guarda solo su hash (SHA-256 de un
  token aleatorio de 32 bytes basta) y compara en tiempo constante. Sin hash
  configurado, responde 503: falla cerrado.
- **Solo HTTPS** fuera de una red interna.
- **Sin CORS**: ningún navegador debe poder leer estas rutas.
- **Sin enumeración**: sin token, el mismo 401 para cualquier petición, sin
  consultar la base de datos; con token, el mismo 404 para una cuenta que no
  existe y para una sin tipo.
- **Límite de peticiones propio**, por token y por IP. La plataforma sale por
  una sola IP y, al abrirse una sesión, entran muchas personas a la vez: un
  límite pensado para visitantes la dejaría sin servicio. En CREUP: 300/min
  por token en `user/role`, 30/min en cada listado y en las rutas de una
  asamblea, 600/min en las de imágenes, con presupuestos por IP separados para
  imágenes y para el resto.
- **Campos mínimos**: listas cerradas de claves, solo las de este contrato.
  Los datos personales (nombre, apellidos y foto de quien se inscribe, quién
  ocupa un cargo) salen solo en las rutas que los necesitan, y nunca un DNI,
  un teléfono ni una dirección.
- **JSON siempre, sin redirecciones** (un 302 a una página HTML se lee como un
  fallo) **y `Cache-Control: no-store`** en toda respuesta con datos.
- **Nunca un 200 con datos parciales**: ante cualquier error interno, un 5xx.
  Un listado vacío o incompleto por un error desactivaría miembros.
- **Logs sin secretos**: ni la cabecera `Authorization`, ni el token, ni el
  email en claro.

### 3.2 Códigos comunes

| Código | Cuándo                                                                                                           | Cuerpo                                |
| ------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 200    | Éxito                                                                                                            | El de cada ruta                       |
| 401    | Falta el token o no es válido. Con `WWW-Authenticate: Bearer`.                                                   | `{"error": "unauthorized"}`           |
| 403    | Petición que no es HTTPS cuando se exige                                                                         | `{"error": "forbidden"}`              |
| 404    | Solo con token válido: cuenta desconocida o sin tipo en `user/role`; asamblea sin evento; imagen que no se sirve | `{"error": "not_found"}`              |
| 422    | Cuerpo inválido                                                                                                  | `{"message": "...", "errors": {...}}` |
| 429    | Límite superado. Con `Retry-After`.                                                                              | JSON                                  |
| 5xx    | Error interno, sin traza                                                                                         | JSON genérico                         |
| 503    | No hay token configurado                                                                                         | `{"error": "service_unavailable"}`    |

Un 304 cuenta como fallo: nada de respuestas condicionales.

### 3.3 `POST user/role`

Quién es una cuenta. Es `POST` para que el email no aparezca en URLs ni en
logs de acceso.

```http
POST /api/asambleas/v1/user/role HTTP/1.1
Authorization: Bearer <token>
Accept: application/json
Content-Type: application/json

{"email": "consejo@universidad.example"}
```

`email`: obligatorio, como mucho 254 caracteres, normalizado con `trim` y
minúsculas antes de buscar. Cualquier otra clave se ignora.

Respuesta 200:

```json
{
  "id": 412,
  "role": "Asociado",
  "name": "Consejo de Estudiantes de la Universidad de Ejemplo",
  "initials": "CEUE",
  "university": "Universidad de Ejemplo",
  "university_acronym": "UE"
}
```

| Campo                | Tipo            | Qué lee la plataforma                                                                                                                                                                                                                                                           |
| -------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | integer \| null | El id estable de la cuenta (1 a 2^31-1). Se guarda en `users.intranet_id` y enlaza la cuenta con su miembro aunque cambien las siglas. Otro valor invalida la respuesta entera.                                                                                                 |
| `role`               | string no vacío | El tipo de la cuenta, comparado literalmente: `Asociado`, `Sectorial`, `CEA`, `CAS`, `CAI`, `CdG` tienen efecto (tabla de `AGENTS.md`); cualquier otro (`Invitado`, `Desasociado`, `Otros`…) da `Otro`. `CAS` es la Coordinación del CAS, que en la Intranet es una cuenta CEA. |
| `name`               | string \| null  | Nombre de la cuenta.                                                                                                                                                                                                                                                            |
| `initials`           | string \| null  | Siglas, como mucho 20 caracteres útiles. Enlazan con el miembro cuando no hay id ni email que lo hagan.                                                                                                                                                                         |
| `university`         | string \| null  | Universidad.                                                                                                                                                                                                                                                                    |
| `university_acronym` | string \| null  | Siglas de la universidad (UGR, UVa), nunca deducidas de su nombre. Dibujan el avatar y prefijan los códigos de enmienda. Más de 20 caracteres cuentan como `null`.                                                                                                              |

Un string vacío cuenta como `null`; un número u otro tipo en estos campos
invalida la respuesta entera. Las claves de más se ignoran, así que añadir
campos es compatible. No se devuelve nada más: ni email, ni id de Google, ni
datos personales.

**El 404.** Con token, `{"error": "not_found"}` exactamente (cualquier otra
clave lo convierte en un fallo) dice que la Intranet ya no tiene la cuenta.
Para la plataforma, a una cuenta que la Intranet conoció antes le retira el
acceso; vaciar el tipo de una cuenta tiene el mismo efecto que borrarla. Los
roles protegidos (`Admin`, `Secretaria`, `Presidencia`, `Moderador`) lo
conservan, y una cuenta que la Intranet no conoció nunca sigue como estaba.

### 3.4 Listados: `GET usuarios/asociados`, `sectoriales`, `cea` y `cas`

```json
{
  "data": [
    {
      "id": 412,
      "email": "consejo@universidad.example",
      "denomination": "CEUE",
      "initials": "CEUE",
      "university": "Universidad de Ejemplo",
      "university_acronym": "UE",
      "autonomous_community": "Andalucía"
    }
  ],
  "generated_at": "2026-11-05T10:15:00+01:00"
}
```

| Campo                                                      | Tipo            | Notas                                                                                                                                             |
| ---------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                                       | integer \| null | Id estable y único de la cuenta. La plataforma empareja primero por él (`members.intranet_id`). Uno que no sea entero invalida la lista entera.   |
| `email`                                                    | string \| null  | El email de inicio de sesión de la cuenta: segundo criterio de emparejamiento, para una cuenta recreada con otro id. Nunca sale de la plataforma. |
| `denomination`                                             | string \| null  | Nombre del miembro; sin él, las siglas.                                                                                                           |
| `initials`                                                 | string \| null  | Siglas. Una fila sin siglas se descarta (y se avisa).                                                                                             |
| `university`, `university_acronym`, `autonomous_community` | string \| null  | Solo en `asociados`; en el resto, `null`.                                                                                                         |
| `holder_name`                                              | string \| null  | Solo en `cea`: nombre y apellidos de quien ocupa el cargo. Es el único dato personal de los listados.                                             |
| `generated_at`                                             | string ISO 8601 | Momento de la respuesta.                                                                                                                          |

- `asociados`: los consejos asociados; `sectoriales`: las sectoriales;
  `cea`: una cuenta por cargo de la Comisión Ejecutiva Ampliada, que
  sobrevive a quien lo ocupa, salvo la Coordinación del CAS; `cas`: esa
  Coordinación, con las siglas `CAS` y la denominación del comité.
- **Lista completa en una sola respuesta, sin paginación.** La plataforma
  desactiva lo que no venga. Admite hasta 5000 filas.
- Si unas siglas o un id se repiten, gana la primera fila (asociados antes que
  sectoriales). Lo que no se puede guardar se avisa, no se pierde en silencio.
- `cea` y `cas` son opcionales: si la Intranet no las sirve, la sincronización
  sigue y deja esos miembros como estaban.

### 3.5 Rutas de la vista de la sala

Para la sala (`docs/seating-plan.md`). **Llevan datos personales**: el
nombre, los apellidos y la foto de quien se inscribe. La plataforma los
pide solo para esa vista y nunca los registra.

La plataforma encuentra el evento de una asamblea por su tipo (`AGO`, `AGE`
o `AGET`, nunca `AGOT`) y su número (1 a 999), nunca por su nombre: la
Intranet guarda esa pareja, única, en cada evento de asamblea.

Un asistente sale en la lista, y se sirven su foto y el logo de su cuenta,
solo si está `Pendiente` o `Confirmada` en un evento con tipo y número, y su
cuenta sigue existiendo.

#### `GET asambleas/{type}/{number}/asistentes`

```json
{
  "event": {
    "id": 98,
    "name": "80.ª Asamblea General Ordinaria",
    "start_date": "2026-11-18",
    "end_date": "2026-11-22"
  },
  "accounts": [
    {
      "id": 412,
      "type": "Asociado",
      "category": "Multiusuario",
      "initials": "CEUE",
      "designation": "CEUE",
      "university_acronym": "UE",
      "order": null,
      "logo_version": "3f2a…"
    }
  ],
  "attendees": [
    {
      "id": 5120,
      "account_id": 412,
      "name": "Ana",
      "surname": "Pérez Ejemplo",
      "status": "Confirmada",
      "photo_version": null
    }
  ],
  "generated_at": "2026-11-15T10:15:00+01:00"
}
```

| Campo                         | Tipo            | Notas                                                                                                                            |
| ----------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `event.start_date`/`end_date` | `Y-m-d` \| null | Los días en que se celebra.                                                                                                      |
| `accounts[].type`             | string          | El tipo de la cuenta, como en `user/role` (`CAS` para la Coordinación del CAS).                                                  |
| `accounts[].category`         | string          | `Individual` (una persona por cuenta: la CEA, el CAS) o `Multiusuario` (consejos, sectoriales).                                  |
| `accounts[].order`            | integer \| null | Puesto de cada cargo de la CEA en su orden canónico, desde 1. `null` en cualquier otra cuenta.                                   |
| `accounts[].logo_version`     | string \| null  | Versión del logo; no nula solo si `cuentas/{id}/logo` lo va a servir. En una cuenta individual, la foto de quien ocupa el cargo. |
| `attendees[].account_id`      | integer         | La cuenta que lo inscribió, siempre presente en `accounts`.                                                                      |
| `attendees[].status`          | string          | `Pendiente` o `Confirmada`.                                                                                                      |
| `attendees[].photo_version`   | string \| null  | No nula solo si `asistentes/{id}/foto` la va a servir.                                                                           |

Cuentas por siglas y luego id; asistentes juntos por cuenta y por id. Lista
entera, sin paginación. Un tipo o un número no válidos (`0`, `080`) o una
pareja sin evento: 404 `{"error":"not_found"}`. Para la plataforma ese 404 no
es una caída: dice que la asamblea no está enlazada con ningún evento, y la
sala lo dice así.

#### `GET asistentes/{attendee}/foto` y `GET cuentas/{user}/logo`

Las imágenes de la sala. La plataforma las convierte y las sirve desde su
propio origen; ningún navegador las pide a la Intranet.

- Foto: JPEG, PNG, WebP o AVIF. Logo: además GIF y SVG (un SVG con
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`).
- El tipo se lee de los bytes, nunca de la extensión.
- `X-Content-Type-Options: nosniff`, `Content-Disposition: inline` sin nombre
  y `no-store`.
- Cualquier otro caso (un id que no es un número, alguien que la lista no
  traería, una foto retirada, un archivo que falta o de otro tipo): el mismo 404. Los parámetros se comprueban después del token.

### 3.6 `GET asambleas/{type}/{number}/inscritos`

Qué cuentas tienen a alguien inscrito, para que el formulario de recuento
marque «Inscrito». Solo ids de cuenta: ningún dato de una persona.

```json
{
  "event": {
    "id": 98,
    "name": "80.ª Asamblea General Ordinaria",
    "start_date": "2026-11-18",
    "end_date": "2026-11-22"
  },
  "account_ids": [7, 41, 412],
  "generated_at": "2026-11-18T10:15:00+01:00"
}
```

`account_ids`: cada cuenta una vez, en orden ascendente, con la misma regla
que la lista de asistentes. El mismo 404 que `asistentes`. La plataforma
marca los consejos y sectoriales por `members.intranet_id` y las cuentas
invitadas por `users.intranet_id`; sin la ruta, no marca a nadie.

### 3.7 `GET firma-secretaria`

La firma visual de la Secretaría Ejecutiva, para el acta de acuerdos: la
imagen que sube en su perfil de la Intranet quien ocupa la cuenta que la
administración marca como la de la Secretaría Ejecutiva (la misma que usan
los certificados de asistencia). Es un dato personal de esa persona: se
borra con sus datos personales.

- `200`: la imagen (PNG o JPEG), con su tipo leído de los bytes y
  `X-Content-Type-Options: nosniff`.
- `404` `{"error":"not_found"}`: no hay cuenta marcada, no tiene firma o
  falta el archivo.

La plataforma la pide sin seguir redirecciones, con un máximo de 3 MB, la
pasa a PNG (como mucho 800 × 320) y la dibuja solo en el PDF que prepara
para firmar; no guarda ninguna copia. Sin ella (un 404, una Intranet sin la
ruta o un error), el hueco de la firma queda en blanco y nada falla.

## 4. Ampliaciones posibles

Lo que la Intranet podría dar para que la plataforma pida menos a mano:

- **Derechos de cada miembro** en la Asamblea General (asistir, voz, voto,
  presentar enmiendas o puntos), para impedir presentar a quien no los tenga
  sin listas manuales.
- **Aviso de cambios**: un webhook firmado (HMAC con un secreto distinto del
  token, con marca de tiempo) sin datos personales, `{"event":
"members.changed"}`, tras el cual la plataforma vuelve a pedir el listado.
  La sincronización diaria cubre los avisos que se pierdan.
