// Pruebas del ciclo del agente con un modelo guionizado (sin red ni clave).
import { describe, expect, test, beforeAll } from "bun:test"
import { mkdtempSync, cpSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { ejecutarTurno, nuevaSesion, registrarModulo, especificaciones, type Dependencias } from "../src/agent"
import type { Bloque, LlmAdapter, PeticionLlm, RespuestaLlm } from "../src/llm/adapter"
import * as contratos from "../src/tools/contratos"

type Paso = (p: PeticionLlm) => Bloque[]
const usar = (name: string, input: Record<string, unknown>): Bloque => ({ type: "tool_use", id: `t-${Math.random()}`, name, input })
const ultimoResultado = (p: PeticionLlm): { ok: boolean; data?: { contrato?: Record<string, unknown> } } => {
  const m = p.mensajes[p.mensajes.length - 1]
  const b = m.content.find((x) => x.type === "tool_result")
  return b && b.type === "tool_result" ? JSON.parse(b.content) : { ok: false }
}

class Guion implements LlmAdapter {
  readonly provider = "guion"; readonly model = "guion"
  constructor(private pasos: Paso[]) {}
  async enviar(p: PeticionLlm): Promise<RespuestaLlm> {
    const paso = this.pasos.shift()
    const bloques = paso ? paso(p) : [{ type: "text", text: "fin" } as Bloque]
    return { bloques, fin: bloques.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", uso: { entrada: 100, salida: 10 } }
  }
}

let dir = ""
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "reto02-"))
  cpSync(resolve(import.meta.dir, "..", "fixtures"), join(dir, "fixtures"), { recursive: true })
})

function deps(adapter: LlmAdapter, maxIteraciones = 25): Dependencias {
  return { adapter, herramientas: registrarModulo("contratos", contratos), system: "test", directorio: dir, limites: { maxIteraciones, maxTokensSesion: 1e6 } }
}

describe("registro de herramientas", () => {
  test("expone las 5 herramientas P0 con esquema JSON", () => {
    const specs = especificaciones(registrarModulo("contratos", contratos))
    expect(specs.map((s) => s.name).sort()).toEqual(["contratos_alertas", "contratos_extraer", "contratos_leer_buzon", "contratos_registrar", "contratos_validar"])
    specs.forEach((s) => expect(s.description.length).toBeGreaterThan(20))
  })
})

describe("confirmación humana (CA3)", () => {
  const sesion = nuevaSesion("test-ca3")
  let contrato6: Record<string, unknown> = {}

  test("bloquea confirmado=true en el mismo turno en que se detecta la revisión", async () => {
    const guion = new Guion([
      () => [usar("contratos_extraer", { mensaje_id: "msg-006" })],
      (p) => { contrato6 = ultimoResultado(p).data?.contrato ?? {}; return [usar("contratos_validar", { mensaje_id: "msg-006", contrato: contrato6 })] },
      () => [usar("contratos_registrar", { mensaje_id: "msg-006", contrato: contrato6, confirmado: true })],
      () => [{ type: "text", text: "¿Confirmas el valor 0 y la fecha fin?" }],
    ])
    const r = await ejecutarTurno(sesion, "procesa msg-006", deps(guion))
    const reg = r.toolCalls.find((t) => t.name === "contratos_registrar")
    expect(reg?.ok).toBe(false)
    expect(reg?.resumen).toContain("confirmación humana requerida")
    expect(r.needsConfirmation).toBe(true)
  })

  test("permite confirmado=true en el turno siguiente y limpia el pendiente", async () => {
    const guion = new Guion([
      () => [usar("contratos_registrar", { mensaje_id: "msg-006", contrato: { ...contrato6, valor: 0, fecha_fin: "2027-08-31" }, confirmado: true, fecha_registro: "2026-09-03" })],
      () => [{ type: "text", text: "Registrado CM-2026-03." }],
    ])
    const r = await ejecutarTurno(sesion, "confirmo el valor 0 y la fecha fin 2027-08-31", deps(guion))
    expect(r.toolCalls[0].ok).toBe(true)
    expect(r.needsConfirmation).toBe(false)
    const maestro = readFileSync(join(dir, "out/sharepoint/maestro-contratos.csv"), "utf-8")
    expect(maestro).toContain("CM-2026-03")
    expect(maestro).toContain("2027-08-31")
  })
})

describe("robustez del ciclo", () => {
  test("argumentos inválidos vuelven al modelo como error, sin romper la sesión", async () => {
    const guion = new Guion([() => [usar("contratos_alertas", { hoy: "03/09/2026" })], () => [{ type: "text", text: "ok" }]])
    const r = await ejecutarTurno(nuevaSesion("t-args"), "alertas", deps(guion))
    expect(r.toolCalls[0].ok).toBe(false)
    expect(r.toolCalls[0].resumen).toContain("argumentos inválidos")
  })

  test("respeta el tope de iteraciones (CA1)", async () => {
    const infinito: Paso[] = Array.from({ length: 10 }, () => () => [usar("contratos_leer_buzon", {})])
    const r = await ejecutarTurno(nuevaSesion("t-tope"), "bucle", deps(new Guion(infinito), 3))
    expect(r.toolCalls.length).toBe(3)
    expect(r.reply).toContain("tope de 3 iteraciones")
  })

  test("un error del proveedor se informa en claro y la sesión sigue (CA5)", async () => {
    const roto: LlmAdapter = { provider: "x", model: "x", enviar: async () => { const { ErrorLlm } = await import("../src/llm/adapter"); throw new ErrorLlm("timeout") } }
    const s = nuevaSesion("t-err")
    const r = await ejecutarTurno(s, "hola", deps(roto))
    expect(r.reply).toContain("timeout")
    expect(s.mensajes[s.mensajes.length - 1].role).toBe("assistant")
  })
})
