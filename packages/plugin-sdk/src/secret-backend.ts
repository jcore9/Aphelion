/** A secret reference, such as `op://vault/item/field`. It is a scheme, then `://`, then the path. */
export type SecretReference = `${string}://${string}`;

/** What a secret backend plugin implements for the schemes it lists in `contributes.secretSchemes`. The deployed server doesn't call secret backends yet. */
export type SecretBackend = {
  /** Returns the secret's value for a reference, or throws if it can't. The value goes only to the secrets broker. */
  resolve(reference: SecretReference): Promise<string>;
};
