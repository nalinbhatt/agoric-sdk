// @ts-check

import { E } from '@endo/eventual-send';
import { Far, passStyleOf } from '@endo/marshal';
import { makePromiseKit } from '@endo/promise-kit';
import { Nat } from '@agoric/nat';
import { assert } from '@agoric/assert';
// import { makeNotifierFromAsyncIterable } from '@agoric/notifier';
import {
  provideKindHandle,
  defineDurableKind,
  defineDurableKindMulti,
  makeScalarBigMapStore,
  makeScalarBigWeakMapStore,
} from '@agoric/vat-data';
import { provide } from '@agoric/store';
// import { makeTimedIterable } from './timed-iteration.js';

// RAM usage: O(number of outstanding delay() promises) +
// O(number of notifiers??). setWakeup() only consumes DB.

/**
 * @typedef {bigint} Time
 * @typedef {bigint} TimeDelta
 * @typedef {unknown} Handler
 * // Handler is a Far object with .wake(time) used for callbacks
 * @typedef {unknown} CancelToken
 * // CancelToken must be pass-by-reference and durable, either local or remote
 * @typedef { { start: Time,
 *              interval: TimeDelta | undefined,
 *              handler: Handler,
 *              scheduled: Time | undefined,
 *              cancelled: boolean,
 *            } } Event
 * @typedef {MapStore<Time, Event[]>} Schedule
 * @typedef {WeakMapStore<CancelToken, Event>} CancelTable
 * @typedef {MapStore<number, PromiseKit} WakeupPromiseTable
 */

/* Repeaters have an Event with both 'start' and 'interval'. One-shot
 * wakeups are Events with .interval = undefined. Each Event is
 * tri-state: "scheduled" (.scheduled is non-undefined), "cancelled"
 * (.cancelled=true), or "executing" (only for Repeaters, indicated by
 * .scheduled=undefined and .cancelled = false). Events are kept alive
 * by the schedule while "scheduled", by handler.wake result promise
 * callbacks while "executing", and by mostly nothing when "cancelled".
 */

// these internal functions are exported for unit tests

/**
 * Insert an event into the schedule at its given time.
 *
 * @param {Schedule} schedule
 * @param {Time} when
 * @param {Event} event
 */
function addEvent(schedule, when, event) {
  assert.typeof(when, 'bigint');
  if (!schedule.has(when)) {
    schedule.init(when, harden([event]));
  } else {
    // events track their .scheduled time, so if addEvent() is called,
    // it is safe to assume the event isn't already scheduled
    schedule.set(when, harden([...schedule.get(when), event]));
  }
}

/**
 * Remove an event from the schedule
 *
 * @param {Schedule} schedule
 * @param {Time} when
 * @param {Event} event
 */
function removeEvent(schedule, when, event) {
  if (schedule.has(when)) {
    /** @typedef { Event[] } */
    const oldEvents = schedule.get(when);
    /** @typedef { Event[] } */
    const newEvents = oldEvents.filter(ev => ev !== event);
    if (newEvents.length === 0) {
      schedule.delete(when);
    } else if (newEvents.length < oldEvents.length) {
      schedule.set(when, harden(newEvents));
    }
  }
}

/**
 * Add a CancelToken->Event registration
 *
 * @param {CancelTable} cancels
 * @param {CancelToken} cancelToken
 * @param {Event} event
 */
function addCancel(cancels, cancelToken, event) {
  if (!cancels.has(cancelToken)) {
    cancels.init(cancelToken, harden([event]));
  } else {
    const oldEvents = cancels.get(cancelToken);
    // each cancelToken can cancel multiple events, but we only
    // addCancel() for each event once, so it is safe to assume the
    // event is not already there
    const events = [...oldEvents, event];
    cancels.set(cancelToken, harden(events));
  }
}

/**
 * Remove a CancelToken->Event registration
 *
 * @param {CancelTable} cancels
 * @param {CancelToken} cancelToken
 * @param {Event} event
 */
function removeCancel(cancels, cancelToken, event) {
  assert(cancelToken !== undefined); // that would be super confusing
  // this check is to tolerate a race between cancel and timer, but it
  // also means we ignore a bogus cancelToken
  if (cancels.has(cancelToken)) {
    const oldEvents = cancels.get(cancelToken);
    const newEvents = oldEvents.filter(oldEvent => oldEvent !== event);
    if (newEvents.length === 0) {
      cancels.delete(cancelToken);
    } else if (newEvents.length < oldEvents.length) {
      cancels.set(cancelToken, harden(newEvents));
    }
  }
}

/**
 * @param {Schedule} schedule
 * @returns {Time | undefined}
 */
function firstWakeup(schedule) {
  const iter = schedule.keys()[Symbol.iterator]();
  const first = iter.next();
  if (first.done) {
    return undefined;
  }
  return first.value;
}

/**
 * return list of events for time <= upto
 *
 * @param {Schedule} schedule
 * @param {Time} upto
 * @returns { Event[] }
 */
function removeEventsUpTo(schedule, upto) {
  assert.typeof(upto, 'bigint');
  let ready = [];
  for (const [time, events] of schedule.entries()) {
    if (time <= upto) {
      ready = ready.concat(events);
      schedule.delete(time);
    } else {
      break; // don't walk the entire future
    }
  }
  return ready;
}

function nextScheduleTime(start, interval, now) {
  // used to schedule repeaters
  assert.typeof(start, 'bigint');
  assert.typeof(interval, 'bigint');
  assert.typeof(now, 'bigint');
  // return the smallest value of `start + N * interval` after now
  if (now < start) {
    return start;
  }
  return now + interval - ((now - start) % interval);
}

export function buildRootObject(vatPowers, _vatParameters, baggage) {
  const { D } = vatPowers;
  const serviceHandle = provideKindHandle(baggage, 'timerServiceHandle');

  // we use baggage to retain a device reference across upgrades
  let timerDevice;
  if (baggage.has('timerDevice')) {
    timerDevice = baggage.get('timerDevice');
  }
  function insistDevice() {
    assert(timerDevice, 'TimerService used before createTimerService()');
  }

  // we rely upon the sortability of BigInt keys, and upon our Stores
  // performing efficient iteration
  /** @type {Schedule} */
  const schedule = provide(baggage, 'schedule', () =>
    makeScalarBigMapStore('schedule', { durable: true }),
  );

  // map cancel handles to the times that hold their events
  /** @type {CancelTable} */
  const cancels = provide(baggage, 'cancels', () =>
    makeScalarBigWeakMapStore('cancels', { durable: true }),
  );

  // Promises are not durable, so we must hold them in a new
  // non-durable store for each incarnation. We index them with an
  // integer that *is* stored in durable storage: if the timer fires
  // after an upgrade, we don't need to fire the promise, since it was
  // rejected (with "Upgrade Disconnected") during the upgrade.

  /** @type {WakeupPromiseTable} */
  const wakeupPromises = makeScalarBigMapStore('promises');
  let nextWakeupPromiseID = provide(baggage, 'wakeupPromiseID', () => 0);
  function allocateWakeupPromiseID() {
    const wakeupPromiseID = nextWakeupPromiseID;
    nextWakeupPromiseID += 1;
    baggage.set('wakeupPromiseID', nextWakeupPromiseID);
    return wakeupPromiseID;
  }

  // populated at the end of the function
  let wakeupHandler;

  function reschedule() {
    assert(wakeupHandler, 'reschedule() without wakeupHandler');
    // the first wakeup should be in the future: the device will not
    // immediately fire when given a stale request
    const newFirstWakeup = firstWakeup();
    // idempotent and ignored if not currently registered
    D(timerDevice).removeWakeup(wakeupHandler);
    if (newFirstWakeup) {
      D(timerDevice).setWakeup(newFirstWakeup, wakeupHandler);
    }
  }

  /**
   * @returns {Time}
   */
  function getCurrentTimestamp() {
    insistDevice();
    return Nat(D(timerDevice).getLastPolled());
  }

  // we have three kinds of events: "one-shot" (one-shot handler.wake),
  // "promise" (one-shot promise.resolve), and repeaters
  // (handler.wake)

  // Event (one-shot)

  const oneShotEventHandle = provideKindHandle(baggage, 'oneShotEventHandle');

  function initOneShotEvent(when, handler, cancelToken) {
    const scheduled = undefined; // set by scheduleYourself()
    const cancelled = false;
    return { when, handler, scheduled, cancelled, cancelToken };
  }

  const oneShotEventBehavior = {
    scheduleYourself({ self, state }) {
      const { when, cancelToken } = state;
      state.scheduled = when; // cleared if fired/cancelled
      addEvent(when, self);
      if (cancelToken) {
        addCancel(cancels, cancelToken, self);
      }
      reschedule();
    },

    fired({ self, state }) {
      const { cancelled, scheduled, handler, cancelToken } = state;
      state.scheduled = undefined;
      if (cancelled) {
        return;
      }
      // we tell the client their scheduled wakeup time, although
      // some time may have passed since device-timer told us, and
      // more time will pass before our wake() arrives at the client
      const p = E(handler).wake(scheduled);
      // one-shots ignore errors and disappear
      p.catch(_err => undefined);
      // TODO use E.sendOnly() for non-repeaters, if it existed
      if (cancelToken) {
        self.cancel(); // stop tracking cancelToken
      }
    },

    cancel({ self, state }) {
      removeCancel(cancels, state.cancelToken, self);
      self.cancelled = true;
      if (state.scheduled) {
        removeEvent(schedule, state.scheduled, self);
        state.scheduled = undefined;
        reschedule();
      }
    },
  };

  const makeOneShotEvent = defineDurableKind(
    oneShotEventHandle,
    initOneShotEvent,
    oneShotEventBehavior,
  );

  // Event (promise)

  const promiseEventHandle = provideKindHandle(baggage, 'promiseEventHandle');

  function initPromiseEvent(when, wakeupPromiseID, cancelToken) {
    assert.typeof(wakeupPromiseID, 'number');
    const scheduled = undefined;
    const cancelled = false;
    return { when, wakeupPromiseID, scheduled, cancelled, cancelToken };
  }

  const promiseEventBehavior = {
    scheduleYourself({ self, state }) {
      const { when, cancelToken } = state;
      state.scheduled = when; // cleared if fired/cancelled
      addEvent(when, self);
      if (cancelToken) {
        addCancel(cancels, cancelToken, self);
      }
      reschedule();
    },

    fired({ self, state }) {
      const { cancelled, scheduled, wakeupPromiseID, cancelToken } = state;
      state.scheduled = undefined;
      if (cancelled) {
        return;
      }
      if (wakeupPromises.has(wakeupPromiseID)) {
        const pk = wakeupPromises.get(wakeupPromiseID);
        pk.resolve(scheduled);
        wakeupPromises.delete(wakeupPromiseID);
      }
      // else: we were upgraded and promise was rejected/disconnected
      if (cancelToken) {
        self.cancel(); // stop tracking cancelToken
      }
    },

    cancel({ self, state }) {
      const { wakeupPromiseID, scheduled, cancelToken } = state;
      removeCancel(cancels, cancelToken, self);
      self.cancelled = true;
      if (scheduled) {
        removeEvent(schedule, scheduled, self);
        state.scheduled = undefined;
        reschedule();
        if (wakeupPromises.has(wakeupPromiseID)) {
          const pk = wakeupPromises.get(wakeupPromiseID);
          pk.reject({ name: 'TimerCancelled' });
          wakeupPromises.delete(wakeupPromiseID);
        }
      }
    },
  };

  const makePromiseEvent = defineDurableKind(
    promiseEventHandle,
    initPromiseEvent,
    promiseEventBehavior,
  );

  // Event (repeaters)

  const repeaterEventHandle = provideKindHandle(baggage, 'repeaterEventHandle');

  function initRepeaterEvent(startTime, interval, handler, cancelToken) {
    const scheduled = undefined;
    const cancelled = false;
    return { startTime, interval, handler, scheduled, cancelled, cancelToken };
  }

  const repeaterEventBehavior = {
    scheduleYourself({ self, state }) {
      // first time
      const { startTime, interval, cancelToken } = state;
      const now = getCurrentTimestamp();
      const next = nextScheduleTime(startTime, interval, now);
      addEvent(next, self);
      if (cancelToken) {
        addCancel(cancels, cancelToken, self);
      }
      reschedule();
    },

    rescheduleYourself({ self, state }) {
      const { cancelled, startTime, interval } = state;
      if (cancelled) {
        // cancelled while waiting for handler to finish
        return;
      }
      const now = getCurrentTimestamp();
      const next = nextScheduleTime(startTime, interval, now);
      addEvent(next, self);
      reschedule();
    },

    fired({ self, state }) {
      const { cancelled, scheduled, handler } = state;
      state.scheduled = undefined;
      if (cancelled) {
        return;
      }
      // repeaters stay in "waiting" until their promise resolves,
      // at which point we either reschedule or cancel
      E(handler)
        .wake(scheduled)
        .then(
          _res => self.rescheduleYourself(),
          _err => self.cancel(),
        )
        .catch(err => console.log(`timer repeater error`, err));
    },

    cancel({ self, state }) {
      const { scheduled, cancelToken } = state;
      removeCancel(cancels, cancelToken, self);
      self.cancelled = true;
      if (scheduled) {
        removeEvent(schedule, scheduled, self);
        state.scheduled = undefined;
        reschedule();
      }
    },
  };

  const makeRepeaterEvent = defineDurableKind(
    repeaterEventHandle,
    initRepeaterEvent,
    repeaterEventBehavior,
  );

  // public API

  /**
   * @param {Time} when
   * @param {Handler} handler
   * @param {CancelToken} [cancelToken]
   */
  function setWakeup(when, handler, cancelToken = undefined) {
    when = Nat(when);
    assert.equal(passStyleOf(handler), 'remotable', 'bad setWakeup() handler');
    if (cancelToken) {
      assert.equal(passStyleOf(cancelToken), 'remotable', 'bad cancel token');
    }

    const now = getCurrentTimestamp();
    if (when <= now) {
      // fire it immediately and skip the rest
      E(handler)
        .wake(when)
        .catch(_err => undefined);
      // TODO: we'd use E.sendOnly() if it existed
      return;
    }

    const event = makeOneShotEvent(when, handler, cancelToken);
    event.scheduleYourself();
  }

  function wakeAtInternal(when, cancelToken) {
    const wakeupPromiseID = allocateWakeupPromiseID();
    const pk = makePromiseKit();
    wakeupPromises.init(wakeupPromiseID, pk);
    const event = makePromiseEvent(when, wakeupPromiseID, cancelToken);
    event.scheduleYourself();
    return pk.promise; // disconnects upon upgrade
  }

  // this gets called when the device's wakeup message reaches us
  function processAndReschedule() {
    // first, service everything that is ready
    const now = getCurrentTimestamp();
    removeEventsUpTo(now).forEach(event => event.fired());
    // then, reschedule for whatever is up next
    reschedule();
  }

  // public API

  /**
   * wakeAt(when): return a Promise that fires (with the scheduled
   * wakeup time) somewhat after 'when'. If a 'cancelToken' is
   * provided, calling ts.cancel(cancelToken) before wakeup will cause
   * the Promise to be rejected instead.
   *
   * @param {Time} when
   * @param {CancelToken} [cancelToken]
   * @returns { Promise<Time> }
   */
  function wakeAt(when, cancelToken = undefined) {
    const now = getCurrentTimestamp();
    if (when <= now) {
      return Promise.resolve(when);
    }
    return wakeAtInternal(when, cancelToken);
  }

  /**
   * delay(delay): return a Promise that fires (with the scheduled wakeup
   * time) at 'delay' time units in the future.
   *
   * @param {TimeDelta} delay
   * @param {CancelToken} [cancelToken]
   * @returns { Promise<Time> }
   */
  function addDelay(delay, cancelToken = undefined) {
    delay = Nat(delay);
    assert(delay > 0n, 'delay must be positive');
    const now = getCurrentTimestamp();
    const when = now + delay;
    return wakeAtInternal(when, cancelToken);
  }

  /**
   * cancel(token): Cancel an outstanding one-shot or repeater. For
   * one-shots that return Promises, the Promise is rejected with {
   * name: 'TimerCancelled' }.
   *
   * @param {CancelToken} cancelToken
   */
  function cancel(cancelToken) {
    // silently ignore multiple cancels and bogus token
    if (cancels.has(cancelToken)) {
      const event = cancels.get(cancelToken);
      event.cancel();
    }
  }

  /**
   * Register a handler, which will be invoked as
   * handler.wake(scheduledTime) at the earliest future instance of
   * `startTime + k*interval`. When the wake() result promise
   * fulfills, the repeater will be rescheduled for the next such
   * instance (there may be gaps). If that promise rejects, the
   * repeater will be cancelled. The repeater can also be cancelled by
   * providing `cancelToken` and calling
   * `E(timerService).cancel(cancelToken)`.
   *
   * @param {Time} startTime
   * @param {TimeDelta} interval
   * @param {Handler} handler
   * @param {CancelToken} [cancelToken]
   */
  function repeat(startTime, interval, handler, cancelToken) {
    assert.typeof(startTime, 'bigint', 'repeat(startTime, _) requires bigint');
    assert.typeof(interval, 'bigint', 'repeat(_, interval) requires bigint');
    assert(interval > 0n, 'interval must be nonzero');
    const event = makeRepeaterEvent(startTime, interval, handler);
    if (cancelToken) {
      addCancel(cancels, cancelToken, event);
    }

    // computes first wakeup (which is always in future, for
    // repeaters), inserts into schedule, updates alarm
    event.scheduleYourself();
  }

  // --- Repeaters: legacy "distinct Repeater object" API ---

  // The durable Repeater object is built from (delay, interval)
  // arguments which requests a wakeup at the earliest future instance
  // of `now + delay + k*interval`. The returned object provides
  // {schedule, disable} methods. We build an Event from it.

  const repeaterHandle = provideKindHandle(baggage, 'repeater');
  function initRepeater(delay, interval) {
    // first wakeup at now+delay, then now+delay+k*interval
    assert.typeof(delay, 'bigint', 'makeRepeater(delay, _) requires bigint');
    assert.typeof(
      interval,
      'bigint',
      'makeRepeater(_, interval) requires bigint',
    );
    assert(interval > 0n, 'interval must be nonzero');
    const start = getCurrentTimestamp() + delay;
    const active = false;
    return { start, interval, active };
  }
  const repeaterFacets = {
    cancel: {}, // marker
    repeater: {
      schedule({ state, facets }, handler) {
        assert(
          passStyleOf(handler) === 'remotable',
          'bad repeater.schedule() handler',
        );
        assert(!state.active, 'repeater already scheduled');
        state.active = true;
        repeat(state.start, state.interval, handler, facets.cancel);
      },
      disable({ state, facets }) {
        if (state.active) {
          cancel(facets.cancel);
          state.active = false;
        }
      },
    },
  };
  const makeRepeater = defineDurableKind(
    repeaterHandle,
    initRepeater,
    repeaterFacets,
  );

  /**
   * makeNotifier(delay, interval): return a Notifier that fires on
   * the same schedule as makeRepeater()
   *
   * @param {Time} delay
   * @param {TimeDelta} interval
   * @returns { Repeater }
   */
  /*
  function makeNotifier(delay, interval) {
    delay = Nat(delay);
    interval = Nat(interval);
    assert(
      interval > 0,
      X`makeNotifier's second parameter must be a positive integer: ${interval}`,
    );

    // Find when the first notification will fire.
    const baseTime = timerService.getCurrentTimestamp() + delay + interval;
  
    const iterable = makeTimedIterable(
      timerService.delay,
      timerService.getCurrentTimestamp,
      baseTime,
      interval,
    );

    const notifier = makeNotifierFromAsyncIterable(iterable);

    return notifier;
  }
  */
  function makeNotifier() {}

  // The TimerService has no state: this module only supports a single
  // instance (one TimerService per vat), and both the TimerDevice and
  // the supporting collections are closed over by the singleton.

  function initService() {
    return {};
  }

  function noContext(f) {
    return (context, ...args) => f(...args);
  }

  const serviceFacets = {
    wakeupHandler: {
      wake: _context => processAndReschedule(),
    },
    service: {
      getCurrentTimestamp: noContext(getCurrentTimestamp),
      // one-shot with handler
      setWakeup: noContext(setWakeup),
      // one-shot with Promise
      wakeAt: noContext(wakeAt), // absolute
      delay: noContext(addDelay), // relative
      // cancel setWakeup/wakeAt/delay/repeat
      cancel: noContext(cancel),
      // repeater with Repeater control object (old)
      makeRepeater: noContext(makeRepeater),
      // repeater without control object
      repeat: noContext(repeat),
      // Notifier
      makeNotifier: noContext(makeNotifier),
      // get attenuated read-only clock facet
      getClock: ({ facets }) => facets.clock,
      getTimerBrand: ({ facets }) => facets.brand,
    },
    clock: {
      getCurrentTimestamp: noContext(getCurrentTimestamp),
      getTimerBrand: ({ facets }) => facets.brand,
    },
    brand: {
      isMyTimerService: ({ facets }, alleged) => alleged === facets.service,
    },
  };

  const makeServiceFacets = defineDurableKindMulti(
    serviceHandle,
    initService,
    serviceFacets,
  );

  const timerServiceFacets = provide(
    baggage,
    'timerServiceFacets',
    makeServiceFacets,
  );
  wakeupHandler = timerServiceFacets.wakeupHandler;

  /**
   * createTimerService() registers devices.timer and returns the
   * timer service. This must called at least once, to connect the
   * device, but we don't prohibit it from being called again (to
   * replace the device), just in case that's useful someday
   *
   * @returns {Promise<TimerService>}
   */

  // TODO: maybe change the name though
  async function createTimerService(timerNode) {
    timerDevice = timerNode;
    if (baggage.has('timerDevice')) {
      baggage.set('timerDevice', timerDevice);
    } else {
      baggage.init('timerDevice', timerDevice);
    }
    return timerServiceFacets.service;
  }

  return Far('root', { createTimerService });
}

export const debugTools = harden({
  addEvent,
  removeEvent,
  addCancel,
  removeCancel,
  removeEventsUpTo,
  firstWakeup,
  nextScheduleTime,
});

// TODO: canceltoken1 serves two repeaters, one is killed because wake() throws, other should still be running, and cancellable
