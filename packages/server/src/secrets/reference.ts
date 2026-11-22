export const secretSchemes = ["op", "bws", "local"] as const;

export type SecretScheme = (typeof secretSchemes)[number];

declare const parsed: unique symbol;

export interface SecretReference {
  readonly scheme: SecretScheme;
  readonly path: string;
  readonly [parsed]: true;
}

export const referenceLimit = 1024;

export const referenceReasons = {
  text: `must be text of at most ${String(referenceLimit)} characters`,
  scheme: "must start with op://, bws:// or local://",
  op: "must be op://vault/item/field or op://vault/item/section/field, each name made of letters, digits, spaces, hyphens, underscores and dots",
  opQuery:
    "may end only with ?attribute=otp, ?attribute=totp or ?ssh-format=openssh",
  bws: "must be bws:// and a Bitwarden secret ID, such as bws://64246aa4-70b3-4332-8587-8b1284ce6d76",
  local:
    "must be local:// and names made of lowercase letters, digits, dots, hyphens and underscores, separated by /, such as local://github/webhook-secret",
} as const;

export type ReferenceReason =
  (typeof referenceReasons)[keyof typeof referenceReasons];

export type ReferenceResult =
  | { readonly ok: true; readonly reference: SecretReference }
  | { readonly ok: false; readonly reason: ReferenceReason };

type PathCheck = (
  path: string,
) => { readonly path: string } | { readonly reason: ReferenceReason };

const opName = /^[A-Za-z0-9_.-](?:[A-Za-z0-9_. -]*[A-Za-z0-9_.-])?$/;
const opQueries = ["attribute=otp", "attribute=totp", "ssh-format=openssh"];
const bwsId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const localName = /^[a-z0-9][a-z0-9._-]*$/;

const checkPath: Readonly<Record<SecretScheme, PathCheck>> = {
  op: (path) => {
    const [names = "", query, ...extra] = path.split("?");
    const parts = names.split("/");
    if (
      parts.length < 3 ||
      parts.length > 4 ||
      !parts.every((part) => opName.test(part))
    ) {
      return { reason: referenceReasons.op };
    }
    if (
      extra.length > 0 ||
      (query !== undefined && !opQueries.includes(query))
    ) {
      return { reason: referenceReasons.opQuery };
    }
    return { path };
  },
  bws: (path) =>
    bwsId.test(path)
      ? { path: path.toLowerCase() }
      : { reason: referenceReasons.bws },
  local: (path) =>
    path.split("/").every((part) => localName.test(part))
      ? { path }
      : { reason: referenceReasons.local },
};

function isScheme(text: string): text is SecretScheme {
  return (secretSchemes as readonly string[]).includes(text);
}

export function parseSecretReference(text: unknown): ReferenceResult {
  if (typeof text !== "string" || text.length > referenceLimit) {
    return { ok: false, reason: referenceReasons.text };
  }
  const separator = text.indexOf("://");
  const scheme = text.slice(0, separator);
  if (separator < 0 || !isScheme(scheme)) {
    return { ok: false, reason: referenceReasons.scheme };
  }
  const checked = checkPath[scheme](text.slice(separator + 3));
  if ("reason" in checked) return { ok: false, reason: checked.reason };
  return {
    ok: true,
    reference: { scheme, path: checked.path } as SecretReference,
  };
}
