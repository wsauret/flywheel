/** Projection of a subset score to the full benchmark: an ordinary least
 *  squares fit of full score on subset score over the board's units (one
 *  unit per model, effort, and harness), and the 90% prediction interval of
 *  a new unit's full score from its subset score. */

/** One calibration unit: its subset score and its full score. */
export interface CalibrationUnit { readonly label: string; readonly subset: number; readonly full: number }

export interface ProjectionFit {
  readonly n: number;
  /** Intercept and slope: full = a + b * subset. */
  readonly a: number;
  readonly b: number;
  /** Residual standard deviation. */
  readonly s: number;
  readonly r2: number;
  readonly meanSubset: number;
  readonly sxx: number;
  /** The one-sided 0.95 quantile of Student's t with n - 2 degrees of freedom. */
  readonly t90: number;
}

export interface Projection { readonly full: number; readonly low: number; readonly high: number }

/** The regularized incomplete beta I_x(a, b), by the Numerical Recipes continued fraction. */
function incompleteBeta(x: number, a: number, b: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 / (1 - (qab * x) / qap);
  let h = d;
  for (let m = 1; m < 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2) * (qam + m2));
    d = 1 / (1 + aa * d);
    c = 1 + aa / c;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 / (1 + aa * d);
    c = 1 + aa / c;
    h *= d * c;
  }
  return (Math.exp(a * Math.log(x) + b * Math.log(1 - x) - (logGamma(a) + logGamma(b) - logGamma(a + b))) * h) / a;
}

/** ln Gamma(x) for x > 0 by the Lanczos approximation (g = 7, 9 terms). */
function logGamma(x: number): number {
  const coefficients = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - logGamma(1 - x);
  const shifted = x - 1;
  let sum = coefficients[0]!;
  for (let i = 1; i < 9; i++) sum += coefficients[i]! / (shifted + i);
  const t = shifted + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sum);
}

function studentCdf(t: number, df: number): number {
  const tail = 0.5 * incompleteBeta(df / (df + t * t), df / 2, 0.5);
  return t > 0 ? 1 - tail : tail;
}

/** The p quantile of Student's t with df degrees of freedom, for p above 0.5, by bisection. */
export function studentQuantile(p: number, df: number): number {
  let low = 0;
  let high = 20;
  for (let i = 0; i < 200; i++) {
    const middle = (low + high) / 2;
    if (studentCdf(middle, df) < p) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Fits full on subset over the units. Throws for fewer than 3 units or
 *  units whose subset scores are all equal, which fit no line. */
export function fitProjection(units: readonly CalibrationUnit[]): ProjectionFit {
  if (units.length < 3) throw new Error(`a projection needs at least 3 board units, got ${units.length}`);
  const xs = units.map((unit) => unit.subset);
  const ys = units.map((unit) => unit.full);
  const mx = mean(xs);
  const my = mean(ys);
  const sxx = xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
  if (sxx === 0) throw new Error("the board units all have the same subset score");
  const sxy = xs.reduce((sum, x, index) => sum + (x - mx) * (ys[index]! - my), 0);
  const syy = ys.reduce((sum, y) => sum + (y - my) ** 2, 0);
  const b = sxy / sxx;
  const a = my - b * mx;
  const residualSquares = xs.reduce((sum, x, index) => sum + (ys[index]! - (a + b * x)) ** 2, 0);
  return { n: units.length, a, b, s: Math.sqrt(residualSquares / (units.length - 2)), r2: (sxy * sxy) / (sxx * syy), meanSubset: mx, sxx, t90: studentQuantile(0.95, units.length - 2) };
}

/** The projected full score of a subset score x and its 90% prediction
 *  interval, yhat +/- t90 * s * sqrt(1 + 1/n + (x - mean)^2 / Sxx). The
 *  board's units carry the same attempt-sampling noise in their subset
 *  scores, so the residual SD already holds it. */
export function project(fit: ProjectionFit, x: number): Projection {
  const full = fit.a + fit.b * x;
  const half = fit.t90 * fit.s * Math.sqrt(1 + 1 / fit.n + (x - fit.meanSubset) ** 2 / fit.sxx);
  return { full, low: full - half, high: full + half };
}

/** Leave-one-out check of the interval: how many units fall inside the
 *  interval that the other units' fit predicts, and the RMSE of those predictions. */
export function leaveOneOut(units: readonly CalibrationUnit[]): { covered: number; n: number; rmse: number } {
  let covered = 0;
  let squares = 0;
  units.forEach((unit, index) => {
    const projection = project(fitProjection(units.filter((_, other) => other !== index)), unit.subset);
    if (projection.low <= unit.full && unit.full <= projection.high) covered += 1;
    squares += (unit.full - projection.full) ** 2;
  });
  return { covered, n: units.length, rmse: Math.sqrt(squares / units.length) };
}
