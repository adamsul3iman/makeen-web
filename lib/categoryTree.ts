import { normalizeArabicText } from "@/lib/arabic";

export interface HierarchyItemLike {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder?: number;
}

export interface FlattenedHierarchyNode<T extends HierarchyItemLike> {
  item: T;
  depth: number;
  pathIds: string[];
  pathNames: string[];
}

export interface CategorySearchResult<T extends HierarchyItemLike> {
  item: T;
  pathNames: string[];
  score: number;
}

function sortOrderOf(item: HierarchyItemLike): number {
  return typeof item.sortOrder === "number" ? item.sortOrder : Number.MAX_SAFE_INTEGER;
}

export function compareHierarchyItems<T extends HierarchyItemLike>(a: T, b: T): number {
  const bySort = sortOrderOf(a) - sortOrderOf(b);
  if (bySort !== 0) return bySort;
  return a.name.localeCompare(b.name, "ar");
}

export function buildChildrenByParent<T extends { id: string; parentId: string | null }>(
  items: Iterable<T>,
): Map<string, T[]> {
  const childrenByParent = new Map<string, T[]>();
  for (const item of items) {
    if (!item.parentId) continue;
    const children = childrenByParent.get(item.parentId) ?? [];
    children.push(item);
    childrenByParent.set(item.parentId, children);
  }
  return childrenByParent;
}

export function collectDescendantIds<T extends { id: string; parentId: string | null }>(
  items: Iterable<T>,
  rootId: string,
): Set<string> {
  const childrenByParent = buildChildrenByParent(items);
  const descendants = new Set<string>();
  const stack = [rootId];

  while (stack.length > 0) {
    const currentId = stack.pop()!;
    for (const child of childrenByParent.get(currentId) ?? []) {
      if (descendants.has(child.id)) continue;
      descendants.add(child.id);
      stack.push(child.id);
    }
  }

  return descendants;
}

export function flattenHierarchy<T extends HierarchyItemLike>(
  items: T[],
): Array<FlattenedHierarchyNode<T>> {
  const byId = new Map(items.map((item) => [item.id, item] as const));
  const childrenByParent = buildChildrenByParent(items);
  for (const children of childrenByParent.values()) {
    children.sort(compareHierarchyItems);
  }

  const roots = items
    .filter((item) => !item.parentId || !byId.has(item.parentId))
    .sort(compareHierarchyItems);

  const visited = new Set<string>();
  const flattened: Array<FlattenedHierarchyNode<T>> = [];

  const visit = (item: T, depth: number, pathIds: string[], pathNames: string[]) => {
    if (visited.has(item.id)) return;
    visited.add(item.id);

    const nextPathIds = [...pathIds, item.id];
    const nextPathNames = [...pathNames, item.name];
    flattened.push({
      item,
      depth,
      pathIds: nextPathIds,
      pathNames: nextPathNames,
    });

    for (const child of childrenByParent.get(item.id) ?? []) {
      visit(child, depth + 1, nextPathIds, nextPathNames);
    }
  };

  for (const root of roots) {
    visit(root, 0, [], []);
  }

  for (const item of [...items].sort(compareHierarchyItems)) {
    if (!visited.has(item.id)) {
      visit(item, 0, [], []);
    }
  }

  return flattened;
}

/** Arabic-safe ranked search across both category names and full paths. */
export function searchCategoryHierarchy<T extends HierarchyItemLike>(
  items: T[],
  query: string,
  options?: {
    limit?: number;
    include?: (item: T) => boolean;
  },
): Array<CategorySearchResult<T>> {
  const needle = normalizeArabicText(query.trim());
  if (!needle) return [];
  const tokens = needle.split(/\s+/).filter(Boolean);

  const limit = Math.max(1, options?.limit ?? 8);
  const include = options?.include ?? (() => true);
  const results: Array<CategorySearchResult<T>> = [];

  for (const node of flattenHierarchy(items)) {
    if (!include(node.item)) continue;
    const name = normalizeArabicText(node.item.name);
    const path = normalizeArabicText(node.pathNames.join(" "));
    const pathMatchesAllTokens = tokens.every((token) => path.includes(token));
    const score =
      name === needle
        ? 0
        : name.startsWith(needle)
          ? 1
          : name.includes(needle)
            ? 2
            : path.includes(needle) || pathMatchesAllTokens
              ? 3
              : -1;
    if (score >= 0) {
      results.push({ item: node.item, pathNames: node.pathNames, score });
    }
  }

  return results
    .sort(
      (a, b) =>
        a.score - b.score ||
        a.pathNames.length - b.pathNames.length ||
        compareHierarchyItems(a.item, b.item),
    )
    .slice(0, limit);
}
