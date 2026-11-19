# Documentación

Qué hay en `docs/` y en qué orden leerlo. Sirve para trabajar en esta
plataforma y también como base para construir una parecida para otra
organización: los documentos describen el dominio y las decisiones, y el
código es la referencia de cómo se hizo.

## Por dónde empezar

1. [`proceso-asambleas.md`](proceso-asambleas.md): cómo funcionan hoy las
   asambleas de CREUP (documentos, plazos, enmiendas, transaccionales,
   votaciones). Es el origen de los requisitos (`R-…`), con la normativa y
   los casos reales que los justifican. Léelo primero si vienes de otra
   organización: lo que cambie en tu proceso cambia el diseño.
2. [`design.md`](design.md): el modelo de la plataforma y por qué es así
   (miembros, documentos, enmiendas como operaciones sobre un texto
   congelado, sesión en directo, recuentos, trazabilidad, permisos).
3. [`api.md`](api.md): cada endpoint, sus reglas y sus errores. Los tipos
   están en [`shared/types/api.ts`](../shared/types/api.ts).
4. [`../AGENTS.md`](../AGENTS.md): las reglas que manda cumplir el
   repositorio a quien lo edite, persona o agente. Si algo choca con otro
   documento, gana `AGENTS.md`.

## Integraciones y funciones concretas

- [`intranet.md`](intranet.md): el contrato con la Intranet, que dice quién
  es cada cuenta, qué miembros hay y quién se inscribe. Otra organización
  puede servir el mismo contrato desde su propio sistema de socios.
- [`control-sheet-plan.md`](control-sheet-plan.md): la hoja de control de la
  Mesa durante la sesión, su diseño y lo que queda por hacer.
- [`seating-plan.md`](seating-plan.md): la vista de la sala (quién se sienta
  dónde), su diseño y lo que queda por hacer.

## Operación

- [`../README.md`](../README.md): desarrollo local.
- [`../DEPLOYMENT.md`](../DEPLOYMENT.md): despliegue, copias de seguridad y
  operación. Usa marcadores para lo que identifica el servidor.

## Lo que no está aquí

`docs/private/` existe solo en local (está en `.gitignore`): los valores
reales del servidor, la implementación interna de la Intranet y los informes
de trabajo (revisiones, auditorías, planes puntuales). Las reglas sobre qué va
ahí están en su propio `README.md`. Un documento público puede decir que algo
está en `docs/private/`, pero nunca copiar su contenido.
