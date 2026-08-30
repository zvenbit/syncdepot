export type JsonChange = {
  path: string;
  kind: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
};

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const segment = (value: string): string => value.replace(/~/g, '~0').replace(/\//g, '~1');

export function deepJsonDiff(from: unknown, to: unknown, maximumChanges = 1_000): {
  changes: JsonChange[];
  truncated: boolean;
} {
  const changes: JsonChange[] = [];
  let truncated = false;

  const add = (change: JsonChange) => {
    if (changes.length >= maximumChanges) {
      truncated = true;
      return;
    }
    changes.push(change);
  };

  const visit = (before: unknown, after: unknown, path: string): void => {
    if (truncated || Object.is(before, after)) return;
    if (object(before) && object(after)) {
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const child = `${path}/${segment(key)}`;
        if (!(key in before)) add({ path: child, kind: 'added', after: after[key] });
        else if (!(key in after)) add({ path: child, kind: 'removed', before: before[key] });
        else visit(before[key], after[key], child);
      }
      return;
    }
    if (Array.isArray(before) && Array.isArray(after)) {
      const length = Math.max(before.length, after.length);
      for (let index = 0; index < length; index += 1) {
        const child = `${path}/${index}`;
        if (index >= before.length) add({ path: child, kind: 'added', after: after[index] });
        else if (index >= after.length) add({ path: child, kind: 'removed', before: before[index] });
        else visit(before[index], after[index], child);
      }
      return;
    }
    add({ path: path || '/', kind: 'changed', before, after });
  };

  visit(from, to, '');
  return { changes, truncated };
}
