// LSP base-protocol framing: `Content-Length: N\r\n\r\n<N bytes of JSON>`.
//
// Hand-rolled on purpose. `vscode-jsonrpc` is the right library and we cannot use it: Claude Code
// git-clones a plugin into ~/.claude/plugins/cache/ and never runs `npm install`, so a runtime
// dependency simply would not exist when the server starts. Zero deps is a hard constraint here,
// not a preference.
//
// Framing is the one place in the shim where a bug is catastrophic rather than merely annoying — get
// a boundary wrong and every subsequent message is garbage — so it lives here, alone, behind tests.
//
// Two rules this module exists to enforce:
//
//   1. Content-Length is BYTES, not characters. A body containing one emoji is longer in bytes than
//      in JS string units, and slicing by string index desynchronises the stream permanently.
//   2. A frame is forwarded VERBATIM. We parse to decide *what a message is*, but we hand back the
//      original bytes to forward. Re-serialising through JSON.parse/stringify would quietly rewrite
//      key order, number formatting and unicode escapes — a proxy that mutates what it claims to
//      pass through is worse than no proxy.

/** Refuse to buffer an unbounded header while hunting for the \r\n\r\n terminator. */
const MAX_HEADER_BYTES = 8 * 1024;

/** A Content-Length larger than this is taken as evidence the stream is not really LSP. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const SEPARATOR = Buffer.from('\r\n\r\n', 'ascii');

/**
 * Serialise a message into a complete LSP frame.
 *
 * @param {unknown} message
 * @returns {Buffer}
 */
export function encodeFrame (message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
    body,
  ]);
}

/**
 * @typedef {object} FrameReaderHandlers
 * @property {(raw: Buffer, message: unknown) => void} onFrame  Called once per complete frame, with
 *   the frame's exact bytes and its parsed body. `message` is `undefined` when the body is not valid
 *   JSON — the framing is still sound, so the caller should forward `raw` and simply not inspect it.
 * @property {(error: Error, pending: Buffer) => void} onFramingError  Called when the byte boundaries
 *   can no longer be trusted. Unrecoverable: the reader stops, and the caller is handed whatever is
 *   still buffered so it can fall back to a raw pipe without losing those bytes.
 */

/**
 * A streaming reader for LSP frames.
 *
 * Chunk boundaries mean nothing: a chunk may carry half a header, several whole frames, or a body
 * split across three reads. The reader consumes bytes until it has a whole frame and never assumes
 * a chunk is a message.
 *
 * @param {FrameReaderHandlers} handlers
 * @returns {(chunk: Buffer) => void} Feed it every chunk from the stream.
 */
export function createFrameReader ({ onFrame, onFramingError }) {
  let buf = Buffer.alloc(0);
  let dead = false;

  const die = (message) => {
    dead = true;
    const pending = buf;
    buf = Buffer.alloc(0);
    onFramingError(new Error(message), pending);
  };

  return function push (chunk) {
    if (dead) return;
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);

    for (;;) {
      const headerEnd = buf.indexOf(SEPARATOR);

      if (headerEnd === -1) {
        // No terminator yet. Fine — unless we have buffered more than any legitimate header could be,
        // which means we are not looking at LSP at all and will never find one.
        if (buf.length > MAX_HEADER_BYTES) {
          die(`no header terminator within ${MAX_HEADER_BYTES} bytes — stream is not LSP-framed`);
        }
        return;
      }

      const header = buf.subarray(0, headerEnd).toString('ascii');
      const match = /^content-length:[ \t]*(\d+)[ \t]*$/im.exec(header);

      if (!match) {
        die(`frame header carries no Content-Length: ${JSON.stringify(header.slice(0, 120))}`);
        return;
      }

      const length = Number(match[1]);
      if (length > MAX_BODY_BYTES) {
        die(`Content-Length ${length} exceeds the ${MAX_BODY_BYTES}-byte sanity bound`);
        return;
      }

      const bodyStart = headerEnd + SEPARATOR.length;
      const bodyEnd = bodyStart + length;
      if (buf.length < bodyEnd) return; // Body still arriving. Wait for more bytes.

      const raw = buf.subarray(0, bodyEnd);
      const body = buf.subarray(bodyStart, bodyEnd);
      buf = buf.subarray(bodyEnd);

      let message;
      try {
        message = JSON.parse(body.toString('utf8'));
      } catch {
        // Bad JSON inside a well-framed message. The boundaries still hold, so this is an inspection
        // problem, not a framing one: pass the bytes on and let the real peer complain.
        message = undefined;
      }

      onFrame(raw, message);
      if (dead) return; // onFrame may have torn things down.
    }
  };
}
