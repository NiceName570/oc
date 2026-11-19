// Purpose: Compact live trading widget and side panel for Kalshi 15-minute BTC contracts.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Settings, ShieldCheck, Unplug, XIcon } from "lucide-react";
import { useContext, useEffect, useState } from "react";

import { Badge } from "@openchart/app/components/ui/badge";
import { Button } from "@openchart/app/components/ui/button";
import { Input } from "@openchart/app/components/ui/input";
import { Textarea } from "@openchart/app/components/ui/textarea";
import type { AppTransport } from "@openchart/app/lib/transport/transport";
import { WidgetContext } from "@openchart/app/lib/widget/widget";
import { cn } from "@openchart/app/utils/cn";

type KalshiSnapshot = Awaited<
  ReturnType<AppTransport["rpc"]["kalshi"]["snapshot"]["query"]>
>;
type KalshiOrderAction = "buy_yes" | "buy_no" | "sell_yes" | "sell_no";
type OrderSizeMode = "dollars" | "shares";

interface OrderBanner {
  readonly tone: "success" | "error";
  readonly text: string;
}

const SNAPSHOT_QUERY_KEY = ["kalshi", "snapshot"] as const;
const DOLLAR_PRESETS = [5, 10, 25] as const;
const SHARE_PRESETS = [1, 5, 10] as const;

function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatSignedUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  const abs = formatUsd(Math.abs(value));
  if (value > 0) return `+${abs}`;
  if (value < 0) return `-${abs}`;
  return abs;
}

function formatCents(priceDollars: number | null | undefined): string {
  if (
    priceDollars === null ||
    priceDollars === undefined ||
    !Number.isFinite(priceDollars)
  ) {
    return "—";
  }
  const cents = priceDollars * 100;
  return Math.abs(cents - Math.round(cents)) >= 0.05
    ? `${cents.toFixed(1)}¢`
    : `${Math.round(cents)}¢`;
}

function formatCountdown(
  closeTimeIso: string | undefined,
  nowMs: number,
): {
  readonly label: string;
  readonly urgent: boolean;
} {
  if (!closeTimeIso) {
    return { label: "--:--", urgent: false };
  }
  const closeMs = Date.parse(closeTimeIso);
  if (!Number.isFinite(closeMs)) {
    return { label: "--:--", urgent: false };
  }
  const remainingSec = Math.max(0, Math.floor((closeMs - nowMs) / 1000));
  const mins = Math.floor(remainingSec / 60);
  const secs = remainingSec % 60;
  return {
    label: `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`,
    urgent: remainingSec <= 120,
  };
}

/** Compact live trading panel for Kalshi `KXBTC15M` contracts with 1-click buys/sells, Dollars/Shares sizing, live strike distance, and auto TP/SL brackets. @example <KalshiTradePanel transport={transport} onClose={() => setOpen(false)} /> */
export function KalshiTradePanel({
  transport: propTransport,
  visible = true,
  onClose,
}: {
  readonly transport?: AppTransport;
  readonly visible?: boolean;
  readonly onClose?: () => void;
} = {}) {
  const widget = useContext(WidgetContext);
  const transport = propTransport ?? widget?.transport;
  if (!transport) {
    throw new Error(
      "KalshiTradePanel requires a transport prop or WidgetContext",
    );
  }

  const queryClient = useQueryClient();

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [replacingKey, setReplacingKey] = useState(false);

  const [apiKeyIdDraft, setApiKeyIdDraft] = useState("");
  const [privateKeyDraft, setPrivateKeyDraft] = useState("");
  const [capDraft, setCapDraft] = useState("25");
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const [sizeMode, setSizeMode] = useState<OrderSizeMode>("dollars");
  const [amountRaw, setAmountRaw] = useState("5");
  const [autoTpOffsetRaw, setAutoTpOffsetRaw] = useState("");
  const [autoSlOffsetRaw, setAutoSlOffsetRaw] = useState("");

  const [tpCentsDraft, setTpCentsDraft] = useState("");
  const [slCentsDraft, setSlCentsDraft] = useState("");
  const [bracketError, setBracketError] = useState<string | null>(null);
  const [dismissedEventTs, setDismissedEventTs] = useState<number | null>(null);

  const [orderBanner, setOrderBanner] = useState<OrderBanner | null>(null);

  useEffect(() => {
    if (!visible) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [visible]);

  const snapshotQuery = useQuery<KalshiSnapshot>({
    queryKey: SNAPSHOT_QUERY_KEY,
    queryFn: () => transport.rpc.kalshi.snapshot.query(),
    enabled: visible,
    refetchInterval: 1000,
    retry: false,
  });

  const snapshot = snapshotQuery.data;
  const connected = snapshot?.connected ?? false;
  const snapshotMaxOrderDollars = snapshot?.maxOrderDollars;
  const maxOrderDollars = snapshotMaxOrderDollars ?? 25;
  const market = snapshot?.market ?? null;
  const position = snapshot?.position ?? null;
  const bracket = snapshot?.bracket ?? null;
  const lastBracketEvent = snapshot?.lastBracketEvent ?? null;

  useEffect(() => {
    if (snapshotMaxOrderDollars !== undefined) {
      setCapDraft(String(snapshotMaxOrderDollars));
    }
  }, [snapshotMaxOrderDollars]);

  const bracketTicker = bracket?.ticker;
  const bracketSide = bracket?.side;
  const bracketTpDollars = bracket?.takeProfitDollars ?? null;
  const bracketSlDollars = bracket?.stopLossDollars ?? null;
  const bracketUpdatedAt = bracket?.updatedAt;
  const posTicker = position?.ticker;
  const posSide = position?.side;

  useEffect(() => {
    setBracketError(null);
    if (bracketTicker !== undefined) {
      setTpCentsDraft(
        bracketTpDollars !== null
          ? String(Math.round(bracketTpDollars * 100))
          : "",
      );
      setSlCentsDraft(
        bracketSlDollars !== null
          ? String(Math.round(bracketSlDollars * 100))
          : "",
      );
    } else {
      setTpCentsDraft("");
      setSlCentsDraft("");
    }
  }, [
    bracketTicker,
    bracketSide,
    bracketTpDollars,
    bracketSlDollars,
    bracketUpdatedAt,
    posTicker,
    posSide,
  ]);

  const connectMutation = useMutation({
    mutationFn: (input: {
      apiKeyId: string;
      privateKeyPem: string;
      maxOrderDollars: number;
    }) => transport.rpc.kalshi.connect.mutate(input),
    onSuccess: async (result) => {
      if (!result.ok) {
        setSettingsError(result.error);
        return;
      }
      setSettingsError(null);
      setPrivateKeyDraft("");
      setApiKeyIdDraft("");
      setSettingsOpen(false);
      setReplacingKey(false);
      setOrderBanner({
        tone: "success",
        text: `Connected (${result.maskedApiKeyId}) • Cap $${result.maxOrderDollars.toFixed(2)}`,
      });
      await queryClient.invalidateQueries({ queryKey: SNAPSHOT_QUERY_KEY });
    },
    onError: (err) => {
      setSettingsError(err instanceof Error ? err.message : String(err));
    },
  });

  const updateCapMutation = useMutation({
    mutationFn: (maxOrderDollars: number) =>
      transport.rpc.kalshi.setMaxOrderDollars.mutate({ maxOrderDollars }),
    onSuccess: async (result) => {
      if (!result.ok) {
        setSettingsError(result.error);
        return;
      }
      setSettingsError(null);
      setOrderBanner({
        tone: "success",
        text: `Max order cap updated to $${result.maxOrderDollars.toFixed(2)}.`,
      });
      await queryClient.invalidateQueries({ queryKey: SNAPSHOT_QUERY_KEY });
    },
    onError: (err) => {
      setSettingsError(err instanceof Error ? err.message : String(err));
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: () => transport.rpc.kalshi.disconnect.mutate(),
    onSuccess: async () => {
      setSettingsError(null);
      setBracketError(null);
      setReplacingKey(false);
      setSettingsOpen(false);
      setOrderBanner(null);
      await queryClient.invalidateQueries({ queryKey: SNAPSHOT_QUERY_KEY });
    },
    onError: (err) => {
      setSettingsError(err instanceof Error ? err.message : String(err));
    },
  });

  const placeOrderMutation = useMutation({
    mutationFn: (input: {
      readonly ticker: string;
      readonly action: KalshiOrderAction;
      readonly count: number;
      readonly limitPriceDollars: number;
      readonly exchangeIndex?: number;
      readonly sideLabel: string;
      readonly takeProfitOffsetCents?: number;
      readonly stopLossOffsetCents?: number;
    }) =>
      transport.rpc.kalshi.placeOrder.mutate({
        ticker: input.ticker,
        action: input.action,
        count: input.count,
        limitPriceDollars: input.limitPriceDollars,
        exchangeIndex: input.exchangeIndex,
        takeProfitOffsetCents: input.takeProfitOffsetCents,
        stopLossOffsetCents: input.stopLossOffsetCents,
      }),
    onSuccess: async (result, order) => {
      if (!result.ok) {
        setOrderBanner({ tone: "error", text: result.error });
        return;
      }
      const filledNum = Number(result.order.fillCount);
      if (Number.isFinite(filledNum) && filledNum <= 0) {
        setOrderBanner({
          tone: "error",
          text: `${order.sideLabel}: 0 filled — live price moved past your ${formatCents(order.limitPriceDollars)} limit.`,
        });
      } else {
        const effectiveFillPrice =
          result.order.averageFillPrice !== null
            ? order.action === "buy_no" || order.action === "sell_no"
              ? 1 - result.order.averageFillPrice
              : result.order.averageFillPrice
            : null;
        const bracketParts: string[] = [];
        if (result.bracket?.takeProfitDollars != null) {
          bracketParts.push(
            `TP ${formatCents(result.bracket.takeProfitDollars)}`,
          );
        }
        if (result.bracket?.stopLossDollars != null) {
          bracketParts.push(
            `SL ${formatCents(result.bracket.stopLossDollars)}`,
          );
        }
        const bracketSuffix =
          bracketParts.length > 0 ? ` • ${bracketParts.join(" / ")} armed` : "";
        setOrderBanner({
          tone: "success",
          text: `${order.sideLabel}: ${result.order.fillCount}/${order.count} filled${
            effectiveFillPrice !== null
              ? ` @ ${formatCents(effectiveFillPrice)}`
              : ""
          } (${result.order.orderId || "submitted"})${bracketSuffix}.`,
        });
      }
      await queryClient.invalidateQueries({ queryKey: SNAPSHOT_QUERY_KEY });
    },
    onError: (err) => {
      setOrderBanner({
        tone: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const setBracketMutation = useMutation({
    mutationFn: (input: {
      readonly ticker: string;
      readonly side: "yes" | "no";
      readonly takeProfitDollars: number | null;
      readonly stopLossDollars: number | null;
      readonly exchangeIndex?: number;
    }) => transport.rpc.kalshi.setBracket.mutate(input),
    onSuccess: async (result) => {
      if (!result.ok) {
        setBracketError(result.error);
        return;
      }
      setBracketError(null);
      await queryClient.invalidateQueries({ queryKey: SNAPSHOT_QUERY_KEY });
    },
    onError: (err) => {
      setBracketError(err instanceof Error ? err.message : String(err));
    },
  });

  const clearBracketMutation = useMutation({
    mutationFn: (ticker?: string) =>
      transport.rpc.kalshi.clearBracket.mutate({ ticker }),
    onSuccess: async () => {
      setBracketError(null);
      await queryClient.invalidateQueries({ queryKey: SNAPSHOT_QUERY_KEY });
    },
    onError: (err) => {
      setBracketError(err instanceof Error ? err.message : String(err));
    },
  });

  const countdown = formatCountdown(market?.closeTime, nowMs);
  const parsedAmount = Number(amountRaw);
  const validAmount =
    Number.isFinite(parsedAmount) && parsedAmount > 0 ? parsedAmount : 0;

  const yesAsk = market?.yesAskDollars ?? null;
  const noAsk = market?.noAskDollars ?? null;

  const yesContracts =
    sizeMode === "dollars"
      ? yesAsk !== null && yesAsk > 0 && validAmount > 0
        ? Math.floor((validAmount + 1e-9) / yesAsk)
        : 0
      : validAmount;

  const noContracts =
    sizeMode === "dollars"
      ? noAsk !== null && noAsk > 0 && validAmount > 0
        ? Math.floor((validAmount + 1e-9) / noAsk)
        : 0
      : validAmount;

  const yesBuyCost =
    yesAsk !== null && yesContracts > 0
      ? Number((yesContracts * yesAsk).toFixed(2))
      : null;
  const noBuyCost =
    noAsk !== null && noContracts > 0
      ? Number((noContracts * noAsk).toFixed(2))
      : null;

  const yesOverCap =
    sizeMode === "dollars"
      ? validAmount > maxOrderDollars + 1e-9 ||
        (yesBuyCost !== null && yesBuyCost > maxOrderDollars + 1e-9)
      : yesBuyCost !== null && yesBuyCost > maxOrderDollars + 1e-9;

  const noOverCap =
    sizeMode === "dollars"
      ? validAmount > maxOrderDollars + 1e-9 ||
        (noBuyCost !== null && noBuyCost > maxOrderDollars + 1e-9)
      : noBuyCost !== null && noBuyCost > maxOrderDollars + 1e-9;

  const quoteAgeSec = snapshot
    ? Math.max(0, Math.floor((nowMs - snapshot.updatedAt) / 1000))
    : null;

  const showSetupCard =
    !snapshotQuery.isPending && (!connected || settingsOpen);

  const presets = sizeMode === "dollars" ? DOLLAR_PRESETS : SHARE_PRESETS;

  const submitOrder = (
    action: KalshiOrderAction,
    priceDollars: number | null,
    count: number,
    sideLabel: string,
  ) => {
    if (!connected) {
      setSettingsOpen(true);
      setOrderBanner({
        tone: "error",
        text: "Connect your Kalshi API key below to submit live orders.",
      });
      return;
    }
    if (!market || priceDollars === null || !(count > 0)) return;
    const estimatedDollars = Number((count * priceDollars).toFixed(2));
    if (
      (action === "buy_yes" || action === "buy_no") &&
      estimatedDollars > maxOrderDollars + 1e-9
    ) {
      setOrderBanner({
        tone: "error",
        text: `Order cost ${formatUsd(estimatedDollars)} exceeds max order cap of ${formatUsd(maxOrderDollars)}.`,
      });
      return;
    }

    const tpOffsetNum = Number(autoTpOffsetRaw);
    const slOffsetNum = Number(autoSlOffsetRaw);
    const takeProfitOffsetCents =
      (action === "buy_yes" || action === "buy_no") &&
      autoTpOffsetRaw.trim() !== "" &&
      Number.isFinite(tpOffsetNum) &&
      tpOffsetNum > 0
        ? tpOffsetNum
        : undefined;
    const stopLossOffsetCents =
      (action === "buy_yes" || action === "buy_no") &&
      autoSlOffsetRaw.trim() !== "" &&
      Number.isFinite(slOffsetNum) &&
      slOffsetNum > 0
        ? slOffsetNum
        : undefined;

    setOrderBanner(null);
    placeOrderMutation.mutate({
      ticker: market.ticker,
      action,
      count,
      limitPriceDollars: priceDollars,
      exchangeIndex: market.exchangeIndex,
      sideLabel,
      takeProfitOffsetCents,
      stopLossOffsetCents,
    });
  };

  const handleSaveBracketSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!position) return;

    const parseOptionalCents = (raw: string, label: string): number | null => {
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      const num = Number(trimmed);
      if (!Number.isFinite(num) || num < 1 || num > 99) {
        throw new Error(`${label} must be between 1¢ and 99¢.`);
      }
      return Number((num / 100).toFixed(4));
    };

    try {
      const takeProfitDollars = parseOptionalCents(tpCentsDraft, "Take profit");
      const stopLossDollars = parseOptionalCents(slCentsDraft, "Stop loss");
      if (
        takeProfitDollars !== null &&
        stopLossDollars !== null &&
        stopLossDollars >= takeProfitDollars
      ) {
        setBracketError("Stop loss must be lower than take profit.");
        return;
      }
      setBracketError(null);
      setBracketMutation.mutate({
        ticker: position.ticker,
        side: position.side,
        takeProfitDollars,
        stopLossDollars,
        exchangeIndex: market?.exchangeIndex,
      });
    } catch (error) {
      setBracketError(
        error instanceof Error ? error.message : "Invalid TP/SL values.",
      );
    }
  };

  const handleConnectSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const parsedCap = Number(capDraft);
    if (!Number.isFinite(parsedCap) || parsedCap <= 0) {
      setSettingsError("Max order cap must be greater than $0.");
      return;
    }
    setSettingsError(null);
    connectMutation.mutate({
      apiKeyId: apiKeyIdDraft,
      privateKeyPem: privateKeyDraft,
      maxOrderDollars: parsedCap,
    });
  };

  const handleUpdateCapSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const parsedCap = Number(capDraft);
    if (!Number.isFinite(parsedCap) || parsedCap <= 0) {
      setSettingsError("Max order cap must be greater than $0.");
      return;
    }
    setSettingsError(null);
    updateCapMutation.mutate(parsedCap);
  };

  const parsedTpDraftNum = Number(tpCentsDraft);
  const parsedSlDraftNum = Number(slCentsDraft);
  const projectedTpPnl =
    position &&
    tpCentsDraft.trim() !== "" &&
    Number.isFinite(parsedTpDraftNum) &&
    parsedTpDraftNum >= 1 &&
    parsedTpDraftNum <= 99
      ? Number(
          (
            position.contracts * (parsedTpDraftNum / 100) -
            position.costBasisDollars
          ).toFixed(2),
        )
      : null;
  const projectedSlPnl =
    position &&
    slCentsDraft.trim() !== "" &&
    Number.isFinite(parsedSlDraftNum) &&
    parsedSlDraftNum >= 1 &&
    parsedSlDraftNum <= 99
      ? Number(
          (
            position.contracts * (parsedSlDraftNum / 100) -
            position.costBasisDollars
          ).toFixed(2),
        )
      : null;

  const isBuyingYes =
    placeOrderMutation.isPending &&
    placeOrderMutation.variables?.action === "buy_yes";
  const isBuyingNo =
    placeOrderMutation.isPending &&
    placeOrderMutation.variables?.action === "buy_no";
  const isSelling =
    placeOrderMutation.isPending &&
    (placeOrderMutation.variables?.action === "sell_yes" ||
      placeOrderMutation.variables?.action === "sell_no");

  const visibleBracketEvent =
    lastBracketEvent && lastBracketEvent.timestampMs !== dismissedEventTs
      ? lastBracketEvent
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden text-xs">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold tracking-tight text-foreground">
              Kalshi BTC 15m
            </span>
            <Badge
              variant={countdown.urgent ? "destructive" : "secondary"}
              className="font-mono text-[11px] tabular-nums"
            >
              {countdown.label}
            </Badge>
          </div>
          <p className="truncate font-mono text-[10px] text-muted-foreground">
            {market ? market.ticker : "Waiting for active KXBTC15M window"}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {connected ? (
            <Badge
              variant="outline"
              className="gap-1 border-emerald-500/40 text-[11px] text-emerald-600 dark:text-emerald-400"
            >
              <span
                className="size-1.5 rounded-full bg-emerald-500"
                aria-hidden="true"
              />
              {snapshot?.balance
                ? formatUsd(snapshot.balance.balanceDollars)
                : "Live"}
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="text-[11px] text-muted-foreground"
            >
              Offline
            </Badge>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Refresh Kalshi quote"
            onClick={() => void snapshotQuery.refetch()}
          >
            <RefreshCw
              className={cn(
                "size-3.5",
                snapshotQuery.isFetching && "animate-spin",
              )}
            />
          </Button>
          {connected && (
            <Button
              type="button"
              variant={settingsOpen ? "secondary" : "ghost"}
              size="icon"
              className="size-7"
              aria-label="Kalshi settings"
              aria-pressed={settingsOpen}
              onClick={() => {
                setSettingsError(null);
                setReplacingKey(false);
                setSettingsOpen((open) => !open);
              }}
            >
              <Settings className="size-3.5" />
            </Button>
          )}
          {onClose && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Close Kalshi panel"
              onClick={onClose}
            >
              <XIcon className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3">
        <div className="rounded-md border bg-card/60 p-2.5">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Strike
              </div>
              <div className="font-mono text-sm font-semibold tabular-nums">
                {formatUsd(market?.strikeDollars)}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                BTC Spot
              </div>
              <div className="font-mono text-sm font-semibold tabular-nums">
                {formatUsd(snapshot?.spotUsd)}
              </div>
            </div>
          </div>

          <div className="mt-2 flex items-center justify-between border-t pt-1.5">
            <span className="text-[11px] text-muted-foreground">vs Strike</span>
            <span
              className={cn(
                "font-mono text-xs font-semibold tabular-nums",
                snapshot?.distanceDollars != null &&
                  snapshot.distanceDollars > 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : snapshot?.distanceDollars != null &&
                      snapshot.distanceDollars < 0
                    ? "text-rose-600 dark:text-rose-400"
                    : "text-muted-foreground",
              )}
            >
              {snapshot?.distanceDollars != null ? (
                <>
                  {formatSignedUsd(snapshot.distanceDollars)}
                  {snapshot.distancePercent != null
                    ? ` (${snapshot.distancePercent >= 0 ? "+" : ""}${snapshot.distancePercent.toFixed(2)}%)`
                    : ""}
                </>
              ) : (
                "—"
              )}
            </span>
          </div>

          {quoteAgeSec !== null && (
            <div className="mt-1 flex items-center justify-between text-[10px]">
              <span className="text-muted-foreground">Quote feed (1s)</span>
              <span
                className={cn(
                  "font-mono tabular-nums",
                  quoteAgeSec >= 5
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-muted-foreground",
                )}
              >
                {quoteAgeSec === 0
                  ? "Live · just now"
                  : `Live · ${quoteAgeSec}s ago`}
              </span>
            </div>
          )}
        </div>

        {snapshot?.marketError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
            {snapshot.marketError}
          </div>
        )}

        {snapshot?.accountError && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
            {snapshot.accountError}
          </div>
        )}

        <div className="flex flex-col gap-2 rounded-md border bg-card/40 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <div
              role="group"
              aria-label="Order sizing unit"
              className="inline-flex rounded border bg-background p-0.5 text-[10px]"
            >
              <button
                type="button"
                aria-pressed={sizeMode === "dollars"}
                onClick={() => setSizeMode("dollars")}
                className={cn(
                  "rounded-sm px-1.5 py-0.5 font-medium transition-colors",
                  sizeMode === "dollars"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                Dollars ($)
              </button>
              <button
                type="button"
                aria-pressed={sizeMode === "shares"}
                onClick={() => setSizeMode("shares")}
                className={cn(
                  "rounded-sm px-1.5 py-0.5 font-medium transition-colors",
                  sizeMode === "shares"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                Shares
              </button>
            </div>
            <div className="flex items-center gap-1">
              {presets.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setAmountRaw(String(preset))}
                  className={cn(
                    "rounded border px-1.5 py-0.5 font-mono text-[10px] transition-colors",
                    parsedAmount === preset
                      ? "border-primary bg-primary/15 text-foreground"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {sizeMode === "dollars" ? `$${preset}` : preset}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor="kalshi-order-amount"
              className="text-[11px] text-muted-foreground"
            >
              {sizeMode === "dollars" ? "Risk Amount ($)" : "Shares"}
            </label>
            <span className="font-mono text-[10px] text-muted-foreground">
              Cap {formatUsd(maxOrderDollars)}
            </span>
          </div>

          <Input
            id="kalshi-order-amount"
            aria-label={sizeMode === "dollars" ? "Amount ($)" : "Contracts"}
            type="number"
            min={1}
            step={sizeMode === "dollars" ? "0.5" : "1"}
            className="h-8 font-mono text-xs tabular-nums"
            value={amountRaw}
            onChange={(event) => setAmountRaw(event.target.value)}
          />

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label
                htmlFor="kalshi-auto-tp-offset"
                className="mb-1 block text-[10px] text-muted-foreground"
              >
                Auto TP (+¢)
              </label>
              <Input
                id="kalshi-auto-tp-offset"
                type="number"
                min={1}
                max={98}
                step="1"
                placeholder="Off"
                className="h-7 font-mono text-xs tabular-nums"
                value={autoTpOffsetRaw}
                onChange={(event) => setAutoTpOffsetRaw(event.target.value)}
              />
            </div>
            <div>
              <label
                htmlFor="kalshi-auto-sl-offset"
                className="mb-1 block text-[10px] text-muted-foreground"
              >
                Auto SL (-¢)
              </label>
              <Input
                id="kalshi-auto-sl-offset"
                type="number"
                min={1}
                max={98}
                step="1"
                placeholder="Off"
                className="h-7 font-mono text-xs tabular-nums"
                value={autoSlOffsetRaw}
                onChange={(event) => setAutoSlOffsetRaw(event.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              className="h-9 bg-emerald-600 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
              disabled={
                !market ||
                yesAsk === null ||
                yesContracts <= 0 ||
                yesOverCap ||
                placeOrderMutation.isPending
              }
              onClick={() =>
                submitOrder("buy_yes", yesAsk, yesContracts, "Buy YES")
              }
            >
              {isBuyingYes
                ? "Buying YES..."
                : `Buy YES (${formatCents(yesAsk)})`}
            </Button>
            <Button
              type="button"
              className="h-9 bg-rose-600 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-50"
              disabled={
                !market ||
                noAsk === null ||
                noContracts <= 0 ||
                noOverCap ||
                placeOrderMutation.isPending
              }
              onClick={() =>
                submitOrder("buy_no", noAsk, noContracts, "Buy NO")
              }
            >
              {isBuyingNo ? "Buying NO..." : `Buy NO (${formatCents(noAsk)})`}
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-2 text-center font-mono text-[10px] tabular-nums text-muted-foreground">
            <span>
              {sizeMode === "dollars"
                ? yesContracts > 0
                  ? `${yesContracts} sh · ${formatUsd(yesBuyCost)}`
                  : yesAsk !== null
                    ? `Min ${formatUsd(yesAsk)}`
                    : "—"
                : yesBuyCost !== null
                  ? `Est. ${formatUsd(yesBuyCost)}`
                  : "—"}
            </span>
            <span>
              {sizeMode === "dollars"
                ? noContracts > 0
                  ? `${noContracts} sh · ${formatUsd(noBuyCost)}`
                  : noAsk !== null
                    ? `Min ${formatUsd(noAsk)}`
                    : "—"
                : noBuyCost !== null
                  ? `Est. ${formatUsd(noBuyCost)}`
                  : "—"}
            </span>
          </div>

          {(yesOverCap || noOverCap) && (
            <div className="text-[11px] text-amber-600 dark:text-amber-400">
              {sizeMode === "dollars" && validAmount > maxOrderDollars + 1e-9
                ? `Amount (${formatUsd(validAmount)}) exceeds ${formatUsd(maxOrderDollars)} cap.`
                : `${yesOverCap ? `YES order (${formatUsd(yesBuyCost)}) ` : ""}${yesOverCap && noOverCap ? "• " : ""}${noOverCap ? `NO order (${formatUsd(noBuyCost)}) ` : ""}exceeds ${formatUsd(maxOrderDollars)} cap.`}
            </div>
          )}
        </div>

        {visibleBracketEvent && (
          <div
            className={cn(
              "flex items-start justify-between gap-2 rounded-md border px-2.5 py-1.5 text-[11px]",
              visibleBracketEvent.status === "filled"
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : visibleBracketEvent.status === "closed"
                  ? "border-border bg-muted/40 text-muted-foreground"
                  : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
            )}
          >
            <span>{visibleBracketEvent.message}</span>
            <button
              type="button"
              aria-label="Dismiss bracket alert"
              className="shrink-0 rounded p-0.5 hover:bg-background/50"
              onClick={() =>
                setDismissedEventTs(visibleBracketEvent.timestampMs)
              }
            >
              <XIcon className="size-3" />
            </button>
          </div>
        )}

        {orderBanner && (
          <div
            className={cn(
              "rounded-md border px-2.5 py-1.5 text-[11px]",
              orderBanner.tone === "success"
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : "border-destructive/40 bg-destructive/10 text-destructive",
            )}
          >
            {orderBanner.text}
          </div>
        )}

        {connected && position && (
          <div className="flex flex-col gap-2 rounded-md border bg-card/60 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-foreground">Open Position</span>
              <Badge
                variant={position.side === "yes" ? "default" : "destructive"}
                className="font-mono text-[10px]"
              >
                {position.side.toUpperCase()} × {position.contracts}
              </Badge>
            </div>

            <div className="grid grid-cols-3 gap-1.5 text-[11px]">
              <div>
                <div className="text-[10px] text-muted-foreground">Cost</div>
                <div className="font-mono font-medium tabular-nums">
                  {formatUsd(position.costBasisDollars)}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground">
                  Exit Bid
                </div>
                <div className="font-mono font-medium tabular-nums">
                  {formatCents(position.exitBidDollars)}
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] text-muted-foreground">
                  Sell P&amp;L
                </div>
                <div
                  className={cn(
                    "font-mono font-semibold tabular-nums",
                    position.estimatedPnlDollars != null &&
                      position.estimatedPnlDollars >= 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-rose-600 dark:text-rose-400",
                  )}
                >
                  {formatSignedUsd(position.estimatedPnlDollars)}
                </div>
              </div>
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-xs font-medium"
              disabled={
                !market ||
                position.exitBidDollars === null ||
                placeOrderMutation.isPending
              }
              onClick={() =>
                submitOrder(
                  position.side === "yes" ? "sell_yes" : "sell_no",
                  position.exitBidDollars,
                  position.contracts,
                  `Sell ${position.side.toUpperCase()}`,
                )
              }
            >
              {isSelling
                ? "Selling..."
                : `Sell ${position.contracts} ${position.side.toUpperCase()} @ ${formatCents(position.exitBidDollars)}`}
            </Button>

            <form
              onSubmit={handleSaveBracketSubmit}
              className="flex flex-col gap-1.5 border-t pt-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-foreground">
                  Auto Exit (TP / SL)
                </span>
                <Badge
                  variant={bracket ? "secondary" : "outline"}
                  className="text-[10px]"
                >
                  {bracket ? "Armed" : "Off"}
                </Badge>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Active while OpenChart is open. Checked every 1s.
              </p>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label
                    htmlFor="kalshi-position-tp"
                    className="mb-1 block text-[10px] text-muted-foreground"
                  >
                    Take Profit (¢)
                  </label>
                  <Input
                    id="kalshi-position-tp"
                    type="number"
                    min={1}
                    max={99}
                    step="1"
                    placeholder="Off"
                    className="h-7 font-mono text-xs tabular-nums"
                    value={tpCentsDraft}
                    onChange={(event) => setTpCentsDraft(event.target.value)}
                  />
                  {projectedTpPnl !== null && (
                    <div className="mt-0.5 font-mono text-[10px] tabular-nums text-emerald-600 dark:text-emerald-400">
                      Est. {formatSignedUsd(projectedTpPnl)}
                    </div>
                  )}
                </div>
                <div>
                  <label
                    htmlFor="kalshi-position-sl"
                    className="mb-1 block text-[10px] text-muted-foreground"
                  >
                    Stop Loss (¢)
                  </label>
                  <Input
                    id="kalshi-position-sl"
                    type="number"
                    min={1}
                    max={99}
                    step="1"
                    placeholder="Off"
                    className="h-7 font-mono text-xs tabular-nums"
                    value={slCentsDraft}
                    onChange={(event) => setSlCentsDraft(event.target.value)}
                  />
                  {projectedSlPnl !== null && (
                    <div className="mt-0.5 font-mono text-[10px] tabular-nums text-rose-600 dark:text-rose-400">
                      Est. {formatSignedUsd(projectedSlPnl)}
                    </div>
                  )}
                </div>
              </div>

              {bracketError && (
                <div className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[10px] text-destructive">
                  {bracketError}
                </div>
              )}

              <div className="flex items-center gap-1.5">
                <Button
                  type="submit"
                  size="sm"
                  className="h-7 flex-1 text-[11px]"
                  disabled={
                    setBracketMutation.isPending ||
                    clearBracketMutation.isPending
                  }
                >
                  {setBracketMutation.isPending ? "Saving..." : "Save TP/SL"}
                </Button>
                {bracket && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2.5 text-[11px]"
                    disabled={
                      clearBracketMutation.isPending ||
                      setBracketMutation.isPending
                    }
                    onClick={() => clearBracketMutation.mutate(position.ticker)}
                  >
                    Clear
                  </Button>
                )}
              </div>
            </form>
          </div>
        )}

        {snapshotQuery.isPending ? (
          <div className="rounded-md border bg-card/40 p-3 text-center text-[11px] text-muted-foreground">
            Loading Kalshi market…
          </div>
        ) : showSetupCard ? (
          <div className="flex flex-col gap-2 rounded-md border bg-card/40 p-2.5">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1 font-medium text-foreground">
                <ShieldCheck className="size-3.5 text-emerald-500" />
                {connected
                  ? "Kalshi Account & Risk Cap"
                  : "Connect Live Kalshi Key"}
              </span>
              {connected && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => setSettingsOpen(false)}
                >
                  Done
                </Button>
              )}
            </div>

            {connected && !replacingKey ? (
              <div className="flex flex-col gap-2">
                <div className="text-[11px] text-muted-foreground">
                  Key:{" "}
                  <span className="font-mono text-foreground">
                    {snapshot?.maskedApiKeyId}
                  </span>
                </div>
                <form
                  onSubmit={handleUpdateCapSubmit}
                  className="flex items-end gap-1.5"
                >
                  <div className="flex-1">
                    <label
                      htmlFor="kalshi-cap-update"
                      className="mb-1 block text-[11px] text-muted-foreground"
                    >
                      Max Order ($)
                    </label>
                    <Input
                      id="kalshi-cap-update"
                      type="number"
                      min={1}
                      step="1"
                      className="h-8 font-mono text-xs"
                      value={capDraft}
                      onChange={(event) => setCapDraft(event.target.value)}
                    />
                  </div>
                  <Button
                    type="submit"
                    size="sm"
                    className="h-8 text-xs"
                    disabled={updateCapMutation.isPending}
                  >
                    {updateCapMutation.isPending ? "Saving..." : "Save Cap"}
                  </Button>
                </form>
                <div className="flex items-center justify-between gap-2 pt-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-[11px]"
                    onClick={() => setReplacingKey(true)}
                  >
                    Replace Key
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    className="h-7 gap-1 text-[11px]"
                    disabled={disconnectMutation.isPending}
                    onClick={() => disconnectMutation.mutate()}
                  >
                    <Unplug className="size-3" />
                    Disconnect
                  </Button>
                </div>
              </div>
            ) : (
              <form
                onSubmit={handleConnectSubmit}
                className="flex flex-col gap-2"
              >
                <p className="text-[11px] text-muted-foreground">
                  Encrypted locally on this machine. Orders submit immediately
                  up to your max cap.
                </p>
                <div>
                  <label
                    htmlFor="kalshi-api-key-id"
                    className="mb-1 block text-[11px] text-muted-foreground"
                  >
                    API Key ID
                  </label>
                  <Input
                    id="kalshi-api-key-id"
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    className="h-8 font-mono text-xs"
                    autoComplete="off"
                    value={apiKeyIdDraft}
                    onChange={(event) => setApiKeyIdDraft(event.target.value)}
                  />
                </div>
                <div>
                  <label
                    htmlFor="kalshi-private-key-pem"
                    className="mb-1 block text-[11px] text-muted-foreground"
                  >
                    Private Key (RSA or Ed25519 PEM)
                  </label>
                  <Textarea
                    id="kalshi-private-key-pem"
                    rows={3}
                    placeholder="-----BEGIN PRIVATE KEY-----"
                    className="min-h-14 font-mono text-[11px]"
                    spellCheck={false}
                    value={privateKeyDraft}
                    onChange={(event) => setPrivateKeyDraft(event.target.value)}
                  />
                </div>
                <div>
                  <label
                    htmlFor="kalshi-max-order-dollars"
                    className="mb-1 block text-[11px] text-muted-foreground"
                  >
                    Max Order Cap ($)
                  </label>
                  <Input
                    id="kalshi-max-order-dollars"
                    type="number"
                    min={1}
                    step="1"
                    className="h-8 font-mono text-xs"
                    value={capDraft}
                    onChange={(event) => setCapDraft(event.target.value)}
                  />
                </div>
                <div className="flex items-center gap-2 pt-0.5">
                  <Button
                    type="submit"
                    size="sm"
                    className="h-8 flex-1 text-xs"
                    disabled={connectMutation.isPending}
                  >
                    {connectMutation.isPending
                      ? "Verifying..."
                      : "Save & Connect"}
                  </Button>
                  {connected && replacingKey && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={() => {
                        setReplacingKey(false);
                        setSettingsError(null);
                      }}
                    >
                      Back
                    </Button>
                  )}
                </div>
              </form>
            )}

            {settingsError && (
              <div className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
                {settingsError}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
