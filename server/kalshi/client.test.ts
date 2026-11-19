// Purpose: Verify Kalshi RSA-PSS/Ed25519 request signing, V2 single-book order mapping, cap checks, and live quote/position math.

import crypto from "node:crypto";
import { describe, expect, test } from "vitest";

import {
  assertBuyWithinCap,
  buildOrderV2Payload,
  computePositionPnl,
  createOrderV2,
  fetchActiveBtc15mMarket,
  fetchBtcSpotUsd,
  fetchMarketPosition,
  signKalshiRequest,
  validateKalshiPrivateKey,
} from "./client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("kalshi client signing & validation", () => {
  test("signs requests with RSA-PSS SHA-256 and strips query string from path", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const timestampMs = "1763576000000";

    const signature = signKalshiRequest({
      privateKeyPem: pem,
      timestampMs,
      method: "get",
      path: "/trade-api/v2/portfolio/positions?ticker=KXBTC15M-1&count_filter=position",
    });

    const expectedPayload = Buffer.from(
      `${timestampMs}GET/trade-api/v2/portfolio/positions`,
      "utf8",
    );
    const valid = crypto.verify(
      "sha256",
      expectedPayload,
      {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      },
      Buffer.from(signature, "base64"),
    );

    expect(valid).toBe(true);
    expect(validateKalshiPrivateKey(pem).algorithm).toBe("rsa-pss");
  });

  test("signs requests with Ed25519 keys", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const timestampMs = "1763576000001";

    const signature = signKalshiRequest({
      privateKeyPem: pem,
      timestampMs,
      method: "POST",
      path: "/trade-api/v2/portfolio/events/orders",
    });

    const valid = crypto.verify(
      null,
      Buffer.from(
        `${timestampMs}POST/trade-api/v2/portfolio/events/orders`,
        "utf8",
      ),
      publicKey,
      Buffer.from(signature, "base64"),
    );

    expect(valid).toBe(true);
    expect(validateKalshiPrivateKey(pem).algorithm).toBe("ed25519");
  });

  test("rejects unsupported ECDSA private key formats", () => {
    const { privateKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

    expect(() => validateKalshiPrivateKey(pem)).toThrow(
      /Unsupported Kalshi private key type/i,
    );
  });
});

describe("kalshi V2 single-book order mapping & P&L", () => {
  test("maps buy_yes, buy_no, sell_yes, and sell_no onto YES-leg V2 payloads", () => {
    expect(
      buildOrderV2Payload({
        ticker: "KXBTC15M-TEST",
        action: "buy_yes",
        count: 5,
        limitPriceDollars: 0.62,
        clientOrderId: "cid-1",
        exchangeIndex: 2,
      }),
    ).toEqual({
      ticker: "KXBTC15M-TEST",
      side: "bid",
      count: "5.00",
      price: "0.6200",
      time_in_force: "immediate_or_cancel",
      self_trade_prevention_type: "taker_at_cross",
      client_order_id: "cid-1",
      reduce_only: false,
      exchange_index: 2,
    });

    expect(
      buildOrderV2Payload({
        ticker: "KXBTC15M-TEST",
        action: "buy_no",
        count: 4,
        limitPriceDollars: 0.35,
        clientOrderId: "cid-2",
      }),
    ).toMatchObject({
      side: "ask",
      count: "4.00",
      price: "0.6500",
      reduce_only: false,
    });

    expect(
      buildOrderV2Payload({
        ticker: "KXBTC15M-TEST",
        action: "sell_yes",
        count: 5,
        limitPriceDollars: 0.78,
        clientOrderId: "cid-3",
      }),
    ).toMatchObject({
      side: "ask",
      count: "5.00",
      price: "0.7800",
      reduce_only: true,
    });

    expect(
      buildOrderV2Payload({
        ticker: "KXBTC15M-TEST",
        action: "sell_no",
        count: 3,
        limitPriceDollars: 0.18,
        clientOrderId: "cid-4",
      }),
    ).toMatchObject({
      side: "bid",
      count: "3.00",
      price: "0.8200",
      reduce_only: true,
    });
  });

  test("enforces maxOrderDollars only on buys while leaving closing sells unblocked", () => {
    expect(
      assertBuyWithinCap({
        action: "buy_yes",
        count: 10,
        limitPriceDollars: 0.5,
        maxOrderDollars: 5,
      }),
    ).toBe(5);

    expect(() =>
      assertBuyWithinCap({
        action: "buy_no",
        count: 11,
        limitPriceDollars: 0.5,
        maxOrderDollars: 5,
      }),
    ).toThrow(/exceeds max order cap/i);

    expect(
      assertBuyWithinCap({
        action: "sell_yes",
        count: 100,
        limitPriceDollars: 0.85,
        maxOrderDollars: 5,
      }),
    ).toBe(85);
  });

  test("computes instant liquidation P&L for YES and NO holdings", () => {
    expect(
      computePositionPnl({
        position: {
          ticker: "KXBTC15M-TEST",
          side: "yes",
          contracts: 10,
          costBasisDollars: 4.5,
          realizedPnlDollars: 0,
          feesPaidDollars: 0.1,
        },
        market: { yesBidDollars: 0.72, noBidDollars: 0.27 },
      }),
    ).toEqual({
      exitBidDollars: 0.72,
      exitProceedsDollars: 7.2,
      estimatedPnlDollars: 2.7,
    });

    expect(
      computePositionPnl({
        position: {
          ticker: "KXBTC15M-TEST",
          side: "no",
          contracts: 5,
          costBasisDollars: 3,
          realizedPnlDollars: 0,
          feesPaidDollars: 0.05,
        },
        market: { yesBidDollars: 0.54, noBidDollars: 0.45 },
      }),
    ).toEqual({
      exitBidDollars: 0.45,
      exitProceedsDollars: 2.25,
      estimatedPnlDollars: -0.75,
    });
  });
});

describe("kalshi client HTTP adapters", () => {
  test("selects the active KXBTC15M market with the soonest future close_time", async () => {
    const nowMs = Date.parse("2026-11-19T18:20:00Z");
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/markets?")) {
        return jsonResponse({
          markets: [
            {
              ticker: "KXBTC15M-EXPIRED",
              status: "active",
              close_time: "2026-11-19T18:15:00Z",
              floor_strike: 62500,
            },
            {
              ticker: "KXBTC15M-NEXT",
              status: "active",
              open_time: "2026-11-19T18:30:00Z",
              close_time: "2026-11-19T18:45:00Z",
              floor_strike: 62900,
            },
            {
              ticker: "KXBTC15M-CURRENT",
              event_ticker: "KXBTC15M-26NOV191330",
              title: "BTC 15m up or down",
              status: "active",
              open_time: "2026-11-19T18:15:00Z",
              close_time: "2026-11-19T18:30:00Z",
              floor_strike: 62653.28,
              exchange_index: 2,
              yes_bid_dollars: "0.8000",
              yes_ask_dollars: "0.8100",
              no_bid_dollars: "0.1900",
              no_ask_dollars: "0.2000",
              last_price_dollars: "0.8000",
            },
          ],
        });
      }
      if (url.includes("coinbase.com")) {
        return jsonResponse({ data: { amount: "62803.795" } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const market = await fetchActiveBtc15mMarket({ fetchImpl, nowMs });
    expect(market?.ticker).toBe("KXBTC15M-CURRENT");
    expect(market?.strikeDollars).toBe(62653.28);
    expect(market?.yesAskDollars).toBe(0.81);
    expect(market?.noAskDollars).toBe(0.2);

    const spot = await fetchBtcSpotUsd({ fetchImpl });
    expect(spot).toBe(62803.795);
  });

  test("posts orders to /trade-api/v2/portfolio/events/orders and parses open positions", async () => {
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    const credentials = {
      apiKeyId: "ak-live-1234",
      privateKeyPem: privateKey
        .export({ format: "pem", type: "pkcs8" })
        .toString(),
    };

    const requests: Array<{
      url: string;
      method: string;
      headers: Headers;
      body?: string;
    }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({
        url,
        method,
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : undefined,
      });

      if (url.includes("/portfolio/events/orders")) {
        return jsonResponse({
          order_id: "ord-1",
          client_order_id: "cid-fixed",
          fill_count: "2.00",
          remaining_count: "0.00",
          average_fill_price: "0.8100",
          average_fee_paid: "0.0200",
          ts_ms: 1763576005000,
        });
      }
      if (url.includes("/portfolio/positions")) {
        return jsonResponse({
          market_positions: [
            {
              ticker: "KXBTC15M-CURRENT",
              position_fp: "-3.00",
              market_exposure_dollars: "0.60",
              realized_pnl_dollars: "0.00",
              fees_paid_dollars: "0.03",
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await createOrderV2({
      credentials,
      ticker: "KXBTC15M-CURRENT",
      action: "buy_yes",
      count: 2,
      limitPriceDollars: 0.81,
      maxOrderDollars: 10,
      clientOrderId: "cid-fixed",
      exchangeIndex: 2,
      fetchImpl,
      nowMs: 1763576000000,
    });

    expect(result).toEqual({
      orderId: "ord-1",
      clientOrderId: "cid-fixed",
      fillCount: "2.00",
      remainingCount: "0.00",
      averageFillPrice: 0.81,
      averageFeePaid: 0.02,
      timestampMs: 1763576005000,
    });
    expect(requests[0]?.url).toBe(
      "https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders",
    );
    expect(requests[0]?.headers.get("KALSHI-ACCESS-KEY")).toBe("ak-live-1234");
    expect(requests[0]?.headers.get("KALSHI-ACCESS-TIMESTAMP")).toBe(
      "1763576000000",
    );
    expect(requests[0]?.headers.get("KALSHI-ACCESS-SIGNATURE")).toBeTruthy();

    const position = await fetchMarketPosition({
      credentials,
      ticker: "KXBTC15M-CURRENT",
      fetchImpl,
    });
    expect(position).toEqual({
      ticker: "KXBTC15M-CURRENT",
      side: "no",
      contracts: 3,
      costBasisDollars: 0.6,
      realizedPnlDollars: 0,
      feesPaidDollars: 0.03,
    });
  });
});
