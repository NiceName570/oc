// Purpose: Verify TP/SL bracket target math, validation, trigger execution, position-missing cleanup, and rollover clearing.

import crypto from "node:crypto";
import { jweEncryption } from "@openchart/server/access/credential/encryption";
import { temporaryHome } from "@openchart/server/home.test-utils";
import { makeRuntime, type Runtime } from "@openchart/server/runtime";
import { ConfigProvider } from "effect";
import { afterEach, describe, expect, test } from "vitest";

import {
  computeAutoBracketTargets,
  createBracketMonitor,
  validateBracketPrices,
} from "./bracket-monitor";
import type { KalshiBtc15mMarket } from "./client";
import { saveKalshiCredentials } from "./credentials";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createTestRuntime() {
  return makeRuntime({
    home: temporaryHome(),
    databasePath: ":memory:",
    credentialEncryption: jweEncryption(crypto.randomBytes(32)),
    config: ConfigProvider.fromUnknown({
      providers: {
        openchart: { enabled: false },
        binance: { enabled: false },
        yfinance: { enabled: false },
        tradingview: { enabled: false },
      },
    }),
    models: {
      fetchEnabled: false,
      userAgent: "test",
    },
  });
}

function makeMarket(
  overrides: Partial<KalshiBtc15mMarket> = {},
): KalshiBtc15mMarket {
  return {
    ticker: "KXBTC15M-26NOV191715-15",
    eventTicker: "KXBTC15M-26NOV191715",
    title: "BTC 15m up or down",
    strikeDollars: 62500,
    openTime: "2026-11-19T22:00:00Z",
    closeTime: "2099-11-19T22:15:00Z",
    exchangeIndex: 2,
    yesBidDollars: 0.6,
    yesAskDollars: 0.62,
    noBidDollars: 0.38,
    noAskDollars: 0.4,
    lastPriceDollars: 0.61,
    ...overrides,
  };
}

describe("kalshi bracket math & validation", () => {
  test("computes bounded TP/SL targets from entry price and cent offsets", () => {
    expect(
      computeAutoBracketTargets({
        entryPriceDollars: 0.6,
        takeProfitOffsetCents: 15,
        stopLossOffsetCents: 10,
      }),
    ).toEqual({
      takeProfitDollars: 0.75,
      stopLossDollars: 0.5,
    });

    expect(
      computeAutoBracketTargets({
        entryPriceDollars: 0.99,
        takeProfitOffsetCents: 10,
        stopLossOffsetCents: 5,
      }),
    ).toEqual({
      takeProfitDollars: null,
      stopLossDollars: 0.94,
    });

    expect(
      computeAutoBracketTargets({
        entryPriceDollars: 0.02,
        takeProfitOffsetCents: 5,
        stopLossOffsetCents: 10,
      }),
    ).toEqual({
      takeProfitDollars: 0.07,
      stopLossDollars: 0.01,
    });
  });

  test("rejects invalid TP/SL ranges and SL >= TP", () => {
    expect(
      validateBracketPrices({ takeProfitDollars: 0.8, stopLossDollars: 0.5 }),
    ).toEqual({ takeProfitDollars: 0.8, stopLossDollars: 0.5 });

    expect(() =>
      validateBracketPrices({ takeProfitDollars: 0.5, stopLossDollars: 0.5 }),
    ).toThrow(/Stop-loss price must be lower/i);

    expect(() =>
      validateBracketPrices({ takeProfitDollars: 1, stopLossDollars: null }),
    ).toThrow(/between \$0\.01 and \$0\.99/i);
  });
});

describe("kalshi bracket monitor execution", () => {
  const runtimes: Runtime[] = [];

  afterEach(async () => {
    await Promise.allSettled(runtimes.splice(0).map((rt) => rt.dispose()));
  });

  test("triggers take-profit reduce_only exit and clears rule after full fill", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    await runtime.runPromise(
      saveKalshiCredentials({
        apiKeyId: "ak-bracket-test",
        privateKeyPem: privateKey
          .export({ format: "pem", type: "pkcs8" })
          .toString(),
        maxOrderDollars: 5,
      }),
    );

    const posted: Array<Record<string, unknown>> = [];
    let executedCallbackCount = 0;

    const monitor = createBracketMonitor({
      pollIntervalMs: 0,
      onOrderExecuted: () => {
        executedCallbackCount += 1;
      },
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.includes("/portfolio/positions")) {
          return jsonResponse({
            market_positions: [
              {
                ticker: "KXBTC15M-26NOV191715-15",
                position_fp: "8.00",
                market_exposure_dollars: "4.80",
                realized_pnl_dollars: "0.00",
                fees_paid_dollars: "0.05",
              },
            ],
          });
        }
        if (url.includes("/portfolio/events/orders")) {
          posted.push(
            JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
          );
          return jsonResponse({
            order_id: "ord-tp-1",
            client_order_id: "cid-tp-1",
            fill_count: "8.00",
            remaining_count: "0.00",
            average_fill_price: "0.7500",
            average_fee_paid: "0.0400",
            ts_ms: 1763590000000,
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    });

    monitor.setRule({
      runtime,
      ticker: "KXBTC15M-26NOV191715-15",
      side: "yes",
      takeProfitDollars: 0.75,
      stopLossDollars: 0.45,
      exchangeIndex: 2,
    });

    expect(
      await monitor.evaluateWithMarket(
        makeMarket({ yesBidDollars: 0.7 }),
        runtime,
      ),
    ).toBeNull();
    expect(posted).toHaveLength(0);

    const event = await monitor.evaluateWithMarket(
      makeMarket({ yesBidDollars: 0.76 }),
      runtime,
    );
    expect(event).toMatchObject({
      trigger: "take_profit",
      status: "filled",
      ticker: "KXBTC15M-26NOV191715-15",
      side: "yes",
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      ticker: "KXBTC15M-26NOV191715-15",
      side: "ask",
      count: "8.00",
      price: "0.7500",
      reduce_only: true,
    });
    expect(executedCallbackCount).toBe(1);
    expect(monitor.getRule()).toBeNull();
  });

  test("triggers stop-loss with sweep buffer on NO side and translates fill price", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    await runtime.runPromise(
      saveKalshiCredentials({
        apiKeyId: "ak-bracket-no",
        privateKeyPem: privateKey
          .export({ format: "pem", type: "pkcs8" })
          .toString(),
        maxOrderDollars: 5,
      }),
    );

    const posted: Array<Record<string, unknown>> = [];
    const monitor = createBracketMonitor({
      pollIntervalMs: 0,
      stopLossSweepBufferDollars: 0.02,
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.includes("/portfolio/positions")) {
          return jsonResponse({
            market_positions: [
              {
                ticker: "KXBTC15M-26NOV191715-15",
                position_fp: "-4.00",
                market_exposure_dollars: "2.00",
                realized_pnl_dollars: "0.00",
                fees_paid_dollars: "0.02",
              },
            ],
          });
        }
        if (url.includes("/portfolio/events/orders")) {
          posted.push(
            JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
          );
          return jsonResponse({
            order_id: "ord-sl-1",
            client_order_id: "cid-sl-1",
            fill_count: "4.00",
            remaining_count: "0.00",
            average_fill_price: "0.6600",
            average_fee_paid: "0.0200",
            ts_ms: 1763590001000,
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    });

    monitor.setRule({
      runtime,
      ticker: "KXBTC15M-26NOV191715-15",
      side: "no",
      takeProfitDollars: 0.7,
      stopLossDollars: 0.36,
    });

    const event = await monitor.evaluateWithMarket(
      makeMarket({ noBidDollars: 0.35 }),
      runtime,
    );
    expect(event).toMatchObject({
      trigger: "stop_loss",
      status: "filled",
      side: "no",
    });
    expect(event?.message).toContain("@ 34¢");
    expect(posted[0]).toMatchObject({
      side: "bid",
      count: "4.00",
      price: "0.6700",
      reduce_only: true,
    });
  });

  test("clears armed rules quietly when position is gone or contract rolls over", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    await runtime.runPromise(
      saveKalshiCredentials({
        apiKeyId: "ak-bracket-clear",
        privateKeyPem: privateKey
          .export({ format: "pem", type: "pkcs8" })
          .toString(),
        maxOrderDollars: 25,
      }),
    );

    const monitor = createBracketMonitor({
      pollIntervalMs: 0,
      fetchImpl: async () => jsonResponse({ market_positions: [] }),
    });

    monitor.setRule({
      runtime,
      ticker: "KXBTC15M-26NOV191715-15",
      side: "yes",
      takeProfitDollars: 0.8,
      stopLossDollars: 0.4,
    });

    const missingResult = await monitor.evaluateWithMarket(
      makeMarket({ yesBidDollars: 0.85 }),
      runtime,
    );
    expect(missingResult).toBeNull();
    expect(monitor.getRule()).toBeNull();

    monitor.setRule({
      runtime,
      ticker: "KXBTC15M-26NOV191715-15",
      side: "yes",
      takeProfitDollars: 0.8,
      stopLossDollars: null,
    });
    const rollover = await monitor.evaluateWithMarket(
      makeMarket({ ticker: "KXBTC15M-26NOV191730-30" }),
      runtime,
    );
    expect(rollover?.status).toBe("closed");
    expect(monitor.getRule()).toBeNull();
  });
});
