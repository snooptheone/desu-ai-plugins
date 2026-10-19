'use strict';
// The last file: removes the virtual devices adopted by devices.e2e.js (and used by firewall.e2e.js), and checks they
// leave the console. Do not run it by hand: ./run.sh restores the VM around it.
const { test, before, after } = require('node:test');
const { client, planAndApply, until } = require('./helper');

const EMU = Boolean(process.env.UNIFI_EMU_RUNNING);

let c;
let site;
before(async () => {
  c = client();
  site = (await c.call('unifi_sites'))[0].id;
});
after(() => c.close());

test('remove: the devices go away from the console', async (t) => {
  if (!EMU) return t.skip('no emulator');
  const before = await c.call('unifi_devices');
  // each device is independent, and the virtual gateway can stay busy for a minute or more: wait for all at once
  await Promise.all(before.map((row) => until(`${row.model} removable`, async () => {
    try {
      await planAndApply(c, 'unifi_plan_change', { method: 'DELETE', path: `sites/${site}/devices/${row.id}` });
      return true;
    } catch (e) {
      // a device that is still being provisioned (the virtual gateway) answers "device-busy" for a while
      if (!/device-busy/.test(e.message)) throw e;
      return null;
    }
  }, { seconds: 180, every: 5 })));
  await until('the removed devices gone', async () => ((await c.call('unifi_devices')).length === 0 ? true : null), { seconds: 120, every: 3 });
  // The emulator is not guaranteed to reset like hardware after being forgotten, so this is reported, not asserted.
  try {
    const back = await until('the devices pending again', async () => {
      const list = await c.call('unifi_pending_devices');
      return list.length >= before.length ? list : null;
    }, { seconds: 45 });
    t.diagnostic(`${back.length} devices came back as pending`);
  } catch {
    t.diagnostic('the virtual devices did not come back as pending within 45s (emulator behavior after being forgotten)');
  }
});
