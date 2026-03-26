export interface NormalizeGeneratedTitleOptions {
  maxLength?: number;
  maxWords?: number;
  preferCompactSegment?: boolean;
}

const DEFAULT_MAX_LENGTH = 60;
const CHAT_TITLE_MAX_LENGTH = 36;
const CHAT_TITLE_MAX_WORDS = 8;
const TITLE_TRUNCATION_BOUNDARY_WINDOW = 12;

const GENERIC_REQUEST_PREFIX_RE = /^(?:(?:please\s+)?(?:help me|can you|could you|would you|i need(?: you)? to|i want(?: you)? to|let'?s)\s+|(?:请问|请(?:帮我|你)?|帮我|麻烦(?:你)?|可以(?:帮我)?|能不能(?:帮我)?|我想(?:让你)?|想让你|帮忙)\s*)/i;
const GENERIC_COLON_PREFIX_HINT_RE = /(?:请|帮我|麻烦|请你|可以|能不能|我想|想让你|看看|看下|报错|错误|总结|分析|解释|review|help|can you|could you|would you|summari[sz]e|explain|fix|debug)/i;

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function stripTitleDecorations(value: string) {
  return value
    .replace(/^(?:[#>*-]+\s+|\d+[.)]\s+)+/, '')
    .replace(/^[`"'“”‘’]+/, '')
    .replace(/[`"'“”‘’]+$/, '')
    .trim();
}

function cleanTitleCandidate(value: string) {
  return normalizeWhitespace(
    stripTitleDecorations(value)
      .replace(/[,:;，、：；\-–—]+$/g, '')
      .trim(),
  );
}

function trimGenericRequestPrefix(value: string) {
  let candidate = value.trim();
  for (let index = 0; index < 3; index += 1) {
    const next = candidate.replace(GENERIC_REQUEST_PREFIX_RE, '').trimStart();
    if (next === candidate) {
      break;
    }
    candidate = next;
  }
  return candidate;
}

function takeFirstNonEmptyLine(value: string) {
  const lines = value
    .split(/\r?\n/)
    .map((entry) => normalizeWhitespace(entry))
    .filter(Boolean);
  return lines[0] ?? value;
}

function preferSuffixAfterGenericColon(value: string) {
  const match = value.match(/^([^:：]{1,20})[:：]\s*(.+)$/);
  if (!match) {
    return value;
  }

  const prefix = match[1]?.trim() ?? '';
  const suffix = match[2]?.trim() ?? '';
  if (!suffix || !GENERIC_COLON_PREFIX_HINT_RE.test(prefix)) {
    return value;
  }

  return suffix;
}

function firstSegment(value: string, pattern: RegExp) {
  const segments = value
    .split(pattern)
    .map((entry) => cleanTitleCandidate(entry))
    .filter(Boolean);
  return segments[0] ?? null;
}

function preferCompactSegment(value: string, maxLength: number) {
  let candidate = takeFirstNonEmptyLine(value);
  candidate = preferSuffixAfterGenericColon(candidate);

  const sentence = firstSegment(candidate, /[。！？!?；;]+/);
  if (sentence) {
    candidate = sentence;
  }

  if (candidate.length > maxLength) {
    const clause = firstSegment(candidate, /(?:\s+-\s+|，|,|、)/);
    if (clause && clause.length >= Math.min(12, maxLength)) {
      candidate = clause;
    }
  }

  return candidate;
}

function limitWordCount(value: string, maxWords: number | undefined) {
  if (!maxWords || !/\s/.test(value)) {
    return value;
  }

  const words = value.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) {
    return value;
  }

  return words.slice(0, maxWords).join(' ');
}

function truncateTitle(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  let truncated = value.slice(0, maxLength).trimEnd();
  const boundaryCandidates = [
    truncated.lastIndexOf(' '),
    truncated.lastIndexOf('/'),
    truncated.lastIndexOf('-'),
  ];
  const boundary = Math.max(...boundaryCandidates);

  if (boundary >= Math.max(8, maxLength - TITLE_TRUNCATION_BOUNDARY_WINDOW)) {
    truncated = truncated.slice(0, boundary).trimEnd();
  }

  truncated = truncated.replace(/[,:;，、：；\-–—]+$/g, '').trimEnd();
  return truncated ? `${truncated}…` : `${value.slice(0, maxLength).trimEnd()}…`;
}

export function normalizeGeneratedTitle(
  value: string | null | undefined,
  options: NormalizeGeneratedTitleOptions = {},
) {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  let candidate = cleanTitleCandidate(value ?? '');

  if (!candidate) {
    return null;
  }

  if (options.preferCompactSegment) {
    candidate = preferCompactSegment(candidate, maxLength);
  }

  candidate = cleanTitleCandidate(preferSuffixAfterGenericColon(trimGenericRequestPrefix(candidate)));
  candidate = cleanTitleCandidate(limitWordCount(candidate, options.maxWords));

  if (!candidate) {
    return null;
  }

  return truncateTitle(candidate, maxLength);
}

export function normalizeChatGeneratedTitle(value: string | null | undefined) {
  return normalizeGeneratedTitle(value, {
    maxLength: CHAT_TITLE_MAX_LENGTH,
    maxWords: CHAT_TITLE_MAX_WORDS,
    preferCompactSegment: true,
  });
}
