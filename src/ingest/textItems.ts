export interface TextItemLike {
  str: string;
  transform: number[];
  hasEOL?: boolean;
}

const LINE_TOLERANCE = 2;

export function itemsToText(items: TextItemLike[]): string {
  const lines: string[] = [];
  let current = '';
  let lastY: number | null = null;
  for (const item of items) {
    if (!item.str && !item.hasEOL) continue;
    const y = item.transform[5];
    if (lastY !== null && Math.abs(y - lastY) > LINE_TOLERANCE) {
      lines.push(current);
      current = '';
    }
    current += item.str;
    if (item.hasEOL) {
      lines.push(current);
      current = '';
      lastY = null;
    } else {
      lastY = y;
    }
  }
  if (current) lines.push(current);
  return lines.map((l) => l.replace(/\s+$/g, '')).join('\n').replace(/\n{3,}/g, '\n\n');
}
