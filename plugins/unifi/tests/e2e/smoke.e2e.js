'use strict';
// Runs against the real UniFi OS test VM. Do not run it by hand: ./run.sh restores the VM around it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { client } = require('./helper');

test('the VM answers: version and the default site', async () => {
  const c = client();
  try {
    assert.match((await c.call('unifi_info')).applicationVersion, /^\d+\./);
    assert.ok((await c.call('unifi_sites')).length >= 1);
  } finally {
    c.close();
  }
});
