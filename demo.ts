// demo.ts — Verificación SIN modelo de lenguaje.
// Procesa los 6 mensajes del buzón llamando directamente a las herramientas.
// Uso: bun install && bun run demo.ts
import { rmSync } from "node:fs"
import { join } from "node:path"
import * as contratos from "./src/tools/contratos"

const HOY = "2026-09-03"
const ctx = { directory: import.meta.dir, sessionId: "demo" }

interface Respuesta<T> { ok: boolean; data?: T; error?: string }
interface Mensaje { id: string; asunto: string; tiene_contrato: boolean }
interface Extraccion { contrato: Record<string, unknown>; confianza: Record<string, number> }
interface Validacion { clasificacion: string; motivo?: string; requiere_revision: string[]; avisos: string[]; diferencias?: Array<{ campo: string; maestro: string; documento: string }> }
interface Registro { accion: string; id_contrato: string | null; ruta_archivo: string | null; resumen: string }
interface Alertas { ruta: string; vencen: unknown[]; polizas_pendientes: unknown[]; registrados_desde_corte: unknown[] }

const leer = <T>(json: string): Respuesta<T> => JSON.parse(json) as Respuesta<T>
const linea = (t = ""): void => console.log(t)
const titulo = (t: string): void => linea(`\n${"═".repeat(72)}\n${t}\n${"═".repeat(72)}`)

async function procesar(id: string): Promise<{ id: string; clasificacion: string; revision: string; accion: string }> {
  titulo(`Mensaje ${id}`)
  const ext = leer<Extraccion>(await contratos.extraer.execute({ mensaje_id: id }, ctx))
  if (ext.ok && ext.data) {
    const conf = Object.entries(ext.data.confianza).map(([c, v]) => `${c}=${v}`).join(" ")
    linea(`extraer   → ok · confianza: ${conf}`)
  } else linea(`extraer   → ${ext.error}`)

  const contrato = ext.data?.contrato ?? {}
  const val = leer<Validacion>(await contratos.validar.execute({ mensaje_id: id, contrato }, ctx))
  if (!val.ok || !val.data) {
    linea(`validar   → ERROR: ${val.error} (se continúa con el siguiente)`)
    return { id, clasificacion: "error", revision: "-", accion: "ninguna" }
  }
  const v = val.data
  linea(`validar   → clasificación: ${v.clasificacion.toUpperCase()}${v.motivo ? ` · motivo: ${v.motivo}` : ""}`)
  linea(`            campos en revisión: ${v.requiere_revision.join(", ") || "ninguno"}`)
  v.diferencias?.forEach((d) => linea(`            Δ ${d.campo}: maestro="${d.maestro}" documento="${d.documento}"`))
  v.avisos.forEach((a) => linea(`            · ${a}`))

  const reg = leer<Registro>(await contratos.registrar.execute({ mensaje_id: id, contrato, fecha_registro: HOY }, ctx))
  const accion = reg.ok && reg.data ? `${reg.data.accion}${reg.data.ruta_archivo ? ` → ${reg.data.ruta_archivo}` : ""}` : `NO REGISTRADO (${reg.error})`
  linea(`registrar → ${accion}`)
  return { id, clasificacion: v.clasificacion, revision: v.requiere_revision.join(", ") || "—", accion: reg.ok ? (reg.data?.accion ?? "") : "pendiente de confirmación" }
}

async function main(): Promise<void> {
  rmSync(join(ctx.directory, "out"), { recursive: true, force: true }) // determinismo: out/ limpio
  titulo(`DEMO Registro de Contratos Vigentes — sin modelo — hoy = ${HOY}`)

  const buzon = leer<{ mensajes: Mensaje[] }>(await contratos.leer_buzon.execute({}, ctx))
  buzon.data?.mensajes.forEach((m) => linea(`  ${m.id} · contrato: ${m.tiene_contrato ? "sí" : "no"} · ${m.asunto}`))

  const resumen = []
  for (const m of buzon.data?.mensajes ?? []) resumen.push(await procesar(m.id))

  titulo("Robustez: mensaje inexistente (HU-6) — el lote no se aborta")
  linea(await contratos.extraer.execute({ mensaje_id: "msg-999" }, ctx))

  titulo("Segunda pasada: confirmación humana de msg-006 (confirmado: true)")
  linea('Usuario: "confirmo el valor 0 y la fecha fin 2027-08-31"')
  const ext6 = leer<Extraccion>(await contratos.extraer.execute({ mensaje_id: "msg-006" }, ctx))
  const corregido = { ...(ext6.data?.contrato ?? {}), valor: 0, fecha_fin: "2027-08-31" }
  const reg6 = leer<Registro>(await contratos.registrar.execute({ mensaje_id: "msg-006", contrato: corregido, confirmado: true, fecha_registro: HOY }, ctx))
  linea(`registrar(confirmado=true) → ${reg6.ok ? `${reg6.data?.accion} ${reg6.data?.id_contrato} → ${reg6.data?.ruta_archivo}` : reg6.error}`)
  const fila6 = resumen.find((r) => r.id === "msg-006")
  if (fila6 && reg6.ok) fila6.accion = "alta (tras confirmación)"

  titulo("Idempotencia: reintentar msg-001 no duplica")
  linea(await contratos.registrar.execute({ mensaje_id: "msg-001" }, ctx))

  titulo(`Alertas al ${HOY}`)
  const al = leer<Alertas>(await contratos.alertas.execute({ hoy: HOY }, ctx))
  linea(al.ok ? `${al.data?.ruta}: ${al.data?.vencen.length} por vencer · ${al.data?.polizas_pendientes.length} pólizas pendientes · ${al.data?.registrados_desde_corte.length} desde el corte` : al.error)

  titulo("Resumen")
  console.table(resumen)
}

await main()
