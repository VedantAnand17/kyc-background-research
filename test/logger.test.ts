import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { createLogger } from "../src/logger.js";

function captureLog(write: (log: ReturnType<typeof createLogger>) => void): string {
  const chunks: Buffer[] = [];
  const dest = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  write(createLogger("info", dest));
  return Buffer.concat(chunks).toString("utf8");
}

describe("log redaction", () => {
  it("never writes LLM_API_KEY, PERFLO_AGENT_KEY, or authorization headers", () => {
    const line = captureLog((log) => {
      log.info(
        {
          LLM_API_KEY: "sk-live-secret",
          PERFLO_AGENT_KEY: "perflo_live_secret",
          authorization: "Bearer sk-live-secret",
          apiKey: "sk-live-secret",
          requestId: "req_1",
        },
        "phase start",
      );
    });
    expect(line).toMatch(/phase start/);
    expect(line).toMatch(/\[redacted\]/);
    expect(line).not.toMatch(/sk-live-secret/);
    expect(line).not.toMatch(/perflo_live_secret/);
    expect(line).not.toMatch(/Bearer /);
  });
});
