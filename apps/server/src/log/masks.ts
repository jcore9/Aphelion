export const minimumMaskLength = 8;
export const maskLimit = 10_000;

export type MaskResult = "masked" | "too short";

export class MaskListFullError extends Error {
  constructor() {
    super(
      `The secret mask list already holds ${String(maskLimit)} values. Unmask a value before masking another.`,
    );
    this.name = "MaskListFullError";
  }
}

const registrations = new Map<
  string,
  { readonly forms: readonly string[]; count: number }
>();
const formCounts = new Map<string, number>();
const byPrefix = new Map<string, string[]>();

function uriEncoded(value: string): string | undefined {
  try {
    return encodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function encodedForms(value: string): string[] {
  const forms = [
    value,
    Buffer.from(value, "utf8").toString("base64"),
    uriEncoded(value),
    JSON.stringify(value).slice(1, -1),
  ];
  return [
    ...new Set(
      forms.filter(
        (form): form is string =>
          form !== undefined && form.length >= minimumMaskLength,
      ),
    ),
  ];
}

function addForm(form: string): void {
  const count = formCounts.get(form) ?? 0;
  formCounts.set(form, count + 1);
  if (count > 0) return;
  const prefix = form.slice(0, minimumMaskLength);
  const forms = byPrefix.get(prefix) ?? [];
  const shorter = forms.findIndex((other) => other.length < form.length);
  forms.splice(shorter < 0 ? forms.length : shorter, 0, form);
  byPrefix.set(prefix, forms);
}

function removeForm(form: string): void {
  const count = (formCounts.get(form) ?? 1) - 1;
  if (count > 0) {
    formCounts.set(form, count);
    return;
  }
  formCounts.delete(form);
  const prefix = form.slice(0, minimumMaskLength);
  const forms = (byPrefix.get(prefix) ?? []).filter((other) => other !== form);
  if (forms.length > 0) byPrefix.set(prefix, forms);
  else byPrefix.delete(prefix);
}

export function maskSecretValue(value: string): MaskResult {
  if (value.length < minimumMaskLength) return "too short";
  const registration = registrations.get(value);
  if (registration !== undefined) {
    registration.count += 1;
    return "masked";
  }
  if (registrations.size >= maskLimit) throw new MaskListFullError();
  const forms = encodedForms(value);
  registrations.set(value, { forms, count: 1 });
  forms.forEach(addForm);
  return "masked";
}

export function unmaskSecretValue(value: string): void {
  const registration = registrations.get(value);
  if (registration === undefined) return;
  registration.count -= 1;
  if (registration.count > 0) return;
  registrations.delete(value);
  registration.forms.forEach(removeForm);
}

export function maskKnownValues(text: string, replacement: string): string {
  if (byPrefix.size === 0 || text.length < minimumMaskLength) return text;
  let result = "";
  let copied = 0;
  let spanStart = -1;
  let spanEnd = -1;
  for (let i = 0; i + minimumMaskLength <= text.length; i += 1) {
    const forms = byPrefix.get(text.slice(i, i + minimumMaskLength));
    const found = forms?.find((form) => text.startsWith(form, i));
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
