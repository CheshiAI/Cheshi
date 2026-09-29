import { CALENDAR_ERRORS } from '../../../../shared/apple-calendar';
import { LoadingState, NeumorphicButton } from '../../shared/ui';
import type { CalendarState } from './calendarModel';
import styles from './Calendar.module.css';

export function CalendarAccessState({ state, onConnect, onRetry }: {
  state: CalendarState;
  onConnect: () => void;
  onRetry: () => void;
}) {
  if (state.loading || (state.access === null && !state.error)) {
    return <div className={styles.connect}><LoadingState label="Checking calendar access…" /></div>;
  }
  const failed = !!state.error && state.error !== CALENDAR_ERRORS.permission;
  const canRequest = !failed && (state.access === 'not-determined' || state.access === 'write-only');
  const title = failed ? 'Could not load Apple Calendar'
    : state.access === 'denied' ? 'Calendar access denied'
      : state.access === 'restricted' ? 'Calendar access restricted'
        : state.access === 'write-only' ? 'Full calendar access required' : 'Connect Apple Calendar';
  const description = failed ? state.error
    : state.access === 'denied' ? CALENDAR_ERRORS.permission
      : state.access === 'restricted' ? 'Calendar access is restricted by this Mac’s settings or policy.'
        : state.access === 'write-only' ? 'Write-only access cannot display events. Allow full access to view and manage your calendars.'
          : 'Connect Apple Calendar to view and manage your events.';
  return <section className={styles.connect} aria-label="Calendar access">
    <h2>{title}</h2>
    <p role={failed || state.access === 'denied' || state.access === 'restricted' ? 'alert' : undefined}>{description}</p>
    <NeumorphicButton variant="standard" onClick={canRequest ? onConnect : onRetry}>
      {canRequest ? state.access === 'write-only' ? 'Allow full access' : 'Connect Apple Calendar' : failed ? 'Retry' : 'Check access again'}
    </NeumorphicButton>
  </section>;
}
