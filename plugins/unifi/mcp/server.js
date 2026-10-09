#!/usr/bin/env node
// UniFi Network MCP server (stdio, no dependencies, Node 18+).
// Talks to the official Network Integration API in one of two modes:
//   cloud (default): through the Site Manager Connector
//     https://api.ui.com/v1/connector/consoles/<console>/proxy/network/integration/v1
//   local: when UNIFI_CONSOLE_HOST is set, straight to the console
//     https://<host>/proxy/network/integration/v1
//     The console's certificate is self-signed, so TLS verification is skipped in this mode.
// This file only sends GET requests.
'use strict';

const https = require('node:https');

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

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, headers, timeout: 30000, rejectUnauthorized: false },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { text += d; });
        res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function get(url) {
  const headers = { 'X-API-KEY': apiKey(), Accept: 'application/json' };
  let res;
  try {
    if (localHost()) {
      res = await httpsGet(url, headers);
    } else {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
      res = { ok: r.ok, status: r.status, text: await r.text() };
    }
  } catch (e) {
    if (e.message.startsWith('UNIFI_API_KEY')) throw e;
    throw new Error(`Connection failed: ${e.cause ? e.cause.message : e.message}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.split('?')[0]}: ${res.text.slice(0, 500)}`);
  return res.text ? JSON.parse(res.text) : null;
}

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

async function callTool(name, args = {}) {
  if (name === 'unifi_get') {
    const p = String(args.path || '');
    if (!p || p.includes('://') || p.startsWith('//')) throw new Error('path must look like /sites, not a URL');
    return project(await getAll(`${await root()}/${p.replace(/^\/+/, '')}`), args.fields);
  }
  const entry = RESOURCES[name.replace(/^unifi_/, '')];
  if (!entry) throw new Error(`Unknown tool ${name}`);
  let [, path, idName] = entry;
  if (path.includes('{site}')) path = path.replace('{site}', enc(await resolveSite(args.site)));
  if (idName) {
    if (!args[idName]) throw new Error(`${idName} is required`);
    path = path.replace('{id}', enc(args[idName]));
  }
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
        serverInfo: { name: 'unifi', version: '0.2.0' },
      });
    }
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: TOOLS });
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
      try { handle(JSON.parse(line)); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    }
  });
}

module.exports = { TOOLS, callTool };
