// Fábrica de proveedores: el único punto que conoce las implementaciones concretas.
import type { LlmAdapter } from "./adapter"
import { AnthropicAdapter } from "./anthropic"
import { MockAdapter } from "./mock"

export function crearAdapter(env: Record<string, string | undefined>): LlmAdapter {
  const proveedor = env.LLM_PROVIDER ?? "anthropic"
  if (proveedor === "mock") return new MockAdapter()
  if (proveedor !== "anthropic") throw new Error(`LLM_PROVIDER no soportado: ${proveedor}`)
  const apiKey = env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error("falta ANTHROPIC_API_KEY (o usa LLM_PROVIDER=mock)")
  return new AnthropicAdapter({
    apiKey,
    model: env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5",
    maxTokens: Number(env.LLM_MAX_TOKENS ?? 4096),
    timeoutMs: Number(env.LLM_TIMEOUT_MS ?? 60000),
    baseUrl: env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
  })
}
