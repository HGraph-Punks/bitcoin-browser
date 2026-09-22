export const MAX_INSCRIPTION_TEXT_BYTES = 256 * 1024;
export const INSCRIPTION_DISPLAY_ID = /^[0-9a-f]{64}i\d{1,10}$/i;
export const INSCRIPTION_IMAGE_TYPES = Object.freeze(['image/png', 'image/apng', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon']);
export const INSCRIPTION_FONT_TYPES = Object.freeze(['font/otf', 'font/ttf', 'font/woff', 'font/woff2', 'application/font-woff', 'application/x-font-ttf', 'application/x-font-opentype', 'application/vnd.ms-opentype']);
export const INSCRIPTION_MODEL_TYPES = Object.freeze(['model/gltf+json', 'model/gltf-binary', 'model/stl', 'application/sla']);
const IMAGES = new Set(INSCRIPTION_IMAGE_TYPES);

export function inscriptionMime(value) { return String(value ?? '').toLowerCase().split(';')[0].trim(); }
export function isReadableInscription(value) {
  const type = inscriptionMime(value);
  return (type.startsWith('text/') && type !== 'text/html')
    || /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/.test(type)
    || ['application/javascript', 'application/x-javascript', 'application/ecmascript', 'application/xml', 'application/yaml', 'application/x-yaml', 'application/pgp-signature', 'application/sql', 'application/toml'].includes(type);
}
export function inscriptionPresentation(value) {
  const type = inscriptionMime(value);
  if (INSCRIPTION_MODEL_TYPES.includes(type)) return 'model';
  if (type === 'application/pdf') return 'pdf';
  if (INSCRIPTION_FONT_TYPES.includes(type)) return 'font';
  if (['text/markdown', 'text/x-markdown'].includes(type)) return 'markdown';
  if (type === 'image/jxl') return 'jxl';
  if (IMAGES.has(type)) return 'image';
  if (isReadableInscription(type)) return 'text';
  if (['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-m4v'].includes(type)) return 'video';
  if (['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/aac', 'audio/x-m4a', 'audio/ogg', 'application/ogg', 'audio/opus', 'audio/wav', 'audio/wave', 'audio/x-wav', 'audio/webm', 'audio/flac', 'audio/x-flac'].includes(type)) return 'audio';
  if (['text/html', 'application/xhtml+xml'].includes(type)) return 'original';
  return 'binary';
}

// Validate JSON, then format its original lexical tokens. Do not stringify the
// parsed value: that would round large numbers and discard duplicate keys.
export function presentInscriptionText(text) {
  if (typeof text !== 'string' || text.length > MAX_INSCRIPTION_TEXT_BYTES) throw new Error('Text preview is too large.');
  try { JSON.parse(text); } catch { return { isJson: false, formatted: text }; }
  const tokens = text.match(/"(?:\\[\s\S]|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:]/g) ?? [];
  if (tokens.length > 5000) return { isJson: true, formatted: text };
  const output = [];
  let depth = 0;
  const newline = () => output.push('\n' + '  '.repeat(depth));
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '{' || token === '[') {
      output.push(token); depth++;
      if (depth > 32) return { isJson: true, formatted: text };
      if (tokens[i + 1] !== (token === '{' ? '}' : ']')) newline();
    } else if (token === '}' || token === ']') {
      depth--;
      if (!['{', '['].includes(tokens[i - 1])) newline();
      output.push(token);
    } else if (token === ',') { output.push(','); newline(); }
    else if (token === ':') output.push(': ');
    else output.push(token);
  }
  return { isJson: true, formatted: output.join('') };
}
