import { watch } from 'vue';
import { api, state, notify } from './state';
type ModelContext = {
  registerTool: (tool: any, options?: any) => Promise<void> | void;
  unregisterTool?: (name: string) => void;
};
export function installWebMcp() {
  const current = (document as Document & { modelContext?: ModelContext }).modelContext;
  const legacy = (navigator as Navigator & { modelContext?: ModelContext }).modelContext;
  const context = current || legacy;
  if (!context) {
    state.webmcpStatus = 'unavailable';
    return;
  }
  let controller: AbortController | undefined;
  let registered: string[] = [];
  let generation = 0;
  watch(
    () => [state.authenticated, state.browserTools, state.adminContext],
    async () => {
      const gen = ++generation;
      controller?.abort();
      for (const name of registered) context.unregisterTool?.(name);
      registered = [];
      if (!state.authenticated || !state.browserTools || !state.adminContext) {
        state.webmcpStatus = 'paused';
        return;
      }
      controller = new AbortController();
      const signal = controller.signal;
      try {
        const tools = await api<any[]>('/api/admin/tools');
        if (gen !== generation) return;
        for (const tool of tools) {
          await context.registerTool(
            {
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
              annotations: { readOnlyHint: tool.readOnly, untrustedContentHint: true },
              execute: async (args: unknown, options?: { signal?: AbortSignal }) => {
                if (
                  !state.authenticated ||
                  !state.browserTools ||
                  !state.adminContext ||
                  signal.aborted
                )
                  throw new Error('Browser tools are paused or the admin session ended.');
                const result = await api('/api/admin/tools/' + tool.name, {
                  method: 'POST',
                  body: JSON.stringify(args),
                  signal: options?.signal,
                });
                if (!tool.readOnly) {
                  window.dispatchEvent(new Event('linkgarden:changed'));
                  notify('Agent completed ' + tool.name.replaceAll('_', ' ') + '.');
                }
                return result;
              },
            },
            { signal, exposedTo: [location.origin] },
          );
          if (gen !== generation) {
            context.unregisterTool?.(tool.name);
            return;
          }
          registered.push(tool.name);
        }
        state.webmcpStatus = 'connected';
      } catch {
        state.webmcpStatus = 'error';
      }
    },
    { immediate: true },
  );
}
