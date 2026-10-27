// API HTTP + front estático. El ciclo vive en agent.ts; las herramientas en tools/.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { extname, join, resolve } from "node:path"
import { ejecutarTurno, nuevaSesion, registrarModulo, type Dependencias, type Sesion } from "./agent"
import { crearAdapter } from "./llm"
import * as contratos from "./tools/contratos"

const RAIZ = resolve(import.meta.dir, "..")
const env = process.env
const PUERTO = Number(env.PORT ?? 3000)
const CLAVE_ACCESO = env.ACCESS_KEY ?? ""
const ID_VALIDO = /^[A-Za-z0-9_-]{4,64}$/

function cargarSystemPrompt(): string {
  const comportamiento = readFileSync(join(RAIZ, "agent", "prompt.md"), "utf-8")
  const conocimiento = readFileSync(join(RAIZ, "src", "knowledge", "registro-contratos.md"), "utf-8")
  const hoy = new Date().toISOString().slice(0, 10)
  return `${comportamiento}\n\n---\n# Conocimiento del proceso\n\n${conocimiento}\n\n---\nFecha del sistema: ${hoy}. Si el usuario indica otra fecha de referencia, usa la del usuario.`
}

const deps: Dependencias = {
  adapter: crearAdapter(env),
  herramientas: registrarModulo("contratos", contratos),
  system: cargarSystemPrompt(),
  directorio: RAIZ,
  limites: {
    maxIteraciones: Number(env.MAX_ITERACIONES ?? 25),
    maxTokensSesion: Number(env.MAX_TOKENS_SESION ?? 400000),
  },
}

// ───────── Sesiones: memoria + copia en archivo ─────────
const sesiones = new Map<string, Sesion>()
const rutaSesion = (id: string): string => join(RAIZ, "out", "sesiones", `${id}.json`)

function obtenerSesion(id: string): Sesion {
  const enMemoria = sesiones.get(id)
  if (enMemoria) return enMemoria
  const sesion = existsSync(rutaSesion(id)) ? (JSON.parse(readFileSync(rutaSesion(id), "utf-8")) as Sesion) : nuevaSesion(id)
  sesiones.set(id, sesion)
  return sesion
}

function guardarSesion(s: Sesion): void {
  mkdirSync(join(RAIZ, "out", "sesiones"), { recursive: true })
  writeFileSync(rutaSesion(s.id), JSON.stringify(s))
}

// ───────── Utilidades HTTP ─────────
function responder(res: ServerResponse, estado: number, cuerpo: unknown): void {
  res.writeHead(estado, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(JSON.stringify(cuerpo))
}

async function leerCuerpo(req: IncomingMessage, limite = 20_000): Promise<unknown> {
  let datos = ""
  for await (const trozo of req) {
    datos += String(trozo)
    if (datos.length > limite) throw new Error("cuerpo demasiado grande")
  }
  return datos ? JSON.parse(datos) : {}
}

const peticionesPorIp = new Map<string, number[]>()
function excedeLimite(ip: string, maxPorMinuto = Number(env.MAX_PETICIONES_MINUTO ?? 20)): boolean {
  const ahora = Date.now()
  const recientes = (peticionesPorIp.get(ip) ?? []).filter((t) => ahora - t < 60_000)
  recientes.push(ahora)
  peticionesPorIp.set(ip, recientes)
  return recientes.length > maxPorMinuto
}

function autorizado(req: IncomingMessage): boolean {
  return CLAVE_ACCESO === "" || req.headers["x-access-key"] === CLAVE_ACCESO
}

const ocupadas = new Set<string>()

async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cuerpo = (await leerCuerpo(req)) as { sessionId?: unknown; message?: unknown }
  const sessionId = String(cuerpo.sessionId ?? "")
  const mensaje = String(cuerpo.message ?? "").trim()
  if (!ID_VALIDO.test(sessionId)) return responder(res, 400, { error: "sessionId inválido" })
  if (!mensaje || mensaje.length > 4000) return responder(res, 400, { error: "mensaje vacío o mayor a 4000 caracteres" })
  if (ocupadas.has(sessionId)) return responder(res, 409, { error: "la sesión está procesando otro mensaje" })
  ocupadas.add(sessionId)
  try {
    const sesion = obtenerSesion(sessionId)
    const r = await ejecutarTurno(sesion, mensaje, deps)
    guardarSesion(sesion)
    responder(res, 200, { ...r, tokensSesion: sesion.tokens })
  } finally {
    ocupadas.delete(sessionId)
  }
}

function reiniciar(res: ServerResponse): void {
  rmSync(join(RAIZ, "out"), { recursive: true, force: true })
  sesiones.clear()
  responder(res, 200, { ok: true, mensaje: "out/ reiniciado: maestro, historial, procesados, alertas y sesiones" })
}

const TIPOS: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }

function estatico(ruta: string, res: ServerResponse): void {
  const archivo = ruta === "/" ? "index.html" : ruta.replace(/^\/+/, "")
  const destino = resolve(RAIZ, "web", archivo)
  if (!destino.startsWith(resolve(RAIZ, "web")) || !existsSync(destino)) return responder(res, 404, { error: "no encontrado" })
  res.writeHead(200, { "content-type": TIPOS[extname(destino)] ?? "application/octet-stream" })
  res.end(readFileSync(destino))
}

async function enrutar(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost")
  const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "")
  if (req.method === "GET" && url.pathname === "/api/health") {
    return responder(res, 200, { ok: true, provider: deps.adapter.provider, model: deps.adapter.model, protegido: CLAVE_ACCESO !== "" })
  }
  if (url.pathname.startsWith("/api/")) {
    if (!autorizado(req)) return responder(res, 401, { error: "clave de acceso inválida" })
    if (excedeLimite(ip)) return responder(res, 429, { error: "demasiadas peticiones; espera un minuto" })
  }
  if (req.method === "POST" && url.pathname === "/api/chat") return chat(req, res)
  if (req.method === "POST" && url.pathname === "/api/reset") return reiniciar(res)
  const sesion = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
  if (req.method === "GET" && sesion) {
    if (!ID_VALIDO.test(sesion[1])) return responder(res, 400, { error: "sessionId inválido" })
    const s = obtenerSesion(sesion[1])
    return responder(res, 200, { id: s.id, eventos: s.eventos, tokens: s.tokens, pendientes: s.pendientes })
  }
  if (req.method === "GET" && url.pathname === "/api/alertas") {
    const ruta = join(RAIZ, "out", "alertas.md")
    return responder(res, 200, { markdown: existsSync(ruta) ? readFileSync(ruta, "utf-8") : "" })
  }
  if (req.method === "GET") return estatico(url.pathname, res)
  responder(res, 404, { error: "ruta no encontrada" })
}

createServer((req, res) => {
  enrutar(req, res).catch((e: unknown) => {
    console.error("error no controlado:", e instanceof Error ? e.message : e)
    if (!res.headersSent) responder(res, 500, { error: "error interno; la sesión sigue disponible" })
  })
}).listen(PUERTO, () => {
  console.log(`Agente de contratos en http://localhost:${PUERTO} · proveedor ${deps.adapter.provider} (${deps.adapter.model})`)
})
