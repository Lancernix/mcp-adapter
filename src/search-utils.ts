// search-utils.ts — Shared search tokenizer and utilities

const zhSegmenter: Intl.Segmenter | null =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter("zh", { granularity: "word" })
    : null;

export function normalizeForSearch(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[-_./:\s]+/g, " ");
}

function isWeakSearchToken(token: string): boolean {
  if (!token) return true;
  if (/^[一-鿿]$/.test(token)) return true;
  if (/^[a-z0-9]$/i.test(token)) return true;
  return false;
}

export function tokenizeForSearch(
  text: string,
  options: { unique?: boolean } = { unique: true },
): string[] {
  const normalized = normalizeForSearch(text);
  const tokens: string[] = [];

  // 1. 英文、数字 token
  for (const m of normalized.matchAll(/[a-z0-9]+/gi)) {
    const t = m[0].toLowerCase();
    if (!isWeakSearchToken(t)) tokens.push(t);
  }

  // 2. Intl.Segmenter 中文分词
  if (zhSegmenter) {
    for (const seg of zhSegmenter.segment(normalized)) {
      if (seg.isWordLike) {
        const t = seg.segment.trim().toLowerCase();
        if (t && !isWeakSearchToken(t)) tokens.push(t);
      }
    }
  }

  // 3. 连续中文串 bigram 兜底
  for (const m of normalized.matchAll(/[一-鿿]+/g)) {
    const s = m[0];
    if (s.length >= 2) tokens.push(s);
    for (let i = 0; i < s.length - 1; i++) {
      tokens.push(s.slice(i, i + 2));
    }
  }

  if (options.unique !== false) {
    return Array.from(new Set(tokens));
  }
  return tokens;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function removeMatchedServerTerms(
  query: string,
  serverName: string,
  aliases: string[],
): string {
  let text = normalizeForSearch(query);

  const terms = [serverName, ...aliases]
    .map((t) => normalizeForSearch(t))
    .filter((t) => t.length >= 2)
    .sort((a, b) => b.length - a.length);

  for (const term of terms) {
    if (/^[a-z0-9 ]+$/i.test(term)) {
      const pattern = new RegExp(`(^|\\s)${escapeRegExp(term)}(?=\\s|$)`, "g");
      text = text.replace(pattern, " ");
    } else {
      text = text.replaceAll(term, " ");
    }
  }

  return text.replace(/\s+/g, " ").trim();
}

export function findServersInText(
  text: string,
  serverNames: string[],
): string[] {
  const normalized = normalizeForSearch(text);
  const queryTokens = tokenizeForSearch(text);
  const matched: string[] = [];

  for (const serverName of serverNames) {
    const nameNormalized = normalizeForSearch(serverName);
    const nameTokens = tokenizeForSearch(serverName);

    if (
      nameTokens.length > 0 &&
      nameTokens.every((nt) => queryTokens.includes(nt))
    ) {
      matched.push(serverName);
      continue;
    }

    if (
      (/[一-鿿]/.test(nameNormalized) || nameNormalized.length >= 4) &&
      normalized.includes(nameNormalized)
    ) {
      matched.push(serverName);
    }
  }

  return matched;
}
