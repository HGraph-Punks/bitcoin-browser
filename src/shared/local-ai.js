import { AppError } from './errors.js';

export const AI_DEFAULT_CONFIG = Object.freeze({ provider: 'lmstudio', baseUrl: 'http://127.0.0.1:1234', model: '' });
export const AI_LIMITS = Object.freeze({ prompt: 4_000, history: 8, historyChars: 24_000, answer: 12_000, calls: 10, rounds: 7, cards: 24, models: 200, toolChars: 12_000, toolContextChars: 32_000, responseBytes: 1024 * 1024, turnMs: 240_000 });
export const AI_SERVERS = Object.freeze({
  lmstudio: Object.freeze({ name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234', guide: 'https://lmstudio.ai/docs/developer/core/server' }),
  ollama: Object.freeze({ name: 'Ollama', baseUrl: 'http://127.0.0.1:11434', guide: 'https://docs.ollama.com/quickstart' })
});
// Fixed diagnostic vocabulary only. Never include addresses, model names,
// request payloads, server bodies, tokens, or arbitrary exception messages.
export const AI_CONNECT_DIAGNOSTIC_CODES = Object.freeze(['STARTED', 'CONNECTED', 'AI_VALIDATION', 'AI_UNREACHABLE',
  'AI_AUTH', 'AI_TIMEOUT', 'AI_CATALOG', 'AI_NO_MODELS', 'AI_REMOTE_MODEL', 'AI_BRIDGE_UNAVAILABLE',
  'NAVIGATION_OWNER_INVALID', 'NAVIGATION_CANCELLED', 'IPC_TRANSPORT_ERROR', 'INTERNAL_ERROR', 'FAILED']);

const invalid = message => new AppError('AI_VALIDATION', message, { status: 400 });
export function aiRecord(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)))
    throw invalid('This AI request contains unsupported fields.');
  return value;
}
export function aiString(value, label, max, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))
    throw invalid(`${label} is missing, too long, or contains unsupported characters.`);
  return value.trim();
}

// Literal loopback only. Do not reuse isLoopbackUrl: that helper intentionally
// includes LAN sources. Normalize localhost before transport, without DNS.
export function validateAiConfig(value) {
  const input = aiRecord(value, ['provider', 'baseUrl', 'model']);
  if (!Object.hasOwn(AI_SERVERS, input.provider)) throw invalid('Choose LM Studio or Ollama.');
  const raw = aiString(input.baseUrl, 'Server address', 100);
  const match = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):([1-9]\d{3,4})(?:\/(?:v1\/?)?)?$/.exec(raw);
  if (!match || Number(match[2]) < 1024 || Number(match[2]) > 65535)
    throw invalid('Use a local server address such as http://127.0.0.1:1234. Only loopback HTTP ports 1024–65535 are supported.');
  const model = aiString(input.model ?? '', 'Model', 200, true);
  if (/[\r\n\t]/.test(model)) throw invalid('The model identifier is invalid.');
  return { provider: input.provider, baseUrl: `http://${match[1] === 'localhost' ? '127.0.0.1' : match[1]}:${match[2]}`, model };
}

export function validateAiRequest(value) {
  const input = aiRecord(value, ['action', 'config', 'token', 'prompt', 'history', 'allowLookups']);
  if (!['connect', 'chat'].includes(input.action)) throw invalid('Unknown AI action.');
  const config = validateAiConfig(input.config);
  const token = aiString(input.token ?? '', 'Server API token', 512, true);
  if (token && (!/^[A-Za-z0-9._~+\/-]+=*$/.test(token) || config.provider !== 'lmstudio'))
    throw invalid('An optional LM Studio API token must contain only token characters.');
  if (input.action === 'connect') {
    if (['prompt', 'history', 'allowLookups'].some(key => Object.hasOwn(input, key))) throw invalid('A connection check cannot include chat data.');
    return { action: input.action, config, token };
  }
  if (!config.model) throw invalid('Connect and choose a model first.');
  if (typeof input.allowLookups !== 'boolean') throw invalid('Choose whether to allow read-only Bitcoin lookups.');
  const prompt = aiString(input.prompt, 'Question', AI_LIMITS.prompt);
  const history = input.history ?? [];
  if (!Array.isArray(history) || history.length > AI_LIMITS.history) throw invalid('Start a new chat; this conversation is too long.');
  let total = 0;
  const safeHistory = history.map(message => {
    aiRecord(message, ['role', 'content']);
    if (!['user', 'assistant'].includes(message.role)) throw invalid('Chat history cannot supply system messages or tool results.');
    const content = aiString(message.content, 'Chat message', AI_LIMITS.answer);
    total += content.length;
    return { role: message.role, content };
  });
  if (total > AI_LIMITS.historyChars) throw invalid('Start a new chat; this conversation is too long.');
  return { action: input.action, config, token, prompt, history: safeHistory, allowLookups: input.allowLookups };
}

// Only browser-produced, allowlisted result targets become interactive links.
// Model prose can use inert formatting, but never creates navigation links.
export function aiResultTarget(value) {
  return typeof value === 'string' && value.length <= 220 &&
    (/^(?:block|tx|address|output|inscription|sat|satpoint|rune):[^\s/?#\\]+$/.test(value) ||
     /^satnav:\/\/(?:inscriptions|runes)(?:\?(?:page|block|offset)=\d+(?:&(?:page|block|offset)=\d+)*)?$/.test(value));
}
