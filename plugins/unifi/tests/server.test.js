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

function fakeApi(log, tls) {
  const make = tls ? (fn) => https.createServer(tls, fn) : (fn) => http.createServer(fn);
  return make((req, res) => {
    const u = new URL(req.url, 'http://x');
    log.push([req.method, u.pathname, req.headers['x-api-key']]);
    const out = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers['x-api-key'] !== 'k') return out(401, { error: 'no' });
    if (u.pathname === '/v1/hosts') return out(200, { data: [{ id: 'C1', type: 'console' }] });
    const rel = u.pathname.startsWith(LP) ? CP + u.pathname.slice(LP.length) : u.pathname;
    if (rel === `${CP}/info`) return out(200, { applicationVersion: '10' });
    if (rel === `${CP}/sites`) return out(200, { count: 1, totalCount: 1, data: [{ id: 'S1', name: 'Default' }] });
    if (rel === `${CP}/sites/S1/clients`) {
      const off = Number(u.searchParams.get('offset'));
      const lim = Number(u.searchParams.get('limit'));
      const rows = Array.from({ length: 250 }, (_, n) => ({ n, name: `c${n}`, ip: '10.0.0.1' })).slice(off, off + lim);
      return out(200, { offset: off, limit: lim, count: rows.length, totalCount: 250, data: rows });
    }
    out(404, { error: 'nf' });
  });
}

async function withServer(env, fn, { local } = {}) {
  const log = [];
  const api = fakeApi(log, local);
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
    return await fn({ rpc, call, log });
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
