export class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
  readonly #entriesMap: Map<K, V>;

  constructor(entries?: Iterable<readonly [K, V]>) {
    this.#entriesMap = new Map(entries);
    Object.freeze(this);
  }

  get size(): number { return this.#entriesMap.size; }
  get(key: K): V | undefined { return this.#entriesMap.get(key); }
  has(key: K): boolean { return this.#entriesMap.has(key); }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    this.#entriesMap.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }
  entries(): IterableIterator<[K, V]> { return this.#entriesMap.entries(); }
  keys(): IterableIterator<K> { return this.#entriesMap.keys(); }
  values(): IterableIterator<V> { return this.#entriesMap.values(); }
  [Symbol.iterator](): IterableIterator<[K, V]> { return this.#entriesMap.entries(); }
  get [Symbol.toStringTag](): string { return 'ReadonlyMap'; }
}
