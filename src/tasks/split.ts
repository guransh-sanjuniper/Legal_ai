export function splitInput(input: string, minChars: number): [string, string] | null {
  if (input.length < minChars * 2) return null;
  const mid = Math.floor(input.length / 2);
  const before = input.lastIndexOf('\n', mid);
  const after = input.indexOf('\n', mid);
  let cut = mid;
  if (before >= 0 && after >= 0) cut = mid - before <= after - mid ? before : after;
  else if (before >= 0) cut = before;
  else if (after >= 0) cut = after;
  const a = input.slice(0, cut);
  const b = input.slice(cut);
  if (a.length < minChars || b.length < minChars) return null;
  return [a, b];
}
