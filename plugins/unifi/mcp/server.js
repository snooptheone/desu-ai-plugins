#!/usr/bin/env node
// UniFi Network MCP server (stdio, no dependencies, Node 18+).
// Talks to the official Network Integration API in one of two modes:
//   cloud (default): through the Site Manager Connector
//     https://api.ui.com/v1/connector/consoles/<console>/proxy/network/integration/v1
//   local: when UNIFI_CONSOLE_HOST is set, straight to the console
//     https://<host>/proxy/network/integration/v1
//     The console's certificate is self-signed, so TLS verification is skipped in this mode.
// Read tools only send GET requests, with one exception: unifi_system_log asks the controller's log query
// (a POST with a fixed body shape that changes nothing). The write tools exist only when UNIFI_ENABLE_WRITES=true, and
// the only code that changes anything is unifi_apply_change, which needs a one-time approval code from a
// previous plan, its exact confirmation phrase, and a resource unchanged since the plan.
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

// ── The controller's own (private) API, read only: events, alarms, statistics, the system log ──
// The official Integration API has no logs or history; the private one does. It is undocumented and may change with
// the controller version, so only a short list of read paths is allowed, and only in local mode (the Site Manager
// connector is documented for the integration API only). Its output is masked: it carries secrets (keys starting x_).
// Paths follow what open clients of this API use (go-unifi, Art-of-WiFi/UniFi-API-client).
const LEGACY_GET = [
  /^api\/s\/[^/]+\/stat\/(?:health|sysinfo|device-basic|device|sta|alluser|guest|rogueap|event|authorization|voucher)$/,
  /^api\/s\/[^/]+\/stat\/sta\/(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/,
  /^api\/s\/[^/]+\/stat\/report\/(?:5minutes|hourly|daily|monthly)\.(?:site|ap|user|gw)$/,
  /^api\/s\/[^/]+\/stat\/(?:current-channel|ccode|dpi|fwupdate\/latest-version)$/,
  /^api\/s\/[^/]+\/(?:list|cnt)\/alarm$/,
  /^api\/s\/[^/]+\/list\/user$/,
  /^v2\/api\/site\/[^/]+\/(?:clients\/active|clients\/history|aggregated-dashboard)$/,
];
const LOG_CLASSES = {
  all: {}, critical: {}, 'vpn-alert': {}, 'device-alert': {},
  'next-ai-alert': { nextAiCategory: ['CLIENT', 'DEVICE', 'INTERNET', 'VPN'] },
  'admin-activity': { activity_keys: ['ACCESSED_NETWORK_WEB', 'ACCESSED_NETWORK_IOS', 'ACCESSED_NETWORK_ANDROID'], change_keys: ['CLIENT', 'DEVICE', 'HOTSPOT', 'INTERNET', 'NETWORK', 'PROFILE', 'ROUTING', 'SECURITY', 'SYSTEM', 'VPN', 'WIFI'] },
  'update-alert': { systemLogDeviceTypes: ['GATEWAYS', 'SWITCHES', 'ACCESS_POINT', 'SMART_POWER', 'BUILDING_TO_BUILDING_BRIDGES', 'UNIFI_LTE'] },
  'client-alert': { clientType: ['GUEST', 'TELEPORT', 'VPN', 'WIRELESS', 'RADIUS', 'WIRED'], guestAuthorizationMethod: ['FACEBOOK_SOCIAL_GATEWAY', 'FREE_TRIAL', 'GOOGLE_SOCIAL_GATEWAY', 'NONE', 'PASSWORD', 'PAYMENT', 'RADIUS', 'VOUCHER'] },
  'threat-alert': { threatTypes: ['HONEYPOT', 'THREAT'] },
  triggers: { triggerTypes: ['TRAFFIC_RULE', 'TRAFFIC_ROUTE', 'FIREWALL_RULE'] }, // Network 10.x only
};
const LOG_CATEGORIES = ['AUDIT', 'CLIENT_DEVICES', 'SOFTWARE_UPDATES', 'INTERNET_AND_WAN'];

function legacyRoot() {
  const h = localHost();
  if (!h) throw new Error('The private-API tools need local mode: set the console address in the plugin options');
  return `https://${h}/proxy/network`;
}

// The private API names a site ("default"), the integration API uses a uuid; the list links the two.
let sitesCache = { at: 0, list: [] }; // the site list for 30 s: sites rarely change, and every private call needs it
async function legacySite(site) {
  const find = (list) => (site ? list.find((s) => s.id === site || s.internalReference === site) : list.length === 1 ? list[0] : null);
  let hit = Date.now() - sitesCache.at < 30000 ? find(sitesCache.list) : null;
  if (!hit) { // a miss may be a new site: ask the console again
    sitesCache = { at: Date.now(), list: await getAll(`${await root()}/sites`) };
    hit = find(sitesCache.list);
  }
  if (!hit) throw new Error(`Pass site with one of: ${sitesCache.list.map((s) => `${s.id} (${s.name})`).join(', ')}`);
  return seg(hit.internalReference, 'site');
}

// The private API answers { meta: { rc: "ok" }, data: [...] }; a failure carries meta.msg.
function legacyData(answer) {
  if (answer && answer.meta && answer.meta.rc !== 'ok') throw new Error(`The console refused the request: ${answer.meta.msg || answer.meta.rc}`);
  return answer && answer.meta && 'data' in answer ? answer.data : answer;
}

async function legacyGet(a) {
  const raw = String(a.path || '').replace(/^\/+/, '');
  if (!raw || raw.includes('?') || raw.includes('#') || raw.includes('://') || /[\u0000-\u001f]/.test(raw)) throw new Error('path must look like stat/health, without a query or a URL');
  checkPath(raw);
  const site = await legacySite(a.site);
  const rel = raw.startsWith('v2/') ? `v2/api/site/${site}/${raw.slice(3)}` : `api/s/${site}/${raw}`;
  if (!LEGACY_GET.some((re) => re.test(rel))) throw new Error(`${raw} is not one of the private-API reads this plugin allows: stat/{health,sysinfo,device,device-basic,sta,alluser,guest,rogueap,event,authorization,voucher,current-channel,ccode,dpi,fwupdate/latest-version}, list/user, stat/sta/<mac>, stat/report/<interval>.<site|ap|user|gw>, list/alarm, cnt/alarm, v2/{clients/active,clients/history,aggregated-dashboard}`);
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(a.query || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,30}$/.test(k) || !['string', 'number', 'boolean'].includes(typeof v) || /[\u0000-\u001f]/.test(String(v))) throw new Error(`Invalid query parameter ${k}`);
    params.set(k, String(v));
  }
  const qs = params.toString();
  const data = legacyData(await get(`${legacyRoot()}/${rel}${qs ? `?${qs}` : ''}`));
  return mask(project(data, a.fields));
}

const clamp = (v, def, lo, hi) => {
  const n = v === undefined ? def : Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`Expected a whole number from ${lo} to ${hi}, got ${v}`);
  return n;
};

async function systemLog(a) {
  const cls = a.class === undefined ? 'all' : a.class;
  if (!Object.hasOwn(LOG_CLASSES, cls)) throw new Error(`class must be one of: ${Object.keys(LOG_CLASSES).join(', ')}`);
  const hours = clamp(a.hours, 24, 1, 24 * 90);
  const now = Date.now();
  const payload = {
    pageNumber: clamp(a.page, 0, 0, 100000), pageSize: clamp(a.pageSize, 100, 1, 500),
    timestampFrom: now - hours * 3600 * 1000, timestampTo: now, ...LOG_CLASSES[cls],
  };
  if (a.categories !== undefined) {
    if (!Array.isArray(a.categories) || !a.categories.every((c) => LOG_CATEGORIES.includes(c))) throw new Error(`categories must be a list of: ${LOG_CATEGORIES.join(', ')}`);
    payload.categories = a.categories;
  }
  const site = await legacySite(a.site);
  return mask(await request('POST', `${legacyRoot()}/v2/api/site/${site}/system-log/${cls}`, payload));
}

// Two more reads the private API answers only to a POST with a query body (nothing is changed). The body is built here
// from checked values, never passed through.
const STATS_KINDS = ['sessions', 'dpi'];
async function statsQuery(a) {
  if (!STATS_KINDS.includes(a.kind)) throw new Error(`kind must be one of: ${STATS_KINDS.join(', ')}`);
  const site = await legacySite(a.site);
  const now = Date.now();
  let path;
  let payload;
  if (a.kind === 'sessions') {
    const type = a.type === undefined ? 'all' : a.type;
    if (!['all', 'guest', 'user'].includes(type)) throw new Error('type must be all, guest or user');
    const hours = clamp(a.hours, 24, 1, 24 * 90);
    payload = { type, start: Math.floor(now / 1000) - hours * 3600, end: Math.floor(now / 1000) };
    if (a.mac !== undefined) {
      if (!/^(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(String(a.mac))) throw new Error('mac must look like aa:bb:cc:dd:ee:ff');
      payload.mac = String(a.mac).toLowerCase();
    }
    path = 'stat/session';
  } else {
    const type = a.type === undefined ? 'by_cat' : a.type;
    if (!['by_cat', 'by_app'].includes(type)) throw new Error('type must be by_cat or by_app');
    payload = { type };
    if (a.cats !== undefined) {
      if (type !== 'by_app' || !Array.isArray(a.cats) || a.cats.length > 50 || !a.cats.every((c) => Number.isInteger(c) && c >= 0 && c < 1000)) throw new Error('cats is a list of up to 50 category numbers, and only with type by_app');
      payload.cats = a.cats;
    }
    path = 'stat/sitedpi';
  }
  return mask(project(legacyData(await request('POST', `${legacyRoot()}/api/s/${site}/${path}`, payload)), a.fields));
}

const LEGACY_TOOLS = [
  {
    name: 'unifi_legacy_get',
    description: 'Read from the controller\'s private API (local mode only), which has what the official API lacks: health, per-client and per-device statistics, rogue APs. stat/event and list/alarm exist only on older controllers (404/400 on 10.6): use unifi_system_log for events and alarms. path: stat/health, stat/sysinfo, stat/device, stat/device-basic, stat/sta, stat/alluser, stat/guest, stat/rogueap, stat/event, stat/authorization, stat/voucher, stat/current-channel, stat/ccode, stat/dpi, stat/fwupdate/latest-version, list/user (every known client, offline ones too), stat/sta/<mac>, stat/report/<5minutes|hourly|daily|monthly>.<site|ap|user|gw>, list/alarm, cnt/alarm, v2/clients/active, v2/clients/history, v2/aggregated-dashboard. query: optional filters such as {"within":24,"_limit":100,"_sort":"-time"}. Undocumented, may change with the version; secrets are masked.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, query: { type: 'object' }, site: siteProp, fields: fieldsProp },
      required: ['path'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'unifi_system_log',
    description: `The controller's system log (local mode only): what happened, who changed what, alerts. On Network 11.x it replaces events and alarms (class "all", "critical"). class: ${Object.keys(LOG_CLASSES).join(', ')}. hours: how far back (default 24). Paged: page, pageSize (default 100). categories (class all): ${LOG_CATEGORIES.join(', ')}. Undocumented, may change with the version; secrets are masked.`,
    inputSchema: {
      type: 'object',
      properties: {
        class: { type: 'string', enum: Object.keys(LOG_CLASSES) }, hours: { type: 'integer' }, page: { type: 'integer' },
        pageSize: { type: 'integer' }, categories: { type: 'array', items: { type: 'string', enum: LOG_CATEGORIES } }, site: siteProp,
      },
      required: [],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'unifi_stats_query',
    description: 'Two statistics the controller\'s private API answers only to a query body (local mode only; nothing is changed). kind "sessions": client sessions (hours back, default 24; type all|guest|user; optional mac). kind "dpi": deep-packet-inspection traffic (type by_cat, or by_app with cats = category numbers). Undocumented, may change with the version; secrets are masked.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: STATS_KINDS }, hours: { type: 'integer' }, type: { type: 'string' }, mac: { type: 'string' },
        cats: { type: 'array', items: { type: 'integer' } }, site: siteProp, fields: fieldsProp,
      },
      required: ['kind'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];
const LEGACY_HANDLERS = { unifi_legacy_get: legacyGet, unifi_system_log: systemLog, unifi_stats_query: statsQuery };

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
    // A 2xx write was most likely applied; reporting a failure could get it retried. But a proxy
    // can also answer 2xx with an error page, so say that the result is unconfirmed.
    if (method !== 'GET') return { raw: res.text.slice(0, 200), warning: 'The console answered 2xx with a body that is not JSON; check that the change took effect.' };
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

// Secrets in a body (a WiFi passphrase, a token) are shown and logged as ***; the request itself carries the real value.
const SECRET_KEY = /^x_|pass(word|phrase)|secret|psk|preshared|token|api.?key/i;
const mask = (v) => (Array.isArray(v) ? v.map(mask)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? '***' : mask(x)])) : v);

function makePlan({ summary, confirmation, method, path: p, body, before, readCurrent, details }) {
  for (const [c, x] of plans) if (Date.now() > x.expires) plans.delete(c);
  const approvalCode = crypto.randomBytes(5).toString('hex').toUpperCase();
  plans.set(approvalCode, { confirmation, method, path: p, body, logBody: mask(body), before, readCurrent, expires: Date.now() + PLAN_TTL_MS });
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
  // Who uses the list is a courtesy: a console without zone-based firewall answers 400 here, which must not block the change.
  let usedBy = null;
  let usedByError;
  try {
    const policies = await getAll(await apiPath(`sites/${site}/firewall/policies`));
    usedBy = policies.filter((x) => JSON.stringify(x).includes(cur.id)).map((x) => x.name);
  } catch (e) {
    usedByError = e.message;
  }
  // The permission prompt shows only the confirmation phrase, so it carries the actual values.
  const show = (i) => (i.value !== undefined ? `${i.type} ${typeof i.value === 'object' ? JSON.stringify(i.value) : i.value}` : JSON.stringify(i));
  const changes = [...added.map((i) => `+${show(i)}`), ...removed.map((i) => `-${show(i)}`), ...(body.name !== cur.name ? [`rename "${body.name}"`] : [])];
  const shown = [];
  let length = 0;
  for (const c of changes) {
    if (length + c.length > 150) break;
    shown.push(c);
    length += c.length + 2;
  }
  if (shown.length < changes.length) shown.push(`... and ${changes.length - shown.length} more`);
  const phrase = `(+${added.length} -${removed.length}): ${shown.join(', ')}`;
  return makePlan({
    summary: `Traffic list "${cur.name}" (${cur.type}): ${changes.join(', ')}. Used by: ${usedBy === null ? 'unknown (the firewall policies could not be read)' : usedBy.length ? usedBy.map((n) => `"${n}"`).join(', ') : 'no firewall policy'}.`,
    confirmation: `UPDATE traffic list "${cur.name}" ${phrase}`,
    method: 'PUT', path: p, body, before: cur, readCurrent: read,
    details: { added, removed, usedBy, ...(usedByError ? { usedByError } : {}) },
  });
}

// ── Every other change of the API (spec 10.6.106), through the same plan -> apply flow ──
// Only these method + path pairs can be planned; anything else is refused before any request.
const ID = '[^/]+';
const SITE = `sites/${ID}`;
const ITEMS = ['acl-rules', 'dns/policies', 'firewall/policies', 'firewall/zones', 'networks', 'traffic-matching-lists', 'wifi/broadcasts'];
const NOT_ORDERING = `(?!ordering$)${ID}`;
// [method, path regex, path whose current state is read as "before" (null: nothing exists yet)]
const CHANGE_ROUTES = [
  ['POST', `${SITE}/(?:${[...ITEMS, 'devices', 'hotspot/vouchers'].join('|')})`, () => null],
  ['PUT', `${SITE}/(?:${ITEMS.join('|')})/${NOT_ORDERING}`, (p) => p],
  ['PATCH', `${SITE}/firewall/policies/${NOT_ORDERING}`, (p) => p],
  ['DELETE', `${SITE}/(?:${[...ITEMS, 'devices', 'hotspot/vouchers'].join('|')})/${NOT_ORDERING}`, (p) => p],
  ['DELETE', `${SITE}/hotspot/vouchers`, (p) => p],
  ['PUT', `${SITE}/(?:acl-rules|firewall/policies)/ordering`, (p) => p],
  ['POST', `${SITE}/(?:devices|clients)/${ID}/actions`, (p) => p.replace(/\/actions$/, '')],
  ['POST', `${SITE}/devices/${ID}/interfaces/ports/${ID}/actions`, (p) => p.replace(/\/interfaces\/.*$/, '')],
];
const CHANGE_QUERY = new Set(['force', 'filter', 'sourceFirewallZoneId', 'destinationFirewallZoneId']);
const STABLE = ['id', 'name', 'model', 'macAddress', 'type', 'state']; // devices and clients carry counters that move on their own

async function planChange(a) {
  const method = String(a.method || '').toUpperCase();
  const raw = String(a.path || '').replace(/^\/+/, '');
  if (!raw || raw.includes('://') || raw.includes('#') || /[\u0000-\u001f]/.test(raw)) throw new Error('path must look like sites/<site>/networks/<id>, not a URL');
  checkPath(raw);
  const q = raw.indexOf('?');
  const p = q < 0 ? raw : raw.slice(0, q);
  const route = CHANGE_ROUTES.find(([m, re]) => m === method && new RegExp(`^${re}$`).test(p));
  if (!route) throw new Error(`${method} ${p} is not a change of the UniFi Network API that this plugin can plan. Use a path like sites/<site>/networks/<id>`);
  const params = new URLSearchParams(q < 0 ? '' : raw.slice(q + 1));
  for (const k of params.keys()) if (!CHANGE_QUERY.has(k)) throw new Error(`Unknown query parameter ${k}`);
  if (method === 'DELETE' && p.endsWith('/hotspot/vouchers') && !params.get('filter')) throw new Error('Deleting vouchers in bulk needs a filter');
  const query = params.toString() ? `?${params}` : '';
  if (method === 'DELETE') {
    if (a.body !== undefined) throw new Error('DELETE takes no body');
  } else if (!a.body || typeof a.body !== 'object' || Array.isArray(a.body) || !Object.keys(a.body).length) {
    throw new Error('body must be a non-empty JSON object');
  }
  const body = method === 'DELETE' ? undefined : a.body;

  const readPath = route[2](p);
  const readQuery = /(?:ordering|hotspot\/vouchers)$/.test(p) ? query : '';
  const read = async () => {
    if (readPath === null) return null;
    const cur = await apiGet(readPath + readQuery);
    return /\/(?:devices|clients)\/[^/]+$/.test(readPath) ? Object.fromEntries(STABLE.filter((k) => k in cur).map((k) => [k, cur[k]])) : cur;
  };
  const before = await read();

  const what = p.replace(/^sites\/[^/]+\//, '');
  const label = before && typeof before.name === 'string' ? ` "${before.name}"` : '';
  const realText = body ? sortedJson(body) : '';
  const bodyText = body ? sortedJson(mask(body)) : '';
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
  // The permission prompt shows only the confirmation phrase: it carries the target, the start of the body,
  // and a digest of the whole request. The digest starts with a random per-plan value, so the phrase (which goes to the
  // change log) cannot be used to guess a secret in the body offline.
  const digest = crypto.createHash('sha256').update(`${crypto.randomBytes(8).toString('hex')} ${method} ${p}${query} ${realText}`).digest('hex').slice(0, 8);
  const confirmation = `${method} ${what}${label}${query}${bodyText ? ` ${clip(bodyText, 120)}` : ''} [${digest}]`;

  const details = { method, path: p + query };
  let summary;
  if (method === 'DELETE') {
    summary = `DELETE ${what}${label}. This cannot be undone.`;
    if (/\/networks\/[^/]+$/.test(p)) {
      try { details.references = await apiGet(`${p}/references`); } catch (e) { details.references = `could not be read: ${e.message}`; }
    }
  } else if (method === 'POST') {
    summary = /\/actions$/.test(p)
      ? `Run an action on ${before ? what.replace(/\/actions$/, '') + label : what}: ${clip(bodyText, 300)}`
      : `Create in ${what}: ${clip(bodyText, 300)}`;
  } else {
    const changed = {};
    const shown = (k, x) => mask({ [k]: x })[k];
    for (const k of Object.keys(body)) if (!isDeepStrictEqual(before[k], body[k])) changed[k] = { from: shown(k, before[k]), to: shown(k, body[k]) };
    if (!Object.keys(changed).length) throw new Error('Nothing to change: the resource already has these values');
    details.changed = changed;
    if (method === 'PUT') details.notInBody = Object.keys(before).filter((k) => !(k in body) && k !== 'id' && k !== 'metadata');
    summary = `${method === 'PUT' ? 'Replace' : 'Update'} ${what}${label}: ${Object.keys(changed).join(', ')}.`;
  }
  return makePlan({ summary, confirmation, method, path: p + query, body, before, readCurrent: read, details });
}

async function applyChange(a) {
  const code = String(a.approvalCode || '').trim().toUpperCase();
  const plan = plans.get(code);
  if (!plan) throw new Error('Unknown, expired or already used approval code. Ask for a new plan.');
  if (Date.now() > plan.expires) {
    plans.delete(code);
    throw new Error('Approval code expired. Ask for a new plan.');
  }
  if (String(a.confirmation || '').trim() !== plan.confirmation.trim()) throw new Error(`confirmation must be exactly: ${plan.confirmation}`);
  plans.delete(code); // one use
  if (!isDeepStrictEqual(await plan.readCurrent(), plan.before)) throw new Error('The resource changed since the plan was made. Ask for a new plan.');
  const entry = { confirmation: plan.confirmation, method: plan.method, path: plan.path, body: plan.logBody, before: mask(plan.before) };
  logChange({ phase: 'attempt', ...entry });
  let result;
  try {
    result = await request(plan.method, await apiPath(plan.path), plan.body);
  } catch (e) {
    try { logChange({ phase: 'failed', confirmation: plan.confirmation, error: e.message }); } catch { /* the request error matters more */ }
    throw e;
  }
  result = mask(result);
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
    name: 'unifi_plan_change',
    description: 'Plan any other change of the Network API: create (POST), replace (PUT), update (PATCH) or delete (DELETE) networks, wifi/broadcasts, firewall/policies, firewall/zones, acl-rules, dns/policies, traffic-matching-lists and hotspot/vouchers (also the firewall and ACL ordering); adopt (POST devices), remove a device, restart it (action RESTART) or power-cycle the PoE of a port (POWER_CYCLE); authorize or unauthorize a guest client (AUTHORIZE_GUEST_ACCESS, UNAUTHORIZE_GUEST_ACCESS). The API cannot block a client. Path is relative to the API, like sites/<site>/networks/<id>. PUT replaces the whole object, so start from the current one. Changes nothing: returns a summary and an approvalCode.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['POST', 'PUT', 'PATCH', 'DELETE'] },
        path: { type: 'string', description: 'For example sites/<site>/networks/<id>; add ?force=true or ?filter=... only where the API takes it' },
        body: { type: 'object', description: 'The JSON body; omit for DELETE' },
      },
      required: ['method', 'path'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
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
  unifi_plan_change: planChange,
  unifi_apply_change: applyChange,
};

async function callTool(name, args = {}) {
  if (Object.hasOwn(WRITE_HANDLERS, name)) {
    if (!WRITES) throw new Error('Writes are disabled. The user can turn on the enable_writes plugin option.');
    return WRITE_HANDLERS[name](args);
  }
  if (Object.hasOwn(LEGACY_HANDLERS, name)) return LEGACY_HANDLERS[name](args);
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
    if (method === 'tools/list') {
      let local = false;
      try { local = Boolean(localHost()); } catch { /* an invalid address is reported by the first call */ }
      return reply({ tools: [...TOOLS, ...(local ? LEGACY_TOOLS : []), ...(WRITES ? WRITE_TOOLS : [])] });
    }
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

module.exports = { callTool, RESOURCES };
