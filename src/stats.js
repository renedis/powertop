'use strict';

const finite = (xs) => xs.filter((x) => typeof x === 'number' && Number.isFinite(x));

function round(x, digits = 2) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

function mean(xs) {
  const v = finite(xs);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/** Sample standard deviation. */
function sd(xs) {
  const v = finite(xs);
  if (!v.length) return null;
  if (v.length === 1) return 0;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1));
}

/**
 * Mean of a step function: each point {t, v} holds until the next one.
 * Time before the first known value is not counted.
 */
function timeWeightedMean(points, from, to) {
  if (!(to > from)) return null;
  let cur = null;
  let t = from;
  let total = 0;
  let covered = 0;
  const add = (v, dt) => {
    if (typeof v === 'number' && Number.isFinite(v) && dt > 0) {
      total += v * dt;
      covered += dt;
    }
  };
  for (const p of points) {
    if (p.t <= from) {
      cur = p.v;
      continue;
    }
    if (p.t >= to) break;
    add(cur, p.t - t);
    cur = p.v;
    t = p.t;
  }
  add(cur, to - t);
  return covered > 0 ? total / covered : null;
}

module.exports = { mean, sd, round, timeWeightedMean };
