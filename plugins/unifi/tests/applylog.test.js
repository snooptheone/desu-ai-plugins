'use strict';
// In-process test: a change that went through is never reported as failed because of the log.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('if the result cannot be logged after a successful change, the change is still reported as applied', async (t) => {
  const writes = [];
  const api = http.createServer((req, res) => {
    if (req.method !== 'GET') writes.push(req.method);
    const url = req.url.split('?')[0];
    const body = url === '/v1/hosts' ? { data: [{ id: 'C1', type: 'console' }] }
      : url.endsWith('/sites') ? { totalCount: 1, data: [{ id: 'S1', name: 'Default' }] }
        : { id: 'D1', name: 'AP1', model: 'U7', state: 'ONLINE' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  t.after(() => api.close());
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unifi-data-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  Object.assign(process.env, {
    UNIFI_API_KEY: 'k',
    UNIFI_API_BASE: `http://127.0.0.1:${api.address().port}`,
    UNIFI_ENABLE_WRITES: 'true',
    CLAUDE_PLUGIN_DATA: dataDir,
  });
  const { callTool } = require('../mcp/server.js');

  const plan = await callTool('unifi_plan_restart_device', { deviceId: 'D1' });
  const real = fs.appendFileSync;
  let calls = 0;
  t.mock.method(fs, 'appendFileSync', (...args) => {
    if (++calls === 2) throw new Error('disk full'); // the 'applied' entry
    return real(...args);
  });
  const out = await callTool('unifi_apply_change', { approvalCode: plan.approvalCode, confirmation: plan.confirmation });
  assert.deepEqual(writes, ['POST']);
  assert.equal(out.applied, plan.confirmation);
  assert.match(out.logWarning, /WAS applied.*disk full/);
});
