'use strict';

class ExpiringCache {
  constructor() {
    this._store = new Map();
  }

  store(key, value, expiresAfterMs) {
    this._store.set(key, {
      value,
      expiresAt: Date.now() + expiresAfterMs,
    });
  }

  get(key) {
    const entry = this._store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this._store.delete(key);
      return null;
    }
    return entry.value;
  }
}

module.exports = { ExpiringCache };
