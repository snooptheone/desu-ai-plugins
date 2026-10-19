'use strict';
// Firewall zones and policies, through unifi_plan_change and the specific planner, against the UniFi OS test VM.
// Needs zone-based firewall on the console. Ubiquiti's requirements (help.ui.com, "Zone-Based Firewalls in UniFi"): a UniFi
// gateway, Network 9.0 or newer, and gateway firmware 4.1 or newer. Without it the tests are skipped and say why.
// Do not run it by hand: ./run.sh restores the VM around it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { client, planAndApply, until, isGateway, describe } = require('./helper');

let c;
let site;
before(async () => {
  c = client();
  site = (await c.call('unifi_sites'))[0].id;
});
after(() => c.close());

const change = (method, path, body) => planAndApply(c, 'unifi_plan_change', { method, path, body });
const named = async (tool, name) => (await c.call(tool)).find((x) => x.name === name);
function readsBack(actual, sent, what) {
  for (const k of Object.keys(sent)) assert.deepEqual(actual[k], sent[k], `${what}: ${k}`);
}
const noZoneBasedFirewall = (e) => /zone-based-firewall-not-configured/.test(e.message);

// Zone-based firewall appears only once the controller has finished provisioning a gateway AND the firewall upgrade was
// done in the app (no API for it is known). Observed on Network 10.6.106 (2026-10-17): a virtual gateway that answers the
// controller's wg-genkeypair command (see build-emu-image) completes provisioning and the console offers the upgrade; a
// snapshot taken after the upgrade (UNIFI_ZBF_SNAPSHOT) then has zones. run.sh sets UNIFI_ZBF_EXPECTED in that pass, where
// a console without zones is a failure; in a plain run it is a skip.
const expected = Boolean(process.env.UNIFI_ZBF_EXPECTED);
test('is zone-based firewall available on this console?', async (t) => {
  const devices = await c.call('unifi_devices');
  t.diagnostic(`devices: ${devices.map(describe).join('; ') || 'none'}`);
  try {
    await until('zone-based firewall on the console', async () => {
      try {
        await c.call('unifi_firewall_zones');
        return true;
      } catch (e) {
        if (!noZoneBasedFirewall(e)) throw e;
        return null;
      }
    }, { seconds: expected ? 180 : 10, every: 5 });
    t.diagnostic('zone-based firewall is available');
  } catch (e) {
    if (!/timed out/.test(e.message)) throw e;
    if (expected) {
      const gw = devices.filter(isGateway);
      assert.fail(`no zone-based firewall in the ZBF snapshot pass. ${gw.length
        ? `The console lists ${gw.map(describe).join('; ')}: run.sh starts a virtual UXGB with MAC 00:27:22:e0:00:01, so the snapshot's gateway must be that one and its state ONLINE or OFFLINE, not ADOPTING.`
        : 'The console has no gateway: the snapshot was taken before the gateway was adopted.'} Is the snapshot taken after the upgrade?`);
    }
    t.skip('this console has no zone-based firewall: it needs a gateway the console has provisioned, and the upgrade done in the app');
  }
});

test('firewall zones and policies: create, edit, toggle, reorder, delete', async (t) => {
  const zonesPath = `sites/${site}/firewall/zones`;
  const policiesPath = `sites/${site}/firewall/policies`;
  try {
    await c.call('unifi_firewall_zones');
  } catch (e) {
    if (!noZoneBasedFirewall(e)) throw e;
    { if (expected) throw e; return t.skip('this console has no zone-based firewall'); }
  }
  const zoneBefore = await c.call('unifi_firewall_zones');
  await change('POST', zonesPath, { name: 'e2e-zone-a', networkIds: [] });
  await change('POST', zonesPath, { name: 'e2e-zone-b', networkIds: [] });
  const zoneA = await named('unifi_firewall_zones', 'e2e-zone-a');
  const zoneB = await named('unifi_firewall_zones', 'e2e-zone-b');
  const made = [];
  try {
    assert.ok(zoneA && zoneB, 'both zones are listed');
    await change('PUT', `${zonesPath}/${zoneB.id}`, { name: 'e2e-zone-b2', networkIds: [] });
    assert.ok(await named('unifi_firewall_zones', 'e2e-zone-b2'), 'the zone was renamed');

    const policy = (name) => ({
      name, enabled: true, loggingEnabled: false, action: { type: 'ALLOW', allowReturnTraffic: false }, ipProtocolScope: { ipVersion: 'IPV4' },
      source: { zoneId: zoneA.id }, destination: { zoneId: zoneB.id },
    });
    await change('POST', policiesPath, policy('e2e-policy-1'));
    await change('POST', policiesPath, policy('e2e-policy-2'));
    const p1 = await named('unifi_firewall_policies', 'e2e-policy-1');
    const p2 = await named('unifi_firewall_policies', 'e2e-policy-2');
    made.push(p1, p2);
    readsBack(p1, policy('e2e-policy-1'), 'policy 1');

    await planAndApply(c, 'unifi_plan_set_firewall_policy', { policyId: p1.id, enabled: false });
    assert.equal((await named('unifi_firewall_policies', 'e2e-policy-1')).enabled, false, 'disabled through PUT');
    await planAndApply(c, 'unifi_plan_set_firewall_policy', { policyId: p1.id, loggingEnabled: true });
    const logged = await named('unifi_firewall_policies', 'e2e-policy-1');
    assert.equal(logged.loggingEnabled, true, 'logging switched on through PATCH');
    assert.equal(logged.enabled, false, 'the PATCH did not undo the disable');
    assert.equal((await named('unifi_firewall_policies', 'e2e-policy-2')).enabled, true, 'the other policy was not touched');

    const q = `?sourceFirewallZoneId=${zoneA.id}&destinationFirewallZoneId=${zoneB.id}`;
    const order = (await c.call('unifi_get', { path: `/${policiesPath}/ordering${q}` })).orderedFirewallPolicyIds;
    const swapped = { ...order, beforeSystemDefined: [...order.beforeSystemDefined].reverse() };
    await change('PUT', `${policiesPath}/ordering${q}`, { orderedFirewallPolicyIds: swapped });
    assert.deepEqual((await c.call('unifi_get', { path: `/${policiesPath}/ordering${q}` })).orderedFirewallPolicyIds, swapped, 'the new order reads back');
  } finally {
    for (const p of made) if (p) await change('DELETE', `${policiesPath}/${p.id}`);
    for (const name of ['e2e-zone-a', 'e2e-zone-b', 'e2e-zone-b2']) {
      const z = await named('unifi_firewall_zones', name);
      if (z) await change('DELETE', `${zonesPath}/${z.id}`);
    }
  }
  assert.deepEqual(await c.call('unifi_firewall_zones'), zoneBefore, 'back to the starting zones');
});
