export function normalizeContextUsage(data) {
  const currentTokens = Math.max(0, Number(data?.currentTokens));
  const tokenLimit = Number(data?.tokenLimit);
  if (!Number.isFinite(currentTokens) || !Number.isFinite(tokenLimit) || tokenLimit <= 0) {
    return undefined;
  }

  const messagesLength = Number(data?.messagesLength);
  const ratio = Math.min(Math.max(currentTokens / tokenLimit, 0), 1);

  return {
    currentTokens,
    tokenLimit,
    messagesLength: Number.isFinite(messagesLength) ? messagesLength : undefined,
    ratio,
  };
}

export function formatTokenCount(value) {
  const number = Math.max(0, Math.round(Number(value)));
  if (number >= 1_000_000) return `${trimDecimal(number / 1_000_000)}M`;
  if (number >= 1_000) return `${trimDecimal(number / 1_000)}k`;
  return String(number);
}

function trimDecimal(value) {
  return value.toFixed(1).replace(/\.0$/, "");
}
