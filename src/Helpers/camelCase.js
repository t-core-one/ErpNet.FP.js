// Convert PascalCase keys to camelCase, preserving IDs/acronyms where the
// second character is also uppercase (e.g. "DT970048" or "URI" stay unchanged).
export function toCamelCase(obj) {
  if (Array.isArray(obj)) return obj.map(toCamelCase);
  if (obj !== null && typeof obj === 'object' && !(obj instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const isPascalCase = k.length > 1
        && k.charCodeAt(0) >= 65 && k.charCodeAt(0) <= 90   // first char A–Z
        && k.charCodeAt(1) >= 97 && k.charCodeAt(1) <= 122; // second char a–z
      const key = isPascalCase ? k[0].toLowerCase() + k.slice(1) : k;
      out[key] = toCamelCase(v);
    }
    return out;
  }
  return obj;
}
