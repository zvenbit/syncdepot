export function resolveRowCount(rowLength: number, affectedRows?: number): number {
  return rowLength > 0 ? rowLength : (affectedRows ?? 0);
}
