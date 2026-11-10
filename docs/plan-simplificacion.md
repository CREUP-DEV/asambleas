# Plan de simplificación de la plataforma

Propuesta para hacer la plataforma mucho más fácil de usar sin quitar funciones. Nada de esto está implementado todavía. Las referencias a archivos indican dónde está hoy cada cosa.

Criterios que aplico en todo el plan:

- En cada pantalla se ve primero lo que le toca hacer a quien la mira; el resto queda a un clic, con un nombre claro ("Ver detalles", "Más opciones").
- Una elección importante se ve como botones o tarjetas, nunca dentro de un desplegable.
- Un mismo dato aparece una sola vez por pantalla.
- Siempre hay una forma visible de volver atrás.

## Decisiones ya tomadas contigo

| Tema                          | Decisión                                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Miembros de la CEA            | No se crea ningún miembro "CEA" fijo ni se cambia el modelo ahora. Secretaría asigna a los cargos que existan. El modelo de cargos queda para después (la Intranet no lista la CEA).                                                                                                                                      |
| Quién ve el cargo de la CEA   | CEA y roles superiores ven el cargo real. Asociados, Sectoriales e Invitados ven solo "CEA".                                                                                                                                                                                                                              |
| Código de enmiendas de la CEA | "CEA n" para todo el mundo, numeradas juntas sea cual sea el cargo.                                                                                                                                                                                                                                                       |
| Enmiendas con la CEA          | La CEA presenta enmiendas y transaccionales. Quien no ve sus cargos sí ve la lista real solo al componer una, para elegirlos como cofirmantes o autor principal. Mientras redacta su borrador ve siempre qué cargos puso y cuál es el autor principal (decidido el 2026-11-10); fuera del editor vuelve a ver solo "CEA". |
| Corregir quién presenta       | Secretaría puede cambiar los firmantes y el autor principal de una enmienda ya presentada y sin decidir. El número se conserva y el código sigue al nuevo autor principal (siempre "CEA n" si es un cargo de la CEA). No se puede cambiar el autor principal mientras haya una transaccional abierta sobre ella.          |
| ODD definitivo                | Botón visible en la página del ODD. Secretaría puede seguir editando después.                                                                                                                                                                                                                                             |
| Presentar enmienda            | Botón que abre el documento entero en un editor, colocado donde estaba leyendo la persona. Todo lo que cambie es una única enmienda con una única justificación.                                                                                                                                                          |
| Ver enmiendas                 | Una a una, con Anterior y Siguiente.                                                                                                                                                                                                                                                                                      |
| PDF en tipos enmendables      | Solo Secretaría. Los miembros los presentan como texto; el servidor también lo impide.                                                                                                                                                                                                                                    |
| Onboarding                    | Bienvenida de 4 o 5 pasos la primera vez, guardada en la cuenta y reabrible desde "Ayuda".                                                                                                                                                                                                                                |

## 1. Navegación: migas de pan y volver atrás

**Hoy.** No hay migas de pan en ninguna página. Dentro de un documento la única forma de subir es el menú lateral, que en móvil está escondido. Hay cinco textos distintos de "volver" y casi todos salen solo en pantallas de error (`documentos/[document]/index.vue`, `revisar.vue`, `consolidado.vue`, `editar.vue`).

**Propuesta.**

- Una fila de migas de pan bajo la barra superior en todas las páginas: `Asambleas › 80.ª AGO › Orden del día › 3. Resoluciones › Resolución X`. En la administración: `Administración › Usuarios`.
- En móvil la fila se reduce a un único enlace "‹ Orden del día" (el nivel de arriba).
- Los cinco "volver" actuales se sustituyen por esa fila. El editor conserva su aviso de cambios sin guardar al salir.
- El menú lateral y la barra de secciones del móvil salen de una sola lista. Hoy no coinciden: en móvil quien no gestiona no llega al Calendario ni a la Proyección.
- Para Secretaría, las secciones de la asamblea se agrupan con títulos: "Asamblea" (resumen, directo, ODD, documentos, calendario, convocatoria), "Secretaría" (validación, seguimiento, ajustes) y "Mesa" (sesión, proyección). Hoy son 11 entradas seguidas más 5 de administración.

Sin cambios en servidor ni base de datos.

## 2. Orden del día

### 2.1 Vista más ligera

**Hoy.** Una sola página pinta todo el árbol: cada punto es una tarjeta, cada documento una fila con hasta ocho datos, y nada se pliega (`agenda/ItemNode.vue`, `agenda/DocumentRow.vue`).

**Propuesta.**

- **Plegar y desplegar.** Cada punto con subpuntos lleva una flecha para mostrarlos u ocultarlos, y arriba hay "Desplegar todo" y "Plegar todo". Se recuerda por asamblea en el navegador. Si un enlace lleva a un subpunto plegado, se despliega solo.
- **Fila compacta.** En el ODD cada documento muestra solo título, estado y número de enmiendas con su palabra ("4 enmiendas", hoy es un número suelto con explicación al pasar el ratón). Presentadores, plazo de enmiendas y frase de progreso pasan a la página del punto.
- **Mismo nombre, una sola fila.** Cuando un punto tiene un único documento y se llaman igual (o el punto es "Aprobación, si procede, de X" y el documento "X"), se pinta una sola fila: el título del punto abre el documento y lleva su estado. La comparación ya existe para proponer títulos (`itemProposal.ts`).
- **Acciones a la vista.** "Editar", "Añadir subpunto" y "Eliminar" dejan de estar en el menú de tres puntos y pasan a ser botones con texto en la página del punto.

### 2.2 Página de un punto o subpunto

Nueva página `orden-del-dia/[punto]` para cualquier punto o subpunto:

- migas con los puntos superiores;
- número, título y descripción;
- sus documentos con toda la información;
- sus subpuntos como lista de enlaces;
- "Anterior" y "Siguiente" para recorrer el ODD;
- para Secretaría, aquí están editar, añadir subpunto, añadir documentos y eliminar.

Usa los datos que ya se cargan; no hace falta nada nuevo en el servidor. La dirección lleva el identificador del punto, porque el número cambia al reordenar.

### 2.3 ODD definitivo

**Hoy.** Solo pasa a definitivo con un interruptor al final de la página de Calendario (`calendario.vue`), por eso la 80.ª AGO sigue como provisional. Una vez definitivo nadie puede tocar los puntos principales sin reabrirlo, tampoco Secretaría. Los subpuntos ya quedan fuera del bloqueo en el servidor.

**Propuesta.**

- Botón "Marcar como definitivo" en la cabecera del ODD para Secretaría. Si la fecha del hito ya pasó y sigue provisional, un aviso lo recuerda en el ODD y en el resumen de la asamblea.
- Con el ODD definitivo, Secretaría puede crear, mover, renombrar y eliminar puntos principales tras confirmar ("El orden del día ya es definitivo. ¿Cambiarlo igualmente?"). El cambio queda en el historial marcado como posterior al definitivo.
- Añadir subpuntos nunca pide confirmación ni se marca: no es modificar el ODD definitivo.
- Desaparece el rodeo "Reabrir en el calendario". El interruptor del calendario se quita para que haya un solo sitio.
- Al desplegar habrá que pulsar el botón una vez en la 80.ª AGO.

Servidor: `assertRootsUnlocked` pasa de rechazar a exigir `confirmFinal` en la petición; nueva clave de historial `afterFinal`.

### 2.4 Resoluciones, mociones y subida en serie

**Hoy.** Los documentos cuelgan directamente del punto; no se crea un subpunto por documento. Un punto solo tiene un interruptor "admite documentos de los miembros", sin tipo. Para subir varios documentos Secretaría repite: crear subpunto, abrir documento, editor, volver.

**Propuesta.**

- **Puntos contenedor.** Secretaría marca un punto como "Aquí los miembros presentan" y elige qué tipos (resoluciones, mociones internas...). Sustituye al interruptor actual.
- **Subpunto automático.** Cuando un miembro presenta un documento en un punto contenedor, se crea en el mismo paso un subpunto con el título del documento y el documento dentro. El subpunto lleva el título del documento y lo sigue si cambia, hasta que Secretaría le ponga otro a mano; desde entonces conserva el suyo. Si el documento se elimina, el subpunto desaparece. Mientras el documento no esté publicado, quien no puede verlo tampoco ve el subpunto; si el subpunto se queda porque contiene otra cosa, lo ve como "Punto de un documento sin publicar", también cuando el documento se movió a otro punto o se eliminó sin llegar a publicarse, hasta que Secretaría le ponga un título propio.
- **Añadir varios documentos.** En la página de un punto, Secretaría tiene "Añadir documentos": una lista donde escribe en cada línea título, tipo y quién presenta, y puede soltar un PDF en cada una. Al guardar se crean todos, cada uno con su subpunto si el punto es contenedor. Sin salir de la página.
- Una sectorial sigue sin poder presentar una moción interna por esta vía.

Servidor: columna nueva en `agenda_items` con los tipos admitidos (migración que convierte el interruptor actual en "todos los tipos"), creación de subpunto y documento en una transacción con sus dos eventos, y una marca que distingue el subpunto automático. Hay que ajustar `isExpectedDocument`, que hoy deduce "documento esperado" de que el punto no admita presentaciones y confundiría los subpuntos automáticos.

### 2.5 Eliminar puntos con contenido

**Hoy.** No se puede eliminar un punto si en su rama hay algún documento enviado o publicado. Además, el borrado en cascada no deja rastro de cada documento ni borra sus PDF del disco.

**Propuesta.**

- Secretaría puede eliminar cualquier punto con sus subpuntos y documentos. Solo se impide si algún documento de la rama tiene enmiendas.
- La confirmación dice exactamente qué se va a borrar: "Se eliminarán 3 subpuntos y 4 documentos".
- Cada documento borrado deja su entrada en el historial y se limpian su PDF, sus votos y el directo.

## 3. Documentos: crear y editar

**Hoy.** El formato (texto o PDF) está dentro de "Opciones avanzadas" al crear, dentro de "Más opciones" en documentos esperados, y tras crear es un botón diminuto dentro de un panel cerrado. El tipo es siempre un desplegable. "Publicar ahora" está en el menú de tres puntos.

**Propuesta.**

- **Formato a la vista.** Dos tarjetas grandes en el formulario principal para Secretaría: "Texto en la plataforma (se puede enmendar)" y "PDF subido (no se puede enmendar)". En el editor, una franja visible para cambiarlo mientras sea borrador.
- **Miembros.** En tipos enmendables no hay elección: siempre texto, con el aviso de que pueden importar un Word. El servidor rechaza un PDF de un miembro en esos tipos (hoy lo acepta).
- **Tipo como tarjetas** para los miembros: los 5 o 6 habituales visibles y una tarjeta "Otro tipo" que abre la lista completa. Secretaría conserva la lista con buscador, que con 15 tipos es más rápida.
- **Mayoría** como tres botones en vez de desplegable.
- **Reglas del tipo.** Secretaría ve un resumen de una línea ("Se puede enmendar · Se vota · Mayoría simple") con un botón "Cambiar" que abre los controles. Hoy son interruptores dentro de dos niveles plegados.
- **"Publicar ahora"** pasa a botón visible.
- Un solo formulario para "Añadir documento" y "Documento esperado": el segundo es el primero con fecha límite.

Otros desplegables que esconden elecciones y pasan a botones visibles: tipo de asamblea al crearla, modos de vista del documento ("Ver"), "Proponer una transaccional" (hoy en "Más"), y los filtros de enmiendas (apartado 4.1).

## 4. Enmiendas

### 4.1 Ver enmiendas

**Hoy.** El cambio sale dos veces en escritorio (en el texto y en la ficha). Cada fragmento cambiado lleva cuatro señales a la vez: texto de color, fondo de color, subrayado y un recuadro burdeos. La ficha tiene 11 secciones y solo el historial está plegado. Para pasar a otra enmienda hay que cerrar, buscar en la lista y pulsar. Las tarjetas de la lista llevan hasta diez elementos y los filtros están en un desplegable.

**Propuesta.**

- **Colores suaves para todos.** El texto cambiado va en color normal; lo añadido lleva un fondo verde muy claro y subrayado fino, y lo quitado un fondo rojo muy claro, tachado y texto atenuado. El recuadro burdeos solo aparece cuando se ven varias enmiendas juntas. El modo "marcas" de accesibilidad se mantiene. Se comprueba el contraste en claro y oscuro antes de darlo por bueno.
- **Lectura una a una.** Al abrir una enmienda la ficha ocupa el panel y arriba pone "‹ Anterior · 3 de 17 · Siguiente ›", respetando los filtros. También con las flechas del teclado. "Volver a la lista" siempre visible.
- **Ficha en primer plano**, en este orden:
  1. código, quién la presenta y una sola línea de estado;
  2. qué cambia (solo el fragmento);
  3. por qué (justificación);
  4. la acción que le toca a quien mira: validar para Secretaría, responder para quien presenta el documento, aceptar la transaccional para las partes, editar o retirar para quien la firma.
- **"Ver detalles"** plegado: firmantes y fechas, resultado de votación, solapes, relaciones, transaccionales e historial.
- **Sin duplicado.** La ficha enseña el fragmento; un botón "Ver en el documento" lleva al texto completo con el cambio marcado. El texto deja de cambiar de modo por su cuenta al seleccionar.
- **Lista más limpia.** Cada tarjeta: código, quién, estado y una línea de justificación. Los avisos que piden actuar (corrección pedida, fuera de plazo pendiente) se mantienen. El resto pasa a la ficha.
- **Filtros a la vista.** Botones "Todas", "Pendientes", "Mías", "Fuera de plazo"; el resto en "Más filtros".
- Los modos del texto (original, con enmiendas, consolidado, comparar) pasan a pestañas visibles.
- **Reclasificar.** Secretaría (y quien tenga sus permisos) puede cambiar una enmienda de "forma" a "contenido" y al revés con un botón en la ficha, mientras no esté decidida. La Mesa no. Queda en el historial y quien la firma lo ve en sus novedades.

Solo cambia el cliente, salvo la reclasificación, que necesita un punto nuevo en el servidor con su evento.

### 4.2 Presentar una enmienda

**Hoy.** El botón "Presentar enmienda" no abre nada: pide pulsar un párrafo, y luego hay que elegir entre "Enmendar", "Añadir después" o "Eliminar". Forma y firmantes están en un desplegable al final, bajo la justificación.

**Propuesta.**

1. **Un botón "Presentar enmienda"** abre el documento entero en un editor a toda la anchura, colocado en el punto por donde iba leyendo.
2. **Se edita como un texto normal.** Escribir, borrar o añadir párrafos; no hay que decir si es modificación, adición o supresión, eso se deduce solo.
3. **Panel fijo a la vista** con tres cosas:
   - "¿Qué tipo de enmienda es?": dos tarjetas, "Cambia el contenido" y "Solo corrige la forma";
   - "¿Quién la presenta?": dos tarjetas, "Solo mi consejo" y "Con otros miembros"; la segunda muestra el selector de miembros y quién es el principal;
   - "¿Por qué?": la justificación.
4. **"Revisar y enviar"** enseña los cambios marcados tal como los verá el resto y los botones "Guardar borrador" y "Enviar".
5. Todo lo cambiado en esa sesión es una única enmienda. Para otra, se repite.

Qué se conserva:

- "Cambiar una palabra en todo el documento", "Devolver el documento" y "Texto alternativo" siguen existiendo como enlaces secundarios bajo el botón principal, con una frase que explica cada uno.
- Borradores, corrección pedida por Secretaría, aviso de fuera de plazo y presentar en nombre de otro (Mesa).

Detalles técnicos:

- El motor ya convierte un texto editado en operaciones ancladas a la versión base (`diffPassage`); no cambia el modelo ni la API.
- **Enmendar formato.** Hoy un cambio que solo toca formato (negrita, cursiva, enlace, nivel de título, tipo o nivel de lista) en un párrafo existente no genera enmienda: el motor solo compara el texto. Hay que ampliarlo:
  - la operación `replace` pasa a poder llevar el formato nuevo del fragmento y el tipo nuevo del bloque (párrafo, título de nivel n, elemento de lista), siempre anclada a la versión base;
  - `diffPassage` detecta esos cambios, `validateOps` los valida, `consolidate` los aplica y `findOverlaps` los cuenta como zona tocada;
  - en pantalla y en PDF un cambio de formato se marca con el mismo estilo suave y una etiqueta legible ("pasa a negrita", "pasa a título de nivel 2"), porque un tachado no lo explica;
  - las enmiendas ya guardadas siguen valiendo sin migración: los campos nuevos son opcionales;
  - es el cambio de más riesgo del plan, porque toca el motor compartido. Va con pruebas nuevas en `content.test.ts` y `engine.fuzz.test.ts` antes de tocar la interfaz.
  - Mover párrafos de sitio sigue siendo quitar y añadir, y el color de las celdas sigue sin ser enmendable.
- En móvil el documento entero en un editor puede ir justo con textos de 30 páginas; lo comprobaré con un documento real antes de cerrar el diseño.

## 5. Quién ve el cargo de la CEA

**Hoy.** Todo el mundo ve el cargo. No hay ningún punto único donde se decida: el presentador sale por documentos, enmiendas, transaccionales, historial, novedades, actividad, turnos de palabra, lista de miembros y PDF.

**Propuesta.**

- **Regla.** Ven el cargo real: Admin, Secretaría, Presidencia, Moderador (la Mesa lo necesita para dar la palabra) y las cuentas CEA. El resto recibe del servidor un presentador genérico "CEA · Comisión Ejecutiva Ampliada" en lugar del cargo. Se hace en el servidor, no ocultando en pantalla.
- **Dónde se aplica:** presentador y copresentadores de documentos, firmantes de enmiendas, partes de transaccionales, historial (también el nombre de la persona que actuó por el cargo), novedades, tareas, actividad, turnos de palabra, la lista de miembros de los selectores y los PDF, que se generan según quien los pide.
- **Códigos.** Las enmiendas de cualquier cargo pasan a "CEA n" para todos, numeradas por documento. Migración para las ya existentes.
- Los documentos de Asociados y Sectoriales no cambian: todo el mundo sigue viendo quién los presenta.
- **Selectores.** Quien no ve los cargos no puede añadir a la CEA como copresentadora de un documento: no aparece en sus selectores y el servidor lo rechaza. Lo hace la propia CEA o Secretaría.
- **Enmiendas y transaccionales (corregido).** La CEA también las presenta, y cualquier miembro puede presentar una con ella. Solo al componer una enmienda o una transaccional, quien no ve los cargos de la CEA recibe la lista real (siglas y nombre, nunca las personas) para elegirlos como cofirmantes o autor principal. Decidido el 2026-11-10 («que cuando redacta siempre pueda ver quién ha puesto de la CEA»): mientras redacta, quien puede editar el borrador de una enmienda o de una transaccional (también el devuelto para corregir) ve siempre qué cargos de la CEA la firman y cuál es el autor principal, marcados uno a uno, y puede quitarlos uno a uno. Solo en el editor y solo mientras es borrador: en las listas, la ficha, el historial, las novedades, la actividad y los PDF sigue viendo "CEA", también en su propio borrador. Con esto queda resuelta la duda anterior sobre la entrada "CEA" de un borrador: ya no existe en el editor, y el servidor no la acepta en una enmienda. Si se presentó mal, Secretaría cambia quién la presenta desde la propia enmienda ("Cambiar quién la presenta").

Sobre el fallo de producción: no es un filtro roto. Los cargos solo existen cuando una cuenta CEA inicia sesión o cuando Secretaría los da de alta en Administración › Miembros, y en producción no ha pasado ninguna de las dos cosas. Según lo decidido no se cambia; en cuanto entren las cuentas CEA aparecerán. Los cargos se crean con las iniciales de la cuenta, así que conviene que Secretaría revise sus nombres.

## 6. Nombres

- `Comisión Ejecutiva (CEA)` pasa a `Comisión Ejecutiva Ampliada (CEA)` (nombre del rol).
- `Área ejecutiva` pasa a `Cargo de la CEA` (corregido: son cargos unipersonales de la CEA, no áreas); en inglés, `CEA office`. Ningún texto visible dice «área».
- Afecta a 6 claves en cada idioma, al texto del rol en el seed, a un test y a la documentación (`AGENTS.md`, `docs/design.md`, `docs/api.md`).
- En inglés propongo `Extended Executive Committee (CEA)`.
- La plataforma no distingue la Comisión Ejecutiva de la Ampliada: todos los textos de la interfaz y de los PDF dicen "Comisión Ejecutiva Ampliada" (por ejemplo, "Informe de la Comisión Ejecutiva Ampliada"). "Informe ejecutivo" se queda como nombre corto del tipo.
- Los títulos de puntos del ODD son contenido que escribe Secretaría y no se tocan.

## 7. Bienvenida y ayuda

**Hoy.** Idioma, tema y accesibilidad están en el menú del avatar, al pie del menú lateral, a tres clics. Las preferencias se guardan por navegador. No hay ninguna ayuda.

**Propuesta.**

- La primera vez que alguien entra, una ventana con pasos cortos, una idea por paso y un dibujo o captura:
  1. Qué es la plataforma y qué puede hacer su rol.
  2. Dónde ve lo que le toca (inicio) y cómo llegar a una asamblea.
  3. Cómo presentar un documento o una enmienda (Asociado, Sectorial, CEA) o cómo validar y organizar (Secretaría).
  4. Cómo volver atrás y dónde está la ayuda.
  5. "Ponlo a tu gusto": idioma, tema claro u oscuro, tipo de letra y forma de marcar los cambios, elegibles ahí mismo.
- Se puede saltar. Se guarda en la cuenta que ya se vio (columna nueva en `users`).
- Entrada "Ayuda" en el menú lateral que la reabre.
- Idioma, tema y accesibilidad dejan de ser submenús: una sola entrada "Preferencias" abre una ventana con las tres cosas a la vista.
- No aparece mientras un Admin suplanta a otra cuenta.

## 8. Buscar usuarios mientras se escribe

Ya funciona así en el código actual: busca en el servidor 300 ms después de dejar de escribir, sin pulsar Intro (`app/pages/admin/usuarios.vue`, commit `6c6bae3`). Si en producción todavía hay que pulsar Intro es que esa versión no está desplegada. Añadiré solo un indicador de "buscando" en el campo.

## 9. Colores de fondo en tablas

**Hoy.** Una celda solo puede ser "clara" (beige) u "oscura", y "oscura" significa en realidad celda de encabezado.

**Propuesta.**

- Una fila de muestras de color en la barra del editor, con las siete de la paleta y "sin color".
- El color del texto lo pone la plataforma:

  | Fondo                 | Texto  | Contraste |
  | --------------------- | ------ | --------- |
  | Burdeos `#792225`     | blanco | 10,2      |
  | Azul `#163866`        | blanco | 11,7      |
  | Beige `#F5EEE6`       | oscuro | 18,3      |
  | Gris oscuro `#424242` | blanco | 10,1      |
  | Gris claro `#A6A6A6`  | negro  | 8,6       |
  | Verde `#2A7258`       | blanco | 5,8       |
  | Morado `#513269`      | blanco | 10,5      |

- El color es solo visual. "Fila de encabezado" sigue siendo un botón aparte (es lo que repite la fila en cada página del PDF).
- Se guarda el nombre del color, no el código, y el beige actual se lee como "beige" sin migrar datos.
- Se aplica igual en pantalla, impresión y PDF. Al importar un Word, cada relleno se convierte al color más parecido de la paleta.

## 10. Lo que ve cada rol

| Rol                    | Inicio                                                                                        | Menú en una asamblea                           |
| ---------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Secretaría y similares | Lo que hay que validar, sus tareas, novedades. Atajos de administración plegados.             | Agrupado en Asamblea, Secretaría y Mesa.       |
| CEA                    | "Te toca": documentos esperados, correcciones, enmiendas por responder. Ve los cargos reales. | Resumen, directo, ODD, documentos, calendario. |
| Asociado               | "Te toca": lo mismo para su consejo. Ve "CEA" sin cargo.                                      | Igual.                                         |
| Sectorial              | Como Asociado; no se le ofrecen mociones internas.                                            | Igual.                                         |
| Invitado               | Próximas asambleas y un texto que explica que solo puede consultar.                           | Igual; conserva todo lo que ve hoy.            |

Además, el inicio y el resumen de la asamblea enseñan como mucho tres bloques en primer plano (lo que te toca, lo siguiente del calendario y el ODD); cifras y calendario completo quedan tras su enlace. Revisaré cada vista con las cuentas de la simulación de la 77.ª AGO, una por rol.

## Decisiones que he tomado por defecto

Dime si alguna no te convence:

- Moderador ve el cargo real de la CEA.
- "Tiene enmiendas", para impedir eliminar un punto, cuenta cualquier enmienda, también borradores y retiradas: borrar el documento se llevaría el trabajo de otros.
- La elección forma o contenido es obligatoria y no viene marcada.
- Los colores suaves sustituyen a los actuales para todos; no añado una tercera opción de accesibilidad.
- Las migas van en una fila propia bajo la barra superior, no dentro de ella.
- Por defecto el ODD se abre con los puntos principales desplegados y lo demás plegado.
- En modo oscuro los colores de tabla se mantienen exactos.

## Preguntas ya resueltas

1. **Enmiendas de formato.** Se pueden enmendar negritas, títulos y listas; se amplía el motor (4.2).
2. **CEA como cofirmante.** Un usuario no puede añadir a la CEA (5).
3. **"Comisión Ejecutiva".** No se distingue de la Ampliada en la plataforma (6).
4. **Reclasificar forma y contenido.** Secretaría sí, la Mesa no (4.1).
5. **Invitado.** Conserva Calendario, Convocatoria y Proyección (10).
6. **Subpunto automático.** Lleva el título del documento y Secretaría puede cambiarlo (2.4).

## Orden propuesto

Cada fase es independiente y se puede desplegar sola.

| Fase | Contenido                                                                                                                                                                                               | Toca base de datos               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 1    | Nombres (6), migas y menú (1), plegar subpuntos y fila compacta (2.1), botón de ODD definitivo y edición posterior (2.3), colores suaves del cambio (4.1), formato y tipo a la vista (3), regla de PDF. | No                               |
| 2    | Página de punto (2.2), puntos contenedor con subpunto automático y subida en serie (2.4), eliminar con contenido (2.5).                                                                                 | Sí: tipos admitidos por punto    |
| 3    | Lectura de enmiendas una a una y reclasificación (4.1); motor ampliado para enmendar formato y nuevo editor para presentarlas (4.2).                                                                    | No                               |
| 4    | Ocultar el cargo de la CEA y códigos "CEA n" (5).                                                                                                                                                       | Sí: renumerar códigos existentes |
| 5    | Bienvenida, ayuda y preferencias (7), colores de tabla (9), repaso por rol (10).                                                                                                                        | Sí: marca de bienvenida vista    |

Cada fase termina con la lista de verificación de `AGENTS.md`, textos en español e inglés, y `docs/design.md`, `docs/api.md` y `AGENTS.md` actualizados donde cambien las reglas.
