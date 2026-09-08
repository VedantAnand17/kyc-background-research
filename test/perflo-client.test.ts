import { afterEach, describe, expect, it } from "vitest";
import { createPerfloClient } from "../src/perflo/client.js";
import { ledgerActionFor, PerfloError } from "../src/perflo/errors.js";
import { startFakePerflo, type FakePayScenario, type FakePerflo } from "./fake-perflo.js";

const maxCharge = { amount: "0.025200", currency: "USD" };

async function clientAgainst(fake: FakePerflo, timeoutMs = 2_000) {
  return createPerfloClient({ baseUrl: fake.baseUrl, agentKey: "perflo_test_fake", timeoutMs });
}

const fakes: FakePerflo[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()));
});

async function fake(): Promise<FakePerflo> {
  const server = await startFakePerflo();
  fakes.push(server);
  return server;
}

describe("perflo error code -> ledger action", () => {
  it("maps the documented codes", () => {
    expect(ledgerActionFor("MAX_CHARGE_EXCEEDED")).toBe("release");
    expect(ledgerActionFor("SCHEMA_VALIDATION_FAILED")).toBe("release");
    expect(ledgerActionFor("VALIDATION_ERROR")).toBe("release");
    expect(ledgerActionFor("VENDOR_NOT_PAYABLE")).toBe("release");
    expect(ledgerActionFor("VENDOR_NOT_FOUND")).toBe("release");
    expect(ledgerActionFor("GUARDRAIL_DENIED")).toBe("release");
    expect(ledgerActionFor("INSUFFICIENT_BALANCE")).toBe("release");
    expect(ledgerActionFor("VENDOR_ERROR")).toBe("release");
    expect(ledgerActionFor("RATE_LIMITED")).toBe("release");
    expect(ledgerActionFor("CONFIRMATION_REQUIRED")).toBe("release");
    expect(ledgerActionFor("SETTLEMENT_RECORDING_FAILED")).toBe("settle_at_reserved");
    expect(ledgerActionFor("TIMEOUT")).toBe("hold");
    expect(ledgerActionFor("NETWORK_ERROR")).toBe("hold");
    expect(ledgerActionFor("INTERNAL_ERROR")).toBe("hold");
  });
});

describe("perflo client against fake server", () => {
  it("pay() sends Idempotency-Key and maxCharge on every call", async () => {
    const server = await fake();
    const client = await clientAgainst(server);
    await client.pay("demo-vendor", {
      input: { query: "ada" },
      maxCharge,
      idempotencyKey: "idem-1",
    });
    expect(server.payCalls).toEqual([
      {
        slug: "demo-vendor",
        idempotencyKey: "idem-1",
        body: { input: { query: "ada" }, maxCharge },
      },
    ]);
  });

  it("a 200 with status failed is treated as a charge", async () => {
    const server = await fake();
    const client = await clientAgainst(server);
    const result = await client.pay("scenario-failed", {
      maxCharge,
      idempotencyKey: "idem-failed",
    });
    expect(result.status).toBe("failed");
    expect(result.charged).toEqual(maxCharge);
    expect(result.transactionId).toMatch(/^tx-/);
  });

  it("a timeout never re-pays; it looks the transaction up", async () => {
    const server = await fake();
    const client = await clientAgainst(server, 80);
    await expect(
      client.pay("scenario-hang", { maxCharge, idempotencyKey: "idem-hang" }),
    ).rejects.toMatchObject({ code: "TIMEOUT", name: "PerfloError" });
    expect(server.payCalls).toHaveLength(1);

    await expect(client.getTransaction("missing")).rejects.toMatchObject({ code: "TRANSACTION_NOT_FOUND" });
  });

  it("maps every documented pay code to the documented ledger action", async () => {
    const server = await fake();
    const client = await clientAgainst(server);
    const cases: Array<{ slug: string; scenario: FakePayScenario; code: string; action: ReturnType<typeof ledgerActionFor> }> = [
      { slug: "scenario-MAX_CHARGE_EXCEEDED", scenario: "MAX_CHARGE_EXCEEDED", code: "MAX_CHARGE_EXCEEDED", action: "release" },
      { slug: "scenario-SCHEMA_VALIDATION_FAILED", scenario: "SCHEMA_VALIDATION_FAILED", code: "SCHEMA_VALIDATION_FAILED", action: "release" },
      { slug: "scenario-VALIDATION_ERROR", scenario: "VALIDATION_ERROR", code: "VALIDATION_ERROR", action: "release" },
      { slug: "scenario-VENDOR_NOT_PAYABLE", scenario: "VENDOR_NOT_PAYABLE", code: "VENDOR_NOT_PAYABLE", action: "release" },
      { slug: "scenario-VENDOR_NOT_FOUND", scenario: "VENDOR_NOT_FOUND", code: "VENDOR_NOT_FOUND", action: "release" },
      { slug: "scenario-GUARDRAIL_DENIED", scenario: "GUARDRAIL_DENIED", code: "GUARDRAIL_DENIED", action: "release" },
      { slug: "scenario-INSUFFICIENT_BALANCE", scenario: "INSUFFICIENT_BALANCE", code: "INSUFFICIENT_BALANCE", action: "release" },
      { slug: "scenario-VENDOR_ERROR", scenario: "VENDOR_ERROR", code: "VENDOR_ERROR", action: "release" },
      { slug: "scenario-pending_confirmation", scenario: "pending_confirmation", code: "CONFIRMATION_REQUIRED", action: "release" },
      { slug: "scenario-SETTLEMENT_RECORDING_FAILED", scenario: "SETTLEMENT_RECORDING_FAILED", code: "SETTLEMENT_RECORDING_FAILED", action: "settle_at_reserved" },
      { slug: "scenario-RATE_LIMITED", scenario: "RATE_LIMITED", code: "RATE_LIMITED", action: "release" },
    ];

    for (const row of cases) {
      const err = await client.pay(row.slug, { maxCharge, idempotencyKey: `idem-${row.scenario}` }).then(
        () => {
          throw new Error(`expected ${row.code} to throw`);
        },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(PerfloError);
      expect(err).toMatchObject({ code: row.code });
      expect(ledgerActionFor(row.code)).toBe(row.action);
    }
  });

  it("replays the first pay result for a repeated Idempotency-Key and charges once", async () => {
    const server = await fake();
    const client = await clientAgainst(server);
    const first = await client.pay("demo-vendor", { maxCharge, idempotencyKey: "same-key" });
    const second = await client.pay("demo-vendor", { maxCharge, idempotencyKey: "same-key" });
    expect(second.transactionId).toBe(first.transactionId);
    expect(server.payCalls).toHaveLength(2);
    const listed = await client.listTransactions();
    expect(listed).toHaveLength(1);
  });

  it("reads vendor, search, balance, and a posted transaction", async () => {
    const server = await fake();
    const client = await clientAgainst(server);
    const vendor = await client.getVendor("demo-vendor");
    expect(vendor.maxChargePerCall).toEqual(maxCharge);
    expect(vendor.input?.fields[0]?.in).toBe("body");

    const found = await client.search("web search", { limit: 2 });
    expect(found[0]?.payable).toBe(true);

    const balance = await client.getBalance();
    expect(balance).toMatchObject({ spendable: { currency: "USD" } });

    const paid = await client.pay("demo-vendor", { maxCharge, idempotencyKey: "idem-tx" });
    const row = await client.getTransaction(paid.transactionId);
    expect(row.ledgerState).toBe("posted");
    expect(row.amount.amount.startsWith("-")).toBe(true);
  });
});
