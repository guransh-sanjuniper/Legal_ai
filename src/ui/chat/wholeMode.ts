// The whole-document scan is offered only for short documents. Page count comes from the stored
// document record; an unknown count is treated as too long (fail closed).
const configured = Number(import.meta.env.VITE_WHOLE_DOC_MAX_PAGES);

export const WHOLE_DOC_MAX_PAGES =
  Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 10;

export function wholeModeAllowed(pageCount: number | null | undefined, max: number): boolean {
  return (
    typeof pageCount === 'number' &&
    Number.isFinite(pageCount) &&
    pageCount > 0 &&
    pageCount <= max
  );
}
