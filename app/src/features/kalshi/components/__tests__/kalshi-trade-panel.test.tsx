/// <reference types="vitest/jsdom" />
// Purpose: Verify KalshiTradePanel 1-click buys/sells, Dollars/Shares sizing, strike readout, and auto/adjustable TP/SL brackets.

import { defineId } from "@openchart/identifier";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { AppTransport } from "@openchart/app/lib/transport/transport";
import { WidgetContext } from "@openchart/app/lib/widget/widget";

import { KalshiTradePanel } from "../kalshi-trade-panel";
import { kalshiWidget } from "../widget";

type SnapshotOutput = Awaited<
  ReturnType<AppTransport["rpc"]["kalshi"]["snapshot"]["query"]>
>;

function makeSnapshot(overrides: Partial<SnapshotOutput> = {}): SnapshotOutput {
  return {
    connected: false,
    maskedApiKeyId: null,
    maxOrderDollars: 25,
    market: {
      ticker: "KXBTC15M-26NOV191330-30",
      eventTicker: "KXBTC15M-26NOV191330",
      title: "BTC 15m up or down",
      strikeDollars: 62653.28,
      openTime: "2026-11-19T18:15:00Z",
      closeTime: new Date(Date.now() + 9 * 60 * 1000).toISOString(),
      exchangeIndex: 2,
      yesBidDollars: 0.72,
      yesAskDollars: 0.81,
      noBidDollars: 0.18,
      noAskDollars: 0.2,
      lastPriceDollars: 0.8,
    },
    spotUsd: 62803.8,
    distanceDollars: 150.52,
    distancePercent: 0.2402,
    balance: null,
    position: null,
    bracket: null,
    lastBracketEvent: null,
    marketError: null,
    accountError: null,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function renderPanel(rpcOverrides: {
  snapshot: () => Promise<SnapshotOutput>;
  connect?: (input: {
    apiKeyId: string;
    privateKeyPem: string;
    maxOrderDollars: number;
  }) => Promise<unknown>;
  placeOrder?: (input: {
    ticker: string;
    action: "buy_yes" | "buy_no" | "sell_yes" | "sell_no";
    count: number;
    limitPriceDollars: number;
    exchangeIndex?: number;
    takeProfitOffsetCents?: number;
    stopLossOffsetCents?: number;
  }) => Promise<unknown>;
  setBracket?: (input: {
    ticker: string;
    side: "yes" | "no";
    takeProfitDollars: number | null;
    stopLossDollars: number | null;
    exchangeIndex?: number;
  }) => Promise<unknown>;
  clearBracket?: (input: { ticker?: string }) => Promise<unknown>;
  setMaxOrderDollars?: (input: { maxOrderDollars: number }) => Promise<unknown>;
  disconnect?: () => Promise<unknown>;
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const placementId = defineId("wdg", "WidgetPlacement.ID").create();
  const dashboardId = defineId("dsh", "Dashboard.ID").create();

  const transport = {
    url: "test",
    rpc: {
      kalshi: {
        snapshot: { query: rpcOverrides.snapshot },
        connect: {
          mutate:
            rpcOverrides.connect ??
            vi.fn().mockResolvedValue({
              ok: true,
              maskedApiKeyId: "abcd...wxyz",
              maxOrderDollars: 25,
              algorithm: "rsa-pss",
              balance: {
                balanceDollars: 150,
                portfolioValueDollars: 150,
                updatedAt: Date.now(),
              },
            }),
        },
        placeOrder: {
          mutate:
            rpcOverrides.placeOrder ??
            vi.fn().mockResolvedValue({
              ok: true,
              order: {
                orderId: "ord-1",
                clientOrderId: "cid-1",
                fillCount: "1.00",
                remainingCount: "0.00",
                averageFillPrice: 0.81,
                averageFeePaid: 0.01,
                timestampMs: Date.now(),
              },
              bracket: null,
            }),
        },
        setBracket: {
          mutate:
            rpcOverrides.setBracket ??
            vi.fn().mockResolvedValue({ ok: true, bracket: null }),
        },
        clearBracket: {
          mutate:
            rpcOverrides.clearBracket ??
            vi.fn().mockResolvedValue({ ok: true }),
        },
        setMaxOrderDollars: {
          mutate:
            rpcOverrides.setMaxOrderDollars ??
            vi.fn().mockResolvedValue({
              ok: true,
              maskedApiKeyId: "abcd...wxyz",
              maxOrderDollars: 50,
            }),
        },
        disconnect: {
          mutate:
            rpcOverrides.disconnect ?? vi.fn().mockResolvedValue({ ok: true }),
        },
      },
    },
  } as unknown as AppTransport;

  const Content = kalshiWidget.Content;

  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <WidgetContext.Provider
          value={{
            placementId,
            dashboardId,
            transport,
            holdControls: () => () => {},
            placeBeside: vi.fn(),
          }}
        >
          <Content />
        </WidgetContext.Provider>
      </QueryClientProvider>,
    ),
  };
}

describe("KalshiTradePanel", () => {
  afterEach(() => {
    cleanup();
  });

  test("shows Buy YES/NO immediately when disconnected, prompts connect on click, and handles connect errors", async () => {
    const user = userEvent.setup();
    let current = makeSnapshot({
      market: {
        ticker: "KXBTC15M-26NOV191330-30",
        eventTicker: "KXBTC15M-26NOV191330",
        title: "BTC 15m up or down",
        strikeDollars: 62653.28,
        openTime: "2026-11-19T18:15:00Z",
        closeTime: new Date(Date.now() + 9 * 60 * 1000).toISOString(),
        exchangeIndex: 2,
        yesBidDollars: 0.018,
        yesAskDollars: 0.019,
        noBidDollars: 0.981,
        noAskDollars: 0.982,
        lastPriceDollars: 0.019,
      },
    });
    const placeOrderMock = vi.fn();

    const connectMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "Invalid Kalshi PEM key." })
      .mockImplementationOnce(async () => {
        current = makeSnapshot({
          connected: true,
          maskedApiKeyId: "abcd...wxyz",
          maxOrderDollars: 15,
          balance: {
            balanceDollars: 125.5,
            portfolioValueDollars: 125.5,
            updatedAt: Date.now(),
          },
        });
        return {
          ok: true,
          maskedApiKeyId: "abcd...wxyz",
          maxOrderDollars: 15,
          algorithm: "rsa-pss",
          balance: current.balance,
        };
      });

    renderPanel({
      snapshot: async () => current,
      connect: connectMock,
      placeOrder: placeOrderMock,
    });

    expect(await screen.findByText("$62,653.28")).toBeTruthy();
    const spotAbove = screen.getByText("$62,803.80");
    expect(spotAbove.className).toContain("text-emerald-600");
    expect(spotAbove.className).not.toContain("text-rose-600");
    expect(screen.getByText(/\+\$150\.52 \(\+0\.24%\)/)).toBeTruthy();
    expect(screen.getByText("Connect Live Kalshi Key")).toBeTruthy();

    const buyYesDisconnected = screen.getByRole("button", {
      name: /Buy YES \(1\.9¢\)/,
    });
    const buyNoDisconnected = screen.getByRole("button", {
      name: /Buy NO \(98\.2¢\)/,
    });
    expect(buyYesDisconnected.className).toContain("text-black");
    expect(buyYesDisconnected.className).not.toContain("text-white");
    expect(buyNoDisconnected.className).toContain("text-black");
    expect(buyNoDisconnected.className).not.toContain("text-white");

    await user.click(buyYesDisconnected);
    expect(
      screen.getByText(
        "Connect your Kalshi API key below to submit live orders.",
      ),
    ).toBeTruthy();
    expect(placeOrderMock).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("API Key ID"), "abcd-key-wxyz");
    await user.type(
      screen.getByLabelText(/Private Key/),
      "-----BEGIN PRIVATE KEY-----bad",
    );
    const capInput = screen.getByLabelText("Max Order Cap ($)");
    await user.clear(capInput);
    await user.type(capInput, "15");

    await user.click(screen.getByRole("button", { name: "Save & Connect" }));
    expect(await screen.findByText("Invalid Kalshi PEM key.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Save & Connect" }));
    expect(
      await screen.findByRole("button", { name: /Buy YES \(81¢\)/ }),
    ).toBeTruthy();
    expect(screen.getByText("$125.50")).toBeTruthy();
  });

  test("colors BTC spot red when below strike", async () => {
    renderPanel({
      snapshot: async () =>
        makeSnapshot({
          spotUsd: 62500,
          distanceDollars: -153.28,
          distancePercent: -0.2446,
        }),
    });

    const spotBelow = await screen.findByText("$62,500.00");
    expect(spotBelow.className).toContain("text-rose-600");
    expect(spotBelow.className).not.toContain("text-emerald-600");
  });

  test("works standalone via transport prop without WidgetContext and triggers onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const transport = {
      url: "test",
      rpc: {
        kalshi: {
          snapshot: { query: async () => makeSnapshot() },
        },
      },
    } as unknown as AppTransport;

    render(
      <QueryClientProvider client={client}>
        <KalshiTradePanel transport={transport} onClose={onClose} />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole("button", { name: /Buy YES \(81¢\)/ }),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Close Kalshi panel" }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("supports Dollars ($) and Shares sizing, cap guards, and 1-click Buy with Auto TP/SL offsets", async () => {
    const user = userEvent.setup();
    const placeOrderMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        order: {
          orderId: "ord-usd-1",
          clientOrderId: "cid-usd-1",
          fillCount: "12.00",
          remainingCount: "0.00",
          averageFillPrice: 0.81,
          averageFeePaid: 0.05,
          timestampMs: Date.now(),
        },
        bracket: null,
      })
      .mockResolvedValueOnce({
        ok: true,
        order: {
          orderId: "ord-sh-2",
          clientOrderId: "cid-sh-2",
          fillCount: "5.00",
          remainingCount: "0.00",
          averageFillPrice: 0.81,
          averageFeePaid: 0.03,
          timestampMs: Date.now(),
        },
        bracket: {
          ticker: "KXBTC15M-26NOV191330-30",
          side: "yes",
          takeProfitDollars: 0.91,
          stopLossDollars: 0.73,
          exchangeIndex: 2,
          updatedAt: Date.now(),
        },
      });

    renderPanel({
      snapshot: async () =>
        makeSnapshot({
          connected: true,
          maskedApiKeyId: "abcd...wxyz",
          maxOrderDollars: 10,
          balance: {
            balanceDollars: 80,
            portfolioValueDollars: 80,
            updatedAt: Date.now(),
          },
        }),
      placeOrder: placeOrderMock,
    });

    const buyYesBtn = await screen.findByRole("button", {
      name: /Buy YES \(81¢\)/,
    });

    await user.click(screen.getByRole("button", { name: "$25" }));
    expect(screen.getByText(/exceeds \$10\.00 cap/i)).toBeTruthy();
    expect((buyYesBtn as HTMLButtonElement).disabled).toBe(true);

    const amountInput = screen.getByLabelText("Amount ($)");
    await user.clear(amountInput);
    await user.type(amountInput, "0.5");
    expect(screen.getByText("Min $0.81")).toBeTruthy();
    expect((buyYesBtn as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: "$10" }));
    expect(screen.getByText("12 sh · $9.72")).toBeTruthy();
    expect((buyYesBtn as HTMLButtonElement).disabled).toBe(false);

    await user.click(buyYesBtn);
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    await waitFor(() => {
      expect(placeOrderMock).toHaveBeenNthCalledWith(1, {
        ticker: "KXBTC15M-26NOV191330-30",
        action: "buy_yes",
        count: 12,
        limitPriceDollars: 0.81,
        exchangeIndex: 2,
        takeProfitOffsetCents: undefined,
        stopLossOffsetCents: undefined,
      });
    });

    await user.click(screen.getByRole("button", { name: "Shares" }));
    await user.click(screen.getByRole("button", { name: "5" }));
    await user.type(screen.getByLabelText("Auto TP (+¢)"), "10");
    await user.type(screen.getByLabelText("Auto SL (-¢)"), "8");

    await user.click(screen.getByRole("button", { name: /Buy YES \(81¢\)/ }));
    await waitFor(() => {
      expect(placeOrderMock).toHaveBeenNthCalledWith(2, {
        ticker: "KXBTC15M-26NOV191330-30",
        action: "buy_yes",
        count: 5,
        limitPriceDollars: 0.81,
        exchangeIndex: 2,
        takeProfitOffsetCents: 10,
        stopLossOffsetCents: 8,
      });
    });
    expect(
      await screen.findByText(
        /Buy YES: 5\.00\/5 filled @ 81¢ \(ord-sh-2\) • TP 91¢ \/ SL 73¢ armed/,
      ),
    ).toBeTruthy();
  });

  test("submits 1-click Sell with no confirmation and edits/clears TP/SL brackets on Open Position", async () => {
    const user = userEvent.setup();
    let current = makeSnapshot({
      connected: true,
      maskedApiKeyId: "abcd...wxyz",
      maxOrderDollars: 25,
      balance: {
        balanceDollars: 75,
        portfolioValueDollars: 82.2,
        updatedAt: Date.now(),
      },
      position: {
        ticker: "KXBTC15M-26NOV191330-30",
        side: "yes",
        contracts: 10,
        costBasisDollars: 4.5,
        realizedPnlDollars: 0,
        feesPaidDollars: 0.1,
        exitBidDollars: 0.72,
        exitProceedsDollars: 7.2,
        estimatedPnlDollars: 2.7,
      },
      bracket: {
        ticker: "KXBTC15M-26NOV191330-30",
        side: "yes",
        takeProfitDollars: 0.82,
        stopLossDollars: 0.4,
        exchangeIndex: 2,
        updatedAt: 1000,
      },
      lastBracketEvent: {
        ticker: "KXBTC15M-OLD",
        side: "no",
        trigger: "take_profit",
        status: "filled",
        message: "Take Profit hit: sold 4.00 NO @ 65¢.",
        timestampMs: 999,
      },
    });

    const placeOrderMock = vi.fn().mockResolvedValue({
      ok: true,
      order: {
        orderId: "ord-sell-now",
        clientOrderId: "cid-sell-now",
        fillCount: "10.00",
        remainingCount: "0.00",
        averageFillPrice: 0.72,
        averageFeePaid: 0.04,
        timestampMs: Date.now(),
      },
      bracket: null,
    });

    const setBracketMock = vi.fn().mockImplementation(async (input) => {
      current = {
        ...current,
        bracket: {
          ticker: input.ticker,
          side: input.side,
          takeProfitDollars: input.takeProfitDollars,
          stopLossDollars: input.stopLossDollars,
          exchangeIndex: input.exchangeIndex,
          updatedAt: 2000,
        },
      };
      return { ok: true, bracket: current.bracket };
    });

    const clearBracketMock = vi.fn().mockImplementation(async () => {
      current = { ...current, bracket: null };
      return { ok: true };
    });

    renderPanel({
      snapshot: async () => current,
      placeOrder: placeOrderMock,
      setBracket: setBracketMock,
      clearBracket: clearBracketMock,
    });

    expect(
      await screen.findByText("Take Profit hit: sold 4.00 NO @ 65¢."),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Dismiss bracket alert" }),
    );
    expect(
      screen.queryByText("Take Profit hit: sold 4.00 NO @ 65¢."),
    ).toBeNull();

    const tpInput = screen.getByLabelText(
      "Take Profit (¢)",
    ) as HTMLInputElement;
    const slInput = screen.getByLabelText("Stop Loss (¢)") as HTMLInputElement;
    expect(tpInput.value).toBe("82");
    expect(slInput.value).toBe("40");

    await user.clear(tpInput);
    await user.type(tpInput, "85");
    await user.clear(slInput);
    await user.type(slInput, "45");
    await user.click(screen.getByRole("button", { name: "Save TP/SL" }));

    await waitFor(() => {
      expect(setBracketMock).toHaveBeenCalledWith({
        ticker: "KXBTC15M-26NOV191330-30",
        side: "yes",
        takeProfitDollars: 0.85,
        stopLossDollars: 0.45,
        exchangeIndex: 2,
      });
    });

    await user.click(await screen.findByRole("button", { name: "Clear" }));
    await waitFor(() => {
      expect(clearBracketMock).toHaveBeenCalledWith({
        ticker: "KXBTC15M-26NOV191330-30",
      });
    });

    await user.click(screen.getByRole("button", { name: "Sell 10 YES @ 72¢" }));
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    await waitFor(() => {
      expect(placeOrderMock).toHaveBeenCalledWith({
        ticker: "KXBTC15M-26NOV191330-30",
        action: "sell_yes",
        count: 10,
        limitPriceDollars: 0.72,
        exchangeIndex: 2,
        takeProfitOffsetCents: undefined,
        stopLossOffsetCents: undefined,
      });
    });
    expect(
      await screen.findByText(
        "Sell YES: 10.00/10 filled @ 72¢ (ord-sell-now).",
      ),
    ).toBeTruthy();
  });
});
