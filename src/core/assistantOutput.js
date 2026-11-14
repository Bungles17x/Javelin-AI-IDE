const TOOL_PROTOCOL_MARKER = /(?:<\s*\/?\s*tool_(?:response|call|result)\b|&lt;\s*\/?\s*tool_(?:response|call|result)\b)/i

export function sanitizeAssistantOutput(text) {
  const output = String(text ?? '').trim()
  return TOOL_PROTOCOL_MARKER.test(output) ? '' : output
}
