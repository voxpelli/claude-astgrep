import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createFrameReader, encodeFrame } from '../bin/lsp-framing.mjs';

/** Collect every frame a reader emits, plus any framing error, for a list of chunks. */
function drain (chunks) {
  const frames = [];
  const errors = [];
  const push = createFrameReader({
    onFrame: (raw, message) => frames.push({ raw, message }),
    onFramingError: (error, pending) => errors.push({ error, pending }),
  });
  for (const chunk of chunks) push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'));
  return { frames, errors };
}

test('encodeFrame round-trips through the reader', () => {
  const message = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };
  const { frames, errors } = drain([encodeFrame(message)]);

  assert.equal(errors.length, 0);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].message, message);
});

test('Content-Length counts BYTES, not string length', () => {
  // The whole reason this module exists. "🧪" is 1 JS string unit of length 2 but 4 UTF-8 bytes; a
  // reader that slices by string index desynchronises here and never recovers.
  const message = { method: 'x', params: { emoji: '🧪🧪🧪', accents: 'Ærøskøbing' } };
  const frame = encodeFrame(message);

  const declared = Number(/Content-Length: (\d+)/.exec(frame.toString('ascii', 0, 40))[1]);
  const body = JSON.stringify(message);
  assert.equal(declared, Buffer.byteLength(body, 'utf8'));
  assert.notEqual(declared, body.length, 'fixture must actually exercise the bytes-vs-chars gap');

  // And a second frame right behind it still lands on the correct boundary.
  const { frames } = drain([Buffer.concat([frame, encodeFrame({ method: 'after' })])]);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0].message, message);
  assert.deepEqual(frames[1].message, { method: 'after' });
});

test('several whole messages arriving in one chunk', () => {
  const msgs = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const { frames } = drain([Buffer.concat(msgs.map(encodeFrame))]);

  assert.deepEqual(frames.map((f) => f.message), msgs);
});

test('one message split across many chunks — including mid-header and mid-body', () => {
  const message = { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///a.js', diagnostics: [] } };
  const frame = encodeFrame(message);

  // Byte-at-a-time is the cruellest split there is: every boundary is exercised at once.
  const { frames, errors } = drain([...frame].map((b) => Buffer.from([b])));

  assert.equal(errors.length, 0);
  assert.equal(frames.length, 1, 'a byte-at-a-time stream must still yield exactly one frame');
  assert.deepEqual(frames[0].message, message);
});

test('a chunk carrying the tail of one frame and the head of the next', () => {
  const a = encodeFrame({ id: 'a' });
  const b = encodeFrame({ id: 'b' });
  const all = Buffer.concat([a, b]);

  // Cut deliberately inside the FIRST frame's body, so chunk 2 spans a boundary.
  const cut = a.length - 3;
  const { frames } = drain([all.subarray(0, cut), all.subarray(cut)]);

  assert.deepEqual(frames.map((f) => f.message), [{ id: 'a' }, { id: 'b' }]);
});

test('the frame handed back is the ORIGINAL bytes, not a re-serialisation', () => {
  // Key order and spacing must survive: the shim forwards `raw` verbatim rather than re-encoding, so
  // that it cannot silently rewrite messages it is only supposed to relay.
  const body = '{"jsonrpc":"2.0","zebra":1,"alpha":2}';
  const raw = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, 'utf8');
  const { frames } = drain([raw]);

  assert.equal(frames.length, 1);
  assert.equal(frames[0].raw.toString('utf8'), raw.toString('utf8'));
  assert.deepEqual(frames[0].message, { jsonrpc: '2.0', zebra: 1, alpha: 2 });
});

test('extra headers and odd casing/whitespace are tolerated', () => {
  const body = '{"ok":true}';
  const raw = Buffer.from(
    `content-length:${Buffer.byteLength(body)}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n${body}`,
    'utf8',
  );
  const { frames, errors } = drain([raw]);

  assert.equal(errors.length, 0);
  assert.deepEqual(frames[0].message, { ok: true });
});

test('a well-framed body that is not valid JSON is forwarded, not fatal', () => {
  // Framing intact, payload garbage => an INSPECTION problem. The bytes must still flow so the real
  // peer can complain; wedging the whole proxy over one bad message would be a worse failure.
  const body = '{ not json';
  const raw = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, 'utf8');
  const { frames, errors } = drain([Buffer.concat([raw, encodeFrame({ id: 'next' })])]);

  assert.equal(errors.length, 0, 'bad JSON must not be treated as a framing failure');
  assert.equal(frames.length, 2);
  assert.equal(frames[0].message, undefined, 'unparseable body surfaces as message: undefined');
  assert.equal(frames[0].raw.toString('utf8'), raw.toString('utf8'), 'and its bytes are still handed over');
  assert.deepEqual(frames[1].message, { id: 'next' }, 'and the stream stays in sync afterwards');
});

test('a header with no Content-Length is a framing error, and surrenders its buffer', () => {
  const raw = Buffer.from('X-Nonsense: 1\r\n\r\n{"id":1}', 'utf8');
  const { frames, errors } = drain([raw]);

  assert.equal(frames.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].error.message, /Content-Length/);
  assert.equal(errors[0].pending.length, raw.length, 'unconsumed bytes come back so the caller can raw-pipe them');
});

test('an endless header does not buffer forever', () => {
  const { errors } = drain([Buffer.alloc(9 * 1024, 0x41)]); // 9 KiB of 'A', no terminator, ever.

  assert.equal(errors.length, 1);
  assert.match(errors[0].error.message, /not LSP-framed/);
});

test('an absurd Content-Length is rejected rather than trusted', () => {
  // Guards against a malformed/hostile header making us wait for 4 GiB that will never arrive.
  const { errors } = drain([Buffer.from('Content-Length: 999999999999\r\n\r\n', 'ascii')]);

  assert.equal(errors.length, 1);
  assert.match(errors[0].error.message, /sanity bound/);
});

test('after a framing error the reader stays dead and emits nothing further', () => {
  const frames = [];
  const errors = [];
  const push = createFrameReader({
    onFrame: (raw, message) => frames.push(message),
    onFramingError: (error) => errors.push(error),
  });

  push(Buffer.from('X-Nonsense: 1\r\n\r\n', 'utf8'));
  push(encodeFrame({ id: 'should be ignored' }));

  assert.equal(errors.length, 1, 'the error fires exactly once');
  assert.equal(frames.length, 0, 'a dead reader must not resume parsing — the caller now owns the stream');
});

test('an empty-object body (Content-Length: 2) is a valid frame', () => {
  const { frames, errors } = drain([encodeFrame({})]);

  assert.equal(errors.length, 0);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].message, {});
});
