export type SecretReference = `${string}://${string}`;

export type SecretBackend = {
  resolve(reference: SecretReference): Promise<string>;
};
