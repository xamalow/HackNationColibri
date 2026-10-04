/** Convert adapter-level write conflicts into a safe owner-facing approval refusal. */
export function isApprovalConflict(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_(BUSY|LOCKED|CONSTRAINT)/i.test(code)
    || /database (?:is|table is) locked|(?:unique )?constraint failed/i.test(message);
}
