/**
 * Split a dense array into fixed-size chunks (last chunk may be smaller).
 */
export function chunkArray<T>(items: readonly T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) {
    throw new Error("chunkSize must be positive");
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    out.push(items.slice(i, i + chunkSize) as T[]);
  }
  return out;
}

export function chunkNumberForRowIndex(rowIndex: number, chunkSize: number): number {
  return Math.floor(rowIndex / chunkSize);
}
