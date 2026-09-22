import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAppleCalendar } from '../../scripts/build-apple-calendar.mts';
import { developmentAppIdentity, prepareCalendarDevelopmentBundle, prepareDevelopmentApp } from '../../scripts/prepare-calendar-development.mts';
import { calendarExecutable, runCalendarCommand } from '../lib/apple-calendar-process.mts';
import createForgeConfiguration from '../../forge.config.mts';
import { calendarEvent } from '../shared/apple-calendar';
import { calendarEventFixture } from './apple-calendar-fixtures';
import { eventOnDay } from '../frontend/src/features/calendar/calendarDates';

test.skipIf(process.platform !== 'darwin')('native calendar dates and mutation guards handle DST and read-only data without accessing calendars', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cheshi-calendar-tests-'));
  const source = fileURLToPath(new URL('../native/apple-calendar/', import.meta.url));
  try {
    const executable = path.join(directory, 'calendar-tests');
    const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-parse-as-library',
      '-module-cache-path', path.join(tmpdir(), 'cheshi-calendar-swift-cache'),
      path.join(source, 'CalendarValues.swift'), path.join(source, 'CalendarValuesTests.swift'), '-o', executable], { encoding: 'utf8' });
    expect(built.stderr).toBe(''); expect(built.status).toBe(0);
    const result = spawnSync(executable, [], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Calendar native boundary checks passed');
    const prefix = 'Calendar date fixtures: ';
    const line = result.stdout.split('\n').find(value => value.startsWith(prefix));
    expect(line).toBeDefined();
    const fixtures: unknown = JSON.parse(line!.slice(prefix.length));
    expect(Array.isArray(fixtures)).toBe(true);
    for (const dates of fixtures as Array<Record<string, unknown>>) {
      const event = calendarEvent({ ...calendarEventFixture, ...dates, allDay: true });
      expect(eventOnDay(event, event.start)).toBe(true);
      expect(eventOnDay(event, event.end)).toBe(false);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 60_000);

test.skipIf(process.platform !== 'darwin')('built native helper runs from packaged resources and development permission metadata remains signed', async () => {
  await buildAppleCalendar();
  const directory = mkdtempSync(path.join(tmpdir(), 'cheshi-calendar-package-'));
  try {
    const bundle = path.join(directory, 'Electron.app');
    const contents = path.join(bundle, 'Contents');
    const macos = path.join(contents, 'MacOS');
    const resources = path.join(contents, 'Resources', 'runtime', `${process.platform}-${process.arch}`);
    mkdirSync(macos, { recursive: true });
    mkdirSync(resources, { recursive: true });
    copyFileSync(calendarExecutable(), path.join(macos, 'Electron'));
    const packaged = path.join(resources, 'cheshi-calendar');
    copyFileSync(calendarExecutable(), packaged);
    expect(await runCalendarCommand({ action: 'invalid-command' }, { executable: packaged })).toEqual({ ok: false, error: { code: 'invalid' } });
    const info = path.join(contents, 'Info.plist');
    writeFileSync(info, '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.cheshi.calendar.test</string><key>CFBundleExecutable</key><string>Electron</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
    prepareCalendarDevelopmentBundle(bundle);
    const first = readFileSync(info, 'utf8');
    expect(first).toContain('NSCalendarsFullAccessUsageDescription');
    expect(first).toContain('NSCalendarsUsageDescription');
    expect(first).toContain('NSAppleEventsUsageDescription');
    expect(first).toContain('manages your Mail messages');
    expect(first).toContain(developmentAppIdentity(process.cwd()).bundleId);
    expect(first).toContain('Cheshi Development');
    prepareCalendarDevelopmentBundle(bundle);
    expect(readFileSync(info, 'utf8')).toBe(first);
    expect(spawnSync('/usr/bin/codesign', ['--verify', '--strict', bundle]).status).toBe(0);
    const checkout = path.join(directory, 'checkout');
    const icons = path.join(checkout, 'resources', 'icons');
    mkdirSync(icons, { recursive: true });
    copyFileSync(new URL('../../resources/icons/app-icon.icns', import.meta.url), path.join(icons, 'app-icon.icns'));
    const development = prepareDevelopmentApp(bundle, checkout);
    expect(development).not.toBe(bundle);
    expect(readFileSync(info, 'utf8')).toBe(first);
    expect(readFileSync(path.join(development, 'Contents', 'Info.plist'), 'utf8')).toContain(developmentAppIdentity(checkout).bundleId);
    expect(prepareDevelopmentApp(bundle, checkout)).toBe(development);
    expect(developmentAppIdentity(`${checkout}-other`).bundleId).not.toBe(developmentAppIdentity(checkout).bundleId);
    const config = await createForgeConfiguration();
    expect(config.packagerConfig?.extendInfo).toMatchObject({
      NSCalendarsFullAccessUsageDescription: expect.any(String), NSCalendarsUsageDescription: expect.any(String),
      NSAppleEventsUsageDescription: expect.stringContaining('manages your Mail messages'),
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 60_000);
