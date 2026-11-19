// Purpose: Verify Kalshi tRPC router credential encryption, caching, snapshot math, cap rejection, and root router mounting.

import crypto from "node:crypto";
import { jweEncryption } from "@openchart/server/access/credential/encryption";
import { temporaryHome } from "@openchart/server/home.test-utils";
import { router } from "@openchart/server";
import { makeRuntime, type Runtime } from "@openchart/server/runtime";
import { ConfigProvider } from "effect";
import { afterEach, describe, expect, test } from "vitest";

import { createKalshiRouter } from "./router";

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

describe("kalshi tRPC router", () => {
  const runtimes: Runtime[] = [];

  afterEach(async () => {
    await Promise.allSettled(runtimes.splice(0).map((rt) => rt.dispose()));
  });

  test("mounts kalshi on the root router without polluting integration listings", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const rootCaller = router.createCaller({ runtime });

    const status = await rootCaller.kalshi.status();
    expect(status).toEqual({
      connected: false,
      maskedApiKeyId: null,
      maxOrderDollars: 25,
    });

    const integrations = await rootCaller.access.integration.listIntegrations();
    expect(integrations.some((entry) => entry.id === "kalshi")).toBe(false);
  });

  test("handles encrypted connect, 10s balance caching, snapshot P&L, cap enforcement, orders, and disconnect", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);

    const { privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const validPem = privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString();

    let balanceCalls = 0;
    let positionCalls = 0;
    const postedOrders: Array<Record<string, unknown>> = [];
    let authRejected = false;

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/markets?")) {
        return jsonResponse({
          markets: [
            {
              ticker: "KXBTC15M-26NOV191330-30",
              event_ticker: "KXBTC15M-26NOV191330",
              title: "BTC 15m up or down",
              status: "active",
              open_time: "2026-11-19T18:15:00Z",
              close_time: "2099-11-19T18:30:00Z",
              floor_strike: 62653.28,
              exchange_index: 2,
              yes_bid_dollars: "0.7200",
              yes_ask_dollars: "0.7400",
              no_bid_dollars: "0.2600",
              no_ask_dollars: "0.2800",
              last_price_dollars: "0.7300",
            },
          ],
        });
      }
      if (url.includes("coinbase.com")) {
        return jsonResponse({ data: { amount: "62803.80" } });
      }
      if (url.includes("/portfolio/balance")) {
        balanceCalls += 1;
        if (authRejected) {
          return jsonResponse(
            { error: { code: "unauthorized", message: "Invalid key" } },
            401,
          );
        }
        return jsonResponse({
          balance: 15000,
          balance_dollars: "150.00",
          portfolio_value: 15720,
          portfolio_value_dollars: "157.20",
          updated_ts: 1763576000,
        });
      }
      if (url.includes("/portfolio/positions")) {
        positionCalls += 1;
        return jsonResponse({
          market_positions: [
            {
              ticker: "KXBTC15M-26NOV191330-30",
              position_fp: "10.00",
              market_exposure_dollars: "4.50",
              realized_pnl_dollars: "0.00",
              fees_paid_dollars: "0.10",
            },
          ],
        });
      }
      if (url.includes("/portfolio/events/orders")) {
        postedOrders.push(
          JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        );
        return jsonResponse({
          order_id: "ord-live-1",
          client_order_id: "cid-1",
          fill_count: "10.00",
          remaining_count: "0.00",
          average_fill_price: "0.7200",
          average_fee_paid: "0.0500",
          ts_ms: 1763576010000,
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    const kalshiRouter = createKalshiRouter({
      fetchImpl,
      balanceCacheTtlMs: 10_000,
    });
    const caller = kalshiRouter.createCaller({ runtime });

    const anonSnapshot = await caller.snapshot();
    expect(anonSnapshot.connected).toBe(false);
    expect(anonSnapshot.spotUsd).toBe(62803.8);
    expect(anonSnapshot.market?.strikeDollars).toBe(62653.28);
    expect(anonSnapshot.distanceDollars).toBe(150.52);
    expect(anonSnapshot.balance).toBeNull();
    expect(anonSnapshot.position).toBeNull();

    authRejected = true;
    const rejectedConnect = await caller.connect({
      apiKeyId: "abcd-1234-wxyz",
      privateKeyPem: validPem,
      maxOrderDollars: 5,
    });
    expect(rejectedConnect.ok).toBe(false);
    expect((await caller.status()).connected).toBe(false);

    authRejected = false;
    const connected = await caller.connect({
      apiKeyId: "abcd-1234-wxyz",
      privateKeyPem: validPem,
      maxOrderDollars: 5,
    });
    expect(connected).toMatchObject({
      ok: true,
      maskedApiKeyId: "abcd...wxyz",
      maxOrderDollars: 5,
      algorithm: "rsa-pss",
    });
    expect(JSON.stringify(connected)).not.toContain("PRIVATE KEY");
    expect(balanceCalls).toBe(2);

    const firstSnap = await caller.snapshot();
    expect(firstSnap.connected).toBe(true);
    expect(firstSnap.maskedApiKeyId).toBe("abcd...wxyz");
    expect(firstSnap.balance?.balanceDollars).toBe(150);
    expect(firstSnap.position).toMatchObject({
      side: "yes",
      contracts: 10,
      costBasisDollars: 4.5,
      exitBidDollars: 0.72,
      exitProceedsDollars: 7.2,
      estimatedPnlDollars: 2.7,
    });
    expect(balanceCalls).toBe(2);
    expect(positionCalls).toBe(1);

    await caller.snapshot();
    expect(balanceCalls).toBe(2);
    expect(positionCalls).toBe(2);

    const overCap = await caller.placeOrder({
      ticker: "KXBTC15M-26NOV191330-30",
      action: "buy_yes",
      count: 10,
      limitPriceDollars: 0.74,
      exchangeIndex: 2,
    });
    expect(overCap.ok).toBe(false);
    if (!overCap.ok) {
      expect(overCap.error).toMatch(/exceeds max order cap/i);
    }
    expect(postedOrders).toHaveLength(0);

    const capUpdated = await caller.setMaxOrderDollars({ maxOrderDollars: 20 });
    expect(capUpdated).toEqual({
      ok: true,
      maskedApiKeyId: "abcd...wxyz",
      maxOrderDollars: 20,
    });

    const sellOrder = await caller.placeOrder({
      ticker: "KXBTC15M-26NOV191330-30",
      action: "sell_yes",
      count: 10,
      limitPriceDollars: 0.72,
      exchangeIndex: 2,
    });
    expect(sellOrder).toMatchObject({
      ok: true,
      order: {
        orderId: "ord-live-1",
        fillCount: "10.00",
      },
    });
    expect(postedOrders).toHaveLength(1);
    expect(postedOrders[0]).toMatchObject({
      ticker: "KXBTC15M-26NOV191330-30",
      side: "ask",
      count: "10.00",
      price: "0.7200",
      reduce_only: true,
      exchange_index: 2,
    });

    await caller.snapshot();
    expect(balanceCalls).toBe(3);

    await caller.disconnect();
    expect(await caller.status()).toEqual({
      connected: false,
      maskedApiKeyId: null,
      maxOrderDollars: 25,
    });
  });

  test("auto-arms TP/SL on buy with offsets, adjusts via setBracket, and clears via clearBracket/disconnect", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    const validPem = privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString();

    let hasPosition = true;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/markets?")) {
        return jsonResponse({
          markets: [
            {
              ticker: "KXBTC15M-26NOV191715-15",
              event_ticker: "KXBTC15M-26NOV191715",
              title: "BTC 15m up or down",
              status: "active",
              open_time: "2026-11-19T22:00:00Z",
              close_time: "2099-11-19T22:15:00Z",
              floor_strike: 62500,
              exchange_index: 2,
              yes_bid_dollars: "0.5800",
              yes_ask_dollars: "0.6000",
              no_bid_dollars: "0.4000",
              no_ask_dollars: "0.4200",
              last_price_dollars: "0.5900",
            },
          ],
        });
      }
      if (url.includes("coinbase.com")) {
        return jsonResponse({ data: { amount: "62540.00" } });
      }
      if (url.includes("/portfolio/balance")) {
        return jsonResponse({
          balance_dollars: "200.00",
          portfolio_value_dollars: "200.00",
          updated_ts: 1763590000,
        });
      }
      if (url.includes("/portfolio/positions")) {
        return jsonResponse({
          market_positions: hasPosition
            ? [
                {
                  ticker: "KXBTC15M-26NOV191715-15",
                  position_fp: "5.00",
                  market_exposure_dollars: "3.00",
                  realized_pnl_dollars: "0.00",
                  fees_paid_dollars: "0.02",
                },
              ]
            : [],
        });
      }
      if (url.includes("/portfolio/events/orders")) {
        return jsonResponse({
          order_id: "ord-auto-1",
          client_order_id: "cid-auto-1",
          fill_count: "5.00",
          remaining_count: "0.00",
          average_fill_price: "0.6000",
          average_fee_paid: "0.0200",
          ts_ms: 1763590001000,
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const caller = createKalshiRouter({
      fetchImpl,
      bracketPollIntervalMs: 0,
    }).createCaller({ runtime });

    await caller.connect({
      apiKeyId: "abcd-1234-wxyz",
      privateKeyPem: validPem,
      maxOrderDollars: 25,
    });

    const buyRes = await caller.placeOrder({
      ticker: "KXBTC15M-26NOV191715-15",
      action: "buy_yes",
      count: 5,
      limitPriceDollars: 0.6,
      exchangeIndex: 2,
      takeProfitOffsetCents: 15,
      stopLossOffsetCents: 10,
    });
    expect(buyRes.ok).toBe(true);
    if (buyRes.ok) {
      expect(buyRes.bracket).toMatchObject({
        ticker: "KXBTC15M-26NOV191715-15",
        side: "yes",
        takeProfitDollars: 0.75,
        stopLossDollars: 0.5,
      });
    }

    const updated = await caller.setBracket({
      ticker: "KXBTC15M-26NOV191715-15",
      side: "yes",
      takeProfitDollars: 0.82,
      stopLossDollars: 0.48,
      exchangeIndex: 2,
    });
    expect(updated).toMatchObject({
      ok: true,
      bracket: {
        takeProfitDollars: 0.82,
        stopLossDollars: 0.48,
      },
    });

    const snap = await caller.snapshot();
    expect(snap.bracket).toMatchObject({
      takeProfitDollars: 0.82,
      stopLossDollars: 0.48,
    });

    await caller.clearBracket({ ticker: "KXBTC15M-26NOV191715-15" });
    expect((await caller.snapshot()).bracket).toBeNull();

    await caller.setBracket({
      ticker: "KXBTC15M-26NOV191715-15",
      side: "yes",
      takeProfitDollars: 0.8,
      stopLossDollars: null,
    });
    hasPosition = false;
    expect((await caller.snapshot()).bracket).toBeNull();
  });
});
