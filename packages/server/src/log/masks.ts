export const minimumMaskLength = 8;

const byPrefix = new Map<string, string[]>();

export function maskSecretValue(value: string): void {
  if (value.length < minimumMaskLength) return;
  const prefix = value.slice(0, minimumMaskLength);
  const values = byPrefix.get(prefix) ?? [];
  if (values.includes(value)) return;
  values.push(value);
  values.sort((a, b) => b.length - a.length);
  byPrefix.set(prefix, values);
}

export function maskKnownValues(text: string, replacement: string): string {
  if (byPrefix.size === 0 || text.length < minimumMaskLength) return text;
  let result = "";
  let copied = 0;
  let spanStart = -1;
  let spanEnd = -1;
  for (let i = 0; i + minimumMaskLength <= text.length; i += 1) {
    const values = byPrefix.get(text.slice(i, i + minimumMaskLength));
    const found = values?.find((value) => text.startsWith(value, i));
    if (found === undefined) continue;
    if (i > spanEnd) {
      if (spanStart >= 0) {
        result += text.slice(copied, spanStart) + replacement;
        copied = spanEnd;
      }
      spanStart = i;
    }
    spanEnd = Math.max(spanEnd, i + found.length);
  }
  if (spanStart < 0) return text;
  return (
    result + text.slice(copied, spanStart) + replacement + text.slice(spanEnd)
  );
}
