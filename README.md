# Reto 02 · Agente "Registro de Contratos Vigentes"

Agente conversacional que funciona como **punto único de recepción de contratos**. Lee el buzón, extrae los datos de cada contrato con su nivel de confianza, detecta duplicados y otrosíes, registra en el maestro (que simula SharePoint), archiva los documentos y genera alertas de vencimiento y de pólizas. Cuando un dato es dudoso, pide **confirmación humana** antes de registrarlo.

- **Link de prueba:** `<<PEGAR_URL_PÚBLICA>>`
- **Clave de acceso al link:** `<<PEGAR_ACCESS_KEY>>`. El front la pide al primer uso.
- Arquitectura, decisiones, costos y regla de gobierno: ver [SOLUCION.md](SOLUCION.md).

## Requisitos
- [Bun](https://bun.sh) 1.1 o superior.
- Una clave de Anthropic, solo para el chat con el modelo real. `demo.ts` y las pruebas no la necesitan.

## Levantar en local (un comando)
```bash
cp .env.example .env        # y completa ANTHROPIC_API_KEY
bun install && bun run dev  # http://localhost:3000
```
Para probar el front **sin clave**, usa `LLM_PROVIDER=mock`. Ese modo solo ejecuta `contratos_leer_buzon` y muestra el resultado, sin razonar.

Con Docker:
```bash
docker build -t reto02 . && docker run -p 3000:3000 --env-file .env reto02
```

## Verificación sin modelo
```bash
bun install && bun run demo.ts   # procesa msg-001…msg-006 y la confirmación de msg-006
bun test                         # 20 pruebas: 6 casos del PRD, errores HU-6, ciclo del agente (CA1, CA3, CA5)
bun run modulo:check             # verifica que modulo/ = fuentes de la app
```
`demo.ts` limpia `out/` al iniciar, así que da el mismo resultado en ejecuciones seguidas (salvo los timestamps).

## Variables de entorno
| Variable | Requerida | Descripción |
|---|---|---|
| `LLM_PROVIDER` | No (`anthropic`) | `anthropic` o `mock` |
| `ANTHROPIC_API_KEY` | Sí, con `anthropic` | Solo vive en el backend. Nunca va al front, al repositorio ni a los logs |
| `ANTHROPIC_MODEL` | No | Por defecto `claude-sonnet-4-5` |
| `LLM_MAX_TOKENS` / `LLM_TIMEOUT_MS` | No | 4096 / 60000 |
| `MAX_ITERACIONES` | No | Tope de llamadas al modelo por turno (25) |
| `MAX_TOKENS_SESION` | No | Tope de tokens por sesión (400000) |
| `MAX_PETICIONES_MINUTO` | No | Límite de peticiones por IP (20) |
| `ACCESS_KEY` | No | Si se define, la API exige el encabezado `x-access-key` |
| `PORT` | No | 3000 |

## API
| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| POST | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation, tokensSesion }` |
| GET | `/api/sessions/:id` | Historial de la sesión: eventos, llamadas a herramientas, tokens y pendientes de confirmación |
| GET | `/api/health` | `{ ok, provider, model, protegido }`. Nunca expone claves |
| GET | `/api/alertas` | Contenido de `out/alertas.md` |
| POST | `/api/reset` | Limpia `out/` para repetir la demo (botón "Reiniciar datos" del front) |

## Prompt de la demo
> Procesa el buzón de contratos con fecha de hoy 2026-09-03. Registra lo que esté limpio, muéstrame lo que requiere revisión campo por campo y termina con el reporte de alertas. No registres nada dudoso sin preguntarme.

Luego: **"Confirmo el valor 0 y la fecha fin 2027-08-31"**. Los dos textos están como botones en el front.

## Despliegue (Render)
1. Sube el repositorio a GitHub.
2. En Render: **New → Blueprint**, selecciona el repositorio. Render usa `render.yaml` y el `Dockerfile`.
3. Define `ANTHROPIC_API_KEY` y `ACCESS_KEY` como variables secretas.
4. Verifica que `https://<app>.onrender.com/api/health` responda `{ ok: true }`.

> En el plan gratuito el servicio "duerme" cuando está inactivo. Abre el link unos minutos antes de la defensa. El disco es efímero: `out/` se reinicia con cada despliegue, lo cual es deseable para la demo.

## Estructura
```
agent/prompt.md                     comportamiento (system prompt)
src/knowledge/registro-contratos.md conocimiento del proceso (reglas RN1–RN7, parámetros)
src/tools/contratos.ts              ejecución: herramientas zod (cada export → contratos_<export>)
src/agent.ts                        ciclo del agente (tope de iteraciones, confirmación humana)
src/llm/                            adaptador de proveedor (interfaz + Anthropic + mock)
src/server.ts                       API HTTP + front estático
web/index.html                      chat (HTML + JS sin dependencias)
demo.ts · tests/ · modulo/ · scripts/build-modulo.ts
fixtures/                           insumos entregados (solo lectura)
out/                                generado en ejecución (no se versiona)
```
