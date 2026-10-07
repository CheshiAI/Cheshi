import type { FlashMemoryApi, FlashMemoryStatus } from '../../../../shared/flash-memory';

export interface FlashStatusView { status: FlashMemoryStatus | null; retrying: boolean; connectionError: boolean }

/** Read cheap in-memory snapshots; never start model work while polling. */
export function observeFlashMemory(api: FlashMemoryApi, publish: (view: FlashStatusView) => void, intervalMs = 1000) {
  let stopped = false;
  let revision = 0;
  let retrying = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let status: FlashMemoryStatus | null = null;
  async function refresh(retry = false) {
    if (stopped || (retry && retrying)) return;
    const current = ++revision;
    clearTimeout(timer);
    retrying = retry;
    if (retry) publish({ status, retrying, connectionError: false });
    try {
      const next = await (retry ? api.retry() : api.status());
      if (stopped || current !== revision) return;
      status = next;
      publish({ status, retrying: false, connectionError: false });
    } catch {
      if (stopped || current !== revision) return;
      status = null;
      publish({ status, retrying: false, connectionError: true });
    } finally {
      if (!stopped && current === revision) {
        retrying = false;
        timer = setTimeout(() => void refresh(), intervalMs);
      }
    }
  }
  void refresh();
  return { retry: () => { void refresh(true); }, stop: () => { stopped = true; ++revision; clearTimeout(timer); } };
}

export function flashStatusPresentation(status: FlashMemoryStatus) {
  const label = { signed_out: 'Sign in', preparing: 'Preparing', syncing: 'Syncing', ready: 'Ready', error: 'Error' }[status.state];
  let detail = status.state === 'signed_out' ? 'Sign in to search saved conversations.'
    : status.state === 'preparing' ? 'Preparing Flash memory…'
    : status.state === 'syncing' ? status.total === null ? 'Reading saved conversations…'
      : `${status.processed.toLocaleString()} / ${status.total.toLocaleString()} messages synchronized`
    : status.state === 'error' ? status.error ?? 'Flash memory is unavailable. Retry synchronization.' : '';
  if (status.waiting > 0) detail += ' Search will continue automatically when ready. Use Stop to cancel.';
  return { label, detail, retryable: status.state === 'error' };
}
