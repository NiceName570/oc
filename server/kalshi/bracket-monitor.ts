// Purpose: Track an open Kalshi position's take-profit/stop-loss targets every second and auto-submit reduce-only exit orders.

import type { Runtime } from "../runtime";

import {
  createOrderV2,
  fetchActiveBtc15mMarket,
  fetchMarketPosition,
  type KalshiBtc15mMarket,
} from "./client";
import { readKalshiCredentials } from "./credentials";

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_STOP_LOSS_SWEEP_BUFFER_DOLLARS = 0.02;

/** Server-held automatic exit targets bound to the current active contract and side. */
export interface KalshiBracketRule {
  readonly ticker: string;
  readonly side: "yes" | "no";
  readonly takeProfitDollars: number | null;
  readonly stopLossDollars: number | null;
  readonly exchangeIndex?: number;
  readonly updatedAt: number;
}

/** Outcome of the latest bracket trigger evaluation or rollover cleanup. */
export interface KalshiBracketEvent {
  readonly ticker: string;
  readonly side: "yes" | "no";
  readonly trigger: "take_profit" | "stop_loss";
  readonly status: "filled" | "partial" | "missed" | "error" | "closed";
  readonly message: string;
  readonly timestampMs: number;
}

/** Configuration for the Kalshi TP/SL bracket monitor loop. */
export interface BracketMonitorOptions {
  readonly fetchImpl?: typeof fetch;
  readonly pollIntervalMs?: number;
  readonly stopLossSweepBufferDollars?: number;
  readonly onOrderExecuted?: () => void;
}

function clampContractPrice(value: number): number {
  return Math.min(0.99, Math.max(0.01, Number(value.toFixed(4))));
}

function formatCentsLabel(priceDollars: number): string {
  const cents = priceDollars * 100;
  return Math.abs(cents - Math.round(cents)) >= 0.05
    ? `${cents.toFixed(1)}¢`
    : `${Math.round(cents)}¢`;
}

/** Compute bounded TP/SL contract-price targets from an entry fill price and optional cent offsets. @example computeAutoBracketTargets({ entryPriceDollars: 0.6, takeProfitOffsetCents: 15, stopLossOffsetCents: 10 }) */
export function computeAutoBracketTargets(input: {
  readonly entryPriceDollars: number;
  readonly takeProfitOffsetCents?: number;
  readonly stopLossOffsetCents?: number;
}): {
  readonly takeProfitDollars: number | null;
  readonly stopLossDollars: number | null;
} {
  let takeProfitDollars: number | null = null;
  if (
    input.takeProfitOffsetCents !== undefined &&
    Number.isFinite(input.takeProfitOffsetCents) &&
    input.takeProfitOffsetCents > 0
  ) {
    const candidate = clampContractPrice(
      input.entryPriceDollars + input.takeProfitOffsetCents / 100,
    );
    if (candidate > input.entryPriceDollars + 0.0001) {
      takeProfitDollars = candidate;
    }
  }

  let stopLossDollars: number | null = null;
  if (
    input.stopLossOffsetCents !== undefined &&
    Number.isFinite(input.stopLossOffsetCents) &&
    input.stopLossOffsetCents > 0
  ) {
    const candidate = clampContractPrice(
      input.entryPriceDollars - input.stopLossOffsetCents / 100,
    );
    if (candidate < input.entryPriceDollars - 0.0001) {
      stopLossDollars = candidate;
    }
  }

  return { takeProfitDollars, stopLossDollars };
}

/** Validate user-supplied TP/SL trigger prices in dollars (`0.01..0.99`, SL below TP). @example validateBracketPrices({ takeProfitDollars: 0.75, stopLossDollars: 0.45 }) */
export function validateBracketPrices(input: {
  readonly takeProfitDollars: number | null;
  readonly stopLossDollars: number | null;
}): {
  readonly takeProfitDollars: number | null;
  readonly stopLossDollars: number | null;
} {
  const normalize = (value: number | null): number | null => {
    if (value === null) return null;
    if (!Number.isFinite(value) || value < 0.01 || value > 0.99) {
      throw new Error(
        "Take-profit and stop-loss prices must be between $0.01 and $0.99.",
      );
    }
    return Number(value.toFixed(4));
  };

  const takeProfitDollars = normalize(input.takeProfitDollars);
  const stopLossDollars = normalize(input.stopLossDollars);

  if (
    takeProfitDollars !== null &&
    stopLossDollars !== null &&
    stopLossDollars >= takeProfitDollars - 1e-9
  ) {
    throw new Error("Stop-loss price must be lower than take-profit price.");
  }

  return { takeProfitDollars, stopLossDollars };
}

/** Create an in-memory 1s TP/SL bracket watcher bound to one Kalshi router instance. @example const monitor = createBracketMonitor({ onOrderExecuted: invalidateCache }); */
export function createBracketMonitor(options?: BracketMonitorOptions) {
  const fetchImpl = options?.fetchImpl;
  const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const stopLossSweepBufferDollars =
    options?.stopLossSweepBufferDollars ??
    DEFAULT_STOP_LOSS_SWEEP_BUFFER_DOLLARS;

  let activeRule: KalshiBracketRule | null = null;
  let activeRuntime: Runtime | null = null;
  let lastEvent: KalshiBracketEvent | null = null;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  function stopTimer() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function clearRule(ticker?: string) {
    if (!activeRule) return;
    if (ticker !== undefined && activeRule.ticker !== ticker) return;
    activeRule = null;
    activeRuntime = null;
    stopTimer();
  }

  function clearAll() {
    activeRule = null;
    activeRuntime = null;
    lastEvent = null;
    stopTimer();
  }

  async function evaluateWithMarket(
    market: KalshiBtc15mMarket | null,
    runtime: Runtime,
  ): Promise<KalshiBracketEvent | null> {
    if (!activeRule || inFlight) return null;
    const rule = activeRule;

    if (market && market.ticker !== rule.ticker) {
      clearRule(rule.ticker);
      lastEvent = {
        ticker: rule.ticker,
        side: rule.side,
        trigger: rule.stopLossDollars !== null ? "stop_loss" : "take_profit",
        status: "closed",
        message: `Cleared ${rule.side.toUpperCase()} bracket after ${rule.ticker} window rolled over.`,
        timestampMs: Date.now(),
      };
      return lastEvent;
    }

    if (!market) return null;

    const exitBid =
      rule.side === "yes" ? market.yesBidDollars : market.noBidDollars;
    if (exitBid === null) return null;

    const hitTp =
      rule.takeProfitDollars !== null &&
      exitBid >= rule.takeProfitDollars - 1e-9;
    const hitSl =
      rule.stopLossDollars !== null && exitBid <= rule.stopLossDollars + 1e-9;
    if (!hitTp && !hitSl) return null;

    inFlight = true;
    try {
      const stored = await runtime.runPromise(readKalshiCredentials);
      if (!stored) {
        clearAll();
        return null;
      }

      const openPos = await fetchMarketPosition({
        credentials: stored,
        ticker: rule.ticker,
        fetchImpl,
      });

      if (!openPos || openPos.side !== rule.side || openPos.contracts <= 0) {
        clearRule(rule.ticker);
        return null;
      }

      const trigger: "take_profit" | "stop_loss" = hitTp
        ? "take_profit"
        : "stop_loss";
      const label = hitTp ? "Take Profit" : "Stop Loss";
      const tpLimit = rule.takeProfitDollars ?? exitBid;
      const slLimit = Math.max(
        0.01,
        Number((exitBid - stopLossSweepBufferDollars).toFixed(4)),
      );
      const limitPriceDollars = hitTp ? tpLimit : slLimit;

      const order = await createOrderV2({
        credentials: stored,
        ticker: rule.ticker,
        action: rule.side === "yes" ? "sell_yes" : "sell_no",
        count: openPos.contracts,
        limitPriceDollars,
        maxOrderDollars: stored.maxOrderDollars,
        exchangeIndex: rule.exchangeIndex ?? market.exchangeIndex,
        fetchImpl,
      });
      options?.onOrderExecuted?.();

      const filledNum = Number(order.fillCount);
      const remainingNum = Number(order.remainingCount);
      const fullyFilled =
        Number.isFinite(filledNum) &&
        filledNum > 0 &&
        (!Number.isFinite(remainingNum) || remainingNum <= 1e-6);
      const partial =
        Number.isFinite(filledNum) && filledNum > 0 && !fullyFilled;

      const contractFillPrice =
        order.averageFillPrice !== null
          ? rule.side === "no"
            ? 1 - order.averageFillPrice
            : order.averageFillPrice
          : null;

      if (fullyFilled) {
        clearRule(rule.ticker);
        lastEvent = {
          ticker: rule.ticker,
          side: rule.side,
          trigger,
          status: "filled",
          message: `${label} hit: sold ${order.fillCount} ${rule.side.toUpperCase()}${
            contractFillPrice !== null
              ? ` @ ${formatCentsLabel(contractFillPrice)}`
              : ""
          }.`,
          timestampMs: Date.now(),
        };
      } else if (partial) {
        lastEvent = {
          ticker: rule.ticker,
          side: rule.side,
          trigger,
          status: "partial",
          message: `${label} partially filled (${order.fillCount}/${openPos.contracts} ${rule.side.toUpperCase()} sold).`,
          timestampMs: Date.now(),
        };
      } else {
        lastEvent = {
          ticker: rule.ticker,
          side: rule.side,
          trigger,
          status: "missed",
          message: `${label} triggered at ${formatCentsLabel(exitBid)} but 0 filled; bracket still armed.`,
          timestampMs: Date.now(),
        };
      }

      return lastEvent;
    } catch (error) {
      const trigger: "take_profit" | "stop_loss" = hitTp
        ? "take_profit"
        : "stop_loss";
      lastEvent = {
        ticker: rule.ticker,
        side: rule.side,
        trigger,
        status: "error",
        message:
          error instanceof Error ? error.message : "Bracket execution failed.",
        timestampMs: Date.now(),
      };
      return lastEvent;
    } finally {
      inFlight = false;
    }
  }

  async function tick(): Promise<void> {
    if (!activeRule || !activeRuntime || inFlight) return;
    try {
      const market = await fetchActiveBtc15mMarket({ fetchImpl });
      if (activeRule && activeRuntime) {
        await evaluateWithMarket(market, activeRuntime);
      }
    } catch {
      /* Transient quote errors retry on the next 1s tick while keeping targets armed. */
    }
  }

  function ensureTimer() {
    if (timer !== null || pollIntervalMs <= 0) return;
    timer = setInterval(() => {
      void tick();
    }, pollIntervalMs);
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref?: () => void }).unref?.();
    }
  }

  function setRule(input: {
    readonly runtime: Runtime;
    readonly ticker: string;
    readonly side: "yes" | "no";
    readonly takeProfitDollars: number | null;
    readonly stopLossDollars: number | null;
    readonly exchangeIndex?: number;
  }): KalshiBracketRule | null {
    const validated = validateBracketPrices({
      takeProfitDollars: input.takeProfitDollars,
      stopLossDollars: input.stopLossDollars,
    });

    if (
      validated.takeProfitDollars === null &&
      validated.stopLossDollars === null
    ) {
      clearRule(input.ticker);
      return null;
    }

    activeRule = {
      ticker: input.ticker,
      side: input.side,
      takeProfitDollars: validated.takeProfitDollars,
      stopLossDollars: validated.stopLossDollars,
      exchangeIndex: input.exchangeIndex,
      updatedAt: Date.now(),
    };
    activeRuntime = input.runtime;
    ensureTimer();
    return activeRule;
  }

  function getRule(ticker?: string): KalshiBracketRule | null {
    if (!activeRule) return null;
    if (ticker !== undefined && activeRule.ticker !== ticker) return null;
    return activeRule;
  }

  function getLastEvent(): KalshiBracketEvent | null {
    return lastEvent;
  }

  return {
    setRule,
    clearRule,
    clearAll,
    getRule,
    getLastEvent,
    evaluateWithMarket,
  };
}
