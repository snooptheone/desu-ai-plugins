'use strict';
// Devices, through virtual ones: run.sh starts the unifi-emu container (UNIFI_EMU_IMAGE set in the settings file),
// whose fake access point and switch speak the real inform protocol, so they show up as pending devices on the VM.
// Adopting, reading, restarting, power-cycling a port and removing them then go through the real API.
// Without the emulator these tests are skipped. Do not run it by hand: ./run.sh restores the VM around it.
// Limits of virtual devices: a restart or a PoE power-cycle is accepted by the controller, but whether the emulator
// then behaves like hardware is the emulator's business; what is checked here is the controller's side.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { client, planAndApply, until, isGateway, describe } = require('./helper');

const EMU = Boolean(process.env.UNIFI_EMU_RUNNING);
const WANTED = (process.env.UNIFI_EMU_MODELS || 'U7PRO,USM8P').split(',').reduce((n, m) => n + (Number(m.split(':')[1]) || 1), 0);

let c;
let site;
before(async () => {
  c = client();
  site = (await c.call('unifi_sites'))[0].id;
});
after(() => c.close());

const adopted = [];

test('virtual devices show up as pending, with a name, an address and what they can do', async (t) => {
  if (!EMU) return t.skip('no emulator: set UNIFI_EMU_IMAGE in the settings file to get virtual devices');
  const pending = await until(`${WANTED} pending devices`, async () => {
    const list = await c.call('unifi_pending_devices');
    return list.length >= WANTED ? list : null;
  }, { seconds: 180 });
  // the console shows its own model names (U7PRO becomes "U7 Pro"), so look at the features instead
  assert.ok(pending.some((d) => d.features.includes('accessPoint')), 'a pending access point');
  assert.ok(pending.some((d) => d.features.includes('switching')), 'a pending switch');
  for (const d of pending) {
    assert.match(d.macAddress, /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i);
    assert.equal(d.supported, true, `${d.model} is supported`);
  }
});

test('adopt: the pending devices become managed, online devices and leave the pending list', async (t) => {
  if (!EMU) return t.skip('no emulator');
  const pending = await c.call('unifi_pending_devices');
  const hasGateway = (await c.call('unifi_devices')).some(isGateway);
  for (const d of pending) {
    if (isGateway(d) && hasGateway) {
      // a console restored with an adopted gateway (the zone-based firewall snapshot) takes only one per site
      await assert.rejects(planAndApply(c, 'unifi_plan_change', { method: 'POST', path: `sites/${site}/devices`, body: { macAddress: d.macAddress, ignoreDeviceLimit: false } }),
        /multiple-gateways-not-allowed/, 'a second gateway is refused');
      continue;
    }
    await planAndApply(c, 'unifi_plan_change', { method: 'POST', path: `sites/${site}/devices`, body: { macAddress: d.macAddress, ignoreDeviceLimit: false } });
    adopted.push(d);
  }
  const online = await until('every adopted device online', async () => {
    const list = await c.call('unifi_devices');
    const mine = adopted.map((a) => list.find((x) => x.macAddress.toLowerCase() === a.macAddress.toLowerCase()));
    return mine.every((x) => x && x.state === 'ONLINE') ? mine : null;
  }, { seconds: 420 });
  t.diagnostic(`adopted: ${online.map(describe).join('; ')}`);
  assert.equal(online.length, adopted.length);
  const stillPending = (await c.call('unifi_pending_devices')).filter((p) => adopted.some((a) => a.macAddress.toLowerCase() === p.macAddress.toLowerCase()));
  assert.deepEqual(stillPending, [], 'adopted devices left the pending list');
});

test('device detail and statistics agree with the device list', async (t) => {
  if (!EMU) return t.skip('no emulator');
  for (const row of await c.call('unifi_devices')) {
    const detail = await c.call('unifi_device', { deviceId: row.id });
    for (const k of ['id', 'name', 'model', 'macAddress', 'state']) assert.deepEqual(detail[k], row[k], `${row.model}: ${k}`);
    assert.ok(detail.interfaces, `${row.model} has interfaces`);
    const stats = await c.call('unifi_device_stats', { deviceId: row.id });
    assert.equal(typeof stats, 'object', `${row.model} statistics`);
  }
});

test('restart: planned and applied, and the device is online again', async (t) => {
  if (!EMU) return t.skip('no emulator');
  const [device] = (await c.call('unifi_devices')).filter((x) => x.state === 'ONLINE' && !isGateway(x));
  const { plan } = await planAndApply(c, 'unifi_plan_restart_device', { deviceId: device.id });
  assert.match(plan.summary, /^Restart device /);
  const again = await until('the device online again', async () => {
    const d = await c.call('unifi_device', { deviceId: device.id });
    return d.state === 'ONLINE' ? d : null;
  }, { seconds: 300 });
  assert.equal(again.id, device.id, 'same device after the restart');
});

test('PoE power-cycle: done on a port that supplies power, refused cleanly on one that does not', async (t) => {
  if (!EMU) return t.skip('no emulator');
  let port;
  let device;
  for (const row of await c.call('unifi_devices')) {
    const detail = await c.call('unifi_device', { deviceId: row.id });
    const ports = ((detail.interfaces && detail.interfaces.ports) || []).filter((x) => x.poe);
    const p = ports.find((x) => x.poe.state === 'UP') || ports[0];
    if (p) { port = p; device = detail; break; }
  }
  if (!port) return t.skip('no virtual device reports a PoE port');
  const plan = await c.call('unifi_plan_change', { method: 'POST', path: `sites/${site}/devices/${device.id}/interfaces/ports/${port.idx}/actions`, body: { action: 'POWER_CYCLE' } });
  assert.match(plan.summary, /^Run an action on /);
  const r = await c.raw('unifi_apply_change', { approvalCode: plan.approvalCode, confirmation: plan.confirmation });
  if (r.isError) {
    // a virtual port draws no power: the console says so, which is the correct answer
    assert.match(r.content[0].text, /not-supplying-power/, 'refused for a reason other than the missing PoE load');
    t.diagnostic(`port ${port.idx} (PoE state ${port.poe.state}) was refused: no power supplied`);
  } else {
    t.diagnostic(`port ${port.idx} (PoE state ${port.poe.state}) was power-cycled`);
  }
  assert.equal((await c.call('unifi_device', { deviceId: device.id })).state, 'ONLINE', 'the device itself was not affected');
});
