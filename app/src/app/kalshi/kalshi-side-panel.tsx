// Purpose: Host the persistent right-side Kalshi 15-minute trading panel beside routed pages.

import { ResizableSidePanel } from "@openchart/app/components/layouts/resizable-side-panel";
import { useSidebar } from "@openchart/app/components/ui/sidebar";
import { KalshiTradePanel } from "@openchart/app/features/kalshi/components/kalshi-trade-panel";
import type { AppTransport } from "@openchart/app/lib/transport/transport";

/** Render Layout's right-side Kalshi 15m panel using the shared ResizableSidePanel container so it mirrors Copilot's width and mobile overlay behavior. @example <KalshiSidePanel transport={transport} open={open} onClose={() => setOpen(false)} /> */
export function KalshiSidePanel({
  transport,
  open,
  onClose,
}: {
  readonly transport: AppTransport;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const { isMobile } = useSidebar();

  return (
    <ResizableSidePanel
      id="app-kalshi"
      label="Kalshi 15m"
      isMobile={isMobile}
      hidden={!open}
    >
      <KalshiTradePanel
        transport={transport}
        visible={open}
        onClose={onClose}
      />
    </ResizableSidePanel>
  );
}
