export interface ViewportMetrics {
  height: number;
  offsetTop: number;
}

const MINIMUM_VIEWPORT_HEIGHT = 1;

export function resolveViewportMetrics(
  visualHeight: number | undefined,
  visualOffsetTop: number | undefined,
  innerHeight: number,
): ViewportMetrics {
  const layoutHeight = Number.isFinite(innerHeight) && innerHeight > 0 ? innerHeight : 1;
  const candidateHeight =
    visualHeight !== undefined && Number.isFinite(visualHeight) && visualHeight > 0
      ? visualHeight
      : layoutHeight;
  const candidateOffset =
    visualOffsetTop !== undefined && Number.isFinite(visualOffsetTop)
      ? visualOffsetTop
      : 0;

  return {
    height: Math.max(MINIMUM_VIEWPORT_HEIGHT, Math.round(candidateHeight)),
    offsetTop: Math.max(0, Math.round(candidateOffset)),
  };
}

/**
 * Keep a modal inside the visual viewport while a mobile software keyboard is
 * open. Desktop callers use the same no-op path, so modal code stays shared.
 */
export function installResponsiveViewport(
  container: HTMLElement,
  enabled: boolean,
): () => void {
  if (!enabled) return () => undefined;

  container.addClass("is-beacon-mobile");
  const viewport = window.visualViewport;
  let animationFrame: number | undefined;
  let active = true;

  const apply = (): void => {
    animationFrame = undefined;
    if (!active) return;
    const metrics = resolveViewportMetrics(
      viewport?.height,
      viewport?.offsetTop,
      window.innerHeight,
    );
    container.style.setProperty("--beacon-viewport-height", `${metrics.height}px`);
    container.style.setProperty("--beacon-viewport-top", `${metrics.offsetTop}px`);
  };
  const schedule = (): void => {
    if (animationFrame !== undefined) return;
    animationFrame = window.requestAnimationFrame(apply);
  };

  apply();
  viewport?.addEventListener("resize", schedule);
  viewport?.addEventListener("scroll", schedule);
  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", schedule);

  return () => {
    active = false;
    if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame);
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    window.removeEventListener("orientationchange", schedule);
    container.style.removeProperty("--beacon-viewport-height");
    container.style.removeProperty("--beacon-viewport-top");
  };
}
