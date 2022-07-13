import { E } from '@endo/eventual-send';
import { Far } from '@endo/marshal';

export function buildRootObject() {
  let ts;
  const events = [];
  const handler = Far('handler', {
    wake(time) {
      events.push(time);
    },
  });
  let repeater;

  return Far('root', {
    async bootstrap(vats, devices) {
      ts = await E(vats.timer).createTimerService(devices.timer);
    },
    async installWakeup(baseTime) {
      return E(ts).setWakeup(baseTime, handler);
    },
    async getEvents() {
      // we need 'events' to remain mutable, but return values are
      // hardened, so clone the array first
      const ret = Array.from(events);
      events.length = 0;
      return ret;
    },
    async removeWakeup() {
      return E(ts).removeWakeup(handler);
    },

    async banana(baseTime) {
      try {
        console.log(`intentional 'bad setWakeup() handler' error follows`);
        await E(ts).setWakeup(baseTime, 'banana');
      } catch (e) {
        return e.message;
      }
      throw Error('banana too slippery');
    },

    async goodRepeater(startTime, interval) {
      repeater = await E(ts).makeRepeater(startTime, interval);
      await E(repeater).schedule(handler);
    },

    async stopRepeater() {
      await E(repeater).disable();
    },

    async repeaterBadSchedule(startTime, interval) {
      repeater = await E(ts).makeRepeater(startTime, interval);
      try {
        await E(repeater).schedule('norb'); // missing arguments #4282
        return 'should have failed';
      } catch (e) {
        return e.message;
      }
      throw Error('should have failed');
    },

    async badRemoveWakeup1() {
      // non-Far is rejected
      try {
        await E(ts).removeWakeup(); // bad argument #4296
        return 'survived';
      } catch (e) {
        return e.message;
      }
    },

    async badRemoveWakeup2() {
      // non-handlers are rejected
      try {
        const farButNotHandler = Far('nope', {});
        await E(ts).removeWakeup(farButNotHandler); // bad argument #4296
        return 'survived';
      } catch(e) {
        return e.message;
      }
    },

  });
}
