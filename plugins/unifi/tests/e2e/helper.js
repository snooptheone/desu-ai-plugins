'use strict';
// A tiny MCP client for the e2e tests: it starts mcp/server.js against the console in the environment
// (UNIFI_API_KEY, UNIFI_CONSOLE_HOST, UNIFI_ENABLE_WRITES, set by run.sh) and calls its tools.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER = path.join(__dirname, '..', '..', 'mcp', 'server.js');

function client() {
  // The change log goes to a throwaway directory, not to the real plugin data.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unifi-e2e-'));
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let buf = '';
  let nextId = 1;
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
  // The raw tool result: { content, isError }
  const raw = (name, args = {}) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, (m) => resolve(m.result));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
  });
  // The parsed JSON of a tool that worked; a tool error becomes an exception with the server's message.
  const call = async (name, args) => {
    const r = await raw(name, args);
    const text = r.content[0].text;
    if (r.isError) throw new Error(`${name}: ${text}`);
    return JSON.parse(text);
  };
  return { call, raw, close: () => { child.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

// Plan a change, then apply it with the code and phrase the plan gave, like Claude does after the person approves.
async function planAndApply(c, tool, args) {
  const plan = await c.call(tool, args);
  const done = await c.call('unifi_apply_change', { approvalCode: plan.approvalCode, confirmation: plan.confirmation });
  return { plan, done };
}

// A valid standard WiFi (10.6.106). WPA needs fastRoamingEnabled set explicitly, the console refuses the body otherwise.
function wifiBody(name, extra = {}) {
  return {
    type: 'STANDARD', name, enabled: true, hideName: false, uapsdEnabled: true, clientIsolationEnabled: false,
    multicastToUnicastConversionEnabled: true, channel2gLockedTo6: false, dtimPeriod2gLockedTo3: false,
    advertiseDeviceName: false, arpProxyEnabled: false, bssTransitionEnabled: true, broadcastingFrequenciesGHz: [2.4, 5],
    network: { type: 'NATIVE' }, securityConfiguration: { type: 'WPA2_PERSONAL', passphrase: 'e2e-passphrase-123', fastRoamingEnabled: false },
    ...extra,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Polls fn until it returns something truthy; throws after `seconds`.
async function until(what, fn, { seconds = 300, every = 5 } = {}) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const got = await fn();
    if (got) return got;
    await sleep(every * 1000);
  }
  throw new Error(`timed out after ${seconds}s waiting for ${what}`);
}

// A gateway, by what it can do or by its model name (the console's feature names are not documented).
const isGateway = (d) => (d.features || []).some((f) => /gateway|rout/i.test(f)) || /gateway|UXG|UDM|UCG|UDR|USG/i.test(d.model || '');
const describe = (d) => `${d.model} fw ${d.firmwareVersion} [${(d.features || []).join(',')}] ${d.state}`;

module.exports = { client, planAndApply, wifiBody, until, isGateway, describe };
