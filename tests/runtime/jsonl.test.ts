import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonlDecoder } from "../../src/runtime/pi/jsonl.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

test("strict LF framing preserves Unicode separators, CRLF and split UTF-8 sequences", () => {
  const parser = new JsonlDecoder();
  const encoded = bytes('{"type":"example","text":"α β γ"}\r\n');
  const records = [];
  for (const byte of encoded) records.push(...parser.push(new Uint8Array([byte])));
  parser.finish();
  assert.deepEqual(records, [{ type: "example", text: "α β γ" }]);
});

test("malformed records, invalid UTF-8 and non-object output refuse the protocol", () => {
  for (const text of ["diagnostic\n", "[]\n", "null\n", "{}\n", "\n"]) {
    assert.throws(() => new JsonlDecoder().push(bytes(text)));
  }
  assert.throws(() => new JsonlDecoder().push(new Uint8Array([0xff])));
});

test("record bounds and unterminated trailing output are checked", () => {
  assert.throws(() => new JsonlDecoder(4).push(bytes("12345")), /limit/);
  assert.throws(() => new JsonlDecoder(4).push(bytes("12345\n")), /limit/);
  const parser = new JsonlDecoder();
  parser.push(bytes('{"type":"event"}'));
  assert.throws(() => parser.finish(), /unterminated/);
});
