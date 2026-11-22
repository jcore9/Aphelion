export type ConfigIssue = {
  file: string;
  position?: { line: number; col: number };
  field?: string;
  message: string;
};

export function formatIssue({
  file,
  position,
  field,
  message,
}: ConfigIssue): string {
  const where = position
    ? `${file}:${String(position.line)}:${String(position.col)}`
    : file;
  return field ? `${where}: ${field}: ${message}` : `${where}: ${message}`;
}
