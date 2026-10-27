// Herramientas del agente "Registro de Contratos Vigentes".
// Cada export es una herramienta: el modelo la ve como contratos_<export>.
// Solo dependen de zod y node:fs/path, para poder importarlas desde demo.ts,
// desde el servidor o desde modulo/ sin arrastrar el backend.
// Regla de oro: execute() NUNCA lanza; siempre devuelve JSON { ok, data } | { ok, error }.

import { z } from "zod"
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync,
  readFileSync, readdirSync, writeFileSync,
} from "node:fs"
import { dirname, extname, join } from "node:path"

// ───────────────────────── Parámetros de negocio ─────────────────────────
// Documentados en src/knowledge/registro-contratos.md (sección "Parámetros").
const PARAMETROS = {
  umbralConfianza: 0.8,
  diasAlerta: 60,
  fechaCorte: "2026-05-30",
  similitudObjeto: 0.9,
  monedas: ["COP", "USD", "PEN", "PAB", "HNL"],
  monedaPorPais: { CO: "COP", EC: "USD", PE: "PEN", PA: "USD", HN: "HNL" } as Record<string, string>,
} as const

const RUTAS = {
  fixtures: "fixtures/reto-02",
  buzon: "fixtures/reto-02/buzon",
  maestroFixture: "fixtures/reto-02/maestro-contratos.csv",
  comerciales: "fixtures/reto-02/comerciales.json",
  out: "out",
  sharepoint: "out/sharepoint",
  maestro: "out/sharepoint/maestro-contratos.csv",
  historial: "out/sharepoint/historial.jsonl",
  procesados: "out/procesados.json",
  log: "out/log.jsonl",
  alertas: "out/alertas.md",
} as const

const COLUMNAS = [
  "id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda",
  "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza", "estado_poliza",
  "comercial", "ruta_sharepoint", "fecha_registro", "fuente",
] as const

/** Campos que salen del documento y llevan confianza. */
const CAMPOS = [
  "id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda",
  "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza",
] as const

// ───────────────────────────── Tipos ─────────────────────────────
type Ctx = { directory: string; sessionId: string }
type Columna = (typeof COLUMNAS)[number]
type Campo = (typeof CAMPOS)[number]
type Fila = Record<Columna, string>
type Confianza = Record<Campo, number>
type TipoDocumento = "contrato" | "contrato_marco" | "otrosi" | "cotizacion" | "desconocido"
type Clasificacion = "nuevo" | "actualizacion" | "duplicado" | "rechazado"

interface Contrato {
  id_contrato: string | null
  cliente: string | null
  nit_cliente: string | null
  pais: string | null
  objeto: string | null
  valor: number | null
  moneda: string | null
  fecha_inicio: string | null
  fecha_fin: string | null
  requiere_poliza: boolean | null
  tipo_poliza: string | null
  valor_indeterminado: boolean
}

interface Extraccion {
  mensaje_id: string
  tipo_documento: TipoDocumento
  adjunto: string
  contrato: Contrato
  confianza: Confianza
  polizas_requieren_ampliacion: boolean
  notas: string[]
}

interface Diferencia { campo: string; maestro: string; documento: string }

interface Validacion {
  mensaje_id: string
  clasificacion: Clasificacion
  motivo?: string
  id_contrato_existente?: string
  requiere_revision: string[]
  diferencias?: Diferencia[]
  contrato?: Contrato
  confianza?: Confianza
  comercial: { email: string; nombre: string | null; registrado: boolean }
  avisos: string[]
}

class ErrorNegocio extends Error {}

// ─────────────────────────── Esquemas zod ───────────────────────────
const IdMensaje = z.string().regex(/^[A-Za-z0-9_-]+$/, "id de mensaje inválido")
  .describe("Identificador del mensaje del buzón, p. ej. msg-001")
const Fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "formato esperado YYYY-MM-DD")

const CorreoSchema = z.object({
  id: z.string(), de: z.string(), para: z.string(), asunto: z.string(),
  fecha: z.string(), cuerpo: z.string(), adjuntos: z.array(z.string()),
})
type Correo = z.infer<typeof CorreoSchema>

const ComercialSchema = z.object({ email: z.string(), nombre: z.string(), region: z.string() })

const ContratoArg = z.object({
  id_contrato: z.string().nullable().optional().describe("Número del contrato tal como aparece en el documento"),
  cliente: z.string().nullable().optional().describe("Razón social de la contraparte"),
  nit_cliente: z.string().nullable().optional().describe("Identificador tributario sin DV ni puntos"),
  pais: z.enum(["CO", "EC", "PE", "PA", "HN"]).nullable().optional().describe("País de la contraparte"),
  objeto: z.string().nullable().optional().describe("Objeto del contrato, máx. 200 caracteres"),
  valor: z.number().nullable().optional().describe("Valor sin separadores; 0 si es por demanda"),
  moneda: z.enum(["COP", "USD", "PEN", "PAB", "HNL"]).nullable().optional().describe("Moneda del valor"),
  fecha_inicio: Fecha.nullable().optional().describe("Fecha de inicio YYYY-MM-DD"),
  fecha_fin: Fecha.nullable().optional().describe("Fecha de fin YYYY-MM-DD"),
  requiere_poliza: z.boolean().nullable().optional().describe("true si el contrato exige póliza"),
  tipo_poliza: z.string().nullable().optional().describe("Tipos de póliza separados por ;"),
}).describe("Valores de data.contrato devueltos por contratos_extraer. Solo cambia un valor si el usuario lo confirmó explícitamente.")
type ContratoPropuesto = z.infer<typeof ContratoArg>

// ─────────────────────────── Utilidades base ───────────────────────────
const ok = <T>(data: T): string => JSON.stringify({ ok: true, data })
const fallo = (error: string): string => JSON.stringify({ ok: false, error })

function ruta(ctx: Ctx, relativa: string): string {
  return join(ctx.directory, relativa)
}

function leerTexto(ctx: Ctx, relativa: string): string {
  return readFileSync(ruta(ctx, relativa), "utf-8")
}

function escribirTexto(ctx: Ctx, relativa: string, contenido: string): void {
  const destino = ruta(ctx, relativa)
  mkdirSync(dirname(destino), { recursive: true })
  writeFileSync(destino, contenido, "utf-8")
}

function agregarLinea(ctx: Ctx, relativa: string, objeto: object): void {
  const destino = ruta(ctx, relativa)
  mkdirSync(dirname(destino), { recursive: true })
  appendFileSync(destino, JSON.stringify(objeto) + "\n", "utf-8")
}

function mensajeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Normaliza para comparar: minúsculas, sin tildes, espacios simples. */
function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/\s+/g, " ").trim()
}

function slug(texto: string): string {
  return normalizar(texto)
    .replace(/\b(s\.?a\.?s\.?|s\.?a\.?c\.?|s\.?a\.?|s\. de r\.l\.|ltda\.?)$/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

/** Similitud de Sørensen–Dice sobre bigramas de caracteres (0..1). */
function similitud(a: string, b: string): number {
  const bigramas = (s: string): string[] => {
    const t = normalizar(s).replace(/[^a-z0-9 ]/g, "")
    return Array.from({ length: Math.max(t.length - 1, 0) }, (_, i) => t.slice(i, i + 2))
  }
  const x = bigramas(a)
  const y = bigramas(b)
  if (x.length === 0 || y.length === 0) return 0
  const conteo = new Map<string, number>()
  x.forEach((g) => conteo.set(g, (conteo.get(g) ?? 0) + 1))
  let comunes = 0
  y.forEach((g) => {
    const n = conteo.get(g) ?? 0
    if (n > 0) { comunes++; conteo.set(g, n - 1) }
  })
  return (2 * comunes) / (x.length + y.length)
}

// ─────────────────────────── Fechas ───────────────────────────
const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
}

function isoDesde(anio: number, mes: number, dia: number): string {
  const d = new Date(Date.UTC(anio, mes - 1, dia))
  if (d.getUTCFullYear() !== anio || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) {
    throw new ErrorNegocio(`fecha inválida: ${dia}/${mes}/${anio}`)
  }
  return d.toISOString().slice(0, 10)
}

function mesNumero(nombre: string): number {
  const mes = MESES[normalizar(nombre)]
  if (mes === undefined) throw new ErrorNegocio(`fecha inválida: mes "${nombre}" no reconocido`)
  return mes
}

/** Fin de un plazo en meses: inicio + n meses − 1 día (convención del maestro). */
function sumarMeses(inicioIso: string, meses: number): string {
  const [a, m, d] = inicioIso.split("-").map(Number)
  const fin = new Date(Date.UTC(a, m - 1 + meses, d - 1))
  return fin.toISOString().slice(0, 10)
}

function diasEntre(desdeIso: string, hastaIso: string): number {
  return Math.round((Date.parse(hastaIso) - Date.parse(desdeIso)) / 86_400_000)
}

function esFechaValida(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false
  const [a, m, d] = iso.split("-").map(Number)
  try { isoDesde(a, m, d); return true } catch { return false }
}

// ─────────────────────────── CSV (RFC 4180 simple) ───────────────────────────
function parsearCsv(texto: string): string[][] {
  const filas: string[][] = []
  let fila: string[] = []
  let campo = ""
  let comillas = false
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]
    if (comillas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++ }
      else if (c === '"') comillas = false
      else campo += c
    } else if (c === '"') comillas = true
    else if (c === ",") { fila.push(campo); campo = "" }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && texto[i + 1] === "\n") i++
      fila.push(campo); campo = ""
      if (fila.some((v) => v !== "")) filas.push(fila)
      fila = []
    } else campo += c
  }
  fila.push(campo)
  if (fila.some((v) => v !== "")) filas.push(fila)
  return filas
}

function celdaCsv(valor: string): string {
  return /[",\n\r]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor
}

// ─────────────────────────── Persistencia (out/) ───────────────────────────
/** RN6: el fixture es de solo lectura; la primera ejecución lo copia a out/sharepoint/. */
function asegurarMaestro(ctx: Ctx): void {
  if (existsSync(ruta(ctx, RUTAS.maestro))) return
  mkdirSync(ruta(ctx, RUTAS.sharepoint), { recursive: true })
  copyFileSync(ruta(ctx, RUTAS.maestroFixture), ruta(ctx, RUTAS.maestro))
}

function leerMaestro(ctx: Ctx): Fila[] {
  asegurarMaestro(ctx)
  const [encabezado, ...filas] = parsearCsv(leerTexto(ctx, RUTAS.maestro))
  const faltantes = COLUMNAS.filter((c) => !encabezado.includes(c))
  if (faltantes.length > 0) throw new ErrorNegocio(`maestro sin columnas: ${faltantes.join(", ")}`)
  return filas.map((valores) => {
    const fila = {} as Fila
    COLUMNAS.forEach((col) => { fila[col] = valores[encabezado.indexOf(col)] ?? "" })
    return fila
  })
}

function guardarMaestro(ctx: Ctx, filas: Fila[]): void {
  const lineas = [COLUMNAS.join(","), ...filas.map((f) => COLUMNAS.map((c) => celdaCsv(f[c])).join(","))]
  escribirTexto(ctx, RUTAS.maestro, lineas.join("\n") + "\n")
}

interface Procesado { mensaje_id: string; accion: string; id_contrato: string | null; ts: string }

function leerProcesados(ctx: Ctx): Procesado[] {
  if (!existsSync(ruta(ctx, RUTAS.procesados))) return []
  const datos: unknown = JSON.parse(leerTexto(ctx, RUTAS.procesados))
  return Array.isArray(datos) ? (datos as Procesado[]) : []
}

function marcarProcesado(ctx: Ctx, mensajeId: string, accion: string, idContrato: string | null): void {
  const lista = leerProcesados(ctx).filter((p) => p.mensaje_id !== mensajeId)
  lista.push({ mensaje_id: mensajeId, accion, id_contrato: idContrato, ts: new Date().toISOString() })
  escribirTexto(ctx, RUTAS.procesados, JSON.stringify(lista, null, 2))
}

function leerHistorial(ctx: Ctx): Array<{ id_contrato: string; accion: string; mensaje_id: string; ts: string }> {
  if (!existsSync(ruta(ctx, RUTAS.historial))) return []
  return leerTexto(ctx, RUTAS.historial).split("\n").filter(Boolean).map((l) => JSON.parse(l))
}

/** RN7: toda ejecución deja rastro en out/log.jsonl. */
function registrarLog(ctx: Ctx, herramienta: string, mensajeId: string | null, salida: string): void {
  try {
    const r = JSON.parse(salida) as { ok: boolean; error?: string; data?: { resumen?: string } }
    const resumen = r.ok ? (r.data?.resumen ?? "ok") : (r.error ?? "error")
    agregarLinea(ctx, RUTAS.log, {
      ts: new Date().toISOString(), herramienta, mensaje_id: mensajeId,
      ok: r.ok, resumen, sesion: ctx.sessionId,
    })
  } catch { /* el log nunca debe tumbar la herramienta */ }
}

/** Envoltorio común: valida, ejecuta, nunca lanza y siempre deja log. */
async function ejecutarSeguro(
  ctx: Ctx, herramienta: string, mensajeId: string | null, fn: () => string,
): Promise<string> {
  let salida: string
  try { salida = fn() } catch (e) {
    salida = fallo(e instanceof ErrorNegocio ? mensajeError(e) : `error interno: ${mensajeError(e)}`)
  }
  registrarLog(ctx, herramienta, mensajeId, salida)
  return salida
}

// ─────────────────────────── Buzón ───────────────────────────
function leerCorreo(ctx: Ctx, mensajeId: string): Correo {
  const archivo = `${RUTAS.buzon}/${mensajeId}/correo.json`
  if (!existsSync(ruta(ctx, archivo))) throw new ErrorNegocio(`no existe el mensaje ${mensajeId} en el buzón`)
  const parse = CorreoSchema.safeParse(JSON.parse(leerTexto(ctx, archivo)))
  if (!parse.success) throw new ErrorNegocio(`correo.json de ${mensajeId} no tiene el formato esperado`)
  return parse.data
}

function detectarTipo(texto: string): TipoDocumento {
  const primera = normalizar(texto.split("\n").find((l) => l.trim() !== "") ?? "")
  if (primera.startsWith("otrosi")) return "otrosi"
  if (primera.startsWith("contrato marco")) return "contrato_marco"
  if (primera.startsWith("contrato")) return "contrato"
  if (primera.startsWith("cotizacion")) return "cotizacion"
  return "desconocido"
}

interface Adjunto { nombre: string; texto: string; tipo: TipoDocumento }

function leerAdjuntos(ctx: Ctx, correo: Correo): Adjunto[] {
  return correo.adjuntos.map((nombre) => {
    const rel = `${RUTAS.buzon}/${correo.id}/${nombre}`
    if (extname(nombre).toLowerCase() !== ".txt" || !existsSync(ruta(ctx, rel))) {
      return { nombre, texto: "", tipo: "desconocido" as TipoDocumento }
    }
    const texto = leerTexto(ctx, rel)
    return { nombre, texto, tipo: detectarTipo(texto) }
  })
}

const TIPOS_CONTRATO: TipoDocumento[] = ["contrato", "contrato_marco", "otrosi"]

function adjuntoContrato(adjuntos: Adjunto[]): Adjunto | null {
  return adjuntos.find((a) => TIPOS_CONTRATO.includes(a.tipo)) ?? null
}

function motivoSinContrato(adjuntos: Adjunto[]): string {
  if (adjuntos.length === 0) return "el correo no trae adjuntos"
  const descr = adjuntos.map((a) => `${a.nombre} (${a.tipo === "desconocido" ? "no reconocido como contrato" : a.tipo})`)
  return `sin adjunto de contrato: ${descr.join(", ")}`
}

// ─────────────────────────── Extracción determinista ───────────────────────────
function lineaCon(texto: string, patron: RegExp): string | null {
  return texto.split("\n").find((l) => patron.test(l)) ?? null
}

function extraerId(texto: string): { valor: string | null; conf: number } {
  const encabezado = texto.split("\n")[0] ?? ""
  const m = encabezado.match(/No\.\s*([A-Z]{2,5}-\d{4}-\d{1,4})/)
  return m ? { valor: m[1], conf: 0.95 } : { valor: null, conf: 0 }
}

const CIUDADES: Record<string, string[]> = {
  CO: ["colombia", "bogota", "medellin", "barranquilla", "cali", "cartagena", "bucaramanga", "pereira"],
  EC: ["ecuador", "quito", "guayaquil", "cuenca"],
  PE: ["peru", "lima", "arequipa"],
  PA: ["panama"],
  HN: ["honduras", "tegucigalpa", "san pedro sula"],
}

function paisPorIdentificador(tipo: string, digitos: string): string | null {
  const t = tipo.toUpperCase()
  if (t === "NIT") return "CO"
  if (t === "RTN") return "HN"
  if (t === "RUC" && digitos.length === 13) return "EC"
  if (t === "RUC" && digitos.length === 11) return "PE"
  if (t === "RUC") return "PA"
  return null
}

function paisPorDomicilio(domicilio: string | null): string | null {
  if (!domicilio) return null
  const d = normalizar(domicilio)
  const hallado = Object.entries(CIUDADES).find(([, lista]) => lista.some((c) => d.includes(c)))
  return hallado ? hallado[0] : null
}

/** Busca el nombre en la línea de firmas para conservar mayúsculas/minúsculas reales. */
function nombreFormal(nombreMayus: string, texto: string): { nombre: string; conf: number } {
  const objetivo = normalizar(nombreMayus)
  for (const linea of texto.split("\n")) {
    const parte = linea.split(/\s{2,}/).find((p) => normalizar(p) === objetivo)
    if (parte) return { nombre: parte.trim(), conf: 0.95 }
  }
  const titulo = nombreMayus.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_, s: string, l: string) => s + l.toUpperCase())
  return { nombre: titulo, conf: 0.85 }
}

interface Contratante {
  cliente: string | null; confCliente: number
  nit: string | null; confNit: number
  pais: string | null; confPais: number
}

function extraerContratante(texto: string, notas: string[]): Contratante {
  const vacio: Contratante = { cliente: null, confCliente: 0, nit: null, confNit: 0, pais: null, confPais: 0 }
  const segmento = texto.match(/Entre\s+([\s\S]*?)\by\s+PERIFERIA IT GROUP/i)?.[1]
  if (!segmento) { notas.push("no se identificó la sección de partes (Entre … y PERIFERIA)"); return vacio }

  const nombre = segmento.match(/^(?:los suscritos,\s*)?([^,]+),/i)?.[1]?.trim() ?? null
  const ident = segmento.match(/\b(NIT|RUC|RTN)\s*(?:No\.?\s*)?([\d][\d.\- ]*\d)/i)
  const domicilio = segmento.match(/domicilio en (.+?),\s*representad/i)?.[1] ?? null

  const formal = nombre ? nombreFormal(nombre, texto) : null
  let nit: string | null = null
  let paisId: string | null = null
  if (ident) {
    const sinDv = ident[1].toUpperCase() === "NIT" ? ident[2].split("-")[0] : ident[2]
    nit = sinDv.replace(/\D/g, "")
    paisId = paisPorIdentificador(ident[1], nit)
  }
  const paisDom = paisPorDomicilio(domicilio)
  const pais = paisId ?? paisDom
  const confPais = paisId && paisDom ? (paisId === paisDom ? 0.95 : 0.5) : pais ? 0.85 : 0
  if (paisId && paisDom && paisId !== paisDom) notas.push(`país inconsistente: identificador sugiere ${paisId}, domicilio sugiere ${paisDom}`)

  return {
    cliente: formal?.nombre ?? null, confCliente: formal?.conf ?? 0,
    nit, confNit: nit ? 0.95 : 0,
    pais, confPais,
  }
}

function extraerObjeto(texto: string): { valor: string | null; conf: number } {
  const crudo = lineaCon(texto, /\bOBJETO\./)?.match(/OBJETO\.\s*(.+)$/)?.[1]
  if (!crudo) return { valor: null, conf: 0 }
  let objeto = crudo
    .replace(/^EL CONTRATISTA\s+(se obliga a\s+(ejecutar\s+)?|prestar[aá]\s+)/i, "")
    .replace(/^(el|la|los|las)\s+/i, "")
    .replace(/\.\s*$/, "").trim()
  objeto = objeto.charAt(0).toUpperCase() + objeto.slice(1)
  if (objeto.length <= 200) return { valor: objeto, conf: 0.9 }
  const corte = objeto.slice(0, 199).replace(/\s+\S*$/, "")
  return { valor: `${corte}…`, conf: 0.8 }
}

function parsearNumero(texto: string): number {
  const decimal = texto.match(/^(.*)[.,](\d{1,2})$/)
  const numero = decimal
    ? Number(`${decimal[1].replace(/[.,\s]/g, "")}.${decimal[2]}`)
    : Number(texto.replace(/[.,\s]/g, ""))
  if (!Number.isFinite(numero)) throw new ErrorNegocio(`valor numérico ilegible: "${texto}"`)
  return numero
}

const PALABRA_MONEDA: Record<string, RegExp> = {
  COP: /pesos/i, USD: /d[oó]lares/i, PEN: /soles/i, PAB: /balboas/i, HNL: /lempiras/i,
}

interface ValorExtraido {
  valor: number | null; confValor: number
  moneda: string | null; confMoneda: number
  indeterminado: boolean
}

function extraerValor(texto: string, notas: string[]): ValorExtraido {
  const linea = lineaCon(texto, /\bVALOR\b/)
  if (!linea) return { valor: null, confValor: 0, moneda: null, confMoneda: 0, indeterminado: false }

  if (/no tiene (un )?valor determinado|valor indeterminado|por demanda|[oó]rdenes? de servicio/i.test(linea)) {
    notas.push("valor por demanda: se registra 0 con valor_indeterminado = true (requiere confirmación)")
    return { valor: 0, confValor: 0.5, moneda: null, confMoneda: 0, indeterminado: true }
  }
  const m = linea.match(/\b([A-Z]{3})\s*\$?\s*(\d[\d.,]*\d)/)
  if (!m) {
    notas.push("no se encontró un valor con código de moneda en la cláusula de valor")
    return { valor: null, confValor: 0, moneda: null, confMoneda: 0, indeterminado: false }
  }
  const moneda = m[1]
  if (!(PARAMETROS.monedas as readonly string[]).includes(moneda)) {
    throw new ErrorNegocio(`moneda desconocida: ${moneda} (permitidas: ${PARAMETROS.monedas.join(", ")})`)
  }
  const coincideEnLetras = PALABRA_MONEDA[moneda]?.test(linea) ?? false
  if (!coincideEnLetras) notas.push(`la moneda ${moneda} no se confirma con el valor en letras`)
  const conf = coincideEnLetras ? 0.95 : 0.85
  return { valor: parsearNumero(m[2]), confValor: conf, moneda, confMoneda: conf, indeterminado: false }
}

const PATRON_FECHA = /\(\s*(\d{1,2})\s*\)\s*de\s+([a-záéíóú]+)\s+de\s+(\d{4})/gi

function fechasEn(linea: string): string[] {
  return Array.from(linea.matchAll(PATRON_FECHA)).map((m) => isoDesde(Number(m[3]), mesNumero(m[2]), Number(m[1])))
}

function fechaFirma(texto: string): { fecha: string; diaConocido: boolean } | null {
  const linea = lineaCon(texto, /se firma/i)
  if (!linea) return null
  const completa = linea.match(/\(\s*(\d{1,2})\s*\)\s*d[ií]as del mes de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i)
  if (completa) return { fecha: isoDesde(Number(completa[3]), mesNumero(completa[2]), Number(completa[1])), diaConocido: true }
  const soloMes = linea.match(/mes de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i)
  if (soloMes) return { fecha: isoDesde(Number(soloMes[2]), mesNumero(soloMes[1]), 1), diaConocido: false }
  return null
}

interface Plazo { inicio: string | null; confInicio: number; fin: string | null; confFin: number }

function extraerPlazo(texto: string, tipo: TipoDocumento, notas: string[]): Plazo {
  const linea = lineaCon(texto, /\bPLAZO\b/)
  if (!linea) return { inicio: null, confInicio: 0, fin: null, confFin: 0 }
  const fechas = fechasEn(linea)
  const meses = Number(linea.match(/\(\s*(\d{1,3})\s*\)\s*mes(es)?/i)?.[1] ?? NaN)
  const prorrogable = /prorrogab|pr[oó]rroga autom/i.test(linea)

  if (tipo === "otrosi") {
    const fin = fechas[fechas.length - 1] ?? null
    return { inicio: null, confInicio: 0, fin, confFin: fin ? 0.9 : 0 }
  }
  if (fechas.length >= 2) {
    const [inicio, fin] = fechas
    const coherente = Number.isNaN(meses) || sumarMeses(inicio, meses) === fin
    if (!coherente) notas.push(`el plazo en meses (${meses}) no coincide exactamente con las fechas`)
    return { inicio, confInicio: 0.95, fin, confFin: coherente ? 0.95 : 0.85 }
  }
  return plazoDerivado(texto, fechas[0] ?? null, meses, prorrogable, notas)
}

function plazoDerivado(
  texto: string, fechaExplicita: string | null, meses: number, prorrogable: boolean, notas: string[],
): Plazo {
  const firma = fechaFirma(texto)
  const inicio = fechaExplicita ?? firma?.fecha ?? null
  let confInicio = fechaExplicita ? 0.9 : firma?.diaConocido ? 0.85 : firma ? 0.8 : 0
  if (firma && !firma.diaConocido && !fechaExplicita) {
    notas.push(`inicio = fecha de firma; el documento solo indica el mes, se asume el día 1 (${firma.fecha})`)
  }
  if (!inicio || Number.isNaN(meses)) {
    notas.push("no fue posible determinar el plazo")
    return { inicio, confInicio, fin: null, confFin: 0 }
  }
  const fin = sumarMeses(inicio, meses)
  notas.push(`fecha_fin derivada: ${meses} meses desde ${inicio}${prorrogable ? "; el contrato es prorrogable automáticamente" : ""}`)
  if (!firma?.diaConocido && !fechaExplicita) confInicio = Math.min(confInicio, 0.8)
  const confFin = fechaExplicita ? 0.85 : prorrogable || !firma?.diaConocido ? 0.5 : 0.8
  return { inicio, confInicio, fin, confFin }
}

const TIPOS_POLIZA: Array<[RegExp, string]> = [
  [/cumplimiento/i, "cumplimiento"],
  [/calidad/i, "calidad"],
  [/salarios|prestaciones sociales/i, "salarios_prestaciones"],
  [/responsabilidad civil/i, "responsabilidad_civil"],
  [/estabilidad/i, "estabilidad"],
  [/anticipo/i, "anticipo"],
]

interface Poliza { requiere: boolean | null; tipo: string | null; conf: number; ampliar: boolean }

function extraerPoliza(texto: string, tipo: TipoDocumento, notas: string[]): Poliza {
  const lineas = texto.split("\n").filter((l) => /p[oó]liza|GARANT[IÍ]AS?|garant[ií]as/i.test(l))
  if (tipo === "otrosi") {
    const ampliar = lineas.some((l) => /ampliar|prorrogar|extender/i.test(l))
    if (ampliar) notas.push("el otrosí exige ampliar la vigencia de las pólizas → estado_poliza pasa a pendiente")
    return { requiere: null, tipo: null, conf: 0, ampliar }
  }
  if (lineas.length === 0) {
    notas.push("sin cláusula de garantías: requiere_poliza = false")
    return { requiere: false, tipo: "", conf: 0.85, ampliar: false }
  }
  const clausula = lineas.join(" ")
  const tipos = TIPOS_POLIZA.filter(([re]) => re.test(clausula)).map(([, t]) => t)
  const condicional = /para cada orden|cuyo valor supere|en caso de que|siempre que/i.test(clausula)
  if (condicional) notas.push("la póliza es condicional (por orden de servicio); se registra requiere_poliza = true")
  return { requiere: true, tipo: tipos.join(";"), conf: condicional ? 0.8 : tipos.length ? 0.95 : 0.7, ampliar: false }
}

function extraerDeTexto(mensajeId: string, adjunto: Adjunto): Extraccion {
  if (adjunto.texto.trim() === "") throw new ErrorNegocio(`el adjunto ${adjunto.nombre} está vacío`)
  const notas: string[] = []
  const id = extraerId(adjunto.texto)
  const partes = extraerContratante(adjunto.texto, notas)
  const objeto = extraerObjeto(adjunto.texto)
  const valor = extraerValor(adjunto.texto, notas)
  const plazo = extraerPlazo(adjunto.texto, adjunto.tipo, notas)
  const poliza = extraerPoliza(adjunto.texto, adjunto.tipo, notas)

  let moneda = valor.moneda
  let confMoneda = valor.confMoneda
  if (!moneda && valor.indeterminado && partes.pais) {
    moneda = PARAMETROS.monedaPorPais[partes.pais] ?? null
    confMoneda = moneda ? 0.8 : 0
    if (moneda) notas.push(`moneda inferida del país del cliente (${partes.pais} → ${moneda})`)
  }
  if (!id.valor) notas.push("el documento no trae número de contrato; se asignará AUTO-<año>-<secuencia>")

  return {
    mensaje_id: mensajeId,
    tipo_documento: adjunto.tipo,
    adjunto: adjunto.nombre,
    contrato: {
      id_contrato: id.valor, cliente: partes.cliente, nit_cliente: partes.nit, pais: partes.pais,
      objeto: objeto.valor, valor: valor.valor, moneda,
      fecha_inicio: plazo.inicio, fecha_fin: plazo.fin,
      requiere_poliza: poliza.requiere, tipo_poliza: poliza.tipo,
      valor_indeterminado: valor.indeterminado,
    },
    confianza: {
      id_contrato: id.conf, cliente: partes.confCliente, nit_cliente: partes.confNit, pais: partes.confPais,
      objeto: objeto.conf, valor: valor.confValor, moneda: confMoneda,
      fecha_inicio: plazo.confInicio, fecha_fin: plazo.confFin,
      requiere_poliza: poliza.conf, tipo_poliza: poliza.conf,
    },
    polizas_requieren_ampliacion: poliza.ampliar,
    notas,
  }
}

function extraerMensaje(ctx: Ctx, mensajeId: string): Extraccion {
  const correo = leerCorreo(ctx, mensajeId)
  const adjunto = adjuntoContrato(leerAdjuntos(ctx, correo))
  if (!adjunto) throw new ErrorNegocio(`${mensajeId}: ${motivoSinContrato(leerAdjuntos(ctx, correo))}`)
  return extraerDeTexto(mensajeId, adjunto)
}

// ─────────────────────────── Validación (RN1–RN5) ───────────────────────────
function resolverComercial(ctx: Ctx, email: string): Validacion["comercial"] {
  const lista = z.array(ComercialSchema).parse(JSON.parse(leerTexto(ctx, RUTAS.comerciales)))
  const hallado = lista.find((c) => c.email.toLowerCase() === email.toLowerCase())
  return { email, nombre: hallado?.nombre ?? null, registrado: Boolean(hallado) }
}

function comoTexto(v: string | number | boolean | null | undefined): string {
  return v === null || v === undefined ? "" : String(v)
}

/** Aplica valores propuestos por el agente; un valor distinto al extraído pierde su confianza. */
function aplicarPropuesta(ext: Extraccion, propuesto: ContratoPropuesto | undefined): { contrato: Contrato; confianza: Confianza; modificados: Campo[] } {
  const contrato: Contrato = { ...ext.contrato }
  const confianza: Confianza = { ...ext.confianza }
  const modificados: Campo[] = []
  if (!propuesto) return { contrato, confianza, modificados }
  for (const campo of CAMPOS) {
    const nuevo = propuesto[campo]
    if (nuevo === undefined || comoTexto(nuevo) === comoTexto(ext.contrato[campo])) continue
    Object.assign(contrato, { [campo]: nuevo })
    confianza[campo] = 0
    modificados.push(campo)
  }
  return { contrato, confianza, modificados }
}

function camposEnRevision(ext: Extraccion, confianza: Confianza, modificados: Campo[]): string[] {
  const relevantes = CAMPOS.filter((c) => {
    if (c === "id_contrato" && ext.contrato.id_contrato === null) return false
    if (ext.tipo_documento === "otrosi") return ext.contrato[c] !== null || modificados.includes(c)
    return true
  })
  return relevantes.filter((c) => confianza[c] < PARAMETROS.umbralConfianza)
}

function compararConMaestro(fila: Fila, contrato: Contrato): Diferencia[] {
  return CAMPOS.filter((c) => contrato[c] !== null && c !== "id_contrato")
    .filter((c) => comoTexto(contrato[c]) !== fila[c])
    .map((c) => ({ campo: c, maestro: fila[c], documento: comoTexto(contrato[c]) }))
}

function buscarExistente(maestro: Fila[], contrato: Contrato): { fila: Fila; criterio: string } | null {
  const porId = contrato.id_contrato ? maestro.find((f) => f.id_contrato === contrato.id_contrato) : undefined
  if (porId) return { fila: porId, criterio: "id_contrato" }
  if (!contrato.nit_cliente || !contrato.objeto) return null
  const objeto = contrato.objeto
  const porNit = maestro.find((f) => f.nit_cliente === contrato.nit_cliente
    && similitud(f.objeto, objeto) >= PARAMETROS.similitudObjeto)
  return porNit ? { fila: porNit, criterio: "nit_cliente + objeto similar" } : null
}

function rechazo(mensajeId: string, motivo: string, comercial: Validacion["comercial"], avisos: string[]): Validacion {
  return { mensaje_id: mensajeId, clasificacion: "rechazado", motivo, requiere_revision: [], comercial, avisos }
}

function validarInterno(ctx: Ctx, mensajeId: string, propuesto?: ContratoPropuesto): Validacion {
  const correo = leerCorreo(ctx, mensajeId)
  const comercial = resolverComercial(ctx, correo.de)
  const avisos = comercial.registrado ? [] : [`remitente no registrado en comerciales.json: ${correo.de} (no bloquea)`]
  const adjuntos = leerAdjuntos(ctx, correo)
  const adjunto = adjuntoContrato(adjuntos)
  if (!adjunto) return rechazo(mensajeId, motivoSinContrato(adjuntos), comercial, avisos)

  const ext = extraerDeTexto(mensajeId, adjunto)
  if (!ext.contrato.cliente || (!ext.contrato.objeto && ext.tipo_documento !== "otrosi")) {
    return rechazo(mensajeId, "el texto no contiene partes u objeto identificables", comercial, avisos)
  }
  const { contrato, confianza, modificados } = aplicarPropuesta(ext, propuesto)
  if (modificados.length) avisos.push(`campos distintos a la extracción (requieren confirmación humana): ${modificados.join(", ")}`)
  avisos.push(...ext.notas)
  const revision = camposEnRevision(ext, confianza, modificados)
  const existente = buscarExistente(leerMaestro(ctx), contrato)
  const base = { mensaje_id: mensajeId, contrato, confianza, comercial, avisos }

  if (ext.tipo_documento === "otrosi") {
    if (!existente) return rechazo(mensajeId, `otrosí del contrato ${contrato.id_contrato ?? "(sin número)"} que no existe en el maestro`, comercial, avisos)
    const diferencias = compararConMaestro(existente.fila, contrato)
    return { ...base, clasificacion: "actualizacion", id_contrato_existente: existente.fila.id_contrato, requiere_revision: revision, diferencias }
  }
  if (!existente) return { ...base, clasificacion: "nuevo", requiere_revision: revision }

  const diferencias = compararConMaestro(existente.fila, contrato)
  const clave = ["valor", "fecha_inicio", "fecha_fin"]
  const mismaClave = clave.every((c) => !diferencias.some((d) => d.campo === c))
  if (mismaClave && existente.criterio === "id_contrato") {
    return { ...base, clasificacion: "duplicado", id_contrato_existente: existente.fila.id_contrato, requiere_revision: [], diferencias }
  }
  // Mismo contrato con datos distintos y SIN otrosí: es un conflicto → revisión humana.
  const conflictos = diferencias.map((d) => `conflicto:${d.campo}`)
  return {
    ...base, clasificacion: "actualizacion", id_contrato_existente: existente.fila.id_contrato,
    requiere_revision: [...revision, ...conflictos], diferencias,
  }
}

// ─────────────────────────── Registro y archivo ───────────────────────────
function siguienteAuto(maestro: Fila[], anio: string): string {
  const usados = maestro.map((f) => f.id_contrato.match(new RegExp(`^AUTO-${anio}-(\\d+)$`))?.[1])
    .filter((n): n is string => Boolean(n)).map(Number)
  return `AUTO-${anio}-${String(Math.max(0, ...usados) + 1).padStart(3, "0")}`
}

function archivar(ctx: Ctx, mensajeId: string, adjunto: string, anio: string, cliente: string, nombre: string): string {
  const relativa = `Contratos/${anio}/${slug(cliente)}/${nombre}${extname(adjunto) || ".txt"}`
  const destino = ruta(ctx, `${RUTAS.sharepoint}/${relativa}`)
  mkdirSync(dirname(destino), { recursive: true })
  copyFileSync(ruta(ctx, `${RUTAS.buzon}/${mensajeId}/${adjunto}`), destino)
  return relativa
}

function adjuntoDe(ctx: Ctx, mensajeId: string): string {
  const adjunto = adjuntoContrato(leerAdjuntos(ctx, leerCorreo(ctx, mensajeId)))
  if (!adjunto) throw new ErrorNegocio(`${mensajeId}: sin adjunto de contrato`)
  return adjunto.nombre
}

interface Registro { mensaje_id: string; id_contrato: string | null; accion: string; ruta_archivo: string | null; resumen: string }

function registrarNuevo(ctx: Ctx, v: Validacion, fechaRegistro: string, confirmado: boolean): Registro {
  const c = v.contrato as Contrato
  const maestro = leerMaestro(ctx)
  const anio = (c.fecha_inicio ?? fechaRegistro).slice(0, 4)
  const id = c.id_contrato ?? siguienteAuto(maestro, anio)
  if (maestro.some((f) => f.id_contrato === id)) throw new ErrorNegocio(`el id ${id} ya existe en el maestro`)
  const rutaArchivo = archivar(ctx, v.mensaje_id, adjuntoDe(ctx, v.mensaje_id), anio, c.cliente ?? "sin-cliente", id)
  const fila: Fila = {
    id_contrato: id, cliente: c.cliente ?? "", nit_cliente: c.nit_cliente ?? "", pais: c.pais ?? "",
    objeto: c.objeto ?? "", valor: comoTexto(c.valor ?? 0), moneda: c.moneda ?? "",
    fecha_inicio: c.fecha_inicio ?? "", fecha_fin: c.fecha_fin ?? "",
    requiere_poliza: String(c.requiere_poliza === true), tipo_poliza: c.requiere_poliza ? (c.tipo_poliza ?? "") : "",
    estado_poliza: c.requiere_poliza ? "pendiente" : "no_aplica",
    comercial: v.comercial.nombre ?? `NO REGISTRADO (${v.comercial.email})`,
    ruta_sharepoint: rutaArchivo, fecha_registro: fechaRegistro, fuente: "buzon",
  }
  guardarMaestro(ctx, [...maestro, fila])
  agregarLinea(ctx, RUTAS.historial, {
    ts: new Date().toISOString(), id_contrato: id, accion: "alta", cambios: fila,
    mensaje_id: v.mensaje_id, confirmado_por_humano: confirmado, campos_confirmados: confirmado ? v.requiere_revision : [],
  })
  marcarProcesado(ctx, v.mensaje_id, "alta", id)
  return { mensaje_id: v.mensaje_id, id_contrato: id, accion: "alta", ruta_archivo: rutaArchivo, resumen: `alta ${id} (${fila.estado_poliza})` }
}

function registrarActualizacion(ctx: Ctx, v: Validacion, confirmado: boolean): Registro {
  const maestro = leerMaestro(ctx)
  const fila = maestro.find((f) => f.id_contrato === v.id_contrato_existente)
  if (!fila) throw new ErrorNegocio(`el contrato ${v.id_contrato_existente} ya no está en el maestro`)
  const cambios = (v.diferencias ?? []).map((d) => ({ campo: d.campo, antes: d.maestro, despues: d.documento }))
  cambios.forEach((d) => { fila[d.campo as Columna] = d.despues })

  const extraccion = extraerMensaje(ctx, v.mensaje_id)
  if (extraccion.polizas_requieren_ampliacion && fila.requiere_poliza === "true" && fila.estado_poliza !== "pendiente") {
    cambios.push({ campo: "estado_poliza", antes: fila.estado_poliza, despues: "pendiente" })
    fila.estado_poliza = "pendiente"
  }
  const sufijo = extraccion.tipo_documento === "otrosi" ? `_otrosi-${historialDe(ctx, fila.id_contrato) + 1}` : `_v${historialDe(ctx, fila.id_contrato) + 2}`
  const rutaArchivo = archivar(ctx, v.mensaje_id, extraccion.adjunto, fila.fecha_inicio.slice(0, 4), fila.cliente, `${fila.id_contrato}${sufijo}`)
  guardarMaestro(ctx, maestro)
  agregarLinea(ctx, RUTAS.historial, {
    ts: new Date().toISOString(), id_contrato: fila.id_contrato, accion: "actualizacion", cambios,
    mensaje_id: v.mensaje_id, documento: rutaArchivo, confirmado_por_humano: confirmado,
  })
  marcarProcesado(ctx, v.mensaje_id, "actualizacion", fila.id_contrato)
  const detalle = cambios.map((d) => `${d.campo}: ${d.antes} → ${d.despues}`).join("; ")
  return { mensaje_id: v.mensaje_id, id_contrato: fila.id_contrato, accion: "actualizacion", ruta_archivo: rutaArchivo, resumen: `actualizado ${fila.id_contrato}: ${detalle}` }
}

function historialDe(ctx: Ctx, idContrato: string): number {
  return leerHistorial(ctx).filter((h) => h.id_contrato === idContrato && h.accion === "actualizacion").length
}

// ─────────────────────────── Alertas ───────────────────────────
interface ItemAlerta { id_contrato: string; cliente: string; detalle: string; comercial: string }

function construirAlertas(ctx: Ctx, hoy: string) {
  const maestro = leerMaestro(ctx)
  const conDias = maestro.filter((f) => esFechaValida(f.fecha_fin)).map((f) => ({ f, dias: diasEntre(hoy, f.fecha_fin) }))
  const item = (f: Fila, detalle: string): ItemAlerta => ({ id_contrato: f.id_contrato, cliente: f.cliente, detalle, comercial: f.comercial })

  const vencen = conDias.filter(({ dias }) => dias >= 0 && dias <= PARAMETROS.diasAlerta)
    .sort((a, b) => a.dias - b.dias).map(({ f, dias }) => item(f, `vence ${f.fecha_fin} (en ${dias} días)`))
  const vencidos = conDias.filter(({ dias }) => dias < 0)
    .map(({ f, dias }) => item(f, `venció ${f.fecha_fin} (hace ${-dias} días) y sigue en el maestro de vigentes`))
  const polizas = maestro.filter((f) => f.requiere_poliza === "true" && f.estado_poliza !== "vigente")
    .map((f) => item(f, `póliza ${f.tipo_poliza || "(tipo sin definir)"} en estado ${f.estado_poliza}`))
  const altas = maestro.filter((f) => f.fecha_registro > PARAMETROS.fechaCorte)
    .map((f) => item(f, `alta el ${f.fecha_registro} (fuente: ${f.fuente})`))
  const actualizados = leerHistorial(ctx).filter((h) => h.accion === "actualizacion")
    .map((h) => ({ id_contrato: h.id_contrato, cliente: maestro.find((f) => f.id_contrato === h.id_contrato)?.cliente ?? "", detalle: `actualizado por ${h.mensaje_id}`, comercial: maestro.find((f) => f.id_contrato === h.id_contrato)?.comercial ?? "" }))
  return { vencen, vencidos, polizas, registrados: [...altas, ...actualizados] }
}

function tablaMd(items: ItemAlerta[]): string {
  if (items.length === 0) return "_Sin elementos._\n"
  const filas = items.map((i) => `| ${i.id_contrato} | ${i.cliente} | ${i.detalle} | ${i.comercial} |`)
  return ["| Contrato | Cliente | Detalle | Comercial |", "|---|---|---|---|", ...filas].join("\n") + "\n"
}

function alertasMd(hoy: string, a: ReturnType<typeof construirAlertas>): string {
  return [
    `# Reporte de alertas de contratos`, ``, `Fecha de referencia: **${hoy}** · Ventana: ${PARAMETROS.diasAlerta} días · Corte del maestro: ${PARAMETROS.fechaCorte}`, ``,
    `## 1. Contratos que vencen en ≤ ${PARAMETROS.diasAlerta} días (${a.vencen.length})`, tablaMd(a.vencen),
    `## 2. Pólizas requeridas que no están vigentes (${a.polizas.length})`, tablaMd(a.polizas),
    `## 3. Contratos registrados o actualizados desde el corte ${PARAMETROS.fechaCorte} — gap cubierto (${a.registrados.length})`, tablaMd(a.registrados),
    `## 4. Contratos ya vencidos que siguen en el maestro (${a.vencidos.length})`, tablaMd(a.vencidos),
  ].join("\n")
}

// ═════════════════════════════ HERRAMIENTAS ═════════════════════════════

export const leer_buzon = {
  description: "Lista los mensajes del buzón de contratos que aún no se han procesado, indicando si cada uno trae un adjunto de contrato.",
  args: {},
  async execute(_args: Record<string, never>, ctx: Ctx): Promise<string> {
    return ejecutarSeguro(ctx, "contratos_leer_buzon", null, () => {
      const procesados = new Set(leerProcesados(ctx).map((p) => p.mensaje_id))
      const ids = readdirSync(ruta(ctx, RUTAS.buzon), { withFileTypes: true })
        .filter((d) => d.isDirectory() && !procesados.has(d.name)).map((d) => d.name).sort()
      const mensajes = ids.map((id) => {
        try {
          const correo = leerCorreo(ctx, id)
          const adjuntos = leerAdjuntos(ctx, correo)
          const contrato = adjuntoContrato(adjuntos)
          return {
            id, de: correo.de, asunto: correo.asunto, fecha: correo.fecha, adjuntos: correo.adjuntos,
            tiene_contrato: Boolean(contrato), tipo_documento: contrato?.tipo ?? adjuntos[0]?.tipo ?? "ninguno",
            ...(contrato ? {} : { clasificacion: "rechazado", motivo: motivoSinContrato(adjuntos) }),
          }
        } catch (e) {
          return { id, de: "", asunto: "", fecha: "", adjuntos: [], tiene_contrato: false, clasificacion: "rechazado", motivo: mensajeError(e) }
        }
      })
      return ok({ mensajes, pendientes: mensajes.length, procesados: procesados.size, resumen: `${mensajes.length} mensajes pendientes` })
    })
  },
}

const ArgsExtraer = z.object({ mensaje_id: IdMensaje })
export const extraer = {
  description: "Extrae de forma determinista los datos estructurados del contrato adjunto a un mensaje, con confianza por campo entre 0 y 1.",
  args: ArgsExtraer.shape,
  async execute(a: z.infer<typeof ArgsExtraer>, ctx: Ctx): Promise<string> {
    return ejecutarSeguro(ctx, "contratos_extraer", a.mensaje_id, () => {
      const ext = extraerMensaje(ctx, a.mensaje_id)
      const bajos = CAMPOS.filter((c) => ext.confianza[c] < PARAMETROS.umbralConfianza && ext.contrato[c] !== null)
      return ok({ ...ext, resumen: `${ext.tipo_documento} ${ext.contrato.id_contrato ?? "(sin número)"}; baja confianza: ${bajos.join(", ") || "ninguno"}` })
    })
  },
}

const ArgsValidar = z.object({ mensaje_id: IdMensaje, contrato: ContratoArg })
export const validar = {
  description: "Clasifica un mensaje como nuevo, actualizacion, duplicado o rechazado contra el maestro y lista los campos que requieren revisión humana.",
  args: ArgsValidar.shape,
  async execute(a: z.infer<typeof ArgsValidar>, ctx: Ctx): Promise<string> {
    return ejecutarSeguro(ctx, "contratos_validar", a.mensaje_id, () => {
      const v = validarInterno(ctx, a.mensaje_id, a.contrato)
      const revision = v.requiere_revision.length ? `; revisar: ${v.requiere_revision.join(", ")}` : ""
      return ok({ ...v, resumen: `${v.clasificacion}${v.motivo ? ` (${v.motivo})` : ""}${revision}` })
    })
  },
}

const ArgsRegistrar = z.object({
  mensaje_id: IdMensaje,
  contrato: ContratoArg.optional().describe("Valores validados del contrato; omitir para rechazados"),
  confirmado: z.boolean().optional().describe("true SOLO si el usuario confirmó explícitamente en su último mensaje los campos en revisión"),
  fecha_registro: Fecha.optional().describe("Fecha de registro YYYY-MM-DD; por defecto, hoy"),
})
export const registrar = {
  description: "Registra el resultado de un mensaje validado: inserta o actualiza el maestro, archiva el documento y deja historial; rechaza si hay campos en revisión sin confirmación.",
  args: ArgsRegistrar.shape,
  async execute(a: z.infer<typeof ArgsRegistrar>, ctx: Ctx): Promise<string> {
    return ejecutarSeguro(ctx, "contratos_registrar", a.mensaje_id, () => {
      if (leerProcesados(ctx).some((p) => p.mensaje_id === a.mensaje_id)) {
        return fallo(`el mensaje ${a.mensaje_id} ya fue procesado; no se escribe nada`)
      }
      const v = validarInterno(ctx, a.mensaje_id, a.contrato)
      const confirmado = a.confirmado === true
      if (v.clasificacion === "rechazado") {
        marcarProcesado(ctx, a.mensaje_id, "rechazado", null)
        return ok({ mensaje_id: a.mensaje_id, id_contrato: null, accion: "rechazado", ruta_archivo: null, motivo: v.motivo, resumen: `rechazado: ${v.motivo}` })
      }
      if (v.clasificacion === "duplicado") {
        marcarProcesado(ctx, a.mensaje_id, "duplicado", v.id_contrato_existente ?? null)
        return ok({ mensaje_id: a.mensaje_id, id_contrato: v.id_contrato_existente, accion: "duplicado_sin_cambios", ruta_archivo: null, resumen: `duplicado de ${v.id_contrato_existente}; sin escritura` })
      }
      if (v.requiere_revision.length > 0 && !confirmado) {
        return fallo(`requiere revisión: ${v.requiere_revision.join(", ")}. Pide confirmación humana y vuelve a llamar con confirmado=true.`)
      }
      const fecha = a.fecha_registro ?? new Date().toISOString().slice(0, 10)
      const r = v.clasificacion === "nuevo" ? registrarNuevo(ctx, v, fecha, confirmado) : registrarActualizacion(ctx, v, confirmado)
      return ok(r)
    })
  },
}

const ArgsAlertas = z.object({ hoy: Fecha.describe("Fecha de referencia YYYY-MM-DD para calcular vencimientos") })
export const alertas = {
  description: "Genera out/alertas.md con contratos que vencen en ≤ 60 días, pólizas requeridas no vigentes y contratos registrados desde el corte.",
  args: ArgsAlertas.shape,
  async execute(a: z.infer<typeof ArgsAlertas>, ctx: Ctx): Promise<string> {
    return ejecutarSeguro(ctx, "contratos_alertas", null, () => {
      if (!esFechaValida(a.hoy)) return fallo(`fecha inválida: ${a.hoy}`)
      const r = construirAlertas(ctx, a.hoy)
      escribirTexto(ctx, RUTAS.alertas, alertasMd(a.hoy, r))
      return ok({
        ruta: RUTAS.alertas, vencen: r.vencen, polizas_pendientes: r.polizas,
        registrados_desde_corte: r.registrados, vencidos_en_maestro: r.vencidos,
        resumen: `${r.vencen.length} por vencer, ${r.polizas.length} pólizas pendientes, ${r.registrados.length} desde el corte`,
      })
    })
  },
}
