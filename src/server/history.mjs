/**
 * The conversation history a FRESH Gemini session gets in its system
 * instruction. Shared by the call bridge and the debug MCP (which rebuilds it
 * for get_conversation_context without loading the bridge).
 */

/** Bound the history carried into a FRESH session's system instruction. Larger
 * than the replay cap: this is the model's only memory of earlier calls when
 * no resumption handle can be used. Newest turns win; one huge line (a tool
 * dump read aloud) can't crowd out the rest. */
export const HISTORY_MAX_TURNS = 60;
export const HISTORY_MAX_CHARS = 16000;
export const HISTORY_MAX_LINE = 1500;
export function historyInstruction(turns) {
  if (!turns?.length) return '';
  const lines = [];
  let total = 0;
  for (const t of turns.slice(-HISTORY_MAX_TURNS).reverse()) {
    const text = String(t.text ?? '').trim();
    if (!text) continue;
    const clipped = text.length > HISTORY_MAX_LINE ? `${text.slice(0, HISTORY_MAX_LINE)} …` : text;
    const line = `${t.role === 'model' ? 'Assistant' : 'User'}: ${clipped}`;
    if (total + line.length > HISTORY_MAX_CHARS && lines.length) break;
    total += line.length;
    lines.unshift(line);
  }
  if (!lines.length) return '';
  return '\n\n--- Conversation so far (earlier calls in this same conversation; you remember all of it. ' +
    'Continue from here — do not greet anew or claim you lack the earlier context) ---\n' +
    `${lines.join('\n')}\n--- end of conversation so far ---`;
}
