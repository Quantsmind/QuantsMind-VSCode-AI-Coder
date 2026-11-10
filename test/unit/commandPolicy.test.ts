import { expect } from 'chai';
import { evaluateCommand } from '../../src/commands/policy';

const ALLOWLIST = ['npm run compile', 'npm test', 'npm publish', 'git status'];

suite('command policy', () => {
  test('allows only exact allowlisted commands and still requires approval', () => {
    const policy = evaluateCommand('npm test', ALLOWLIST);
    expect(policy.allowed).to.equal(true);
    expect(policy.risk).to.equal('validation');
    expect(policy.requiresApproval).to.equal(true);
    expect(policy.normalized).to.equal('npm test');
  });

  test('rejects commands outside the allowlist', () => {
    const policy = evaluateCommand('npm run build', ALLOWLIST);
    expect(policy.allowed).to.equal(false);
    expect(policy.reason).to.match(/allowlist/);
  });

  test('destructive commands stay blocked even when allowlisted', () => {
    const publish = evaluateCommand('npm publish', ALLOWLIST);
    expect(publish.risk).to.equal('destructive');
    expect(publish.allowed).to.equal(false);

    const reset = evaluateCommand('git reset --hard HEAD', ALLOWLIST);
    expect(reset.risk).to.equal('destructive');
    expect(reset.allowed).to.equal(false);

    const remove = evaluateCommand('rm -rf src', ALLOWLIST);
    expect(remove.risk).to.equal('destructive');
    expect(remove.allowed).to.equal(false);
  });

  test('does not classify ordinary formatting scripts as destructive', () => {
    const policy = evaluateCommand('npm run format', ['npm run format']);
    expect(policy.risk).to.equal('validation');
    expect(policy.allowed).to.equal(true);
  });

  test('rejects shell metacharacters and non-text input', () => {
    expect(evaluateCommand('npm test && rm -rf /', ALLOWLIST).allowed).to.equal(false);
    expect(evaluateCommand(undefined as unknown as string, ALLOWLIST).allowed).to.equal(false);
  });
});
