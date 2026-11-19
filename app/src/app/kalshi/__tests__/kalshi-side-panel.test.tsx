/// <reference types="vitest/jsdom" />
// Purpose: Verify KalshiTrigger and KalshiSidePanel toggle cleanly in AppLayout without rendering outside their provider.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { SidebarProvider } from "@openchart/app/components/ui/sidebar";
import { TooltipProvider } from "@openchart/app/components/ui/tooltip";
import type { AppTransport } from "@openchart/app/lib/transport/transport";

import { KalshiPanelControlsProvider, KalshiTrigger } from "../kalshi-controls";
import { KalshiSidePanel } from "../kalshi-side-panel";

function SidePanelHarness({ transport }: { readonly transport: AppTransport }) {
  const [open, setOpen] = useState(false);

  return (
    <TooltipProvider>
      <SidebarProvider>
        <KalshiPanelControlsProvider
          value={{ open, toggle: () => setOpen((value) => !value) }}
        >
          <KalshiTrigger />
          <KalshiSidePanel
            transport={transport}
            open={open}
            onClose={() => setOpen(false)}
          />
        </KalshiPanelControlsProvider>
      </SidebarProvider>
    </TooltipProvider>
  );
}

describe("KalshiSidePanel & KalshiTrigger", () => {
  afterEach(() => {
    cleanup();
  });

  test("toggles the side panel via KalshiTrigger and closes via panel Close button", async () => {
    const user = userEvent.setup();
    const snapshotQuery = vi.fn().mockResolvedValue({
      connected: false,
      maskedApiKeyId: null,
      maxOrderDollars: 25,
      market: {
        ticker: "KXBTC15M-26NOV191445-45",
        eventTicker: "KXBTC15M-26NOV191445",
        title: "BTC 15m up or down",
        strikeDollars: 62787.1,
        openTime: "2026-11-19T19:30:00Z",
        closeTime: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        exchangeIndex: 2,
        yesBidDollars: 0.4,
        yesAskDollars: 0.42,
        noBidDollars: 0.58,
        noAskDollars: 0.6,
        lastPriceDollars: 0.41,
      },
      spotUsd: 62750,
      distanceDollars: -37.1,
      distancePercent: -0.0591,
      balance: null,
      position: null,
      marketError: null,
      accountError: null,
      updatedAt: Date.now(),
    });

    const transport = {
      url: "test",
      rpc: {
        kalshi: {
          snapshot: { query: snapshotQuery },
        },
      },
    } as unknown as AppTransport;

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { container } = render(
      <QueryClientProvider client={client}>
        <SidePanelHarness transport={transport} />
      </QueryClientProvider>,
    );

    const trigger = screen.getByRole("button", { name: "Toggle Kalshi 15m" });
    const aside = container.querySelector("#app-kalshi") as HTMLElement | null;
    expect(aside).toBeTruthy();
    expect(aside?.hidden).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(snapshotQuery).not.toHaveBeenCalled();

    await user.click(trigger);
    expect(aside?.hidden).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(
      await screen.findByRole("button", { name: /Buy YES \(42¢\)/ }),
    ).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Close Kalshi panel" }),
    );
    expect(aside?.hidden).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  test("renders nothing when KalshiTrigger is mounted outside KalshiPanelControlsProvider", () => {
    render(
      <TooltipProvider>
        <KalshiTrigger />
      </TooltipProvider>,
    );
    expect(
      screen.queryByRole("button", { name: "Toggle Kalshi 15m" }),
    ).toBeNull();
  });
});
