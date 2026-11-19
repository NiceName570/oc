/// <reference types="vitest/jsdom" />
// Purpose: Verify KalshiTradePanel market strike/distance display, credential connect flow, cap guards, confirm-gated buys, and live exit P&L sells.

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
  }) => Promise<unknown>;
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
            }),
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

  test("shows Buy YES/NO immediately when disconnected, prompts connect on click, and handles connect errors before connecting", async () => {
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
    expect(screen.getByText("$62,803.80")).toBeTruthy();
    expect(screen.getByText(/\+\$150\.52 \(\+0\.24%\)/)).toBeTruthy();
    expect(screen.getByText("Connect Live Kalshi Key")).toBeTruthy();

    const buyYesDisconnected = screen.getByRole("button", {
      name: /Buy YES \(1\.9¢\)/,
    });
    expect(
      screen.getByRole("button", { name: /Buy NO \(98\.2¢\)/ }),
    ).toBeTruthy();

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

  test("blocks over-cap buys and requires inline confirmation before submitting Buy YES", async () => {
    const user = userEvent.setup();
    const placeOrderMock = vi.fn().mockResolvedValue({
      ok: true,
      order: {
        orderId: "ord-yes-1",
        clientOrderId: "cid-yes-1",
        fillCount: "5.00",
        remainingCount: "0.00",
        averageFillPrice: 0.81,
        averageFeePaid: 0.03,
        timestampMs: Date.now(),
      },
    });

    renderPanel({
      snapshot: async () =>
        makeSnapshot({
          connected: true,
          maskedApiKeyId: "abcd...wxyz",
          maxOrderDollars: 5,
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

    await user.click(screen.getByRole("button", { name: "10" }));
    expect(
      screen.getByText(/YES order \(\$8\.10\) exceeds \$5\.00 cap/i),
    ).toBeTruthy();
    expect((buyYesBtn as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: "5" }));
    expect((buyYesBtn as HTMLButtonElement).disabled).toBe(false);

    await user.click(buyYesBtn);
    expect(
      screen.getByText(/Confirm Buy YES 5 @ 81¢ \(\$4\.05\)/),
    ).toBeTruthy();
    expect(placeOrderMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => {
      expect(placeOrderMock).toHaveBeenCalledWith({
        ticker: "KXBTC15M-26NOV191330-30",
        action: "buy_yes",
        count: 5,
        limitPriceDollars: 0.81,
        exchangeIndex: 2,
      });
    });
  });

  test("shows held position live P&L, gates Sell behind confirmation, and clears pending confirmation on ticker rollover", async () => {
    const user = userEvent.setup();
    let current = makeSnapshot({
      connected: true,
      maskedApiKeyId: "abcd...wxyz",
      maxOrderDollars: 10,
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
    });

    const placeOrderMock = vi.fn().mockResolvedValue({
      ok: true,
      order: {
        orderId: "ord-sell-1",
        clientOrderId: "cid-sell-1",
        fillCount: "10.00",
        remainingCount: "0.00",
        averageFillPrice: 0.72,
        averageFeePaid: 0.04,
        timestampMs: Date.now(),
      },
    });

    renderPanel({
      snapshot: async () => current,
      placeOrder: placeOrderMock,
    });

    expect(await screen.findByText("YES × 10")).toBeTruthy();
    expect(screen.getByText("+$2.70")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Sell 10 YES @ 72¢" }));
    expect(
      screen.getByText(/Confirm Sell YES 10 @ 72¢ \(\$7\.20\)/),
    ).toBeTruthy();

    current = makeSnapshot({
      connected: true,
      maskedApiKeyId: "abcd...wxyz",
      maxOrderDollars: 10,
      market: {
        ticker: "KXBTC15M-26NOV191345-45",
        eventTicker: "KXBTC15M-26NOV191345",
        title: "BTC 15m up or down",
        strikeDollars: 62810,
        openTime: "2026-11-19T18:30:00Z",
        closeTime: new Date(Date.now() + 14 * 60 * 1000).toISOString(),
        exchangeIndex: 2,
        yesBidDollars: 0.5,
        yesAskDollars: 0.52,
        noBidDollars: 0.48,
        noAskDollars: 0.5,
        lastPriceDollars: 0.51,
      },
    });

    await user.click(
      screen.getByRole("button", { name: "Refresh Kalshi quote" }),
    );
    await waitFor(() => {
      expect(screen.queryByText(/Confirm Sell YES 10/)).toBeNull();
    });
    expect(placeOrderMock).not.toHaveBeenCalled();

    current = {
      ...current,
      position: {
        ticker: "KXBTC15M-26NOV191345-45",
        side: "no",
        contracts: 4,
        costBasisDollars: 1.6,
        realizedPnlDollars: 0,
        feesPaidDollars: 0.04,
        exitBidDollars: 0.48,
        exitProceedsDollars: 1.92,
        estimatedPnlDollars: 0.32,
      },
    };
    await user.click(
      screen.getByRole("button", { name: "Refresh Kalshi quote" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Sell 4 NO @ 48¢" }),
    );
    expect(
      screen.getByText(/Confirm Sell NO 4 @ 48¢ \(\$1\.92\)/),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => {
      expect(placeOrderMock).toHaveBeenCalledWith({
        ticker: "KXBTC15M-26NOV191345-45",
        action: "sell_no",
        count: 4,
        limitPriceDollars: 0.48,
        exchangeIndex: 2,
      });
    });
  });
});
