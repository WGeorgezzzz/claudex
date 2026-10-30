import crypto from 'node:crypto';

// A crashed/cancelled deployment must not leave the old HTTP server frozen.
// The token prevents an old guard from cancelling a newer handoff.
export function createProviderRestartLease(setDraining: (value: boolean) => void, lifetimeMs = 120_000) {
  let current: { handoffId: string; expiresAt: number } | undefined;
  let timer: NodeJS.Timeout | undefined;
  const clear = () => { clearTimeout(timer); current = undefined; setDraining(false); };
  const renew = (handoffId: string) => {
    if (!current || current.handoffId !== handoffId) throw new Error('Unknown or expired provider handoff');
    current.expiresAt = Date.now() + lifetimeMs;
    clearTimeout(timer); timer = setTimeout(clear, lifetimeMs); timer.unref();
    return { ...current };
  };
  return {
    begin(handoffId: string = crypto.randomUUID()) {
      if (!/^[a-zA-Z0-9-]{1,80}$/.test(handoffId)) throw new Error('Invalid provider handoff token');
      if (current && current.handoffId !== handoffId) throw new Error('Another provider handoff is active');
      current ||= { handoffId, expiresAt: 0 }; setDraining(true);
      return renew(handoffId);
    },
    renew,
    cancel(handoffId: string) {
      if (!current) return { cancelled: true };
      if (current.handoffId !== handoffId) throw new Error('Provider handoff token mismatch');
      clear(); return { cancelled: true };
    },
    assertCurrent(handoffId: string) {
      if (!current || current.handoffId !== handoffId || current.expiresAt <= Date.now()) throw new Error('Provider handoff expired during preparation');
    },
  };
}
