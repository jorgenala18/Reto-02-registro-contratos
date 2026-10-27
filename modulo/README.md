# Módulo reutilizable — Registro de Contratos

Paquete del agente para integrarlo en otras plataformas de agentes sin depender del servidor de este repositorio.

| Pieza | Qué es | Fuente en la app |
|---|---|---|
| `agent.md` | Frontmatter (`description`, `mode: primary`, `permission: {edit: deny, bash: deny}`) + system prompt | `agent/prompt.md` |
| `tools/contratos.ts` | Las mismas herramientas tipadas con zod. Solo dependen de `zod` y `node:fs`/`node:path` | `src/tools/contratos.ts` |
| `skill/registro-contratos/SKILL.md` | Conocimiento del proceso: reglas RN1–RN7, parámetros y casos especiales | `src/knowledge/registro-contratos.md` |

**No hay copias divergentes.** Las tres piezas se generan con `bun run modulo`, y `bun run modulo:check` falla si alguna difiere de su fuente.

## Uso
```ts
import * as contratos from "./tools/contratos"
const ctx = { directory: "/ruta/al/proyecto", sessionId: "s1" } // debe contener fixtures/reto-02 (o el buzón real)
const r = JSON.parse(await contratos.leer_buzon.execute({}, ctx))
```
Cada export es una herramienta con la forma `{ description, args (zod), execute(args, ctx) → string JSON }`. La plataforma la expone como `contratos_<export>`.
