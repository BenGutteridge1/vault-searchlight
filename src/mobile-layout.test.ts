import { describe, expect, it } from "vitest";
import { resolveViewportMetrics } from "./mobile-layout";

describe("resolveViewportMetrics", () => {
  it("uses the visual viewport so the software keyboard reduces modal height", () => {
    expect(resolveViewportMetrics(412.4, 18.7, 844)).toEqual({
      height: 412,
      offsetTop: 19,
    });
  });

  it("falls back to the layout viewport without exceeding a short visible area", () => {
    expect(resolveViewportMetrics(undefined, undefined, 720)).toEqual({
      height: 720,
      offsetTop: 0,
    });
    expect(resolveViewportMetrics(120, -8, 720)).toEqual({
      height: 120,
      offsetTop: 0,
    });
    expect(resolveViewportMetrics(0, 0, 720)).toEqual({
      height: 720,
      offsetTop: 0,
    });
    expect(resolveViewportMetrics(undefined, undefined, Number.NaN)).toEqual({
      height: 1,
      offsetTop: 0,
    });
  });
});
