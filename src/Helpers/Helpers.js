'use strict';

function slice(arr, from, to) {
  if (!arr) return Buffer.alloc(0);
  if (to === undefined) to = arr.length;
  if (from < 0) from = 0;
  if (to > arr.length) to = arr.length;
  if (from >= to) return Buffer.alloc(0);
  return arr.slice(from, to);
}

function withMaxLength(text, max = 72) {
  if (!text) return '';
  return text.length <= max ? text : text.substring(0, max);
}

function wrapAtLength(text, maxLength) {
  if (!text || maxLength <= 0) return [];
  const lines = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    lines.push(remaining.substring(0, maxLength));
    remaining = remaining.substring(maxLength);
  }
  if (remaining.length > 0) lines.push(remaining);
  return lines;
}

function mergeWith(options, newOptions) {
  if (!newOptions) return options || {};
  if (!options) return Object.assign({}, newOptions);
  return Object.assign({}, options, newOptions);
}

function valueOrDefault(options, key, defaultValue) {
  if (!options) return defaultValue;
  const val = options[key];
  if (val === undefined || val === null) return defaultValue;
  return val;
}

function ifNullOrEmpty(val, fallback) {
  if (val === null || val === undefined || val === '') return fallback;
  return val;
}

function splitByChunkSizes(str, chunkSizes) {
  const result = [];
  let idx = 0;
  for (const size of chunkSizes) {
    result.push(str.substring(idx, idx + size));
    idx += size;
  }
  return result;
}

function intPow(a, b) {
  let result = 1;
  for (let i = 0; i < b; i++) result *= a;
  return result;
}

function parseTimeout(s) {
  if (!s) return 0;
  s = s.trim().toLowerCase();
  if (s.endsWith('ms')) return parseInt(s.slice(0, -2), 10);
  if (s.endsWith('s')) return parseInt(s.slice(0, -1), 10) * 1000;
  if (s.endsWith('m')) return parseInt(s.slice(0, -1), 10) * 60000;
  return parseInt(s, 10);
}

module.exports = {
  slice,
  withMaxLength,
  wrapAtLength,
  mergeWith,
  valueOrDefault,
  ifNullOrEmpty,
  splitByChunkSizes,
  intPow,
  parseTimeout,
};
