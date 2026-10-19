import { dashboardClient, isDashboardHostMessage } from './dashboardClient';
import type { WebviewApi } from './dashboardClient';

/**
 * Bundle entry point. esbuild inlines this module and everything it imports into the
 * single inline webview script, so the client may use ordinary imports. The static
 * shell calls the global below with its per-render instance key.
 */
declare global {
  // eslint-disable-next-line no-var
  var __dejareviewDashboard: ((acquire: () => WebviewApi, instanceKey: string) => void) | undefined;
}

globalThis.__dejareviewDashboard = (acquire, instanceKey) => {
  dashboardClient(acquire, instanceKey, isDashboardHostMessage);
};
