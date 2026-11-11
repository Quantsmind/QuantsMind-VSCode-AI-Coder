import { expect } from 'chai';
import {
  isTrusted,
  RESTRICTED_MODE_ACTION_NOTICE,
  RESTRICTED_MODE_FEATURE_NOTICE,
  RESTRICTED_MODE_REPLAY_NOTICE,
} from '../../src/security/workspaceTrust';

suite('workspace trust decisions', () => {
  test('a missing check fails closed', () => {
    expect(isTrusted(undefined)).to.equal(false);
  });

  test('only an exact `true` grants trust', () => {
    expect(isTrusted(() => true)).to.equal(true);
    expect(isTrusted(() => false)).to.equal(false);
    expect(isTrusted(() => 1 as unknown as boolean)).to.equal(false);
    expect(isTrusted(() => 'true' as unknown as boolean)).to.equal(false);
    expect(isTrusted(() => undefined as unknown as boolean)).to.equal(false);
  });

  test('a check that throws fails closed instead of denying loudly or granting silently', () => {
    expect(
      isTrusted(() => {
        throw new Error('host trust API unavailable');
      }),
    ).to.equal(false);
  });

  test('reads the check on every call instead of caching a decision', () => {
    let trusted = true;
    const check = (): boolean => trusted;

    expect(isTrusted(check)).to.equal(true);
    trusted = false;
    expect(isTrusted(check)).to.equal(false);
  });

  test('restricted-mode notices name the boundary without paths or credentials', () => {
    const notices = [
      RESTRICTED_MODE_FEATURE_NOTICE,
      RESTRICTED_MODE_ACTION_NOTICE,
      RESTRICTED_MODE_REPLAY_NOTICE,
    ];

    for (const notice of notices) {
      expect(notice).to.contain('Restricted Mode');
      expect(notice).to.not.match(/[A-Za-z]:\\|\/home\/|sk-[A-Za-z0-9]/);
    }
    expect(RESTRICTED_MODE_FEATURE_NOTICE).to.contain('attach yourself');
    expect(RESTRICTED_MODE_REPLAY_NOTICE).to.contain('withheld');
  });
});
