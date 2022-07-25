import { Nat } from '@endo/nat';
import { M, fit } from '@agoric/store';

export const TimerBrandShape = M.remotable();
export const TimestampValueShape = M.nat();
export const RelativeTimeValueShape = M.nat(); // Should we allow negatives?

export const TimestampRecordShape = harden({
  timerBrand: TimerBrandShape,
  absValue: TimestampValueShape,
});

export const RelativeTimeRecordShape = harden({
  timerBrand: TimerBrandShape,
  relValue: RelativeTimeValueShape,
});

export const TimestampShape = M.or(TimestampRecordShape, TimestampValueShape);
export const RelativeTimeShape = M.or(
  RelativeTimeRecordShape,
  RelativeTimeValueShape,
);

/**
 * @param {Timestamp | number} ts
 * @returns {Timestamp}
 */
export const toTimestamp = ts => {
  if (typeof ts === 'number') {
    ts = Nat(ts);
  }
  fit(ts, TimestampShape);
  return ts;
};
harden(toTimestamp);

/**
 * @param {RelativeTime | number} rt
 * @returns {RelativeTime}
 */
export const toRelativeTime = rt => {
  if (typeof rt === 'number') {
    rt = Nat(rt);
  }
  fit(rt, RelativeTimeShape);
  return rt;
};
harden(toRelativeTime);
