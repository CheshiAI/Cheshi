export type SchedulerDesktop = {
  startup(): { enabled: boolean; available: boolean };
  setStartup(enabled: boolean): void;
};
let desktop: SchedulerDesktop = { startup: () => ({ enabled: false, available: false }), setStartup() { throw new Error('Login startup is unavailable.'); } };
export const schedulerDesktop = () => desktop;
export function configureSchedulerDesktop(value: SchedulerDesktop): void { desktop = value; }
