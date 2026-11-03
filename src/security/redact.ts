const REDACTED = '[REDACTED]';

export interface RedactionResult {
  readonly text: string;
  readonly count: number;
}

interface ReplacementRule {
  readonly pattern: RegExp;
  readonly replace: string | ((...args: string[]) => string);
}

const RULES: readonly ReplacementRule[] = [
  // Providers often echo a partially masked key (for example `sk-abc***wxyz`
  // or `sk-...1234`). These shapes are shorter than a full key and contain
  // mask characters, so they must be handled before the full-key rules below.
  {
    pattern:
      /\bBearer\s+[A-Za-z0-9._~+/=-]{0,60}(?:\*{2,}|…+|\.{3,}|•{1,})[A-Za-z0-9._~+/=-]{0,60}(?![A-Za-z0-9._~+/=-])/gi,
    replace: `Bearer ${REDACTED}`,
  },
  {
    pattern:
      /\bsk-[A-Za-z0-9_-]{0,60}(?:\*{2,}|…+|\.{3,}|•{1,})[A-Za-z0-9_-]{0,60}(?![A-Za-z0-9_-])/gi,
    replace: REDACTED,
  },
  {
    pattern:
      /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|x-api-key)(\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{0,60}(?:\*{2,}|…+|\.{3,}|•{1,})[A-Za-z0-9._~+/=-]{0,60}/gi,
    replace: (_match, name, separator) => `${name}${separator}${REDACTED}`,
  },
  {
    pattern:
      /("(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|password|secret)"\s*:\s*")([^"\n]*?(?:\*{2,}|…+|\.{3,})[^"\n]*?)(")/gi,
    replace: (_match, prefix, _value, quote) => `${prefix}${REDACTED}${quote}`,
  },
  {
    pattern: /\b[A-Za-z0-9_-]{4,}(?:\*{2,}|•{2,})[A-Za-z0-9_-]{4,}\b/g,
    replace: REDACTED,
  },
  { pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, replace: REDACTED },
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
    replace: (_match, scheme) => `${scheme}${REDACTED}@`,
  },
  {
    pattern: /\b(x-api-key\s*[:=]\s*)([^\s,;]{4,})/gi,
    replace: (_match, prefix) => `${prefix}${REDACTED}`,
  },
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replace: REDACTED },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: REDACTED },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replace: REDACTED },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: REDACTED },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replace: REDACTED },
  { pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g, replace: REDACTED },
  {
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: '[REDACTED PRIVATE KEY]',
  },
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    replace: `Bearer ${REDACTED}`,
  },
  {
    pattern:
      /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret)(\s*[:=]\s*)(["'])([^"'\n]{8,})\3/gi,
    replace: (_match, name, separator, quote) => `${name}${separator}${quote}${REDACTED}${quote}`,
  },
  {
    pattern:
      /("(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|password|secret)"\s*:\s*")([^"\n]{8,})"/gi,
    replace: (_match, prefix) => `${prefix}${REDACTED}"`,
  },
  {
    pattern: /(Authorization\s*:\s*)(?!\s*Bearer\b)[^\r\n,;]{8,}/gi,
    replace: (_match, prefix) => `${prefix}${REDACTED}`,
  },
];

function replaceLiteral(text: string, secret: string): { text: string; count: number } {
  const parts = text.split(secret);
  if (parts.length === 1) {
    return { text, count: 0 };
  }
  return { text: parts.join(REDACTED), count: parts.length - 1 };
}

/**
 * Removes configured credential values and well-known secret shapes from text.
 * Context attached to a model and every log line pass through this function.
 */
export function redactSecrets(
  text: string,
  extraSecrets: readonly (string | undefined | null)[] = [],
): RedactionResult {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: '', count: 0 };
  }

  let result = text;
  let count = 0;

  for (const candidate of extraSecrets) {
    const secret = typeof candidate === 'string' ? candidate.trim() : '';
    if (secret.length < 3) {
      continue;
    }
    const replaced = replaceLiteral(result, secret);
    result = replaced.text;
    count += replaced.count;
  }

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    result = result.replace(rule.pattern, (...args: unknown[]) => {
      count += 1;
      if (typeof rule.replace === 'function') {
        return (rule.replace as (...inner: string[]) => string)(
          ...(args as string[]),
        );
      }
      return rule.replace;
    });
  }

  return { text: result, count };
}
