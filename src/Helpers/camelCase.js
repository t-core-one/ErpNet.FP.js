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

// Convert camelCase keys to PascalCase — mirrors toCamelCase.
// Applied to incoming request bodies so drivers always receive PascalCase,
// matching the behaviour of the C# server (ASP.NET case-insensitive binding).
export function toPascalCase(obj) {
  if (Array.isArray(obj)) return obj.map(toPascalCase);
  if (obj !== null && typeof obj === 'object' && !(obj instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const isCamelCase = k.length > 1
        && k.charCodeAt(0) >= 97 && k.charCodeAt(0) <= 122  // first char a–z
        && k.charCodeAt(1) >= 97 && k.charCodeAt(1) <= 122; // second char a–z
      const key = isCamelCase ? k[0].toUpperCase() + k.slice(1) : k;
      out[key] = toPascalCase(v);
    }
    return out;
  }
  return obj;
}
