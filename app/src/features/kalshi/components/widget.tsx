// Purpose: Register the built-in Kalshi 15m BTC trading panel as an OpenChart dashboard widget.

import { CandlestickChart } from "lucide-react";

import type { WidgetDefinition } from "@openchart/app/lib/widget/widget";

import { KalshiTradePanel } from "./kalshi-trade-panel";

/** Compact Kalshi BTC 15-minute ticket designed to sit beside a 1h BTC chart. @example widgetRegistry.kalshi = kalshiWidget; */
export const kalshiWidget: WidgetDefinition = {
  kind: "kalshi",
  title: "Kalshi 15m",
  Icon: CandlestickChart,
  defaultSize: { w: 3, h: 10 },
  minSize: { w: 3, h: 8 },
  Content: KalshiTradePanel,
};
