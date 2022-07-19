import { test } from '../../tools/prepare-test-env-ava.js';

// eslint-disable-next-line import/order
import { parse } from '@endo/marshal';
import { provideHostStorage } from '../../src/controller/hostStorage.js';
import { initializeSwingset, makeSwingsetController } from '../../src/index.js';
import { buildTimer } from '../../src/devices/timer/timer.js';

const bfile = name => new URL(name, import.meta.url).pathname;

test('timer vat', async t => {
  const timer = buildTimer();
  const config = {
    bootstrap: 'bootstrap',
    vats: { bootstrap: { sourceSpec: bfile('bootstrap-timer.js') } },
    devices: { timer: { sourceSpec: timer.srcPath } },
  };

  const hostStorage = provideHostStorage();
  const deviceEndowments = {
    timer: { ...timer.endowments },
  };
  await initializeSwingset(config, [], hostStorage);
  const c = await makeSwingsetController(hostStorage, deviceEndowments);
  t.teardown(c.shutdown);
  c.pinVatRoot('bootstrap');
  timer.poll(1n); // initial time
  await c.run();

  const run = async (method, args = []) => {
    assert(Array.isArray(args));
    const kpid = c.queueToVatRoot('bootstrap', method, args);
    await c.run();
    const status = c.kpStatus(kpid);
    const capdata = c.kpResolution(kpid);
    t.is(status, 'fulfilled', JSON.stringify([status, capdata]));
    return capdata;
  };

  const cd1 = await run('installWakeup', [3n]); // baseTime=3
  t.deepEqual(parse(cd1.body), 3n); // echoes the wakeup time

  const cd2 = await run('getEvents');
  t.deepEqual(parse(cd2.body), []); // no wakeups yet

  timer.poll(2n); // time passes but not enough
  await c.run();

  const cd3 = await run('getEvents');
  t.deepEqual(parse(cd3.body), []); // no wakeups yet

  timer.poll(4n); // yes enough
  await c.run();

  const cd4 = await run('getEvents');
  t.deepEqual(parse(cd4.body), [3n]); // scheduled time

  const cd5 = await run('installWakeup', [5n]);
  t.deepEqual(parse(cd5.body), 5n);
  const cd6 = await run('installWakeup', [6n]);
  t.deepEqual(parse(cd6.body), 6n);
  // If you added the same handler multiple times, removeWakeup()
  // would remove them all. It returns a list of wakeup timestamps.
  const cd7 = await run('removeWakeup');
  t.deepEqual(parse(cd7.body), [5n, 6n]);

  timer.poll(7n);
  await c.run();

  const cd8 = await run('getEvents');
  t.deepEqual(parse(cd8.body), []); // cancelled before wakeup

  const cd9 = await run('banana', [10n]);
  t.deepEqual(parse(cd9.body), 'bad setWakeup() handler');

  // start a repeater that should first fire at now+delay+interval, so
  // 7+20+10=37. TODO: poll at 25,35,40
  await run('goodRepeater', [20n, 10n]);
  timer.poll(25n);
  const cd10 = await run('getEvents');
  t.deepEqual(parse(cd10.body), [20n]);
  timer.poll(35n);
  const cd11 = await run('getEvents');
  t.deepEqual(parse(cd11.body), [30n]);
  await run('stopRepeater');
  timer.poll(45n);
  const cd12 = await run('getEvents');
  // TODO: disabling the repeater between t=35 and t=40 should inhibit
  // the t=40 event, but the code does not walk the list of pending
  // wakeups and remove repeater events, it just turns off the
  // automatic rescheduling step
  t.deepEqual(parse(cd12.body), [40n]); // TODO: should be []

  timer.poll(55n);
  const cd13 = await run('getEvents');
  t.deepEqual(parse(cd13.body), []); // repeater disabled, no events

  const cd14 = await run('repeaterBadSchedule', [60n, 10n]);
  // TODO: repeaterBadSchedule does a repeater.schedule() with a
  // non-Far handler, which should throw an immediate error, but
  // instead is stored normally, which causes a panic during the next
  // poll() which triggers the repeater notification

  //t.deepEqual(parse(cd14.body), 'bad handler');
  //timer.poll(75n);
  t.pass('survived timer.poll');

  // trying to remove a non-Far handler should throw. TODO: they are
  // currently ignored
  const cd15 = await run('badRemoveWakeup1', []);
  t.deepEqual(parse(cd15.body), 'bad removeWakeup() handler');

  // trying to remove a Far handler that wasn't previously registered
  // should throw. TODO: they are currently ignored
  const cd16 = await run('badRemoveWakeup2', []);
  t.deepEqual(parse(cd16.body), 'survived');



});


// TODO 1: deleting a repeater should cancel all wakeups for it, but the next wakeup happens anyways

// TODO 2: deleting a repeater should free all memory used by it, but
// there's an array which holds empty entries and never shrinks

// TODO 3: attempting to repeater.schedule an invalid handler should
// throw, but succeeds and provokes a kernel panic later when poll()
// is called (and tries to invoke the handler)

// TODO 4: vat-timer.js and timer.md claim `makeRepeater(delay,
// interval)` where the first arg is delay-from-now, but
// device-timer.js provides `makeRepeater(startTime, interval)`, where
// the arg is delay-from-epoch
