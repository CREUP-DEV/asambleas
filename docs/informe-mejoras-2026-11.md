# Informe de mejoras de la plataforma de asambleas

11 de noviembre de 2026

Este informe reúne lo que conviene mejorar en la plataforma de asambleas de CREUP, juzgado por cómo se usa de verdad: una AGO de tres días con unas 150 enmiendas y transaccionales en plena sesión, la Mesa con la consola y la proyección que lee toda la sala, la Secretaría a su lado y las delegaciones siguiendo el directo desde el móvil con la Wi-Fi de la sede.

Se exploraron 17 áreas de la aplicación, una por agente, y otras 6 comprobaciones que propuso un crítico de cobertura. De ahí salieron 298 hallazgos. Un revisor escéptico volvió a comprobar cada uno en el código e intentó refutarlo; sobrevivieron 218, que se han fusionado en los 183 elementos de este informe: 15 de prioridad 1, 75 de prioridad 2 y 93 de prioridad 3.

Cada elemento lleva su identificador, su prioridad, un esfuerzo estimado (S, M o L) y cómo se ha verificado: «confirmado» quiere decir que el revisor lo demostró en el código; «por confirmar», que es probable pero hace falta ejecutarlo o escribir un test para estar seguros. Se pidió recoger solo lo que tiene impacto real y prestar una atención especial a la accesibilidad de las enmiendas, que por eso abre el informe con su propia sección.

## Lo más importante

- **SES-1** (también SEG-2 y OPS-1) Todo /api/assemblies/\*\* comparte un cubo de 12.000 peticiones cada 5 min por IP del recinto y puede dejar a la Mesa y a la sala en 429; hay que desactivar el rateLimiter en esa regla, cuyas rutas ya pasan por requireActor.
- **SEG-1** El xssValidator activo por defecto devuelve 400 a los POST con «<», «>» o «->» y bloquea el bucle de eventos al serializar cada subida multipart; se arregla con xssValidator: false en nuxt.config.ts y un test HTTP.
- **SES-2** La proyección pinta autores y presentadores con el cargo real porque se abre con una cuenta que ve los cargos; hay que añadir una vista de sala, que solo acepte el servidor y solo de quien modera, construida con el actor público para que se apliquen los redact\*.
- **UXS-1** Los atajos de la consola actúan sobre la fila enfocada aunque el debate haya cambiado y siguen activos con el recuento abierto; hay que ignorarlos con un diálogo o popover abierto, mover el foco a la enmienda en debate y confirmar cuando no coincidan.
- **ACC-ENM-1** Las letras a, r, t, l y v responden o deciden enmiendas al instante en revisar y en la consola de la Mesa sin poder apagarse (WCAG 2.1.4); hay que añadir un interruptor por navegador que apague todas las letras sueltas y la guarda de activeElement en withFocused.
- **SES-3** «Ahora en debate» y el asentimiento en bloque no avisan de una transaccional pendiente, que se cierra al decidir la enmienda; hay que añadir una línea discreta en NowAmendment y en los diálogos, confirmar las acciones de un clic y excluirla del lote.
- **ENM-1** El servidor calcula la mayoría con el último recuento aunque sea de otro día o aunque la Mesa vacíe «Presentes», mientras la previsión enseña otra base; el cliente debe mostrar el día del recuento y usar su cifra en la previsión cuando el campo esté vacío.
- **MOT-1** Los fragmentos proyectados reinician las listas en 1 o «a)» y el diff numera los ítems borrados; hay que poner el start real de orderedListNumbers en cada tramo de previewAmendment, saltar los borrados como el PDF y sembrarlo en la transaccional.
- **CLI-1** Ir de un documento a otro (Siguiente/Anterior o «atrás») desmonta el compositor sin preguntar porque solo hay onBeforeRouteLeave; hay que añadir onBeforeRouteUpdate cuando cambia la ruta y ocultar la barra de lectura con el compositor abierto.
- **UXM-1** En el móvil el compositor se abre al principio del documento, dentro de una caja con desplazamiento propio, sin índice y con «Revisar y enviar» fuera de la pantalla; hay que mostrar el índice flotante por debajo de sm y llevar «Revisar y enviar» a una barra fija al pie.
- **DOC-1** La cuenta atrás redondea bloques de 24 h y dice «pasado mañana» para un plazo de mañana; hay que contar por día de calendario de Madrid, añadir la hora si cae hoy o mañana y poner la fecha absoluta en la línea del documento.
- **OPS-2** deploy.sh migra sin copia previa y rollback.sh vuelve a imágenes incompatibles con el esquema (precedente 0021); hay que volcar la base antes de migrar, documentar la restauración, comparar el journal en el rollback y avisar si hay una sesión en curso.
- **MAN-1** deploy.sh despliega sin ejecutar lint, typecheck ni tests (y el README omite pnpm test), así que hay que añadir un script pnpm verify que deploy.sh ejecute antes de construir, exigir --allow-dirty y excluir .sim77/ y public/\_\* en .dockerignore.
- **SEG-4** (también REN-2 e I18N-1) pdfmake maqueta de forma síncrona en el proceso de la app (1,5 s fijos más ~0,15 s por página) y congela la sala con cada exportación; hay que moverlo a un worker o proceso hijo persistente, cachear y restringir el dosier de asamblea.
- **CLI-2** (también SEG-3) El middleware de sesión redirige a /login ante cualquier fallo del fetch, incluida la Wi-Fi caída; debe redirigir solo ante 401/403 y saltarse la comprobación cuando solo cambia la query.
- **SES-5** (también OPS-4 y CLI-6) El latido SSE es un comentario invisible para JS y no hay vigilancia ni resincronización al volver a la pestaña; hay que enviarlo como event: ping y reabrir con poll si pasan 60 s sin mensajes, al volver a visible o con online.
- **SEG-5** El anexo del PDF anotado se construye con la visibilidad de la Secretaría o la Mesa y filtra los cargos reales y las enmiendas no publicadas cuando se reenvía; debe construirse siempre como lo vería un delegado, con la variante interna en «Más» y marca de uso interno.
- **ACC-ENM-2** (también SES-8) El diff proyectado con un párrafo de contexto desborda la pantalla y su marca de lo añadido es tenue; conviene quitar el contexto, ajustar la letra al alto disponible y aplicar en la proyección las marcas fuertes de .diff-marks.

## Prioridad 1 por área

### Accesibilidad de las enmiendas

- **ACC-ENM-1** Atajos de una sola letra que registran respuestas y decisiones sin poder apagarse

### Seguridad, visibilidad y permisos

- **SEG-1** El filtro XSS de nuxt-security rechaza textos con «<» o «>» y congela el servidor en cada subida
- **SEG-2** El limitador de peticiones cuenta por IP: toda la sala comparte un cubo para /api/assemblies

### Lógica de enmiendas, documentos, orden del día y plazos

- **DOC-1** Las cuentas atrás dicen «pasado mañana» cuando el plazo cierra mañana
- **ENM-1** La base de presentes de una votación no es la que la Mesa ve en el formulario

### Motor de contenido y diffs

- **MOT-1** Las letras y números de las listas salen mal en los fragmentos de enmienda y en el diff

### Sesión en directo, proyección y tiempo real

- **SES-1** El límite de peticiones por IP deja a toda la sala, Mesa incluida, sin servicio hasta 5 minutos
- **SES-2** La proyección, abierta con la cuenta de la Mesa, muestra a la sala qué cargo de la CEA presenta cada enmienda o documento
- **SES-3** Decidir una enmienda, sola o en bloque, cierra sin aviso la transaccional pendiente sobre ella

### Experiencia de asociados, sectoriales y CEA

- **UXM-1** Compositor de enmiendas en el móvil: se abre al principio, sin índice y con «Revisar y enviar» fuera de la pantalla

### Experiencia de Secretaría y Mesa

- **UXS-1** Los atajos «a», «l» y «v» pueden actuar sobre una enmienda que no está en debate

### Rendimiento, fiabilidad, despliegue y datos

- **OPS-1** Un solo cupo de peticiones por IP para toda la sala, Mesa incluida
- **OPS-2** Desplegar o volver atrás durante una AGO no tiene red: ni copia previa ni comprobación del esquema

### Cliente, idiomas y exportación a PDF

- **CLI-1** Una enmienda o transaccional a medio escribir se pierde sin aviso al pasar a otro documento

### Mantenibilidad, pruebas y documentación

- **MAN-1** Se puede desplegar a producción sin pasar typecheck ni tests

## Solapamientos entre secciones

- SEG-2, SES-1 y OPS-1: son el mismo limitador por IP de nuxt-security en la regla de /api/assemblies/\*\* de nuxt.config.ts; se arreglan con un solo cambio.
- OPS-6 y UXS-14: las imágenes del editor heredan el límite de 8 MB de la misma regla de /api/assemblies/\*\*; una regla de ruta propia para imágenes y un mensaje con la cifra los resuelven a la vez.
- ACC-ENM-1, UXS-1, SES-6 y ACC-1: son los mismos atajos de una letra de la consola (y de revisar); un solo cambio debe añadir el interruptor por navegador, pausarlos con un diálogo abierto, hacer que la selección siga a la enmienda en debate y confirmar cuando no coincida.
- ACC-ENM-6 y ACC-3: el mismo aria-live de CommonCountdown; basta quitarlo una vez.
- DOC-1 e I18N-3: la misma cuenta atrás que redondea bloques de 24 h; hay que contar por día natural de Europe/Madrid en un solo sitio.
- ENM-1, UXS-2, SES-11 y MAN-5: la base de presentes sale del último recuento aunque sea de otro día; mostrar su fecha, avisar en VoteFields y usar su cifra en la previsión es un único cambio, y los tests de withHeadcount y fillPresent de MAN-5 deben acompañarlo.
- SEG-4, REN-2 e I18N-1: pdfmake maqueta en el hilo del único proceso; sacar el render a un proceso hijo o worker los resuelve los tres, y es la condición que pone I18N-12 para recuperar el dosier.
- SES-4 y REN-1: las recargas en directo con casi cualquier evento; el mismo filtro por tipo de evento en el cliente.
- SES-5, OPS-4 y CLI-6: el latido SSE es un comentario sin vigilancia; event: ping y reconexión tras unos 60 s de silencio, en el mismo código de reconexión donde REN-3 pide jitter.
- SEG-3, CLI-2 y SEG-13: el mismo middleware global de sesión; debe mandar a /login solo cuando la sesión no vale y, al hacerlo, con localePath.
- SES-2 y SEG-5: el personal ve los cargos reales de la CEA y lo que genera lo leen otros (la sala en la proyección, quien recibe el PDF anotado); ambos se arreglan construyendo esa salida con el actor público para que se apliquen los redact\*.
- ACC-ENM-2 y SES-8: el párrafo de contexto de la proyección deja el cambio fuera de la pantalla; hay que decidir juntos si se quita el contexto o se desplaza al bloque tocado.
- ACC-ENM-3, UXM-6 y CLI-3: la misma copia local del compositor de enmiendas y transaccionales con «Recuperar» al reabrir; hay que elegir un solo almacenamiento, y CLI-1 toca el mismo ciclo de vida del compositor.
- SES-3, ENM-5 y MOT-3: decidir o aceptar una enmienda cierra transaccionales pendientes o choca con otras incorporadas sin aviso; los avisos de la consola, de la revisión del proponente y los approvalWarnings de setAmendmentPosition salen de los mismos datos.
- ENM-4 y MAN-2: el plazo propio de las enmiendas a la totalidad de una reforma (RRI art. 65.4); el mismo desfase en las reglas de calendario y en isLateSubmission.
- UXS-4, I18N-5, SES-15 y UXM-3: los 409 de negocio caen en «Alguien ha modificado estos datos»; hay que dar a todos un messageKey o reason en el servidor, reservar ese texto al bloqueo optimista y ocultar el envío con el plazo vencido.
- DOC-3 y UXM-4: «Tareas pendientes» ofrece acciones que el servidor ya rechaza; se filtran con los mismos predicados del servidor, mejor ya compartidos como pide MAN-4.
- UXM-7 y CLI-7: los filtros de la lista de documentos se pierden con «Atrás»; llevarlos a la query los resuelve a la vez.
- ENM-6 e I18N-2: la misma línea de votación del PDF (mapping.ts y finalVoteLine); hay que imprimir la base, blancos, nulos y el asentimiento en el mismo cambio.
- ACC-ENM-10 y ACC-6: la misma región viva de «En directo», que debe anunciar tanto los desenlaces sin votación como el aviso de la Mesa.
- DAT-5 y UXS-10: registrar acuerdos y mociones sin documento; un solo endpoint de decisiones con su voto opcional, desde el «Más» de la consola.
- OPS-2 y MAN-1: el mismo deploy.sh; la verificación previa, la copia de la base y la comprobación del esquema en el rollback van juntas.
- MOT-14 y DOCS-3: la misma sección del motor en design.md, que hay que reescribir una sola vez.

## Índice

| Sección                                                 | Identificadores | P1     | P2     | P3     | Total   |
| ------------------------------------------------------- | --------------- | ------ | ------ | ------ | ------- |
| Accesibilidad de las enmiendas                          | ACC-ENM         | 1      | 7      | 11     | 19      |
| Accesibilidad general                                   | ACC             | 0      | 4      | 6      | 10      |
| Seguridad, visibilidad y permisos                       | SEG             | 2      | 7      | 4      | 13      |
| Lógica de enmiendas, documentos, orden del día y plazos | ENM, DOC        | 2      | 10     | 6      | 18      |
| Motor de contenido y diffs                              | MOT             | 1      | 7      | 6      | 14      |
| Sesión en directo, proyección y tiempo real             | SES             | 3      | 6      | 10     | 19      |
| Experiencia de asociados, sectoriales y CEA             | UXM             | 1      | 7      | 7      | 15      |
| Experiencia de Secretaría y Mesa                        | UXS             | 1      | 6      | 13     | 20      |
| Rendimiento, fiabilidad, despliegue y datos             | OPS, REN, DAT   | 2      | 6      | 9      | 17      |
| Cliente, idiomas y exportación a PDF                    | CLI, I18N       | 1      | 11     | 8      | 20      |
| Mantenibilidad, pruebas y documentación                 | MAN, DOCS       | 1      | 4      | 13     | 18      |
| **Total**                                               |                 | **15** | **75** | **93** | **183** |

## Comprobación manual de la prioridad 1

Después del flujo de agentes revisé a mano parte de la prioridad 1.

- **Probado**: SEG-1. Probé con textos reales el filtro que nuxt-security trae por defecto (`xss`, métodos GET y POST). «importe < 3.000 €», «<<cita>>» y «a -> b» devuelven 400; «cita» entre comillas latinas y un texto sin signos pasan. Una operación `replace` lleva el `baseText` del bloque (`shared/utils/schemas/content.ts:195`), así que basta con que el texto original contenga uno de esos signos. La otra mitad del título, que el filtro congele el servidor en cada subida multipart, no está probada.
- **Leído en el código**:
  - DOC-1: `formatRelative` redondea los días con `Math.round` (`app/utils/format.ts:168-171`). Un cierre el martes a las 23:59, visto el lunes a las 08:00 (40 h), sale como «pasado mañana».
  - ACC-ENM-1 y UXS-1: los atajos de una letra de `sesion.vue:150-199` y `revisar.vue:728-756` no se pueden apagar, y en la consola «a» aprueba por asentimiento sin confirmar.
  - ENM-1: la parte del servidor. `withHeadcount` rellena los presentes con el último recuento, sea del día que sea (`server/utils/domain/headcounts.ts:565-578`).
  - OPS-2 y MAN-1: `deploy.sh` migra sin copia previa y sin ejecutar lint, typecheck ni tests.
- **Leído en parte**: MOT-1, SES-2 y CLI-1. En CLI-1 el compositor solo tiene `onBeforeRouteLeave`. Que la página se vuelva a montar al cambiar de documento lo deduzco de la clave de página de Nuxt; no lo he visto pasar.
- **Aceptado del revisor, sin comprobar a mano**: SES-3, UXM-1 y la parte del cliente de ENM-1.
- **Por confirmar**: SEG-2, SES-1 y OPS-1, que son el mismo problema. La clave del limitador es IP más regla de ruta, así que toda la sala comparte 12.000 peticiones cada 5 minutos en `/api/assemblies/**`. El comentario de `nuxt.config.ts:166-167` muestra que esa cifra se eligió a propósito para una IP compartida. Falta medir cuántas peticiones genera la sala por cada evento en directo.

Quitando duplicados, la prioridad 1 son 12 problemas distintos: SEG-2, SES-1 y OPS-1 son uno, y ACC-ENM-1 y UXS-1 son otro.

## Accesibilidad de las enmiendas

Cubre cómo se leen, recorren, redactan y deciden las enmiendas con teclado, lector de pantalla, control por voz, móvil y en la proyección. La base es buena (etiquetas sr-only en los diffs, foco cuidado en «Revisar enmiendas», preferencias de fuente), pero hay atajos de una letra que deciden sin poder apagarse, saltos de foco en escritorio y regiones vivas que hablan sin que nadie haga nada.

### Prioridad 1: antes de la próxima asamblea

#### ACC-ENM-1. Atajos de una sola letra que registran respuestas y decisiones sin poder apagarse

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/pages/asambleas/[assembly]/documentos/[document]/revisar.vue:728-756`, `app/pages/asambleas/[assembly]/sesion.vue:150-199`, `app/components/amendment/Detail.vue:200-214`, `app/components/proponent-review/ShortcutHelp.vue:9-15`, `app/components/session/ConsoleToolbar.vue:136-162`, `server/utils/domain/reviewState.ts:614-628`
- **Qué pasa**: `defineShortcuts` escucha en toda la página. En revisar, `a`, `r` y `t` guardan al momento la respuesta del presentador y pasan a la siguiente; en la sesión, `a` aprueba por asentimiento, `l` declara decaída y `v` y `t` abren voto o transaccional. Solo se paran en campos de texto, diálogos, menús y listbox, y `withFocused` ni siquiera mira el `activeElement`. Nada los apaga: incumple WCAG 2.1.4 (nivel A).
- **Cuándo pasa**: En revisar, el presentador responde, empieza a escribir «Aceptamos la redacción» sin pulsar en el comentario y la «t» transacciona la enmienda siguiente. En la sesión, tras «Dar la palabra», el vocal teclea «Laura» y la «l» hace decaer la enmienda en debate.
- **Impacto**: Decisiones que nadie tomó, proyectadas y enviadas a los autores. Aceptar con la regla «incorporar», aprobar o hacer decaer cierra las transaccionales pendientes; deshacer reabre la enmienda, pero cada transaccional hay que reabrirla a mano.
- **Propuesta**: Un interruptor «Atajos de teclado» por navegador (localStorage con try/catch) en las ayudas que ya existen (`ShortcutHelp.vue`, popover de `ConsoleToolbar.vue`) que apague todas las letras sueltas, `j`/`k` de Detail incluidas; puede venir encendido. Alternativa: modificador (Alt+letra). Añadir a `withFocused` la guarda de `activeElement` de revisar y Detail.

### Prioridad 2

#### ACC-ENM-2. La proyección no muestra entero un diff largo y sus marcas son débiles

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `app/pages/proyeccion/[assembly].vue:641-647`, `app/pages/proyeccion/[assembly].vue:735-739`, `app/pages/proyeccion/[assembly].vue:785-810`, `app/assets/css/main.css:716-723`
- **Qué pasa**: El diff proyectado lleva `:context="1"` (párrafo anterior y posterior). Con la letra a escala de proyector caben unas 10 líneas bajo la cabecera; el propio comentario de :735-739 admite que un diff largo desborda y que nadie desplaza un proyector, y no hay ajuste ni desplazamiento. En modo color, lo añadido es un tinte pálido con un subrayado de 0,07em.
- **Cuándo pasa**: Una enmienda que sustituye un párrafo de 150 palabras ocupa 25-30 líneas con su contexto: la sala ve la mitad y el cambio que se vota puede quedar fuera.
- **Impacto**: La pantalla que lee toda la sala no muestra completa la enmienda que se vota. Cada delegado la tiene en el directo, por eso no es P1.
- **Propuesta**: `context=0` en la proyección (o contexto solo si cabe, o desplazar al primer cambio) y ajustar la letra al alto disponible con un mínimo legible (ResizeObserver). Aplicar bajo `.projection-text` las reglas de `.diff-marks` (negrita y líneas de 0,1em) sea cual sea el modo del portátil de la Mesa. No forzar el modo claro: la página trae logos para el oscuro a propósito.

#### ACC-ENM-3. El compositor de enmiendas solo guarda en memoria

- **Esfuerzo**: M · **Verificación**: por confirmar
- **Dónde**: `app/components/amendment/Composer.vue:156`, `app/components/amendment/Composer.vue:593-601`, `app/components/amendment/Composer.vue:809-818`, `app/components/amendment/Composer.vue:1252-1278`
- **Qué pasa**: Lo redactado vive solo en memoria (`edited`). «Guardar borrador» solo está en la fase de revisión y exige el tipo; la única protección es `beforeunload` y `onBeforeRouteLeave`. No hay copia local.
- **Cuándo pasa**: Una delegada redacta en el móvil, en la sala, una enmienda tardía larga, cambia a WhatsApp para consultarla con su consejo y Android descarta la pestaña sin disparar `beforeunload`. Al volver, lo escrito ha desaparecido. Depende del navegador y no se puede probar desde el código.
- **Impacto**: Se pierde trabajo en el peor momento, sobre todo a quien escribe despacio (lector de pantalla, dictado). Es más de fiabilidad que de accesibilidad.
- **Propuesta**: Copia local sin interfaz visible: guardar en sessionStorage (try/catch, con espera tras cada cambio) bloques, tipo, autores y justificación, con clave de cuenta, documento y borrador; ofrecer recuperarla al reabrir y borrarla al enviar o descartar. No guardar con un tipo por defecto ni aceptar un tipo nulo en el servidor.

#### ACC-ENM-4. En escritorio, abrir una enmienda o pulsar «Ver en el documento» no mueve el foco

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:699-702`, `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:843-849`, `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:867-895`, `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:1854-1911`, `app/components/amendment/Detail.vue:173-190`, `app/components/amendment/Detail.vue:604-611`, `app/components/content/ContentView.vue:423-453`
- **Qué pasa**: Al abrir la ficha desde la lista, la lista y su cabecera de filtros se desmontan y el foco cae en `body`: `selectAmendment` no llama a `focusDetail()`, que existe pero solo se usa tras el compositor. «Ver en el documento» llama a `scrollToAmendment` sin `{ focus: true }`, que la rama móvil sí pasa: el texto se desplaza, pero el foco sigue en el botón y nada se anuncia.
- **Cuándo pasa**: Un delegado con NVDA pulsa Intro en la tarjeta «12 · CEUM 4» y el lector calla o vuelve al principio de la página, con cada enmienda que abre.
- **Impacto**: El recorrido principal (lista, ficha, contexto) pierde la posición con teclado y lector de pantalla en pantallas anchas.
- **Propuesta**: Mover el foco al h2 de la ficha solo si no estaba abierta: leer `showDesktopDetail` antes de `detailOpen = true` y llamar a `focusDetail()` si era false (Anterior y Siguiente dejan el foco en su botón a propósito). En `showInDocument`, pasar `{ focus: true }`; `selectAmendment` sigue sin llevar el foco al texto.

#### ACC-ENM-5. Las actualizaciones en directo hacen repetir «45 enmiendas» y «7 de 31»

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:1246-1254`, `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:1981-1986`, `app/composables/amendment/useDocumentAmendments.ts:79`, `app/composables/amendment/useDocumentAmendments.ts:198-201`, `app/components/amendment/Detail.vue:178-190`, `app/components/amendment/Detail.vue:582-587`
- **Qué pasa**: La región viva de la lista se vacía mientras `list.pending` y vuelve a «N enmiendas» tras cada `refresh()`, que lanzan cada lote en directo del documento y cada reconexión (`poll`). El contador «{n} de {total}» de la ficha también es región viva: habla solo cuando una novedad cambia la lista, y al pulsar Anterior o Siguiente dice la posición pero no qué enmienda se abrió.
- **Cuándo pasa**: En la sesión (posiciones, admisiones, transaccionales, cortes del wifi de la sede), un delegado ciego con el documento abierto oye «45 enmiendas» o «7 de 31» cada vez que cambia algo.
- **Impacto**: Ruido constante que interrumpe la lectura justo en el momento de más actividad.
- **Propuesta**: Usar la condición del esqueleto, `list.pending.value && list.amendments.value.length === 0 ? "" : …`, para que la región solo hable si cambian el recuento o los filtros. Quitar `aria-live` del contador visible y añadir una región sr-only que solo rellene `go()` con «{código}, {n} de {total}».

#### ACC-ENM-6. Las cuentas atrás se anuncian cada minuto en la última hora

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/common/Countdown.vue:66-73`, `app/composables/time/useAppNow.ts:38-43`, `app/utils/format.ts:166-171`, `app/components/document/DocumentHeader.vue:236-243`, `app/components/agenda/DocumentRow.vue:153-161`
- **Qué pasa**: `CommonCountdown` (13 usos) es `aria-live="polite" aria-atomic="true"`. En la última hora el texto cambia, y se anuncia, cada minuto. La cabecera del documento sigue montada encima del compositor, y casi todas las filas de documentos comparten el cierre de enmiendas.
- **Cuándo pasa**: La noche del cierre, quien redacta su enmienda con lector oye «Cierre de enmiendas dentro de 37 minutos», «36 minutos»… mientras escribe; en la lista de documentos, la misma frase por cada fila visible.
- **Impacto**: Redactar y recorrer la lista con lector se vuelve muy difícil justo antes del plazo. No incumple un criterio AA, pero va contra la práctica ARIA: `role="timer"` lleva `aria-live="off"` implícito por esto.
- **Propuesta**: Quitar `aria-live` y `aria-atomic` de `Countdown.vue` (y su comentario), sin crear otra región. No añadir el plazo al compositor: ya es la línea de `DocumentHeader`, y la revisión avisa con `lateOnSend`.

#### ACC-ENM-7. Cada tarjeta de enmienda lee la justificación entera como nombre del botón

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/amendment/Card.vue:110-124`, `app/components/amendment/Card.vue:189-208`
- **Qué pasa**: Toda la tarjeta es un `<button>` y su nombre accesible es todo su texto, incluida la justificación completa (`line-clamp-1` solo recorta a la vista) y la nota de corrección.
- **Cuándo pasa**: Al tabular por las 27-65 enmiendas de un posicionamiento, el lector lee en cada parada código, autor, estado y la justificación entera.
- **Impacto**: La lista, que es la puerta de entrada a la lectura, se recorre muy despacio con lector de pantalla.
- **Propuesta**: `aria-hidden="true"` en el span de la justificación (:203-208): la ficha ya la da entera en «Por qué». La nota de corrección se queda, porque pide actuar al autor; como mucho, recortarla a una frase en el DOM tras «Nota de la Secretaría:».

#### ACC-ENM-8. El índice del margen mete todos los títulos en el orden de tabulación

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/content/ContentOutlineRail.vue:134-138`, `app/components/content/ContentOutlineRail.vue:204-214`, `app/components/content/ContentOutlineList.vue:48-64`, `app/components/content/ContentOutlineList.vue:110-128`, `app/components/content/BlockEditor.client.vue:1383`
- **Qué pasa**: Al enfocar el disparador, la lista se despliega (decisión deliberada) y cada título es un botón tabulable, aunque las flechas, Inicio y Fin ya funcionan.
- **Cuándo pasa**: Quien tabula desde las pestañas de modo hacia el texto o las enmiendas pasa por los 37 títulos de un posicionamiento. El mismo índice está en el borrador y en el compositor, entre la barra de herramientas y el texto.
- **Impacto**: Fricción en cada recorrido con teclado de la página del documento y al redactar enmiendas. No es una trampa: Escape lo pliega.
- **Propuesta**: Tabindex itinerante en `ContentOutlineList`: solo el título actual (o el primero) con `tabindex=0` y el resto con `-1`, para que la lista sea una sola parada. Mantener la apertura al enfocar.

### Prioridad 3

#### ACC-ENM-9. El foco se pierde tras confirmar, responder o editar en línea

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/amendment/Detail.vue:1142-1173`, `app/components/amendment/Detail.vue:1194-1214`, `app/components/amendment/Relations.vue:136-256`, `app/components/amendment/Composer.vue:955-1007`, `app/components/amendment/PositionPanel.vue:198-249`, `app/components/amendment/Acceptances.vue:240-270`, `app/components/transactional/AuthorAnswer.vue:145-173`
- **Qué pasa**: «Retirar» y «Eliminar» cambian el botón por un grupo sin nombre cuyo botón de confirmar repite la etiqueta, sin mover el foco ni devolverlo al cancelar. «Añadir relación», la papelera de una relación, «Mantener la mía», guardar o cancelar la respuesta del presentador y los botones de respuesta a una transaccional desaparecen con el foco dentro.
- **Cuándo pasa**: La Secretaría pulsa «Retirar» con lector de pantalla y no oye la pregunta «¿Retirar esta enmienda?».
- **Impacto**: La confirmación de acciones irreversibles pasa desapercibida y hay que reencontrar el sitio tras cada acción (WCAG 2.4.3). La vía masiva, «Revisar enmiendas», ya gestiona bien el foco.
- **Propuesta**: Aplicar el patrón de `AuthorAnswer.vue:133-143` y `ReviewPanel.vue:231-236`: enfocar el botón de confirmar, nombrar el grupo con la pregunta (`aria-labelledby`) y devolver el foco al cancelar. Empezar por Detail; luego Relations (primer control del formulario y, tras borrar, el título de la sección) y «Mantener la mía».

#### ACC-ENM-10. El directo no anuncia los desenlaces sin votación de la enmienda en debate

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/pages/asambleas/[assembly]/directo.vue:477-542`, `app/components/live-view/-model.ts:127-138`, `app/components/live-view/Debate.vue:168-174`, `server/utils/domain/amendments.ts:3707-3724`
- **Qué pasa**: La región viva anuncia el cambio de enmienda, el turno de palabra y la votación, pero no que la enmienda en debate se apruebe por asentimiento o como de forma (no crea fila de votación), decaiga, se retire, se transaccione, se incorpore o se inadmita: el distintivo cambia en silencio.
- **Cuándo pasa**: La Mesa aprueba por asentimiento la enmienda 12, el desenlace más frecuente sin votación, y un delegado ciego que sigue la sesión en el móvil no recibe confirmación.
- **Impacto**: Bajo, porque la Mesa lo dice en voz alta, pero la región viva falla en los desenlaces más comunes.
- **Propuesta**: Un watch de `debated.value?.state` que, si la enmienda es la misma y pasa a un estado final (aprobada y rechazada incluidas), anuncie «{código}: {liveView.state.X.label}», salvo que la votación ya lo haya anunciado.

#### ACC-ENM-11. La fuente de lectura elegida no llega a títulos, tablas y varias justificaciones

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/assets/css/main.css:384-394`, `app/assets/css/main.css:470-477`, `app/components/live-view/Debate.vue:209`, `app/components/live-view/Debate.vue:230`, `app/components/amendment/Summary.vue:206-211`, `app/components/amendment/Composer.vue:1491-1500`, `app/components/transactional/Composer.vue:954-961`
- **Qué pasa**: Los títulos (`h2`-`h5`, `.cx-heading`) y los `th` del contenido fijan `var(--font-sans)` y anulan la preferencia, también dentro de los diffs. La justificación se lee sin `content-font` en el directo y en el anexo del consolidado, y se escribe sin ella en los dos compositores, aunque en el resto de sitios se lee con ella.
- **Cuándo pasa**: Un delegado con OpenDyslexic lee en el directo la justificación en Raleway, y escribe la suya en Raleway aunque luego la relee en OpenDyslexic.
- **Impacto**: La adaptación se aplica de forma desigual a lo que se lee y se escribe.
- **Propuesta**: Apuntar las reglas de títulos y `th` a `var(--user-content-font)` (con Raleway ya equivale a `--font-sans`) y revisar a ojo cómo queda OpenDyslexic en las barras burdeos. Añadir `content-font` a esas justificaciones y a los dos `UTextarea` de justificación, como ya hace `session/TransactionalComposer.vue:489`.

#### ACC-ENM-12. Los códigos de procedencia no se leen sobre la barra burdeos de los títulos de nivel 1

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/assets/css/main.css:154-159`, `app/assets/css/main.css:341-358`, `app/assets/css/main.css:590-597`, `app/assets/css/main.css:739-746`, `app/assets/css/main.css:849-856`
- **Qué pasa**: `.cx-ref` y el subrayado de `.cx-prov` toman `--cx-prov-color`, que nada redefine dentro de `.rich-text h2` (#792225). En modo claro dan entre 1,45:1 y 2,0:1 y no llegan al 3:1 del texto grande (WCAG 1.4.3); en modo oscuro pasan.
- **Cuándo pasa**: Una enmienda aprobada cambia o añade un título de nivel 1, y en el consolidado (página del documento, `consolidado.vue` y panel de la consola de la Mesa) no se ve qué enmienda lo cambió.
- **Impacto**: Se pierde la procedencia justo en los cambios de estructura.
- **Propuesta**: Redefinir `--cx-prov-0..5` en `.rich-text :is(h2, .cx-heading-2)` con los valores de la paleta oscura, como hace :739-746 con ins y del. Revisar igual los subrayados de procedencia en `th` y en celdas con relleno.

#### ACC-ENM-13. En el consolidado, cada fragmento enmendado es un botón que sustituye su texto

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `app/components/content/ContentView.vue:168-197`, `shared/utils/content/render.ts:328-333`, `shared/utils/content/render.ts:392-394`, `app/pages/asambleas/[assembly]/documentos/[document]/consolidado.vue:303-310`, `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:1791-1799`
- **Qué pasa**: Con `interactive`, cada `.cx-prov` recibe `role="button"`, `tabindex=0` y un `aria-label` «{texto} (de la enmienda {código})» que sustituye al contenido; el superíndice con el código es `aria-hidden`. Los hijos de un botón son presentacionales: un enlace dentro deja de ser enlace y el párrafo no se puede leer por frases.
- **Cuándo pasa**: En el consolidado de un posicionamiento con 40 enmiendas aprobadas, cada párrafo insertado o modificado es un «botón» que el lector lee de golpe.
- **Impacto**: La vista que dice de qué enmienda sale cada parte del texto final es pesada con lector de pantalla; afecta a pocos usuarios.
- **Propuesta**: Quitar role y aria-label de `.cx-prov`, convertir `.cx-ref` en `<button>` sin `aria-hidden` y con nombre «Enmienda 12», y añadir un sr-only «(de la enmienda 12)» tras el fragmento. Las paradas no bajan, pero el texto vuelve a ser texto. El clic con ratón sobre el fragmento sigue igual.

#### ACC-ENM-14. Los marcadores del margen no dicen a qué párrafo van y siguen el orden de las enmiendas

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/content/ContentView.vue:130-139`, `app/components/content/ContentView.vue:474-515`, `app/composables/amendment/workspace.ts:813-840`, `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:401-410`, `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:1659-1666`
- **Qué pasa**: En «Original» los marcadores son botones llamados «{n} enmiendas afectan a este bloque», sin decir qué bloque, aunque la página ya tiene `blockReference()` («3. Devolución · párrafo 2»). `amendmentBlockMarkers` los ordena por enmienda, no por posición en el texto, así que una enmienda que toca los artículos 3 y 20 hace saltar el foco del 20 hacia atrás (WCAG 2.4.3).
- **Cuándo pasa**: Quien tabula por los marcadores de un documento largo oye recuentos sin lugar y en un orden que no es el del texto.
- **Impacto**: El mapa de qué enmiendas tocan cada párrafo no sirve sin vista; la lista ya da el dato en orden del texto, con los solapes nombrados.
- **Propuesta**: Ordenar `markerEntries` por la posición del bloque en el texto y pasar a ContentView una función `markerName(blockId)` hecha con `blockReference`: «3. Devolución · párrafo 2: 2 enmiendas, se solapan».

#### ACC-ENM-15. Los niveles de título del documento y de la enmienda se mezclan

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `shared/utils/content/render.ts:229-233`, `app/components/content/ContentView.vue:162-165`, `app/components/content/ContentView.vue:220-240`, `app/components/document/DocumentHeader.vue:212-217`, `app/components/amendment/Detail.vue:604`, `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:1194-1236`
- **Qué pasa**: El título del documento, los títulos de nivel 1 del contenido y el código de la enmienda son todos h2 (en `consolidado.vue`, el h2 «Texto» queda al nivel de los del propio texto). En «Con la enmienda», los bloques que se solapan llevan `aria-current="true"`, que se anuncia como «actual», no como solape.
- **Cuándo pasa**: Con NVDA, navegando por títulos, las secciones del documento se mezclan con la ficha de la enmienda.
- **Impacto**: Moverse entre el texto y la enmienda cuesta más sin vista.
- **Propuesta**: Opción `headingOffset` en `renderBlocks` y `renderAnnotated` para que el contenido empiece en h3, ampliando el selector de `readOutline` y restando el desplazamiento al calcular `level` (si no, se rompe el índice lateral). Una prop `selectedLabel` en ContentView que en «Con la enmienda» ponga un sr-only «(se solapa con otras enmiendas)» en vez de `aria-current`; en la transaccional, «actual» sigue valiendo.

#### ACC-ENM-16. El contenido no declara `lang="es"`

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/app.vue:32-36`, `app/components/content/ContentView.vue:508-515`, `shared/utils/content/render.ts:299-326`, `app/components/amendment/Detail.vue:738-743`
- **Qué pasa**: El único `lang` es el de `<html>`, que sigue a la interfaz. Ni `.cx-content` ni las justificaciones llevan `lang`.
- **Cuándo pasa**: Un delegado con la interfaz en inglés y NVDA (por ejemplo, de Erasmus) oye el RRI y sus enmiendas con fonética inglesa.
- **Impacto**: El grupo es muy pequeño, pero para él la lectura queda casi bloqueada (WCAG 3.1.2).
- **Propuesta**: `lang="es"` en el contenedor `.cx-content` y en los párrafos de justificación; las etiquetas sr-only del diff y `.cx-fmt-label` que genera `render.ts` llevan entonces el `lang` de la interfaz. No hace falta en cada título de lista. El PDF se queda como está: pdfmake declara un solo idioma y sus etiquetas están traducidas.

#### ACC-ENM-17. El editor desactiva la autocorrección y las mayúsculas del teclado del móvil

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `node_modules/@nuxt/ui/dist/runtime/components/Editor.vue:78-82`, `app/components/content/BlockEditor.client.vue:1197-1242`
- **Qué pasa**: UEditor pone `autocorrect="off"` y `autocapitalize="off"` en el contenteditable, y BlockEditor, que usan los cuatro compositores y el borrador, no los cambia. El corrector ortográfico sigue activo.
- **Cuándo pasa**: Quien redacta en el móvil una enmienda tardía o una transaccional: iOS deja de poner tildes («accion») y Android pierde la mayúscula tras el punto.
- **Impacto**: Más erratas en textos que se votan y se incorporan tal cual, y más esfuerzo para quien escribe con dificultad. Es usabilidad, no un criterio WCAG.
- **Propuesta**: Pasar `autocorrect="on"` y `autocapitalize="sentences"` como atributos de `<UEditor>` (se aplican después de los valores por defecto) o en `editorProps.attributes`.

#### ACC-ENM-18. Los identificadores largos sin cortes desbordan en móvil

- **Esfuerzo**: S · **Verificación**: por confirmar
- **Dónde**: `app/assets/css/main.css:361-366`, `app/assets/css/main.css:694-696`, `app/components/amendment/Detail.vue:611`, `app/components/amendment/Detail.vue:738-743`, `app/components/proponent-review/AmendmentStep.vue:384-389`, `app/components/live-view/Debate.vue:209`, `app/components/live-view/Debate.vue:230`
- **Qué pasa**: `.rich-text`, `.content-font` y las justificaciones (`whitespace-pre-line`) no tienen corte de palabra, mientras el resto de la app usa `break-words`. El lugar de la enmienda en la ficha se corta con `truncate`.
- **Cuándo pasa**: Una justificación pega un enlace de Drive (33-44 caracteres sin cortes) y se lee en la hoja lateral de un móvil de 360 px: la línea se sale y aparece desplazamiento horizontal (WCAG 1.4.10). Las URL habituales, como las del BOE, suelen saltar tras «/».
- **Impacto**: Bajo y dependiente de lo que se escriba.
- **Propuesta**: `overflow-wrap: break-word` en `.rich-text` y `.content-font` (no `anywhere`, que encogería las tablas) y `break-words` o `wrap-anywhere` en los cuatro párrafos de justificación. Cambiar el `truncate` del lugar por `line-clamp-2`.

#### ACC-ENM-19. El diff dice dónde empieza un cambio pero no dónde acaba

- **Esfuerzo**: S · **Verificación**: por confirmar
- **Dónde**: `shared/utils/content/render.ts:299-326`, `app/components/content/ContentView.vue:99-111`, `app/components/content/ContentView.vue:231`
- **Qué pasa**: Cada `ins`, `del` y `.cx-fmt` lleva delante un sr-only («Se añade:», «Se quita:», «Cambia el formato:») y ninguna marca de cierre. Los roles insertion y deletion existen, pero que el lector anuncie el final depende de él y de su configuración.
- **Cuándo pasa**: «en el plazo de quince días hábiles» pasa a «treinta días hábiles» y se oye «Se quita: quince Se añade: treinta días hábiles», sin saber si «días hábiles» es nuevo.
- **Impacto**: Un delegado ciego puede entender mal el alcance de lo que vota.
- **Propuesta**: Probar antes con NVDA y Chrome, JAWS y VoiceOver. Si no anuncian el final, añadir un cierre sr-only corto («fin») dentro de cada elemento, con claves nuevas en `diffLabels`; `readOutline` ya quita `.sr-only`.

## Accesibilidad general

Este apartado cubre el uso con teclado y con lector de pantalla, el contraste, las regiones vivas y el idioma de la proyección. La base es sólida: el diff, los colores de estado y la mayoría de las vistas ya cumplen. No hay fallos graves; lo que queda son fallos puntuales que se arreglan con cambios pequeños y localizados. Los dos que más afectan a una sesión son los atajos de la consola y el «Quitar» de un turno de palabra.

### Prioridad 2

#### ACC-1. Los atajos de una tecla de la consola siguen activos dentro del recuento y otros diálogos

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/pages/asambleas/[assembly]/sesion.vue:155-198`, `app/composables/session/useSessionConsole.ts:857-869`, `app/composables/session/useSessionConsole.ts:920-934`, `app/composables/session/useSessionConsole.ts:1011-1035`, `app/components/session/HeadcountPanel.vue:124`
- **Qué pasa**: los atajos solo se pausan con `anyDialogOpen`. Esa lista no incluye el modal de recuento, que usa un `ref` local, ni Preferencias ni Bienvenida. `defineShortcuts` solo se calla con el foco en un campo de texto, y tanto la X del modal como las casillas de reka son botones. Si ninguna tarjeta tiene el foco, `a` aprueba por asentimiento la enmienda en debate y `l` la declara decaída, en los dos casos sin confirmación.
- **Cuándo pasa**: en un recuento de 40 consejos, la Vocalía marca casillas con el ratón y sigue tecleando para filtrar sin haber vuelto a pulsar en «Buscar un miembro».
- **Impacto**: la decisión falsa sale al momento en la proyección y en todos los móviles, y queda en el historial. Solo se deshace con el toast de 5 s o con «Reabrir».
- **Propuesta**: en `withFocused` y `move`, salir si `document.activeElement?.closest('[role="dialog"]')`. No copiar la guarda `[role="menu"]` de `Detail.vue`, porque el menú de la tarjeta anuncia `l` y `t`. Otra opción es mover el `open` del recuento al contexto de la consola, como ya se hace con `speakerRenameDialog`.

#### ACC-2. Quitar un turno de palabra solo se puede deshacer en un toast de 5 segundos

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/session/SpeakersPanel.vue:223`, `app/composables/session/useSessionSpeakers.ts:205-252`, `app/composables/session/sessionModel.ts:1034-1061`, `app/app.vue:40`, `app/pages/asambleas/[assembly].vue:320-325`, `app/pages/asambleas/[assembly].vue:607-609`, `app/pages/admin/usuarios.vue:473-474`
- **Qué pasa**: «Quitar» llama a `remove` sin pedir confirmación, y la única forma de llegar a `restore` es la acción del toast. Los turnos quitados no aparecen en ninguna lista. `UApp` no fija `toaster`, así que todos los toasts duran 5 s. Además, varias pantallas escriben el mismo texto en una región sr-only y en un toast con `role="alert"`, y el lector lo lee dos veces.
- **Cuándo pasa**: con 8 turnos en espera, la Vocalía quita a la persona equivocada mientras mira a la sala. Cuando vuelve a mirar la pantalla, el toast ya ha desaparecido.
- **Impacto**: hay que volver a apuntar a la persona y subirla con las flechas, lo que cuesta tiempo y crea fricción en la sala. Además, incumple WCAG 2.2.1, porque el límite de tiempo no tiene alternativa.
- **Propuesta**: añadir un pliegue discreto «Quitados», cerrado por defecto, con «Volver a la cola». Los datos ya están en `byId`. No mezclarlos con «Ya han hablado». Dar a los toasts con acción una duración de al menos 10 s, como en `revisar.vue:630`. Quitar la línea sr-only cuando el toast dice lo mismo; `type: 'background'` no sirve para esto.

#### ACC-3. Cada cuenta atrás es una región viva y el lector las anuncia todas a la vez

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/common/Countdown.vue:64-73`, `app/components/agenda/DocumentRow.vue:154-161`, `app/pages/asambleas/[assembly]/documentos/index.vue:357-363`, `app/pages/asambleas/[assembly]/orden-del-dia/[item].vue:353`, `app/components/calendar/MilestoneTimeline.vue:115-121`, `app/pages/asambleas/[assembly].vue:585`, `app/utils/format.ts:165-172`
- **Qué pasa**: todas las instancias llevan `aria-live="polite" aria-atomic="true"`. `useAppNow` avanza cada minuto y `formatRelative` trunca el tiempo, así que el texto cambia cada hora durante el último día y cada minuto durante la última hora. Cada fila de documento lleva su propia cuenta atrás, y el hub añade otra en todas sus páginas.
- **Cuándo pasa**: en la última hora antes del cierre de enmiendas, con 15 a 30 documentos que comparten el mismo plazo, el lector encola cada minuto decenas de avisos iguales («Enmiendas: cierran dentro de 41 minutos»).
- **Impacto**: con lector de pantalla, «Documentos» y la página de un punto quedan casi inutilizables justo cuando más se enmienda.
- **Propuesta**: quitar `aria-live` y `aria-atomic` de `CommonCountdown`, porque el tiempo restante se lee igual al llegar a él. Un único aviso de umbrales (queda una hora, cerrado) es opcional.

#### ACC-4. El foco vuelve al principio de la página al cerrar un diálogo abierto desde un menú

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `app/components/shell/UserMenu.vue:27-39`, `app/components/session/AmendmentCard.vue:202,301,312`, `app/components/session/NowAmendment.vue:230,246,279`, `app/components/session/SpeakersPanel.vue:188`, `app/pages/asambleas/[assembly].vue:291`, `app/pages/asambleas/[assembly]/orden-del-dia/index.vue:111,116`, `app/pages/asambleas/[assembly]/convocatoria/index.vue:191`, `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:363,778`, `app/components/document/ManageActions.vue:152,160`, `app/pages/admin/usuarios.vue:915`, `app/composables/session/useSessionConsole.ts:920-992`
- **Qué pasa**: al cerrar un diálogo, reka devuelve el foco al elemento que estaba activo al abrirlo. Si se abrió desde un menú, ese elemento es un ítem que ya no existe, y el foco acaba en `<body>`. `UserMenu.vue` documenta el fallo y lo arregla con `onCloseAutoFocus`, pero ningún otro sitio lo hace.
- **Cuándo pasa**: la Mesa cierra «Relacionar» o «Inadmitir» abiertos desde «Más» en una tarjeta. Un delegado cierra el composer de un transaccional abierto desde «Más» en el documento. La Secretaría cancela «Más estados».
- **Impacto**: quien usa teclado o lector pierde su sitio en una cola de 60 enmiendas o en un texto de 30 páginas, y le pasa en cada acción.
- **Propuesta**: crear un helper compartido (`useMenuDialogFocus`) que devuelva `content: { onCloseAutoFocus }` y lleve el foco al botón que abrió el menú. Aplicarlo a cada `UModal` o `USlideover` que se abra desde un ítem de menú. Como mejora menor, llamar a `focusCard` tras un `runOutcome` con éxito, como ya hace `validateAmendments`.

### Prioridad 3

#### ACC-5. Texto secundario sobre fondos tintados: gris por debajo de 4,5:1 y una etiqueta roja sobre rojo

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/assets/css/main.css:76-90`, `app/components/live-view/VoteResult.vue:25,28,46,54`, `app/pages/proyeccion/[assembly].vue:532-537,565,575`, `app/components/session/NowAmendment.vue:354,360`, `app/components/session/SpeakersPanel.vue:384,388`, `app/components/session/AgendaPanel.vue:98,122`, `app/components/tracking/Summary.vue:94,96,110`, `app/pages/index.vue:225,231`, `app/pages/asambleas/[assembly]/calendario.vue:348`, `app/components/agenda/ItemNumber.vue:26`
- **Qué pasa**: en modo claro, `text-muted` y `text-dimmed` son slate-500. Sobre blanco dan 4,77:1, pero sobre los tintes `/5` y `/10` bajan a entre 3,96 y 4,47:1. Afecta a «A favor / En contra / Abstenciones / Mayoría» del resultado, también en la proyección, donde los `dt` no pasan de 22 px y por tanto no cuentan como texto grande. Afecta también a «Tiene la palabra», al número del punto en curso y a la tarjeta seleccionada del seguimiento. Con `opacity-80`, «Sin publicar» baja a 3,25:1. En «Fuera de plazo», la etiqueta va en `text-error` sobre `bg-error/5`. Se lee, pero AGENTS.md lo prohíbe.
- **Cuándo pasa**: un delegado mira el resultado en el móvil en una sala luminosa, o la sala lo lee en un proyector.
- **Impacto**: incumple WCAG 1.4.3 justo en los datos de las votaciones.
- **Propuesta**: seguir el precedente de `main.css` y usar `text-toned` en el texto secundario sobre tintes. En `Summary.vue:110`, poner la etiqueta en `text-default` y dejar el rojo solo en el icono, el borde y la cifra. Quitar `opacity-80`.

#### ACC-6. «En directo» no anuncia el aviso de la Mesa

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/pages/asambleas/[assembly]/directo.vue:467-541`, `app/pages/asambleas/[assembly]/directo.vue:638-646`, `app/pages/asambleas/[assembly].vue:377-391`
- **Qué pasa**: la región viva `announcement` sigue el punto, el documento, el turno de palabra y la votación, pero no `message`. El aviso de la Mesa es un `UAlert` sin región viva. La pérdida de datos actualizados ya se anuncia en parte con el toast de `useStaleDataNotice`. Además, desde `sm`, el aria-label del botón «Sin actualizar» del hub no empieza por su texto visible (WCAG 2.5.3).
- **Cuándo pasa**: la Mesa publica «Receso; se reanuda a las 16:00» y un delegado ciego que sigue la sesión en el móvil no se entera.
- **Impacto**: quien usa lector de pantalla se queda fuera de los avisos dirigidos a toda la sala.
- **Propuesta**: añadir un `watch(message)` que escriba «Aviso de la Mesa: …» en `announcement`. Si se quiere anunciar la conexión, hacerlo solo en la transición y por esa misma región. No poner `role="status"` en la línea de conexión, porque «Actualizado a las HH:MM» se leería sin parar. Hacer que el aria-label del botón empiece por «Sin actualizar».

#### ACC-7. La proyección sale en el idioma de quien la abre

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/session/ConsoleToolbar.vue:17-21`, `app/composables/assembly/useAssemblySections.ts:56`, `app/pages/index.vue:244`, `app/pages/asambleas/[assembly]/sesion.vue:103-107`, `app/pages/proyeccion/[assembly].vue`
- **Qué pasa**: los cuatro enlaces se construyen con `localePath` y la estrategia es `prefix_except_default`. Con la interfaz en inglés abren `/en/proyeccion/...` y todos los rótulos salen en inglés. Además, `detectBrowserLanguage` manda a `/en` a cualquier equipo nuevo cuyo navegador esté en inglés.
- **Cuándo pasa**: el portátil del proyector o de la sede está configurado en inglés, o un miembro de la Mesa prefiere el inglés.
- **Impacto**: en una asamblea en español, la sala lee «APPROVED · In favour · Against», y hay que reabrir la pestaña en el proyector a mitad de sesión.
- **Propuesta**: fijar la página en español, limitando sus locales a `es` con la configuración i18n por página o redirigiendo `/en/proyeccion/*` a `/proyeccion/*`. Así resiste también recargas y enlaces abiertos a mano. No hace falta un selector de idioma en la proyección, porque nadie maneja esa pantalla.

#### ACC-8. Los formularios no llevan el foco al primer error

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/agenda/NewDocumentModal.vue:766-772,1096-1103`, `app/components/tracking/ExpectedDocumentModal.vue:260`, `app/components/agenda/ItemFormModal.vue:236`, `app/components/assembly/AssemblyCreateModal.vue:241`, `app/components/review/CorrectionModal.vue:80`, `app/pages/asambleas/[assembly]/ajustes.vue:340`, `app/pages/admin/miembros.vue:673`, `app/components/document/MetadataForm.vue:743-758`
- **Qué pasa**: cuando falla la validación, `UForm` no mueve el foco y el error de `UFormField` no es una región viva. Solo `MetadataForm.check()` lo resuelve: despliega la sección, centra el campo y enfoca el primer error. En `NewDocumentModal` el botón está en el pie, lejos del error.
- **Cuándo pasa**: un consejo pulsa «Continuar» sin elegir «Tipo». Con lector de pantalla no oye nada, y en el móvil el error queda fuera de la vista.
- **Impacto**: parece que el botón no funciona, y los usuarios no técnicos abandonan o lo repiten.
- **Propuesta**: extraer de `MetadataForm.check()` un helper compartido y engancharlo como `@error` en cada `UForm`.

#### ACC-9. Al buscar o filtrar en «Documentos» no se dice cuántos quedan

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/pages/asambleas/[assembly]/documentos/index.vue:215-220`, `app/pages/asambleas/[assembly]/documentos/index.vue:230-279`, `app/pages/asambleas/index.vue:195-206`
- **Qué pasa**: la línea del recuento siempre muestra el total. Al buscar o al cambiar el estado o el tipo, nada anuncia el resultado. El estado vacío lleva `role="status"`, pero se inserta con `v-else-if` ya con su contenido, y así no se anuncia de forma fiable. El listado de asambleas sí lo anuncia. «Solo lo que me queda por leer» ya incluye el número en su etiqueta.
- **Cuándo pasa**: alguien con lector de pantalla busca «financiación» y no sabe si hay 0 o 12 resultados hasta que recorre la página.
- **Impacto**: es una molestia en la página que más se usa para preparar la asamblea.
- **Propuesta**: que la misma línea diga «N de M documentos» mientras haya filtros, dentro de una región `role="status"` que esté siempre en el DOM y con un pequeño retardo mientras se escribe. Sigue siendo una sola línea discreta y también sirve a quien ve la pantalla.

#### ACC-10. Las delegaciones de «En directo» solo muestran siglas en el móvil

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/common/MemberBadge.vue:42-56`, `app/components/live-view/Attendance.vue`
- **Qué pasa**: el nombre completo va en un `UTooltip` sobre un `UBadge` que no recibe el foco, así que no se abre ni al tocar ni con el teclado. El lector sí lo lee gracias a `sr-only`. Lo más visible ya está resuelto (`SpeakerName.vue`, `show-name` en `Debate.vue`, el popover «+N más»). Falta la lista de asistentes y delegaciones.
- **Cuándo pasa**: una delegada nueva consulta en el móvil las delegaciones del último recuento y solo ve «CEUCLM → DAUC3M».
- **Impacto**: menor, porque en la sala se habla por siglas.
- **Propuesta**: usar `show-name` en la lista de delegaciones de `Attendance.vue` y, si se quiere, también en las listas plegadas «en la sala» y «asisten». No hacer enfocable cada insignia, porque supondría más de 40 paradas de tabulación.

## Seguridad, visibilidad y permisos

Esta área cubre la configuración de nuxt-security, el inicio de sesión y el relevo de cuentas, la gestión de roles y permisos, lo que dejan ver los PDF y los historiales, y la trazabilidad de votaciones y recuentos. Las reglas de visibilidad del servidor se cumplen en general. Los riesgos están en dos sitios: los valores por defecto de nuxt-security, que pueden bloquear la sesión, y los caminos manuales del relevo anual, que fallan sin avisar.

### Prioridad 1: antes de la próxima asamblea

#### SEG-1. El filtro XSS de nuxt-security rechaza textos con «<» o «>» y congela el servidor en cada subida

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `nuxt.config.ts:164-209`, `node_modules/nuxt-security/dist/defaultConfig.mjs:58-61`, `node_modules/nuxt-security/dist/runtime/server/middleware/xssValidator.js:17-37`, `app/components/amendment/Composer.vue:706`, `app/composables/api/useApi.ts:27`
- **Qué pasa**: `xssValidator` no está configurado, así que se aplica a GET y POST en todas las rutas. Pasa el cuerpo por `JSON.stringify` y FilterXSS y responde 400 si algo cambia. Fallan `>50 %`, `<<Ley>>`, `a -> b` y `x < y`; en cambio `<b>hola</b>` pasa sin cambios, así que no protege de nada. En un POST multipart serializa el Buffer como un array de números. Medido con el heap de producción (448 MB): 8 MB bloquean 2,8 s y 20 MB bloquean 5,8 s y ocupan 323 MB.
- **Cuándo pasa**: los textos de la 80.ª AGO no tienen `<` ni `>`. El fallo llega con lo que se escribe a mano en el primer guardado (POST): texto nuevo, justificación, notas de corrección o de resultado, títulos y turnos de palabra. El usuario solo lee «Revisa el formulario». Una foto o un DOCX de 3-8 MB congela la sala 1-3 s.
- **Impacto**: una enmienda o transaccional bloqueada del todo con un mensaje engañoso. La consola, la proyección y el SSE se congelan con cada subida grande, y cerca de 20 MB hay riesgo de quedarse sin memoria.
- **Propuesta**: poner `xssValidator: false` en `nuxt.config.ts`; Zod, `blocksSchema` y el renderizado escapado ya cubren el riesgo. Añadir un test HTTP que haga POST de una enmienda con «<<Ley>>» y «>50 %» y espere 201.

#### SEG-2. El limitador de peticiones cuenta por IP: toda la sala comparte un cubo para /api/assemblies

- **Esfuerzo**: S · **Verificación**: por confirmar
- **Dónde**: `nuxt.config.ts:34-41`, `nuxt.config.ts:166-171`, `node_modules/nuxt-security/dist/runtime/server/middleware/rateLimiter.js:26`, `node_modules/nuxt-security/dist/runtime/nitro/context/index.js:22-34`, `server/utils/domain/events.ts:74-83`, `app/composables/readMarks/useReadMarks.ts:80-90`
- **Qué pasa**: la clave es `ip + route`, y la ruta es la regla que encaja. Como existe `/api/assemblies/**`, todas las lecturas, escrituras y reconexiones SSE de una IP comparten 12.000 peticiones por ventana fija de 5 min. Cada evento llega a todos, borradores incluidos. Por cada lote, cada dispositivo recarga la agenda y las marcas de lectura, y en la página de un documento también el documento y sus enmiendas.
- **Cuándo pasa**: un bloque de votaciones con 80-100 dispositivos tras la IP pública del recinto (NAT de eduroam) y 40-50 lotes cada 5 min. Hasta que acaba la ventana todo responde 429, y un 429 en `/live` empuja más clientes al sondeo.
- **Impacto**: si la Mesa comparte red con la sala, no puede proyectar ni registrar resultados durante hasta 5 min. Si no la comparte, los delegados pierden el directo en plena votación.
- **Propuesta**: un limitador propio por usuario o sesión tras la autenticación. La alternativa es `rateLimiter: false` en `/api/assemblies/**`, dando un `rateLimiter` explícito a `.../export`, `.../file`, `.../import`, `.../images`, `.../convocation` y `/api/members/sync`, que si no heredarían el `false`. Antes, contar peticiones por IP y ventana en los logs de nginx de una sesión real.

### Prioridad 2

#### SEG-3. Cualquier fallo al comprobar la sesión manda a /login, no solo un 401

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/middleware/auth.global.ts:1`, `app/middleware/auth.global.ts:19-37`, `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:1146-1157`, `app/composables/security/useMe.ts:93-98`
- **Qué pasa**: el `catch` trata un fallo de red, un 5xx durante un despliegue o un 429 (SEG-2) igual que una sesión caducada. En el cliente se repite en cada navegación pasados 2 minutos, también en las que solo cambian la query: la página del documento hace `router.replace` con `?enmienda=` al abrir cada enmienda. `useMe.refresh`, en cambio, conserva los datos ante fallos transitorios.
- **Cuándo pasa**: un delegado con la Wi-Fi de la sede intermitente va pasando enmiendas en un debate, se pierde una petición y aparece «Iniciar sesión con Google».
- **Impacto**: una salida falsa de la sesión en el entorno más frágil. La persona pierde la página y repite el OAuth con una red que se cae.
- **Propuesta**: redirigir solo cuando `errorStatus(error) === 401`, porque esta ruta nunca responde 403. Ante null, 5xx o 429, dejar `sessionVerified` y `lastCheckedAt` como estaban y seguir con la navegación.

#### SEG-4. Las exportaciones PDF se maquetan en el hilo principal del único proceso

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `server/plugins/export-worker.ts:100`, `server/plugins/export-worker.ts:190-208`, `node_modules/pdfmake/js/Printer.js:78`, `server/utils/export/enqueue.ts:54`, `server/api/assemblies/[assembly]/export.post.ts:26`, `app/pages/asambleas/[assembly]/documentos/[document]/consolidado.vue:183-192`
- **Qué pasa**: el worker de pg-boss es un plugin de Nitro y pdfmake maqueta de forma síncrona. Medido con el pdfmake del proyecto: unos 1,5 s fijos más ~0,15 s por página, 6,3 s con 28 páginas y 60 enmiendas, y ~20 s para un dosier de 143 páginas. No hay caché ni deduplicación. Cualquiera que vea la asamblea puede pedir el dosier aunque ningún botón lo ofrezca.
- **Cuándo pasa**: 5-10 delegados piden el PDF limpio o el anotado antes de un debate, y la sala sufre 30-60 s de congelaciones de 4-7 s en el SSE, la consola de la Mesa y la proyección.
- **Impacto**: la sesión se degrada una y otra vez por un uso legítimo.
- **Propuesta**: mover pdfmake a un `worker_threads` o a un proceso hijo persistente con las fuentes ya cargadas, como el conversor DOCX. Después, cachear por documento, variante, idioma, versión y clase de visibilidad, y reutilizar un trabajo pendiente igual. Restringir `POST /api/assemblies/[assembly]/export` a `assembly:manage` o quitarlo.

#### SEG-5. El PDF anotado del personal enseña cargos de la CEA y enmiendas nunca publicadas

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `server/utils/export/buildData.ts:262-266`, `server/utils/export/buildData.ts:296`, `server/utils/export/mapping.ts:214-217`, `server/utils/export/pdfBuilder.ts:653`, `shared/utils/schemas/export.ts:22-24`
- **Qué pasa**: el anexo del anotado se construye con el actor que lo pide. Los autores pasan por `visibleAcronym(actor, …)`, así que «CEA 3» sale firmada por «SG». Las filas salen de `loadAmendmentVisibility` con ese mismo actor, y por eso entran las presentadas sin publicar que no son borradores (retiradas antes de publicarse, inadmitidas), con su código y su estado. El PDF limpio no revela nada.
- **Cuándo pasa**: tras un debate, la Secretaría exporta el anotado y lo sube a la carpeta de Drive de la asamblea o lo adjunta al acta (R-CON-02).
- **Impacto**: rompe la regla de que los PDF muestran el «CEA» genérico y expone retiradas privadas de otros miembros. El fichero se reenvía y se archiva sin ninguna marca de uso interno.
- **Propuesta**: en el worker, construir siempre el anexo y las marcas como las vería un delegado, con un actor público sintético: solo las enmiendas publicadas y el «CEA» genérico. Si hace falta una variante interna, ponerla en el menú «Más» con «Uso interno» en el pie.

#### SEG-6. Los actos de la Secretaría hechos con la cuenta de su cargo salen «por CEA»

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `server/utils/domain/events.ts:68-69`, `server/utils/auth/roleSync.ts:807-808`, `server/utils/domain/visibility.ts:566-574`, `server/utils/domain/amendments.ts:4685-4696`, `server/utils/domain/documents.ts:2967`, `app/components/amendment/History.vue:487-493`
- **Qué pasa**: `recordEvent` guarda el miembro del actor, y la sincronización vincula también los roles protegidos a su cargo. Para quien no ve los cargos, `redactEventActor` convierte en «CEA» sin nombre también las validaciones, correcciones, inadmisiones y resultados que registra la Secretaría o la Presidencia.
- **Cuándo pasa**: un autor abre el historial de su enmienda y lee «Declarada inadmisible · por CEA». En el historial del documento pasa lo mismo, y conviene revisar `news[].by` de `/api/me/work`.
- **Impacto**: parece que la CEA, parte interesada porque también presenta, decide sobre las enmiendas de los miembros. Es fácil que acabe en protestas en sala.
- **Propuesta**: en los eventos que solo hace el personal (validated, published, correction_requested, reclassified, authors_changed, admitted, inadmissible, votos y reopened), no devolver actor a quien no ve los cargos. Otra opción es guardar `as: "secretaria" | "mesa"` en el payload según el permiso usado y pintar «por la Secretaría». Nunca en amendment_created ni en amendment_submitted, que siguen como «CEA».

#### SEG-7. Quien entra con su Google personal queda como «Otro» sin pista para cambiar de cuenta

- **Esfuerzo**: S · **Verificación**: confirmado (que Google se salte el selector, por confirmar)
- **Dónde**: `app/pages/login.vue:69-89`, `app/pages/index.vue:121-128`, `app/components/shell/-welcome.ts:62-70`, `server/utils/domain/documents.ts:433-434`, `server/utils/auth/auth.ts:364-375`, `i18n/locales/es.json:2464`
- **Qué pasa**: el login no dice qué cuenta usar. Una Gmail que la Intranet no conoce queda como Otro, y la portada le dice «Tu cuenta es de invitado». Es falso, porque Invitado es otro rol, y además sustituye a `home.todo.emptyNoMember`, el único texto que explica la vinculación. El aviso del compositor nunca se ve: sin `amendment:create` ni miembro no aparece «Presentar enmienda». Y como `socialProviders.google` no lleva `prompt: "select_account"`, cerrar sesión y volver a entrar puede devolverlo a la misma Gmail.
- **Cuándo pasa**: en cada relevo, el representante nuevo entra con su Gmail personal, lo lee todo y descubre el último día de enmiendas que no puede presentar.
- **Impacto**: enmiendas fuera de plazo y trabajo extra para la Secretaría.
- **Propuesta**: (1) una línea gris bajo el botón del login: «Entra con la misma cuenta de Google que usas en la Intranet». (2) Para Otro sin miembro, un texto propio con su email y «Cambiar de cuenta», y la misma variante en la bienvenida. (3) `prompt: "select_account"` en `auth.ts`.

#### SEG-8. El arreglo a mano del relevo en Usuarios se deshace o nunca funciona, y nada lo avisa

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/pages/admin/usuarios.vue:1448-1474`, `app/pages/admin/usuarios.vue:1833-1849`, `server/utils/auth/roleSync.ts:135-148`, `server/utils/auth/roleSync.ts:182-199`, `i18n/locales/es.json:1838`, `i18n/locales/es.json:1843`
- **Qué pasa**: hay dos casos. (a) Si se da Asociado a una Gmail que la Intranet tiene como Invitado u Otros, al volver a entrar la sincronización la devuelve a Otro y borra el miembro. La ayuda del panel nombra Invitado, que solo sube, y omite Otro, CAS, CAI y CdG. (b) Al vincular un miembro a una cuenta Otro, el diálogo promete «Presentará documentos y enmiendas en su nombre», pero sin `amendment:create` no puede presentar.
- **Cuándo pasa**: en la AGO, la Secretaría arregla la cuenta del representante nuevo. Al día siguiente él entra desde el móvil y ya no puede aceptar la transaccional que le pide la Mesa.
- **Impacto**: el arreglo previsto para el relevo falla justo cuando más se necesita.
- **Propuesta**: recomendar la vía que ya dura: dejar la cuenta como Otro, vincularla y darle `document:create` y `amendment:create` como permisos propios. El diálogo de vinculación debe mirar los permisos efectivos y ofrecer una casilla marcada que los añada con `PUT /permissions`. El de cambio de rol debe avisar cuando la Intranet tiene otro tipo. Corregir `editingHelp` en es y en.

#### SEG-9. Los roles de la Mesa y los permisos extra no caducan con el relevo

- **Esfuerzo**: S · **Verificación**: por confirmar
- **Dónde**: `server/utils/auth/roleSync.ts:342-349`, `server/utils/auth/roleSync.ts:369`, `server/utils/auth/adminUsers.ts:49-98`, `server/api/admin/users/index.get.ts:38`, `app/pages/admin/usuarios.vue:178-181`
- **Qué pasa**: Moderador, Secretaria, Presidencia y Admin son roles protegidos. Una Gmail que la Intranet nunca conoció no se vuelve a sincronizar, y `user_permissions` no caduca. La tabla enseña el rol y la insignia «+N» de cada fila, pero el único filtro es «Sin acceso» y la búsqueda no mira el rol.
- **Cuándo pasa**: la Mesa se ratifica en cada AGO. Un Moderador o un `amendment:review` dado a una Gmail personal sigue activo en otoño, salvo que alguien revise la lista a ojo.
- **Impacto**: quien ya no tiene derecho sigue leyendo enmiendas sin publicar y los cargos reales, y puede llevar recuentos. La exposición es ante personas que ya estuvieron dentro, y toda escritura queda auditada.
- **Propuesta**: añadir en `GET /api/admin/users` y en `usuarios.vue` los filtros «Rol» y «Con permisos extra», guardados en la URL (`?access=`). Para ir a la raíz: roles de Mesa por asamblea o un aviso al cerrarla.

### Prioridad 3

#### SEG-10. Las votaciones anuladas o reabiertas no se ven en ningún historial

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/amendment/History.vue:469-484`, `app/composables/activity/-present.ts:523-527`, `server/utils/domain/amendments.ts:3771-3785`, `server/utils/domain/amendments.ts:3934-3963`, `server/utils/domain/documents.ts:2770-2786`, `i18n/locales/es.json:3565`
- **Qué pasa**: el payload de amendment_approved y amendment_rejected ya lleva los votos a favor, en contra y las abstenciones, pero History.vue solo pinta el método, y rejected y reopened caen en `return null`. Reabrir pone `outcomeVoteId` a null y el detalle solo muestra la votación vigente. Al anular la votación final se pide una nota y se promete «La votación queda en el historial», pero `final_vote_annulled` no se pinta en ningún sitio.
- **Cuándo pasa**: la Mesa rechaza CEUM 4 por 12-14-3, reabre por una delegación mal contada y la aprueba por 15-12-2. Al redactar el acta o ante una impugnación, el historial no tiene cifras.
- **Impacto**: la Secretaría no puede reconstruir qué se votó antes de la corrección.
- **Propuesta**: en `detailOf`, añadir `t('amendment.vote.inline', …)` para approved y rejected. En reopened, mostrar `previousStatus` y marcar como anulada la votación cuyo `voteId` coincide con `voidedVoteId`. Pintar el resultado y la nota de `final_vote_annulled` en `-present.ts` y en el panel consolidado, o reescribir la línea 3565 de `es.json` y `en.json`.

#### SEG-11. Corregir un recuento borra quién estaba en sala y quién delegaba

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `server/utils/domain/headcounts.ts:516-540`, `app/components/session/HeadcountPanel.vue:55-57`
- **Qué pasa**: `updateHeadcount` borra y vuelve a escribir las entradas y los invitados, y `headcount_corrected` solo guarda totales. Cada votación conserva su `present`, pero se pierden la lista por miembro y las delegaciones de antes de la corrección.
- **Cuándo pasa**: a las 11:00 la Mesa corrige el recuento de las 9:30 porque CAUB sí estaba. Si luego se discute si su delegación contó en la votación de las 10:15, nadie puede comprobarlo.
- **Impacto**: no queda rastro justo cuando hay más riesgo de disputa sobre quórum y mayorías.
- **Propuesta**: añadir al payload de `headcount_corrected` las altas y bajas por miembro, por delegación y por invitado. Son ids, que `redactPayloadMembers` ya enmascara. Opcional: una línea discreta «Corregido a las 11:02» en HeadcountPanel.

#### SEG-12. Google rechaza el inicio de sesión desde el navegador integrado de Telegram o Instagram en Android

- **Esfuerzo**: S · **Verificación**: por confirmar
- **Dónde**: `app/pages/login.vue:57-93`, `app/composables/security/useAuth.ts:24-33`
- **Qué pasa**: la app no detecta navegadores integrados, y el botón salta directo a Google, que rechaza OAuth en un WebView (`disallowed_useragent`). Gmail y WhatsApp abren los enlaces en Chrome o en Custom Tabs, y ahí sí funciona.
- **Cuándo pasa**: alguien abre en Android un enlace de un grupo de Telegram. Como el WebView no comparte cookies con Chrome, el problema vuelve con cada enlace.
- **Impacto**: un primer acceso que acaba en error, sin salida, para parte de los usuarios.
- **Propuesta**: detectar en el cliente los agentes conocidos (`FBAN|FBAV|Instagram|Line/|Telegram|LinkedInApp|; wv\)`). En ese caso, sustituir el botón por una línea discreta («Google no deja entrar desde el navegador de esta app: ábrelo en Chrome o Safari») con «Copiar enlace».

#### SEG-13. Quien usa la interfaz en inglés vuelve al español en el login y con cada enlace sin prefijo

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/middleware/auth.global.ts:33-36`, `nuxt.config.ts:296-301`, `app/composables/locale/useLocaleSwitcher.ts:46-55`
- **Qué pasa**: el middleware redirige a `/login` sin `localePath`. Con `redirectOn: "root"` la cookie solo actúa en «/». Además, al abrir una ruta sin prefijo, i18n reescribe `user-locale` a «es»: basta un enlace para perder la elección del inglés.
- **Cuándo pasa**: un invitado internacional elige English en la bienvenida, y cada enlace del grupo lo devuelve al español.
- **Impacto**: una fricción repetida para un grupo pequeño. Solo afecta a la interfaz, porque el contenido está en español.
- **Propuesta**: usar `localePath({ path: "/login", query })` en el middleware y añadir una redirección que solo mire la cookie, antes de que i18n la reescriba. No usar `redirectOn: "no prefix"`, que mandaría a /en a quien tenga el navegador en inglés.

## Lógica de enmiendas, documentos, orden del día y plazos

Este apartado cubre el ciclo de las enmiendas y transaccionales, las votaciones y su registro, la presentación de documentos, la numeración del orden del día, la convocatoria y los plazos del calendario. El motor de fondo es sólido; los fallos están en avisos que faltan o que dicen otra cosa, en plazos reglamentarios que el código aún no aplica y en diferencias entre lo que se ve en pantalla y lo que guarda el servidor.

### Prioridad 1: antes de la próxima asamblea

#### DOC-1. Las cuentas atrás dicen «pasado mañana» cuando el plazo cierra mañana

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/utils/format.ts:158-173`, `app/components/common/Countdown.vue:85`, `app/components/document/DocumentHeader.vue:236-251`, `app/components/agenda/DocumentRow.vue:156-161`, `app/components/document/ProgressBanner.vue:107-113`, `app/pages/asambleas/[assembly].vue:585`
- **Qué pasa**: `formatRelative` usa `Intl.RelativeTimeFormat` con `numeric: "auto"` y redondea bloques de 24 h: entre 36 y 59 h escribe «pasado mañana» («in 2 days») aunque el plazo caiga mañana. Sin `maxUnit`, 11 días se leen «dentro de 2 semanas». `Countdown` deja la fecha absoluta en un `title`, que no se ve en el móvil.
- **Cuándo pasa**: un cierre de enmiendas el martes a las 23:59 consultado el lunes a las 08:00. Los cierres a las 23:59 son la norma.
- **Impacto**: el dato clave de la página del documento llega con un día de más; un consejo puede presentar fuera de plazo y quedar a merced de la admisión.
- **Propuesta**: en `formatRelative`, contar días y semanas por día de calendario de Europe/Madrid (como `assemblyDay` en `shared/utils/calendar.ts`) y añadir la hora si es hoy o mañana («mañana a las 23:59»). Fecha absoluta en la línea de `DocumentHeader` (y quizá en la cabecera del hub), no en cada fila del orden del día. Tests de 36 a 59 h.

#### ENM-1. La base de presentes de una votación no es la que la Mesa ve en el formulario

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `server/utils/domain/headcounts.ts:547-578`, `app/components/session/VoteFields.vue:69-149`, `app/components/session/VoteFields.vue:207-215`, `app/components/session/HeadcountPanel.vue:55-57`, `app/components/live-view/Attendance.vue:20`, `app/composables/session/sessionModel.ts:1644-1665`, `app/components/session/FinalVoteDialog.vue:118-119`
- **Qué pasa**: con `denominator: "present"`, `withHeadcount` toma el último recuento, sea del día que sea. (a) El formulario y el panel solo dan la hora, así que un recuento de ayer parece de hoy. (b) Si se vacía «Presentes» («Opcional»), la previsión y la confirmación calculan sobre los votos válidos, pero el servidor rellena el recuento y calcula sobre él; la nota dice «Corregido para esta votación» sin corrección alguna.
- **Cuándo pasa**: día 2 de una AGO sin recuento tras el descanso; o en una AGET, al pasar los resultados del portal con el campo vaciado.
- **Impacto**: con mayoría absoluta o de 2/3 se guarda y proyecta un resultado distinto del confirmado («Aprobada» en la previsión, «Rechazada» en el registro) o sale un 422 inesperado.
- **Propuesta**: solo en el cliente. Mostrar el día si el recuento no es de hoy («de ayer a las 10:15») y una línea discreta si es de otro día natural, sin umbral de horas. Con recuento, quitar «Opcional» y que la previsión use `headcount.present` si el campo está vacío. Test que compare `sessionVoteOutcome` con `evaluateFinalVote` tras `withHeadcount`.

### Prioridad 2

#### ENM-2. Un solo autor puede retirar una transaccional que ya sustituyó las enmiendas de otros miembros

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `server/utils/domain/amendments.ts:561`, `server/utils/domain/amendments.ts:2482-2491`, `server/utils/domain/news.ts:168`, `app/components/session/TransactionalComposer.vue:150-153`, `i18n/locales/es.json:1396`
- **Qué pasa**: `withdrawAmendment` y `can.withdraw` solo exigen ser autor y `submitted`, aunque la transaccional ya sustituyera a sus fuentes, que siguen `transacted` (por diseño). En las de la Mesa todas las partes son autoras. El aviso solo dice «¿Retirar esta enmienda? No se debatirá.», y `news.ts:168` no avisa a la parte no autora de una retirada manual.
- **Cuándo pasa**: la UAM propone T3 sobre UAM 3 y UCM 2; UCM acepta y la Secretaría valida. En el debate la UAM retira T3 desde el móvil.
- **Impacto**: UCM 2 sale del debate y del consolidado sin consentimiento ni aviso. Solo vuelve el texto fusionado si la Mesa reabre T3. Contradice «si no hay acuerdo, se vota la enmienda original» (`docs/proceso-asambleas.md:178`).
- **Propuesta**: si ya sustituyó a sus fuentes (`validatedAt` y `authorsApproval === "accepted"`), 409 a quien no sea la Mesa («Ya sustituye a enmiendas de otros miembros: pide a la Mesa que la retire») y ocultar `can.withdraw`. En `isNewsEvent`, avisar a `overOwn` de la retirada o decaída manual. No devolver las fuentes.

#### ENM-3. El diálogo de votación dice «mayoría simple» mientras propone la absoluta en una reforma

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/session/VoteDialog.vue:32-35`, `app/components/session/VoteDialog.vue:73`, `shared/constants/domain.ts:143-145`, `i18n/locales/es.json:3383`
- **Qué pasa**: el diálogo propone `amendmentVoteMajority(kind)`, absoluta en `regulation` y `statutes`, bajo un texto fijo: «Las enmiendas se deciden por mayoría simple salvo que la Mesa indique otra.».
- **Cuándo pasa**: en cada votación de enmienda de una reforma de Estatutos o reglamentos (la 35.ª AGE, una AGET con el RRI o el RFAG): decenas de votaciones.
- **Impacto**: la Mesa duda al registrar; pasarla a simple da un resultado contrario al RRI art. 65.5.
- **Propuesta**: elegir la descripción según la mayoría propuesta. Para absoluta: «En una reforma de Estatutos o reglamentos, las enmiendas se deciden por mayoría absoluta (RRI art. 65.5) salvo que la Mesa indique otra». Clave nueva en es y en.

#### ENM-4. Las enmiendas a la totalidad de una reforma cuentan en plazo hasta el cierre general (RRI art. 65.4)

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `shared/utils/calendar.ts:43-47`, `shared/utils/calendar.ts:324-329`, `server/utils/domain/amendments.ts:2394`, `server/utils/domain/reviewState.ts:286-291`, `shared/constants/domain.ts:133-136`, `app/components/amendment/Composer.vue:412-421`, `docs/proceso-asambleas.md:96`
- **Qué pasa**: `isLateSubmission` solo compara con `closesAt` y `submitAmendment` no distingue `totality_*`; al validar, la Secretaría admite lo que llega en plazo. El repositorio lo deja como pendiente.
- **Cuándo pasa**: 35.ª AGE (reforma de Estatutos): un consejo presenta un texto alternativo a T-6 días y queda admitido al validarlo.
- **Impacto**: la enmienda de más peso de una reforma, que además se debate primero, se admite mal. Inadmitirla depende de que la Mesa recuerde la regla.
- **Propuesta**: ampliar la regla de reformas de `calendar_rules`, junto a `regulationWindowDays`, con un corte de totalidad como `MilestoneOffset` (8 días antes del inicio, sembrado en `INITIAL_CALENDAR_RULES`, editable en `/admin/calendario`), solo para `REGULATION_DOCUMENT_KINDS`. Un helper compartido marca `late` las `totality_*` posteriores (respetando `submissionLate`), que esperan la admisión como cualquier tardía. El compositor lo dice en su línea de plazo actual.

#### ENM-5. Con la regla «incorporar», aceptar una enmienda no dice lo que provoca

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `server/utils/domain/amendments.ts:3496-3541`, `server/utils/domain/amendments.ts:1365-1392`, `server/utils/domain/amendments.ts:649-655`, `app/components/proponent-review/AmendmentStep.vue:186-196`, `app/components/amendment/PositionPanel.vue`, `i18n/locales/es.json:1434`
- **Qué pasa**: en Estatutos y reglamentos, aceptar aprueba al instante (decisión documentada). La revisión del proponente no avisa de que (a) choca con otra ya incorporada (`setAmendmentPosition` no calcula `approvalWarnings`), (b) cierra la transaccional pendiente sobre ella, ni (c) todos verán «aprobada» aunque las respuestas sean reservadas (`status` y `approvalMethod` no se enmascaran).
- **Cuándo pasa**: 35.ª AGE: días antes, la CEA acepta CEUM 4 y UAM 2, que reescriben la misma frase del art. 3.11, con visibilidad «en sesión».
- **Impacto**: el proponente decide a ciegas, revela su posición antes de tiempo y el choque solo aflora en el consolidado o la consola.
- **Propuesta**: líneas discretas, sin bloqueo, en `AmendmentStep` y `PositionPanel`: «Choca con 12 · CEUM 4, ya incorporada», desde `list.overlaps` (ya cargado en `revisar.vue`); «Aceptarla cierra la transaccional T1»; y, con visibilidad «mesa» o «en sesión» antes de la sesión, completar `acceptIncorporate`: «Al aceptarla queda aprobada y todos lo verán, aunque las respuestas aún sean reservadas». No aplazar la aprobación.

#### ENM-6. El PDF no dice la base de la mayoría ni los votos en blanco y nulos

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `server/utils/export/pdfBuilder.ts:82-90`, `server/utils/export/pdfBuilder.ts:478-511`, `server/utils/export/pdfBuilder.ts:656-660`, `server/utils/export/mapping.ts`, `i18n/locales/es.json:2113-2116`
- **Qué pasa**: `ExportVote` y `ExportAnnexRow.vote` no llevan `blank`, `invalid` ni `present`. `voteCounts` imprime solo a favor, en contra y abstenciones; el rechazo dice «requería {majority}» sin cifra ni base; el anexo, «a / b / c» sin mayoría. La interfaz (`VoteSummary.vue`) sí los muestra.
- **Cuándo pasa**: RES 4 con 19/3/5 y 30 presentes (2/3 = 20) se rechaza; quien lee calcula 2/3 de 27 = 18 y cree que la plataforma se equivoca. En una elección secreta se pierden los votos en blanco.
- **Impacto**: el acta de acuerdos no se puede comprobar con lo impreso, y ya hubo actas cuyos recuentos no cuadraban.
- **Propuesta**: añadir los tres campos en `mapping.ts`; en `voteCounts`, «en blanco» y «nulos» si los hay y «sobre {present} miembros presentes»; en el rechazo, el umbral de `computeVoteOutcome` («requería mayoría de dos tercios: 20 votos a favor sobre 30 presentes»); en el anexo, la mayoría cuando no sea simple («12/8/2 · absoluta»). Textos en es y en.

#### ENM-7. Las candidaturas y sedes en competencia se registran como votaciones sueltas

- **Esfuerzo**: S · **Verificación**: por confirmar
- **Dónde**: `shared/constants/domain.ts:236-247`, `shared/constants/domain.ts:349`, `shared/utils/votes.ts:61-75`, `app/components/session/FinalVoteDialog.vue`, `app/pages/proyeccion/[assembly].vue`
- **Qué pasa**: cada candidatura o sede es un documento con votación final propia por mayoría simple, y nada relaciona las opciones de un mismo punto. Con dos opciones sale bien si los votos a la otra se anotan «en contra», pero el formulario no lo dice. Con tres o más por mayoría relativa no hay forma correcta de registrarlo.
- **Cuándo pasa**: dos sedes para la 81.ª AGO, A 20 y B 15: si se anotan solo los a favor, las dos salen «APROBADA». Con tres candidaturas a un cargo de la CEA (14, 12 y 10), la ganadora sale rechazada.
- **Impacto**: el registro oficial (proyección, PDF, historial) puede mostrar dos sedes aprobadas o la ganadora rechazada.
- **Propuesta**: en `FinalVoteDialog`, para `candidacy` y `venue`, una línea discreta sobre cómo anotar (votos a las demás opciones en contra; blancos y nulos en su campo) y, si ya hay otra aprobada en el punto, «Ya está aprobada {título} en este punto». Un formulario «Registrar elección» solo tras confirmar la regla electoral del RRI (art. 41 y siguientes).

#### DOC-2. Candidaturas y sedes se cierran con el plazo de documentos (T-8) y no con el suyo (T-96 h)

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `server/utils/domain/documents.ts:283-334`, `server/utils/domain/documentCreate.ts:100-102`, `app/composables/document/useAddDocument.ts:45-52`, `app/components/document/PublishDialog.vue:152-176`, `app/pages/asambleas/[assembly]/documentos/[document]/editar.vue`, `app/pages/asambleas/[assembly]/validacion.vue:272-277`, `shared/constants/calendarRules.ts:31-36`
- **Qué pasa**: `documentsDeadlinePassed`, `presentationClosed`, `requireMemberMayCreate`, `useAddDocument` y `PublishDialog` solo miran `documents_close`, el plazo de mociones internas y resoluciones. La bandeja de validación ya mide candidaturas y sedes contra `candidacies_close` (RRI art. 41.1).
- **Cuándo pasa**: con un punto abierto a `candidacy` o `venue`, entre T-8 y T-4 días un consejo no puede presentar su candidatura ni enviar un borrador anterior (409).
- **Impacto**: miembros en plazo quedan fuera y la Secretaría crea el documento a mano en los días de más carga.
- **Propuesta**: regla compartida en `shared/utils/calendar.ts`, `presentationDeadlineKey(kind)`: `candidacies_close` para `candidacy` y `venue` si el tipo de asamblea lo tiene (la AGET no), si no `documents_close`. Usarla en el servidor por documento y en `editar.vue`, `PublishDialog` y `validacion.vue`. En `useAddDocument`, el botón sigue mientras algún punto elegible admita esos tipos en plazo, y el modal filtra los tipos por su plazo.

#### DOC-3. «Tareas pendientes» propone acciones que ya no se pueden hacer

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/home/-work.ts:132-152`, `server/utils/domain/review.ts:219-255`, `server/utils/domain/review.ts:291-296`, `server/utils/domain/review.ts:412-433`, `server/utils/domain/amendments.ts:1688-1720`, `app/pages/asambleas/[assembly]/documentos/[document]/editar.vue:293-298`, `app/components/document/PublishDialog.vue:162-170`
- **Qué pasa**: (a) todo borrador con contenido da «Revisar y enviar» hasta cerrar la asamblea, aunque el plazo haya pasado y el servidor responda 409; en el editor «Enviar» sigue de botón principal y el diálogo bloquea sin decir al miembro qué hacer. (b) Los borradores de enmienda sobre documentos votados o aplazados siguen como tarea (409 en `assertAmendable`). (c) La bandeja y los contadores de la Secretaría siguen pidiendo validar enmiendas de documentos retirados.
- **Cuándo pasa**: tras `documents_close` en cada AGO; Becas retirada en la 79.ª AGO con 16 tardías pendientes.
- **Impacto**: ruido en el primer plano los días de más carga, con tareas imposibles.
- **Propuesta**: solo filtros de lectura. `presentationClosed` y la fecha de cierre en `MeWorkDocumentDto`: con el plazo cerrado no hay tarea, sino una novedad discreta («El plazo terminó; si hace falta, habla con Secretaría»). `canSubmit` mira el plazo (`deadlineExempt`, `documentsClose`). Borradores de enmienda filtrados con el predicado de `assertAmendable`; documentos retirados fuera de la bandeja y los contadores.

#### DOC-4. El resultado de la votación final no se ve en el documento, las listas ni la consola

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `shared/types/api.ts:632-633`, `server/utils/domain/documents.ts:575`, `app/components/document/DocumentHeader.vue`, `app/components/agenda/DocumentRow.vue:216-223`, `app/components/session/AgendaPanel.vue:25-43`, `app/pages/asambleas/[assembly]/documentos/[document]/consolidado.vue:195-229`, `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:1737-1760`
- **Qué pasa**: `DocumentSummaryDto` solo trae `consolidated`, cierto únicamente en un texto estructurado aprobado. Cuentas, actas, candidaturas, sedes en PDF y textos rechazados nunca muestran su resultado; el consolidado de un texto rechazado enseña la versión provisional sin decirlo. La consola cuenta «{done} de {total} documentos con texto final».
- **Cuándo pasa**: la mañana después de una AGET ningún documento dice si salió aprobado; al pasar 30 a 60 resultados, el progreso nunca llega al total.
- **Impacto**: los delegados pueden creer pendiente o aprobado un texto rechazado, y la Mesa no ve qué resultados le faltan.
- **Propuesta**: añadir `finalVote` (al menos resultado y mayoría) al DTO junto a `documents.ts:575`. En `DocumentHeader`, una línea discreta con resultado y mayoría; en `DocumentRow` y `AgendaPanel`, «Aprobado» o «Rechazado» en lugar de «Texto final», no a su lado; el progreso cuenta `finalVote !== null` («{done} de {total} documentos votados», es y en).

#### DOC-5. La convocatoria generada se firma con el lugar de la asamblea

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/convocation/Sheet.vue:102-110`, `app/components/convocation/Sheet.vue:366-372`, `i18n/locales/es.json:3036`, `i18n/locales/es.json:3040`
- **Qué pasa**: la firma es «{location}, a {date}.» con `assembly.location`, que es obligatorio, y no hay otra forma de editarla.
- **Cuándo pasa**: en cada convocatoria. Una AGET con lugar «Telemática» firma «Telemática, a 30 de septiembre de 2026.»; una AGO, «Universidad de Murcia, Campus de Espinardo, a …».
- **Impacto**: la errata llega al documento oficial que se imprime y se firma, justo lo que la hoja generada debía evitar.
- **Propuesta**: un ajuste propio «Lugar de firma», por defecto la ciudad de la sede de la asociación, en lugar de `assembly.location`, para todos los tipos de asamblea. La introducción por defecto («se celebrará en {location}») ya se edita por asamblea; en la AGET basta, como mucho, la etiqueta «Modalidad». Los hitos de votación quedan fuera de este cambio.

### Prioridad 3

#### ENM-8. «Deshacer» y cambiar la respuesta no ofrecen reabrir las transaccionales que la decisión cerró

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `server/utils/domain/amendments.ts:3896-3970`, `server/utils/domain/amendments.ts:3542-3566`, `app/composables/session/useSessionConsole.ts:961-967`, `app/composables/session/sessionModel.ts:189-193`
- **Qué pasa**: decidir una fuente cierra las transaccionales pendientes sobre ella (`closeDependents`), pero la rama `reopen` de `applyAmendmentOutcome` y la de `setAmendmentPosition` solo devuelven su propia fila. Después `sessionClosingSourceIds` deja de coincidir y la transaccional se lee como una retirada normal.
- **Cuándo pasa**: la Mesa aprueba por error CEUM 2 y pulsa «Deshacer», o el proponente cambia su respuesta con la regla «incorporar»: T7 sigue cerrada y sus partes ya recibieron el aviso.
- **Impacto**: una transaccional puede quedar cerrada sin que nadie lo note hasta la votación final.
- **Propuesta**: que el toast de «Deshacer» y el de cambiar la respuesta ofrezcan «Reabrir también T7» cuando se cerraron transaccionales en el mismo instante (`transactionalReopenBlocker` ya lo permite con la fuente abierta). Sin reapertura automática en el servidor.

#### ENM-9. El método «de forma» no sigue al tipo de la enmienda

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `server/utils/domain/amendments.ts:3648-3734`, `app/components/session/NowAmendment.vue:265-271`, `app/components/session/AmendmentCard.vue:276-282`, `app/composables/session/sessionModel.ts:1290-1295`, `app/composables/session/useSessionConsole.ts:1112-1122`
- **Qué pasa**: `applyAmendmentOutcome` acepta `method: "formal"` para cualquier `kind`, y la consola ofrece «De forma» en toda enmienda abierta (también de contenido, totalidad o transaccional), saltándose la reclasificación reservada a `amendment:review`. Al revés, `bulkAssent` aprueba con `method: "assent"` también las de forma.
- **Cuándo pasa**: la Mesa despacha una parcial con «De forma»; o, con la regla «vote», el asentimiento en bloque registra como asentidas las de forma aceptadas.
- **Impacto**: registro incoherente en el historial, el PDF y el acta. No abre un camino nuevo para aprobar sin votar: el asentimiento ya lo es.
- **Propuesta**: en el servidor, 422 a `method: "formal"` si `kind !== "formal"` («Primero hay que pasarla a enmienda de forma»); en la consola, «De forma» solo en las de forma; en `bulkAssent`, `method: "formal"` cuando `kind === "formal"`.

#### ENM-10. Ampliar el plazo de enmiendas no recalcula «fuera de plazo»

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `server/utils/domain/amendments.ts:2394`, `shared/utils/calendar.ts:324-329`, `server/utils/domain/documents.ts:1676-1680`, `server/utils/domain/reviewState.ts:286-291`, `server/utils/export/pdfBuilder.ts:640`
- **Qué pasa**: `late` solo se escribe al presentar; cambiar `amendmentsCloseAt` o el hito `amendments_close` no lo revisa, y validar una tardía no la admite.
- **Cuándo pasa**: la CE prorroga el cierre (RFAG art. 20) cuando ya han presentado varios consejos tras el cierre original, o la Secretaría corrige un plazo mal puesto.
- **Impacto**: la Secretaría puede admitirlas en bloque desde Validación, pero el registro dice «Lo decide la Mesa» y el anexo del PDF las marca «Fuera de plazo».
- **Propuesta**: al ampliar el plazo (nunca al acortarlo), recalcular en la misma transacción las `submitted` sin decidir y con admisión pendiente, tomando la primera presentación como referencia: `late=false` y, si ya están validadas, admitidas, con un evento propio dado de alta en `shared/constants/activity.ts`. Alternativa más simple: un método de admisión «Prórroga de la CE».

#### ENM-11. Rehacer una transaccional obliga a teclearla de nuevo

- **Esfuerzo**: S · **Verificación**: por confirmar
- **Dónde**: `app/components/session/TransactionalComposer.vue:156-166`, `app/components/session/TransactionalComposer.vue:199-227`, `server/utils/domain/amendments.ts:1981-1982`, `server/utils/domain/reviewState.ts:614-628`
- **Qué pasa**: por diseño, una transaccional presentada no se edita y una rechazada no se reabre: se hace otra. Pero tras crear T4, `createdId` queda fijado y reabrir el compositor con las mismas fuentes llama a `startFresh` y vuelve a sembrar desde las fuentes, con lo que se pierde el texto tecleado.
- **Cuándo pasa**: retoques orales («promover» por «impulsar») en debates con hasta 10 transaccionales en 3,5 h.
- **Impacto**: la Mesa reescribe el texto en pleno debate.
- **Propuesta**: «Rehacer» en una transaccional retirada o rechazada que presentó la Mesa: abre el compositor con sus fuentes, autores, operaciones y justificación, y al presentar crea otra con código nuevo. No editar en el sitio una transaccional publicada.

#### ENM-12. Los diálogos de votación se abren siempre en «Mano alzada»

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/composables/session/sessionModel.ts:1557-1571`, `app/components/session/VoteDialog.vue:39-45`, `app/components/session/FinalVoteDialog.vue:50-56`, `app/components/session/AdmissionDialog.vue:64`
- **Qué pasa**: `sessionEmptyVote` fija `show_of_hands` y los tres diálogos lo reinician al abrirse; nada propone «Portal electrónico».
- **Cuándo pasa**: al pasar unos 40 resultados y 4 votaciones finales de una AGET al cerrar el portal, o al aprobar actas por asentimiento.
- **Impacto**: un cambio de desplegable por resultado y, si se olvida, el historial y el resumen dicen «Mano alzada».
- **Propuesta**: valor inicial según el tipo de asamblea (AGET, `portal`; el resto, `show_of_hands`) y «Asentimiento» en la votación final de `minutes`. No recordar el último método, que arrastraría un voto secreto. Sin botón ni aviso nuevo.

#### DOC-6. Los números de los subpuntos se desplazan al publicar o retirar documentos

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `server/utils/domain/agendaWrites.ts:88-109`, `server/utils/domain/documentCreate.ts:262-268`, `server/utils/domain/documents.ts:2049-2116`, `shared/utils/agendaNumbering.ts:87-128`, `server/utils/domain/assemblies.ts:594-599`, `server/utils/export/buildData.ts:159`
- **Qué pasa**: el subpunto automático toma su orden al crear el borrador y no se numera mientras el documento no es público. Un borrador antiguo publicado tarde entra delante de los ya publicados (6.1 y 6.2 pasan a 6.2 y 6.3); retirar uno publicado lo deja sin listar y los siguientes suben (6.5 pasa a 6.4). No contradice AGENTS.md, que solo promete el mismo número para todos en cada momento.
- **Cuándo pasa**: en la semana de validación de cada AGO y al retirar una resolución en sala.
- **Impacto**: bajo: en vivo todos ven el número nuevo con su título, pero los PDF y las referencias ya citadas dejan de cuadrar.
- **Propuesta**: (a) en la primera publicación (`publishedAt` nulo), mover el subpunto al final de sus hermanos, con `lockAssembly` antes del bloqueo del documento y un evento `agenda_reordered`; hace falta una marca de que un gestor lo recolocó. (b) Como `DeletedInfo.wasPublic`, mantener listado y numerado, con su título y la marca «Retirado», el subpunto de un documento retirado que llegó a publicarse (`visibleAgendaItems`, `unlistedAgendaItemIds` y la exportación).

## Motor de contenido y diffs

Cubre el motor compartido de enmiendas (`shared/utils/content/`: operaciones, diff, solapes, consolidación y render) y las vistas que lo pintan en sala, en los composers y en el PDF. El motor es sólido y está bien probado, pero los fragmentos que se proyectan pierden la numeración real de las listas, y algunos casos frecuentes (vaciar un apartado, aceptar con la regla «incorporar», la sustitución global) dejan texto aprobado defectuoso o bloquean la votación final.

### Prioridad 1: antes de la próxima asamblea

#### MOT-1. Las letras y números de las listas salen mal en los fragmentos de enmienda y en el diff

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `shared/utils/content/render.ts:203-223`, `shared/utils/content/consolidate.ts:317-340`, `shared/utils/content/lists.ts:100-126`, `app/components/content/AmendmentDiff.vue:42-50`, `shared/utils/content/editor.ts:411-416`, `app/composables/amendment/transactional.ts:192-213`, `server/utils/export/content.ts:712-779`
- **Qué pasa**: `wrapFlow` solo escribe `start` si el bloque lo trae, y `previewAmendment` devuelve un subconjunto de bloques sin número: todo fragmento con `context=1` empieza en 1 o en «a)». Ningún renderizador usa `orderedListNumbers`. En el diff completo los ítems borrados siguen numerando, mientras el PDF los salta (`countable`). La semilla de la transaccional copia los bloques sin `start` y el editor arranca en 1.
- **Cuándo pasa**: reforma del RRI o de los Estatutos importada de Word. Una enmienda al apartado k) del art. 15.1 se ve como «b)» en la proyección, el directo, la consola y la revisión del composer. La Mesa dice «la letra k» y la pantalla dice otra cosa.
- **Impacto**: la sala, el directo y el PDF dan referencias distintas para el mismo apartado justo cuando se debate.
- **Propuesta**: en `previewAmendment`, calcular `orderedListNumbers` sobre el texto anotado sin los bloques borrados y poner el `start` real en el primer ítem de cada tramo contiguo (así dos tramos separados no se funden). En el diff, `list-style: none` en el ítem borrado o `value` en el siguiente. Sembrar el `start` real en la transaccional sin que `diffPassage` lo lea como cambio de formato. Tests: fragmento que empieza en «k)» y diff con un ítem borrado.

### Prioridad 2

#### MOT-2. Vaciar un apartado lo deja como bloque vacío en el texto consolidado

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `shared/utils/content/diff.ts:356-394`, `shared/utils/content/consolidate.ts:293-303`, `shared/utils/content/render.ts:256`, `shared/utils/content/engine.fuzz.test.ts:1310-1315`
- **Qué pasa**: `diffPassage` conserva todo bloque cuyo id sigue en el editor y emite un `replace` de su texto por `''`; solo descarta los bloques nuevos vacíos. `consolidate` guarda el bloque vacío, que se pinta como línea en blanco o como ítem que sigue numerando. En el editor, triple clic y Supr vacía el bloque pero no lo quita.
- **Cuándo pasa**: un consejo suprime el apartado c) del art. 19.3 de los Estatutos con triple clic y Supr, como en Word. El diff lo enseña tachado; al aprobarse, el consolidado y su PDF conservan un «c)» vacío y no renumeran.
- **Impacto**: el texto oficial aprobado sale con apartados o líneas vacías, y la versión consolidada no se edita tras la votación final.
- **Propuesta**: en `diffPassage`, si un bloque base con texto (sin contar espacios) queda vacío y no es celda ni imagen, tratarlo como borrado: meterlo en el `delete` y descartar su `replace` y su cambio de formato. No tocar los bloques que ya estaban vacíos en el base. Ajustar la propiedad 1 del fuzz y añadir un test con un apartado vaciado en una lista ordenada.

#### MOT-3. Con la regla «incorporar», el proponente aprueba enmiendas que chocan sin ningún aviso

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `server/utils/domain/amendments.ts:3496-3541`, `app/pages/asambleas/[assembly]/documentos/[document]/revisar.vue:586-657`, `app/components/amendment/PositionPanel.vue`, `shared/utils/content/overlaps.ts:82-88`, `shared/utils/content/consolidate.ts:174-181`, `server/utils/domain/documents.ts:2632-2640`
- **Qué pasa**: `setAmendmentPosition` aprueba en el acto (`approvalMethod: 'proponent'`) sin calcular `approvalWarnings`. La consola de la Mesa sí avisa (`offerLapses`), pero ni `revisar.vue` ni `PositionPanel` enseñan solapes. Dos enmiendas con operaciones idénticas son `same_text` duro y `consolidate` deja fuera la segunda.
- **Cuándo pasa**: reforma de los Estatutos o de un reglamento. Antes de la sesión, el proponente acepta desde su página dos enmiendas que corrigen la misma errata igual, o dos de los tres autores sobre el art. 3.11. Las dos quedan aprobadas y el conflicto sale en la votación final (409, con los códigos listados).
- **Impacto**: la votación final de la reforma (2/3) se bloquea en sala hasta reabrir una enmienda, algo que se podía avisar al aceptar.
- **Propuesta**: devolver `approvalWarnings` desde `setAmendmentPosition` cuando el efecto es aprobar y enseñarlos en `revisar.vue` y `PositionPanel`, como `offerLapses`. En el motor, clasificar como idénticas dos enmiendas con las mismas operaciones y dar la segunda por aplicada sin conflicto, manteniendo visible el duplicado para la Mesa.

#### MOT-4. Los fragmentos de enmienda pegan pasajes lejanos sin marca de salto

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `shared/utils/content/consolidate.ts:333-339`, `shared/utils/content/render.ts:345-400`, `app/components/content/AmendmentDiff.vue:74-83`
- **Qué pasa**: `previewAmendment` filtra los bloques por índice sin dato de hueco y `renderAnnotated` los pinta seguidos. El composer junta en una enmienda todo lo que se cambia de una vez, así que las enmiendas de varios sitios son normales.
- **Cuándo pasa**: una enmienda cambia una cifra del párrafo 5 y una frase del 32, o corrige erratas dispersas. La proyección y el directo enseñan 4-5-6 y 31-32-33 como si fueran contiguos.
- **Impacto**: la sala, el detalle y la revisión del autor leen como seguido un texto del que se han omitido páginas.
- **Propuesta**: que `previewAmendment` marque el primer bloque de cada tramo no contiguo (`gapBefore: true`) y que `renderAnnotated` pinte ahí un separador discreto «…» con texto sr-only «Texto omitido», si se quiere con la referencia del tramo (`blockLabels`). Sin cajas de color. Hacerlo en el mismo cambio que MOT-1, que necesita los mismos tramos.

#### MOT-5. Los grupos de «Mismo pasaje» se encadenan: una sustitución global arrastra enmiendas lejanas y desordena el debate

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `shared/utils/content/overlaps.ts:130-168`, `app/composables/session/sessionModel.ts:632-691`, `app/composables/session/sessionModel.ts:1142-1157`, `app/composables/amendment/workspace.ts:752-798`, `app/composables/amendment/transactional.ts:190-220`
- **Qué pasa**: `findOverlaps` devuelve clusters transitivos (union-find) y `buildSessionQueue` coloca el cluster entero donde aparece su primer miembro. Ni `clusterable` ni `groupAmendmentsByOverlap` excluyen la global, solo la totalidad.
- **Cuándo pasa**: una global solapa en el párrafo 3 con UAH 1, en el 18 con CEUM 2 y en el 40 con UPV 9. Las cuatro forman un grupo: «Siguiente» salta de la página 2 a la 25 y vuelve, y «Transaccionar 4» siembra un pasaje que abarca casi todo el documento.
- **Impacto**: el orden de debate deja de seguir el texto y la Mesa reordena a mano en sala.
- **Propuesta**: dejar fuera de la agrupación las enmiendas con `globalReplace`, en `groupAmendmentsByOverlap` y en `clusterable`, igual que la totalidad. No quitarlas de `passageAmendments`, que alimenta los avisos por pares de `amendmentOverlapIndex`. Opcionalmente, lo mismo con las enmiendas de bloques no contiguos. Test con una global que solapa con dos enmiendas lejanas.

#### MOT-6. La sustitución global distingue mayúsculas, duplica términos y choca con quien reescribe la misma frase

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `shared/utils/content/ops.ts:281-307`, `shared/utils/content/overlaps.ts:54-57`, `shared/utils/content/overlaps.ts:82-88`, `shared/utils/content/consolidate.ts:191-233`, `app/composables/session/sessionModel.ts:1224-1232`, `server/utils/domain/documents.ts:2632-2640`, `shared/utils/content/content.test.ts:374-385`
- **Qué pasa**: `globalReplaceOps` crea un `replace` por aparición en el base, sin bandera `i`, y casa también donde ya está el reemplazo («Comisión Ejecutiva» dentro de «Comisión Ejecutiva Ampliada»). No alcanza el texto que añaden otras enmiendas. Cada aparición da `same_text` duro con la enmienda que reescriba esa frase: la consola ofrece hacerla decaer y, con las dos aprobadas, la votación final da 409. El único test usa justo el patrón que duplica.
- **Cuándo pasa**: más o menos una global por AGO (OVI 1 en la 79.ª AGO). «Alumnado» por «estudiantado» deja intacto «TÍTULO II. DEL ALUMNADO»; otra sustitución deja «Ampliada Ampliada».
- **Impacto**: texto aprobado incoherente o duplicado sin aviso, y enmiendas compatibles tratadas como incompatibles.
- **Propuesta**: sin cambiar la representación de `design.md:351`: buscar sin distinguir mayúsculas y conservar la forma del original; no casar si el texto ya sigue con el resto del reemplazo; clasificar aparte el choque de una aparición con otra enmienda, sin oferta de decaer, y en `consolidate` aplicar la otra y omitir esa aparición. Tests de los tres casos.

#### MOT-7. Una enmienda a la totalidad con texto alternativo no se puede guardar sobre un documento real

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `shared/utils/schemas/content.ts:216-219`, `app/composables/amendment/workspace.ts:1242-1265`, `shared/utils/content/ops.ts:94-96`, `server/utils/domain/amendments.ts:270-277`, `app/components/amendment/Composer.vue:685-722`
- **Qué pasa**: el esquema limita un `insert` a 200 bloques. `totalityAlternativeOps` mete todo el texto en un único `insert` y `validateOps` no deja partirlo con el mismo ancla (`duplicate_anchor`). El servidor responde 400 sin `reasons` y el composer solo dice «No se ha podido guardar».
- **Cuándo pasa**: texto alternativo a un posicionamiento de 30 páginas, a una reforma del RRI o a unos Presupuestos (cada celda es un bloque): entre 200 y 600 bloques. También una enmienda que añade un anexo o una tabla de más de 200 celdas.
- **Impacto**: la totalidad con texto alternativo (RRI 2025, art. 65.4) no se puede presentar sobre casi ningún documento real, y el autor no sabe por qué.
- **Propuesta**: subir el máximo del `insert` a `DOCUMENT_MAX_BLOCKS` y mantener el límite global de operaciones (el cuerpo admite 6 MB, de sobra). Traducir el fallo del esquema de ops a un `reason` con clave i18n para que `amendmentErrorReasons` lo muestre. Test con un texto alternativo de 300 bloques.

#### MOT-8. Las vistas de sala muestran la sustitución global y el texto alternativo como un mosaico de fragmentos

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/pages/proyeccion/[assembly].vue:642-647`, `app/components/live-view/Debate.vue:197-202`, `app/components/session/NowAmendment.vue:387-393`, `app/components/session/AmendmentCard.vue`, `app/components/amendment/Detail.vue:680-702`
- **Qué pasa**: el detalle y la tarjeta de revisión dicen «sustituye X por Y», pero la proyección, el directo, `NowAmendment` y la tarjeta de sesión solo pintan `ContentAmendmentDiff` con `context=1`. Una global son N fragmentos sueltos sin decir «en todo el texto». Un texto alternativo es el documento entero tachado y el nuevo entero añadido, también en `Detail.vue`.
- **Cuándo pasa**: al debatir la global de la AGO o un texto alternativo. La proyección no hace scroll, así que la sala solo ve la primera pantalla.
- **Impacto**: la sala no puede leer lo que se vota.
- **Propuesta**: con `globalReplace`, una sola línea del tipo Sustituye «X» por «Y» en todo el texto (N veces), y debajo los primeros fragmentos con «y N más». Para `totality_alternative`, el texto nuevo limpio (`insertedBlocksOf`) con una línea que diga que sustituye el texto completo.

### Prioridad 3

#### MOT-9. Dos añadidos al final del mismo párrafo son un choque duro

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `shared/utils/content/overlaps.ts:32`, `shared/utils/content/overlaps.ts:89-91`, `shared/utils/content/consolidate.ts:40-46`, `shared/utils/content/engine.fuzz.test.ts:1420-1471`
- **Qué pasa**: `rangesCollide` trata dos inserciones de texto en el mismo punto como `same_text` duro, mientras que dos bloques insertados tras el mismo ancla son `same_position` blando. Es una decisión documentada (`overlaps.ts:4-12`).
- **Cuándo pasa**: dos consejos añaden cada uno una frase al final del mismo apartado del RRI sin reescribir el punto final. Al aprobar una, la consola ofrece hacer decaer la otra; con las dos aprobadas, la votación final da 409.
- **Impacto**: obliga a una transaccional o invita a hacer decaer una enmienda compatible. Se detecta antes de la votación final.
- **Propuesta**: lo barato es el aviso al aceptar de MOT-3. En el motor: tratar punto con punto en el mismo offset como `same_position` y aplicar en orden de aprobación (el `sort` estable ya lo da), corrigiendo `mapPosition`, que solo cuenta la primera inserción en un offset, y la propiedad 2 del fuzz.

#### MOT-10. La ubicación «párrafo N» cuenta apartados, celdas e imágenes como párrafos

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `shared/utils/content/render.ts:406-426`, `app/components/amendment/Detail.vue:297-308`, `app/components/proponent-review/Change.vue:38-48`, `app/components/amendment/Composer.vue:144-153`, `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:401-410`
- **Qué pasa**: `blockLabels` suma 1 por cada bloque que no es título, incluidos apartados de lista, celdas (también vacías), imágenes y citas.
- **Cuándo pasa**: una enmienda al apartado k) del art. 15 se ubica en «párrafo 23»; una a una celda de presupuestos, en «párrafo 87».
- **Impacto**: la referencia no coincide con la numeración del texto ni del PDF y confunde al leerla en sala.
- **Propuesta**: para apartados, «apartado k)» con `orderedListNumbers` y `formatListNumber`; contar como párrafos solo los que no están en listas ni en celdas; para celdas, «tabla · fila N» a partir de `cell.row`.

#### MOT-11. La línea de aprobación se ve con sus marcadores en la web del texto aprobado

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `shared/utils/content/approvalLine.ts`, `server/utils/export/pdfBuilder.ts:585`, `app/components/document/DocxImport.vue:141-150`, `app/pages/asambleas/[assembly]/documentos/[document]/consolidado.vue`
- **Qué pasa**: `fillApprovalLines` solo se aplica en el PDF. El consolidado y el modo «Con lo aprobado» de la web pintan la línea sin rellenar.
- **Cuándo pasa**: tras aprobar una reforma del RRI, la web dice «Modificado parcialmente en la XX Asamblea General Ordinaria el XX de xxxxxxxxx de 202x.» y el PDF da la fecha real.
- **Impacto**: la web y el PDF del texto oficial no coinciden.
- **Propuesta**: rellenarla al pintar las vistas del texto final cuando la votación final lo aprobó, sin tocar lo guardado. Antes de la votación no ocultarla: en reglamentos y Estatutos es un bloque enmendable. En `consolidado.vue`, aplicarla después de `provenanceMatches` y solo en bloques sin segmentos de enmienda.

#### MOT-12. La importación avisa de marcadores falsos

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `shared/utils/content/approvalLine.ts:31-32`, `app/components/document/DocxImport.vue:168-180`
- **Qué pasa**: `PLACEHOLDER_PATTERN` acepta cualquier texto entre corchetes de 1 a 40 caracteres que no sea solo dígitos, y «DD», «XX» o «XXXX» como palabra suelta en cualquier sitio.
- **Cuándo pasa**: un posicionamiento con «[…]» en una cita de la LOSU, «[en línea]» en la bibliografía, «DD.HH.» o «siglo XX» recibe el aviso de marcadores sin rellenar.
- **Impacto**: ruido en el modal de importación que enseña a ignorar el aviso cuando sí hay marcadores. No bloquea nada.
- **Propuesta**: en los corchetes, exigir mayúscula inicial o un campo conocido («[Mayoría]», «[Nº]», «[Día]») y excluir «[…]», «[...]» y «[sic]»; aceptar «DD» o «XX» solo en contexto de fecha («el XX de», «XX/XX/XXXX»).

#### MOT-13. Saneador HTML sin uso que contradice la regla de no guardar HTML

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `server/utils/richText.ts:16-44`, `shared/utils/richText.ts`, `package.json:46`
- **Qué pasa**: `sanitizeRichTextHtml` y los helpers de `shared/utils/richText.ts` no tienen llamadas, y `dompurify` solo lo importa ese fichero. Al estar en `server/utils`, Nitro lo autoimporta en todo el servidor.
- **Cuándo pasa**: alguien que añade un campo lo encuentra autoimportado y lo usa para guardar HTML.
- **Impacto**: poco probable, porque AGENTS.md lo prohíbe; el beneficio es sobre todo limpieza.
- **Propuesta**: borrar los dos ficheros y quitar `dompurify` de `package.json`. `linkedom` se queda: lo usa la importación de Word (`server/utils/content/docx.ts:10`).

#### MOT-14. La sección del motor de design.md nombra rutas y funciones que no existen

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `docs/design.md:412-438`
- **Qué pasa**: cita `shared/utils/amendments/`, `diffBlocks` y `renderDiff`; el motor está en `shared/utils/content/`, con `diffText`/`diffPassage` y `renderBlocks`/`renderAnnotated`, y faltan `ops.ts`, `format.ts`, `lists.ts`, `tables.ts` y `editor.ts`. Además, `design.md:412-418` incluye al proponente del documento entre las partes de una transaccional, cuando son solo los autores principales de las enmiendas de origen.
- **Cuándo pasa**: quien entra al proyecto, o un agente, busca esas funciones para cambiar el motor.
- **Impacto**: tiempo perdido y riesgo de duplicar lógica fuera del motor compartido.
- **Propuesta**: reescribir la sección con los ficheros reales, enlazar los tests de propiedades (`engine.fuzz.test.ts`) y corregir las partes de una transaccional.

## Sesión en directo, proyección y tiempo real

Esta área cubre la consola de la Mesa, la proyección, la página «Directo» y el canal en tiempo real (SSE sobre LISTEN/NOTIFY). La base es sólida, pero antes de la próxima asamblea hay que cerrar dos riesgos para toda la sala: el límite de peticiones por IP compartida y los cargos de la CEA en la pantalla. También hay decisiones de la consola que cierran negociaciones sin avisar.

### Prioridad 1: antes de la próxima asamblea

#### SES-1. El límite de peticiones por IP deja a toda la sala, Mesa incluida, sin servicio hasta 5 minutos

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `nuxt.config.ts:34`, `nuxt.config.ts:164-171`, `node_modules/nuxt-security/dist/runtime/server/middleware/rateLimiter.js:26`, `node_modules/nuxt-security/dist/runtime/server/middleware/rateLimiter.js:73`, `DEPLOYMENT.md:157`
- **Qué pasa**: nuxt-security usa como clave `ip + route`. Todo `/api/assemblies/**` (directo, consola, proyección, `/live` y los POST de la Mesa) comparte un único cubo de ventana fija: 12.000 peticiones cada 5 min por IP. Detrás de Cloudflare se usa la IP real, así que todo el NAT del recinto gasta el mismo cupo. Cada 429 en `/live` cuenta como error del SSE, y tras 3 la pestaña pasa a sondear cada 15 s con recarga completa.
- **Cuándo pasa**: con 100-150 pestañas, un debate normal gasta unas 1.000-3.000 peticiones cada 5 min. Lo agotan las tandas rápidas de asentimientos o posiciones y las reconexiones en masa cuando cae la wifi.
- **Impacto**: todo responde 429. La Mesa no puede registrar votos ni avanzar, la proyección se congela y los delegados pierden el directo, justo en los picos.
- **Propuesta**: poner `rateLimiter: false` en la regla `"/api/assemblies/**"`; la fusión de matchAll lo lleva también a `/import`, `/file` y `/convocation`. Todas esas rutas pasan por `requireActor`. Mantener el límite en `/api/auth/**` y en las páginas. No limitar por cuenta: la de un consejo la comparten varias personas.

#### SES-2. La proyección, abierta con la cuenta de la Mesa, muestra a la sala qué cargo de la CEA presenta cada enmienda o documento

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `app/pages/proyeccion/[assembly].vue:622-629`, `app/pages/proyeccion/[assembly].vue:673-679`, `app/pages/proyeccion/[assembly].vue:744-748`, `app/pages/proyeccion/[assembly].vue:340-343`, `app/pages/proyeccion/[assembly].vue:426-429`, `server/utils/domain/visibility.ts:303-309`, `server/utils/domain/speakers.ts:61-83`, `app/components/live-view/SpeakerName.vue`
- **Qué pasa**: la proyección pinta con nombre `debated.authors` y `document.proponent`, pedidos con la sesión del navegador. Moderador y Secretaría pasan `canSeeExecutiveMembers`, así que reciben el cargo real. La página ya filtra a mano las enmiendas privadas y los puntos sin publicar, pero no los cargos. La banda de turnos añade además el nombre de quien habla por un cargo.
- **Cuándo pasa**: se debate «CEA 3», de la Secretaría Ejecutiva. En el móvil se lee «CEA» y en la pantalla, «SE · Secretaría Ejecutiva».
- **Impacto**: rompe ante toda la asamblea una regla que el servidor aplica en todas sus respuestas (AGENTS.md, Security Checklist).
- **Propuesta**: crear un indicador de vista de sala (`?view=room` o una cabecera) que el servidor solo acepte de quien `canModerate`. Con él, el servidor construye el mismo actor público que usan `unlistedAgendaItemIds` y `visibleAgendaItems`. Así se aplican solos todos los `redact*` y sobran los filtros manuales de la página. No ocultarlo en el cliente.

#### SES-3. Decidir una enmienda, sola o en bloque, cierra sin aviso la transaccional pendiente sobre ella

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `app/components/session/NowAmendment.vue:89-138`, `app/components/session/AmendmentCard.vue:571-577`, `app/composables/session/useSessionConsole.ts:1011-1035`, `app/composables/session/sessionModel.ts:329-336`, `app/composables/session/sessionModel.ts:1284-1335`, `app/components/session/BulkAssentDialog.vue:74-92`, `server/utils/domain/amendments.ts:3803-3809`, `server/utils/domain/amendments.ts:3885-3887`, `server/utils/domain/reviewState.ts:614-628`
- **Qué pasa**: aunque la enmienda abierta tenga una transaccional pendiente, «Ahora en debate» dice «La Mesa puede decidirla ahora»; solo la tarjeta desplegada nombra la transaccional. Asentir, retirar, decaer o aceptar con «incorporar» se envían sin confirmar, y el servidor cierra la transaccional en la misma transacción. El asentimiento en bloque (`sessionAssentPlan`) no excluye estas enmiendas ni las que chocan con una abierta que se queda fuera del lote.
- **Cuándo pasa**: como en Gobernanza de la 78.ª AGO (10 transaccionales en 3,5 h). CEUAH presenta T9 sobre UGR 3 y UPV 2, y T9 espera a UPV en el grupo plegado. La Presidencia somete UGR 3 a votación o la incluye en un asentimiento de 18.
- **Impacto**: la sala vota la original, cuando lo habitual es votarla solo si no hay acuerdo. T9 solo se recupera reabriendo UGR 3, es decir, anulando lo que la sala ya decidió.
- **Propuesta**:
  1. En NowAmendment, añadir una línea discreta bajo el estado («Hay una transaccional en curso sobre ella: T9, espera a UPV»), sacada de `sessionReplacingIds`.
  2. Repetir esa línea dentro de VoteDialog, AdmissionDialog y BulkAssentDialog.
  3. Pedir una confirmación que nombre T9 solo en las acciones de un clic.
  4. En `sessionAssentPlan`, excluir con dos motivos nuevos: «tiene en curso la transaccional {codes}» y «choca con {codes}, aún por decidir».

### Prioridad 2

#### SES-4. Cada evento hace que todos los clientes vuelvan a descargar mucho más de lo que ha cambiado

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `app/pages/asambleas/[assembly]/directo.vue:258-266`, `app/pages/proyeccion/[assembly].vue:236-249`, `app/composables/document/useDocument.ts:88-90`, `app/components/live-view/-model.ts:85-92`, `app/composables/assembly/-liveFilters.ts:18-50`, `app/components/document/ReadBar.vue:22`, `app/composables/live/useAssemblyLive.ts:5-7`, `app/composables/live/useAssemblyLive.ts:115-120`
- **Qué pasa**:
  - Directo, proyección y la página del documento recargan el documento entero (con el texto base congelado) y todas sus enmiendas con cualquier evento que lleve `documentId`.
  - Los turnos se recargan con cualquier evento `live`, aunque cada cambio de visibilidad ya emite `speakers_visibility_changed`.
  - ReadBar recarga el orden del día casi con cualquier evento.
  - Guardar un borrador (`amendment_updated`) hace refrescar a quien no puede verlo.
  - Todos esperan los mismos 300 ms y piden a la vez. La proyección ya lo admite en un comentario: «a 502 under the refetch herd of a vote».
- **Cuándo pasa**: en cada votación de un posicionamiento de 30 páginas con 60 enmiendas, unos 100 directos piden a la vez el documento y las 60 enmiendas.
- **Impacto**: picos de decenas de MB contra un único proceso con un pool de 20 conexiones. La siguiente acción de la Mesa espera, aparecen errores 502 y se gasta el cupo de SES-1.
- **Propuesta**:
  1. Recargar el documento solo con eventos de tipo `document`, que incluyen la votación final y su anulación. Con eventos de enmienda, recargar solo la lista. En useDocument y en el orden del día, seguir recargando cuando cambie `amendmentCount`.
  2. Quitar `live` de `affectsSpeakers`, y no pedir turnos mientras `speakersVisible` sea false.
  3. Ignorar `amendment_updated` y `amendment_created`. Una transaccional presentada ya emite `amendment_submitted`.
  4. Añadir un retraso aleatorio de 0 a 1 s en las vistas pasivas.

#### SES-5. Una pestaña puede quedarse sin directo y seguir diciendo «En directo»

- **Esfuerzo**: S · **Verificación**: por confirmar
- **Dónde**: `server/api/assemblies/[assembly]/live.get.ts:24-35`, `server/api/assemblies/[assembly]/live.get.ts:64-66`, `app/composables/live/useAssemblyLive.ts:166-168`, `app/composables/live/useAssemblyLive.ts:182-192`, `app/composables/live/useAssemblyLive.ts:219-225`
- **Qué pasa**: el servidor envía cada 25 s un latido como comentario SSE, pero EventSource no entrega los comentarios a JS. `connected` solo pasa a false con un `error`, y `online` no hace nada si ya está conectado. No hay manejador de `visibilitychange` ni vigilancia.
- **Cuándo pasa**: Chrome y Android suelen cerrar el socket en menos de un minuto. El problema está en Firefox, que tarda hasta 600 s en detectarlo, y en Safari o iOS al volver del reposo: portátil cerrado en el descanso, móvil que cambia de punto de acceso o portátil de la proyección suspendido.
- **Impacto**: la pantalla sigue diciendo «En directo» con una enmienda o un turno que ya terminaron. En un rato tranquilo, la línea «Actualizado a las…» tampoco lo delata.
- **Propuesta**: enviar el latido como `event: ping`, que `writeComment` ya tiene de respaldo. Guardar la hora del último mensaje (ready, change o ping) y reabrir con `poll` si pasan más de 60 s sin nada, o si la pestaña vuelve a verse tras un rato oculta. En `online`, reabrir siempre.

#### SES-6. Los atajos «a» y «l» deciden la fila seleccionada aunque no sea la que está en debate

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/pages/asambleas/[assembly]/sesion.vue:150-178`, `app/components/session/QueueRow.vue:106-107`, `app/components/session/ConsoleToolbar.vue:47-54`, `app/composables/session/useSessionConsole.ts:433-435`, `app/composables/session/useSessionConsole.ts:763`, `app/composables/session/useSessionConsole.ts:952-970`
- **Qué pasa**: `withFocused` actúa sobre `focused ?? debatedAmendment`, y la selección cambia con cualquier clic o foco en una fila. Solo sigue a la enmienda en debate en el portátil que pulsa «Siguiente». «a» (asentimiento) y «l» (decaída) actúan sin confirmar. Además, la ayuda llama a `j` «Siguiente enmienda», pero `j` solo mueve la selección.
- **Cuándo pasa**: la Presidencia pasa a BMA 5 desde su portátil. En el de la Secretaría sigue seleccionada BMA 9, que se dejó pendiente mientras se redactaba una transaccional. La sala asiente BMA 5 y la Secretaría pulsa «a».
- **Impacto**: BMA 9 queda aprobada sin debate. Solo lo avisa un mensaje de 5 s con «Deshacer», y «Siguiente» ya no la ofrecerá.
- **Propuesta**: que `focusedId` siga a `liveState.amendmentId` cuando cambie el debate (un watch). Pedir confirmación en «a» y «l» cuando el destino no sea la enmienda en debate, nombrándola. Renombrar j/k a «Seleccionar la siguiente/anterior».

#### SES-7. Las votaciones de admisión se proyectan como «Votación de una decisión de la Mesa», sin decir qué se votó

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/live-view/-model.ts:461-462`, `app/components/live-view/-model.ts:490-491`, `server/utils/domain/assemblies.ts:790-815`, `server/utils/domain/amendments.ts:2683-2698`, `server/utils/domain/amendments.ts:2829-2833`
- **Qué pasa**: `loadLiveStateDto` no carga la decisión votada, así que el directo y la proyección solo pueden decir «Votación de una decisión de la Mesa», aunque vote la asamblea. Si fracasa la votación para inadmitir, la enmienda queda admitida, pero la pantalla muestra «RECHAZADA» en grande.
- **Cuándo pasa**: con enmiendas fuera de plazo hasta la última mañana, la Mesa somete a votación admitir tres.
- **Impacto**: en cada admisión votada se proyecta un resultado que no dice qué se votó y que se puede entender al revés.
- **Propuesta**: añadir al voto en directo el tipo (`admit_late` o `inadmission`) y los `subjectIds` de la decisión, con un join a `decisions`. El cliente lo redacta con el vocabulario de la consola («Tratarla», «No tratarla»), sin «de la Mesa». Los códigos deben salir solo de enmiendas que la sala puede leer (`liveAmendmentRows(..., null)`). Revisar también la etapa tardía, donde un «APROBADA» se lee como aprobación de la enmienda.

#### SES-8. En la proyección, el párrafo de contexto deja fuera de la pantalla el cambio de la enmienda

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `app/pages/proyeccion/[assembly].vue:642-647`, `app/pages/proyeccion/[assembly].vue:785-788`, `shared/utils/content/consolidate.ts:333-339`, `app/components/content/AmendmentDiff.vue`
- **Qué pasa**: la proyección pasa `:context="1"`, y `previewAmendment` conserva bloques enteros alrededor del cambio con letra de hasta 3rem. Caben unas 8-11 líneas y nada desplaza la vista hasta el cambio. Los paneles de votación y de mensaje lo empujan aún más abajo.
- **Cuándo pasa**: una enmienda cambia una frase del párrafo 12 de un posicionamiento, y el párrafo 11 tiene 120 palabras. En un proyector de 1280×720 pasa antes.
- **Impacto**: la sala ve el contexto, no lo que se debate, hasta que alguien desplaza a mano la ventana del proyector.
- **Propuesta**: cada vez que cambie `debated.id`, desplazar la vista al primer bloque tocado con el `scrollToBlock` que ya expone ContentView, que sirve también para cambios solo de formato. Añadir un `scroll-margin-bottom` del alto de la banda de turnos. Bajar el contexto a 0 no basta por sí solo.

#### SES-9. Las relaciones entre enmiendas no se ven en la consola

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/session/NowAmendment.vue`, `app/composables/session/useSessionConsole.ts:998-1003`, `app/composables/session/useSessionConsole.ts:1137-1142`, `app/components/session/RelationDialog.vue:60-68`, `app/components/proponent-review/AmendmentStep.vue:182-210`
- **Qué pasa**: `session.relations` solo lo leen la oferta de decaídas y el diálogo «Relacionar». Ni NowAmendment, ni la tarjeta, ni la fila muestran nada. La revisión del proponente ya las enseña en una línea discreta.
- **Cuándo pasa**: la Secretaría marca que UAH 2 duplica UAH 1 y que CEUM 5 es incompatible con UPV 3. Cuando la Mesa pone UPV 3 en debate, no ve nada de eso.
- **Impacto**: la Mesa no puede avisar de que, si se aprueba UPV 3, decae CEUM 5, ni tratar juntos los duplicados. Se entera después, con la oferta de decaídas.
- **Propuesta**: añadir en NowAmendment una línea apagada con el formato de AmendmentStep («Incompatible con CEUM 5 · Duplica a UAH 1»). Usar `amendmentRelationsOf` (`app/composables/amendment/workspace.ts:1121`) y las claves `amendment.relations.kinds/inverse`. No añadir nada a la fila.

### Prioridad 3

#### SES-10. La consola de la Mesa no reintenta las recargas fallidas

- **Esfuerzo**: S · **Verificación**: por confirmar
- **Dónde**: `app/composables/session/useSessionConsole.ts:293-303`, `app/composables/session/useSessionConsole.ts:507-556`, `app/composables/fetch/lastGoodData.ts:290-313`, `app/components/session/ConsoleToolbar.vue:31-34`
- **Qué pasa**: el directo y la proyección usan `useRetryFailed`. La consola solo muestra un aviso con «Reintentar» que se cierra a los 5 s, y no vuelve a pedir los datos hasta el siguiente evento. El distintivo de conexión refleja el SSE, no las recargas.
- **Cuándo pasa**: tras una votación, la recarga de enmiendas de la consola recibe un 502 mientras el SSE sigue vivo, y «Siguiente» elige sobre una lista vieja. Lo atenúan el bloqueo optimista, «Recargar datos» y el `poll` al reconectar.
- **Impacto**: la Mesa puede actuar con datos viejos sin saberlo.
- **Propuesta**: usar `useRetryFailed` como en `app/pages/asambleas/[assembly]/directo.vue:276`. Mostrar el estado «datos sin actualizar» en el distintivo que ya existe, sin añadir otra línea.

#### SES-11. Los recuentos solo muestran la hora, y en una AGO de tres días no se sabe de qué día son

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/live-view/Attendance.vue:19-20`, `app/components/live-view/Attendance.vue:196`, `app/components/session/VoteFields.vue:103-109`, `app/components/session/HeadcountPanel.vue:55-57`, `server/utils/domain/headcounts.ts:565-578`
- **Qué pasa**: `formatTime` solo da HH:MM, y `withHeadcount` toma el último recuento, sea del día que sea. La lista de recuentos anteriores no distingue días.
- **Cuándo pasa**: segundo día de la AGO, la Mesa abre una votación antes del recuento de la mañana. «Presentes del recuento de las 18:40» se refiere al de ayer.
- **Impacto**: la mayoría se calcula sobre la asistencia de otro día. Es poco frecuente, porque se recuenta al empezar cada jornada.
- **Propuesta**: usar `formatDateTime` cuando el recuento no sea de hoy, con variantes con fecha de `session.vote.presentFromCount` y `liveView.attendance.takenAt` en es y en. Añadir un aviso discreto en VoteFields solo cuando el recuento sea de otro día.

#### SES-12. La proyección no pide mantener la pantalla encendida

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/pages/proyeccion/[assembly].vue:434-444`
- **Qué pasa**: no hay `navigator.wakeLock` ni `useWakeLock` en `app/`.
- **Cuándo pasa**: la proyección va en un miniPC o en un segundo portátil que nadie toca durante un debate largo.
- **Impacto**: a los 10-15 minutos el sistema apaga la pantalla y la sala se queda sin proyección hasta que alguien toca el equipo.
- **Propuesta**: usar `useWakeLock` de `@vueuse/core`, que ya está instalado y vuelve a pedir el bloqueo cuando la página vuelve a ser visible. No cambia nada a la vista.

#### SES-13. El orden del día de la proyección no cabe en pantalla y deja fuera el punto en curso

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/session/ProjectionAgenda.vue:23-31`, `app/components/session/ProjectionAgenda.vue:52-85`, `app/pages/proyeccion/[assembly].vue:344-351`, `app/pages/proyeccion/[assembly].vue:712-718`
- **Qué pasa**: se pintan todas las filas con todos sus subpuntos, sin recortar. La 80.ª AGO local tiene 28 puntos y 63 elementos, sobre todo subpuntos manuales del informe de la CEA.
- **Cuándo pasa**: durante casi toda la sesión, en la columna compacta junto al documento y en reposo.
- **Impacto**: la cabecera ya dice cuál es el punto en curso, pero la sala no ve qué viene después.
- **Propuesta**: no desplazar la página, porque sacaría la cabecera de la pantalla. En modo compacto, mostrar el punto en curso con uno o dos puntos antes y después. En modo completo, plegar en una línea los subpuntos de los demás puntos (clave i18n nueva en es y en).

#### SES-14. La oferta de decaídas no salta cuando se retira, decae o se inadmite la enmienda de la que otra depende

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/composables/session/sessionModel.ts:1211-1222`, `app/composables/session/useSessionConsole.ts:973-975`, `app/composables/session/useSessionConsole.ts:1215-1263`
- **Qué pasa**: `sessionLapseOffer` solo ofrece decaer las enmiendas que dependen de otra (`depends_on`, `consequence_of`) cuando esa otra se rechaza. Si se retira, decae o se inadmite, devuelve una lista vacía, aunque al retirar y al decaer ya se llama a `offerLapses`.
- **Cuándo pasa**: CEUM 8 depende de FPU. El proponente rechaza FPU y su autor la retira en sala, que es lo habitual. CEUM 8 sigue «Por decidir».
- **Impacto**: es menor: hace falta haber anotado antes la relación, y la Mesa puede declararla decaída cuando salga con «Siguiente».
- **Propuesta**: en `sessionLapseOffer`, tratar withdrawn, lapsed e inadmissible como rejected. Llamar a `offerLapses` después de `decideAdmission` cuando inadmite. Cambiar el texto de `session.lapse.descriptionRejected` para que valga en todos los casos.

#### SES-15. El diálogo de votación sigue abierto sobre una enmienda que ya no se puede votar, y el aviso pide repetir

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `app/components/session/VoteDialog.vue:26-30`, `app/components/session/VoteDialog.vue:50-51`, `app/components/session/VoteDialog.vue:61`, `app/composables/api/useApi.ts:72-118`, `app/composables/api/useApi.ts:247-261`, `server/utils/domain/amendments.ts:3650-3660`, `server/utils/domain/amendments.ts:3703`
- **Qué pasa**: VoteDialog solo se bloquea por el recuento. Los 409 de enmienda ya decidida, no admitida, sin publicar o pendiente de los autores no llevan `reason`, así que `notifyError` muestra «vuelve a intentarlo» y «Registrar» sigue activo.
- **Cuándo pasa**: otro portátil de la Mesa, la Secretaría o los autores resuelven o retiran la enmienda mientras el diálogo está abierto.
- **Impacto**: la Mesa reintenta una y otra vez sin saber que la enmienda ya está resuelta.
- **Propuesta**: en VoteDialog, observar `session.stageOf(amendment)`. Si deja de ser decidible, mostrar la frase de etapa, desactivar «Registrar» y conservar el recuento. Añadir un `data.reason` a esos 409 y traducirlo en `REASON_KEYS`. El 409 del bloqueo optimista (`:3752`) se queda como está.

#### SES-16. La Mesa no puede registrar la retirada de una enmienda que la Secretaría aún no ha validado

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/session/AmendmentCard.vue:254-259`, `app/components/session/AmendmentCard.vue:631-644`, `server/utils/domain/amendments.ts:2486-2491`, `server/utils/domain/documents.ts:2598-2603`
- **Qué pasa**: si la enmienda está pendiente de validar, el menú de la tarjeta sale vacío y solo se ofrece «Validar». Sin embargo, el servidor deja a la Mesa retirar cualquier enmienda presentada. La votación final sigue bloqueada mientras quede alguna presentada.
- **Cuándo pasa**: el último día, CEUAM presenta una enmienda fuera de plazo a las 9:40 y la retira en sala antes de que la Secretaría la valide.
- **Impacto**: hay que dar rodeos: validarla, y con ello publicarla, para después retirarla, o devolverla como si fuera una corrección. Mientras tanto, la votación final se retrasa.
- **Propuesta**: en la rama `awaiting` de `menuItems`, con status `submitted`, `reviewState` `pending_validation` y `withdrawable`, añadir `withdrawSubmissionItem`, igual que en la rama `awaitingAuthors`.

#### SES-17. La votación final aparece como lista aunque el texto consolidado tenga choques

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/session/NowAmendment.vue:187-193`, `app/components/session/ConsolidatedPanel.vue:171`, `app/components/session/FinalVoteDialog.vue:122-131`, `app/composables/session/useFinalVoteReasonText.ts:24-33`, `server/utils/domain/documents.ts:2632-2640`
- **Qué pasa**: `finalVoteReady`, el botón del panel y el bloqueo del diálogo no tienen en cuenta `preview.conflicts`, pero el servidor rechaza el registro si hay choques. Además, los motivos de bloqueo solo dan recuentos, no códigos.
- **Cuándo pasa**: rara vez: quedan dos aprobadas que chocan porque se ignoró la alerta roja de la oferta de decaídas. La sala vota por 2/3 y el servidor rechaza el registro.
- **Impacto**: hay que repetir una votación que la sala ya hizo.
- **Propuesta**: que los choques pongan `finalVoteReady` a false y bloqueen FinalVoteDialog, sin añadir otra frase, porque la alerta roja ya lo dice. Opcionalmente, nombrar en los motivos hasta unos 6 códigos.

#### SES-18. Con «Ocultar decididas», pulsar el texto consolidado no lleva a su enmienda

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/session/ConsolidatedPanel.vue:84-90`, `app/composables/session/useSessionConsole.ts:340-341`, `app/components/session/AmendmentQueue.vue:109-127`
- **Qué pasa**: `focusAmendment` busca la fila de la enmienda, pero con el filtro activo esa fila no se pinta, porque los fragmentos son siempre de enmiendas aprobadas. El resaltado cambia, pero la cola no se desplaza.
- **Cuándo pasa**: la Mesa activa el filtro para ver lo que queda y después pulsa un choque.
- **Impacto**: no llega a «Reabrir», que está en la tarjeta de la fila oculta y es lo que hace falta para resolver el choque.
- **Propuesta**: si la enmienda no pasa `session.isVisible`, poner `hideDecided` a false y esperar a `nextTick` antes de buscar la fila.

#### SES-19. AmendmentCard repite el estado de la fila y conserva un modo no embebido que nadie usa

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/session/AmendmentCard.vue:61-63`, `app/components/session/AmendmentCard.vue:145-147`, `app/components/session/AmendmentCard.vue:349-385`, `app/components/session/AmendmentCard.vue:416-473`, `app/components/session/AmendmentCard.vue:598-615`, `app/components/session/AmendmentCard.vue:648`, `app/components/session/AmendmentCard.vue:755-767`, `app/components/session/QueueRow.vue:194`
- **Qué pasa**: la tarjeta solo se usa embebida (`QueueRow.vue:194`), así que el modo no embebido es código muerto en una pieza de 770 líneas. En el modo embebido, las insignias «En debate», «No pública», «Pendiente de admisión», «Presentada» e «Inadmitida» repiten lo que ya dice la fila o la propia tarjeta.
- **Cuándo pasa**: la repetición se ve cada vez que la Mesa despliega una fila, y el código muerto estorba cada vez que alguien toca la tarjeta.
- **Impacto**: incumple la regla de mostrar cada dato una vez y hace más arriesgado tocar la pieza de la consola con más estados.
- **Propuesta**: quitar la prop `embedded` y sus ramas muertas (`focused`, `debatable` y `expandedByUser`) y reescribir el comentario de cabecera. Quitar también las insignias que ya da la fila. «Fuera de plazo» se queda solo en una tardía admitida.

## Experiencia de asociados, sectoriales y CEA

Esta área cubre el trabajo de los miembros que presentan documentos y enmiendas: las tareas pendientes, el compositor y los editores, la lectura y la navegación en el móvil, las respuestas a transaccionales y los avisos. En escritorio el recorrido es sólido. Los problemas se concentran en el móvil, que es lo que se usa en la sala, y en tareas que no saben si todavía se pueden cumplir.

### Prioridad 1: antes de la próxima asamblea

#### UXM-1. Compositor de enmiendas en el móvil: se abre al principio, sin índice y con «Revisar y enviar» fuera de la pantalla

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:581-590`, `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:680-682`, `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:1349-1356`, `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:1531-1540`, `app/utils/readingPosition.ts:10-25`, `app/components/content/BlockEditor.client.vue:1378-1381`, `app/components/amendment/Composer.vue:845-858`, `app/components/amendment/Composer.vue:1013-1027`, `app/components/amendment/Composer.vue:1505-1533`
- **Qué pasa**: «Presentar enmienda» solo está en la cabecera y `startAmendment` toma el bloque visible al pulsar, que después de subir es el primero («ÍNDICE»). En el teléfono el editor es una caja `max-lg:h-[70dvh]` con desplazamiento propio. Su índice es `max-sm:hidden` y el índice flotante solo sale sin compositor. El único paso adelante, «Revisar y enviar», queda debajo de la caja. Medido a 375×812 en el posicionamiento de Becas: 82.467 px de texto en una caja de 568 px y el botón 650 px por debajo del borde. Con el teclado abierto quedarían pocas líneas visibles (estimación, sin medir).
- **Cuándo pasa**: un consejo encuentra en la página 25 lo que quiere cambiar, sube a pulsar el botón y el editor se abre en el índice. Al terminar, desliza sobre el texto buscando cómo enviar. Lo mismo con las enmiendas fuera de plazo escritas en la sala.
- **Impacto**: enmendar desde el móvil los textos largos, que son los que reciben 27-65 enmiendas, se vuelve casi impracticable.
- **Propuesta**: por debajo de sm, pintar en BlockEditor el `ContentOutline` flotante con los `outlineItems` y `goToHeading` que ya calcula. Por debajo de lg, convertir el bloque «párrafos cambiados · Revisar y enviar» en una barra sticky al pie del compositor (el mismo botón, movido). Recordar el último bloque leído solo cuando, al pulsar, el lector está en la cabecera. No ocultar migas ni barra de secciones.

### Prioridad 2

#### UXM-2. En el móvil, mantener pulsado el texto abre un menú de escritorio y anula la selección y «Pegar» del sistema

- **Esfuerzo**: S · **Verificación**: confirmado (falta probarlo en dispositivos reales)
- **Dónde**: `app/components/content/BlockEditor.client.vue:875-904`, `app/components/content/BlockEditor.client.vue:1183-1187`, `app/components/amendment/Composer.vue`, `app/components/transactional/Composer.vue`, `app/components/session/TransactionalComposer.vue`, `app/components/document/DraftEditor.vue`
- **Qué pasa**: el editor va envuelto en `<UContextMenu :modal="false">` sin condición de puntero. Reka cancela `contextmenu`, abre el menú con un toque largo de 700 ms y pone `-webkit-touch-callout: none`. Además, el manejador en captura `onContextMenu` mueve el cursor al punto pulsado. En emulación a 375 px el foco pasa al menú («Convertir en», «Insertar tabla», «Mayús + clic derecho»), sin «Pegar».
- **Cuándo pasa**: un delegado mantiene pulsada una palabra para seleccionar la frase que quiere cambiar, o para pegar un texto que le pasaron por WhatsApp. Ocurre en los cuatro editores, también al escribir una transaccional en la sala.
- **Impacto**: rompe seleccionar, sustituir y pegar en pantallas táctiles, y el menú no ofrece nada que no esté ya en la barra de herramientas.
- **Propuesta**: `const coarse = useMediaQuery("(pointer: coarse)")` y `<UContextMenu :disabled="coarse">`. `:disabled` solo no basta: salir al principio de `onContextMenu` cuando `pointerType === "touch"` o el puntero es grueso, y anular `-webkit-touch-callout` en táctil. Probarlo después en un iPhone y un Android.

#### UXM-3. Pasado el cierre de documentos, el borrador de un miembro sigue pidiendo «Revisar y enviar» y el envío se bloquea sin explicación

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/home/-work.ts:132-141`, `app/components/home/-work.ts:200-218`, `app/components/document/PublishDialog.vue:152-171`, `app/pages/asambleas/[assembly]/documentos/[document]/editar.vue:938-971`, `server/utils/domain/documents.ts:321-334`, `server/utils/domain/documents.ts:1956`, `server/utils/domain/review.ts`, `i18n/locales/es.json:911`, `i18n/locales/es.json:931-932`
- **Qué pasa**: `homeWorkDocumentTask` devuelve `document_send` aunque haya pasado `documents_close`, y la tarea solo conoce `document.dueAt`. En editar.vue «Enviar a Secretaría» sigue activo. PublishDialog marca el plazo en rojo y solo da explicación a los gestores, así que el miembro lee «Resuelve los puntos marcados en rojo» sin nada que resolver. El servidor lo rechaza.
- **Cuándo pasa**: CEUM crea su resolución en T-9, la deja para revisarla con su co-presentador y se pasa el cierre de T-8. Inicio sigue diciendo «Revisar y enviar» hasta que se cierra la asamblea.
- **Impacto**: es un callejón sin salida en el trámite principal de los miembros, y nada menciona la vía tardía (RRI art. 13.1.b), que en la práctica se usa.
- **Propuesta**: que el servidor mande una marca `presentationClosed` en `MeWorkDocumentDto`, porque el cliente no tiene los datos del punto. La tarea y el paso 3 de editar.vue (que ya calcula `deadlineExempt`) muestran, en lugar del botón, la línea «El plazo terminó el {date}. Solo Secretaría puede presentarlo fuera de plazo, y la asamblea decide si lo trata.». La misma frase como `description` de PublishDialog para los miembros. Sin botón nuevo.

#### UXM-4. Los borradores y correcciones de enmienda sobre documentos ya votados, retirados o aplazados siguen como tareas

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `server/utils/domain/review.ts:258-298`, `server/utils/domain/review.ts:476-483`, `app/components/home/-work.ts:144-153`, `server/utils/domain/amendments.ts:552-560`, `app/components/amendment/Detail.vue:1207`
- **Qué pasa**: `loadWorkAmendments` filtra solo por el estado de la enmienda y por que la asamblea siga abierta; no mira `finalVoteId` ni el estado del documento. En un documento votado, `amendmentCapabilities` quita editar y enviar, y el detalle esconde también «Eliminar», así que la tarea no se puede cumplir ni borrar. En los retirados o aplazados se ven Editar y Enviar, que responden 409.
- **Cuándo pasa**: un delegado empieza una enmienda fuera de plazo durante el debate de Becas y no la envía. Becas se vota y la tarea sigue ahí los tres días de la AGO. Una corrección pendiente es peor: tiene rango 0 y ocupa el botón principal de Inicio y del resumen.
- **Impacto**: una tarea imposible que no desaparece y hace desconfiar del resto de la lista.
- **Propuesta**: en `loadWorkAmendments`, unir con el documento y exigir las condiciones de `assertAmendable` (publicado, `finalVoteId` y `consolidatedVersionId` nulos), reutilizando las de `openPublishedDocuments`. Opcional: dejar «Eliminar» en los borradores de documentos votados, que el servidor ya permite.

#### UXM-5. El autor no ve sin desplegar que quien presenta el documento rechaza su enmienda o propone transaccionarla

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/amendment/Detail.vue:840`, `app/components/amendment/Detail.vue:975-983`, `app/components/amendment/Card.vue:26-30`, `app/composables/amendment/workspace.ts:1096-1108`, `shared/constants/domain.ts:391-395`
- **Qué pasa**: para quien no presenta el documento, `AmendmentPositionPanel` va bajo «Ver detalles», y ni `amendmentStatusLine` ni la tarjeta lo muestran. Un autor tampoco puede abrir /revisar. Las Novedades van plegadas y se cortan en 30 entradas.
- **Cuándo pasa**: ya en sesión (`positionVisibility: "session"`), la UVa tiene 8 enmiendas al posicionamiento de Gobernanza y necesita saber cuáles se rechazaron para mantenerlas o retirarlas. Tiene que abrir las 8 y desplegar cada una.
- **Impacto**: es el dato que decide el siguiente paso del autor, y AGENTS.md pide no plegar un panel que pide actuar.
- **Propuesta**: solo en las enmiendas propias con respuesta `reject` o `transact`, una línea discreta en la cabecera del detalle y en las tarjetas de «Mías», donde ya se usa `showPublished`. Sin nombrar a quien presenta, que suele ser un cargo de la CEA: «Quien presenta el documento la rechaza», o pasarlo por `redactMember`. El panel completo sigue en «Ver detalles».

#### UXM-6. El borrador de enmienda no se puede guardar al salir ni tiene copia local

- **Esfuerzo**: M · **Verificación**: por confirmar
- **Dónde**: `app/components/amendment/Composer.vue:593-601`, `app/components/amendment/Composer.vue:814-818`, `app/components/amendment/Composer.vue:1262-1270`, `app/components/amendment/Composer.vue:1539-1558`, `app/composables/amendment/workspace.ts:1378`
- **Qué pasa**: «Guardar borrador» solo existe en la fase de revisión. Al pie de la edición solo está «Revisar y enviar», y el diálogo de salida ofrece «Salir sin guardar» o «Seguir editando». No hay autoguardado ni copia en el navegador: solo `beforeunload`, que no salta cuando el móvil descarta una pestaña en segundo plano.
- **Cuándo pasa**: en la sala, un delegado escribe en el móvil una enmienda fuera de plazo, cambia a WhatsApp para confirmar la redacción con el coautor y el sistema descarta la pestaña. Falta comprobar con qué frecuencia ocurre en iOS y Android.
- **Impacto**: se pierde trabajo en el trámite más usado (unas 150 enmiendas por AGO), en las condiciones habituales de la sala.
- **Propuesta**: añadir «Guardar y salir» al diálogo de salida cuando el guardado no esté bloqueado. Guardar en localStorage, por documento y borrador, el `draftBody()` de operaciones y la justificación. Al reabrir, compararlo con el `updatedAt` del borrador y ofrecer «Recuperar», sin aplicarlo nunca en silencio sobre una versión más nueva de un coautor. El tipo sigue siendo obligatorio: es un clic.

#### UXM-7. «Atrás» no devuelve al sitio: la lista pierde la posición y los filtros, y el detalle de enmienda del móvil no está en el historial

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `app/pages/asambleas/[assembly].vue:354-358`, `app/app.config.ts:38-43`, `app/pages/asambleas/[assembly]/documentos/index.vue:58-62`, `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:886-895`, `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:1146-1158`, `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:2066-2073`
- **Qué pasa**: lo que se desplaza es el cuerpo de `#assembly-hub`, que sigue montado entre secciones y nadie reinicia ni restaura, y el scrollBehavior del router solo mueve `window`. La búsqueda y los filtros de la lista son `ref` locales. En el móvil, `?enmienda` se escribe con `replace` y el detalle es un USlideover fuera del historial. Tras «Ver en el documento» solo queda la línea «Mostrando CEUM 3».
- **Cuándo pasa**: un delegado filtra lo que le queda por leer, abre la 17.3 y vuelve: cae al final de la lista y sin filtro (medido a 375 px). Revisando 40 enmiendas con «Siguiente», el gesto Atrás de Android lo saca del documento.
- **Impacto**: pérdida de contexto en el recorrido más frecuente (lista, documento y vuelta) y al revisar enmiendas.
- **Propuesta**: llevar los filtros a la query con `router.replace`. En el hub, guardar el `scrollTop` del panel por `history.state.position` en `beforeEach` y restaurarlo en `page:finish` (0 en navegaciones nuevas). En pantallas estrechas, añadir una entrada al abrir el detalle desde la propia página, cerrarlo en popstate y hacer que cualquier otro cierre llame a `history.back()`. Convertir «Mostrando CEUM 3» en un botón que reabra el detalle.

#### UXM-8. Fuera del resumen de la asamblea nada avisa de que te toca responder

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `app/pages/index.vue:53-59`, `app/components/shell/Navigation.vue:67-84`, `app/components/home/Fold.vue:76-83`, `server/utils/domain/news.ts:74-76`, `app/pages/asambleas/[assembly]/directo.vue`
- **Qué pasa**: Inicio carga `/api/me/work` una sola vez y no se refresca ni al volver a la pestaña. El menú lateral no lleva contador y el de Novedades es el total de 30 días, no lo nuevo. El resumen de la asamblea sí refresca las tareas en vivo, y las correcciones encabezan Tareas pendientes.
- **Cuándo pasa**: antes de la sesión o en la ventana de voto de una AGET, una transaccional publicada 40-75 minutos antes espera la respuesta del autor principal, que tiene abierta una pestaña antigua de Inicio.
- **Impacto**: las respuestas que solo puede dar el autor llegan tarde y la Mesa acaba pidiéndolas de palabra.
- **Propuesta**: (a) refrescar `me-work` en `visibilitychange`; (b) un número discreto junto a «Inicio» con las tareas pendientes; (c) en Directo, una sola línea, y solo si la transaccional es del documento en debate; (d) «N nuevas» en Novedades a partir de la última visita guardada por navegador, como la bienvenida.

### Prioridad 3

#### UXM-9. Aceptar una transaccional sobre la enmienda propia se hace con un toque, no se puede cambiar y la tarjeta no enseña el texto

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/amendment/Acceptances.vue:128-134`, `app/components/amendment/Acceptances.vue:359-375`, `app/components/transactional/AuthorAnswer.vue:201-277`, `app/components/amendment/Detail.vue:787-810`, `server/utils/domain/amendments.ts:4346-4347`, `server/utils/domain/amendments.ts:4374-4387`
- **Qué pasa**: `asksFirst` confirma un rechazo y la aceptación de la Mesa que completa la transaccional, pero no la aceptación propia que la completa. Entonces la enmienda pasa a `transacted` y no se reabre, y una parte que ya respondió recibe 409. La tarjeta del detalle de la enmienda propia (`AuthorAnswer`) pone «Aceptar» como botón principal sin el texto de la transaccional. La tarea de Inicio sí lleva al detalle de la transaccional, con «Qué cambia» arriba.
- **Cuándo pasa**: con 10 transaccionales en 3,5 horas, un autor abre su enmienda en el móvil y acepta desde la tarjeta sin comparar la redacción.
- **Impacto**: un toque sin leer saca para siempre del debate la enmienda propia.
- **Propuesta**: `asksFirst = decision === "rejected" || completes(party)`, reutilizando `session.acceptance.confirmComplete.description` con una etiqueta propia («Aceptar y sustituir»). En `AuthorAnswer`, que la acción principal sea «Leer y responder» y abra la transaccional. Si se responde en la tarjeta, avisar de que la respuesta no se puede cambiar sin la Mesa. Alinear los dos componentes, sin diff abierto por defecto.

#### UXM-10. Textos que contradicen el proceso: «la votará la asamblea», quién admite una tardía y una transaccional que no existe

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `i18n/locales/es.json:1431`, `i18n/locales/es.json:1652`, `i18n/locales/es.json:2559`, `i18n/locales/es.json:2586`, `i18n/locales/es.json:4495`, `i18n/locales/en.json`, `app/components/amendment/PositionPanel.vue:209-221`
- **Qué pasa**: (1) La respuesta «Se acepta» dice «Después la votará la asamblea» (1431), pero la revisión (4495) y el flujo real aprueban las aceptadas por asentimiento. (2) `lateWarning` (1652) dice que la Mesa decide si admite una tardía, contra `validatedLate` (2586) y AGENTS.md: decide la asamblea. (3) Más débil: Novedades dice «{who} propone una transaccional sobre {amendment}» (2559) cuando es solo la respuesta guardada y no hay nada que aceptar.
- **Cuándo pasa**: un autor que leyó «la votará la asamblea» ve aprobar su enmienda por asentimiento; otro busca una transaccional que no existe.
- **Impacto**: representantes que rotan cada año esperan pasos que no llegan.
- **Propuesta**: usar en PositionPanel el texto de la revisión; unificar en «la asamblea decidirá si la trata»; en Novedades, «{who} quiere acordar un texto transaccional sobre {amendment}; todavía no lo ha presentado». Cambiar también en.json.

#### UXM-11. Los borradores de enmienda en Inicio y en «Mías» no dicen dónde actúan ni cuándo cierra el plazo

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/home/-work.ts:170`, `app/components/home/-work.ts:237-254`, `app/components/home/TaskList.vue:63-74`, `shared/types/api.ts:283-296`, `app/composables/amendment/useDocumentAmendments.ts:149-153`, `app/components/amendment/Card.vue:203-208`, `app/components/amendment/Detail.vue:297-308`
- **Qué pasa**: cada borrador sale como «Enmienda sin enviar · Documento: {document}» con la acción «Abrir», sin fecha (`dueAt: null`). `MeWorkAmendmentDto` no lleva ni el lugar ni la ventana de enmiendas. En el documento todos se llaman «Borrador» y la tarjeta solo añade la justificación, que en un borrador puede estar vacía.
- **Cuándo pasa**: CEUM prepara seis enmiendas al posicionamiento de Becas y ve seis filas iguales en Inicio y seis tarjetas «Borrador», sin ninguna mención de que las enmiendas cierran en T-4.
- **Impacto**: molestia frecuente con 27-65 enmiendas por posicionamiento. Es menor porque Inicio y el documento ya muestran el próximo hito.
- **Propuesta**: en el documento, añadir solo a los borradores el «dónde» de Detail.vue con los `blockLabels` que index.vue ya calcula. En `MeWorkAmendmentDto`, la etiqueta del lugar y el cierre de la ventana propia del documento, pintado como línea neutra («Cierre de enmiendas: …»; si ya pasó, «Si la envías ahora llegará fuera de plazo»), nunca como `overdue` en rojo. Las correcciones quedan exentas.

#### UXM-12. En el móvil, cada documento abre con los datos de la asamblea y una barra de lectura de varias filas antes del título

- **Esfuerzo**: S · **Verificación**: confirmado (las medidas en píxeles no se han reproducido)
- **Dónde**: `app/pages/asambleas/[assembly].vue:536-588`, `app/components/document/ReadBar.vue:53-150`
- **Qué pasa**: el `dl lg:hidden` con tipo, fechas y lugar se pinta en el cuerpo de todas las secciones; en los documentos solo se excluye el próximo plazo (`!onDocumentPage`). ReadBar pone en un `flex-wrap` Anterior, la posición, lo que queda por leer, «Marcar como leído» y Siguiente, que a 375 px ocupan varias filas. Según la medición del auditor, el texto empieza en y=720 de 812.
- **Cuándo pasa**: un delegado recorre en el móvil los 25 documentos con «Siguiente» y en cada uno ve «Asamblea General Ordinaria · del 18 al 22 de noviembre · Universidad de León» antes del título.
- **Impacto**: va contra el criterio de mostrar primero solo el asunto de la página, y suma desplazamiento en cada documento.
- **Propuesta**: aplicar a tipo, fechas y lugar el mismo `!onDocumentPage` que ya excluye el plazo. Por debajo de sm, ReadBar en una fila: Anterior y Siguiente solo con icono (con `aria-label` y `title`), «11/25», el botón de leído y lo que queda como enlace de la posición.

#### UXM-13. Un consejo no tiene dónde ver cómo acabaron todas sus enmiendas de la asamblea

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `server/utils/domain/review.ts:600-633`, `server/utils/domain/news.ts:74-76`, `app/pages/asambleas/[assembly]/index.vue`, `app/components/home/Fold.vue`, `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:1921-1949`
- **Qué pasa**: «Mías» solo existe dentro de cada documento. `loadMeWork` devuelve solo las enmiendas sin decidir, así que una decidida desaparece de «Mis documentos y enmiendas», y Novedades se corta en 30 entradas de 30 días.
- **Cuándo pasa**: en una AGO de 3 días, un consejo con unas 10 enmiendas en 6 documentos tiene que abrir los 6 y tocar «Enmiendas» y «Mías» en cada uno para saber cómo acabaron.
- **Impacto**: no queda un registro de resultados del consejo. Las pendientes ya están cubiertas por Tareas pendientes, y Directo muestra las siglas de los autores.
- **Propuesta**: un `HomeFold` plegado en el resumen, fuera de los tres bloques, «Mis enmiendas en esta asamblea»: una línea por enmienda, en orden del día, con código, documento, estado (`amendmentStatusLine`) y enlace con `?enmienda`. Requiere ampliar `/api/me/work` con las decididas de la asamblea o un endpoint propio. No cambiar el sentido de «Solo los míos».

#### UXM-14. Al retirar una enmienda conjunta, la confirmación no dice que se retira en nombre de todos los autores

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `server/utils/domain/amendments.ts:561`, `server/utils/domain/amendments.ts:2486-2487`, `i18n/locales/es.json:1396`, `i18n/locales/en.json`, `app/components/amendment/Detail.vue`
- **Qué pasa**: cualquier autor puede retirar (`withdraw = isAuthor && submitted`) y la confirmación solo dice «¿Retirar esta enmienda? No se debatirá.». No es silencioso ni irreversible: el autor principal recibe la novedad y la Mesa puede reabrirla antes de la votación final, aunque no vuelven las transaccionales que la retirada cerró.
- **Cuándo pasa**: en enmiendas conjuntas, que son frecuentes (19 de CEUAH y CEUM en la 34.ª AGE), el delegado de un coautor la retira desde el móvil sin consultar al autor principal.
- **Impacto**: bajo, pero obliga a la Mesa a reabrirla y puede costar transaccionales.
- **Propuesta**: con varios autores, que la confirmación los nombre: «La retiras también en nombre de CEUAH.». Opcional: «Quitar mi firma» para los coautores, con `amendment_authors_changed`. Limitar la retirada al autor principal es un cambio de regla que decide el propietario.

#### UXM-15. Ningún aviso fuera de la app para correcciones devueltas y documentos esperados

- **Esfuerzo**: M · **Verificación**: por confirmar
- **Dónde**: `package.json`, `server/plugins`, `app/components/home/-work.ts:26-46`, `app/components/home/-work.ts:163-171`, `shared/constants/domain.ts:25-34`
- **Qué pasa**: no hay correo, push ni .ics. Las correcciones devueltas y los documentos esperados con `dueAt` solo se ven dentro de la app, aunque encabezan Tareas pendientes. La cuenta del consejo es compartida y sus representantes cambian cada año.
- **Cuándo pasa**: Secretaría devuelve el jueves una enmienda para corregir su clasificación. El delegado cree que está hecha, no vuelve a entrar y el sábado la enmienda no está en el debate.
- **Impacto**: bajo. El propietario lo clasifica como deseable (R-OTR-03, «could», `docs/proceso-asambleas.md:358`), y los delegados entran a la plataforma para leer los documentos.
- **Propuesta**: un resumen diario por correo con pg-boss, solo cuando haya correcciones devueltas o documentos esperados con `dueAt` próximo o vencido. Requiere un relé SMTP nuevo y, en desarrollo, un transporte que solo registre (sin Mailpit). Antes, comprobar con Secretaría qué direcciones tienen las cuentas de los consejos. El .ics y el push aportan poco y no se recomiendan.

## Experiencia de Secretaría y Mesa

Cubre las herramientas con las que la Secretaría prepara la asamblea (orden del día, encargos, validación, convocatoria) y con las que la Mesa la dirige en la sala (consola, recuentos, votaciones, admisiones). La base es sólida, pero hay atajos de teclado que pueden decidir sobre la enmienda equivocada, recuentos de otro día que cambian los umbrales sin avisar y varios trámites reglamentarios que la plataforma no recoge.

### Prioridad 1: antes de la próxima asamblea

#### UXS-1. Los atajos «a», «l» y «v» pueden actuar sobre una enmienda que no está en debate

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/pages/asambleas/[assembly]/sesion.vue:150-178`, `app/composables/session/useSessionConsole.ts:415-435`, `app/composables/session/useSessionConsole.ts:857-869`, `app/components/session/QueueRow.vue:89-93`, `app/components/session/QueueRow.vue:107-108`, `app/components/session/AmendmentCard.vue:177`, `app/components/session/NowAmendment.vue:462-473`, `app/components/session/HeadcountPanel.vue:124`, `app/components/session/ConsoleToolbar.vue:130`
- **Qué pasa**: `withFocused` elige el destino de la tecla sin mirar qué hay en pantalla. Da prioridad a la fila enfocada sobre la enmienda en debate, y `focusedId` solo se vacía al cambiar de documento: si el debate avanza desde otro equipo, el foco se queda en la fila anterior. La tooltip de «Asentimiento» de la enmienda en debate enseña la «a», que sugiere lo contrario. Además, el modal del recuento (y los popovers de la barra) quedan fuera de `anyDialogOpen`, y `defineShortcuts` solo calla con el foco en un campo de texto: el foco inicial cae en el botón de cerrar y las casillas son botones.
- **Cuándo pasa**: la Secretaría despliega CEUM 4 para leerla, Presidencia pasa a UPV 9, la sala asiente y se pulsa «a»: se aprueba CEUM 4. O la Mesa abre «Nuevo recuento» y teclea «uam» sin entrar al buscador.
- **Impacto**: una decisión equivocada, proyectada a la sala y en el historial, justo antes de votar. Hay «Deshacer», pero el error es público.
- **Propuesta**: que `withFocused` y `move` ignoren las teclas con un `[role=dialog]` abierto o el foco en un popover, y llevar el `open` del recuento a la consola (como `speakerRenameDialog`). Al cambiar `liveState.amendmentId`, mover `focusedId` a la nueva enmienda en debate (como `debateNext`) o vaciarlo, sin excepción por el foco del DOM. Si la fila enfocada no es la de debate, confirmar nombrando el código.

### Prioridad 2

#### UXS-2. Las votaciones usan el recuento del día anterior sin decir que es de otro día

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/session/VoteFields.vue:98-123`, `app/utils/format.ts:112-122`, `app/composables/session/useSessionHeadcounts.ts:54-56`, `server/utils/domain/headcounts.ts:565-578`, `app/components/session/HeadcountPanel.vue:56`, `app/components/live-view/Attendance.vue:20`, `app/components/live-view/Attendance.vue:54`, `app/pages/proyeccion/[assembly].vue:396-419`
- **Qué pasa**: el formulario dice «Presentes del recuento de las {time}» con hora y minuto, sin fecha; el panel de recuentos y el directo, igual; la proyección enseña «40 de 45 · Mayoría absoluta 23 · Dos tercios 27» sin hora. El cliente y `withHeadcount` toman el último recuento de la asamblea sea del día que sea, y `headcountWarning` solo avisa si no hay recuento o falta quórum.
- **Cuándo pasa**: AGO de tres días. El martes a las 18:45 se cuentan 40; el miércoles a las 10:00 la Mesa vota una resolución por dos tercios antes de contar, con 32 en la sala. El umbral sale de 40 (27) y no de 32 (22): un 25/3/4 se registra y se proyecta como rechazada.
- **Impacto**: resultados equivocados en votaciones de dos tercios sin que nadie lo note.
- **Propuesta**: cuando el recuento no sea de hoy según Europe/Madrid (no el día del navegador), poner la fecha con el mismo texto en las cuatro vistas: «Recuento de ayer, 18:45». En VoteFields, un aviso que no bloquee junto a los que ya existen. No ocultar las mayorías de la proyección.

#### UXS-3. La admisión de enmiendas propone «Lo decide la Mesa» como método

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/session/AdmissionDialog.vue:36`, `app/components/session/AdmissionDialog.vue:57-64`, `app/components/session/AmendmentQueue.vue:328`, `app/composables/session/useSessionConsole.ts:1242`, `app/components/review/AdmissionModal.vue:13-20`, `server/utils/domain/amendments.ts:2707`
- **Qué pasa**: el diálogo pone `method = "mesa"` cada vez que se abre, también desde «Admitir todas» y desde «Deshacer». El método queda en la decisión y en el evento `amendment_admitted`. En cambio, `review/AdmissionModal` lo deja vacío a propósito, para que nadie registre «Lo decide la Mesa» sin elegirlo.
- **Cuándo pasa**: con prisa, tras un asentimiento de la sala, la Mesa pulsa «Admitir» sin tocar el método.
- **Impacto**: el registro atribuye a la Mesa un acuerdo de la asamblea. R-SES-03 pide dejar constancia del método, y pesa si se recurre la admisión.
- **Propuesta**: hacer lo mismo que AdmissionModal: `method` como `DecisionMethod | undefined`, sin valor al abrir y `!method` en `blocked`. No poner «Asentimiento» por defecto: el mismo diálogo registra la inadmisión de enmiendas en plazo, que es de la Mesa, y quién admite las tardías sigue abierto (`docs/proceso-asambleas.md:363`).

#### UXS-4. Presentar o enviar justo al cerrar el plazo dice «Alguien ha modificado estos datos»

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `server/utils/domain/documentCreate.ts:99-102`, `server/utils/domain/documents.ts:1956-1958`, `app/composables/api/useApi.ts:31`, `app/components/document/PublishDialog.vue:162`, `app/components/document/PublishDialog.vue:183`, `app/components/document/PublishDialog.vue:218`, `app/pages/asambleas/[assembly]/documentos/[document]/editar.vue:512-516`, `app/components/agenda/NewDocumentModal.vue:692-702`
- **Qué pasa**: los 409 de «plazo terminado» y «asamblea cerrada» no llevan `data.messageKey`, así que `notifyError` muestra `common.errors.conflict`: «Alguien ha modificado estos datos mientras tanto…». Las claves buenas ya existen (`agenda.submissionsDeadlinePassed`, `agenda.submissionsClosedAssembly`). Además, PublishDialog compara con `Date.now()` dentro de computeds que no se recalculan: abierto antes del cierre, sigue diciendo «en plazo» y deja reintentar.
- **Cuándo pasa**: un consejo pulsa «Enviar a Secretaría» a las 00:01, reintenta varias veces y escribe a la Secretaría creyendo que es un fallo.
- **Impacto**: falsos conflictos cada vez que cierra un plazo, cuando más se presenta, y se pierde el momento de pedir que se admita.
- **Propuesta**: añadir esos `messageKey` a los tres 409. En PublishDialog, `useAppNow()` en `deadlineCheck`, `dueCheck` y `windowCheck`, para que `blocked` frene a la hora exacta. Menor: dar su propio `messageKey` al 409 de número duplicado de Ajustes (`server/api/assemblies/[assembly]/index.put.ts:62-71`).

#### UXS-5. Los documentos tardíos no llevan marca ni la decisión de la asamblea

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `app/pages/asambleas/[assembly]/validacion.vue:267-283`, `server/utils/domain/documents.ts:178`, `server/utils/domain/documents.ts:1948-1962`, `server/utils/domain/amendments.ts:2702`, `shared/types/api.ts`
- **Qué pasa**: la única marca es la insignia `sentLate` de la bandeja, calculada en el cliente con `submittedAt`. Tras `documents_close` un miembro ya no puede presentar (409 salvo esperados o devueltos), así que los tardíos entran casi siempre por la Secretaría, que puede publicar un borrador sin presentarlo: entonces no hay ni insignia. Ningún DTO tiene `late` y solo las enmiendas escriben en `decisions`. El RRI 2025 art. 13.1.b y el RFAG 2025 art. 10.1.b someten los documentos tardíos a la Asamblea.
- **Cuándo pasa**: llega una resolución en T-1 (consta en las AGET 33 y 34, `docs/proceso-asambleas.md:77`); la Secretaría la crea y la publica, y la Mesa la debate sin que la asamblea haya acordado tratarla.
- **Impacto**: se salta un trámite sin recordatorio ni constancia, y el acuerdo queda expuesto a recurso.
- **Propuesta**: calcular `late` en el servidor solo para documentos no esperados, con la regla de `presentationClosed` e `isExpectedDocument`, y `candidacies_close` para candidaturas y sedes, para no marcar informes ni cuentas que la Secretaría añade legítimamente. Que alimente la insignia de la bandeja, una línea discreta en la consola y una decisión `admit_late` sobre el documento.

#### UXS-6. Encargar los documentos esperados cuesta decenas de acciones y deja plazos sin poner

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `app/components/agenda/BulkDocumentsModal.vue:354-362`, `shared/utils/schemas/document.ts:81`, `app/components/tracking/ExpectedDocumentModal.vue:119-127`, `app/components/tracking/ExpectedDocumentModal.vue:225-226`, `app/components/tracking/ExpectedDocumentModal.vue:272-278`, `app/components/agenda/NewDocumentModal.vue:233-246`, `app/pages/asambleas/[assembly]/seguimiento.vue:137-146`
- **Qué pasa**: «Añadir varios», en el orden del día, no pide plazo aunque el esquema acepta `dueAt` por fila y el servidor lo guarda; después cada plazo se pone uno a uno. ExpectedDocumentModal se vacía al abrir, no propone tipo ni título desde el punto, usa un `USelect` sin buscador que corta los títulos y se cierra tras cada alta.
- **Cuándo pasa**: en una AGO hay unos 12 informes de cargos de la CEA bajo un punto, más POA, cuentas, presupuesto y memoria, casi todos con el mismo plazo interno: entre 50 y 80 acciones solo para los informes.
- **Impacto**: horas en la semana de la convocatoria, y documentos sin plazo, que nunca salen «fuera de plazo» en el seguimiento (R-DOC-05).
- **Propuesta**: un campo opcional «Plazo interno» común en BulkDocumentsModal, enviado como `dueAt` en cada fila y contado en `dirty` para que Escape no lo pierda. En ExpectedDocumentModal, reutilizar `proposalFor`, `proposeFromItem` e `itemSelectUi` de NewDocumentModal en lugar de rehacerlos. Recordar el último plazo es secundario.

#### UXS-7. No hay un resumen de acuerdos de la asamblea para redactar el acta

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `server/utils/export/buildData.ts:214-279`, `server/utils/export/buildData.ts:451-547`, `server/utils/export/queue.ts:77-79`, `server/db/schema/session.ts:136-196`, `docs/proceso-asambleas.md:64`, `docs/proceso-asambleas.md:277`, `docs/design.md:25`
- **Qué pasa**: hay dos exportaciones: el dosier, con la línea de votación final de cada documento, y el PDF anotado de cada documento, con los recuentos de sus enmiendas. Nada reúne por punto del ODD el resultado final, las admisiones y la asistencia, aunque todo está en `votes`, `decisions` y `headcounts`. El acta de acuerdos se aprueba antes del cierre (R-TRZ-03, «must») y hoy llega tarde y con recuentos que no cuadran. `docs/design.md:25` dejó las actas fuera de esta iteración.
- **Cuándo pasa**: al acabar una AGO de unas 150 enmiendas y 25 documentos, la Secretaría copia a mano cada resultado.
- **Impacto**: el trabajo más largo y propenso a errores de la Secretaría tras cada asamblea.
- **Propuesta**: reabrir esa decisión solo para el acta de acuerdos: por punto, la votación final con método, mayoría y recuentos, las decisiones de admisión y los recuentos de asistencia con fecha y hora. Como la Secretaría la completa y la firma a mano, que se pueda copiar o editar, no solo un PDF de marca. Una página «Resultados», si se hace, va en `useAssemblySections` y solo para quien gestiona. El acta de sesión y el CSV quedan fuera.

### Prioridad 3

#### UXS-8. La consola deja debatir y proyectar documentos sin publicar sin decir su estado

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/session/AgendaPanel.vue:144-205`, `server/utils/domain/assemblies.ts:895-938`, `app/composables/session/useSessionConsole.ts:687-727`, `app/pages/proyeccion/[assembly].vue:651-679`, `app/composables/session/sessionModel.ts:984-997`
- **Qué pasa**: las filas de documento del panel de agenda no dicen si están publicados y ofrecen «Debatir». `updateLiveState` acepta un `documentId` sin publicar, a diferencia de las enmiendas, y la proyección abierta con una cuenta de la Mesa o de la Secretaría muestra su título y su presentador. La fila del punto y «Siguiente punto» ya avisan «(sin publicar)».
- **Cuándo pasa**: el último día la Secretaría crea una resolución tardía aún sin validar, y la Mesa pulsa «Debatir» sobre ella sin saberlo.
- **Impacto**: la sala ve un documento que la Secretaría todavía puede devolver. Son pocos casos.
- **Propuesta**: marcar «Sin publicar» con discreción en esas filas; al pulsar «Debatir», hacer lo que `requestDebate` ya hace con las enmiendas privadas (confirmar y publicar y debatir de una vez, o avisar si no se puede publicar). En el servidor, 409 a un `documentId` no público. Saltar esas filas en `sessionNextAgendaTarget` es opcional.

#### UXS-9. La Mesa no puede abrir la sesión, pero la consola le pide que lo haga

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/pages/asambleas/[assembly]/sesion.vue:249-260`, `app/pages/asambleas/[assembly].vue:260-262`, `server/api/assemblies/[assembly]/status.put.ts:24`, `i18n/locales/es.json:3226`, `app/pages/proyeccion/[assembly].vue:398`
- **Qué pasa**: un `UAlert` de aviso dice a todo el que modera «Abre la sesión desde la cabecera de la asamblea antes de votar», pero los botones de estado y el endpoint exigen `assembly:manage`, que Moderador no tiene. El servidor no impide votar fuera de sesión, y el aviso sale también con la asamblea cerrada.
- **Cuándo pasa**: primer día de la AGO, la Presidencia de la Mesa busca el botón en la cabecera y no lo encuentra.
- **Impacto**: confusión al empezar. Mientras nadie abre la sesión, la proyección oculta la asistencia y las posiciones con visibilidad «session» siguen ocultas.
- **Propuesta**: texto según quién lo lee, «Pide a la Secretaría que abra la sesión» sin `can.manage`, en una línea discreta en vez de una caja de color, y nada con la asamblea cerrada. Dejar que `session:moderate` abra la sesión es un cambio de política; si se hace, solo `convened → in_session`.

#### UXS-10. No se puede registrar un acuerdo sobre un punto sin documento

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `app/components/session/NowPanel.vue:156-164`, `app/components/session/NowPanel.vue:414-477`, `shared/constants/domain.ts:352-367`, `server/utils/domain/amendments.ts:2702`, `docs/proceso-asambleas.md:43`
- **Qué pasa**: con un punto sin documentos en debate, el panel «Ahora» solo ofrece dejar de debatirlo. `DECISION_KINDS` prevé `agenda_change` y `other`, pero solo la admisión de enmiendas escribe en `decisions`.
- **Cuándo pasa**: cada AGE y cada AGET abren con la ratificación de la urgencia (la 33.ª AGET acabó sin tratar nada porque no se ratificó). Dos o tres veces al año, casi siempre por asentimiento.
- **Impacto**: ese acuerdo no queda en la plataforma ni en la proyección. El rodeo, crear un documento `agreement` u `other` de una línea y votarlo, ensucia la lista de documentos.
- **Propuesta**: «Registrar acuerdo» bajo «Más» en el modo punto, que reutilice `VoteFields` y guarde una decisión `other` con su votación (`decision`), proyectada como las demás y visible en el historial.

#### UXS-11. El composer de transaccionales de la consola no deja añadir coautores fuera de las partes

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/session/TransactionalComposer.vue:22-24`, `app/components/session/TransactionalComposer.vue:115-118`, `app/components/session/TransactionalComposer.vue:150-153`, `server/utils/domain/amendments.ts:4066-4091`, `server/utils/domain/amendments.ts:3254`
- **Qué pasa**: el selector de autores solo ofrece a los autores principales de las enmiendas de origen, y `reseed` vuelve a filtrar por ellos al cambiar las fuentes. El servidor deja a la Mesa nombrar a cualquier miembro.
- **Cuándo pasa**: una transaccional negociada entre CEUM y el cargo de la CEA que presenta el posicionamiento (precedente: «Proponente: CEUM y V.Sostenibilidad», 34.ª AGET) sale solo a nombre de CEUM.
- **Impacto**: el registro queda mal, y corregirlo exige `amendment:review`: una cuenta de la Mesa con solo `session:moderate` depende de la Secretaría.
- **Propuesta**: ofrecer, detrás de las partes, al presentador principal y los copresentadores del documento y a los coautores de las fuentes, y filtrar `reseed` contra esa lista ampliada. Corregir el docstring, que promete una elección que la interfaz no da.

#### UXS-12. El diálogo de votación no lleva el foco a «A favor»

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/session/VoteDialog.vue:65-89`, `app/components/session/VoteFields.vue:152-218`, `app/components/session/FinalVoteDialog.vue`, `app/components/session/ConsoleToolbar.vue:51`
- **Qué pasa**: el modal se abre sin autofocus y el foco cae en el botón de cerrar; el método y la mayoría van antes de los recuentos. Rompe el flujo de teclado que ofrece el atajo «v», cuando otros diálogos del proyecto ya enfocan su campo principal.
- **Cuándo pasa**: en cada votación con recuento: las 20 a 30 votaciones finales de una AGO más las enmiendas votadas, con la sala esperando.
- **Impacto**: segundos y clics de más en cada votación.
- **Propuesta**: un prop opcional en VoteFields (por ejemplo, `focusCounts`) que ponga autofocus en «A favor» y lo omita con asentimiento, usado por VoteDialog y FinalVoteDialog; VoteFields también sirve a las admisiones, que no lo necesitan.

#### UXS-13. Mover un punto principal en un ODD definitivo pide una confirmación por paso

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/pages/asambleas/[assembly]/orden-del-dia/index.vue:363-381`, `app/utils/agendaTree.ts:48`, `app/utils/agendaTree.ts:463-468`
- **Qué pasa**: los movimientos son de un paso, y cada uno que cambia las raíces llama a `askFinalChange` y hace su propio PUT. Mover un punto ocho posiciones pide ocho confirmaciones y deja ocho eventos con `afterFinal: true`.
- **Cuándo pasa**: al reordenar en sesión con el ODD ya definitivo, para aplazar un punto o alterar el orden (R-SES-04, `docs/proceso-asambleas.md:338`).
- **Impacto**: fricción repetitiva en plena sesión y un historial lleno de pasos.
- **Propuesta**: recordar la confirmación mientras dure el modo «Organizar orden del día» y añadir «Mover a…» en el menú del punto, enviado como un solo reorder con `confirmFinal` (la API ya acepta varias entradas).

#### UXS-14. Los rechazos por tamaño no dicen cómo resolverlo, y las imágenes fallan antes de su límite

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/document/FileUpload.vue:38-62`, `app/components/document/DocxImport.vue:98-99`, `nuxt.config.ts:34-41`, `server/utils/domain/documentImages.ts:27`, `server/api/assemblies/[assembly]/documents/[document]/images.post.ts:14-23`, `app/components/content/BlockEditor.client.vue:930-951`, `app/components/document/DraftEditor.vue:160-175`
- **Qué pasa**: un PDF de más de 20 MB se rechaza en un toast que se cierra solo, con el límite (que la zona ya dice) y sin pista para reducirlo. Las imágenes del texto heredan `maxUploadFileRequestInBytes: 8_000_000` (unos 7,6 MiB) de `/api/assemblies/**` aunque el manejador admite 10 MiB, y el editor no comprueba el tamaño: «El archivo es demasiado grande», sin cifra.
- **Cuándo pasa**: un PDF de candidatura con escaneos (hubo uno de 188 MB en una AGET, `docs/proceso-asambleas.md:305`) o una foto de móvil de 9 MB en un posicionamiento.
- **Impacto**: bloqueos con prisa que acaban con el archivo enviado a la Secretaría por WhatsApp.
- **Propuesta**: en FileUpload, dejar el error escrito bajo la zona (como `fileError` en BulkDocumentsModal) con una pista: «Redúcelo con la opción de reducir tamaño de tu lector de PDF o vuelve a escanear a menos resolución». Una regla de ruta para `.../images` con unos 11_000_000 y una comprobación previa en el editor que diga el máximo. Claves en es y en.

#### UXS-15. Sustituir la convocatoria firmada borra el PDF original

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `server/utils/domain/convocation.ts:66-104`, `app/pages/asambleas/[assembly]/convocatoria/index.vue:168-172`
- **Qué pasa**: tras guardar la nueva, `removeConvocationPdf(previous)` borra la anterior sin avisar, y `uploadedAt` pasa a mostrar la fecha de la corrección. En cambio, los PDF de documentos sustituidos una vez publicados se conservan con `replacedAt`.
- **Cuándo pasa**: convocatorias con erratas o fechas que cambian después de convocar (`docs/proceso-asambleas.md:87-88`): la Secretaría sube la corregida.
- **Impacto**: se pierde en la plataforma el fichero publicado en T-31. La actividad conserva la fecha y el nombre del primero, y la prueba oficial está en el envío y en Drive, así que el daño es limitado.
- **Propuesta**: no borrar la anterior y guardarla con `replacedAt`, como `document_files`, visible solo para quien gestiona la asamblea. Así no hace falta ninguna confirmación.

#### UXS-16. Montar el orden del día obliga a crear cada punto en un modal que se cierra

- **Esfuerzo**: S (guardar y añadir otro); M (copiar el ODD) · **Verificación**: confirmado
- **Dónde**: `app/components/agenda/ItemFormModal.vue:209-215`, `app/pages/asambleas/[assembly]/orden-del-dia/index.vue:494-503`, `server/api/assemblies/index.post.ts:20-89`, `app/components/assembly/AssemblyCreateModal.vue`
- **Qué pasa**: la asamblea se crea solo con su calendario, y cada punto se crea en un modal que se cierra al guardar, sin «Guardar y añadir otro» ni copia de la asamblea anterior.
- **Cuándo pasa**: cada AGO, unas dos al año, repite un esqueleto de 22 a 26 puntos con subpuntos y los documentos que admite cada uno.
- **Impacto**: decenas de modales, y puntos que se quedan sin marcar como sitio donde presentar (se arregla editándolos).
- **Propuesta**: primero, «Guardar y añadir otro» en ItemFormModal, que conserve el punto superior y la elección de documentos. Después, «Copiar el orden del día de…» en AssemblyCreateModal (por defecto, la última asamblea del mismo tipo), con títulos, jerarquía, `acceptsSubmissions` y `submissionKinds`, sin documentos ni subpuntos automáticos.

#### UXS-17. En la página de un punto, la Secretaría ve cuatro botones, con «Eliminar» en rojo

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/agenda/ItemManageBar.vue:15-26`, `app/components/agenda/ItemManageBar.vue:295-338`, `app/pages/asambleas/[assembly]/orden-del-dia/[item].vue:320-321`
- **Qué pasa**: bajo el título salen «Editar», «Añadir subpunto», «Añadir documentos» y «Eliminar» (rojo, outline) al mismo nivel. El componente lo documenta como deliberado, según el plan de simplificación (2.1), anterior al criterio de una sola acción principal.
- **Cuándo pasa**: la Secretaría abre «12. Posicionamientos» para añadir documentos.
- **Impacto**: incumple el criterio de primer plano y deja la acción destructiva al lado de la habitual.
- **Propuesta**: dejar «Añadir documentos» como acción principal (y «Editar» como segunda si hace falta) y llevar «Añadir subpunto» y «Eliminar» a un botón «Más» con texto, con el patrón `moreItems`, no a un icono de tres puntos suelto, que el plan rechazó. El modo compacto de organizar se queda igual.

#### UXS-18. La bandeja de validación no enlaza a cada enmienda

- **Esfuerzo**: S · **Verificación**: por confirmar
- **Dónde**: `app/components/review/AmendmentCard.vue:14-36`, `app/components/review/AmendmentGroup.vue:409-414`, `app/components/amendment/Detail.vue:762-776`, `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:950`
- **Qué pasa**: la tarjeta solo ofrece validar, pedir corrección o validar sin publicar, y el único enlace es el del grupo, al documento. Reclasificar y corregir autores están en el detalle, en una sección que no se pliega, y la página del documento tiene buscador.
- **Cuándo pasa**: validando 65 enmiendas, la Secretaría ve que una «parcial» es de forma.
- **Impacto**: fricción en la tarea más repetida antes de cada asamblea, que invita a validar sin corregir.
- **Propuesta**: convertir el código de la tarjeta en enlace a `documentPath?enmienda=<id>`, como `app/components/live-view/AmendmentList.vue:42`. Opcional: «Cambiar a de forma / de contenido» bajo «Más» de la tarjeta, reutilizando Reclassify. Corregir quién la presenta se queda en el detalle.

#### UXS-19. Encargar un documento a un miembro por el que no ha entrado nadie promete que «lo verá»

- **Esfuerzo**: S (texto); M (dato para gestores) · **Verificación**: por confirmar
- **Dónde**: `app/components/tracking/ExpectedDocumentModal.vue:24-29`, `i18n/locales/es.json:4106`, `i18n/locales/es.json:4132`, `app/components/tracking/DocumentRow.vue:134-147`, `shared/types/api.ts:79-87`, `app/pages/admin/miembros.vue:300-307`
- **Qué pasa**: el modal dice «Lo verá en su inicio y lo preparará desde allí» y DeadlineModal, «Quien lo presenta verá el nuevo plazo», pero el encargo solo llega por `/api/me/work` a las cuentas vinculadas; no hay correo, y nada dice si el miembro tiene alguna.
- **Cuándo pasa**: un cargo cuya nueva titular aún no ha entrado, un cargo manual con siglas distintas de las de la intranet o el CdG, que por diseño no se vincula.
- **Impacto**: el seguimiento no distingue quién no lo recibió de quién no lo hizo, y la Secretaría se entera al vencer el plazo. No hay datos de cuántos casos hay.
- **Propuesta**: cambiar el texto a «Lo verá en su inicio quien entre por ese miembro» en los dos sitios. Como extra, un dato para gestores (si alguna cuenta con acceso actúa por ese miembro) en una línea discreta del seguimiento. Menor: que el alta manual de miembros empiece en `other` y no en `executive`.

#### UXS-20. La consola no dice cuántas enmiendas siguen sin posición del proponente

- **Esfuerzo**: S · **Verificación**: por confirmar
- **Dónde**: `app/components/session/AmendmentQueue.vue:168-180`, `shared/types/api.ts:224-229`
- **Qué pasa**: `positionsPending` solo existe para el propio presentador, y la cola de la consola cuenta el total, las que están sin decidir y las aprobadas, no las que faltan por responder. Por documento, la página «Revisar» ya da el progreso a la Mesa y a la Secretaría.
- **Cuándo pasa**: al abrir el debate de un posicionamiento de 65 enmiendas, la Mesa no ve cuántas posiciones faltan sin ir a «Revisar». Las posiciones se dan en la sala al empezar el debate, así que es el flujo normal.
- **Impacto**: menor: una cifra útil que la consola ya podría dar.
- **Propuesta**: añadir «N sin respuesta» a `sessionQueueCounts` y a la línea de recuentos de la cola, con los datos que la consola ya tiene y sin tocar ningún DTO. Una columna o un filtro en el seguimiento sería opcional.

## Rendimiento, fiabilidad, despliegue y datos

Esta sección cubre la carga que la sesión en directo pone sobre un único contenedor de 1 CPU, la exportación de PDF, la recuperación ante cortes de red o de base de datos, el despliegue y la vuelta atrás, y la conservación y coherencia de los datos. La base es sólida (SSE con reconexión, migraciones transaccionales, copias externas), pero dos riesgos pueden parar una sesión: el limitador de peticiones que comparte toda la sala y desplegar o volver atrás sin red de seguridad.

### Prioridad 1: antes de la próxima asamblea

#### OPS-1. Un solo cupo de peticiones por IP para toda la sala, Mesa incluida

- **Esfuerzo**: S · **Verificación**: por confirmar
- **Dónde**: `nuxt.config.ts:165-171`, `nuxt.config.ts:34-41`, `node_modules/nuxt-security/dist/runtime/server/middleware/rateLimiter.js:23-30`, `app/composables/live/useAssemblyLive.ts:12-13`
- **Qué pasa**: `rateLimiter` da 12 000 peticiones cada 300 s con clave `ip + route`, donde `route` es la regla más específica. Todo `/api/assemblies/**`, incluidos el SSE `/live` y las escrituras de la Mesa, comparte un cubo por IP de ventana fija; al vaciarse, todo responde 429 hasta que termina la ventana. `/api/me/*` y `/api/members` caen en otro cubo.
- **Cuándo pasa**: con unos 100 dispositivos tras el NAT del recinto, el uso intenso normal consume del 40 al 70 % del cupo. Si el SSE falla y muchos pasan a sondear (unas 8 peticiones por `poll` cada 15 s), unos 75 dispositivos lo vacían sin ninguna votación. Una vez agotado, el 429 en `/live` mete a todos en sondeo y `useRetryFailed` reintenta cada fuente: la ráfaga cae justo al reabrirse la ventana. Falta comprobar que se alcance en un recinto real.
- **Impacto**: si salta, la Mesa no registra votos ni turnos, la proyección no avanza y la sala queda desactualizada hasta 5 minutos.
- **Propuesta**: regla de ruta con `security: { rateLimiter: false }` en `/api/assemblies/**` y `/api/exports/**`, donde la sesión de Google ya es obligatoria; mantener el limitador en `/api/auth/**` y en las páginas. Si se quiere limitar a usuarios autenticados, un middleware propio posterior a la autenticación con clave por cuenta (nuxt-security no puede usar el usuario como clave). Reducir las recargas (REN-1) amplía el margen.

#### OPS-2. Desplegar o volver atrás durante una AGO no tiene red: ni copia previa ni comprobación del esquema

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `deploy.sh:171-180`, `rollback.sh:76-97`, `DEPLOYMENT.md:206`, `DEPLOYMENT.md:219`, `DEPLOYMENT.md:244-253`, `drizzle/0021_large_preak.sql:17`
- **Qué pasa**: deploy.sh migra sin `pg_dump` previo y DEPLOYMENT.md no explica cómo restaurar (la copia del clúster es un `pg_dumpall` de todos los proyectos). rollback.sh recrea cualquier imagen y la da por buena si `/api/health` responde, sin comparar sus migraciones con las aplicadas. Precedente: la 0021 borró `headcounts.call` y cambió la forma de `calendar_rules.quorum`, que la versión anterior leía.
- **Cuándo pasa**: un hotfix entre el día 2 y el 3 de una AGO (7 migraciones entraron solo el 10 de noviembre). Una migración que falla no deja la base a medias (drizzle las aplica en una transacción), pero una que termina bien y transforma mal los datos no se puede deshacer, y un rollback tras una como la 0021 rompe recuentos y quórum en plena sesión.
- **Impacto**: perder o no saber recuperar a tiempo una jornada de votaciones; la herramienta de emergencia empeora la situación.
- **Propuesta**: (1) en deploy.sh, antes de migrar, `pg_dump -Fc asambleas` a `backups/db/asambleas-predeploy-<fecha>.dump`, conservando los últimos N y abortando si falla; (2) sección «Restaurar» en DEPLOYMENT.md con `pg_restore --clean --if-exists` y `restic restore` de `asambleas/data/`; (3) rollback.sh compara las entradas de `drizzle/meta/_journal.json` de la imagen destino con `drizzle.__drizzle_migrations` y exige `--force` si la base va por delante; (4) deploy.sh avisa y pide confirmación, sin bloquear, si hay una asamblea `in_session`; (5) extender a todo el esquema y a los cambios de forma de los JSON la regla de AGENTS.md de borrar columnas una versión después.

### Prioridad 2

#### REN-1. Cada votación hace que cada cliente recargue datos que no han cambiado

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `app/composables/document/useDocument.ts:36-47`, `app/composables/document/useDocument.ts:88-100`, `app/composables/amendment/useDocumentAmendments.ts:198-201`, `app/pages/asambleas/[assembly]/directo.vue:264-265`, `app/composables/assembly/-liveFilters.ts:49-51`, `app/composables/readMarks/useReadMarks.ts:80-90`, `server/utils/domain/amendments.ts:1641-1673`
- **Qué pasa**: `isDocumentLiveBatch` da true con cualquier evento que lleve `documentId`, así que cada votación recarga el DocumentDto (con los bloques de la versión base, inmutable) y la lista completa de enmiendas con ops y justificaciones. `shouldRefetchAgenda` recarga el orden del día con votaciones, decisiones, posturas y aceptaciones, que no cambian `amendmentCount`. `provideReadMarks` se monta en el hub y recarga también en Directo, que no muestra las marcas.
- **Cuándo pasa**: debate de un posicionamiento con 65 enmiendas, unos 50 móviles en Directo y 30 portátiles en el documento: cada votación dispara unas 80 recargas de documento y lista, más las del orden del día y las marcas.
- **Impacto**: decenas de MB que construir y serializar por votación en 1 CPU con 10 conexiones; la siguiente petición de la Mesa espera detrás.
- **Propuesta**: (1, S) recargar el DocumentDto solo con eventos `entityType === "document"`, `poll` o cambio del documento en debate (Directo necesita `baseVersion.blocks`). (2, S) Excluir de `shouldRefetchAgenda`, con test, los tipos que solo cambian estado (`vote_recorded`, `decision_recorded`, `position_changed`, `acceptance_recorded`, `amendment_approved`, `amendment_rejected`, `amendment_lapsed`, `amendment_transacted`, `amendment_reopened`, `amendment_reclassified`) y hacer perezoso el proveedor de marcas. (3, M) Ante un evento de enmienda, pedir solo esa enmienda con un `GET .../amendments/[amendment]` sobre `amendmentDto()` y su `upsert`; la lista completa queda de respaldo, porque una votación puede cerrar transaccionales y competidoras.

#### REN-2. Maquetar un PDF congela el único proceso de la app durante segundos

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `server/plugins/export-worker.ts:100`, `server/plugins/export-worker.ts:190-208`, `server/utils/export/pdfBuilder.ts:813-815`, `server/utils/export/enqueue.ts`, `app/pages/asambleas/[assembly]/documentos/[document]/consolidado.vue:183-192`, `server/utils/content/docx.ts:1285-1295`
- **Qué pasa**: pdfmake 0.3.13 ejecuta `layoutDocument` y `renderPages` de forma síncrona dentro de Nitro, y la regla `pageBreakBefore` relanza la maquetación completa por cada encabezado que cae al pie. Cualquier lector puede pedir el PDF limpio o el anotado, y cada clic encola un trabajo nuevo. La importación DOCX, en cambio, ya corre en un proceso hijo limitado.
- **Cuándo pasa**: al empezar el debate de un posicionamiento con 60 enmiendas, una decena de delegados pide el PDF anotado, o la Secretaría exporta el consolidado cuando la Mesa pasa al punto siguiente. Los trabajos van de uno en uno: el proceso se congela en cada maquetación, varias veces seguidas. Falta medir el tramo síncrono del anotado más grande en 1 vCPU.
- **Impacto**: mientras se maqueta no responde nada (eventos, votaciones, proyección). No corta el SSE (latido cada 25 s), pero lo retrasa todo.
- **Propuesta**: (1) registrar por separado la duración de buildData y de pdfmake; (2) sacar el worker de pg-boss a un segundo contenedor de la misma imagen, con una variable que impida al web arrancar export-worker.ts, o a un proceso hijo que construya la definición desde `exportData` (`worker_threads` no sirve tal cual: la definición lleva funciones y un objeto fontkit); (3) reutilizar un PDF solo para el mismo solicitante y la misma revisión, porque el contenido depende del actor (cargos de la CEA, enmiendas sin publicar); (4) sustituir `pageBreakBefore` por una `stack` `unbreakable` con el encabezado y su primer bloque.

#### OPS-3. Un corte de PostgreSQL mata para siempre el worker de exportaciones

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `server/utils/export/queue.ts:50-56`, `server/utils/members/schedule.ts:240`, `server/plugins/export-worker.ts:216-218`, `node_modules/pg-boss/dist/worker.js:63-86`
- **Qué pasa**: la instancia PgBoss de las exportaciones no registra `on("error")`, a diferencia de la de la Intranet. En pg-boss 12 un fetch fallido emite `error`; sin listener, `emit` lanza ERR_UNHANDLED_ERROR, que sale del bucle del worker y lo termina. Nitro solo lo registra y el proceso sigue vivo, así que `restart: unless-stopped` no lo cura.
- **Cuándo pasa**: un reinicio de pocos segundos del PostgreSQL compartido en cualquier momento desde el último arranque (los workers consultan cada 2 s). Desde entonces «Exportar PDF» gira 3 minutos y avisa de tiempo agotado; la limpieza diaria de imágenes, en la misma instancia, también se para.
- **Impacto**: exportaciones rotas en silencio hasta que alguien reinicie el contenedor, sin nadie en la sala capaz de diagnosticarlo.
- **Propuesta**: en `startExportQueue`, antes de `start`, `instance.on("error", (error) => logError("export.queue", error))`, como en schedule.ts. Mejora secundaria: si el arranque agota sus reintentos, que `enqueueExport` responda 503 en vez de crear una instancia sin worker.

#### OPS-4. El cliente no detecta un stream SSE muerto en silencio

- **Esfuerzo**: S · **Verificación**: por confirmar
- **Dónde**: `server/api/assemblies/[assembly]/live.get.ts:17-37`, `server/api/assemblies/[assembly]/live.get.ts:64-66`, `app/composables/live/useAssemblyLive.ts:182-192`, `app/composables/live/useAssemblyLive.ts:219-224`, `app/composables/document/useDocumentPresence.ts:102-104`
- **Qué pasa**: el latido es un comentario SSE que el navegador no expone. useAssemblyLive solo reconecta con el evento `error`, `onOnline` solo actúa si no se cree conectado y no escucha `visibilitychange` ni `pageshow` (la presencia sí).
- **Cuándo pasa**: el portátil de la proyección o el de un delegado cambia de punto de acceso conservando la IP, o el router pierde su tabla NAT; un móvil se desbloquea entre votaciones con el EventSource roto. La conexión muere sin FIN y el indicador sigue en «conectado» hasta que vence el keepalive TCP, un plazo que depende del navegador, del sistema y del protocolo hacia Cloudflare.
- **Impacto**: pantallas que la sala cree en directo muestran turnos o resultados atrasados; lo más grave es la proyección.
- **Propuesta**: enviar el latido como evento con nombre `ping` (el camino de reserva de `writeComment` ya lo hace). En el cliente, guardar la hora del último `ready`, `change` o `ping` y, solo con la página visible, cerrar y reabrir el stream tras unos 60 s sin mensajes, lo que marca `missedChanges` y produce el `poll`. Al volver a visible tras más de 30 s oculta, y en `pageshow` con `persisted`, reconectar o encolar un `poll`.

#### DAT-1. Sin plazo de conservación: IP, sesiones caducadas y PDF exportados se guardan para siempre

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `server/utils/domain/audit.ts:186-206`, `server/db/schema/impersonation.ts:50-51`, `server/db/schema/auth.ts:100-101`, `server/utils/export/storage.ts:45-51`, `server/utils/export/storage.ts:142-146`, `server/utils/domain/imageCleanup.ts`, `docs/design.md:959-962`
- **Qué pasa**: recordAudit guarda IP y navegador en cada fila (también `auth.sign_in` y `export.request`), igual que `impersonations` y `sessions`. El diseño deja pendiente el trabajo de conservación de las dos primeras; `sessions` ni figura en el inventario, y better-auth solo borra una sesión caducada al consultarla. Nada borra `<jobId>.pdf` ni `<jobId>.json`: el `jobId` solo vive en ExportButton, así que cada PDF queda huérfano al cerrar la página, borradores ya eliminados incluidos (`download.get.ts:18-22`).
- **Cuándo pasa**: con 150 cuentas que rotan cada año, cada AGO deja IP de exrepresentantes y copias de textos borrados en disco y en restic.
- **Impacto**: incumple la limitación del plazo de conservación (RGPD art. 5.1.e) y complica atender un derecho de acceso o supresión. El disco es lo de menos.
- **Propuesta**: un trabajo diario de pg-boss `data-retention` con el patrón de imageCleanup.ts: anular IP y navegador en `audit_log` e `impersonations` pasado un plazo de al menos 30 días (por ejemplo, 12 meses, escrito en design.md); borrar `sessions` caducadas hace más de 7 días y `verifications` caducadas; borrar exportaciones con metadata `done` o `failed` de más de 1 a 7 días. No tocar `events` (`nextMemberSeq` los lee). Registrar con `logInfo`, o dar de alta la acción de auditoría completa (AUDIT_ACTIONS, AUDIT_PAYLOAD_KEYS, i18n e icono).

#### DAT-2. `carriedFromDocumentId` nunca se escribe: un punto aplazado se recrea a mano en la asamblea siguiente

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `server/db/schema/document.ts:107-110`, `docs/design.md:181`, `docs/proceso-asambleas.md:305`, `docs/proceso-asambleas.md:338`
- **Qué pasa**: la columna existe y design.md la describe, pero nada en app/, server/ ni shared/ la lee ni la escribe, y no hay ninguna acción para llevar un documento a otra asamblea, como pide R-DOC-06.
- **Cuándo pasa**: hay cadenas reales de arrastre (Refugios Climáticos: 79.ª AGO, 33.ª y 34.ª AGET; PO Becas, retirado en la 79.ª AGO y punto 14 de la 80.ª). La Secretaría crea un documento nuevo, vuelve a cargar el texto y elige otra vez a quienes presentan.
- **Impacto**: trabajo repetido, riesgo de partir de una versión equivocada y trazabilidad cortada entre asambleas.
- **Propuesta**: acción de gestor «Llevar a otra asamblea» en el menú «Más», para documentos `postponed` o `withdrawn`. Crea el borrador con `createDocuments` (`lockAssembly` y subpunto automático) desde la versión base, o desde la base con las enmiendas aprobadas aplicadas con `consolidate` (sin votación final no hay consolidada); copia el PDF en disco con su propia fila (`attachDocumentFile`). Precarga los presentadores, editables y validados con `requirePresentersMayPresent`. Rellena `carriedFromDocumentId`, registra eventos en las dos asambleas y muestra un enlace discreto («Viene de la 79.ª AGO») solo a quien pueda ver el origen. Las enmiendas no se copian.

### Prioridad 3

#### REN-3. Todos los clientes resincronizan a la vez al entrar en la asamblea y al volver la red

- **Esfuerzo**: S · **Verificación**: por confirmar
- **Dónde**: `app/composables/live/useAssemblyLive.ts:5`, `app/composables/live/useAssemblyLive.ts:115-120`, `app/composables/live/useAssemblyLive.ts:173`, `app/composables/live/useAssemblyLive.ts:210-224`
- **Qué pasa**: el lote se vacía a +300 ms exactos en todos los clientes; `onOnline` reabre el stream sin el jitter que sí aplica `scheduleReconnect`; y cada `connect()` hace un `poll` al primer `ready`, así que entrar en el hub lo pide todo dos veces (decisión documentada: el stream no tiene replay).
- **Cuándo pasa**: cuando la Mesa dice «entrad en la asamblea» y la sala entra junta. Un `online` simultáneo solo se da si vuelve la interfaz de red; si cae solo la salida a internet, ya hay backoff con jitter.
- **Impacto**: picos breves que retrasan la consola y la proyección, sin cambiar el trabajo total. Falta medirlo.
- **Propuesta**: jitter en `onOnline` (una línea). Resincronización condicional: `ready` envía el id o `createdAt` del último evento de la asamblea y el cliente solo hace `poll` si hubo eventos desde su primera carga. Dispersar el vaciado de quien solo mira retrasa que todos vean el resultado a la vez; si se hace, nunca en la consola ni en la proyección.

#### REN-4. La página de un documento descarga el editor tiptap aunque solo se vaya a leer

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:1502`, `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:1879`, `app/components/amendment/Composer.vue:1030`, `app/components/transactional/Composer.vue:865`, `app/components/content/BlockEditor.client.vue:4`
- **Qué pasa**: `AmendmentComposer` y `TransactionalComposer` se importan de forma estática y montan `ContentBlockEditor`, que importa tiptap/ProseMirror. En el build del 9 de noviembre el chunk de la página importa el de tiptap (579 KB; 179 KB con gzip), alrededor del 31 % de su JS.
- **Cuándo pasa**: un delegado abre en el móvil, con la Wi-Fi del recinto, el enlace de un documento para leerlo.
- **Impacto**: 179 KB más que descargar y unos 580 KB que compilar en móviles de gama media, una vez por dispositivo y despliegue.
- **Propuesta**: usar `LazyAmendmentComposer` y `LazyTransactionalComposer` (los dos: con uno solo el import sigue siendo estático) y comprobar tras el build que el chunk de la página ya no importa el de tiptap. Lo mismo vale para la consola de sesión (`sesion.vue`).

#### REN-5. Los PDF subidos se sirven con `no-store`: cada revisita los descarga enteros

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `server/api/uploads/documents/[filename].get.ts:110`, `server/api/uploads/convocations/[filename].get.ts:76`, `app/components/document/PdfViewer.vue:27-36`
- **Qué pasa**: las dos rutas responden `private, no-store` con `sendStream`, sin ETag ni `Accept-Ranges`. Cada subida tiene su propio nombre almacenado, así que una URL nunca cambia de contenido.
- **Cuándo pasa**: la Mesa pasa a un informe en PDF de 3 a 8 MB; cada portátil que vuelve a la página (la SPA recrea el iframe), va atrás o lo abre en una pestaña nueva lo descarga otra vez.
- **Impacto**: descargas repetidas por la Wi-Fi del recinto; la primera de cada portátil no la evita ninguna cabecera.
- **Propuesta**: `Cache-Control: private, no-cache` con un ETag tomado del `fileStat` que ya se calcula (mtime y tamaño) y 304 si coincide `If-None-Match`, manteniendo la comprobación de visibilidad en cada petición. No usar `immutable`. Opcional: atender `Range` a mano (206 y `Content-Range`) para la vista progresiva.

#### REN-6. Cada carga del orden del día descomprime el texto de todos los documentos

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `server/utils/domain/documents.ts:757-782`, `server/utils/domain/documents.ts:847-850`, `server/utils/domain/assemblies.ts:611-623`, `server/utils/domain/documents.ts:2073`
- **Qué pasa**: `loadContentFlags` ejecuta `jsonb_array_length(blocks)` sobre la versión de trabajo de cada documento estructurado, lo que obliga a Postgres a leer de TOAST y descomprimir el jsonb entero en cada `buildDocumentSummaries` (orden del día, documentos, `/me/work`, bandeja).
- **Cuándo pasa**: 25 documentos de 10 a 35 páginas, con el orden del día recargado por los clientes del hub en muchos eventos (REN-1).
- **Impacto**: pocos ms de Postgres por petición, multiplicados por el abanico de recargas.
- **Propuesta**: dar `hasContent = true` a todo documento estructurado con `baseVersionId` (publicar ya rechaza un borrador vacío) y calcular `jsonb_array_length` solo para los demás, sin cambiar el esquema.

#### OPS-5. Al apagar, los streams SSE impiden el cierre ordenado y alargan cada despliegue

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `docker-compose.production.example.yml:5-36`, `server/api/assemblies/[assembly]/live.get.ts:64-66`, `server/plugins/export-worker.ts:210-213`, `server/utils/export/queue.ts:64`, `DEPLOYMENT.md:206`
- **Qué pasa**: Nitro espera `NITRO_SHUTDOWN_TIMEOUT` (30 s) a que terminen las conexiones antes de los hooks `close` y no destruye un stream SSE en curso; Docker manda SIGKILL a los 10 s. Con un solo cliente conectado, ni `boss.stop()` ni `stopLiveHub()` llegan a ejecutarse, y el servidor viejo rechaza conexiones nuevas esos 10 s.
- **Cuándo pasa**: un hotfix entre días de una AGO con delegados conectados.
- **Impacto**: unos 10 s más de corte por despliegue (los clientes se recuperan solos con `ready`), y una exportación en curso queda `active` hasta una hora.
- **Propuesta**: fijar `NITRO_SHUTDOWN_TIMEOUT` a unos 2000 en el `environment` del compose, sin tocar `stop_grace_period` (alargarlo prolonga el rechazo). Alternativa más limpia: que el hub cierre todos los streams en SIGTERM. Bajar `expireInSeconds` de las exportaciones a unos 600 y corregir en DEPLOYMENT.md la duración del corte.

#### OPS-6. Las imágenes del editor de 7,6 a 10 MiB reciben un 413 genérico

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `nuxt.config.ts:34-65`, `server/utils/domain/documentImages.ts:27`, `app/components/document/DraftEditor.vue:160-172`
- **Qué pasa**: el servidor y la documentación admiten 10 MiB, pero `POST .../documents/[document]/images` solo casa con `/api/assemblies/**`, cuyo `maxUploadFileRequestInBytes` es 8 000 000 para toda la petición multipart; `/file`, `/import` y `/convocation` tienen su propia regla. Como `notifyError` nunca muestra el texto del servidor, el editor dice «El archivo es demasiado grande.» sin el límite.
- **Cuándo pasa**: alguien pega en un borrador una foto del móvil o una captura PNG grande.
- **Impacto**: fricción al redactar con imágenes que el contrato dice aceptar.
- **Propuesta**: regla `/api/assemblies/*/documents/*/images` con `maxUploadFileRequestInBytes: 11_000_000`, y que el 413 lleve un `data.messageKey` que diga 10 MB (como las claves de 15 y 20 MB que ya existen), o que DraftEditor compruebe `file.size` antes de subir.

#### DAT-3. Borrar una asamblea en borrador deja en disco los PDF de sus documentos

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `server/api/assemblies/[assembly]/index.delete.ts:86-120`, `server/api/assemblies/[assembly]/agenda/[item].delete.ts:213-217`, `server/utils/domain/documents.ts:2172-2184`
- **Qué pasa**: el borrado elimina las filas en cascada y solo quita el PDF de la convocatoria. No recoge `documents.file_url` ni `document_files.stored_name` como `removeDocument` y el borrado de un punto, y no hay barrido de PDF huérfanos (el de imágenes ya existe).
- **Cuándo pasa**: la Secretaría borra una asamblea creada duplicada o con el tipo equivocado tras subir candidaturas en PDF. Ya pasó en producción con una asamblea de prueba: cuatro PDF quitados a mano.
- **Impacto**: datos personales sin finalidad en disco y en las copias, que la aplicación ya no sirve (404) ni permite localizar.
- **Propuesta**: dentro de la transacción y antes del delete, seleccionar las rutas de los PDF de la asamblea y borrarlas con `removeStoredPdf` tras el commit.

#### DAT-4. La referencia oficial (RES 004/2026) no sigue al documento

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `server/utils/domain/documents.ts:1164-1186`, `server/utils/domain/documents.ts:2091-2092`, `server/utils/domain/documents.ts:1524-1529`, `app/components/document/MetadataForm.vue:812-827`, `server/utils/domain/documents.ts:2218`
- **Qué pasa**: publicar solo asigna referencia si no la hay, y un gestor puede cambiar el tipo de un documento publicado sin tocarla, aunque la banda del PDF sale del tipo. `assignReference` toma el máximo de las referencias vivas, así que borrar la última publicada libera su número.
- **Cuándo pasa**: la Secretaría corrige el tipo tras publicar y queda «RES 004/2026» con la banda «Posicionamiento». La reutilización exige borrar un publicado sin enmiendas, lo que es raro.
- **Impacto**: referencias incoherentes o duplicadas en el orden del día y los PDF, que son el identificador con el que se citan los acuerdos.
- **Propuesta**: una vez publicado, responder 409 a un cambio de tipo que cambie el prefijo (o que pase a uno con prefijo) y pedir retirarlo y crearlo de nuevo. Para no reutilizar números, contar en el máximo los `reference` de los payloads `document_deleted`.

#### DAT-5. Las mociones de procedimiento no tienen dónde registrarse

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `shared/constants/domain.ts:352-366`, `server/utils/domain/amendments.ts:2685`, `server/utils/domain/amendments.ts:2702`, `server/utils/domain/amendments.ts:3710`, `server/utils/domain/documents.ts:2645`, `docs/proceso-asambleas.md:338`
- **Qué pasa**: `DECISION_KINDS` prevé `unify`, `agenda_change` y `other`, y `VOTE_SUBJECTS` prevé `other`, pero solo se escriben decisiones de admisión y votos de enmienda, finales y de admisión. R-SES-04 pide registrar las mociones de procedimiento.
- **Cuándo pasa**: una delegación pide votar en bloque las enmiendas aceptadas, u otra aplazar la votación final (actas de la 77.ª y la 79.ª AGO). La Mesa puede ponerlo en pantalla con el mensaje de `live_state`, pero no queda en el historial ni en la exportación.
- **Impacto**: decisiones que cambian cómo se vota todo lo demás quedan fuera del registro estructurado.
- **Propuesta**: `POST .../decisions` (`session:moderate`, asamblea `in_session`) que inserte la decisión y, si se vota, su voto, reutilizando `withHeadcount` y `evaluateVoteInput` como `decideAmendmentAdmission`, con `decision_recorded` y `vote_recorded`. En la consola, como entrada del menú «Más».

## Cliente, idiomas y exportación a PDF

Esta área cubre el comportamiento del cliente (navegación, compositores, sesión, hidratación y directo), los textos y traducciones y la exportación a PDF. Lo esencial funciona, pero hay un riesgo claro de perder enmiendas a medio escribir, y algunos PDF pueden afirmar algo falso o congelar la sala unos segundos.

### Prioridad 1: antes de la próxima asamblea

#### CLI-1. Una enmienda o transaccional a medio escribir se pierde sin aviso al pasar a otro documento

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/components/amendment/Composer.vue:809`, `app/components/transactional/Composer.vue:584`, `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:1309`, `app/components/document/ReadBar.vue:62`, `app/components/document/ReadBar.vue:143`
- **Qué pasa**: los compositores solo protegen la salida con `onBeforeRouteLeave`, y en `app/` no hay ningún `onBeforeRouteUpdate`. Ir de `/documentos/a` a `/documentos/b` es el mismo registro de ruta: vue-router 5.4 no llama a los guardas de salida, pero Nuxt usa la ruta con parámetros como key y vuelve a montar la página, así que el compositor desaparece sin preguntar. `beforeunload` no salta en una navegación SPA. `DocumentReadBar` sigue visible con el compositor abierto y sus «Anterior» y «Siguiente» añaden entradas al historial.
- **Cuándo pasa**: un delegado llega a RES 4 con «Siguiente», redacta una enmienda durante 15 minutos y hace el gesto «atrás» del móvil para cerrar el editor: vuelve a RES 3 y lo escrito se pierde. Igual con un toque por error en «Anterior» o «Siguiente».
- **Impacto**: pérdida silenciosa de enmiendas y transaccionales; unas 150 por AGO, muchas escritas en la sala o la última mañana.
- **Propuesta**: añadir en los dos compositores `onBeforeRouteUpdate` con la misma pregunta, solo cuando `to.path !== from.path` (así no salta con el `replace` de `?enmienda=`); conviene un composable común que registre también `onBeforeRouteLeave` y `beforeunload`. Ocultar `DocumentReadBar` con el compositor abierto (`v-if="!composer"`, como el resumen en `index.vue:1402`). `editar.vue` y `revisar.vue` no lo necesitan.

### Prioridad 2

#### CLI-2. Un corte de red o un 5xx manda al login, también al abrir una enmienda

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/middleware/auth.global.ts:19-37`, `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:1146-1157`, `app/composables/security/useMe.ts:94-99`, `app/pages/login.vue`
- **Qué pasa**: el middleware global vuelve a comprobar la sesión si han pasado más de 2 minutos y, ante cualquier excepción del `$fetch` a `/api/auth/session`, redirige a `/login`, sin distinguir un 401 de un fallo de red o un 502. Nuxt lo ejecuta en cada navegación, también en el `router.replace` de `?enmienda=`. `useMe`, en cambio, conserva el estado ante fallos transitorios.
- **Cuándo pasa**: la Wi-Fi del recinto se cae unos segundos y un delegado toca una tarjeta de enmienda; o alguien navega durante un despliegue (502 de nginx).
- **Impacto**: expulsa a delegados y a la Mesa en plena sesión. Sin red no pueden ni volver a entrar, y luego tienen que pasar por Google aunque su sesión seguía válida. No se pierden datos, porque `redirect` conserva la ruta.
- **Propuesta**: redirigir solo ante 401 o 403; ante un error de red o un 5xx, dejar pasar la navegación sin actualizar `lastCheckedAt`. Saltarse la comprobación cuando solo cambia la query (`to.path === from.path`). Secundario: `localePath('/login')` y que el login devuelva a `redirect` a quien ya tiene sesión.

#### CLI-3. Los compositores de enmiendas y transaccionales guardan el texto solo en memoria

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `app/components/amendment/Composer.vue:156-171`, `app/components/amendment/Composer.vue:1261-1270`, `app/components/transactional/Composer.vue:589-593`, `app/components/session/HeadcountPanel.vue:85-104`
- **Qué pasa**: el estado del compositor son refs, sin guardado automático ni copia local. «Guardar borrador» solo aparece en la fase de revisión, y el compositor de transaccionales no guarda nada hasta crearla. El patrón de copia local ya existe en `HeadcountPanel`, que guarda el recuento en localStorage para no perderlo al cerrar o recargar.
- **Cuándo pasa**: un delegado redacta desde el móvil una enmienda larga la última mañana, cambia a WhatsApp para consensuarla y el sistema descarta la pestaña; al volver, la página se recarga vacía (`beforeunload` no salta). Igual si el portátil se queda sin batería o el navegador se cuelga.
- **Impacto**: hay que reescribir enmiendas largas con el plazo encima; algunas llegan fuera de plazo o no llegan.
- **Propuesta**: copia local con debounce (modo, bloques u operaciones, tipo, justificación, autores, `draftId`, `baseVersionId`, hora) bajo `amendment-composer:<documentId>:<draftId|new>`, borrada al enviar, descartar o guardar en el servidor. Al abrir el compositor sobre la misma versión base, ofrecer recuperarla con una línea discreta dentro del propio compositor. Lo mismo en el de transaccionales. Permitir guardar sin tipo exigiría cambiar el esquema (`shared/utils/schemas/amendment.ts:103`) y es secundario. Esta copia también cubre el caso de CLI-1.

#### CLI-4. La página de un punto del orden del día dice «ya no existe» al renombrarlo

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/pages/asambleas/[assembly]/orden-del-dia/[item].vue:47-53`, `app/pages/asambleas/[assembly]/orden-del-dia/[item].vue:89-104`, `app/pages/asambleas/[assembly]/orden-del-dia/[item].vue:276-289`, `app/components/agenda/ItemManageBar.vue:146-154`, `app/utils/agendaTree.ts:169-174`
- **Qué pasa**: la página resuelve el punto por slug o por id, y el slug sale del título sin guardarse. Tras renombrar, el parámetro ya no coincide, `findAgendaNode` busca por id y no encuentra nada, y se muestra el estado «gone». El watch que debería mover la URL al nuevo slug observa `item.value?.slug`, ya undefined, y nunca salta, al contrario de lo que promete la cabecera del archivo.
- **Cuándo pasa**: la Secretaría corrige el título de «3. Resoluciones» desde «Editar» en la barra del propio punto; quien lo tenía abierto en directo ve lo mismo. También en los subpuntos automáticos cuando su documento cambia de título (`syncAutoItemTitle`).
- **Impacto**: la Secretaría cree que ha borrado el punto y los delegados, que ha desaparecido.
- **Propuesta**: guardar en un ref el último id resuelto (como ya se hace con `parentId`, líneas 227-230) y usarlo como respaldo en `itemId` cuando el parámetro no coincide con ningún slug; el watch existente reemplazará la URL. Que los enlaces antiguos dejen de funcionar tras renombrar es deliberado (`shared/utils/slug.ts`) y no se toca.

#### CLI-5. En escritorio, un documento sin enmiendas carga con el panel vacío visible y el interruptor al revés

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:149`, `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:1099-1138`
- **Qué pasa**: `isDesktop` sale de `useMediaQuery` sin `provideSSRWidth`: el servidor pinta `false` y el cliente calcula `true` al hidratar. De él dependen `listHidden`, `textOnly`, `amendmentsPanelClass` y `textPanelUi`, y en producción Vue no corrige las clases al hidratar, así que el DOM se queda con las del servidor. `sesion.vue` no está afectada: va dentro de `ClientOnly`.
- **Cuándo pasa**: en cada carga completa en un portátil (recargar, abrir un enlace de un chat, pestaña nueva) de un documento publicado sin enmiendas. Se ve «No hay enmiendas» junto al texto mientras el botón dice «Mostrar enmiendas (0)», y el primer clic no cambia nada. También con `wideCompare` al llegar en modo comparar.
- **Impacto**: confunde y contradice el último commit, que quería mostrar el texto limpio en esos documentos.
- **Propuesta**: sacar `isDesktop` de los computed que solo dan clases, que ya llevan prefijo `lg:`; dejarlo solo para el comportamiento (detalle en modal o al lado) y pintar el botón con `hidden lg:inline-flex` en lugar de `v-if`. `useMounted` evitaría el desajuste, pero el panel parpadearía en cada carga.

#### I18N-1. Cada exportación a PDF congela el servidor unos segundos

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `server/plugins/export-worker.ts:100`, `server/plugins/export-worker.ts:192`, `server/utils/export/pdfBuilder.ts:813-815`, `server/utils/content/docx.ts:47-51`, `app/components/export/ExportButton.vue:54`
- **Qué pasa**: `pdfmake.createPdf(...).write(...)` corre dentro del proceso de Nitro y su maquetación es síncrona; además la rehace entera por cada salto que añade `pageBreakBefore`. Mientras dura se detienen el SSE, la consola de la Mesa, la proyección y cualquier petición. Un agente midió unos 4-7 s para un texto de 44 páginas en su máquina. Los trabajos van en serie y las dos colas comparten hilo. El repositorio ya sacó mammoth a un proceso aparte por lo mismo.
- **Cuándo pasa**: basta una exportación de un posicionamiento largo durante la sesión, por ejemplo tras la votación final.
- **Impacto**: la proyección, los turnos y los resultados se paran unos segundos para toda la sala; con varias exportaciones seguidas parece que la plataforma se ha caído. Las conexiones no se cortan.
- **Propuesta**: renderizar en un proceso hijo, como mammoth (no en un worker_thread con resourceLimits, que `docx.ts:50-51` ya descarta). Opcional: caché del PDF limpio por (versión, votación final, idioma), asociando el fichero compartido a cada trabajo, porque la descarga se autoriza por trabajo. No sustituir `pageBreakBefore` por pilas `unbreakable`: pdfmake recortaría en silencio lo que no cabe en una página.

#### I18N-2. Votación final por asentimiento: el PDF imprime «por mayoría… (votos a favor: 0, en contra: 0, abstenciones: 0)»

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `server/utils/export/pdfBuilder.ts:489-512`, `server/utils/export/pdfBuilder.ts:766`, `app/components/session/FinalVoteDialog.vue:39`, `i18n/locales/es.json`, `i18n/locales/en.json`
- **Qué pasa**: la votación final admite asentimiento y guarda 0/0/0 con la mayoría del documento. `finalVoteLine` ignora `vote.method`, que sí llega en `toExportVote`, e imprime mayoría y recuento con `export.pdf.finalVote.approved`. Solo la línea de aprobación de la plantilla trata el asentimiento (`approvalLine.ts:97-98`). En el anotado la línea de voto sale siempre; en el limpio, cuando el texto no trae la línea de la plantilla.
- **Cuándo pasa**: una resolución, un posicionamiento o una moción en texto aprobados sin oposición. Las actas suelen subirse en PDF y no se exportan.
- **Impacto**: el documento que se archiva y se difunde afirma cero votos a favor para algo aprobado.
- **Propuesta**: clave `export.pdf.finalVote.assent` («Aprobado por asentimiento en la {assembly} el {date}.» / «Approved by assent at the {assembly} on {date}.»), usada cuando `vote.method === "assent"`, sin mayoría ni recuentos, y un test en `export.test.ts`.

#### I18N-3. «Mañana» y «pasado mañana» redondean horas: el plazo puede leerse con un día de más

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/utils/format.ts:162-172`, `app/components/common/Countdown.vue:40-46`, `app/components/document/DocumentHeader.vue:236-242`
- **Qué pasa**: para días o más se calcula `Math.round(seconds / size)` y se formatea con `Intl.RelativeTimeFormat(..., { numeric: "auto" })`, que convierte 1 y 2 en «mañana» y «pasado mañana». `DocumentHeader`, el único sitio que muestra el plazo de enmiendas de un documento, enseña solo esa forma; la fecha absoluta queda en un `title` que no se ve en el móvil.
- **Cuándo pasa**: con los plazos reales a las 23:59 de Madrid, el día anterior antes de las 11:59 faltan 36 h o más y la cabecera dice «Cierre de enmiendas pasado mañana»; dos días antes a las 09:00, «dentro de 3 días». En inglés, «in 2 days».
- **Impacto**: el error va hacia el lado peligroso: lleva a presentar fuera de plazo y a depender de que la Mesa admita la enmienda.
- **Propuesta**: para unidades de día o mayores, contar días naturales en Europe/Madrid con `@internationalized/date` (ya importado en `format.ts`) y añadir un test del redondeo. Opcional: «mañana a las 23:59» en la misma línea discreta.

#### I18N-4. «PDF limpio» en el texto consolidado descarga el texto publicado, sin las enmiendas aprobadas

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/pages/asambleas/[assembly]/documentos/[document]/consolidado.vue:183-192`, `server/utils/export/rules.ts:33-50`, `server/utils/export/buildData.ts:360-372`, `server/utils/export/pdfBuilder.ts:753`
- **Qué pasa**: la página del consolidado ofrece «PDF limpio» junto al texto provisional con las enmiendas aprobadas, pero `pickCleanVersion` solo usa `consolidatedVersionId`, que nace con la votación final; antes devuelve el texto base. El PDF solo lleva marca cuando es un borrador, así que nada avisa. El anotado de esa misma página sí aplica la consolidación provisional.
- **Cuándo pasa**: con al menos una enmienda aprobada y sin votación final; por ejemplo, en pleno debate alguien imprime o comparte el limpio para ver cómo queda el texto.
- **Impacto**: se discute sobre un papel que no recoge lo aprobado, sin ninguna advertencia.
- **Propuesta**: ocultar «PDF limpio» en el consolidado hasta la votación final; el anotado ya exporta el estado provisional y queda un solo botón. Si se prefiere un limpio provisional con `consolidate(...).blocks`, debe llevar una marca discreta «PROVISIONAL» y decir qué enmiendas aprobadas quedaron fuera por conflicto, como hace el anotado.

#### I18N-5. Los rechazos de negocio (409) se muestran como «Alguien ha modificado estos datos»

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `app/composables/api/useApi.ts:26-35`, `server/utils/domain/documents.ts:1957`, `app/pages/asambleas/[assembly]/documentos/[document]/editar.vue:293-298`, `app/pages/asambleas/[assembly]/documentos/[document]/editar.vue:514-516`
- **Qué pasa**: `notifyError` traduce todo 409 sin `messageKey` como `common.errors.conflict`. En `server/` hay 95 `fail(409` y ninguno lleva clave, entre ellos «El plazo de presentación de documentos ha terminado». En `editar.vue`, `canSubmit` no mira el plazo aunque la página ya calcula `documentsClose` y `deadlineExempt`.
- **Cuándo pasa**: un consejo termina su resolución minutos después del cierre de las 23:59 y pulsa «Enviar a Secretaría»: lee «No se ha podido enviar el documento. Alguien ha modificado estos datos mientras tanto…» y reintenta.
- **Impacto**: un mensaje falso que no dice qué hacer, justo al cierre del plazo, y más consultas a la Secretaría.
- **Propuesta**: 1) `messageKey` en los 409 de negocio que se alcanzan de verdad, al menos plazo cerrado y asamblea cerrada (puede reutilizar `agenda.submissionsDeadlinePassed`), en es y en. 2) En `editar.vue`, con el orden del día ya cargado, ocultar el envío si `documentsClose` pasó y no hay `deadlineExempt`, y poner una línea discreta. 3) Marcar los 409 de `assertOptimisticLock` (`data.code: 'stale'`) y reservarles el texto de conflicto; los demás sin clave, con un texto neutro.

#### I18N-6. La fuente del PDF no tiene glifos para ligaduras ni Latín Extendido: salen cajas

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `server/assets/fonts/Raleway-Regular.woff`, `server/utils/export/pdfmake.ts`, `server/utils/export/content.ts`
- **Qué pasa**: los Raleway empaquetados son un subconjunto de unos 270 glifos (latín básico, Latín-1 y algunas comillas y símbolos). Faltan las ligaduras U+FB00-FB06, el Latín Extendido-A, U+2010/2011, ≥ y →. pdfmake no recurre a otra fuente y dibuja el `.notdef`, una caja; en pantalla el navegador sí recurre a otra y todo se ve bien.
- **Cuándo pasa**: ya en los datos de la 80.ª AGO: «Ratiﬁcar» y «ﬁnes» (texto pegado desde un PDF) en un reglamento y «Gwosć» en la bibliografía de dos posicionamientos.
- **Impacto**: el PDF oficial pierde caracteres sin que nadie lo note en la plataforma.
- **Propuesta**: lo mínimo, convertir U+FB00-FB06 en sus letras al exportar o al guardar (no con NFKC completo, que cambiaría ª, º, ² y ½). De fondo, empaquetar para el PDF un Raleway con latin-ext; la interfaz puede seguir con el subconjunto. Añadir un test con fontkit que compruebe que cada carácter exportado tiene glifo. Una fuente de reserva por glifo es opcional.

#### I18N-7. No hay forma de llevarse las enmiendas de un documento para leerlas sin conexión

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `server/utils/export/buildData.ts:281-309`, `server/utils/export/pdfBuilder.ts:630-697`, `app/pages/asambleas/[assembly]/documentos/[document]/index.vue`, `docs/proceso-asambleas.md:357`
- **Qué pasa**: el anotado solo incorpora las enmiendas aprobadas; antes de la sesión es el texto base más un anexo con código, autoría, tipo y estado, sin texto propuesto ni justificación. No hay modo sin conexión y el área de trabajo muestra las enmiendas de una en una. La petición consta en R-OTR-02 (ruego del Acta de la 77.ª AGO).
- **Cuándo pasa**: un consejo quiere leer en el tren, o con la Wi-Fi del recinto caída, las 65 enmiendas a un posicionamiento con sus justificaciones.
- **Impacto**: las delegaciones preparan peor el debate y dependen de la red cuando más se lee.
- **Propuesta**: una entrada «Enmiendas (PDF)» en el menú «Más» del documento, sin botones visibles nuevos: las enmiendas publicadas y visibles para quien lo pide, en el orden del texto, con código, quién la presenta, el cambio (`annotatedToPdf` sobre esa sola enmienda) y la justificación, y los cargos de la CEA redactados con `visibleAcronym` y `redactAuthors`. Con unas decenas de páginas no depende de I18N-1.

### Prioridad 3

#### CLI-6. Las páginas en directo no detectan un stream SSE muerto en silencio

- **Esfuerzo**: S · **Verificación**: por confirmar
- **Dónde**: `app/composables/live/useAssemblyLive.ts:166-192`, `app/composables/live/useAssemblyLive.ts:218-225`, `server/api/assemblies/[assembly]/live.get.ts:24-37`
- **Qué pasa**: el latido del servidor es un comentario SSE, que EventSource no entrega a JavaScript. El cliente solo reacciona a `error` y a `online`, sin temporizador de inactividad ni `visibilitychange`, y /directo muestra «En directo» mientras `connected` sea true.
- **Cuándo pasa**: un delegado bloquea el móvil unos minutos o cambia de punto de acceso y el navegador conserva un socket medio muerto, sobre todo en iOS Safari (Chrome suele cerrarlo en uno o dos minutos). No está demostrado que ocurra.
- **Impacto**: sigue un estado desfasado sin saberlo; raro, pero difícil de notar.
- **Propuesta**: enviar siempre el evento con nombre `ping` (ya existe como alternativa en `writeComment`). En el cliente, si pasan unos 60 s sin mensajes o la pestaña vuelve a verse tras un rato oculta, poner `missedChanges = true` y reabrir el stream; sin esa marca, `ready` no vuelve a pedir los datos (líneas 169-173).

#### CLI-7. Los filtros de la lista de documentos se pierden al volver atrás

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/pages/asambleas/[assembly]/documentos/index.vue:58-62`, `app/pages/asambleas/index.vue:26-77`
- **Qué pasa**: búsqueda, estado, tipo, «Solo los míos» y «Solo lo que me queda» son refs locales que no pasan a la URL. La lista de asambleas ya guarda sus filtros en la query.
- **Cuándo pasa**: un delegado busca su sigla o filtra por tipo, abre un documento y vuelve con «Atrás»: la lista sale entera. La barra de lectura cubre en parte el caso de lo pendiente.
- **Impacto**: una molestia repetida al repasar 20-30 documentos.
- **Propuesta**: copiar el patrón de `asambleas/index.vue` (computed con get/set sobre `route.query` y `router.replace`) para los cinco filtros, validando estado y tipo contra `PROGRESS_LABEL_ORDER` y `DOCUMENT_KINDS`.

#### I18N-8. Los encabezados de nivel 1 y 3 pueden quedarse solos al pie de página

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `server/utils/export/content.ts:404-419`, `server/utils/export/pdfBuilder.ts:813-815`
- **Qué pasa**: la barra y la caja granate son tablas de una celda. `pageBreakBefore` solo salta si no hay nodos siguientes en la página, pero `getFollowingNodesOnPage` incluye la propia celda, así que nunca salta. Reproducido con Raleway; los niveles 2 y 4, de texto, sí funcionan.
- **Cuándo pasa**: en posicionamientos de 20-35 páginas con varios apartados de nivel 1 o 3, alguno caerá al final de una página.
- **Impacto**: la barra granate queda sola abajo y su texto empieza en la página siguiente.
- **Propuesta**: en el predicado, descartar los nodos siguientes con `style` `barHeading` o `boxHeading`, o exigir `length <= (node.table ? 1 : 0)`, y añadir un test de render en `export.test.ts`.

#### I18N-9. El PDF anotado no dice de cuándo es

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `server/utils/export/pdfBuilder.ts:742-825`, `server/api/assemblies/[assembly]/documents/[document]/export.post.ts:44-48`, `server/utils/export/storage.ts:127-137`
- **Qué pasa**: `buildDocumentPdf` nunca imprime `generatedAt`, y todas las descargas del anotado se llaman igual («…-anotado.pdf»), aunque retratan un conjunto de enmiendas que sigue cambiando.
- **Cuándo pasa**: una delegación estudia o imprime un anotado descargado días antes mientras se siguen publicando enmiendas, también fuera de plazo hasta la última mañana.
- **Impacto**: trabaja sobre una foto desfasada sin saberlo.
- **Propuesta**: una línea discreta «Estado a {fecha hora}» (`formatExportDateTime`) en el bloque de leyenda del anotado, que no forma parte de la plantilla. Poner la hora en el nombre del fichero es secundario. El limpio no cambia.

#### I18N-10. Plurales sin forma singular en la proyección y en la cola de la Mesa

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `i18n/locales/es.json:3841`, `i18n/locales/es.json:3275`, `i18n/locales/en.json:3841`, `i18n/locales/en.json:3275`, `app/pages/proyeccion/[assembly].vue:685-692`, `app/components/session/AmendmentQueue.vue:173-178`
- **Qué pasa**: `projection.amendmentStats` y `session.queue.counts` no tienen forma singular, aunque el proyecto ya usa « | » en 181 cadenas.
- **Cuándo pasa**: con la primera enmienda aprobada de cada documento, la pantalla de la sala dice «1 enmiendas aprobadas» y la consola, «1 enmiendas» y «1 aprobadas».
- **Impacto**: pequeño, pero lo lee toda la asamblea en la pantalla grande.
- **Propuesta**: separar en piezas con plural (`{count} enmienda aprobada | {count} enmiendas aprobadas`) unidas con « · », en es y en. El idioma de la proyección no es un problema real; si se quisiera fijar, basta con enlazarla sin `localePath` en `ConsoleToolbar.vue:19`.

#### I18N-11. Dos «Descargar PDF» iguales en el texto consolidado

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `app/pages/asambleas/[assembly]/documentos/[document]/consolidado.vue:183-192`, `app/components/export/ExportButton.vue:220-230`
- **Qué pasa**: al terminar, los dos `ExportButton` (limpio y anotado) pasan a un enlace «Descargar PDF» sin indicar la variante; el botón «Generar de nuevo» y el aviso «PDF listo» también se repiten iguales.
- **Cuándo pasa**: la Secretaría pide los dos PDF del consolidado. Con un lector de pantalla quedan dos enlaces idénticos (WCAG 2.4.4).
- **Impacto**: hay que adivinar cuál es cuál o descargar los dos.
- **Propuesta**: elegir en `ExportButton` según `variant`, como ya hace `idleLabel`, las claves de descarga, de repetir y del aviso («Descargar PDF limpio» / «Descargar PDF anotado»), en es y en. Con I18N-4 aplicado, solo ocurre tras la votación final.

#### I18N-12. El dossier de la asamblea no tiene botón desde la reconstrucción, pero su código sigue vivo

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `server/api/assemblies/[assembly]/export.post.ts`, `server/utils/export/pdfBuilder.ts:859`, `server/utils/export/pdfBuilder.ts:942-949`, `app/components/export/ExportButton.vue:67-74`, `i18n/locales/es.json:2187-2203`
- **Qué pasa**: desde 2b90167 ninguna página usa `ExportButton` sin documento, pero el endpoint, `buildAssemblyPdf`, `buildAssemblyExportData`, sus tests y `docs/api.md` siguen ahí. Sus etiquetas `export.pdf.documentKinds`, que solo se usan en el dossier, llaman «Acuerdo» al convenio y «Sede» a la candidatura a sede; los PDF subidos solo se mencionan.
- **Cuándo pasa**: una delegación quiere un único PDF con el orden del día y los textos para leer sin red y tiene que bajar 20-30 PDF uno a uno.
- **Impacto**: funcionalidad mantenida que nadie puede usar.
- **Propuesta**: decisión del propietario. O recuperarlo en el «Más» del orden del día después de I18N-1 (cientos de páginas bloquearían la sala), con las etiquetas de `document.kinds` y, si se quieren los PDF subidos, añadiendo `pdf-lib`. O eliminar el endpoint, los constructores, las claves y los tests.

#### I18N-13. La exportación de un documento carga y enmascara datos que el PDF ya no imprime

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `server/utils/export/buildData.ts:171-210`, `server/utils/export/buildData.ts:384-443`, `server/utils/export/buildData.ts:469`, `server/utils/export/pdfBuilder.ts:97-102`
- **Qué pasa**: desde 2c29e2b (la plantilla con el título solo sobre el texto), `proponent`, `agendaNumbering` y `agendaTitle` no se leen, pero `buildData.ts` los sigue calculando con su propio enmascarado de los cargos de la CEA y de los títulos retenidos.
- **Cuándo pasa**: en cada exportación; el riesgo es que alguien vuelva a imprimirlos confiando en un código sin tests de salida.
- **Impacto**: una segunda vía de enmascarado de la CEA que hay que mantener sin ningún efecto.
- **Propuesta**: quitarlos, porque volver a imprimirlos rompe la plantilla de AGENTS.md. En el documento: el join de `proponent`, `loadAgenda`, `loadPublicDocuments`, `loadCoProponents`, el bloque `unlisted`/`buildAgendaTree`, `agendaTitles` y el `findFirst` de la línea 421. En la asamblea, conservar el árbol del orden del día y quitar `agendaTitles`, `coProponents` y el join de `proponent`. Borrar `visibleCoAcronyms`, `presentersLabel` y su test (`export.test.ts:431-441`). Si se elimina el dossier (I18N-12), sale casi todo junto.

## Mantenibilidad, pruebas y documentación

Esta área cubre la red de seguridad del código (tests, tipos, lint y la barrera antes de desplegar), las reglas que viven en más de un sitio y la documentación que leen cada curso la persona de TIC y los agentes. La suite de tests es amplia y buena, pero nada obliga a ejecutarla antes de desplegar, la parte más usada en sala no tiene ningún test con base de datos y varios documentos de referencia describen reglas ya retiradas.

### Prioridad 1: antes de la próxima asamblea

#### MAN-1. Se puede desplegar a producción sin pasar typecheck ni tests

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `deploy.sh:292-298`, `deploy.sh:321-323`, `DEPLOYMENT.md:208`, `README.md:117-125`, `package.json`, `Dockerfile:29`, `.dockerignore`
- **Qué pasa**: deploy.sh etiqueta un árbol con cambios sin confirmar como `-dirty-<fecha>`, avisa y despliega. No ejecuta lint, typecheck ni tests (DEPLOYMENT.md:208 lo reconoce), no hay `.github/` ni hooks, y como `nuxt.config.ts` no activa `typeCheck`, el `pnpm run build` del Dockerfile tampoco compila tipos. La lista «Verificación antes de PR» del README omite `pnpm test` y `pnpm format:check`. Reglas como «toda mutación registra un evento», que alimenta el directo, solo las vigila `traceability.test.ts`. Además, `.dockerignore` no excluye `.sim77/` ni `public/_*`.
- **Cuándo pasa**: un arreglo urgente la noche entre dos jornadas de una AGO, con cambios a medias de otra sesión en el mismo árbol o con un test de `executiveMembers.test.ts` roto.
- **Impacto**: a la mañana siguiente llega a la sala una regresión que la suite detectaba, como un cargo de la CEA visible o un evento que no llega al directo.
- **Propuesta**: script `verify` en package.json (lint, format:check, typecheck, i18n:check, i18n:audit-identical, test) que deploy.sh ejecute antes de `build_and_push_image`, salvo con `DEPLOY_SKIP_VERIFY=1` explícito (no con `DEPLOY_SKIP_BUILD=1`). El modo sucio es deliberado para que el rollback tenga etiqueta única: exigir `--allow-dirty` en vez de prohibirlo. El README remite a la lista de AGENTS. Añadir `.sim77/` y `public/_*` a `.dockerignore`. Una CI en GitHub sería solo una señal secundaria, porque deploy.sh construye desde el árbol local.

### Prioridad 2

#### MAN-2. No se aplica el plazo propio de las enmiendas a la totalidad en una reforma (RRI 2025 art. 65.4)

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `shared/utils/calendar.ts:26-53`, `shared/utils/calendar.ts:324-329`, `server/utils/domain/amendments.ts:2394`, `server/utils/domain/reviewState.ts:286-291`, `shared/constants/calendarRules.ts`, `docs/proceso-asambleas.md:96`
- **Qué pasa**: `isLateSubmission` compara solo con `window.closesAt`, sea cual sea el tipo de enmienda, y CalendarRules no tiene un cierre propio para la totalidad (8 días antes). proceso-asambleas.md:96 lo da como pendiente. Una enmienda validada en plazo queda admitida (`admissionOnValidation`).
- **Cuándo pasa**: en una AGE de reforma de los Estatutos, un consejo presenta una enmienda de devolución 6 días antes.
- **Impacto**: se admite fuera de plazo sin que la Asamblea decida su admisión, algo recurrible ante el Comité de Garantías. La salida manual (declararla inadmisible o votar su admisión) depende de que alguien recuerde la regla.
- **Propuesta**: añadir a CalendarRules un desfase de cierre para la totalidad en reformas, como dato editable en /admin/calendario y sembrado en `INITIAL_CALENDAR_RULES` con su artículo. Aplicarlo en isLateSubmission solo a `totality_return` y `totality_alternative` sobre `REGULATION_DOCUMENT_KINDS`; adelantar el cierre de toda la ventana recortaría el plazo de las parciales. Mostrarlo en la línea de plazo de DocumentHeader, no en un recuadro, y quitar el «pendiente» de proceso-asambleas.md.

#### MAN-3. Ningún test ejecuta el SQL de los flujos de enmiendas en sesión

- **Esfuerzo**: L (la guarda estática sola, S) · **Verificación**: confirmado
- **Dónde**: `server/utils/domain/amendments.ts:2449`, `server/utils/domain/amendments.ts:2525`, `server/utils/domain/amendments.ts:3528-3539`, `server/utils/domain/amendments.ts:3792-3803`, `server/utils/domain/amendments.ts:4272`, `server/utils/domain/amendments.test.ts:9-11`, `server/utils/domain/acceptedRule.ts:161-208`, `server/utils/domain/transactionalClosure.ts:148`, `server/utils/domain/activity.db.test.ts`
- **Qué pasa**: amendments.test.ts mockea `../../db` y prueba solo helpers puros. Los planificadores puros (transactionalsToClose, competingTransactionalIds, admissionEligible, transactionalReopenBlocker) sí tienen tests; el cableado SQL y los bloqueos, no. Las invariantes de AGENTS (bloquear las competidoras al llamar a replaceSources, cerrar las transaccionales pendientes al resolver una original) se cumplen a mano en once llamadas. El único test con base de datos es opcional y solo lee.
- **Cuándo pasa**: alguien añade una vía nueva para cerrar enmiendas y olvida el cierre, y se nota en un debate con 10 transaccionales en 3,5 horas.
- **Impacto**: una transaccional que debía cerrarse sigue abierta, o la consola de la Mesa recibe un 409 o un 500 ante la sala.
- **Propuesta**: primero, una guarda estática al estilo de `traceability.test.ts`: toda función exportada que escriba un estado terminal en `amendments.status` llama a closeDependents, closeTransactionalsOver o replaceSources, con excepciones comentadas. Después, un `globalSetup` de vitest con `TEST_DATABASE_URL` que cree una base efímera, aplique `drizzle/*.sql` y siembre una asamblea `in_session`, empezando por la sustitución (fuentes `transacted`, rival `lapsed`) y el cierre (`by: "sources_closed"`).

#### MAN-4. El cliente rehace a mano reglas de estado del servidor

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `app/composables/session/sessionModel.ts:77-104`, `app/composables/session/sessionModel.ts:449-458`, `server/utils/domain/amendments.ts:2542-2550`, `server/utils/domain/amendments.ts:3897-3902`, `server/utils/domain/amendments.ts:3986-3995`, `app/components/document/ManageActions.vue:87-121`, `server/utils/domain/documents.ts:1268-1334`, `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:224-238`, `app/pages/asambleas/[assembly]/documentos/[document]/revisar.vue:178-192`, `app/pages/asambleas/[assembly]/documentos/[document]/editar.vue:550-555`, `app/composables/document/useAddDocument.ts:45-52`, `shared/types/api.ts:861-874`
- **Qué pasa**: `SESSION_REOPENABLE` copia la lista `reopenable`, `isSessionAdmissionEligible` copia `admissionEligible`, ManageActions rehace `assertStatusChange`, y quién propone una transaccional está escrito tres veces (`canTransact`, `canProposeTransactional` en revisar.vue y en el servidor). editar.vue copia la exención de plazo (`deadlineExempt`). Ningún test comprueba que coincidan, y la deriva ya ocurrió: el commit 9e99ab4 corrigió que el cliente ocultara «Añadir documento» a gestores que el servidor eximía.
- **Cuándo pasa**: se cambia una regla en el servidor (reabrir una inadmisible, aplazar un documento enviado) y la consola de la Mesa o el menú «Más» siguen con la antigua.
- **Impacto**: en plena sesión falta un botón que el servidor admite, o aparece uno que da 409 ante el proyector.
- **Propuesta**: llevar los predicados puros a shared/utils, como ya hacen `amendmentReclassify.ts`, `amendmentAuthors.ts` y `presenterKinds.ts`: admissionEligible, la lista de reabribles y los cambios que permite assertStatusChange. Lo que depende del actor, como flags del servidor: `can.transact` en DocumentCapabilities, `reopen` y `admit` en AmendmentCapabilities, y uno que diga si el actor puede añadir documentos con la exención de gestores ya aplicada.

#### DOCS-1. docs/intranet.md describe una integración con la Intranet que ya no existe

- **Esfuerzo**: M · **Verificación**: confirmado
- **Dónde**: `docs/intranet.md:10-13`, `docs/intranet.md:90-140`, `docs/intranet.md:217-226`, `docs/intranet.md:402-544`, `docs/intranet.md:1279`, `docs/intranet.md:1500-1503`, `server/utils/auth/roleSync.ts:96-103`, `server/utils/auth/roleSync.ts:141`, `server/utils/members/link.ts:20-35`, `server/utils/members/roster.ts:24-71`, `server/utils/members/intranet.ts:11-32`
- **Qué pasa**: §1 dice que hay tres listados, que todo tipo desconocido da «Invitado» (también §7, :1279) y que los cargos de la CEA se enlazan solo por siglas; §9 lo deja «Pendiente» y habla de «áreas ejecutivas». El código pide cuatro listados (`cea` y `cas` incluidos), da «Otro» y enlaza CEA y CAS por id, email y siglas. El contrato de §4.3 no define `/usuarios/cea` ni `/usuarios/cas`, omite `CAS` en los valores de `role` (:465), dice que `id` solo enlaza Asociado y Sectorial (:464), y §4.4 (:544) prohíbe los emails con los que roster.ts empareja. intranet.ts:11-16 remite a esa §4.3.
- **Cuándo pasa**: la Secretaría pregunta a la persona de TIC del curso por qué una cuenta no sale como invitada en el recuento; README, DEPLOYMENT y api.md la mandan a esta sección.
- **Impacto**: respuestas equivocadas sobre recuentos y enlaces, y un contrato inútil para cambiar la Intranet.
- **Propuesta**: reescribir §1 remitiendo a `docs/design.md:36-80`, con «Otro» donde dice «Invitado»; quitar el pendiente de §9 y hablar de cargos en §10.1 (la tabla `executive_areas` de la Intranet puede conservar su nombre). Completar §4.3 con los dos listados, el campo `email`, `CAS` y la fila `id`, y dejar en §4.4 la decisión real: el email viaja para emparejar cuentas recreadas y `members.email` nunca llega a clientes, auditoría ni logs.

### Prioridad 3

#### MAN-5. El denominador por defecto de las votaciones («present») no tiene tests

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `shared/utils/votes.ts:56-58`, `shared/utils/votes.test.ts:76-79`, `shared/constants/domain.ts:394`, `server/utils/domain/headcounts.ts:565-578`, `app/components/live-view/-attendance.test.ts:73-78`
- **Qué pasa**: `DEFAULT_ASSEMBLY_SETTINGS` usa `denominator: "present"`, pero los tests de computeVoteOutcome y evaluateVoteInput usan `valid_votes`. El redondeo de `majorityThreshold` sobre presentes sí está cubierto (-attendance.test.ts); el resultado completo, el paso a votos válidos cuando falta `present` y `withHeadcount`, que rellena `present` con el último recuento, no.
- **Cuándo pasa**: alguien toca computeVoteOutcome o withHeadcount antes de una AGE de reforma y la suite sigue en verde.
- **Impacto**: puede cambiar si un texto queda aprobado, en la ruta que usa cada asamblea por defecto.
- **Propuesta**: 3 o 4 tests con `DEFAULT_ASSEMBLY_SETTINGS` tal cual: 30 presentes y dos tercios (19 rechaza, 20 aprueba), absoluta con abstenciones que cuentan en contra, y `present: null` fijado como paso deliberado a votos válidos (VoteFields.vue ya avisa con `session.vote.noHeadcount`). Extraer y testear la parte pura de withHeadcount (`fillPresent`). Unificar las tres conversiones VoteInput→VoteCounts es limpieza opcional.

#### MAN-6. Inicio cuenta «Fuera de plazo» un documento que el seguimiento pone en «Corrección»

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `server/utils/domain/review.ts:403-409`, `app/components/tracking/-status.ts:51-57`, `app/components/home/ReviewCard.vue:84`, `server/utils/domain/documents.ts:2021-2026`, `server/utils/domain/reviewState.ts:168-180`, `server/utils/domain/reviewState.ts:622-623`, `server/utils/domain/reviewState.ts:716-725`
- **Qué pasa**: requestDocumentCorrection devuelve el documento a `draft` y conserva `dueAt`. El SQL de Inicio (`status = draft AND dueAt < now`) lo cuenta vencido, mientras trackingBucket le da su propio recuadro «Corrección». `isDocumentOverdue` (que tampoco excluye la corrección) y `replacesSources` solo se usan en tests. El resto del SQL de Inicio coincide hoy con los predicados TS que cita.
- **Cuándo pasa**: la Secretaría devuelve para corregir un documento esperado cuyo plazo interno ya pasó.
- **Impacto**: Inicio muestra en rojo «Fuera de plazo: 1» y el recuadro al que enlaza sale a 0, lo que resta confianza en el recuento de tareas.
- **Propuesta**: excluir de los vencidos lo que excluye draftState (`isNull(correctionNote)` e `isNull(correctionRequestedAt)`), aplicar la misma regla a isDocumentOverdue o borrarlo, y borrar replacesSources. No usarlo en transactionalReopenBlocker: sobre transaccionales ya decididas siempre daría false y bloquearía su reapertura.

#### MAN-7. Los tipos de evento son `string`: un evento nuevo sin catalogar compila

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `server/utils/domain/events.ts:29`, `server/utils/domain/events.ts:48-60`, `shared/types/api.ts:1376-1381`, `app/components/review/-live.ts:24`, `app/composables/assembly/-liveFilters.ts:17`, `server/utils/domain/speakersRules.ts:245`, `shared/constants/permissions.ts:63-82`, `drizzle/seed.ts:170-172`
- **Qué pasa**: `LiveMessage.type` y recordEvent aceptan cualquier `string` aunque exista `EventType`; también LiveEventDto, REVIEW_LIVE_TYPES, IGNORED_LIVE_TYPES y turnEventType. `DEFAULT_ROLE_PERMISSIONS` es `Record<string, ...>` y el seed se salta en silencio un rol que no existe. Hoy no hay discrepancias.
- **Cuándo pasa**: se añade un tipo de evento (17 de 162 commits tocan el catálogo) sin declararlo en `EVENT_TYPES`.
- **Impacto**: el evento sale como «other» en la actividad y su payload se vacía para quien no es Admin; un rol mal escrito queda sin permisos tras `pnpm db:seed`.
- **Propuesta**: tipar `type: EventType` en LiveMessage y recordEvent (`entityType` ya es EntityType), `LiveEventDto.type: EventType | "poll"` y su `entityType`, las listas como `ReadonlySet<EventType | "poll">` y turnEventType. Así `EVENT_PAYLOAD_KEYS`, ya `Record<EventType, ...>`, obliga a declarar las claves. `DEFAULT_ROLE_PERMISSIONS` como `Record<Exclude<SystemRoleName, "Admin">, PermissionKey[]>`, y que el seed avise.

#### MAN-8. La comprobación entre bodies y esquemas Zod no detecta un campo olvidado

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `shared/utils/schemas/document.ts:176`, `shared/utils/schemas/amendment.ts:234`, `shared/utils/schemas/assembly.ts:210-211`, `shared/utils/schemas/bodies.test.ts:9-13`
- **Qué pasa**: `type Assignable<T, U extends T> = U`, repetido en ocho ficheros de schemas, solo exige que el esquema sea asignable a la interfaz. Un campo opcional añadido a la interfaz y olvidado en el esquema compila, y `z.object` lo descarta sin error. bodies.test.ts lo parchea con tests de parse para unos pocos campos.
- **Cuándo pasa**: se añade una opción a DocumentUpdateBody y al formulario, pero no a documentUpdateSchema.
- **Impacto**: la Secretaría lee «Guardado» y el dato no se guarda; ni typecheck ni los tests lo ven.
- **Propuesta**: comprobar solo el sentido que pierde datos: `Exclude<keyof T, keyof z.output<S>>` debe ser `never` para cada par. No exigir igualdad de claves: assembly.ts:210-211 compara la misma AgendaItemBody con el esquema de creación y el de actualización, y `keyof` de una unión solo da las claves comunes.

#### MAN-9. ESLint no vigila las reglas de AGENTS.md: un import relativo de shared/ solo falla al construir

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `eslint.config.mjs:1-5`, `app/middleware/auth.global.ts:20`
- **Qué pasa**: la configuración es solo `withNuxt` con Prettier. Un import `../../shared/...` desde app/ pasa lint, typecheck y vitest, y rompe `pnpm build` en Nitro; ya pasó (commit c0c2b3a). Tampoco hay regla contra un `$fetch` crudo en mutaciones.
- **Cuándo pasa**: en un cambio rutinario sin `pnpm build`; el error salta en deploy.sh al desplegar un arreglo entre jornadas.
- **Impacto**: un despliegue urgente bloqueado; producción no se ve afectada.
- **Propuesta**: para `files: ["app/**"]`, `no-restricted-imports` con `patterns: [{ regex: "^\\.{1,2}/(.*/)?shared/", message: "Usa ~~/shared/..." }]` (un glob `**/shared/*` prohibiría también el alias correcto) y `no-restricted-syntax` con `CallExpression[callee.name='$fetch'] > ObjectExpression > Property[key.name='method']`, que deja pasar el GET de auth.global.ts.

#### MAN-10. Dependencias y código muertos, uno de ellos recomendado por AGENTS.md

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `package.json`, `server/utils/crud.ts:7`, `AGENTS.md:385`, `app/composables/security/usePermissions.ts:20-27`, `app/composables/amendment/workspace.ts:505-522`, `app/composables/session/useSessionPosition.ts:77`, `shared/utils/config.ts:24`, `shared/utils/config.ts:46`, `shared/utils/config.ts:67`
- **Qué pasa**: sortablejs, @types/sortablejs y @fontsource/raleway no se importan. runCrudTransaction no tiene usos y AGENTS lo recomienda. isSecretaria, isAsociado, isReadOnly e isModerador no los usa nadie. amendmentAcceptBlocked nunca tiene efecto: publicada la enmienda da false, y sin publicar el menú ya sale deshabilitado por waitsPublication. Tres helpers de config sin uso.
- **Cuándo pasa**: un agente copia los helpers por nombre de rol para decidir qué muestra una pantalla.
- **Impacto**: superficie que confunde, más avisos de seguridad y actualizaciones sin valor.
- **Propuesta**: quitar las tres dependencias, crud.ts y su mención en AGENTS; reducir usePermissions a lo que usan sus dos consumidores; borrar amendmentAcceptBlocked con el campo `acceptBlocked` de SessionPositionMenu y su rama en useSessionPosition.ts; borrar los helpers de config.

#### MAN-11. Ficheros gigantes que esconden reglas

- **Esfuerzo**: M · **Verificación**: por confirmar
- **Dónde**: `server/utils/domain/amendments.ts` (4700 líneas), `server/utils/domain/documents.ts` (3210), `server/utils/domain/activity.ts` (2685), `app/pages/asambleas/[assembly]/documentos/[document]/index.vue:1-1259`
- **Qué pasa**: amendments.ts reúne borradores, revisión, admisión, posición, resultado, transaccionales y relaciones. El script de la página del documento tiene 59 computed y 33 funciones que vitest, en entorno node, no puede probar. Hoy no hay ninguna regresión atribuible.
- **Cuándo pasa**: tocar las transaccionales obliga a leer miles de líneas para encontrar las once llamadas a replaceSources y closeDependents.
- **Impacto**: encarece cada cambio de reglamento y facilita las copias divergentes (MAN-4) y las invariantes olvidadas (MAN-3).
- **Propuesta**: partir flujo a flujo, no de una vez (hay worktrees paralelos sobre el mismo árbol), como ya se hizo con transactionalClosure.ts, presenters.ts y acceptedRule.ts. Empezar por un `transactionals.ts` con createTransactionalAmendment, recordAmendmentAcceptance, replaceSources y closeDependents, reexportado desde amendments.ts. En la página, sacar los computed de permisos y visibilidad a un `-documentPage.ts` puro y testeable.

#### DOCS-2. README y .env.example describen un producto y un arranque anteriores

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `README.md:12`, `README.md:15`, `README.md:39`, `README.md:57`, `README.md:79`, `README.md:115`, `.env.example:2`, `.env.example:16`, `.claude/launch.json:7-8`, `package.json:87`
- **Qué pasa**: el README habla de estados `provisional` y `definitive` (son draft, convened, in_session y closed) y de enmiendas como «patches diff-match-patch» (son operaciones ancladas a la base), enlaza un PLAN.md inexistente, pide pnpm 10.33+ (se fija pnpm@12.10.1) y no enlaza design.md, api.md ni proceso-asambleas.md. En :79 dice que sin Intranet todos entran como «Invitado» (es «Otro»). .env.example trae la URL de la Intranet de producción con el token vacío: cada inicio de sesión recibe 401 y «Sincronizar» da 502. launch.json arranca en 3001 y el resto dice 3000.
- **Cuándo pasa**: en cada relevo de TIC, o cuando un agente combina el .env de ejemplo con el preview y Google responde INVALID_ORIGIN.
- **Impacto**: el modelo se entiende mal desde la primera página y se pierden horas con un fallo de configuración que parece de roles.
- **Propuesta**: corregir :12, :15, :39 (la versión de `packageManager`, con corepack) y :79; quitar PLAN.md o apuntarlo a docs/plan-simplificacion.md y enlazar los tres documentos de docs/. En .env.example, comentar la URL junto al token avisando del 401. Alinear el puerto de launch.json o avisar de él.

#### DOCS-3. design.md contradice a AGENTS y al código sobre transaccionales, motor y publicación

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `docs/design.md:178`, `docs/design.md:216`, `docs/design.md:412-418`, `docs/design.md:422-436`, `docs/design.md:535-537`, `docs/design.md:902-903`, `shared/constants/domain.ts:318`
- **Qué pasa**: :412-418 dice que las partes de una transaccional incluyen al proponente del documento y que sustituye a sus originales al aprobarse; AGENTS, api.md:1171-1174 y design.md:713-736 dicen autores principales y sustitución al quedar validada y aceptada. §Engine cita `shared/utils/amendments/`, `diffBlocks` y `renderDiff` (hoy shared/utils/content/, diffPassage y renderAnnotated). :178 y :216 sitúan la referencia y la base al admitir y al abrir la ventana (es al publicar); :535-537 trata las aceptadas como política por asamblea (es `documents.acceptedAmendments`); :902-903 da el import DOCX como excepción de trazabilidad (es solo presence.post.ts).
- **Cuándo pasa**: un agente lee el modelo de datos para tocar las transaccionales o el motor.
- **Impacto**: riesgo de reintroducir la fila `proponent` o de escribir un diff propio, mitigado porque AGENTS enuncia la regla correcta.
- **Propuesta**: reescribir esos pasajes según AGENTS y design.md:713-736, incluidas las líneas 417-418 sobre el linaje.

#### DOCS-4. plan-simplificacion.md dice «Nada de esto está implementado» y conserva decisiones revertidas

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `docs/plan-simplificacion.md:3`, `docs/plan-simplificacion.md:16-25`, `docs/plan-simplificacion.md:118`, `docs/plan-simplificacion.md:189`, `docs/plan-simplificacion.md:212-213`, `docs/plan-simplificacion.md:281-287`
- **Qué pasa**: casi todo el plan está hecho (migas, página de punto, tipos como tarjetas, enmiendas una a una). Siguen escritas decisiones cambiadas: la bienvenida guardada en la cuenta (AGENTS: es del navegador), «Ayuda» en el menú lateral (está en el de usuario), «Proponer una transaccional» como botón visible (sigue en «Más» a propósito) y cargos de la CEA que solo existen al iniciar sesión (hoy se sincronizan desde /usuarios/cea). La tabla de §10 no tiene Otro, CAS, CAI ni CdG.
- **Cuándo pasa**: a un agente se le pide «termina lo que falta del plan».
- **Impacto**: guardaría la bienvenida en una cuenta que comparten varias personas o sacaría una acción de «Más», contra los criterios del propietario.
- **Propuesta**: corregir la cabecera, marcar el estado de cada fase en la tabla de :281-287 y anotar las decisiones revertidas con referencia a AGENTS. No moverlo a un histórico: se editó en los mismos commits que lo implementan.

#### DOCS-5. «Secretaria» sin tilde como nombre de rol en la documentación

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `AGENTS.md:134`, `AGENTS.md:136`, `AGENTS.md:146`, `AGENTS.md:159`, `AGENTS.md:166`, `AGENTS.md:167`, `docs/intranet.md:122`, `docs/intranet.md:136`, `docs/intranet.md:480`, `docs/intranet.md:1572`, `DEPLOYMENT.md:313`, `shared/constants/roles.ts:3`
- **Qué pasa**: el rol se llama «Secretaría» (`SYSTEM_ROLES.SECRETARIA`), pero la documentación escribe `Secretaria` como identificador.
- **Cuándo pasa**: una carga o consulta puntual en producción por SQL copia el nombre, y `WHERE name = 'Secretaria'` no encuentra ninguna cuenta.
- **Impacto**: un script que no hace nada y no da error.
- **Propuesta**: escribir `Secretaría` o `SYSTEM_ROLES.SECRETARIA` en esos sitios. Los tests que usan el nombre sin tilde no lo comparan; cambiarlos es opcional.

#### DOCS-6. DEPLOYMENT.md omite la limpieza diaria de imágenes y exagera sobre SEED_DEMO

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `DEPLOYMENT.md:28`, `DEPLOYMENT.md:198`, `DEPLOYMENT.md:271-300`, `server/utils/domain/imageCleanup.ts:23-24`, `server/plugins/image-cleanup.ts`, `drizzle/seed.ts:2047`
- **Qué pasa**: la cola `document-images-cleanup` borra cada día a las 04:45 las imágenes sin usar con más de 14 días, y ni DEPLOYMENT ni el mapa de AGENTS la mencionan. :198 dice que el seed «Nunca carga datos de demo», pero lo hace si `SEED_DEMO=1` está en el env_file.
- **Cuándo pasa**: quien opera el VPS ve trabajos o eventos `document_images.cleanup` que no conoce, o echa en falta imágenes tras restaurar.
- **Impacto**: diagnóstico más lento; poco frecuente.
- **Propuesta**: añadir la cola a :28 y a la sección de trabajos, con su consulta en `pgboss.job` y la acción de Actividad, y al mapa de AGENTS (reutiliza la instancia de exportaciones, así que el recuento de conexiones no cambia). Cambiar :198 por «salvo que SEED_DEMO=1 esté en el .env».

#### DOCS-7. api.md: enlace de cuentas a miembros incompleto y /api/calendar-rules fuera de la lista de suplantación

- **Esfuerzo**: S · **Verificación**: confirmado
- **Dónde**: `docs/api.md:341`, `docs/api.md:348-352`, `docs/api.md:1571`, `docs/api.md:1610-1616`, `server/utils/members/link.ts:29-35`, `server/utils/auth/roleSync.ts:110-118`, `server/handlers/protected.ts:44-52`
- **Qué pasa**: «Linking accounts to members» dice que los demás tipos no tocan `memberId` y omite que CAS se enlaza con el miembro CAS y que CAI y CdG son roles sincronizados a los que se borra el enlace. La lista de rutas de solo lectura y `x-acting-user` durante la suplantación omite /api/calendar-rules (sí descrita en :411-412). El dossier, la ruta de subidas de documentos y `/api/health` faltan en las tablas, y :1571 conserva un título obsoleto.
- **Cuándo pasa**: alguien consulta api.md para entender por qué una cuenta CAS tiene un miembro enlazado.
- **Impacto**: fricción pequeña; AGENTS tiene la tabla completa.
- **Propuesta**: completar «Linking accounts to members», añadir /api/calendar-rules en :1610 y :1614 y llevar las tres rutas a sus tablas.

## Descartado en la verificación

Estas propuestas las hicieron los buscadores y las refutó un revisor que volvió a leer el código: ya estaban resueltas, eran una decisión deliberada, eran erróneas o su impacto es despreciable.

### Accesibilidad: lectura de enmiendas

- **Lo añadido se marca con un subrayado que se confunde con el subrayado propio del texto**: el choque solo existe en modo marcas y con un texto original en negrita y subrayado junto al cambio; en modo color el tinte lo distingue y el lector de pantalla oye «Se añade:».
- **Con colores forzados desaparecen el punto de «sin leer», la tarjeta seleccionada y los resaltados**: depende del navegador, «Con cambios» es una insignia de texto y lo leído lleva un tic, WCAG 2.2 AA no exige colores forzados y es improbable que alguien use un tema de contraste.
- **Las flechas izquierda y derecha de la ficha impiden desplazar en horizontal las tablas anchas**: las flechas son una decisión documentada y solo afectan a quien usa solo el teclado en una tabla que desborda, que tiene el ratón y «Volver a la lista».
- **En el PDF anotado, lo quitado y lo añadido solo se distinguen por la decoración**: la plataforma ya da la lectura no visual con «Añadido» y «Eliminado» para lectores de pantalla, hay un PDF limpio al lado y el tachado y el subrayado no dependen solo del color.

### Accesibilidad: redacción de enmiendas

- **En el editor de enmiendas, Tab cambia el texto (sangra listas, añade filas a tablas) en lugar de salir**: en un párrafo normal Tab sale del editor, sangrar listas con Tab es lo que hacen Word y Google Docs, y el paso de revisión muestra cualquier cambio de formato antes de enviar.
- **Los botones de formato del editor no exponen su estado y la barra suma 17 paradas de Tab**: incumple 4.1.2, pero solo afecta a quien usa lector de pantalla y redacta enmiendas de formato, algo raro con estos usuarios.
- **Si «Enviar» falla después de guardar, el compositor solo lo dice en un toast de 5 s**: el compositor se queda abierto en la revisión, el borrador sale en la lista y la portada avisa, y exige que la segunda petición falle milisegundos después de que la primera salga bien.
- **Los errores de las acciones sobre enmiendas y el «Deshacer» de la Mesa solo viven 5 s en un toast**: la misma acción sigue disponible como «Reabrir» y, tras un error, la pantalla sigue mostrando que no se registró nada.
- **El texto de documentos y enmiendas, en castellano, no lleva lang="es"**: el defecto es real (WCAG 3.1.2), pero exige a la vez la interfaz en inglés y un lector de pantalla o lectura en voz alta, una combinación rara entre 50 y 150 cuentas.
- **Regiones vivas demasiado grandes en los formularios de la Mesa**: es cierto que el diff entero se relee a cada pausa, pero solo afecta a una persona de la Mesa que use lector de pantalla.

### Accesibilidad general

- **Con la barra lateral contraída, los enlaces de navegación se quedan sin nombre accesible**: es real, pero contraer la barra es una preferencia visual que quien usa lector de pantalla rara vez elige.
- **Con la interfaz en inglés, el contenido en español no lleva lang="es" y el lector lo pronuncia en inglés**: exige interfaz en inglés, lector de pantalla y contenido en español a la vez, algo casi inexistente entre representantes de universidades españolas.
- **La bienvenida se abre sola encima de «En directo» y de la consola la primera vez que se entra desde un dispositivo**: cuesta un toque en «Saltar» una vez por navegador, y que se abra sola es una decisión deliberada de AGENTS.md.

### Seguridad

- **Las sesiones sobreviven al relevo anual y nadie puede cerrarlas**: está confirmado en el código, pero el daño exige que la persona saliente use la app al menos una vez por semana y además actúe de mala fe.
- **El stream SSE reenvía a todos los espectadores los eventos de borradores y de enmiendas sin publicar**: que el stream lleve solo ids es una decisión documentada y solo deja ver cuántos borradores hay y cuándo se guardan, y eso solo en las herramientas del navegador.
- **Los PDF generados no se borran nunca**: el mismo contenido vive sin límite en la base de datos y sus copias, quien vuelve a descargar ya recibió ese fichero y una cuenta revocada no puede autenticarse.

### Enmiendas

- **Si se corta la Wi-Fi al presentar una transaccional, reintentar crea otra idéntica**: exige perder la respuesta en una ventana de milisegundos tras confirmar, y aun así la duplicada se ve al resincronizar, se puede retirar y decae sola cuando la otra sustituye a las fuentes.
- **Borrar un borrador devuelto para corrección libera su número y su código**: ese borrador nunca se publicó, así que nadie vio su número, y la numeración pública ya tiene huecos por diseño.
- **En una transaccional sobre otra, solo responde el autor principal de la primera**: es la regla deliberada de que solo responde el autor principal, coherente con el RFAG 2025 art. 21.2, y el caso consta una sola vez en todo el histórico.

### Documentos y orden del día

- **Un plazo fijado a las HH:MM cierra en el segundo 00 de ese minuto**: cliente y servidor coinciden en el corte y la interfaz ya muestra el plazo vencido a esa hora; si pasa, la enmienda solo queda fuera de plazo y la Mesa puede admitirla.

### Motor de contenido

- **Un cambio de formato del bloque choca con cualquier cambio de texto del mismo párrafo**: es una decisión documentada y fijada por test, y que una enmienda de formato de bloque coincida con otra de fondo sobre el mismo bloque es muy raro.
- **Dividir o unir párrafos se lee como borrar y reescribir el texto, y crea solapes falsos**: el choque al dividir no es falso porque el modelo no tiene «mover» ni «dividir», unir con una línea vacía conserva el id y partir un párrafo en una enmienda es poco frecuente.
- **La importación de Word pega los superíndices y subíndices al texto sin avisar**: las notas al pie y los ordinales ya se convierten bien, lo que queda es raro en estos textos y el modal muestra una vista previa completa antes de confirmar.
- **El texto consolidado con procedencia no deja rastro de lo suprimido**: las supresiones ya se ven en el modo «Comparar» y en el anexo de enmiendas aprobadas, y marcarlas en el texto limpio iría contra el primer plano tranquilo.

### Sesión en directo

- **Cada apertura de página y cada reconexión vuelve a descargarlo todo, y tras un corte de la wifi toda la sala reconecta a la vez**: la resincronización es deliberada, la reconexión ya lleva dispersión y espera exponencial, y el límite por IP está dimensionado para la IP compartida del recinto.
- **Faltan atajos para las dos acciones más repetidas de la Mesa, y el diálogo de votación no pone el foco en «A favor»**: las dos acciones ya son el botón principal de su panel, a un clic, y una tecla suelta que cambia lo que ve la sala es fácil de pulsar sin querer.
- **El buscador de turnos de palabra esconde a los consejos que llegan después del último recuento**: es una regla de AGENTS.md, y el consejo que llega tarde tiene que entrar en un recuento nuevo de todos modos para que las mayorías salgan bien.
- **PUT live-state no comprueba la versión**: es cierto, pero exige una consola sin flujo en directo mientras otro miembro de la Mesa mueve el debate, lo que es raro.
- **Si se cae la conexión LISTEN del servidor, los clientes siguen «conectados» y pierden eventos sin resincronizarse**: el mecanismo existe, pero un corte de PostgreSQL durante una sesión presencial es raro.
- **El cronómetro del turno de palabra usa el reloj del portátil y no el del servidor**: los dispositivos sincronizan por NTP con desfases de segundos, la plataforma no impone límite por turno y el cronómetro solo lo ve la Mesa.

### Rendimiento

- **La bandeja de la Secretaría se construye documento a documento y el hub la descarga entera solo para el número del distintivo**: los cargadores casi nunca lanzan consultas para lo pendiente, la consulta principal es una sola y compartir la clave es una decisión documentada que solo afecta a las pocas cuentas que validan.

### Experiencia de los miembros

- **Cualquier coautor puede retirar una enmienda conjunta para todos**: es una regla documentada, la confirmación dice «No se debatirá» y la Mesa puede reabrir la enmienda retirada.
- **Una vez enviado un documento o una enmienda, no hay forma de recuperarlo para corregir una errata**: con el plazo abierto se puede retirar y presentar otra en plazo, y recuperarlo conservando la primera hora permitiría reservar hueco con un texto provisional.
- **Una petición de corrección no dice hasta cuándo hay que corregir**: conservar la puntualidad original es una decisión documentada, las 72 h no son una norma y la Secretaría puede poner un plazo en la nota.

### Experiencia de Secretaría y Mesa

- **El selector de turnos de palabra oculta los consejos que no estaban en el último recuento**: es la regla de AGENTS.md, y añadir al consejo que llega tarde es una casilla en un recuento que hay que actualizar de todos modos.
- **La admisión de enmiendas tardías es por documento: un solo acuerdo de la asamblea se registra N veces**: es deliberado y encaja con la práctica de admitir las fuera de plazo al debatir cada documento, y el único precedente es una sola admisión.
- **Al cambiar la fecha de inicio, el calendario no ofrece desplazar los plazos**: ya hay aviso y enlace al calendario con la fecha por defecto en cada fila, son solo 8 hitos y desplazar solos unos plazos ya convocados sería un riesgo.
- **Los avisos de la sincronización de miembros solo salen en toasts de 5 s**: lo que los desencadena es raro en un padrón de unos 60 miembros que cambia poco, y una sincronización manual vuelve a mostrarlos.

### Fiabilidad y operación

- **El hub LISTEN reconecta sin avisar a los streams abiertos**: la ventana es estrecha (PostgreSQL caído en plena sesión y una mutación justo entre reintentos), y el siguiente evento sobre el mismo documento repara la proyección.
- **Si la Intranet falla en el primer inicio de sesión de una cuenta, queda como «Otro» toda la sesión**: solo afecta al primer acceso de una cuenta, es una decisión de AGENTS.md y se arregla volviendo a entrar o con la Secretaría asignando el rol.
- **Pocos datos para diagnosticar una sesión que falla**: los cortes del hub y las duraciones de exportación ya quedan en los logs, en pg-boss y en los metadatos, y lo que falta es comodidad, no capacidad de diagnóstico.

### Modelo de datos

- **Corregir un recuento no avisa de las votaciones que ya se contaron con él**: cada voto guarda su propio `present`, solo se corrige el último recuento y cambiar un resultado exigiría una coincidencia muy rara.
- **Un miembro sincronizado inactivo bloquea para siempre sus siglas**: exige que la Intranet dé al consejo un id y un correo nuevos a la vez, y no pasa en silencio porque la página de miembros avisa.
- **Las reglas del calendario guardadas se sustituyen en silencio por las iniciales si el JSON no pasa el esquema estricto**: haría falta un cambio futuro sin migrar los datos, el proyecto ya migra ese jsonb y el fallback es deliberado.
- **`late` se calcula al presentar y no se revisa si se amplía el plazo**: la CE prorroga antes del cierre, y para el caso retroactivo la bandeja ya admite en bloque antes de la sesión.
- **La votación nominal solo guarda totales**: los requisitos solo piden método y recuentos, el voto nominal es esporádico y la nota del voto permite anotar el sentido de cada consejo.
- **Defensa en profundidad: invariantes que hoy garantizan solo los bloqueos del código**: no hay un fallo real porque todas las escrituras toman el bloqueo, y es un seguro teórico contra regresiones futuras.

### Idiomas y PDF

- **Una celda de tabla más alta que una página se corta en silencio en el PDF**: en la carga real de la 80.ª AGO el bloque de celda más largo tiene 160 caracteres, lejos de los 1.300 a 1.800 que harían falta.
- **El contenido, siempre en español, no declara su idioma**: incumple WCAG 3.1.2, pero solo afecta a quien usa lector de pantalla con la interfaz en inglés, un grupo muy pequeño.
- **Erratas y términos mezclados en el inglés (PDF y avisos)**: son incoherencias reales pero cosméticas, y la errata de «a absolute majority» exige una combinación muy rara.
- **PDF anotado: en la capa de texto, lo suprimido y lo añadido se leen seguidos**: el PDF entero carece de etiquetas, la vista accesible ya existe en la plataforma y marcar cada cambio con corchetes recargaría la lectura de todos.
- **Las horas se muestran en hora peninsular sin indicarlo fuera del calendario y la convocatoria**: casi todos esos sitios solo muestran cuentas atrás, correctas en cualquier zona, y donde se planifica ya dice «hora peninsular».

### Corrección del cliente

- **Cambiar el número o el tipo de una asamblea cambia su slug y las pestañas abiertas caen en un 404**: esos datos se corrigen mientras es borrador, que solo ven los gestores, y cambiarlos tras convocar es excepcional.
- **El editor del borrador adopta la copia de otro copresentador sin volcar antes lo que se está tecleando**: la ventana es estrecha (la primera ráfaga de tecleo sin pausas de 200 ms), y el borrador se edita por turnos con aviso de presencia.

### Mantenibilidad

- **Una sección nueva de /api se queda sin CSRF, same-origin ni x-acting-user sin que ningún test lo detecte**: las ocho secciones actuales están cubiertas, la cookie SameSite=Lax hace que un POST de otro sitio llegue sin autenticar y una sección nueva de primer nivel es rara.
- **La regla de que una corrección del recuento nunca convierte un sectorial en voto no tiene test**: el código es correcto y está comentado, y para que importe tendrían que coincidir un cambio del miembro entre recuento y corrección y un refactor que rompa el bucle.
- **Enmascarado del cargo de la CEA reimplementado fuera de visibility.ts**: los turnos ya usan los helpers compartidos, la actividad usa `loadExecutiveMask` en producción y el ejemplo del CAS contradice AGENTS.md.

### Consola de la Mesa

- **La cola no dice qué sustituye a qué**: un solo estado por fila es una decisión escrita, y el panel de la enmienda en debate y la tarjeta desplegada ya dicen qué sustituye.
- **La lista de respuestas de una transaccional de un miembro promete que «sustituirá» a las originales antes de que Secretaría la valide**: la misma tarjeta explica encima que falta la validación de Secretaría y ningún diálogo promete la sustitución.
- **No se puede decidir si se trata una tardía hasta que Secretaría la valida**: el cliente es más estricto a propósito, la Secretaría valida con un clic desde la misma tarjeta y la tarjeta ya lo explica.

### Acceso y roles

- **El rol solo se lee de la Intranet al iniciar sesión, y una sesión usada a diario no caduca**: el rol se vuelve a leer de la base de datos en cada petición, así que basta un inicio de sesión del consejo en otro dispositivo, y el arreglo manual de la Secretaría se mantiene.
- **La bienvenida se marca como vista por navegador, no por audiencia**: es por navegador a propósito, el caso es poco frecuente y lo que se pierde son dos frases sobre botones que ya se ven, a un clic en «Ayuda».
- **En el recuento, los invitados que han entrado como «Otro» no aparecen**: es una decisión deliberada, los invitados nunca cuentan para el quórum ni para las votaciones y la Secretaría está al lado para asignar el rol.
- **Los mensajes mandan a «la Secretaría» sin decir cómo contactar con ella**: quien usa la plataforma ya tiene un canal con la Secretaría y esos mensajes solo salen en casos raros.
- **Las reglas de concesión de varios endpoints de administración no tienen test de endpoint**: la lógica está cubierta como funciones puras y el escenario no puede darse con los roles actuales.

### AGET y votaciones

- **En una AGET, los resultados del portal se calculan sobre los presentes de la sesión oral**: contar sobre los presentes es una decisión con base en el RRI art. 18.2, se puede cambiar en Ajustes y un recuento nuevo actualiza los diálogos siguientes.
- **No hay forma de pasar en bloque los resultados del portal, y la oferta de «decae» marca por defecto enmiendas con resultado propio**: Enter no marca nada como «decae» y los choques se avisan al aprobarse la segunda enmienda, así que solo queda ahorrar tiempo en una o dos AGET al año.
- **Una AGET se convoca por defecto con 7 días sin avisar de que hay que ratificarla**: toda AGE y AGET abre con la ratificación de la urgencia, y un aviso que saldría en todas sería ruido.
- **En una AGET, el recuento y En directo hablan de «la sala»**: «sala» se entiende bien como la de una videollamada, y la Mesa ya puede escribir su aviso en En directo.
- **En los turnos de palabra no aparece el consejo que se conecta después del último recuento**: el filtro es deliberado y se explica en pantalla, y el recuento nuevo hace falta de todos modos antes de la siguiente votación.
- **proceso-asambleas.md dice que la plataforma calcula los 2/3 sobre los votos válidos, pero por defecto lo hace sobre los presentes**: la contradicción entre documentos es real, pero quien configura una asamblea no lee docs/, y los Ajustes y cada votación dicen la base.

### Actividad y visibilidad

- **La Secretaría y la Mesa no tienen un registro de la asamblea**: el registro global solo para el Admin es deliberado, y la vista propuesta no resolvería el caso porque los eventos de recuento no guardan las delegaciones.
- **«Con cambios» no dice qué cambió, y el PDF anterior solo lo ve la Secretaría**: abrir el PDF anterior a los delegados contradice una decisión explícita de AGENTS.md, y sustituir un PDF ya publicado es poco frecuente.
- **El canal SSE emite a todo el mundo los eventos de borradores ajenos**: es una decisión documentada y solo deja ver la existencia y el ritmo de los eventos, sin contenido ni autores.

### Montaje de la asamblea

- **Si ningún punto admite documentos de los miembros, el botón de presentar desaparece sin explicación**: el formulario del punto hace la pregunta de forma explícita, que ningún punto admita envíos es legítimo en una AGE de un solo asunto y el primer consejo que no encuentre el botón avisará a tiempo.
- **«Aplicar plazos por defecto» reescribe también los plazos ya pasados**: exige aplazar una asamblea ya convocada y pulsar ese botón, el diálogo avisa y nada se guarda sin pulsar Guardar.
- **Las subidas de PDF no muestran progreso ni avisan al salir**: no se puede publicar un documento PDF sin su fichero, el modal no se cierra mientras sube, navegar dentro de la app no corta la subida y ya hay un indicador de subida.
- **Cambiar la base de las mayorías o la regla de empate no dice que solo vale para las votaciones siguientes**: la base se fija antes de la asamblea, cada votación muestra su base y el cambio queda en la actividad.
- **El seguimiento no muestra los puntos del ODD que aún no tienen ningún documento**: el orden del día ya los muestra, «… y añadir otro» lleva al siguiente punto vacío y varios puntos de trámite no tienen documento por naturaleza.

### Delegados en el móvil

- **Los PDF se sirven con «no-store»: si cae la Wi-Fi no se puede reabrir un PDF ya abierto**: sin red tampoco carga la página del documento, así que cachear el PDF no devolvería el acceso, y no-store evita dejar copias en dispositivos compartidos.
