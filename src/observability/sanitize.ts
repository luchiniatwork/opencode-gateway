export function sanitizeDiagnosticUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;

  try {
    const url = new URL(value);
    const pathname = url.pathname === "/" ? "" : url.pathname;

    return `${url.protocol}//${url.host}${pathname}`;
  } catch {
    return value;
  }
}
