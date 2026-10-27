// Implementación Anthropic (Messages API) usando fetch: sin SDK, una dependencia menos.
import { ErrorLlm, type Bloque, type LlmAdapter, type PeticionLlm, type RespuestaLlm } from "./adapter"

interface Config { apiKey: string; model: string; maxTokens: number; timeoutMs: number; baseUrl: string }

interface RespuestaApi {
  content?: Bloque[]
  stop_reason?: string
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { message?: string }
}

export class AnthropicAdapter implements LlmAdapter {
  readonly provider = "anthropic"
  readonly model: string
  private readonly config: Config

  constructor(config: Config) {
    this.config = config
    this.model = config.model
  }

  async enviar(p: PeticionLlm): Promise<RespuestaLlm> {
    const control = new AbortController()
    const temporizador = setTimeout(() => control.abort(), this.config.timeoutMs)
    try {
      const r = await fetch(`${this.config.baseUrl}/v1/messages`, {
        method: "POST",
        signal: control.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": this.config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: this.config.maxTokens,
          temperature: 0,
          // cache del system prompt y las herramientas: abarata cada iteración del ciclo
          system: [{ type: "text", text: p.system, cache_control: { type: "ephemeral" } }],
          tools: p.herramientas,
          messages: p.mensajes,
        }),
      })
      const cuerpo = (await r.json()) as RespuestaApi
      if (!r.ok) throw new ErrorLlm(`el proveedor respondió ${r.status}: ${cuerpo.error?.message ?? "error desconocido"}`)
      return {
        bloques: (cuerpo.content ?? []).filter((b) => b.type === "text" || b.type === "tool_use"),
        fin: this.fin(cuerpo.stop_reason),
        uso: { entrada: cuerpo.usage?.input_tokens ?? 0, salida: cuerpo.usage?.output_tokens ?? 0 },
      }
    } catch (e) {
      if (e instanceof ErrorLlm) throw e
      if (e instanceof Error && e.name === "AbortError") {
        throw new ErrorLlm(`el modelo no respondió en ${this.config.timeoutMs / 1000} s (timeout)`)
      }
      throw new ErrorLlm(`no fue posible contactar al proveedor: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      clearTimeout(temporizador)
    }
  }

  private fin(stop: string | undefined): RespuestaLlm["fin"] {
    if (stop === "end_turn" || stop === "tool_use" || stop === "max_tokens") return stop
    return "otro"
  }
}
