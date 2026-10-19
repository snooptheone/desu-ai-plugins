'use strict';
// Real changes through unifi_plan_change and the specific planners, against the UniFi OS test VM.
// Every test checks the effect by reading the resource back, not only that the API answered:
//   - what was sent is what is read (every field of the body),
//   - what was not touched is unchanged (the other items of the list, the other fields),
//   - what was deleted is gone.
// Every test creates what it needs and removes it again; run.sh rolls the VM back afterwards anyway.
// Do not run it by hand: ./run.sh restores the VM around it. Request bodies follow the 10.6.106 spec.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { client, planAndApply, wifiBody } = require('./helper');

let c;
let site;
before(async () => {
  c = client();
  site = (await c.call('unifi_sites'))[0].id;
});
after(() => c.close());

const change = (method, path, body) => planAndApply(c, 'unifi_plan_change', { method, path, body });
const named = async (tool, name) => (await c.call(tool)).find((x) => x.name === name);
const without = (list, id) => list.filter((x) => x.id !== id);

// Every field that was sent must read back the same. `skip` lists write-only fields (passphrases).
function readsBack(actual, sent, what, skip = []) {
  for (const k of Object.keys(sent)) if (!skip.includes(k)) assert.deepEqual(actual[k], sent[k], `${what}: ${k}`);
}

test('network: create, edit, delete, and nothing else moves', async () => {
  const base = `sites/${site}/networks`;
  const body = { management: 'UNMANAGED', name: 'e2e-net', enabled: true, vlanId: 3901 };
  const others = await c.call('unifi_networks');

  await change('POST', base, body);
  const net = await named('unifi_networks', 'e2e-net');
  assert.ok(net, 'the created network is listed');
  readsBack(net, body, 'after create');
  assert.deepEqual(without(await c.call('unifi_networks'), net.id), others, 'other networks untouched by the create');

  const { plan } = await change('PUT', `${base}/${net.id}`, { ...body, vlanId: 3902 });
  assert.deepEqual(Object.keys(plan.changed), ['vlanId']);
  const edited = await named('unifi_networks', 'e2e-net');
  readsBack(edited, { ...body, vlanId: 3902 }, 'after edit');
  assert.equal(edited.id, net.id, 'the edit keeps the id');

  const gone = await change('DELETE', `${base}/${net.id}`);
  assert.match(gone.plan.summary, /^DELETE networks\//);
  assert.deepEqual(await c.call('unifi_networks'), others, 'back to the starting list');
});

test('a plan made before somebody else changed the resource is refused, and the other change stays', async () => {
  const base = `sites/${site}/networks`;
  const body = { management: 'UNMANAGED', name: 'e2e-stale', enabled: true, vlanId: 3903 };
  await change('POST', base, body);
  const net = await named('unifi_networks', 'e2e-stale');
  try {
    const stale = await c.call('unifi_plan_change', { method: 'PUT', path: `${base}/${net.id}`, body: { ...body, vlanId: 3904 } });
    await change('PUT', `${base}/${net.id}`, { ...body, vlanId: 3905 });
    const r = await c.raw('unifi_apply_change', { approvalCode: stale.approvalCode, confirmation: stale.confirmation });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /changed since/);
    assert.equal((await named('unifi_networks', 'e2e-stale')).vlanId, 3905, 'the refused plan did not overwrite the newer change');
  } finally {
    await change('DELETE', `${base}/${net.id}`);
  }
});

test('a PUT that repeats the current values has nothing to change', async () => {
  const base = `sites/${site}/networks`;
  const body = { management: 'UNMANAGED', name: 'e2e-same', enabled: true, vlanId: 3906 };
  await change('POST', base, body);
  const net = await named('unifi_networks', 'e2e-same');
  try {
    await assert.rejects(c.call('unifi_plan_change', { method: 'PUT', path: `${base}/${net.id}`, body }), /Nothing to change/);
  } finally {
    await change('DELETE', `${base}/${net.id}`);
  }
});

test('network delete: refused while a WiFi uses it, done with ?force=true', async () => {
  const nets = `sites/${site}/networks`;
  const wifis = `sites/${site}/wifi/broadcasts`;
  await change('POST', nets, { management: 'UNMANAGED', name: 'e2e-force', enabled: true, vlanId: 3907 });
  const net = await named('unifi_networks', 'e2e-force');
  try {
    await change('POST', wifis, wifiBody('e2e-force-wifi', { network: { type: 'SPECIFIC', networkId: net.id } }));
    assert.ok(await named('unifi_wifi', 'e2e-force-wifi'), 'the WiFi on the network is listed');

    const plan = await c.call('unifi_plan_change', { method: 'DELETE', path: `${nets}/${net.id}` });
    assert.ok(plan.references, 'the plan says what still references the network');
    const refused = await c.raw('unifi_apply_change', { approvalCode: plan.approvalCode, confirmation: plan.confirmation });
    assert.equal(refused.isError, true, 'a plain DELETE of a network in use is refused by the API');
    assert.ok(await named('unifi_networks', 'e2e-force'), 'the network is still there');

    await change('DELETE', `${nets}/${net.id}?force=true`);
    assert.equal(await named('unifi_networks', 'e2e-force'), undefined, 'force removed the network');
  } finally {
    const left = await named('unifi_wifi', 'e2e-force-wifi');
    if (left) await change('DELETE', `${wifis}/${left.id}`);
    const stillNet = await named('unifi_networks', 'e2e-force');
    if (stillNet) await change('DELETE', `${nets}/${stillNet.id}?force=true`);
  }
});

test('WiFi: create, edit, delete; the passphrase is in the detail, not in the list', async () => {
  const base = `sites/${site}/wifi/broadcasts`;
  const body = wifiBody('e2e-wifi');
  const detail = async (id) => c.call('unifi_get', { path: `/${base}/${id}` }); // the list only has a summary
  await change('POST', base, body);
  const wifi = await named('unifi_wifi', 'e2e-wifi');
  assert.ok(wifi, 'the created WiFi is listed');
  const created = await detail(wifi.id);
  readsBack(created, body, 'after create', ['securityConfiguration', 'network', 'broadcastingFrequenciesGHz']);
  // the frequencies are a set: the console may return them in another order
  assert.deepEqual([...created.broadcastingFrequenciesGHz].sort(), [...body.broadcastingFrequenciesGHz].sort(), 'frequencies');
  assert.equal(created.securityConfiguration.type, 'WPA2_PERSONAL');
  assert.ok(!JSON.stringify(wifi).includes('e2e-passphrase-123'), 'the list summary does not carry the passphrase');
  assert.equal(created.securityConfiguration.passphrase, 'e2e-passphrase-123', 'the detail of one WiFi returns the passphrase that was set');

  const { plan } = await change('PUT', `${base}/${wifi.id}`, { ...body, hideName: true });
  assert.ok('hideName' in plan.changed, 'the edit shows the field that changed');
  assert.ok(!JSON.stringify(plan).includes('e2e-passphrase-123'), 'the plan does not show the passphrase');
  assert.equal((await detail(wifi.id)).hideName, true);

  await change('DELETE', `${base}/${wifi.id}`);
  assert.equal(await named('unifi_wifi', 'e2e-wifi'), undefined);
});

test('traffic list: create, edit with the specific planner, delete', async () => {
  const base = `sites/${site}/traffic-matching-lists`;
  const others = await c.call('unifi_traffic_lists');
  const created = { type: 'PORTS', name: 'e2e-ports', items: [{ type: 'PORT_NUMBER', value: 8080 }] };
  await change('POST', base, created);
  const list = await named('unifi_traffic_lists', 'e2e-ports');
  assert.ok(list, 'the created list is listed');
  readsBack(list, created, 'after create');

  const items = [{ type: 'PORT_NUMBER', value: 8080 }, { type: 'PORT_NUMBER', value: 8081 }];
  const { plan } = await planAndApply(c, 'unifi_plan_update_traffic_list', { listId: list.id, items });
  assert.deepEqual(plan.added, [{ type: 'PORT_NUMBER', value: 8081 }]);
  const edited = await named('unifi_traffic_lists', 'e2e-ports');
  assert.deepEqual(edited.items, items, 'the items read back are exactly the ones sent');
  assert.equal(edited.name, 'e2e-ports', 'the name was not touched');

  await change('DELETE', `${base}/${list.id}`);
  assert.deepEqual(await c.call('unifi_traffic_lists'), others, 'back to the starting lists');
});

test('DNS policy: create, edit, delete', async () => {
  const base = `sites/${site}/dns/policies`;
  const body = { type: 'A_RECORD', domain: 'e2e.example.test', ipv4Address: '192.0.2.10', ttlSeconds: 300, enabled: true };
  const find = async () => (await c.call('unifi_dns_policies')).find((p) => p.domain === body.domain);
  await change('POST', base, body);
  const policy = await find();
  assert.ok(policy, 'the created policy is listed');
  readsBack(policy, body, 'after create');

  const { plan } = await change('PUT', `${base}/${policy.id}`, { ...body, ttlSeconds: 600 });
  assert.deepEqual(Object.keys(plan.changed), ['ttlSeconds']);
  readsBack(await find(), { ...body, ttlSeconds: 600 }, 'after edit');

  await change('DELETE', `${base}/${policy.id}`);
  assert.equal(await find(), undefined);
});

test('ACL rule: create, edit, reorder, delete', async () => {
  const base = `sites/${site}/acl-rules`;
  const a = { type: 'IPV4', name: 'e2e-acl-a', enabled: true, action: 'BLOCK' };
  const b = { type: 'IPV4', name: 'e2e-acl-b', enabled: true, action: 'ALLOW' };
  await change('POST', base, a);
  await change('POST', base, b);
  const ruleA = await named('unifi_acl_rules', 'e2e-acl-a');
  const ruleB = await named('unifi_acl_rules', 'e2e-acl-b');
  try {
    assert.ok(ruleA && ruleB, 'both rules are listed');
    readsBack(ruleA, a, 'rule a');
    readsBack(ruleB, b, 'rule b');

    const { plan } = await change('PUT', `${base}/${ruleA.id}`, { ...a, enabled: false });
    assert.deepEqual(Object.keys(plan.changed), ['enabled']);
    assert.equal((await named('unifi_acl_rules', 'e2e-acl-a')).enabled, false);
    assert.equal((await named('unifi_acl_rules', 'e2e-acl-b')).enabled, true, 'the other rule was not touched');

    const order = (await c.call('unifi_get', { path: `/${base}/ordering` })).orderedAclRuleIds;
    const mine = order.filter((id) => id === ruleA.id || id === ruleB.id);
    assert.equal(mine.length, 2, 'both rules are in the ordering');
    const swapped = order.map((id) => (id === mine[0] ? mine[1] : id === mine[1] ? mine[0] : id));
    await change('PUT', `${base}/ordering`, { orderedAclRuleIds: swapped });
    assert.deepEqual((await c.call('unifi_get', { path: `/${base}/ordering` })).orderedAclRuleIds, swapped, 'the new order reads back');
  } finally {
    for (const rule of [ruleA, ruleB]) if (rule) await change('DELETE', `${base}/${rule.id}`);
  }
  assert.equal(await named('unifi_acl_rules', 'e2e-acl-a'), undefined);
  assert.equal(await named('unifi_acl_rules', 'e2e-acl-b'), undefined);
});

test('hotspot vouchers: create, delete by id, and delete in bulk by filter', async () => {
  const base = `sites/${site}/hotspot/vouchers`;
  const list = async () => c.call('unifi_get', { path: `/${base}` });
  const mine = async (name) => (await list()).filter((v) => v.name === name);

  await change('POST', base, { name: 'e2e-single', timeLimitMinutes: 60, count: 1 });
  const [single] = await mine('e2e-single');
  assert.ok(single, 'the created voucher is listed');
  assert.equal(single.timeLimitMinutes, 60);
  await change('DELETE', `${base}/${single.id}`);
  assert.deepEqual(await mine('e2e-single'), []);

  await change('POST', base, { name: 'e2e-bulk', timeLimitMinutes: 30, count: 3 });
  await change('POST', base, { name: 'e2e-keep', timeLimitMinutes: 30, count: 1 });
  try {
    assert.equal((await mine('e2e-bulk')).length, 3, 'three bulk vouchers were created');
    const plan = await c.call('unifi_plan_change', { method: 'DELETE', path: `${base}?filter=name.eq('e2e-bulk')` });
    assert.match(plan.summary, /^DELETE hotspot\/vouchers/);
    await c.call('unifi_apply_change', { approvalCode: plan.approvalCode, confirmation: plan.confirmation });
    assert.deepEqual(await mine('e2e-bulk'), [], 'the filter removed all the bulk vouchers');
    assert.equal((await mine('e2e-keep')).length, 1, 'a voucher outside the filter was not touched');
  } finally {
    for (const v of await mine('e2e-keep')) await change('DELETE', `${base}/${v.id}`);
    for (const v of await mine('e2e-bulk')) await change('DELETE', `${base}/${v.id}`);
  }
});

test('operations outside the API are refused without a request', async () => {
  await assert.rejects(c.call('unifi_plan_change', { method: 'DELETE', path: `sites/${site}` }), /not a change of the UniFi Network API/);
});
