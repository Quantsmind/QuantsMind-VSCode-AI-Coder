import { expect } from 'chai';
import {
  isTrusted,
  RESTRICTED_MODE_ACTION_NOTICE,
  RESTRICTED_MODE_FEATURE_NOTICE,
  RESTRICTED_MODE_REPLAY_NOTICE,
} from '../../src/security/workspaceTrust';

suite('workspace trust decisions', () => {
  test('uses the supplied check and fails open only when none is supplied', () => {
    expect(isTrusted(() => true)).to.equal(true);
    expect(isTrusted(() => false)).to.equal(false);
    expect(isTrusted(undefined)).to.equal(true);
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
