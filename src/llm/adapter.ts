// Interfaz neutral de proveedor LLM. El ciclo del agente solo conoce estos tipos;
// cambiar de proveedor = escribir otra implementación de LlmAdapter.

export type Bloque =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }

export interface Mensaje { role: "user" | "assistant"; content: Bloque[] }

export interface HerramientaSpec {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface RespuestaLlm {
  bloques: Bloque[]
  fin: "end_turn" | "tool_use" | "max_tokens" | "otro"
  uso: { entrada: number; salida: number }
}

export interface PeticionLlm {
  system: string
  mensajes: Mensaje[]
  herramientas: HerramientaSpec[]
}

export interface LlmAdapter {
  readonly provider: string
  readonly model: string
  enviar(peticion: PeticionLlm): Promise<RespuestaLlm>
}

export class ErrorLlm extends Error {}
