import { describe, expect, it } from 'bun:test';
import { MemoryMonitor } from '../src';

describe('MemoryMonitor', () => {
  it('starts polling, records a peak, and stops cleanly', async () => {
    let thresholdExceeded = 0;
    const monitor = new MemoryMonitor(0, () => {
      thresholdExceeded += 1;
    });

    monitor.start(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    monitor.stop();

    expect(thresholdExceeded).toBeGreaterThan(0);
    expect(monitor.getPeakUsage()).toBeGreaterThan(0);

    const peakAfterStop = monitor.getPeakUsage();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(monitor.getPeakUsage()).toBe(peakAfterStop);
  });
});
