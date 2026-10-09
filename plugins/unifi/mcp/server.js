#!/usr/bin/env node
// UniFi Network MCP server (stdio, no dependencies, Node 18+).
// Talks to the official Network Integration API in one of two modes:
//   cloud (default): through the Site Manager Connector
//     https://api.ui.com/v1/connector/consoles/<console>/proxy/network/integration/v1
//   local: when UNIFI_CONSOLE_HOST is set, straight to the console
//     https://<host>/proxy/network/integration/v1
//     The console's certificate is self-signed, so TLS verification is skipped in this mode.
// Read tools only send GET requests. The write tools exist only when UNIFI_ENABLE_WRITES=true, and the
// only code that sends a non-GET request is unifi_apply_change, which needs a one-time approval code
// from a previous plan, its exact confirmation phrase, and a resource unchanged since the plan.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const { version: VERSION } = require('../.claude-plugin/plugin.json');
const BASE = (process.env.UNIFI_API_BASE || 'https://api.ui.com').replace(/\/+$/, '');
const PAGE = 200;

// name -> [description, path template, needs id]
const RESOURCES = {
  info: ['Network application version', 'info'],
  sites: ['Sites of the console', 'sites'],
  pending_devices: ['Devices waiting for adoption', 'pending-devices'],
  devices: ['Managed devices (APs, switches, gateway)', 'sites/{site}/devices'],
  device: ['One device in detail: switch ports (state, speed) or AP radios (channel, width, band)', 'sites/{site}/devices/{id}', 'deviceId'],
  device_stats: ['Latest statistics of one device (CPU, memory, uplink rates)', 'sites/{site}/devices/{id}/statistics/latest', 'deviceId'],
  clients: ['Connected clients', 'sites/{site}/clients'],
  networks: ['Networks / VLANs', 'sites/{site}/networks'],
  wifi: ['WiFi broadcasts (SSIDs)', 'sites/{site}/wifi/broadcasts'],
  firewall_policies: ['Firewall policies', 'sites/{site}/firewall/policies'],
  firewall_zones: ['Firewall zones', 'sites/{site}/firewall/zones'],
  acl_rules: ['ACL rules', 'sites/{site}/acl-rules'],
  dns_policies: ['DNS policies', 'sites/{site}/dns/policies'],
  wans: ['WAN links', 'sites/{site}/wans'],
  vpn_servers: ['VPN servers', 'sites/{site}/vpn/servers'],
  vpn_tunnels: ['Site-to-site VPN tunnels', 'sites/{site}/vpn/site-to-site-tunnels'],
  traffic_lists: ['Traffic matching lists', 'sites/{site}/traffic-matching-lists'],
};

const siteProp = { type: 'string', description: 'Site id. Default: the only site' };
const fieldsProp = {
  type: 'array', items: { type: 'string' },
  description: 'Keep only these top-level fields of each item (saves tokens)',
};

const TOOLS = Object.entries(RESOURCES).map(([name, [description, path, idName]]) => {
  const properties = {};
  if (path.includes('{site}')) properties.site = siteProp;
  if (idName) properties[idName] = { type: 'string', description: `The ${idName}` };
  if (!['info', 'device', 'device_stats'].includes(name)) properties.fields = fieldsProp;
  return {
    name: `unifi_${name}`,
    description,
    inputSchema: { type: 'object', properties, required: idName ? [idName] : [] },
    annotations: { readOnlyHint: true, openWorldHint: true },
  };
});
TOOLS.push({
  name: 'unifi_get',
  description: 'GET any path under the Network Integration API v1, e.g. /dpi/categories',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path such as /dpi/categories (no full URLs)' }, fields: fieldsProp },
    required: ['path'],
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
});

function apiKey() {
  const key = (process.env.UNIFI_API_KEY || '').trim();
  if (!key) throw new Error('UNIFI_API_KEY is not set: enable the plugin and enter the API key (https://unifi.ui.com/settings/api-keys)');
  return key;
}

// Local mode host (host or host:port), or null for cloud mode. An unset plugin option can reach us
// as an empty string or as the literal "${user_config.…}" placeholder; both mean "not set".
function localHost() {
  const h = (process.env.UNIFI_CONSOLE_HOST || '').trim();
  if (!h || h.includes('${')) return null;
  if (!/^[A-Za-z0-9.\-:[\]]+$/.test(h)) throw new Error(`Invalid console host: ${h}`);
  return h;
}

function httpsRequest(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { method, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || 443, path: u.pathname + u.search, headers, timeout: 30000, rejectUnauthorized: false },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { text += d; });
        res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

async function request(method, url, jsonBody) {
  const headers = { 'X-API-KEY': apiKey(), Accept: 'application/json' };
  const body = jsonBody === undefined ? undefined : JSON.stringify(jsonBody);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    if (localHost()) {
      res = await httpsRequest(method, url, headers, body);
    } else {
      const r = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(30000) });
      res = { ok: r.ok, status: r.status, text: await r.text() };
    }
  } catch (e) {
    if (e.message.startsWith('UNIFI_API_KEY')) throw e;
    throw new Error(`Connection failed: ${e.cause ? e.cause.message : e.message}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.split('?')[0]}: ${res.text.slice(0, 500)}`);
  if (!res.text) return null;
  try {
    return JSON.parse(res.text);
  } catch {
    throw new Error(`Not JSON from ${url.split('?')[0]} (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
  }
}

const get = (url) => request('GET', url);

// Follow offset/limit pagination and return the concatenated `data` list.
async function getAll(url) {
  const sep = url.includes('?') ? '&' : '?';
  const items = [];
  for (;;) {
    const page = await get(`${url}${sep}limit=${PAGE}&offset=${items.length}`);
    if (!page || !Array.isArray(page.data)) return page;
    items.push(...page.data);
    if (!page.data.length || items.length >= (page.totalCount ?? items.length)) return items;
  }
}

let consoleIdCache;
async function consoleId() {
  if (process.env.UNIFI_CONSOLE_ID) return process.env.UNIFI_CONSOLE_ID;
  if (!consoleIdCache) {
    const hosts = (await get(`${BASE}/v1/hosts`)).data.filter((h) => h.type === 'console');
    if (hosts.length !== 1) {
      throw new Error(`${hosts.length} consoles found; set UNIFI_CONSOLE_ID to one of: ${hosts.map((h) => h.id).join(', ')}`);
    }
    consoleIdCache = hosts[0].id;
  }
  return consoleIdCache;
}

const enc = encodeURIComponent;

// A value that goes into one URL path segment (an id or a site). '.' and '..' would be resolved by
// the URL parser and walk out of the integration API.
function seg(value, what) {
  const v = String(value ?? '');
  if (!v || v === '.' || v === '..' || /[/\\\u0000-\u001f]/.test(v)) throw new Error(`Invalid ${what}`);
  return enc(v);
}

function checkPath(p) {
  for (const part of p.split('?')[0].split('/')) {
    let d;
    try { d = decodeURIComponent(part); } catch { throw new Error('Invalid path'); }
    // Decode first, then split again: "..%2f..%2fv1" is one part here but two '..' for a server that decodes %2f.
    if (d.includes('\\') || d.split('/').some((x) => x === '.' || x === '..')) throw new Error("path must not contain '.' or '..' segments");
  }
}

async function root() {
  const host = localHost();
  if (host) return `https://${host}/proxy/network/integration/v1`;
  return `${BASE}/v1/connector/consoles/${enc(await consoleId())}/proxy/network/integration/v1`;
}

async function resolveSite(site) {
  if (site) return site;
  const sites = await getAll(`${await root()}/sites`);
  if (sites.length !== 1) {
    throw new Error(`Several sites: pass site with one of: ${sites.map((s) => `${s.id} (${s.name})`).join(', ')}`);
  }
  return sites[0].id;
}

function project(data, fields) {
  if (!Array.isArray(fields) || !fields.length || !Array.isArray(data)) return data;
  return data.map((row) => Object.fromEntries(fields.filter((f) => f in row).map((f) => [f, row[f]])));
}

// ── Writes: plan, then apply ──
const WRITES = String(process.env.UNIFI_ENABLE_WRITES || '').trim().toLowerCase() === 'true';
const PLAN_TTL_MS = 5 * 60 * 1000;
const plans = new Map(); // approval code -> plan (in memory only)

const dataDir = () => process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'plugins', 'data', 'unifi');

// Append-only record of every attempted change. Throws if it cannot be written, so nothing is applied unlogged.
function logChange(entry) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.appendFileSync(path.join(dataDir(), 'changes.jsonl'), `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
}

const apiPath = async (p) => `${await root()}/${p}`;
const apiGet = async (p) => get(await apiPath(p));

function makePlan({ summary, confirmation, method, path: p, body, before, readCurrent, details }) {
  for (const [c, x] of plans) if (Date.now() > x.expires) plans.delete(c);
  const approvalCode = crypto.randomBytes(5).toString('hex').toUpperCase();
  plans.set(approvalCode, { confirmation, method, path: p, body, before, readCurrent, expires: Date.now() + PLAN_TTL_MS });
  return {
    summary,
    ...details,
    approvalCode,
    confirmation,
    expiresInSeconds: PLAN_TTL_MS / 1000,
    next: 'Nothing has been changed. Show the summary to the user and wait for an explicit yes in the chat. Only then call unifi_apply_change with approvalCode and confirmation exactly as given.',
  };
}

async function planRestartDevice(a) {
  if (!a.deviceId) throw new Error('deviceId is required');
  const deviceId = seg(a.deviceId, 'deviceId');
  const p = `sites/${seg(await resolveSite(a.site), 'site')}/devices/${deviceId}`;
  const read = async () => {
    const d = await apiGet(p);
    return { id: d.id, name: d.name, model: d.model, state: d.state };
  };
  const before = await read();
  return makePlan({
    summary: `Restart device "${before.name}" (${before.model}), currently ${before.state}. It goes offline for a few minutes and its clients disconnect.`,
    confirmation: `RESTART ${before.name}`,
    method: 'POST', path: `${p}/actions`, body: { action: 'RESTART' }, before, readCurrent: read,
  });
}

const POLICY_PUT_KEYS = ['action', 'connectionStateFilter', 'description', 'destination', 'enabled', 'ipProtocolScope', 'ipsecFilter', 'loggingEnabled', 'name', 'schedule', 'source'];

async function planSetFirewallPolicy(a) {
  if (!a.policyId) throw new Error('policyId is required');
  const policyId = seg(a.policyId, 'policyId');
  const wanted = {};
  for (const k of ['enabled', 'loggingEnabled']) {
    if (a[k] === undefined) continue;
    if (typeof a[k] !== 'boolean') throw new Error(`${k} must be true or false`);
    wanted[k] = a[k];
  }
  if (!Object.keys(wanted).length) throw new Error('Pass enabled and/or loggingEnabled');
  const site = seg(await resolveSite(a.site), 'site');
  const p = `sites/${site}/firewall/policies/${policyId}`;
  const read = () => apiGet(p);
  const cur = await read();
  const origin = cur.metadata && cur.metadata.origin;
  const changes = Object.fromEntries(Object.entries(wanted).filter(([k, v]) => cur[k] !== v));
  if (!Object.keys(changes).length) throw new Error('Nothing to change: the policy already has those values');
  if ('enabled' in changes && origin !== 'USER_DEFINED') throw new Error(`Only user-defined policies can be enabled or disabled; this one is ${origin}`);
  if ('loggingEnabled' in changes && origin !== 'USER_DEFINED' && !(cur.metadata && cur.metadata.configurable)) throw new Error(`This policy (${origin}) is not configurable`);
  const zones = Object.fromEntries((await getAll(await apiPath(`sites/${site}/firewall/zones`))).map((z) => [z.id, z.name]));
  const zone = (side) => zones[cur[side].zoneId] || cur[side].zoneId;
  // The API takes only loggingEnabled on PATCH; enabling needs the whole policy on PUT.
  const full = 'enabled' in changes;
  const body = full ? { ...Object.fromEntries(POLICY_PUT_KEYS.filter((k) => k in cur).map((k) => [k, cur[k]])), ...changes } : changes;
  const list = Object.entries(changes).map(([k, v]) => `${k}: ${cur[k]} -> ${v}`).join(', ');
  return makePlan({
    summary: `Firewall policy "${cur.name}" (${zone('source')} -> ${zone('destination')}, ${cur.action && cur.action.type}, ${cur.ipProtocolScope && cur.ipProtocolScope.ipVersion}): ${list}.`,
    confirmation: `SET firewall policy "${cur.name}": ${Object.entries(changes).map(([k, v]) => `${k}=${v}`).join(', ')}`,
    method: full ? 'PUT' : 'PATCH', path: p, body, before: cur, readCurrent: read,
    details: { changes },
  });
}

const sortedJson = (o) => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));

async function planUpdateTrafficList(a) {
  if (!a.listId) throw new Error('listId is required');
  const listId = seg(a.listId, 'listId');
  if (!Array.isArray(a.items) || !a.items.length || !a.items.every((i) => i && typeof i === 'object' && i.type && i.value !== undefined)) {
    throw new Error('items must be a non-empty array of objects like {"type":"PORT_NUMBER","value":22}; it replaces the whole list');
  }
  if (a.name !== undefined && (typeof a.name !== 'string' || !a.name)) throw new Error('name must be a non-empty string');
  const site = seg(await resolveSite(a.site), 'site');
  const p = `sites/${site}/traffic-matching-lists/${listId}`;
  const read = () => apiGet(p);
  const cur = await read();
  const body = { name: a.name ?? cur.name, type: cur.type, items: a.items };
  const have = new Set((cur.items || []).map(sortedJson));
  const want = new Set(a.items.map(sortedJson));
  const added = a.items.filter((i) => !have.has(sortedJson(i)));
  const removed = (cur.items || []).filter((i) => !want.has(sortedJson(i)));
  if (!added.length && !removed.length && body.name === cur.name) throw new Error('Nothing to change: the list already has these items');
  const policies = await getAll(await apiPath(`sites/${site}/firewall/policies`));
  const usedBy = policies.filter((x) => JSON.stringify(x).includes(cur.id)).map((x) => x.name);
  return makePlan({
    summary: `Traffic list "${cur.name}" (${cur.type}): add ${added.length}, remove ${removed.length}${body.name !== cur.name ? `, rename to "${body.name}"` : ''}. Used by: ${usedBy.length ? usedBy.map((n) => `"${n}"`).join(', ') : 'no firewall policy'}.`,
    confirmation: `UPDATE traffic list "${cur.name}"`,
    method: 'PUT', path: p, body, before: cur, readCurrent: read,
    details: { added, removed, usedBy },
  });
}

async function applyChange(a) {
  const code = String(a.approvalCode || '').trim().toUpperCase();
  const plan = plans.get(code);
  if (!plan) throw new Error('Unknown, expired or already used approval code. Ask for a new plan.');
  if (Date.now() > plan.expires) {
    plans.delete(code);
    throw new Error('Approval code expired. Ask for a new plan.');
  }
  if (String(a.confirmation || '').trim() !== plan.confirmation) throw new Error(`confirmation must be exactly: ${plan.confirmation}`);
  plans.delete(code); // one use
  if (!isDeepStrictEqual(await plan.readCurrent(), plan.before)) throw new Error('The resource changed since the plan was made. Ask for a new plan.');
  const entry = { confirmation: plan.confirmation, method: plan.method, path: plan.path, body: plan.body, before: plan.before };
  logChange({ phase: 'attempt', ...entry });
  let result;
  try {
    result = await request(plan.method, await apiPath(plan.path), plan.body);
  } catch (e) {
    try { logChange({ phase: 'failed', confirmation: plan.confirmation, error: e.message }); } catch { /* the request error matters more */ }
    throw e;
  }
  const out = { applied: plan.confirmation, result, log: path.join(dataDir(), 'changes.jsonl') };
  try {
    logChange({ phase: 'applied', confirmation: plan.confirmation, result });
  } catch (e) {
    out.logWarning = `The change WAS applied, but writing the result to the log failed: ${e.message}`;
  }
  return out;
}

const idProp = (what) => ({ type: 'string', description: what });
const planTool = (name, description, properties, required) => ({
  name, description: `${description} Changes nothing: returns a summary and an approvalCode.`,
  inputSchema: { type: 'object', properties: { ...properties, site: siteProp }, required },
  annotations: { readOnlyHint: true, openWorldHint: true },
});
const WRITE_TOOLS = [
  planTool('unifi_plan_restart_device', 'Plan restarting an adopted device (AP, switch or gateway).', { deviceId: idProp('The deviceId') }, ['deviceId']),
  planTool('unifi_plan_set_firewall_policy', 'Plan enabling/disabling a user-defined firewall policy, or turning its logging on/off.', {
    policyId: idProp('The firewall policy id'), enabled: { type: 'boolean' }, loggingEnabled: { type: 'boolean' },
  }, ['policyId']),
  planTool('unifi_plan_update_traffic_list', 'Plan replacing the items of a traffic matching list (ports or IP addresses); all items must be given.', {
    listId: idProp('The traffic matching list id'), name: { type: 'string' },
    items: { type: 'array', items: { type: 'object' }, description: 'The complete new list, like [{"type":"PORT_NUMBER","value":22}]' },
  }, ['listId', 'items']),
  {
    name: 'unifi_apply_change',
    description: 'Apply a change planned earlier. Call it ONLY after the user explicitly approved, in the chat, the exact change shown by the plan. Pass approvalCode and confirmation exactly as the plan gave them.',
    inputSchema: {
      type: 'object',
      properties: { approvalCode: { type: 'string' }, confirmation: { type: 'string', description: 'The confirmation phrase from the plan, verbatim' } },
      required: ['approvalCode', 'confirmation'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    // Claude Code shows its permission prompt on every call, whatever the permission mode or allow rules.
    _meta: { 'anthropic/requiresUserInteraction': true },
  },
];
const WRITE_HANDLERS = {
  unifi_plan_restart_device: planRestartDevice,
  unifi_plan_set_firewall_policy: planSetFirewallPolicy,
  unifi_plan_update_traffic_list: planUpdateTrafficList,
  unifi_apply_change: applyChange,
};

async function callTool(name, args = {}) {
  if (Object.hasOwn(WRITE_HANDLERS, name)) {
    if (!WRITES) throw new Error('Writes are disabled. The user can turn on the enable_writes plugin option.');
    return WRITE_HANDLERS[name](args);
  }
  if (name === 'unifi_get') {
    const p = String(args.path || '');
    if (!p || p.includes('://') || p.startsWith('//')) throw new Error('path must look like /sites, not a URL');
    checkPath(p);
    return project(await getAll(`${await root()}/${p.replace(/^\/+/, '')}`), args.fields);
  }
  const key = name.replace(/^unifi_/, '');
  const entry = Object.hasOwn(RESOURCES, key) ? RESOURCES[key] : null;
  if (!entry) throw new Error(`Unknown tool ${name}`);
  let [, path, idName] = entry;
  if (idName) {
    if (!args[idName]) throw new Error(`${idName} is required`);
    path = path.replace('{id}', seg(args[idName], idName));
  }
  if (path.includes('{site}')) path = path.replace('{site}', seg(await resolveSite(args.site), 'site'));
  return project(await getAll(`${await root()}/${path}`), args.fields);
}

// ── JSON-RPC over stdio (newline-delimited) ──
function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  const reply = (result) => send({ jsonrpc: '2.0', id, result });
  try {
    if (method === 'initialize') {
      return reply({
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'unifi', version: VERSION },
      });
    }
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: WRITES ? [...TOOLS, ...WRITE_TOOLS] : TOOLS });
    if (method === 'tools/call') {
      try {
        const data = await callTool(params.name, params.arguments);
        return reply({ content: [{ type: 'text', text: JSON.stringify(data, null, 1) }] });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: e.message }], isError: true });
      }
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
}

if (require.main === module) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) { send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }); continue; }
      handle(msg);
    }
  });
}

module.exports = { callTool };
