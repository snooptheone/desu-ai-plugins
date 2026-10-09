'use strict';
// In-process test: an approval code stops working after five minutes.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('an approval code expires after five minutes', async (t) => {
  const device = { id: 'D1', name: 'AP1', model: 'U7', state: 'ONLINE' };
  const requests = [];
  const api = http.createServer((req, res) => {
    requests.push(req.method);
    const url = req.url.split('?')[0];
    const body = url === '/v1/hosts' ? { data: [{ id: 'C1', type: 'console' }] }
      : url.endsWith('/sites') ? { totalCount: 1, data: [{ id: 'S1', name: 'Default' }] }
        : device;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  t.after(() => api.close());
  Object.assign(process.env, {
    UNIFI_API_KEY: 'k',
    UNIFI_API_BASE: `http://127.0.0.1:${api.address().port}`,
    UNIFI_ENABLE_WRITES: 'true',
    CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'unifi-data-')),
  });
  const { callTool } = require('../mcp/server.js');

  const plan = await callTool('unifi_plan_restart_device', { deviceId: 'D1' });
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 5 * 60 * 1000 + 1);
  await assert.rejects(callTool('unifi_apply_change', { approvalCode: plan.approvalCode, confirmation: plan.confirmation }), /expired/);
  assert.ok(!requests.includes('POST'));
});
