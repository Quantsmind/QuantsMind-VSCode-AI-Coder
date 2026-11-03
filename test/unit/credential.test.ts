import { expect } from 'chai';
import {
  CredentialValidationError,
  MAX_CREDENTIAL_LENGTH,
  validateCredential,
} from '../../src/security/credential';

function expectRejected(value: unknown): void {
  expect(() => validateCredential(value)).to.throw(CredentialValidationError);
}

suite('credential validation', () => {
  test('trims surrounding whitespace', () => {
    expect(validateCredential('  sk-test-credential  ')).to.equal('sk-test-credential');
  });

  test('rejects non-string values', () => {
    expectRejected(undefined);
    expectRejected(null);
    expectRejected(42);
    expectRejected({ key: 'value' });
  });

  test('rejects empty and whitespace-only values', () => {
    expectRejected('');
    expectRejected('    ');
  });

  test('rejects internal whitespace and control characters', () => {
    expectRejected('abc def');
    expectRejected('abc\ndef');
    expectRejected('abc\u0000def');
  });

  test('rejects credentials above the maximum length', () => {
    expect(() => validateCredential('a'.repeat(MAX_CREDENTIAL_LENGTH))).to.not.throw();
    expectRejected('a'.repeat(MAX_CREDENTIAL_LENGTH + 1));
  });
});
