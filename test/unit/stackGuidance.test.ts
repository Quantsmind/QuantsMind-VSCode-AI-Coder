import { expect } from 'chai';
import { buildStackGuidance } from '../../src/agent/stackGuidance';

suite('stack guidance', () => {
  test('returns empty when there is no evidence', () => {
    expect(buildStackGuidance({})).to.equal('');
    expect(buildStackGuidance({ languages: [] })).to.equal('');
  });

  test('names detected languages, package manager and Karkain posture', () => {
    const guidance = buildStackGuidance({
      languages: [
        { name: 'TypeScript', files: 42 },
        { name: 'Karkain', files: 3 },
      ],
      packageManager: 'npm',
      hasKarkain: true,
    });

    expect(guidance).to.contain('TypeScript (42)');
    expect(guidance).to.contain('Karkain (3)');
    expect(guidance).to.contain('Package manager: npm');
    expect(guidance).to.contain('get_karkain_project');
  });

  test('bounds the guidance block', () => {
    const languages = Array.from({ length: 12 }, (_, index) => ({ name: `Lang${index}`, files: index }));
    const guidance = buildStackGuidance({ languages });

    expect(guidance.length).to.be.lessThanOrEqual(1_200);
    expect(guidance).to.contain('Lang0');
  });
});
