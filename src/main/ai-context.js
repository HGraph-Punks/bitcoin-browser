import { AppError } from '../shared/errors.js';

const estimate = value => Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 4);
// This is a conservative heuristic, not a model tokenizer. Actual server
// context errors are separately classified without reflecting server bodies.
export function fitAiContext(messages, tools, loadedContextLength) {
  const capacity = loadedContextLength ?? 8192;
  const maxTokens = capacity < 8192 ? 1024 : 1536;
  const budget = capacity - maxTokens - 512;
  const result = structuredClone(messages);
  const size = () => estimate(result) + (tools ? estimate(tools) : 0) + result.length * 32;
  let shortened = false;
  let currentUser = result.findLastIndex(message => message.role === 'user');
  // Remove oldest complete history turns, never the current user question.
  while (size() > budget && currentUser > 1) {
    let end = 2;
    while (end < currentUser && result[end].role !== 'user') end++;
    result.splice(1, end - 1); currentUser -= end - 1; shortened = true;
  }
  // Drop old tool rounds as whole assistant-call/result groups. Never leave
  // orphaned tool messages. Visible cards and the in-memory chat stay intact.
  while (size() > budget) {
    const starts = result.flatMap((message, index) => index > currentUser && message.tool_calls?.length ? [index] : []);
    if (starts.length < 2) break;
    result.splice(starts[0], starts[1] - starts[0]); shortened = true;
  }
  if (size() > budget) for (const message of result) {
    if (message.role !== 'tool') continue;
    try {
      const original = JSON.parse(message.content);
      // Keep exact fact strings and source attribution, not a broken JSON
      // slice. The complete details are still present in browser-owned cards.
      message.content = JSON.stringify({ cards: (original.cards ?? []).slice(0, 4).map(card => ({ ...card, facts: (card.facts ?? []).slice(0, 16) })),
        ...(original.error ? { error: original.error } : {}), note: 'Context excerpt: only these cards and facts were supplied. Missing details are unknown. Ask a focused follow-up.' });
      shortened = true;
    } catch { /* Do not replace a malformed result with invented data. */ }
    if (size() <= budget) break;
  }
  if (size() > budget) throw new AppError('AI_CONTEXT_LIMIT', 'This question exceeds the loaded model context.', { status: 400 });
  return { messages: result, maxTokens, shortened };
}
