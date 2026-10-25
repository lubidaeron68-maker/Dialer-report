/**
 * Memory-safety utilities for the dashboard.
 *
 * Design:
 * - String interning: repeated short strings (company, department, agent names,
 *   contact types, action results, statuses...) are stored ONCE per pool and
 *   referenced everywhere else. On a 150k-row file where "BLOB A" appears 40k
 *   times this cuts heap per string from ~20 bytes unique refs to a single ref.
 * - Budget: total estimated heap across ALL loaded datasets is kept under a
 *   RAM budget. When exceeded, the dashboard evicts the oldest inactive tab
 *   instead of letting the browser tab crash.
 */

export const HEAP_PER_RECORD_BYTES = 620; // conservative estimate with interning
export const TOTAL_HEAP_BUDGET_BYTES = 280 * 1024 * 1024; // 280 MB across all files
export const MAX_SINGLE_FILE_BYTES = 60 * 1024 * 1024; // single-file guard (60 MB source)
export const WARN_SINGLE_FILE_BYTES = 18 * 1024 * 1024; // show "large file" notice above this

export function estimateRecordHeap(rowCount: number): number {
  return rowCount * HEAP_PER_RECORD_BYTES;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Module-level intern pool shared across all datasets */
class InternPool {
  private pool = new Map<string, string>();
  private refCount = 0;

  intern(value: string): string {
    if (!value || value.length > 120) return value; // skip very long strings
    const existing = this.pool.get(value);
    if (existing !== undefined) return existing;
    this.pool.set(value, value);
    return value;
  }

  retain(): void {
    this.refCount++;
  }

  /** Release a dataset. Pool is cleared when no datasets remain. */
  release(): void {
    this.refCount = Math.max(0, this.refCount - 1);
    if (this.refCount === 0) {
      this.pool.clear();
    }
  }

  get size(): number {
    return this.pool.size;
  }
}

export const stringPool = new InternPool();
