# Kalshi app composition

Hosts the dockable right-hand Kalshi drawer beside routed pages in `Layout`. See [Kalshi architecture](../../../../docs/architecture/kalshi.md).

- `kalshi-controls.tsx` exports `KalshiPanelControlsProvider`, `KalshiTrigger`, and `useKalshiPanelControls`. Keep `KalshiPanelControlsContext` defaulting to `null` so standalone `<PageHeader>` renders outside `Layout` remain unaffected.
- `kalshi-side-panel.tsx` mounts `KalshiTradePanel` inside shared `ResizableSidePanel` (`id="app-kalshi"`, `320–800px` desktop, full-width overlay mobile) and passes `visible={open}` to halt background `1s` snapshot polling when collapsed.
- `Layout` keeps `KalshiSidePanel` and `CopilotAgent` mutually exclusive on the right edge and updates mobile `pageHidden` whenever either drawer is open.
