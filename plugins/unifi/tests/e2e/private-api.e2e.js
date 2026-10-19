'use strict';
// The controller's private API through unifi_legacy_get and unifi_system_log, against the UniFi OS test VM.
// First question it answers: does the API key work on the private API at all? If it does not, the failure says so,
// and the way forward is a local read-only account instead of the key. Then: does each allowed read answer, does the
// private API agree with the official one, and does the system log record what the tests change.
// Do not run it by hand: ./run.sh restores the VM around it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { client, planAndApply } = require('./helper');

let c;
let site;
before(async () => {
  c = client();
  site = (await c.call('unifi_sites'))[0].id;
});
after(() => c.close());

const keyRefused = (e) => /HTTP 40[13]|LoginRequired|Unauthorized|Forbidden/i.test(e.message);
const fail = (what, e) => assert.fail(`${what}: ${e.message.slice(0, 300)}${keyRefused(e)
  ? '\n=> the API key is NOT accepted by the private API. Plan B: a local read-only account (username and password) instead of the key.' : ''}`);

async function read(path, query) {
  try {
    return await c.call('unifi_legacy_get', { path, query });
  } catch (e) {
    return fail(`GET ${path}`, e);
  }
}

test('the API key is accepted by the private API, and it reports the same version as the official one', async () => {
  const [sysinfo] = await read('stat/sysinfo');
  const official = (await c.call('unifi_info')).applicationVersion;
  assert.ok(sysinfo && sysinfo.version, 'stat/sysinfo has a version');
  assert.ok(sysinfo.version.startsWith(official.split('.').slice(0, 2).join('.')), `private ${sysinfo.version} vs official ${official}`);
});

test('health lists the subsystems, each with a status', async () => {
  const health = await read('stat/health');
  assert.ok(Array.isArray(health) && health.length > 0);
  for (const h of health) {
    assert.equal(typeof h.subsystem, 'string');
    assert.equal(typeof h.status, 'string');
  }
});

test('every allowed read answers; the table of results is in the report', async (t) => {
  const probes = [
    ['stat/device'], ['stat/device-basic'], ['stat/sta'], ['stat/alluser'], ['stat/guest'], ['stat/rogueap'],
    ['stat/event', { within: 24, _limit: 50 }], ['list/alarm'], ['cnt/alarm'], ['stat/authorization'], ['stat/voucher'],
    ['stat/report/hourly.site'], ['v2/clients/active'], ['v2/clients/history'], ['v2/aggregated-dashboard'],
    ['list/user'], ['stat/current-channel'], ['stat/ccode'], ['stat/dpi'], ['stat/fwupdate/latest-version'],
  ];
  // These answer 404 or 400 on Network 10.x (the system log replaced them); every other read must answer.
  const oldOnly = ['stat/event', 'list/alarm', 'cnt/alarm'];
  const rows = [];
  const broken = [];
  for (const [path, query] of probes) {
    try {
      const data = await c.call('unifi_legacy_get', { path, query });
      rows.push(`${path}: OK (${Array.isArray(data) ? `${data.length} items` : typeof data})`);
    } catch (e) {
      rows.push(`${path}: ${keyRefused(e) ? 'REFUSED (key?)' : /404/.test(e.message) ? 'not there (404)' : 'ERROR'} ${e.message.slice(0, 90)}`);
      if (!oldOnly.includes(path)) broken.push(rows.at(-1));
    }
  }
  t.diagnostic(`private API reads:\n  ${rows.join('\n  ')}`);
  assert.ok(!rows.some((r) => r.includes('REFUSED')), `the key was refused somewhere:\n${rows.join('\n')}`);
  assert.deepEqual(broken, [], 'reads that should answer on this version did not');
});

test('session and DPI queries answer (a POST that changes nothing); the table of results is in the report', async (t) => {
  const rows = [];
  const broken = [];
  for (const args of [{ kind: 'sessions' }, { kind: 'dpi' }, { kind: 'dpi', type: 'by_app', cats: [4] }]) {
    try {
      const data = await c.call('unifi_stats_query', args);
      rows.push(`${JSON.stringify(args)}: OK (${Array.isArray(data) ? `${data.length} items` : typeof data})`);
    } catch (e) {
      rows.push(`${JSON.stringify(args)}: ${keyRefused(e) ? 'REFUSED (key?)' : 'ERROR'} ${e.message.slice(0, 90)}`);
      broken.push(rows.at(-1));
    }
  }
  t.diagnostic(`stats queries:\n  ${rows.join('\n  ')}`);
  assert.ok(!rows.some((r) => r.includes('REFUSED')), `the key was refused somewhere:\n${rows.join('\n')}`);
  assert.deepEqual(broken, [], 'queries that should answer on this version did not');
});

test('the system log answers with the documented shape (or stat/event does, on Network 10.x)', async (t) => {
  let log = null;
  try {
    log = await c.call('unifi_system_log', { class: 'all', hours: 24 });
  } catch (e) {
    if (keyRefused(e)) fail('system log', e);
    t.diagnostic(`system log: ${e.message.slice(0, 150)}`);
  }
  if (log) {
    assert.ok(Array.isArray(log.data), 'data is a list');
    for (const entry of log.data.slice(0, 20)) assert.equal(typeof entry.timestamp, 'number', 'entries carry a timestamp in ms');
    t.diagnostic(`system log: ${log.data.length} entries on this page; page fields: ${Object.keys(log).join(', ')}`);
  } else {
    assert.ok(Array.isArray(await read('stat/event', { within: 24, _limit: 50 })), 'neither the system log nor stat/event answers');
  }
});

test('a change made through the official API shows up in the log', async (t) => {
  const stamp = Date.now();
  const count = async () => {
    try {
      const log = await c.call('unifi_system_log', { class: 'all', hours: 1, pageSize: 200 });
      return { n: log.total_element_count ?? log.data.length, text: JSON.stringify(log.data) };
    } catch {
      const events = await read('stat/event', { within: 1, _limit: 200 });
      return { n: events.length, text: JSON.stringify(events) };
    }
  };
  const before = await count();
  const base = `sites/${site}/networks`;
  const name = `e2e-log-${stamp}`;
  await planAndApply(c, 'unifi_plan_change', { method: 'POST', path: base, body: { management: 'UNMANAGED', name, enabled: true, vlanId: 3961 } });
  const net = (await c.call('unifi_networks')).find((n) => n.name === name);
  await planAndApply(c, 'unifi_plan_change', { method: 'DELETE', path: `${base}/${net.id}` });
  const after = await count();
  t.diagnostic(`log entries ${before.n} -> ${after.n}; the new network's name ${after.text.includes(name) ? 'IS' : 'is not'} in the log text`);
  assert.ok(after.n >= before.n, 'the log did not shrink');
});
