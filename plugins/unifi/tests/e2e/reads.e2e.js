'use strict';
// Calls every GET operation of the Network API on the UniFi OS test VM and checks the answer against the OpenAPI
// spec of the VM's own version: required fields present and primitive types right. Sample data is created first so
// the lists are not empty. Operations that need a resource the VM does not have (devices, clients, zones) are
// reported as skipped, never silently passed. Do not run it by hand: ./run.sh restores the VM around it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { client, planAndApply, wifiBody } = require('./helper');
const { RESOURCES } = require('../../mcp/server.js');

let c;
let site;
let spec = null;
const made = []; // [method-less delete paths] to remove at the end

before(async () => {
  c = client();
  site = (await c.call('unifi_sites'))[0].id;
  const version = (await c.call('unifi_info')).applicationVersion;
  try {
    const res = await fetch(`https://developer.ui.com/network/v${version}/openapi.json`, { signal: AbortSignal.timeout(30000) });
    if (res.ok) spec = await res.json();
  } catch { /* offline: the shape checks are skipped, the calls are still made */ }
});
after(async () => {
  for (const p of made.reverse()) await planAndApply(c, 'unifi_plan_change', { method: 'DELETE', path: p }).catch(() => {});
  c.close();
});

const make = async (listTool, path, body, find) => {
  await planAndApply(c, 'unifi_plan_change', { method: 'POST', path, body });
  const item = (await c.call(listTool)).find(find);
  if (item) made.push(`${path}/${item.id}`);
  return item;
};

// ── a small checker for the parts of JSON Schema the spec uses ──
const resolve = (s) => {
  let cur = s;
  while (cur && cur.$ref) cur = spec.components.schemas[cur.$ref.split('/').pop()];
  return cur;
};
function collect(schema, value, acc, depth = 0) {
  const s = resolve(schema);
  if (!s || depth > 6) return;
  for (const r of s.required || []) acc.required.add(r);
  Object.assign(acc.props, s.properties || {});
  for (const part of s.allOf || []) collect(part, value, acc, depth + 1);
  const d = s.discriminator;
  if (d && value && typeof value === 'object') {
    const target = d.mapping && d.mapping[value[d.propertyName]];
    if (target) collect({ $ref: target }, value, acc, depth + 1);
  }
}
const typeOk = (type, v) => (type === 'integer' ? Number.isInteger(v)
  : type === 'number' ? typeof v === 'number'
    : type === 'array' ? Array.isArray(v)
      : type === 'object' ? typeof v === 'object' && !Array.isArray(v)
        : typeof v === type);
function check(schema, value, where, errors) {
  const acc = { required: new Set(), props: {} };
  collect(schema, value, acc);
  for (const r of acc.required) if (!(r in value)) errors.push(`${where}: missing required "${r}"`);
  for (const [k, ps] of Object.entries(acc.props)) {
    if (value[k] === undefined || value[k] === null) continue;
    const t = resolve(ps) && resolve(ps).type;
    if (['string', 'integer', 'number', 'boolean', 'array', 'object'].includes(t) && !typeOk(t, value[k])) errors.push(`${where}: "${k}" should be ${t}, got ${JSON.stringify(value[k]).slice(0, 40)}`);
  }
}
function checkResponse(opSchema, data, where, errors) {
  const s = resolve(opSchema);
  if (!s) return;
  const page = s.properties && s.properties.data && resolve(s.properties.data);
  if (page && page.type === 'array') {
    assert.ok(Array.isArray(data), `${where}: a list was expected`);
    data.slice(0, 10).forEach((item, i) => check(page.items, item, `${where}[${i}]`, errors));
  } else if (data && typeof data === 'object') {
    check(s, data, where, errors);
  }
}

test('every GET operation of the spec answers, and answers in the shape the spec says', async (t) => {
  assert.ok(spec, 'the OpenAPI spec of the VM version could not be downloaded from developer.ui.com');
  const net = await make('unifi_networks', `sites/${site}/networks`, { management: 'UNMANAGED', name: 'e2e-sweep', enabled: true, vlanId: 3951 }, (n) => n.name === 'e2e-sweep');
  const wifi = await make('unifi_wifi', `sites/${site}/wifi/broadcasts`, wifiBody('e2e-sweep-wifi'), (w) => w.name === 'e2e-sweep-wifi');
  const list = await make('unifi_traffic_lists', `sites/${site}/traffic-matching-lists`, { type: 'PORTS', name: 'e2e-sweep-ports', items: [{ type: 'PORT_NUMBER', value: 9090 }] }, (l) => l.name === 'e2e-sweep-ports');
  const dns = await make('unifi_dns_policies', `sites/${site}/dns/policies`, { type: 'A_RECORD', domain: 'sweep.example.test', ipv4Address: '192.0.2.20', ttlSeconds: 300, enabled: true }, (p) => p.domain === 'sweep.example.test');
  const acl = await make('unifi_acl_rules', `sites/${site}/acl-rules`, { type: 'IPV4', name: 'e2e-sweep-acl', enabled: true, action: 'BLOCK' }, (r) => r.name === 'e2e-sweep-acl');
  await planAndApply(c, 'unifi_plan_change', { method: 'POST', path: `sites/${site}/hotspot/vouchers`, body: { name: 'e2e-sweep-voucher', timeLimitMinutes: 15, count: 1 } });
  const voucher = (await c.call('unifi_get', { path: `/sites/${site}/hotspot/vouchers` })).find((v) => v.name === 'e2e-sweep-voucher');
  if (voucher) made.push(`sites/${site}/hotspot/vouchers/${voucher.id}`);

  // ids that the path parameters can take; the first item of a list when the VM has one
  const first = async (path) => {
    try {
      return ((await c.call('unifi_get', { path })) || [])[0];
    } catch (e) {
      if (/zone-based-firewall-not-configured/.test(e.message)) return undefined; // the one expected "not here"
      throw e; // a failing list is a finding, not a skip
    }
  };
  const ids = {
    siteId: site, networkId: net && net.id, wifiBroadcastId: wifi && wifi.id, trafficMatchingListId: list && list.id,
    dnsPolicyId: dns && dns.id, aclRuleId: acl && acl.id, voucherId: voucher && voucher.id,
    deviceId: (await first(`/sites/${site}/devices`))?.id, clientId: (await first(`/sites/${site}/clients`))?.id,
    firewallPolicyId: (await first(`/sites/${site}/firewall/policies`))?.id, firewallZoneId: (await first(`/sites/${site}/firewall/zones`))?.id,
    lagId: (await first(`/sites/${site}/switching/lags`))?.id, mcLagDomainId: (await first(`/sites/${site}/switching/mc-lag-domains`))?.id,
    switchStackId: (await first(`/sites/${site}/switching/switch-stacks`))?.id,
  };

  const errors = [];
  const done = [];
  const skipped = [];
  for (const [p, item] of Object.entries(spec.paths)) {
    const op = item.get;
    if (!op) continue;
    const params = [...p.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const required = (op.parameters || []).filter((x) => x.in === 'query' && x.required).map((x) => x.name);
    const missing = params.filter((n) => !ids[n]);
    if (missing.length || required.length) {
      skipped.push(`${p}${missing.length ? ` (no ${missing.join(', ')} on this VM)` : ` (needs query ${required.join(', ')})`}`);
      continue;
    }
    const path = p.replace(/^\/v1/, '').replace(/\{(\w+)\}/g, (_, n) => ids[n]);
    let data;
    try {
      data = await c.call('unifi_get', { path });
    } catch (e) {
      if (/zone-based-firewall-not-configured/.test(e.message)) skipped.push(`${p} (no zone-based firewall on this VM)`);
      else errors.push(`${p}: ${e.message.slice(0, 200)}`);
      continue;
    }
    done.push(p);
    const ok = op.responses && op.responses['200'] && op.responses['200'].content && op.responses['200'].content['application/json'];
    if (ok) checkResponse(ok.schema, data, p, errors);
  }
  t.diagnostic(`swept ${done.length} GET operations; skipped ${skipped.length}:\n  ${skipped.join('\n  ')}`);
  assert.deepEqual(errors, [], `${errors.length} problem(s):\n${errors.slice(0, 25).join('\n')}`);
});

test('each named read tool returns what unifi_get returns for its path', async (t) => {
  const skipped = [];
  const noZones = (e) => /zone-based-firewall-not-configured/.test(e.message);
  for (const [name, [, template, idName]] of Object.entries(RESOURCES)) {
    let args = {};
    let path = `/${template.replace('{site}', site)}`;
    if (idName) {
      const one = (await c.call('unifi_get', { path: `/sites/${site}/devices` }))[0];
      if (!one) { skipped.push(`${name} (no device on this VM; devices.e2e.js covers it)`); continue; }
      args = { [idName]: one.id };
      path = path.replace('{id}', one.id);
    }
    let viaTool;
    try {
      viaTool = await c.call(`unifi_${name}`, args);
    } catch (e) {
      if (!noZones(e)) throw e;
      skipped.push(`${name} (no zone-based firewall on this VM)`);
      continue;
    }
    assert.deepEqual(viaTool, await c.call('unifi_get', { path }), name);
  }
  t.diagnostic(`skipped: ${skipped.join('; ') || 'none'}`);
});
