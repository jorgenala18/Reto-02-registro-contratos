// Genera modulo/ a partir de las MISMAS fuentes que usa la aplicación:
//   agent/prompt.md                     → modulo/agent.md (con frontmatter)
//   src/tools/contratos.ts              → modulo/tools/contratos.ts (copia byte a byte)
//   src/knowledge/registro-contratos.md → modulo/skill/registro-contratos/SKILL.md
// Con --check falla si modulo/ diverge de las fuentes (úsalo en CI o antes de entregar).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const raiz = resolve(import.meta.dir, "..")
const leer = (r: string): string => readFileSync(join(raiz, r), "utf-8")

const FRONTMATTER_AGENTE = `---
description: Agente punto único de recepción de contratos. Lee el buzón, extrae y valida contratos, registra en el maestro con confirmación humana para datos dudosos y genera alertas de vencimiento y pólizas.
mode: primary
permission:
  edit: deny
  bash: deny
---

`

const piezas: Record<string, string> = {
  "modulo/agent.md": FRONTMATTER_AGENTE + leer("agent/prompt.md"),
  "modulo/tools/contratos.ts": leer("src/tools/contratos.ts"),
  "modulo/skill/registro-contratos/SKILL.md": leer("src/knowledge/registro-contratos.md"),
}

const verificar = process.argv.includes("--check")
const divergentes = Object.entries(piezas).filter(([ruta, contenido]) => {
  const destino = join(raiz, ruta)
  return !existsSync(destino) || readFileSync(destino, "utf-8") !== contenido
}).map(([ruta]) => ruta)

if (verificar) {
  if (divergentes.length) { console.error(`modulo/ diverge de las fuentes: ${divergentes.join(", ")}. Ejecuta: bun run modulo`); process.exit(1) }
  console.log("modulo/ coincide con las fuentes ✔")
} else {
  for (const [ruta, contenido] of Object.entries(piezas)) {
    mkdirSync(dirname(join(raiz, ruta)), { recursive: true })
    writeFileSync(join(raiz, ruta), contenido)
  }
  console.log(`modulo/ generado (${Object.keys(piezas).length} piezas)`)
}
