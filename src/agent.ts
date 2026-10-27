// Ciclo del agente: prompt → modelo → herramientas → … → respuesta.
// Independiente del proveedor (usa LlmAdapter) y del transporte HTTP.
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { ErrorLlm, type Bloque, type HerramientaSpec, type LlmAdapter, type Mensaje } from "./llm/adapter"

export type Ctx = { directory: string; sessionId: string }

/** Forma de cada herramienta exportada por src/tools/*.ts (método → bivariante a propósito). */
export interface Herramienta {
  description: string
  args: Record<string, z.ZodType>
  execute(args: Record<string, unknown>, ctx: Ctx): Promise<string>
}

export interface LlamadaHerramienta {
  id: string
  name: string
  args: Record<string, unknown>
  ok: boolean
  resumen: string
  resultado: string
}

export interface EventoChat {
  rol: "user" | "assistant"
  texto: string
  ts: string
  toolCalls?: LlamadaHerramienta[]
  needsConfirmation?: boolean
}

export interface Sesion {
  id: string
  mensajes: Mensaje[]
  eventos: EventoChat[]
  tokens: number
  turno: number
  /** mensaje_id → turno en que se detectó que requiere revisión humana */
  pendientes: Record<string, number>
}

export interface Limites { maxIteraciones: number; maxTokensSesion: number }

export interface Dependencias {
  adapter: LlmAdapter
  herramientas: Record<string, Herramienta>
  system: string
  directorio: string
  limites: Limites
}

export interface ResultadoTurno { reply: string; toolCalls: LlamadaHerramienta[]; needsConfirmation: boolean }

export function nuevaSesion(id: string): Sesion {
  return { id, mensajes: [], eventos: [], tokens: 0, turno: 0, pendientes: {} }
}

export function esHerramienta(x: unknown): x is Herramienta {
  if (typeof x !== "object" || x === null) return false
  const h = x as Record<string, unknown>
  return typeof h.description === "string" && typeof h.args === "object" && typeof h.execute === "function"
}

/** Registro: cada export del módulo → <prefijo>_<export>. */
export function registrarModulo(prefijo: string, modulo: Record<string, unknown>): Record<string, Herramienta> {
  const registro: Record<string, Herramienta> = {}
  for (const [nombre, valor] of Object.entries(modulo)) {
    if (esHerramienta(valor)) registro[`${prefijo}_${nombre}`] = valor
  }
  return registro
}

export function especificaciones(herramientas: Record<string, Herramienta>): HerramientaSpec[] {
  return Object.entries(herramientas).map(([name, h]) => {
    const esquema = z.toJSONSchema(z.object(h.args)) as Record<string, unknown>
    delete esquema.$schema
    return { name, description: h.description, input_schema: esquema }
  })
}

function textoDe(bloques: Bloque[]): string {
  return bloques.filter((b): b is Extract<Bloque, { type: "text" }> => b.type === "text").map((b) => b.text).join("\n").trim()
}

function logAgente(dir: string, entrada: object): void {
  try {
    mkdirSync(join(dir, "out"), { recursive: true })
    appendFileSync(join(dir, "out", "log.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...entrada }) + "\n")
  } catch { /* nunca tumbar el turno por el log */ }
}

// ───────── Confirmación humana (CA3) aplicada en el servidor, no solo en el prompt ─────────
function bloqueoConfirmacion(sesion: Sesion, nombre: string, args: Record<string, unknown>): string | null {
  if (nombre !== "contratos_registrar" || args.confirmado !== true) return null
  const id = String(args.mensaje_id ?? "")
  const turnoDetectado = sesion.pendientes[id]
  if (turnoDetectado === undefined) {
    return `confirmación no válida: ${id} no tiene campos en revisión pendientes. Llama sin confirmado=true.`
  }
  if (turnoDetectado >= sesion.turno) {
    return `confirmación humana requerida: ${id} se marcó para revisión en este mismo turno. Termina el turno con una pregunta explícita al usuario y espera su respuesta.`
  }
  return null
}

function actualizarPendientes(sesion: Sesion, nombre: string, args: Record<string, unknown>, salida: string): void {
  const id = String(args.mensaje_id ?? "")
  if (!id) return
  const r = JSON.parse(salida) as { ok: boolean; error?: string; data?: { requiere_revision?: string[]; clasificacion?: string; accion?: string } }
  const marcaRevision = (nombre === "contratos_validar" && r.ok && (r.data?.requiere_revision?.length ?? 0) > 0)
    || (nombre === "contratos_registrar" && !r.ok && (r.error ?? "").startsWith("requiere revisión"))
  if (marcaRevision && sesion.pendientes[id] === undefined) sesion.pendientes[id] = sesion.turno
  if (nombre === "contratos_registrar" && r.ok) delete sesion.pendientes[id]
}

async function ejecutarHerramienta(
  sesion: Sesion, deps: Dependencias, uso: Extract<Bloque, { type: "tool_use" }>,
): Promise<LlamadaHerramienta> {
  const base = { id: uso.id, name: uso.name, args: uso.input }
  const herramienta = deps.herramientas[uso.name]
  let salida: string
  if (!herramienta) {
    salida = JSON.stringify({ ok: false, error: `herramienta desconocida: ${uso.name}` })
  } else {
    const validacion = z.object(herramienta.args).safeParse(uso.input)
    const bloqueo = bloqueoConfirmacion(sesion, uso.name, uso.input)
    if (!validacion.success) {
      const detalle = validacion.error.issues.map((i) => `${i.path.map(String).join(".") || "(raíz)"}: ${i.message}`).join("; ")
      salida = JSON.stringify({ ok: false, error: `argumentos inválidos → ${detalle}` })
    } else if (bloqueo) {
      salida = JSON.stringify({ ok: false, error: bloqueo })
      logAgente(deps.directorio, { herramienta: uso.name, mensaje_id: uso.input.mensaje_id ?? null, ok: false, resumen: bloqueo, sesion: sesion.id })
    } else {
      salida = await herramienta.execute(validacion.data as Record<string, unknown>, { directory: deps.directorio, sessionId: sesion.id })
      actualizarPendientes(sesion, uso.name, uso.input, salida)
    }
  }
  const r = JSON.parse(salida) as { ok: boolean; error?: string; data?: { resumen?: string } }
  return { ...base, ok: r.ok, resumen: r.ok ? (r.data?.resumen ?? "ok") : (r.error ?? "error"), resultado: salida }
}

export async function ejecutarTurno(sesion: Sesion, texto: string, deps: Dependencias): Promise<ResultadoTurno> {
  sesion.turno++
  sesion.mensajes.push({ role: "user", content: [{ type: "text", text: texto }] })
  sesion.eventos.push({ rol: "user", texto, ts: new Date().toISOString() })
  const llamadas: LlamadaHerramienta[] = []
  const textos: string[] = []
  let reply = ""

  for (let i = 0; i < deps.limites.maxIteraciones; i++) {
    if (sesion.tokens >= deps.limites.maxTokensSesion) {
      reply = `Se alcanzó el tope de ${deps.limites.maxTokensSesion} tokens de esta sesión. Inicia una sesión nueva para continuar.`
      break
    }
    let respuesta
    try {
      respuesta = await deps.adapter.enviar({ system: deps.system, mensajes: sesion.mensajes, herramientas: especificaciones(deps.herramientas) })
    } catch (e) {
      reply = `⚠️ No pude completar la respuesta: ${e instanceof ErrorLlm ? e.message : "error inesperado del proveedor"}. La sesión sigue activa; puedes reintentar.`
      break
    }
    sesion.tokens += respuesta.uso.entrada + respuesta.uso.salida
    sesion.mensajes.push({ role: "assistant", content: respuesta.bloques })
    const parcial = textoDe(respuesta.bloques)
    if (parcial) textos.push(parcial)

    const usos = respuesta.bloques.filter((b): b is Extract<Bloque, { type: "tool_use" }> => b.type === "tool_use")
    if (usos.length === 0) { reply = textos.join("\n\n"); break }

    const resultados: Bloque[] = []
    for (const uso of usos) {
      const llamada = await ejecutarHerramienta(sesion, deps, uso)
      llamadas.push(llamada)
      resultados.push({ type: "tool_result", tool_use_id: uso.id, content: llamada.resultado, is_error: !llamada.ok })
    }
    sesion.mensajes.push({ role: "user", content: resultados })
  }

  if (!reply) {
    reply = `${textos.join("\n\n")}\n\n⚠️ Alcancé el tope de ${deps.limites.maxIteraciones} iteraciones en este turno. Lo hecho hasta ahora está arriba; escribe "continúa" para seguir con lo que falta.`.trim()
  }
  // Mantener la alternancia user/assistant si el turno terminó en resultados de herramientas o error.
  const ultimo = sesion.mensajes[sesion.mensajes.length - 1]
  if (ultimo?.role === "user") sesion.mensajes.push({ role: "assistant", content: [{ type: "text", text: reply }] })

  const needsConfirmation = Object.keys(sesion.pendientes).length > 0
  sesion.eventos.push({ rol: "assistant", texto: reply, ts: new Date().toISOString(), toolCalls: llamadas, needsConfirmation })
  return { reply, toolCalls: llamadas, needsConfirmation }
}
