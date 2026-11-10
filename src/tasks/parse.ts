export type ParseResult = { items: unknown[]; rejected: number } | { error: 'bad_json' | 'validation' };

export function parseItems(text: string, validate: (item: unknown) => boolean): ParseResult {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let data: unknown;
  try {
    data = JSON.parse(cleaned);
  } catch {
    return { error: 'bad_json' };
  }
  if (!Array.isArray(data)) return { error: 'bad_json' };
  const items = data.filter(validate);
  if (data.length > 0 && items.length === 0) return { error: 'validation' };
  return { items, rejected: data.length - items.length };
}
