// @ts-check

// TODO Move this module somewhere more pleasantly reusable

import { Nat } from '@agoric/nat';
import './types.js';

/**
 * @param {Timestamp | RelativeTime} left
 * @param {Timestamp | RelativeTime} right
 * @returns {TimerBrand | undefined}
 */
const sharedTimerBrand = (left, right) => {
  if (typeof left === 'bigint') {
    if (typeof right === 'bigint') {
      return undefined;
    } else {
      return right.timerBrand;
    }
  } else if (typeof right === 'bigint') {
    return left.timerBrand;
  } else {
    const result = left.timerBrand;
    assert.equal(result, right.timerBrand);
    return result;
  }
};

/**
 * @param {Timestamp | RelativeTime} left
 * @param {Timestamp | RelativeTime} right
 * @param {TimestampValue} absValue
 * @returns {Timestamp}
 */
const absLike = (left, right, absValue) => {
  Nat(absValue);
  const timerBrand = sharedTimerBrand(left, right);
  if (timerBrand) {
    return harden({
      timerBrand,
      absValue,
    });
  } else {
    return absValue;
  }
};

/**
 * @param {Timestamp | RelativeTime} left
 * @param {Timestamp | RelativeTime} right
 * @param {RelativeTimeValue} relValue
 * @returns {RelativeTime}
 */
const relLike = (left, right, relValue) => {
  Nat(relValue);
  const timerBrand = sharedTimerBrand(left, right);
  if (timerBrand) {
    return harden({
      timerBrand,
      relValue,
    });
  } else {
    return relValue;
  }
};

const absValue = abs =>
  typeof abs === 'bigint' ? Nat(abs) : Nat(abs.absValue);

const relValue = rel =>
  typeof rel === 'bigint' ? Nat(rel) : Nat(rel.relValue);

const addAbsRel = (abs, rel) =>
  absLike(abs, rel, absValue(abs) + relValue(rel));

const addRelRel = (rel1, rel2) =>
  relLike(rel1, rel2, relValue(rel1) + relValue(rel2));

const subtractAbsAbs = (abs1, abs2) =>
  relLike(abs1, abs2, absValue(abs1) - absValue(abs2));

const clampedSubtractAbsAbs = (abs1, abs2) => {
  const val1 = absValue(abs1);
  const val2 = absValue(abs2);
  return relLike(abs1, abs2, val1 > val2 ? val1 - val2 : 0n);
};

const subtractAbsRel = (abs, rel) =>
  absLike(abs, rel, absValue(abs) - relValue(rel));

const subtractRelRel = (rel1, rel2) =>
  relLike(rel1, rel2, relValue(rel1) - relValue(rel2));

const modAbsRel = (abs, step) => {
  sharedTimerBrand(abs, step); // just assert they're compat
  return absValue(abs) % relValue(step);
};

const modRelRel = (rel, step) => {
  sharedTimerBrand(rel, step); // just assert they're compat
  return relValue(rel) % relValue(step);
};

/**
 * @param {bigint} v1
 * @param {bigint} v2
 * @returns {RankComparison}
 */
const compareValues = (v1, v2) => {
  if (v1 < v2) {
    return -1;
  } else if (v1 === v2) {
    return 0;
  } else {
    assert(v1 > v2);
    return 1;
  }
};

/**
 * @type {TimeMathType}
 */
export const TimeMath = harden({
  absValue,
  relValue,
  addAbsRel,
  addRelRel,
  subtractAbsAbs,
  clampedSubtractAbsAbs,
  subtractAbsRel,
  subtractRelRel,
  modAbsRel,
  modRelRel,
  compareAbs: (abs1, abs2) => compareValues(absValue(abs1), absValue(abs2)),
  compareRel: (rel1, rel2) => compareValues(relValue(rel1), relValue(rel2)),
});
