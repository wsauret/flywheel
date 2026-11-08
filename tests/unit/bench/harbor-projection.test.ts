import { describe, expect, it } from "bun:test";
import { fitProjection, project, studentQuantile } from "../../../bench/harbor/analysis/projection.js";

describe("subset projection", () => {
  it("fits full on subset and gives the 90% prediction interval of a hand-computed case", () => {
    // x = 0, 1, 2 and y = 0, 1, 3: b = 3/2, a = -1/6, residuals 1/6, -1/3, 1/6, so s = sqrt(1/6) on 1 degree of freedom.
    const fit = fitProjection([{ label: "u1", subset: 0, full: 0 }, { label: "u2", subset: 1, full: 1 }, { label: "u3", subset: 2, full: 3 }]);
    expect(fit.b).toBeCloseTo(1.5, 12);
    expect(fit.a).toBeCloseTo(-1 / 6, 12);
    expect(fit.s).toBeCloseTo(Math.sqrt(1 / 6), 12);
    expect(fit.t90).toBeCloseTo(6.313752, 5);
    // At the mean subset score the half width is t90 * s * sqrt(1 + 1/3).
    const projection = project(fit, 1);
    expect(projection.full).toBeCloseTo(4 / 3, 12);
    expect(projection.high - projection.full).toBeCloseTo(6.313752 * Math.sqrt(1 / 6) * Math.sqrt(4 / 3), 4);
  });

  it("matches the t quantile of the board's 45-unit fit", () => {
    expect(studentQuantile(0.95, 43)).toBeCloseTo(1.6810707, 6);
  });
});
