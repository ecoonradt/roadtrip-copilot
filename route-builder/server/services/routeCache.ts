import type { RouteResponse } from '../types/index.js';

export class RouteCache {
  private readonly cache = new Map<string, RouteResponse>();
  private readonly maxEntries: number;

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
  }

  /**
   * Normalizes coordinate string to prevent floating-point mismatch misses.
   * Rounds coordinates to 5 decimal places (~1.1 meter resolution).
   */
  public normalizeKey(coords: string): string {
    return coords
      .split(';')
      .map((pair) => {
        const parts = pair.split(',');
        if (parts.length !== 2) return pair.trim();
        const lon = parseFloat(parts[0].trim());
        const lat = parseFloat(parts[1].trim());
        if (isNaN(lon) || isNaN(lat)) return pair.trim();
        return `${lon.toFixed(5)},${lat.toFixed(5)}`;
      })
      .join(';');
  }

  public get(coords: string): RouteResponse | undefined {
    const key = this.normalizeKey(coords);
    const item = this.cache.get(key);
    if (item) {
      // Re-insert to keep LRU order
      this.cache.delete(key);
      this.cache.set(key, item);
      return { ...item, cached: true };
    }
    return undefined;
  }

  public set(coords: string, response: RouteResponse): void {
    const key = this.normalizeKey(coords);
    if (this.cache.size >= this.maxEntries) {
      // Evict oldest entry (LRU)
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, { ...response, cached: false });
  }

  public has(coords: string): boolean {
    return this.cache.has(this.normalizeKey(coords));
  }

  public clear(): void {
    this.cache.clear();
  }

  public size(): number {
    return this.cache.size;
  }
}

export const defaultRouteCache = new RouteCache();
