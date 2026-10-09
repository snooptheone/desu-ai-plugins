'use strict';
// Run: node --test plugins/unifi/tests
const test = require('node:test');
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
  device: { id: 'D1', name: 'AP1', model: 'U7 Pro', state: 'ONLINE', interfaces: { radios: [{ channel: 36 }] } },
  policies: {
    P1: { id: 'P1', index: 5, name: 'SSH', enabled: true, loggingEnabled: true, action: { type: 'ALLOW' }, ipProtocolScope: { ipVersion: 'IPV6' }, source: { zoneId: 'Z1' }, destination: { zoneId: 'Z2', trafficFilter: { portFilter: { trafficMatchingListId: 'L1' } } }, metadata: { origin: 'USER_DEFINED' } },
    P2: { id: 'P2', index: 6, name: 'Block All Traffic', enabled: true, loggingEnabled: false, action: { type: 'BLOCK' }, ipProtocolScope: { ipVersion: 'IPV4_AND_IPV6' }, source: { zoneId: 'Z1' }, destination: { zoneId: 'Z2' }, metadata: { origin: 'SYSTEM_DEFINED', configurable: false } },
  },
  lists: { L1: { id: 'L1', name: 'SSH', type: 'PORTS', items: [{ type: 'PORT_NUMBER', value: 22 }] } },
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
    const rel = u.pathname.startsWith(LP) ? CP + u.pathname.slice(LP.length) : u.pathname;
    if (req.method !== 'GET') state.writes.push({ method: req.method, path: rel.slice(CP.length), body });
    if (rel === `${CP}/info`) return out(200, { applicationVersion: '10' });
    if (rel === `${CP}/sites`) return out(200, { count: 1, totalCount: 1, data: [{ id: 'S1', name: 'Default' }] });
    if (rel === `${CP}/sites/S1/devices/D1`) return out(200, state.device);
    if (rel === `${CP}/sites/S1/devices/D1/actions`) return out(200, {});
    if (rel === `${CP}/sites/S1/firewall/zones`) return list([{ id: 'Z1', name: 'External' }, { id: 'Z2', name: 'Gateway' }]);
    if (rel === `${CP}/sites/S1/firewall/policies`) return list(Object.values(state.policies));
    let m = rel.match(/\/sites\/S1\/firewall\/policies\/(\w+)$/);
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
    return await fn({ rpc, call, log, state });
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
const WRITE_ENV = () => ({ UNIFI_API_KEY: 'k', UNIFI_ENABLE_WRITES: 'true', CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'unifi-data-')) });
const json = (r) => JSON.parse(text(r));
const WRITE_NAMES = ['unifi_plan_restart_device', 'unifi_plan_set_firewall_policy', 'unifi_plan_update_traffic_list', 'unifi_apply_change'];
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
