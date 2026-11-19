// Test helpers: an in-memory stand-in for plugin KV storage.
import type { Kv } from "../src/store.ts";

export function memoryKv(): Kv & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(key: string) {
      const v = data.get(key);
      return v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as T);
    },
    async set(key, value) {
      data.set(key, JSON.parse(JSON.stringify(value)));
    },
    async delete(key) {
      data.delete(key);
    },
    async list(prefix = "") {
      return [...data.keys()].filter((k) => k.startsWith(prefix));
    },
  };
}
