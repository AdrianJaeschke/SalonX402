// Shared input contract for HTTP and MCP commissions. The server supplies
// identity, field ownership, version and creator attribution separately.
export function parseCreativeBrief(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('A creative brief must be an object.');
  }
  const allowed = new Set(['brief', 'language']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new TypeError('Unexpected creative brief field: ' + key);
  }
  if (typeof input.brief !== 'string' || !input.brief.trim()) {
    throw new TypeError('Describe the requested interpretation in the brief.');
  }
  const brief = input.brief.trim();
  if (brief.length > 2000) throw new RangeError('Brief exceeds 2000 characters.');
  const language = input.language;
  if (language !== undefined && (typeof language !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language) || language.length > 35)) {
    throw new TypeError('Invalid brief language.');
  }
  return language === undefined ? { brief } : { brief, language };
}
