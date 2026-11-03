export const MAX_CREDENTIAL_LENGTH = 8192;

export class CredentialValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialValidationError';
  }
}

/**
 * Validates and normalizes an API key before it is stored or used.
 * The raw credential is never logged or echoed back.
 */
export function validateCredential(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new CredentialValidationError('The API key must be text.');
  }

  const value = raw.trim();

  if (value.length === 0) {
    throw new CredentialValidationError('The API key cannot be empty.');
  }
  if (value.length > MAX_CREDENTIAL_LENGTH) {
    throw new CredentialValidationError(
      `The API key is too long (maximum ${MAX_CREDENTIAL_LENGTH} characters).`,
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new CredentialValidationError('The API key must not contain control characters.');
  }
  if (/\s/.test(value)) {
    throw new CredentialValidationError('The API key must not contain whitespace.');
  }

  return value;
}
