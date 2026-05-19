export function now(): number {
  return Date.now();
}

export function cutoff<T extends { ts: number }>(items: T[], ms: number): T[] {
  const threshold = now() - ms;
  return items.filter((item) => item.ts >= threshold);
}
