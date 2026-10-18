import { expect, test } from "bun:test";
import { JsonlDecoder } from "../../src/runtime/pi/jsonl.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

test("strict LF framing preserves Unicode separators, CRLF and split UTF-8 sequences", () => {
  const parser = new JsonlDecoder();
  const encoded = bytes('{"type":"example","text":"α\u2028β\u2029γ"}\r\n');
  const records = [];
  for (const byte of encoded) records.push(...parser.push(new Uint8Array([byte])));
  parser.finish();
  expect(records).toEqual([{ type: "example", text: "α\u2028β\u2029γ" }]);
});

test("malformed records, invalid UTF-8 and non-object output refuse the protocol", () => {
  for (const text of ["diagnostic\n", "[]\n", "null\n", "{}\n", "\n"]) {
    expect(() => new JsonlDecoder().push(bytes(text))).toThrow();
  }
  expect(() => new JsonlDecoder().push(new Uint8Array([0xff]))).toThrow();
});

test("record bounds and unterminated trailing output are checked", () => {
  expect(() => new JsonlDecoder(4).push(bytes("12345"))).toThrow("limit");
  expect(() => new JsonlDecoder(4).push(bytes("12345\n"))).toThrow("limit");
  const parser = new JsonlDecoder();
  parser.push(bytes('{"type":"event"}'));
  expect(() => parser.finish()).toThrow("unterminated");
});
