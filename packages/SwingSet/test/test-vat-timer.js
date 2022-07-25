// eslint-disable-next-line import/order
import { test } from '../tools/prepare-test-env-ava.js';

import { E } from '@endo/eventual-send';
import { Far } from '@endo/marshal';
import { makeScalarMapStore } from '@agoric/store';
import { buildRootObject, debugTools } from '../src/vats/timer/vat-timer.js';

test('schedule', t => {
  const schedule = makeScalarMapStore();

  function addEvent(when, event) {
    return debugTools.addEvent(schedule, when, event);
  }
  function removeEvent(when, event) {
    return debugTools.removeEvent(schedule, when, event);
  }
  function firstWakeup() {
    return debugTools.firstWakeup(schedule);
  }
  function removeEventsUpTo(upto) {
    return debugTools.removeEventsUpTo(schedule, upto);
  }

  // exercise the ordered list, without concern about the durability
  // the handlers
  addEvent(10n, 'e10');
  addEvent(30n, 'e30');
  addEvent(20n, 'e20');
  addEvent(30n, 'e30x');
  t.deepEqual(schedule.get(10n), ['e10']);
  t.deepEqual(schedule.get(20n), ['e20']);
  t.deepEqual(schedule.get(30n), ['e30', 'e30x']);
  t.is(firstWakeup(), 10n);

  let done = removeEventsUpTo(5n);
  t.deepEqual(done, []);
  done = removeEventsUpTo(10n);
  t.deepEqual(done, ['e10']);
  t.is(firstWakeup(), 20n);
  done = removeEventsUpTo(10n);
  t.deepEqual(done, []);
  done = removeEventsUpTo(35n);
  t.deepEqual(done, ['e20', 'e30', 'e30x']);
  t.is(firstWakeup(), undefined);
  done = removeEventsUpTo(40n);
  t.deepEqual(done, []);

  addEvent(50n, 'e50');
  addEvent(50n, 'e50x');
  addEvent(60n, 'e60');
  addEvent(70n, 'e70');
  addEvent(70n, 'e70x');
  t.deepEqual(schedule.get(50n), ['e50', 'e50x']);
  t.is(firstWakeup(), 50n);
  removeEvent(50n, 'e50');
  t.deepEqual(schedule.get(50n), ['e50x']);
  // removing a bogus event is ignored
  removeEvent('50n', 'bogus');
  t.deepEqual(schedule.get(50n), ['e50x']);
  removeEvent(50n, 'e50x');
  t.not(schedule.has(50n));
  t.is(firstWakeup(), 60n);
});

test('cancels', t => {
  const cancels = makeScalarMapStore();
  function addCancel(cancelToken, event) {
    return debugTools.addCancel(cancels, cancelToken, event);
  }
  function removeCancel(cancelToken, event) {
    return debugTools.removeCancel(cancels, cancelToken, event);
  }

  const cancel1 = Far('cancel token', {});
  const cancel2 = Far('cancel token', {});
  const cancel3 = Far('cancel token', {});
  addCancel(cancel1, 'e10');
  addCancel(cancel2, 'e20');
  addCancel(cancel3, 'e30');
  addCancel(cancel3, 'e30x'); // cancels can be shared among events

  t.deepEqual(cancels.get(cancel1), ['e10']);
  t.deepEqual(cancels.get(cancel2), ['e20']);
  t.deepEqual(cancels.get(cancel3), ['e30', 'e30x']);

  removeCancel(cancel1, 'e10');
  t.not(cancels.has(cancel1));

  // bogus cancels are ignored
  removeCancel('bogus', 'e20');
  t.deepEqual(cancels.get(cancel2), ['e20']);
  // unrecognized events are ignored
  removeCancel(cancel2, 'bogus');
  t.deepEqual(cancels.get(cancel2), ['e20']);

  removeCancel(cancel3, 'e30x');
  t.deepEqual(cancels.get(cancel3), ['e30']);
  removeCancel(cancel3, 'e30');
  t.not(cancels.has(cancel3));

  t.throws(() => removeCancel(undefined)); // that would be confusing
});

test('nextScheduleTime', t => {
  const nst = debugTools.nextScheduleTime; // nst(start, interval, now)
  let start = 0n;
  const interval = 10n;

  t.is(nst(start, interval, 0n), 10n);
  t.is(nst(start, interval, 1n), 10n);
  t.is(nst(start, interval, 9n), 10n);
  t.is(nst(start, interval, 10n), 20n);
  t.is(nst(start, interval, 11n), 20n);

  start = 5n;
  t.is(nst(start, interval, 0n), 5n);
  t.is(nst(start, interval, 4n), 5n);
  t.is(nst(start, interval, 5n), 15n);
  t.is(nst(start, interval, 14n), 15n);
  t.is(nst(start, interval, 15n), 25n);

  start = 63n;
  t.is(nst(start, interval, 0n), 63n);
  t.is(nst(start, interval, 9n), 63n);
  t.is(nst(start, interval, 62n), 63n);
  t.is(nst(start, interval, 63n), 73n);
  t.is(nst(start, interval, 72n), 73n);
  t.is(nst(start, interval, 73n), 83n);
});

async function setup() {
  const state = {
    now: 0n, // current time, updated during test
    currentWakeup: undefined,
    currentHandler: undefined,
  };
  const deviceMarker = harden({});
  const timerDeviceFuncs = harden({
    getLastPolled: () => state.now,
    setWakeup: (when, handler) => {
      assert.equal(state.currentWakeup, undefined, 'one at a time');
      assert.equal(state.currentHandler, undefined, 'one at a time');
      if (state.currentWakeup !== undefined) {
        assert(
          state.currentWakeup > now,
          `too late: ${currentWakeup} <= ${now}`,
        );
      }
      state.currentWakeup = when;
      state.currentHandler = handler;
    },
    removeWakeup: handler => {
      state.currentWakeup = undefined;
      state.currentHandler = undefined;
    },
  });
  function D(node) {
    assert.equal(node, deviceMarker, 'fake D only supports devices.timer');
    return timerDeviceFuncs;
  }
  const vatPowers = { D };

  const vatParameters = {};
  // const baggage = makeScalarBigMapStore();
  const baggage = makeScalarMapStore();

  const root = buildRootObject(vatPowers, vatParameters, baggage);
  const ts = await E(root).createTimerService(deviceMarker);

  const fired = {};
  function makeHandler(which) {
    return Far('handler', {
      wake(time) {
        console.log('wake', time, which);
        fired[which] = time;
      },
    });
  }

  return { ts, state, fired, makeHandler };
}

test('setWakeup', async t => {
  const { ts, state, fired, makeHandler } = await setup();

  t.not(ts, undefined);
  t.is(state.currentWakeup, undefined);

  t.is(await E(ts).getCurrentTimestamp(), state.now);

  // the first setWakeup sets the alarm
  await E(ts).setWakeup(30n, makeHandler(30));
  t.is(state.currentWakeup, 30n);
  t.not(state.currentHandler, undefined);

  // an earlier setWakeup brings the alarm forward
  const cancel20 = Far('cancel token', {});
  await E(ts).setWakeup(20n, makeHandler(20), cancel20);
  t.is(state.currentWakeup, 20n);

  // deleting the earlier pushes the alarm back
  await E(ts).cancel(cancel20);
  t.is(state.currentWakeup, 30n);

  // later setWakeups do not change the alarm
  await E(ts).setWakeup(40n, makeHandler(40));
  await E(ts).setWakeup(50n, makeHandler(50));
  await E(ts).setWakeup(50n, makeHandler('50x'));
  // cancel tokens can be shared
  const cancel6x = Far('cancel token', {});
  await E(ts).setWakeup(60n, makeHandler(60n), cancel6x);
  await E(ts).setWakeup(60n, makeHandler('60x'));
  await E(ts).setWakeup(61n, makeHandler(61n), cancel6x);
  t.is(state.currentWakeup, 30n);

  // wake up exactly on time
  state.now = 30n;
  await E(state.currentHandler).wake(30n);
  await Promise.resolve();
  t.is(fired[20], undefined); // was removed
  t.is(fired[30], 30n); // fired
  t.is(fired[40], undefined); // not yet fired
  // resets wakeup to next alarm
  t.is(state.currentWakeup, 40n);
  t.not(state.currentHandler, undefined);

  // wake up a little late, then message takes a while to arrive, all
  // wakeups before/upto the arrival time are fired
  state.now = 51n;
  await E(state.currentHandler).wake(41n);
  await Promise.resolve();
  t.is(fired[40], 40n);
  t.is(fired[50], 50n);
  t.is(fired['50x'], 50n);
  t.is(fired[60], undefined);
  t.is(state.currentWakeup, 60n);
  t.not(state.currentHandler, undefined);

  // a setWakeup in the past will be fired immediately
  await E(ts).setWakeup(21n, makeHandler(21));
  t.is(fired[21], 21n);

  // a setWakeup in the near future..
  await E(ts).setWakeup(52n, makeHandler(52));
  t.is(fired[52], undefined);
  // .. which time passes
  state.now = 53n;
  // .. will be fired when any request causes a reschedule
  await E(ts).setWakeup(54n, makeHandler(54));
  t.is(fired[52], 52n);
  t.is(fired[54], undefined);

  // same for a removal
  state.now = 55n;
  // cancellation might shrink a time entry from two handlers to one
  await E(ts).cancel(cancel6x);
  t.is(fired[54], 54n);

  // the remaining time-entry handler should still be there
  state.now = 65n;
  await E(state.currentHandler).wake(state.now);
  await Promise.resolve();
  t.is(fired['60x'], 60n);
});

test('repeater', async t => {
  const { ts, state, fired, makeHandler } = await setup();

  // TODO: initial 'time' is 'undefined', how is that handled??

  // fire at T=25,35,45,..
  const r1 = await E(ts).makeRepeater(25n, 10n);
  t.is(state.currentWakeup, undefined); // not scheduled yet
  await E(r1).schedule(makeHandler(1));
  t.is(state.currentWakeup, 25n);

  state.now = 1n;
  await E(state.currentHandler).wake(state.now);
  await Promise.resolve();
  t.is(fired[1], undefined); // not yet

  state.now = 24n;
  await E(state.currentHandler).wake(state.now);
  await Promise.resolve();
  t.is(fired[1], undefined); // wait for it

  state.now = 25n;
  await E(state.currentHandler).wake(state.now);
  await Promise.resolve();
  t.is(fired[1], 25n); // fired
  t.is(state.currentWakeup, 35n); // primed for next time

  // if we miss a couple, next wakeup is in the future
  state.now = 50n;
  await E(state.currentHandler).wake(state.now);
  await Promise.resolve();
  t.is(fired[1], 35n);
  t.is(state.currentWakeup, 55n);

  // likewise if device-timer message takes a while to reach vat-timer
  state.now = 60n;
  // sent at T=50, received by vat-timer at T=60
  await E(state.currentHandler).wake(50n);
  await Promise.resolve();
  t.is(fired[1], 55n);
  t.is(state.currentWakeup, 65n);

  await E(r1).disable();
  t.is(state.currentWakeup, undefined);

  await E(ts).setWakeup(70n, makeHandler(70));
  t.is(state.currentWakeup, 70n);
  state.now = 70n;
  await E(state.currentHandler).wake(state.now);
  await Promise.resolve();
  t.is(fired[70], 70n);
  t.is(fired[1], 55n); // unchanged
  t.is(state.currentWakeup, undefined);
});
