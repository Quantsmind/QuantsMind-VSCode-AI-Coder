/**
 * Markdown link checker for the repository.
 *
 * Scans every Markdown file under the repository root and validates:
 *   - relative links to files and directories (existence check)
 *   - relative image and HTML <img> references (existence check)
 *   - anchor fragments against GitHub-style heading slugs of the target
 *     document (or of the same document for bare `#anchor` links)
 *   - repository URLs: flags stale `github.com/ajit-ai/...` references that
 *     should use the `Quantsmind` organization
 *
 * External links (http(s), mailto, protocol-relative, and other schemes) are
 * counted and listed but never fetched, so the check is deterministic and
 * free of network dependence.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative, extname, sep } from 'node:path';

/**
 * @typedef {{ file: string, line: number, target: string, reason: string }} DocsLinkIssue
 * @typedef {{ files: number, checked: number, external: number, broken: DocsLinkIssue[], staleRepoUrls: DocsLinkIssue[] }} DocsLinkReport
 */

const SKIP_DIRS = new Set([
  'node_modules',
  'out',
  'dist',
  'coverage',
  '.vscode-test',
  '.git',
  'worktrees',
  '.tmp',
  '.cache',
]);

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

/**
 * Documentation that must remain available on the default branch; removing
 * these files fails the link check so the documentation set cannot regress.
 */
const REQUIRED_DOCS = [
  'docs/AGENT_WORKFLOW.md',
  'docs/COMMAND_EXECUTION.md',
  'docs/PROJECT_INTELLIGENCE.md',
];

/** Approximates GitHub's heading slugger for this repository's docs. */
export function slugifyHeading(text) {
  const stripped = text
    .replace(/<[^>]+>/g, '') // raw HTML tags
    .replace(/`([^`]*)`/g, '$1') // inline code keeps its text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links keep their text
    .replace(/[*_~]/g, '') // emphasis markers
    .trim()
    .toLowerCase();
  const withoutPunctuation = stripped.replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '');
  return withoutPunctuation.replace(/\s/g, '-');
}

/** Collects the GitHub-style heading slugs of a Markdown document. */
export function headingSlugs(markdown) {
  const counts = new Map();
  const emitted = new Set();
  const lines = markdown.split(/\r?\n/);
  let fenced = false;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (/^\s*```/.test(line) || /^\s*~~~/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      continue;
    }
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match === null) {
      continue;
    }
    const base = slugifyHeading(match[2]);
    if (base.length === 0) {
      continue;
    }
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    emitted.add(seen === 0 ? base : `${base}-${seen}`);
  }
  return emitted;
}

function findMarkdownFiles(root) {
  const files = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(join(directory, entry.name));
        }
        continue;
      }
      if (entry.isFile() && MARKDOWN_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        files.push(join(directory, entry.name));
      }
    }
  };
  walk(root);
  return files.sort();
}

/** Masks fenced code blocks and inline code, preserving line numbering. */
function maskCodeSpans(content) {
  const lines = content.split(/\r?\n/);
  let fenced = false;
  return lines.map((line) => {
    if (/^\s*```/.test(line) || /^\s*~~~/.test(line)) {
      fenced = !fenced;
      return ' '.repeat(line.length);
    }
    if (fenced) {
      return ' '.repeat(line.length);
    }
    return line.replace(/`[^`\n]*`/g, (span) => ' '.repeat(span.length));
  });
}

const INLINE_LINK = /!?\[[^\]\n]*\]\(([^)\n]+)\)/g;
const REFERENCE_DEF = /^\s*\[([^\]^\n][^\]\n]*)\]:\s*(\S+)(?:\s+["'(].*["')])?\s*$/;
const REFERENCE_LINK = /!?\[([^\]\n]*)\]\[([^\]\n]*)\]/g;
const IMAGE_HTML = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
const ANCHOR_HTML = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;

function splitInlineTarget(raw) {
  let target = raw.trim();
  if (target.startsWith('<')) {
    const closing = target.indexOf('>');
    if (closing > 0) {
      return target.slice(1, closing).trim();
    }
  }
  const titleMatch = /^(\S+)\s+["'(].*["')]$/.exec(target);
  if (titleMatch !== null) {
    target = titleMatch[1];
  }
  return target;
}

function isExternalTarget(target) {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) {
    return true; // scheme present: https:, mailto:, data:, …
  }
  return target.startsWith('//');
}

function splitPathAndAnchor(target) {
  const hashIndex = target.indexOf('#');
  if (hashIndex === -1) {
    return { path: target };
  }
  return { path: target.slice(0, hashIndex), anchor: target.slice(hashIndex + 1) };
}

function safeStat(candidate) {
  try {
    return statSync(candidate);
  } catch {
    return undefined;
  }
}

function relativePosix(root, file) {
  const relativePath = relative(root, file);
  return sep === '/' ? relativePath : relativePath.split(sep).join('/');
}

/**
 * Checks the repository's Markdown files and returns a structured report.
 * `root` must be the repository root.
 */
export function checkDocsLinks(root) {
  const absoluteRoot = resolve(root);
  const files = findMarkdownFiles(absoluteRoot);
  const broken = [];

  // Required documentation must exist in the real repository; bare fixture
  // roots (used by the test-suite) are not held to this requirement.
  const isRepository = (() => {
    try {
      statSync(join(absoluteRoot, 'package.json'));
      return true;
    } catch {
      return false;
    }
  })();
  if (isRepository) {
    for (const required of REQUIRED_DOCS) {
      try {
        const stat = statSync(join(absoluteRoot, required));
        if (!stat.isFile()) {
          broken.push({ file: '(repository)', line: 0, target: required, reason: 'required documentation file is missing' });
        }
      } catch {
        broken.push({ file: '(repository)', line: 0, target: required, reason: 'required documentation file is missing' });
      }
    }
  }

  const staleRepoUrls = [];
  const externalUrls = new Set();
  let checked = 0;

  const headingCache = new Map();
  const slugsFor = (absoluteFile) => {
    let slugs = headingCache.get(absoluteFile);
    if (slugs === undefined) {
      let content;
      try {
        content = readFileSync(absoluteFile, 'utf8');
      } catch {
        content = '';
      }
      slugs = headingSlugs(content);
      headingCache.set(absoluteFile, slugs);
    }
    return slugs;
  };

  const validateTarget = (file, line, rawTarget) => {
    const target = splitInlineTarget(rawTarget);
    const relFile = relativePosix(absoluteRoot, file);
    if (target.length === 0) {
      broken.push({ file: relFile, line, target: rawTarget.trim(), reason: 'empty link target' });
      return;
    }
    if (isExternalTarget(target)) {
      externalUrls.add(target);
      return;
    }
    let decoded;
    try {
      decoded = decodeURIComponent(target);
    } catch {
      decoded = target;
    }
    const { path: pathPart, anchor } = splitPathAndAnchor(decoded);
    const pathWithoutQuery = pathPart.split('?')[0];

    if (pathWithoutQuery.length === 0) {
      // Bare "#anchor" link into the same document.
      checked += 1;
      if (anchor === undefined || !slugsFor(file).has(anchor)) {
        broken.push({ file: relFile, line, target, reason: `missing anchor #${anchor ?? ''}` });
      }
      return;
    }

    const candidate = resolve(dirname(file), pathWithoutQuery);
    const stat = safeStat(candidate);
    checked += 1;
    if (stat === undefined) {
      broken.push({ file: relFile, line, target, reason: 'file does not exist' });
      return;
    }
    if (
      anchor !== undefined &&
      stat.isFile() &&
      extname(candidate).toLowerCase() === '.md'
    ) {
      if (!slugsFor(candidate).has(anchor)) {
        broken.push({
          file: relFile,
          line,
          target,
          reason: `missing anchor #${anchor} in ${relativePosix(absoluteRoot, candidate)}`,
        });
      }
    }
  };

  for (const file of files) {
    const relFile = relativePosix(absoluteRoot, file);
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const masked = maskCodeSpans(content);

    // Repository URL consistency: stale organization reference.
    for (let index = 0; index < masked.length; index += 1) {
      const stale = /github\.com\/ajit-ai\//i.exec(masked[index]);
      if (stale !== null) {
        staleRepoUrls.push({
          file: relFile,
          line: index + 1,
          target: stale[0],
          reason: 'stale organization; use github.com/Quantsmind/',
        });
      }
    }

    // Reference definitions, harvested first and line based.
    const definitions = new Map();
    for (const rawLine of masked) {
      const match = REFERENCE_DEF.exec(rawLine);
      if (match !== null) {
        definitions.set(match[1].trim().toLowerCase(), match[2].trim());
      }
    }

    for (let index = 0; index < masked.length; index += 1) {
      const line = masked[index];
      const lineNumber = index + 1;

      INLINE_LINK.lastIndex = 0;
      let match;
      while ((match = INLINE_LINK.exec(line)) !== null) {
        validateTarget(file, lineNumber, match[1]);
      }

      REFERENCE_LINK.lastIndex = 0;
      while ((match = REFERENCE_LINK.exec(line)) !== null) {
        const key = (match[2].length > 0 ? match[2] : match[1]).trim().toLowerCase();
        if (key.startsWith('^')) {
          continue; // footnote reference, not a link
        }
        const definition = definitions.get(key);
        if (definition === undefined) {
          broken.push({
            file: relFile,
            line: lineNumber,
            target: `[${key}]`,
            reason: 'undefined reference link',
          });
          continue;
        }
        validateTarget(file, lineNumber, definition);
      }

      IMAGE_HTML.lastIndex = 0;
      while ((match = IMAGE_HTML.exec(line)) !== null) {
        validateTarget(file, lineNumber, match[1]);
      }

      ANCHOR_HTML.lastIndex = 0;
      while ((match = ANCHOR_HTML.exec(line)) !== null) {
        validateTarget(file, lineNumber, match[1]);
      }
    }
  }

  return {
    files: files.length,
    checked,
    external: externalUrls.size,
    broken,
    staleRepoUrls,
  };
}
