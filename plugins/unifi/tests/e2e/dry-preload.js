'use strict';
// Used by selftest.sh (node --require): runs the e2e test files against a stand-in for ./helper that accepts any call,
// so a misspelled or undeclared name (a ReferenceError) shows up without a VM. Assertions are expected to fail here;
// only ReferenceErrors matter. node --check cannot find these: they are valid syntax.
const Module = require('node:module');

const stand = () => new Proxy(function () {}, {
  get: (_, key) => (key === 'then' ? undefined : key === Symbol.iterator ? function* () {} : key === Symbol.toPrimitive ? () => '' : stand()),
  apply: () => stand(),
});
const fake = {
  client: () => ({ call: async () => stand(), raw: async () => stand(), close() {} }),
  planAndApply: async () => ({ plan: stand(), done: stand() }),
  wifiBody: () => ({}),
  until: async (what, fn) => fn(),
  isGateway: () => false,
  describe: () => '',
};
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === './helper' ? fake : load.call(this, request, ...rest);
};
