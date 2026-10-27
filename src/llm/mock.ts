// Proveedor simulado y determinista: permite probar el front y el ciclo sin clave.
// No razona: lee el buzón y responde con lo que devolvió la herramienta.
import type { LlmAdapter, PeticionLlm, RespuestaLlm } from "./adapter"

export class MockAdapter implements LlmAdapter {
  readonly provider = "mock"
  readonly model = "mock-determinista"

  async enviar(p: PeticionLlm): Promise<RespuestaLlm> {
    const ultimo = p.mensajes[p.mensajes.length - 1]
    const resultado = ultimo?.content.find((b) => b.type === "tool_result")
    if (resultado && resultado.type === "tool_result") {
      return {
        bloques: [{ type: "text", text: `Modo simulado (sin modelo). Resultado de la herramienta:\n\n\`\`\`json\n${resultado.content.slice(0, 1500)}\n\`\`\`\n\nConfigura LLM_PROVIDER=anthropic para conversar con el agente real.` }],
        fin: "end_turn", uso: { entrada: 0, salida: 0 },
      }
    }
    return {
      bloques: [{ type: "tool_use", id: `mock-${Date.now()}`, name: "contratos_leer_buzon", input: {} }],
      fin: "tool_use", uso: { entrada: 0, salida: 0 },
    }
  }
}
