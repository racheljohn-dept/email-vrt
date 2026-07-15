// PURPOSE: Safely turn a task name (or any string) into a filesystem-friendly piece:
// - Lowercase
// - Remove unsafe characters
// - Replace spaces with chosen separator
// - Limit length for safety on different OSes
//
// EXAMPLE:
//   sanitizeFilename("EB 21397 Staging") -> "eb-21397-staging" (default hyphens)
//   sanitizeFilename("EB 21397 Staging", false) -> "eb_21397_staging"
export function sanitizeFilename(name: string, useHyphens: boolean = true): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9\s-.]/g, '');
  const separator = useHyphens ? '-' : '_';
  return cleaned.replace(/\s+/g, separator).substring(0, 100);
}