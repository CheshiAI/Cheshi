export function homiesReady(status: HomieSetupStatus | null): boolean {
  return status?.supported === true && status.brew === true && status.docker === true
    && status.colima === true && status.connected === true && status.securityReady === true && status.busy === false;
}

export interface HomieSetupStatus {
  supported: boolean;
  brew: boolean;
  docker: boolean;
  colima: boolean;
  connected: boolean;
  securityReady: boolean;
  busy: boolean;
  detail: string;
  startedAt?: number;
  error?: string;
}

export function parseHomieSetupStatus(value: unknown): HomieSetupStatus {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid Homies setup status.');
  const status = value as Record<string, unknown>;
  for (const key of ['supported', 'brew', 'docker', 'colima', 'connected', 'securityReady', 'busy']) {
    if (typeof status[key] !== 'boolean') throw new TypeError('Invalid Homies setup status.');
  }
  if (typeof status.detail !== 'string' || status.detail.length > 1000
    || (status.error !== undefined && (typeof status.error !== 'string' || status.error.length > 1000))
    || (status.startedAt !== undefined && (typeof status.startedAt !== 'number'
      || !Number.isSafeInteger(status.startedAt) || status.startedAt < 0))) throw new TypeError('Invalid Homies setup status.');
  return { supported: status.supported === true, brew: status.brew === true, docker: status.docker === true,
    colima: status.colima === true, connected: status.connected === true, securityReady: status.securityReady === true, busy: status.busy === true,
    detail: status.detail, ...(status.error === undefined ? {} : { error: status.error as string }),
    ...(status.startedAt === undefined ? {} : { startedAt: status.startedAt as number }) };
}
