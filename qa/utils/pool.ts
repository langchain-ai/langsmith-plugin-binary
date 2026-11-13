export async function forEachInParallel<T>(
  items: T[],
  limit: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const queue = items.entries();
  const lane = async () => {
    for (const [index, item] of queue) await work(item, index);
  };
  await Promise.all(Array.from({ length: limit }, lane));
}
