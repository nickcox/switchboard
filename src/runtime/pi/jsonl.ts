import { z } from "zod";

const recordSchema = z.object({ type: z.string().min(1) }).passthrough();
export type RpcRecord = z.infer<typeof recordSchema>;

/** Pi JSONL uses LF only; Unicode line separators are valid within JSON strings. */
export class JsonlDecoder {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private buffered = "";
  private readonly maxRecordBytes: number;
  constructor(maxRecordBytes = 4 * 1024 * 1024) { this.maxRecordBytes = maxRecordBytes; }

  push(bytes: Uint8Array): RpcRecord[] {
    this.buffered += this.decoder.decode(bytes, { stream: true });
    const records: RpcRecord[] = [];
    let boundary: number;
    while ((boundary = this.buffered.indexOf("\n")) !== -1) {
      const line = this.buffered.slice(0, boundary).replace(/\r$/, "");
      this.buffered = this.buffered.slice(boundary + 1);
      if (Buffer.byteLength(line) > this.maxRecordBytes) throw new Error("RPC record exceeds byte limit");
      records.push(recordSchema.parse(JSON.parse(line)));
    }
    if (Buffer.byteLength(this.buffered) > this.maxRecordBytes) throw new Error("RPC record exceeds byte limit");
    return records;
  }

  finish(): void {
    this.buffered += this.decoder.decode();
    if (this.buffered.length) throw new Error("RPC stream ended with an unterminated record");
  }
}
