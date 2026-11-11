import { expect } from 'chai';
import {
  LANGUAGE_REGISTRY,
  detectLanguageForPath,
  getLanguageCapability,
  knownLanguageIds,
} from '../../src/languages/registry';

const ALL_EXTENSIONS: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  pyi: 'python',
  java: 'java',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hh: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  cs: 'csharp',
  go: 'go',
  rs: 'rust',
  php: 'php',
  phtml: 'php',
  rb: 'ruby',
  rake: 'ruby',
  gemspec: 'ruby',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  sql: 'sql',
  html: 'web',
  htm: 'web',
  css: 'web',
  scss: 'web',
  sass: 'web',
  less: 'web',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  toml: 'toml',
  kark: 'karkain',
};

suite('language capability registry', () => {
  test('covers the mission-listed language families', () => {
    const ids = new Set(knownLanguageIds());
    const required = [
      'typescript', 'javascript', 'python', 'java', 'c', 'cpp', 'csharp', 'go',
      'rust', 'php', 'ruby', 'kotlin', 'swift', 'sql', 'web', 'shell', 'yaml',
      'json', 'toml', 'karkain',
    ];
    for (const id of required) {
      expect(ids.has(id), `registry is missing ${id}`).to.equal(true);
    }
    // No duplicates.
    expect(knownLanguageIds().length).to.equal(LANGUAGE_REGISTRY.length);
  });

  test('every registry entry carries the required capability metadata', () => {
    for (const entry of LANGUAGE_REGISTRY) {
      expect(entry.id.length).to.be.greaterThan(0);
      expect(entry.displayName.length).to.be.greaterThan(0);
      expect(entry.extensions.length).to.be.greaterThan(0);
      expect(entry.manifests.length).to.be.greaterThan(0);
      expect(entry.guidance.length).to.be.greaterThan(0);
      expect(['source', 'query', 'markup', 'script', 'config']).to.include(entry.kind);
      expect(['analysis', 'detection']).to.include(entry.qualification);
      for (const extension of entry.extensions) {
        expect(extension, `extension of ${entry.id}`).to.equal(extension.toLowerCase());
      }
    }
  });

  test('detects a language for every documented extension', () => {
    for (const [extension, id] of Object.entries(ALL_EXTENSIONS)) {
      const capability = detectLanguageForPath(`src/file.${extension}`);
      expect(capability?.id, `extension ${extension}`).to.equal(id);
    }
  });

  test('compound extensions take precedence (d.ts -> typescript)', () => {
    expect(detectLanguageForPath('types.d.ts')?.id).to.equal('typescript');
    expect(detectLanguageForPath('src/deep/api.d.ts')?.id).to.equal('typescript');
  });

  test('unknown extensions and extensionless files degrade to undefined', () => {
    expect(detectLanguageForPath('notes.xyz123')).to.equal(undefined);
    expect(detectLanguageForPath('Makefile')).to.equal(undefined);
    expect(detectLanguageForPath('')).to.equal(undefined);
    expect(detectLanguageForPath('src/file.')).to.equal(undefined);
  });

  test('detection is case-insensitive', () => {
    expect(detectLanguageForPath('SRC/APP.TS')?.id).to.equal('typescript');
    expect(detectLanguageForPath('Config.YAML')?.id).to.equal('yaml');
  });

  test('unknown languages do not throw and report no capability', () => {
    expect(getLanguageCapability('cobol')).to.equal(undefined);
    expect(getLanguageCapability('TypeScript')?.id).to.equal('typescript');
  });
});
