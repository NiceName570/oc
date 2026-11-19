// Purpose: Share Layout-owned Kalshi side panel visibility with routed page headers.

import { CandlestickChart } from "lucide-react";
import { createContext, useContext } from "react";

import { Button } from "@openchart/app/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@openchart/app/components/ui/tooltip";

type KalshiPanelControls = {
  open: boolean;
  toggle: () => void;
} | null;

const KalshiPanelControlsContext = createContext<KalshiPanelControls>(null);

/** Shares Layout's Kalshi side panel controls without owning state; null hides the trigger when unavailable. @example <KalshiPanelControlsProvider value={controls}>{children}</KalshiPanelControlsProvider> */
export const KalshiPanelControlsProvider = KalshiPanelControlsContext.Provider;

/** Toggle button placed inside PageHeader next to CopilotTrigger; renders nothing outside KalshiPanelControlsProvider. @example <KalshiTrigger /> */
export function KalshiTrigger() {
  const controls = useKalshiPanelControls();
  if (controls === null) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={controls.open ? "secondary" : "ghost"}
          size="sm"
          className="h-7 gap-1.5 rounded-md px-2 text-xs"
          aria-label="Toggle Kalshi 15m"
          aria-expanded={controls.open}
          aria-controls="app-kalshi"
          onClick={controls.toggle}
        >
          <CandlestickChart className="size-3.5" aria-hidden="true" />
          <span>Kalshi</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>Toggle Kalshi 15m</TooltipContent>
    </Tooltip>
  );
}

/** Read Layout's Kalshi side panel controls, or null when unmounted. @example const kalshi = useKalshiPanelControls(); kalshi?.toggle(); */
export function useKalshiPanelControls() {
  return useContext(KalshiPanelControlsContext);
}
