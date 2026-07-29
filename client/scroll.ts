export function isNearScrollEnd(
  metrics: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
  threshold = 120,
) {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}
