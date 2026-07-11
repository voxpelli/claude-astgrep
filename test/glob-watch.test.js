import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { globToRegExp, scheduleFlush } from '../bin/glob-watch.mjs';

test('globToRegExp handles the patterns LSP servers actually register', () => {
  const matches = (glob, p) => globToRegExp(glob).test(p);

  // ast-grep's own registration.
  assert.ok(matches('**/*.{yml,yaml}', '.ast-grep/rules/no-x.yml'));
  assert.ok(matches('**/*.{yml,yaml}', 'deep/nested/dir/rule.yaml'));

  // `**/` MUST match zero segments: sgconfig.yml lives at the root and is the likeliest file to be
  // edited. A `(?:[^/]+/)+` compilation would miss it and the config would never hot-reload.
  assert.ok(matches('**/*.{yml,yaml}', 'sgconfig.yml'), '**/ must match zero directories');

  assert.ok(!matches('**/*.{yml,yaml}', 'src/index.js'));
  assert.ok(!matches('**/*.{yml,yaml}', 'rules/no-x.yml.bak'));

  // `*` stays within one segment.
  assert.ok(matches('*.json', 'tsconfig.json'));
  assert.ok(!matches('*.json', 'a/tsconfig.json'), '* must not cross a path separator');

  // Other real-world registrations.
  assert.ok(matches('**/Cargo.toml', 'crates/core/Cargo.toml'));
  assert.ok(matches('?.js', 'a.js'));
  assert.ok(!matches('?.js', 'ab.js'));
  assert.ok(matches('src/[abc]*.js', 'src/alpha.js'));
  assert.ok(!matches('src/[!abc]*.js', 'src/alpha.js'));

  // A dot is a literal, not "any char" — otherwise `*.yml` would match `axyml`.
  assert.ok(!matches('*.yml', 'ayml'));
});

test('a lone write flushes immediately — no latency on the common case', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const flush = mock.fn();
  const timers = { debounce: null, max: null };

  scheduleFlush({ flush, debounceMs: 250, maxWaitMs: 1000, timers });

  assert.equal(flush.mock.callCount(), 1, 'the leading edge fires synchronously, before any timer');
  mock.timers.reset();
});

test('a burst flushes once at the leading edge and once when it settles', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  // The real flush() clears both timers; model that, or the trailing edge cannot be observed.
  const timers = { debounce: null, max: null };
  const flush = mock.fn(() => {
    clearTimeout(timers.debounce); timers.debounce = null;
    clearTimeout(timers.max); timers.max = null;
  });

  const fire = () => scheduleFlush({ flush, debounceMs: 250, maxWaitMs: 1000, timers });

  fire();                       // t=0   — leading edge
  assert.equal(flush.mock.callCount(), 1);

  mock.timers.tick(50); fire(); // t=50  — still bursting; must NOT re-fire the leading edge
  mock.timers.tick(50); fire(); // t=100
  assert.equal(flush.mock.callCount(), 1, 'mid-burst changes are coalesced, not flushed per event');

  mock.timers.tick(249);
  assert.equal(flush.mock.callCount(), 1, 'the debounce is measured from the LAST change, not the first');

  mock.timers.tick(1);
  assert.equal(flush.mock.callCount(), 2, 'the burst settles and flushes exactly once more');
  mock.timers.reset();
});

test('an unbroken stream of changes still flushes — maxWait defeats debounce starvation', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const timers = { debounce: null, max: null };
  const flush = mock.fn(() => {
    clearTimeout(timers.debounce); timers.debounce = null;
    clearTimeout(timers.max); timers.max = null;
  });

  scheduleFlush({ flush, debounceMs: 250, maxWaitMs: 1000, timers }); // leading
  assert.equal(flush.mock.callCount(), 1);

  // A change every 100ms forever: the debounce timer is reset before it can ever fire. Without the
  // maxWait ceiling the server would never hear about anything again.
  for (let t = 100; t <= 1000; t += 100) {
    mock.timers.tick(100);
    scheduleFlush({ flush, debounceMs: 250, maxWaitMs: 1000, timers });
  }

  assert.ok(flush.mock.callCount() >= 2, 'maxWait forces a flush through a stream that never goes quiet');
  mock.timers.reset();
});
