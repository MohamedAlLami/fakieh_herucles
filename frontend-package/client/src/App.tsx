import { lazy, Suspense } from "react";
import { Switch, Route, Redirect, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider, useTheme } from "@/contexts/ThemeContext";
import { NavLayoutProvider } from "@/contexts/NavLayoutContext";
import { SiloProvider } from "@/contexts/SiloContext";
import { ErrorBoundary } from "@/components/ErrorBoundary";

// Water System Pages — lazy so a first visit only downloads the route it needs
// instead of every screen's chunk (Orders alone is ~2.6k lines).
const WaterDashboard = lazy(() =>
  import("./pages/water-system/Dashboard").then((m) => ({ default: m.Dashboard }))
);
const FakiehDashboard = lazy(() => import("./pages/water-system/FakiehDashboard"));
const Material = lazy(() =>
  import("./pages/water-system/Material").then((m) => ({ default: m.Material }))
);
const Storage = lazy(() =>
  import("./pages/water-system/Storage").then((m) => ({ default: m.Storage }))
);
const Production = lazy(() =>
  import("./pages/water-system/Production").then((m) => ({ default: m.Production }))
);
const Orders = lazy(() =>
  import("./pages/water-system/Orders").then((m) => ({ default: m.Orders }))
);
const OrderHistory = lazy(() =>
  import("./pages/water-system/OrderHistory").then((m) => ({ default: m.OrderHistory }))
);
const Weighbridge = lazy(() =>
  import("./pages/water-system/Weighbridge").then((m) => ({ default: m.Weighbridge }))
);
const TruckEntry = lazy(() => import("./pages/water-system/TruckEntry"));
const Alarms = lazy(() =>
  import("./pages/water-system/Alarms").then((m) => ({ default: m.Alarms }))
);
const Admin = lazy(() =>
  import("./pages/water-system/Admin").then((m) => ({ default: m.Admin }))
);
const PLCConfiguration = lazy(() =>
  import("./pages/water-system/PlcConfiguration").then((m) => ({ default: m.PLCConfiguration }))
);
const PLCReports = lazy(() =>
  import("./pages/water-system/PLCReports").then((m) => ({ default: m.PLCReports }))
);
const BatchCalendarPage = lazy(() =>
  import("./pages/water-system/BatchCalendarPage").then((m) => ({ default: m.BatchCalendarPage }))
);
const BatchHistoricalReports = lazy(() =>
  import("./pages/water-system/BatchHistoricalReports").then((m) => ({
    default: m.BatchHistoricalReports,
  }))
);
const BatchRawDataPage = lazy(() =>
  import("./pages/water-system/BatchRawDataPage").then((m) => ({ default: m.BatchRawDataPage }))
);
const PalletReport = lazy(() =>
  import("./pages/water-system/PalletReport").then((m) => ({ default: m.PalletReport }))
);
const Distribution = lazy(() =>
  import("./pages/water-system/Distribution").then((m) => ({ default: m.Distribution }))
);
const Management = lazy(() => import("./pages/water-system/Management"));
const AiAssistant = lazy(() => import("./pages/water-system/AiAssistant"));
// three.js only reaches the browser when this route is opened.
const Plant3D = lazy(() => import("./pages/water-system/Plant3D"));

function PageFallback() {
  return (
    <div className="h-screen w-screen flex items-center justify-center bg-slate-950 light:bg-white">
      <div className="text-sm opacity-70 text-white light:text-gray-900">Loading page…</div>
    </div>
  );
}

function Router() {
  const { isInitialized } = useTheme();

  // Show loading state until theme is initialized to prevent flickering
  if (!isInitialized) {
    return (
      <div className="h-screen w-screen bg-slate-950 light:bg-white flex items-center justify-center">
        <div className="text-white light:text-gray-900">Loading...</div>
      </div>
    );
  }

  return (
    <Switch>
      {/* Redirect root to Fakieh water system (SPA redirect — no document reload) */}
      <Route path="/">
        <Redirect to="/fakieh/fakieh-dashboard" />
      </Route>

      {/* Fakieh routes - full-screen layouts without AppLayout */}
      <Route path="/fakieh" component={WaterDashboard} />
      <Route path="/fakieh/dashboard" component={WaterDashboard} />
      <Route path="/fakieh/fakieh-dashboard" component={FakiehDashboard} />
      <Route path="/fakieh/material" component={Material} />
      <Route path="/fakieh/storage" component={Storage} />
      <Route path="/fakieh/plant-3d" component={Plant3D} />
      <Route path="/fakieh/production" component={Production} />
      <Route path="/fakieh/orders">
        <Redirect to="/fakieh/live_orders" />
      </Route>
      <Route path="/fakieh/live_orders" component={Orders} />
      <Route path="/fakieh/order-history" component={OrderHistory} />
      <Route path="/fakieh/rfid">
        <Redirect to="/fakieh/management/rfid" />
      </Route>
      <Route path="/fakieh/weighbridge" component={Weighbridge} />
      <Route path="/fakieh/management">
        <Redirect to="/fakieh/management/trucks" />
      </Route>
      <Route path="/fakieh/management/rfid" component={Management} />
      <Route path="/fakieh/management/trucks" component={Management} />
      <Route path="/fakieh/management/drivers" component={Management} />
      <Route path="/fakieh/management/clients" component={Management} />
      <Route path="/fakieh/truck-management">
        <Redirect to="/fakieh/management/trucks" />
      </Route>
      <Route path="/fakieh/truck-entry" component={TruckEntry} />
      <Route path="/fakieh/client-information">
        <Redirect to="/fakieh/management/clients" />
      </Route>
      <Route path="/fakieh/alarms" component={Alarms} />
      <Route path="/fakieh/admin" component={Admin} />
      <Route path="/fakieh/distribution" component={Distribution} />
      <Route path="/fakieh/ai-assistant" component={AiAssistant} />
      <Route path="/fakieh/engineering" component={PLCConfiguration} />
      <Route path="/fakieh/plc-reports" component={PLCReports} />
      <Route path="/fakieh/batch-calendar" component={BatchCalendarPage} />
      <Route path="/fakieh/batch-historical-reports" component={BatchHistoricalReports} />
      <Route path="/fakieh/batch-raw-data" component={BatchRawDataPage} />
      <Route path="/fakieh/pallet-report" component={PalletReport} />

      {/* Catch all - redirect to Fakieh */}
      <Route>
        <Redirect to="/fakieh/fakieh-dashboard" />
      </Route>
    </Switch>
  );
}

/**
 * The routed tree, bounded.
 *
 * Named routes rather than one blanket name: the fallback tells the operator
 * WHICH screen failed, and "Plant 3D" is a more useful thing to read than
 * "the application". Anything unlisted falls back to a neutral description
 * rather than a wrong one.
 */
const ROUTE_NAMES: Array<[string, string]> = [
  ['/fakieh/plant-3d', 'Plant 3D'],
  ['/fakieh/storage', 'Storage'],
  ['/fakieh/live_orders', 'Orders'],
  ['/fakieh/order-history', 'Order history'],
  ['/fakieh/weighbridge', 'Weighbridge'],
  ['/fakieh/production', 'Production'],
  ['/fakieh/pallet-report', 'Pallet Report'],
];

function RoutedErrorBoundary() {
  const [location] = useLocation();
  const name = ROUTE_NAMES.find(([path]) => location.startsWith(path))?.[1] ?? 'This screen';
  return (
    <ErrorBoundary name={name} resetKey={location}>
      <Router />
    </ErrorBoundary>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <NavLayoutProvider>
          <SiloProvider>
            <TooltipProvider>
              <Toaster />
              <Suspense fallback={<PageFallback />}>
                {/*
                 * Inside the Suspense, so a chunk that fails to download is
                 * caught here too rather than leaving the fallback spinning
                 * for ever — these routes are all lazy.
                 *
                 * Keyed on the path, so navigating away from a crashed screen
                 * and back actually retries it. Without that the boundary
                 * latches on first error and every later route renders the
                 * same dead panel, which looks like the crash spreading.
                 */}
                <RoutedErrorBoundary />
              </Suspense>
            </TooltipProvider>
          </SiloProvider>
        </NavLayoutProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
