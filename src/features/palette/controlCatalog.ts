export interface ControlCatalogItem {
  readonly name: string;
}

export function createControlCatalog(names: readonly string[]): readonly ControlCatalogItem[] {
  return Object.freeze(
    [...new Set(names)]
      .sort((left, right) => left.localeCompare(right))
      .map((name) => Object.freeze({ name })),
  );
}
