'use strict';
// Run: node --test plugins/unifi/tests/*.test.js
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');

const SERVER = path.join(__dirname, '..', 'mcp', 'server.js');
const CP = '/v1/connector/consoles/C1/proxy/network/integration/v1';
const LP = '/proxy/network/integration/v1';

// A throwaway self-signed certificate, like the one a UniFi console serves. Needs the openssl CLI.
function selfSigned() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unifi-test-'));
  const key = path.join(dir, 'k');
  const crt = path.join(dir, 'c');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=unifi.local', '-keyout', key, '-out', crt], { stdio: 'ignore' });
    return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const newState = () => ({
  writes: [],
  private: [],
  device: { id: 'D1', name: 'AP1', model: 'U7 Pro', state: 'ONLINE', interfaces: { radios: [{ channel: 36 }] } },
  policies: {
    P1: { id: 'P1', index: 5, name: 'SSH', enabled: true, loggingEnabled: true, action: { type: 'ALLOW' }, ipProtocolScope: { ipVersion: 'IPV6' }, source: { zoneId: 'Z1' }, destination: { zoneId: 'Z2', trafficFilter: { portFilter: { trafficMatchingListId: 'L1' } } }, metadata: { origin: 'USER_DEFINED' } },
    P2: { id: 'P2', index: 6, name: 'Block All Traffic', enabled: true, loggingEnabled: false, action: { type: 'BLOCK' }, ipProtocolScope: { ipVersion: 'IPV4_AND_IPV6' }, source: { zoneId: 'Z1' }, destination: { zoneId: 'Z2' }, metadata: { origin: 'SYSTEM_DEFINED', configurable: false } },
  },
  lists: { L1: { id: 'L1', name: 'SSH', type: 'PORTS', items: [{ type: 'PORT_NUMBER', value: 22 }] } },
  networks: { N1: { id: 'N1', name: 'Guest', enabled: true, vlanId: 30, management: 'GATEWAY', metadata: { origin: 'USER_DEFINED' } } },
  client: { id: 'C1', name: 'laptop', macAddress: 'aa:bb', type: 'WIRELESS', uptimeSec: 1 },
  ordering: { orderedFirewallPolicyIds: { beforeSystemDefined: ['P1'], afterSystemDefined: [] } },
});

function fakeApi(log, tls, state) {
  const make = tls ? (fn) => https.createServer(tls, fn) : (fn) => http.createServer(fn);
  return make((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      handle(req, res, raw ? JSON.parse(raw) : undefined);
    });
  });

  function handle(req, res, body) {
    const u = new URL(req.url, 'http://x');
    log.push([req.method, u.pathname, req.headers['x-api-key']]);
    const out = (code, payload) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
    const list = (rows) => out(200, { count: rows.length, totalCount: rows.length, data: rows });
    if (req.headers['x-api-key'] !== 'k') return out(401, { error: 'no' });
    if (u.pathname === '/v1/hosts') return out(200, { data: [{ id: 'C1', type: 'console' }] });
    if (u.pathname.startsWith('/proxy/network/api/') || u.pathname.startsWith('/proxy/network/v2/')) {
      const priv = u.pathname.slice('/proxy/network'.length);
      state.private.push({ method: req.method, path: priv + u.search, body });
      if (priv === '/api/s/default/stat/health') return out(200, { meta: { rc: 'ok' }, data: [{ subsystem: 'wlan', status: 'ok' }] });
      if (priv === '/api/s/default/stat/device') return out(200, { meta: { rc: 'ok' }, data: [{ name: 'AP1', x_authkey: 'device-secret', x_ssh_password: 'ssh-secret', model: 'U7PRO' }] });
      if (['/api/s/default/list/user', '/api/s/default/stat/current-channel', '/api/s/default/stat/ccode', '/api/s/default/stat/dpi', '/api/s/default/stat/fwupdate/latest-version'].includes(priv)) return out(200, { meta: { rc: 'ok' }, data: [{ from: priv }] });
      if (['/api/s/default/stat/session', '/api/s/default/stat/sitedpi'].includes(priv) && req.method === 'POST') return out(200, { meta: { rc: 'ok' }, data: [{ from: priv, x_secret: 's' }] });
      if (priv === '/api/s/default/stat/event') return out(404, { meta: { rc: 'error', msg: 'api.err.NotFound' } });
      if (priv === '/api/s/default/list/alarm') return out(200, { meta: { rc: 'error', msg: 'api.err.LoginRequired' } });
      if (priv === '/v2/api/site/default/system-log/all' && req.method === 'POST') return out(200, { data: [{ key: 'CLIENT_CONNECTED', timestamp: 1 }], page_number: body.pageNumber, total_page_count: 1, total_element_count: 1 });
      return out(404, { error: 'nf' });
    }
    const rel = u.pathname.startsWith(LP) ? CP + u.pathname.slice(LP.length) : u.pathname;
    if (req.method !== 'GET') state.writes.push({ method: req.method, path: rel.slice(CP.length), body });
    if (rel === `${CP}/html`) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>maintenance</html>'); }
    if (rel === `${CP}/info`) return out(200, { applicationVersion: '10' });
    if (rel === `${CP}/sites`) return out(200, { count: 1, totalCount: 1, data: [{ id: 'S1', name: 'Default', internalReference: 'default' }] });
    if (rel === `${CP}/sites/S1/devices/D1`) return out(200, state.device);
    if (rel === `${CP}/sites/S1/devices/D1/actions`) {
      if (!state.actionText) return out(200, {});
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(state.actionText);
    }
    if (state.noZbf && /\/sites\/S1\/firewall\/(policies|zones)$/.test(rel)) return out(400, { code: 'api.firewall.zone-based-firewall-not-configured', message: 'Zone Based Firewall is not configured' });
    if (rel === `${CP}/sites/S1/firewall/zones`) return list([{ id: 'Z1', name: 'External' }, { id: 'Z2', name: 'Gateway' }]);
    if (rel === `${CP}/sites/S1/firewall/policies`) return list(Object.values(state.policies));
    if (rel === `${CP}/sites/S1/firewall/policies/ordering`) {
      if (req.method === 'GET') return out(200, state.ordering);
      state.ordering = body;
      return out(200, body);
    }
    if (rel === `${CP}/sites/S1/networks` && req.method === 'POST') return out(201, (state.networks.N2 = { id: 'N2', ...body }));
    if (rel === `${CP}/sites/S1/networks/N1/references`) return out(200, { referenceResources: [{ resourceType: 'WIFI_BROADCAST', referenceCount: 1 }] });
    if (rel === `${CP}/sites/S1/clients/C1`) return out(200, state.client);
    if (rel === `${CP}/sites/S1/clients/C1/actions`) return out(200, {});
    let m = rel.match(/\/sites\/S1\/networks\/(\w+)$/);
    if (m && state.networks[m[1]]) {
      if (req.method === 'GET') return out(200, state.networks[m[1]]);
      if (req.method === 'DELETE') { delete state.networks[m[1]]; return out(200, {}); }
      state.networks[m[1]] = { ...body, id: m[1] };
      return out(200, state.networks[m[1]]);
    }
    m = rel.match(/\/sites\/S1\/firewall\/policies\/(\w+)$/);
    if (m && state.policies[m[1]]) {
      const cur = state.policies[m[1]];
      if (req.method === 'GET') return out(200, cur);
      state.policies[m[1]] = { ...cur, ...body };
      return out(200, state.policies[m[1]]);
    }
    m = rel.match(/\/sites\/S1\/traffic-matching-lists\/(\w+)$/);
    if (m && state.lists[m[1]]) {
      if (req.method === 'GET') return out(200, state.lists[m[1]]);
      state.lists[m[1]] = { ...state.lists[m[1]], ...body };
      return out(200, state.lists[m[1]]);
    }
    if (rel === `${CP}/sites/S1/clients`) {
      const off = Number(u.searchParams.get('offset'));
      const lim = Number(u.searchParams.get('limit'));
      const rows = Array.from({ length: 250 }, (_, n) => ({ n, name: `c${n}`, ip: '10.0.0.1' })).slice(off, off + lim);
      return out(200, { offset: off, limit: lim, count: rows.length, totalCount: 250, data: rows });
    }
    out(404, { error: 'nf' });
  }
}

async function withServer(env, fn, { local } = {}) {
  const log = [];
  const state = newState();
  const api = fakeApi(log, local, state);
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const addr = `127.0.0.1:${api.address().port}`;
  const childEnv = { ...process.env, UNIFI_API_BASE: `http://${addr}`, UNIFI_CONSOLE_HOST: undefined, ...(local ? { UNIFI_CONSOLE_HOST: addr } : {}), ...env };
  for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
  const child = spawn(process.execPath, [SERVER], { env: childEnv, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      pending.get(msg.id)?.(msg);
    }
  });
  let nextId = 1;
  const rpc = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
  try {
    return await fn({ rpc, call, log, state, raw: (line) => child.stdin.write(`${line}\n`) });
  } finally {
    child.kill();
    api.close();
  }
}

const text = (r) => r.content[0].text;

test('initialize and tools/list: every tool is read-only', () => withServer({ UNIFI_API_KEY: 'k' }, async ({ rpc }) => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'unifi');
  const { tools } = (await rpc('tools/list')).result;
  assert.ok(tools.length >= 16);
  for (const t of tools) assert.equal(t.annotations.readOnlyHint, true, t.name);
}));

test('info and sites', () => withServer({ UNIFI_API_KEY: 'k' }, async ({ call }) => {
  assert.deepEqual(JSON.parse(text(await call('unifi_info', {}))), { applicationVersion: '10' });
  assert.equal(JSON.parse(text(await call('unifi_sites', {})))[0].id, 'S1');
}));

test('device detail returns the single device object', () => withServer({ UNIFI_API_KEY: 'k' }, async ({ call }) => {
  const d = JSON.parse(text(await call('unifi_device', { deviceId: 'D1' })));
  assert.equal(d.interfaces.radios[0].channel, 36);
  assert.equal((await call('unifi_device', {})).isError, true);
}));

test('pagination, automatic site, fields projection', () => withServer({ UNIFI_API_KEY: 'k' }, async ({ call }) => {
  const all = JSON.parse(text(await call('unifi_clients', {})));
  assert.equal(all.length, 250);
  const some = JSON.parse(text(await call('unifi_clients', { fields: ['name'] })));
  assert.deepEqual(some[0], { name: 'c0' });
}));

test('only GET requests, with the key header', () => withServer({ UNIFI_API_KEY: 'k' }, async ({ call, log }) => {
  await call('unifi_clients', {});
  await call('unifi_get', { path: '/sites' });
  assert.ok(log.length > 0);
  assert.ok(log.every(([m, , k]) => m === 'GET' && k === 'k'));
}));

test('unifi_get rejects full URLs without any request', () => withServer({ UNIFI_API_KEY: 'k' }, async ({ call, log }) => {
  for (const p of ['https://evil.example/x', 'http://evil.example/x', '//evil.example/x']) {
    const r = await call('unifi_get', { path: p });
    assert.equal(r.isError, true, p);
  }
  assert.equal(log.length, 0);
}));

test('missing key is a clear tool error', () => withServer({ UNIFI_API_KEY: '' }, async ({ call, log }) => {
  const r = await call('unifi_info', {});
  assert.equal(r.isError, true);
  assert.match(text(r), /UNIFI_API_KEY is not set/);
  assert.equal(log.length, 0);
}));

test('bad key surfaces the HTTP error', () => withServer({ UNIFI_API_KEY: 'bad' }, async ({ call }) => {
  const r = await call('unifi_info', {});
  assert.equal(r.isError, true);
  assert.match(text(r), /401/);
}));

test('unknown tool and unknown method', () => withServer({ UNIFI_API_KEY: 'k' }, async ({ call, rpc }) => {
  assert.equal((await call('unifi_nope', {})).isError, true);
  assert.equal((await rpc('nope')).error.code, -32601);
}));

const tls = selfSigned();
const localTest = tls ? test : test.skip;

localTest('local mode: self-signed console, no connector, GET only', () => withServer({ UNIFI_API_KEY: 'k' }, async ({ call, log }) => {
  assert.deepEqual(JSON.parse(text(await call('unifi_info', {}))), { applicationVersion: '10' });
  assert.equal(JSON.parse(text(await call('unifi_clients', {}))).length, 250);
  assert.ok(log.length > 0);
  assert.ok(log.every(([m, p, k]) => m === 'GET' && k === 'k' && p.startsWith(LP) && p !== '/v1/hosts'));
}, { local: tls }));

localTest('local mode: wrong key is an HTTP error', () => withServer({ UNIFI_API_KEY: 'bad' }, async ({ call }) => {
  const r = await call('unifi_info', {});
  assert.equal(r.isError, true);
  assert.match(text(r), /401/);
}, { local: tls }));

test('an unset console host (empty or placeholder) means cloud mode', async () => {
  for (const host of ['', '${user_config.console_host}']) {
    await withServer({ UNIFI_API_KEY: 'k', UNIFI_CONSOLE_HOST: host }, async ({ call, log }) => {
      assert.deepEqual(JSON.parse(text(await call('unifi_info', {}))), { applicationVersion: '10' });
      assert.ok(log.some(([, p]) => p === '/v1/hosts'));
    });
  }
});

test('an invalid console host is rejected before any request', () => withServer({ UNIFI_API_KEY: 'k', UNIFI_CONSOLE_HOST: 'evil.example/x@y' }, async ({ call, log }) => {
  const r = await call('unifi_info', {});
  assert.equal(r.isError, true);
  assert.match(text(r), /Invalid console host/);
  assert.equal(log.length, 0);
}));

// ── writes ──
const dataDirs = [];
after(() => dataDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const WRITE_ENV = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unifi-data-'));
  dataDirs.push(dir);
  return { UNIFI_API_KEY: 'k', UNIFI_ENABLE_WRITES: 'true', CLAUDE_PLUGIN_DATA: dir };
};
const json = (r) => JSON.parse(text(r));
const WRITE_NAMES = ['unifi_plan_restart_device', 'unifi_plan_set_firewall_policy', 'unifi_plan_update_traffic_list', 'unifi_plan_change', 'unifi_apply_change'];
const logLines = (env) => fs.readFileSync(path.join(env.CLAUDE_PLUGIN_DATA, 'changes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('writes are off by default: no write tools, calls refused, no request', async () => {
  for (const flag of [undefined, '', 'false', '${user_config.enable_writes}']) {
    await withServer({ UNIFI_API_KEY: 'k', UNIFI_ENABLE_WRITES: flag }, async ({ rpc, call, log }) => {
      const names = (await rpc('tools/list')).result.tools.map((t) => t.name);
      for (const n of WRITE_NAMES) assert.ok(!names.includes(n), n);
      const r = await call('unifi_plan_restart_device', { deviceId: 'D1' });
      assert.equal(r.isError, true);
      assert.match(text(r), /Writes are disabled/);
      assert.equal((await call('unifi_apply_change', { approvalCode: 'X', confirmation: 'Y' })).isError, true);
      assert.equal(log.length, 0);
    });
  }
});

test('writes on: plan tools are read-only, apply is marked destructive', () => withServer(WRITE_ENV(), async ({ rpc }) => {
  const tools = (await rpc('tools/list')).result.tools;
  for (const n of WRITE_NAMES) assert.ok(tools.some((t) => t.name === n), n);
  for (const t of tools.filter((x) => x.name.startsWith('unifi_plan_'))) assert.equal(t.annotations.readOnlyHint, true, t.name);
  const apply = tools.find((t) => t.name === 'unifi_apply_change');
  assert.equal(apply.annotations.readOnlyHint, false);
  assert.equal(apply.annotations.destructiveHint, true);
}));

test('planning changes nothing; apply needs the code and the exact confirmation', () => {
  const env = WRITE_ENV();
  return withServer(env, async ({ call, state }) => {
    const plan = json(await call('unifi_plan_restart_device', { deviceId: 'D1' }));
    assert.match(plan.summary, /Restart device "AP1"/);
    assert.equal(plan.confirmation, 'RESTART AP1');
    assert.deepEqual(state.writes, []);

    const bad = await call('unifi_apply_change', { approvalCode: plan.approvalCode, confirmation: 'restart it' });
    assert.equal(bad.isError, true);
    assert.deepEqual(state.writes, []);
    assert.equal((await call('unifi_apply_change', { approvalCode: 'NOPE', confirmation: plan.confirmation })).isError, true);
    assert.deepEqual(state.writes, []);

    const ok = await call('unifi_apply_change', { approvalCode: plan.approvalCode, confirmation: plan.confirmation });
    assert.notEqual(ok.isError, true, text(ok));
    assert.deepEqual(state.writes, [{ method: 'POST', path: '/sites/S1/devices/D1/actions', body: { action: 'RESTART' } }]);

    const again = await call('unifi_apply_change', { approvalCode: plan.approvalCode, confirmation: plan.confirmation });
    assert.equal(again.isError, true);
    assert.match(text(again), /already used/);
    assert.equal(state.writes.length, 1);

    const lines = logLines(env);
    assert.deepEqual(lines.map((l) => l.phase), ['attempt', 'applied']);
    assert.equal(lines[0].before.name, 'AP1');
    assert.ok(!JSON.stringify(lines).includes('"k"'), 'the API key must not be logged');
  });
});

test('a write that succeeds with a non-JSON body is reported as applied, not failed', () => withServer(WRITE_ENV(), async ({ call, state }) => {
  state.actionText = 'OK';
  const plan = json(await call('unifi_plan_restart_device', { deviceId: 'D1' }));
  const ok = await call('unifi_apply_change', { approvalCode: plan.approvalCode, confirmation: plan.confirmation });
  assert.notEqual(ok.isError, true, text(ok));
  assert.equal(json(ok).result.raw, 'OK');
  assert.match(json(ok).result.warning, /check that the change took effect/);
  assert.equal(state.writes.length, 1);
}));

test('a plan goes stale when the resource changes before apply', () => withServer(WRITE_ENV(), async ({ call, state }) => {
  const plan = json(await call('unifi_plan_restart_device', { deviceId: 'D1' }));
  state.device.state = 'OFFLINE';
  const r = await call('unifi_apply_change', { approvalCode: plan.approvalCode, confirmation: plan.confirmation });
  assert.equal(r.isError, true);
  assert.match(text(r), /changed since/);
  assert.deepEqual(state.writes, []);
}));

test('firewall: disabling a user policy sends the whole policy on PUT', () => withServer(WRITE_ENV(), async ({ call, state }) => {
  const plan = json(await call('unifi_plan_set_firewall_policy', { policyId: 'P1', enabled: false }));
  assert.match(plan.summary, /"SSH" \(External -> Gateway, ALLOW, IPV6\): enabled: true -> false/);
  await call('unifi_apply_change', { approvalCode: plan.approvalCode, confirmation: plan.confirmation });
  const [w] = state.writes;
  assert.equal(w.method, 'PUT');
  assert.equal(w.body.enabled, false);
  assert.equal(w.body.name, 'SSH');
  for (const k of ['id', 'index', 'metadata']) assert.ok(!(k in w.body), k);
  assert.equal(state.policies.P1.enabled, false);
}));

test('firewall: logging-only change is a PATCH with just that field', () => withServer(WRITE_ENV(), async ({ call, state }) => {
  const plan = json(await call('unifi_plan_set_firewall_policy', { policyId: 'P1', loggingEnabled: false }));
  await call('unifi_apply_change', { approvalCode: plan.approvalCode, confirmation: plan.confirmation });
  assert.deepEqual(state.writes, [{ method: 'PATCH', path: '/sites/S1/firewall/policies/P1', body: { loggingEnabled: false } }]);
}));

test('firewall: system policies, no-ops and bad input are refused at plan time', () => withServer(WRITE_ENV(), async ({ call, state }) => {
  for (const args of [{ policyId: 'P2', enabled: false }, { policyId: 'P2', loggingEnabled: true }, { policyId: 'P1', enabled: true },
    { policyId: 'P1' }, { policyId: 'P1', enabled: 'no' }, { policyId: 'NOPE', enabled: false }]) {
    assert.equal((await call('unifi_plan_set_firewall_policy', args)).isError, true, JSON.stringify(args));
  }
  assert.deepEqual(state.writes, []);
}));

test('traffic list: plan shows the diff and who uses it, apply replaces the items', () => withServer(WRITE_ENV(), async ({ call, state }) => {
  const items = [{ type: 'PORT_NUMBER', value: 22 }, { type: 'PORT_NUMBER', value: 2222 }];
  const plan = json(await call('unifi_plan_update_traffic_list', { listId: 'L1', items }));
  assert.deepEqual(plan.added, [{ type: 'PORT_NUMBER', value: 2222 }]);
  assert.deepEqual(plan.removed, []);
  assert.deepEqual(plan.usedBy, ['SSH']);
  assert.equal(plan.confirmation, 'UPDATE traffic list "SSH" (+1 -0): +PORT_NUMBER 2222');
  assert.match(plan.summary, /\+PORT_NUMBER 2222/);
  assert.deepEqual(state.writes, []);
  await call('unifi_apply_change', { approvalCode: plan.approvalCode, confirmation: plan.confirmation });
  assert.deepEqual(state.writes, [{ method: 'PUT', path: '/sites/S1/traffic-matching-lists/L1', body: { name: 'SSH', type: 'PORTS', items } }]);
}));

test('traffic list: empty, malformed and unchanged item lists are refused', () => withServer(WRITE_ENV(), async ({ call, state }) => {
  for (const items of [[], 'x', [{ type: 'PORT_NUMBER' }], [{ type: 'PORT_NUMBER', value: 22 }]]) {
    assert.equal((await call('unifi_plan_update_traffic_list', { listId: 'L1', items })).isError, true, JSON.stringify(items));
  }
  assert.deepEqual(state.writes, []);
}));

test('apply refuses to run if the change cannot be logged', async () => {
  const env = WRITE_ENV();
  fs.mkdirSync(path.join(env.CLAUDE_PLUGIN_DATA, 'changes.jsonl')); // a directory where the log file should be
  await withServer(env, async ({ call, state }) => {
    const plan = json(await call('unifi_plan_restart_device', { deviceId: 'D1' }));
    const r = await call('unifi_apply_change', { approvalCode: plan.approvalCode, confirmation: plan.confirmation });
    assert.equal(r.isError, true);
    assert.deepEqual(state.writes, []);
  });
});

// ── audit findings ──
test('apply always asks the person: marked requiresUserInteraction, and only apply', () => withServer(WRITE_ENV(), async ({ rpc }) => {
  const { tools } = (await rpc('tools/list')).result;
  for (const t of tools) {
    const flagged = Boolean(t._meta && t._meta['anthropic/requiresUserInteraction'] === true);
    assert.equal(flagged, t.name === 'unifi_apply_change', t.name);
  }
}));

test('dot segments in a path or an id never leave the integration API', () => withServer(WRITE_ENV(), async ({ call, log }) => {
  for (const p of ['/../../v1/hosts', '/sites/%2e%2e/x', '/a/./b', '/sites\\x', '/%zz', '/..%2f..%2f..%2fv1/hosts', '/sites%2f..%2fx', '/a%5c..%5cb', '/%2e%2e%2fx']) {
    assert.equal((await call('unifi_get', { path: p })).isError, true, p);
  }
  for (const [tool, args] of [['unifi_device', { deviceId: '..' }], ['unifi_device', { deviceId: 'a/b' }], ['unifi_clients', { site: '..' }],
    ['unifi_plan_restart_device', { deviceId: '..' }], ['unifi_plan_restart_device', { deviceId: 'D1', site: '.' }],
    ['unifi_plan_set_firewall_policy', { policyId: '..', enabled: false }], ['unifi_plan_update_traffic_list', { listId: 'a/b', items: [{ type: 'PORT_NUMBER', value: 1 }] }]]) {
    const r = await call(tool, args);
    assert.equal(r.isError, true, `${tool} ${JSON.stringify(args)}`);
    assert.match(text(r), /Invalid/);
  }
  assert.equal(log.length, 0);
}));

test('junk lines on stdin do not stop the server', () => withServer({ UNIFI_API_KEY: 'k' }, async ({ call, raw }) => {
  for (const line of ['null', '42', '[]', '"x"', '{not json', 'true']) raw(line);
  assert.deepEqual(JSON.parse(text(await call('unifi_info', {}))), { applicationVersion: '10' });
}));

const hasIpv6 = (() => { try { return Object.values(os.networkInterfaces()).flat().some((i) => i.address === '::1'); } catch { return false; } })();
const ipv6Test = tls && hasIpv6 ? test : test.skip;

ipv6Test('local mode works with an IPv6 console address', async () => {
  const log = [];
  const state = newState();
  const api = fakeApi(log, tls, state);
  await new Promise((r) => api.listen(0, '::1', r));
  try {
    const env = { ...process.env, UNIFI_API_KEY: 'k', UNIFI_CONSOLE_HOST: `[::1]:${api.address().port}` };
    const child = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    const answer = await new Promise((resolve) => {
      child.stdout.once('data', (d) => resolve(JSON.parse(String(d))));
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'unifi_info', arguments: {} } })}\n`);
    });
    child.kill();
    assert.notEqual(answer.result.isError, true, JSON.stringify(answer));
    assert.deepEqual(JSON.parse(text(answer.result)), { applicationVersion: '10' });
  } finally {
    api.close();
  }
});

test('the version reported at initialize is the plugin version', () => withServer({ UNIFI_API_KEY: 'k' }, async ({ rpc }) => {
  const manifest = require('../.claude-plugin/plugin.json');
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.serverInfo.version, manifest.version);
}));

test('names that only exist on Object.prototype are unknown tools', async () => {
  for (const env of [{ UNIFI_API_KEY: 'k' }, WRITE_ENV()]) {
    await withServer(env, async ({ call, log }) => {
      for (const name of ['constructor', 'toString', '__proto__', 'unifi_constructor', 'unifi_toString', 'unifi___proto__', 'hasOwnProperty']) {
        const r = await call(name, {});
        assert.equal(r.isError, true, name);
        assert.match(text(r), /Unknown tool|Writes are disabled/, name);
      }
      assert.equal(log.length, 0);
    });
  }
});

test('a 200 answer that is not JSON gives a clear error', () => withServer({ UNIFI_API_KEY: 'k' }, async ({ call }) => {
  const r = await call('unifi_get', { path: '/html' });
  assert.equal(r.isError, true);
  assert.match(text(r), /Not JSON from .*\/html \(HTTP 200\): <html>maintenance/);
}));

test('traffic list: the confirmation phrase shows the values, and stays short for big changes', () => withServer(WRITE_ENV(), async ({ call, state }) => {
  const small = json(await call('unifi_plan_update_traffic_list', { listId: 'L1', name: 'SSH2', items: [{ type: 'PORT_NUMBER', value: 2222 }] }));
  assert.equal(small.confirmation, 'UPDATE traffic list "SSH" (+1 -1): +PORT_NUMBER 2222, -PORT_NUMBER 22, rename "SSH2"');

  const items = Array.from({ length: 60 }, (_, n) => ({ type: 'PORT_NUMBER', value: 3000 + n }));
  const big = json(await call('unifi_plan_update_traffic_list', { listId: 'L1', items }));
  assert.ok(big.confirmation.length < 260, big.confirmation.length);
  assert.match(big.confirmation, /^UPDATE traffic list "SSH" \(\+60 -1\): \+PORT_NUMBER 3000/); // the totals are visible even when values are cut
  assert.match(big.confirmation, /\.\.\. and \d+ more$/);
  assert.match(big.summary, /\+PORT_NUMBER 3059/); // the summary lists everything
  const r = await call('unifi_apply_change', { approvalCode: big.approvalCode, confirmation: big.confirmation });
  assert.notEqual(r.isError, true, text(r));
  assert.equal(state.writes.length, 1);
}));

test('a name that ends with a space can still be confirmed', () => withServer(WRITE_ENV(), async ({ call, state }) => {
  state.device.name = 'AP1 ';
  const plan = json(await call('unifi_plan_restart_device', { deviceId: 'D1' }));
  const r = await call('unifi_apply_change', { approvalCode: plan.approvalCode, confirmation: plan.confirmation });
  assert.notEqual(r.isError, true, text(r));
  assert.equal(state.writes.length, 1);
}));

// ── unifi_plan_change: the rest of the API ──
const GUEST = { name: 'Guest', enabled: true, vlanId: 31, management: 'GATEWAY' };

test('plan_change: PUT shows what changes, apply sends the body and the digest binds it', () => withServer(WRITE_ENV(), async ({ call, state }) => {
  const plan = json(await call('unifi_plan_change', { method: 'PUT', path: 'sites/S1/networks/N1', body: GUEST }));
  assert.deepEqual(plan.changed, { vlanId: { from: 30, to: 31 } });
  assert.deepEqual(plan.notInBody, []);
  assert.match(plan.confirmation, /^PUT networks\/N1 "Guest" \{.*"vlanId":31.*\} \[[0-9a-f]{8}\]$/);
  assert.deepEqual(state.writes, []);
  const other = json(await call('unifi_plan_change', { method: 'PUT', path: 'sites/S1/networks/N1', body: { ...GUEST, vlanId: 32 } }));
  assert.notEqual(other.confirmation.slice(-10), plan.confirmation.slice(-10));
  assert.equal((await call('unifi_apply_change', { approvalCode: plan.approvalCode, confirmation: other.confirmation })).isError, true);
  assert.deepEqual(state.writes, []);
  const ok = await call('unifi_apply_change', { approvalCode: plan.approvalCode, confirmation: plan.confirmation });
  assert.notEqual(ok.isError, true, text(ok));
  assert.deepEqual(state.writes, [{ method: 'PUT', path: '/sites/S1/networks/N1', body: GUEST }]);
}));

test('plan_change: DELETE says what uses the network, and removes it only after apply', () => withServer(WRITE_ENV(), async ({ call, state }) => {
  const plan = json(await call('unifi_plan_change', { method: 'DELETE', path: '/sites/S1/networks/N1?force=true' }));
  assert.match(plan.summary, /^DELETE networks\/N1 "Guest"\. This cannot be undone\./);
  assert.equal(plan.references.referenceResources[0].referenceCount, 1);
  assert.deepEqual(state.writes, []);
  await call('unifi_apply_change', { approvalCode: plan.approvalCode, confirmation: plan.confirmation });
  assert.deepEqual(state.writes, [{ method: 'DELETE', path: '/sites/S1/networks/N1', body: undefined }]);
  assert.equal(state.networks.N1, undefined);
}));

test('plan_change: create has nothing to read, and a stale plan is not possible for it', () => withServer(WRITE_ENV(), async ({ call, state }) => {
  const plan = json(await call('unifi_plan_change', { method: 'POST', path: 'sites/S1/networks', body: { name: 'IoT', vlanId: 40 } }));
  assert.match(plan.summary, /^Create in networks: /);
  await call('unifi_apply_change', { approvalCode: plan.approvalCode, confirmation: plan.confirmation });
  assert.deepEqual(state.writes, [{ method: 'POST', path: '/sites/S1/networks', body: { name: 'IoT', vlanId: 40 } }]);
}));

test('plan_change: a client counter that moves on its own does not make the plan stale', () => withServer(WRITE_ENV(), async ({ call, state }) => {
  const plan = json(await call('unifi_plan_change', { method: 'POST', path: 'sites/S1/clients/C1/actions', body: { action: 'AUTHORIZE_GUEST_ACCESS' } }));
  assert.match(plan.summary, /^Run an action on clients\/C1 "laptop"/);
  state.client.uptimeSec = 999;
  const ok = await call('unifi_apply_change', { approvalCode: plan.approvalCode, confirmation: plan.confirmation });
  assert.notEqual(ok.isError, true, text(ok));
  assert.equal(state.writes[0].path, '/sites/S1/clients/C1/actions');
}));

test('plan_change: a configuration that changes before apply makes the plan stale', () => withServer(WRITE_ENV(), async ({ call, state }) => {
  const plan = json(await call('unifi_plan_change', { method: 'PUT', path: 'sites/S1/networks/N1', body: GUEST }));
  state.networks.N1.enabled = false;
  const r = await call('unifi_apply_change', { approvalCode: plan.approvalCode, confirmation: plan.confirmation });
  assert.equal(r.isError, true);
  assert.match(text(r), /changed since/);
  assert.deepEqual(state.writes, []);
}));

test('plan_change: ordering takes its two zones as query and reads them first', () => withServer(WRITE_ENV(), async ({ call, state, log }) => {
  const path = 'sites/S1/firewall/policies/ordering?sourceFirewallZoneId=Z1&destinationFirewallZoneId=Z2';
  const body = { orderedFirewallPolicyIds: { beforeSystemDefined: ['P2', 'P1'], afterSystemDefined: [] } };
  const plan = json(await call('unifi_plan_change', { method: 'PUT', path, body }));
  assert.ok(Object.hasOwn(plan.changed, 'orderedFirewallPolicyIds'));
  assert.ok(log.some(([m, p]) => m === 'GET' && p.endsWith('/firewall/policies/ordering')));
  await call('unifi_apply_change', { approvalCode: plan.approvalCode, confirmation: plan.confirmation });
  assert.deepEqual(state.writes[0].body, body);
}));

test('plan_change: operations that are not in the API, odd queries and bad bodies are refused before any request', () => withServer(WRITE_ENV(), async ({ call, state, log }) => {
  const bad = [
    { method: 'DELETE', path: 'sites/S1' }, { method: 'POST', path: 'sites' }, { method: 'PUT', path: 'sites/S1/devices/D1', body: { a: 1 } },
    { method: 'GET', path: 'sites/S1/networks' }, { method: 'PUT', path: 'sites/S1/networks/ordering', body: { a: 1 } },
    { method: 'PATCH', path: 'sites/S1/networks/N1', body: { a: 1 } }, { method: 'POST', path: 'sites/S1/networks/N1/references', body: { a: 1 } },
    { method: 'DELETE', path: 'sites/S1/networks/N1', body: { a: 1 } }, { method: 'PUT', path: 'sites/S1/networks/N1' },
    { method: 'PUT', path: 'sites/S1/networks/N1', body: [] }, { method: 'PUT', path: 'sites/S1/networks/N1', body: {} },
    { method: 'DELETE', path: 'sites/S1/networks/N1?evil=1' }, { method: 'DELETE', path: 'sites/S1/hotspot/vouchers' },
    { method: 'DELETE', path: 'https://evil.example/x' }, { method: 'DELETE', path: 'sites/S1/networks/..' },
    { method: 'POST', path: 'sites/S1/../../v1/hosts', body: { a: 1 } }, { method: 'POST', path: 'sites/%2e%2e/networks', body: { a: 1 } },
    { method: 'DELETE', path: 'sites/S1/networks/N1#x' },
  ];
  for (const args of bad) assert.equal((await call('unifi_plan_change', args)).isError, true, JSON.stringify(args));
  assert.deepEqual(state.writes, []);
  assert.equal(log.length, 0);
}));

test('plan_change: a PUT that changes nothing is refused', () => withServer(WRITE_ENV(), async ({ call, state }) => {
  const r = await call('unifi_plan_change', { method: 'PUT', path: 'sites/S1/networks/N1', body: { name: 'Guest', vlanId: 30 } });
  assert.equal(r.isError, true);
  assert.match(text(r), /Nothing to change/);
  assert.deepEqual(state.writes, []);
}));

test('plan_change is off with writes off', () => withServer({ UNIFI_API_KEY: 'k' }, async ({ call, log }) => {
  const r = await call('unifi_plan_change', { method: 'DELETE', path: 'sites/S1/networks/N1' });
  assert.equal(r.isError, true);
  assert.match(text(r), /Writes are disabled/);
  assert.equal(log.length, 0);
}));

test('traffic list: a console without zone-based firewall can still be edited, and the plan says who uses it is unknown', () => withServer(WRITE_ENV(), async ({ call, state }) => {
  state.noZbf = true;
  const items = [{ type: 'PORT_NUMBER', value: 22 }, { type: 'PORT_NUMBER', value: 2222 }];
  const plan = json(await call('unifi_plan_update_traffic_list', { listId: 'L1', items }));
  assert.equal(plan.usedBy, null);
  assert.match(plan.usedByError, /zone-based-firewall-not-configured/);
  assert.match(plan.summary, /Used by: unknown \(the firewall policies could not be read\)\./);
  const ok = await call('unifi_apply_change', { approvalCode: plan.approvalCode, confirmation: plan.confirmation });
  assert.notEqual(ok.isError, true, text(ok));
  assert.equal(state.writes.length, 1);
}));

test('plan_change: a secret in the body (a WiFi passphrase) is never shown or logged, but is sent', () => {
  const env = WRITE_ENV();
  return withServer(env, async ({ call, state }) => {
    const body = { management: 'GATEWAY', name: 'Guest', enabled: true, vlanId: 30, wifiPassphrase: 'hunter2', nested: { apiKey: 'k-secret' } };
    const plan = json(await call('unifi_plan_change', { method: 'PUT', path: 'sites/S1/networks/N1', body }));
    assert.ok(!JSON.stringify(plan).includes('hunter2') && !JSON.stringify(plan).includes('k-secret'), 'plan text');
    assert.match(plan.confirmation, /"wifiPassphrase":"\*\*\*"/);
    await call('unifi_apply_change', { approvalCode: plan.approvalCode, confirmation: plan.confirmation });
    assert.equal(state.writes[0].body.wifiPassphrase, 'hunter2');
    assert.equal(state.writes[0].body.nested.apiKey, 'k-secret');
    assert.ok(!fs.readFileSync(path.join(env.CLAUDE_PLUGIN_DATA, 'changes.jsonl'), 'utf8').match(/hunter2|k-secret/), 'change log');
  });
});

test('plan_change: the same request planned twice gets a different digest, so a secret cannot be guessed from the phrase', () => withServer(WRITE_ENV(), async ({ call }) => {
  const body = { management: 'GATEWAY', name: 'Guest', enabled: true, vlanId: 30, wifiPassphrase: 'one' };
  const a = json(await call('unifi_plan_change', { method: 'PUT', path: 'sites/S1/networks/N1', body }));
  const b = json(await call('unifi_plan_change', { method: 'PUT', path: 'sites/S1/networks/N1', body }));
  assert.notEqual(a.confirmation, b.confirmation);
  assert.ok(!a.confirmation.includes('one'));
}));

// ── the controller's private API (local mode): statistics, alarms, the system log ──
const privateTest = tls ? localTest : test.skip;
const LOCAL = { local: tls };
const priv = (state) => state.private;

privateTest('private API tools are listed only in local mode', async () => {
  await withServer({ UNIFI_API_KEY: 'k' }, async ({ rpc, call }) => {
    const names = (await rpc('tools/list')).result.tools.map((t) => t.name);
    assert.ok(!names.includes('unifi_legacy_get') && !names.includes('unifi_system_log') && !names.includes('unifi_stats_query'));
    const r = await call('unifi_legacy_get', { path: 'stat/health' });
    assert.equal(r.isError, true);
    assert.match(text(r), /need local mode/);
  });
  await withServer({ UNIFI_API_KEY: 'k' }, async ({ rpc }) => {
    const tools = (await rpc('tools/list')).result.tools;
    for (const n of ['unifi_legacy_get', 'unifi_system_log', 'unifi_stats_query']) assert.equal(tools.find((t) => t.name === n).annotations.readOnlyHint, true, n);
  }, LOCAL);
});

privateTest('legacy_get: an allowed path is read with the key, the site name comes from the site list', () => withServer({ UNIFI_API_KEY: 'k' }, async ({ call, state }) => {
  assert.deepEqual(json(await call('unifi_legacy_get', { path: '/stat/health' })), [{ subsystem: 'wlan', status: 'ok' }]);
  assert.deepEqual(priv(state), [{ method: 'GET', path: '/api/s/default/stat/health', body: undefined }]);
  assert.deepEqual(json(await call('unifi_legacy_get', { path: 'stat/health', site: 'S1' })), [{ subsystem: 'wlan', status: 'ok' }]);
  assert.equal((await call('unifi_legacy_get', { path: 'stat/health', site: 'nope' })).isError, true);
}, LOCAL));

privateTest('legacy_get: secrets of the private API (x_ keys) never reach the output', () => withServer({ UNIFI_API_KEY: 'k' }, async ({ call }) => {
  const out = text(await call('unifi_legacy_get', { path: 'stat/device' }));
  assert.ok(!/device-secret|ssh-secret/.test(out), out);
  assert.equal(json(await call('unifi_legacy_get', { path: 'stat/device' }))[0].model, 'U7PRO');
  assert.deepEqual(json(await call('unifi_legacy_get', { path: 'stat/device', fields: ['name'] })), [{ name: 'AP1' }]);
}, LOCAL));

privateTest('legacy_get: only the listed reads; settings, commands, traversal and queries in the path are refused without a request', () => withServer({ UNIFI_API_KEY: 'k' }, async ({ call, state }) => {
  const before = priv(state).length;
  for (const path of ['rest/wlanconf', 'rest/setting', 'cmd/stamgr', 'set/setting/x', 'stat/health?x=1', 'stat/../rest/user', 'stat/%2e%2e/rest/user',
    'https://evil.example/x', 'stat/sta/zz', 'stat/sta/aaaaaaaaaaaaaaaaa', 'stat/report/hourly.evil', 'v2/system-log/all', 'v2/clients/active/extra', '', 'stat/health#x']) {
    const r = await call('unifi_legacy_get', { path });
    assert.equal(r.isError, true, path);
  }
  assert.equal(priv(state).length, before, 'no private request was made');
  assert.equal(state.writes.length, 0);
}, LOCAL));

privateTest('legacy_get: query filters are passed, bad ones refused', () => withServer({ UNIFI_API_KEY: 'k' }, async ({ call, state }) => {
  await call('unifi_legacy_get', { path: 'stat/health', query: { within: 24, _limit: 5 } });
  assert.equal(priv(state).at(-1).path, '/api/s/default/stat/health?within=24&_limit=5');
  for (const query of [{ 'a b': 1 }, { x: { y: 1 } }, { x: 'a\nb' }, { '../x': 1 }]) assert.equal((await call('unifi_legacy_get', { path: 'stat/health', query })).isError, true, JSON.stringify(query));
}, LOCAL));

privateTest('legacy_get: a refusal inside a 200 answer (meta.rc) and a 404 are clear errors', () => withServer({ UNIFI_API_KEY: 'k' }, async ({ call }) => {
  const a = await call('unifi_legacy_get', { path: 'list/alarm' });
  assert.equal(a.isError, true);
  assert.match(text(a), /refused the request: api\.err\.LoginRequired/);
  const e = await call('unifi_legacy_get', { path: 'stat/event' });
  assert.equal(e.isError, true);
  assert.match(text(e), /404/);
}, LOCAL));

privateTest('the site list is fetched once for several private reads, and a site it does not know asks the console again', () => withServer({ UNIFI_API_KEY: 'k' }, async ({ call, log }) => {
  const listings = () => log.filter(([, p]) => p.endsWith('/integration/v1/sites')).length;
  await call('unifi_legacy_get', { path: 'stat/health' });
  await call('unifi_legacy_get', { path: 'stat/sysinfo', site: 'default' });
  await call('unifi_legacy_get', { path: 'stat/health', site: 'S1' });
  assert.equal(listings(), 1, 'one listing for three reads');
  assert.equal((await call('unifi_legacy_get', { path: 'stat/health', site: 'nope' })).isError, true);
  assert.equal((await call('unifi_legacy_get', { path: 'stat/health', site: 'nope' })).isError, true);
  assert.equal(listings(), 3, 'a miss is never cached');
}, LOCAL));

privateTest('system_log: a fixed, bounded POST body to the log query, nothing else', () => withServer({ UNIFI_API_KEY: 'k' }, async ({ call, state }) => {
  const r = json(await call('unifi_system_log', { hours: 2, pageSize: 50, page: 1, categories: ['AUDIT'] }));
  assert.equal(r.data[0].key, 'CLIENT_CONNECTED');
  const [sent] = priv(state);
  assert.equal(sent.method, 'POST');
  assert.equal(sent.path, '/v2/api/site/default/system-log/all');
  assert.deepEqual(Object.keys(sent.body).sort(), ['categories', 'pageNumber', 'pageSize', 'timestampFrom', 'timestampTo']);
  assert.equal(sent.body.pageSize, 50);
  assert.equal(sent.body.pageNumber, 1);
  assert.deepEqual(sent.body.categories, ['AUDIT']);
  assert.equal(sent.body.timestampTo - sent.body.timestampFrom, 2 * 3600 * 1000);
  assert.equal(state.writes.length, 0, 'it is not a change');
}, LOCAL));

privateTest('the extra GET reads are allowed: known clients, channels, country codes, DPI, newest firmware', () => withServer({ UNIFI_API_KEY: 'k' }, async ({ call, state }) => {
  for (const path of ['list/user', 'stat/current-channel', 'stat/ccode', 'stat/dpi', 'stat/fwupdate/latest-version']) {
    assert.equal(json(await call('unifi_legacy_get', { path }))[0].from, `/api/s/default/${path}`);
  }
  for (const path of ['list/user/x', 'rest/user', 'stat/dpi/x', 'stat/fwupdate/x', 'list/setting']) assert.equal((await call('unifi_legacy_get', { path })).isError, true, path);
  assert.ok(priv(state).every((r) => r.method === 'GET'));
}, LOCAL));

privateTest('stats_query: each kind is a bounded POST to its one path, with a body built from checked values', () => withServer({ UNIFI_API_KEY: 'k' }, async ({ call, state }) => {
  const sent = async (args) => { await call('unifi_stats_query', args); return priv(state).at(-1); };
  const s1 = await sent({ kind: 'sessions', hours: 2, type: 'guest', mac: 'AA:BB:CC:DD:EE:FF' });
  assert.equal(s1.method, 'POST');
  assert.equal(s1.path, '/api/s/default/stat/session');
  assert.deepEqual(Object.keys(s1.body).sort(), ['end', 'mac', 'start', 'type']);
  assert.equal(s1.body.mac, 'aa:bb:cc:dd:ee:ff');
  assert.equal(s1.body.end - s1.body.start, 2 * 3600);
  const s3 = await sent({ kind: 'dpi', type: 'by_app', cats: [4, 18] });
  assert.equal(s3.path, '/api/s/default/stat/sitedpi');
  assert.deepEqual(s3.body, { type: 'by_app', cats: [4, 18] });
  assert.deepEqual((await sent({ kind: 'dpi' })).body, { type: 'by_cat' });
  const r = json(await call('unifi_stats_query', { kind: 'sessions' }));
  assert.notEqual(r[0].x_secret, 's', 'secrets are masked');
  assert.equal(state.writes.length, 0, 'not a change');
}, LOCAL));

privateTest('stats_query: unknown kinds, bad values and out-of-range numbers are refused without a request', () => withServer({ UNIFI_API_KEY: 'k' }, async ({ call, state }) => {
  for (const args of [{}, { kind: 'x' }, { kind: '__proto__' }, { kind: 'sessions', type: 'all/../x' }, { kind: 'sessions', mac: 'zz' }, { kind: 'sessions', mac: 'aaaaaaaaaaaaaaaaa' }, { kind: 'sessions', mac: ':::::::::::::::::' }, { kind: 'sessions', hours: 0 },
    { kind: 'sessions', hours: 24 * 91 }, { kind: 'ips_events' }, { kind: 'dpi', type: 'by_x' },
    { kind: 'dpi', cats: [1] }, { kind: 'dpi', type: 'by_app', cats: ['a'] }, { kind: 'dpi', type: 'by_app', cats: Array(51).fill(1) }]) {
    assert.equal((await call('unifi_stats_query', args)).isError, true, JSON.stringify(args));
  }
  assert.equal(priv(state).length, 0);
}, LOCAL));

privateTest('system_log: unknown classes, categories and out-of-range numbers are refused without a request', () => withServer({ UNIFI_API_KEY: 'k' }, async ({ call, state }) => {
  for (const args of [{ class: 'all/../x' }, { class: '__proto__' }, { class: 'constructor' }, { hours: 0 }, { hours: 24 * 91 }, { hours: 1.5 }, { pageSize: 501 }, { pageSize: 0 },
    { page: -1 }, { page: 'x' }, { categories: ['EVIL'] }, { categories: 'AUDIT' }]) {
    assert.equal((await call('unifi_system_log', args)).isError, true, JSON.stringify(args));
  }
  assert.equal(priv(state).length, 0);
}, LOCAL));
