// Pruebas de las herramientas: los 6 casos del PRD + errores de HU-6.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, cpSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import * as contratos from "../src/tools/contratos"

function entorno() {
  const dir = mkdtempSync(join(tmpdir(), "reto02-h-"))
  cpSync(resolve(import.meta.dir, "..", "fixtures"), join(dir, "fixtures"), { recursive: true })
  return { directory: dir, sessionId: "test" }
}
const json = (s: string) => JSON.parse(s)

async function clasificar(ctx: { directory: string; sessionId: string }, id: string) {
  const ext = json(await contratos.extraer.execute({ mensaje_id: id }, ctx))
  return json(await contratos.validar.execute({ mensaje_id: id, contrato: ext.data?.contrato ?? {} }, ctx)).data
}

describe("casos del buzón (PRD 7.4)", () => {
  const ctx = entorno()
  const esperado: Record<string, [string, string[]]> = {
    "msg-001": ["nuevo", []], "msg-002": ["nuevo", []], "msg-003": ["actualizacion", []],
    "msg-004": ["duplicado", []], "msg-005": ["rechazado", []], "msg-006": ["nuevo", ["valor", "fecha_fin"]],
  }
  for (const [id, [clase, revision]] of Object.entries(esperado)) {
    test(`${id} → ${clase}`, async () => {
      const v = await clasificar(ctx, id)
      expect(v.clasificacion).toBe(clase)
      expect(v.requiere_revision).toEqual(revision)
    })
  }
  test("msg-001 extrae exactamente los valores del contrato", async () => {
    const e = json(await contratos.extraer.execute({ mensaje_id: "msg-001" }, ctx)).data.contrato
    expect(e).toMatchObject({ id_contrato: "CT-2026-015", cliente: "Industrias Delta S.A.S.", nit_cliente: "890900111", pais: "CO", valor: 265000000, moneda: "COP", fecha_inicio: "2026-08-01", fecha_fin: "2027-07-31", requiere_poliza: true, tipo_poliza: "cumplimiento" })
  })
  test("msg-002 interpreta USD 120,000.00 y RUC de Ecuador", async () => {
    const e = json(await contratos.extraer.execute({ mensaje_id: "msg-002" }, ctx)).data.contrato
    expect(e).toMatchObject({ valor: 120000, moneda: "USD", pais: "EC", nit_cliente: "1790012345001", requiere_poliza: false })
  })
  test("registrar sin confirmar msg-006 devuelve requiere revisión", async () => {
    const r = json(await contratos.registrar.execute({ mensaje_id: "msg-006" }, ctx))
    expect(r.ok).toBe(false)
    expect(r.error).toStartWith("requiere revisión")
  })
  test("el agente no puede alterar un valor sin confirmación (CA2)", async () => {
    const e = json(await contratos.extraer.execute({ mensaje_id: "msg-002" }, ctx)).data.contrato
    const r = json(await contratos.registrar.execute({ mensaje_id: "msg-002", contrato: { ...e, valor: 999 } }, ctx))
    expect(r.ok).toBe(false)
    expect(r.error).toContain("valor")
  })
})

describe("errores legibles (HU-6)", () => {
  function conAdjunto(texto: string) {
    const ctx = entorno()
    const d = join(ctx.directory, "fixtures/reto-02/buzon/msg-900")
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, "correo.json"), JSON.stringify({ id: "msg-900", de: "x@y.com", para: "c@y.com", asunto: "t", fecha: "2026-09-01", cuerpo: "", adjuntos: ["contrato.txt"] }))
    writeFileSync(join(d, "contrato.txt"), texto)
    return ctx
  }
  const base = "CONTRATO DE PRESTACIÓN DE SERVICIOS No. CT-2026-900\nEntre ACME S.A.S., NIT 900.000.001-1, con domicilio en Bogotá, representada por X, y PERIFERIA IT GROUP S.A.S.\nPRIMERA. OBJETO. Soporte.\n"
  test("moneda desconocida", async () => {
    const ctx = conAdjunto(base + "SEGUNDA. VALOR. EUR 1.000.\nTERCERA. PLAZO. desde el uno (1) de enero de 2026 hasta el uno (1) de enero de 2027.")
    const r = json(await contratos.extraer.execute({ mensaje_id: "msg-900" }, ctx))
    expect(r).toEqual({ ok: false, error: expect.stringContaining("moneda desconocida: EUR") })
  })
  test("fecha inválida", async () => {
    const ctx = conAdjunto(base + "SEGUNDA. VALOR. COP 1.000.\nTERCERA. PLAZO. desde el (31) de febrero de 2026 hasta el (1) de enero de 2027.")
    const r = json(await contratos.extraer.execute({ mensaje_id: "msg-900" }, ctx))
    expect(r.error).toContain("fecha inválida")
  })
  test("texto vacío", async () => {
    const ctx = conAdjunto("   ")
    const r = json(await contratos.extraer.execute({ mensaje_id: "msg-900" }, ctx))
    expect(r.ok).toBe(false)
  })
  test("alertas con fecha inválida", async () => {
    const r = json(await contratos.alertas.execute({ hoy: "2026-02-31" }, entorno()))
    expect(r.error).toContain("fecha inválida")
  })
})
