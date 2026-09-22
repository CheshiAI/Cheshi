import { CalendarDays, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AppleCalendar, AppleCalendarApi, CalendarEvent } from '../../../../shared/apple-calendar';
import { Modal, NeumorphicButton, NeumorphicSurface, NeumorphicTextField } from '../../shared/ui';
import { createCalendarDraft } from './calendarDraft';
import styles from './Calendar.module.css';

export function CalendarEventDialog({ api, event, day, calendarId, calendars, onClose, onSaved }: {
  api: AppleCalendarApi; event: CalendarEvent | null; day: string; calendarId: string;
  calendars: AppleCalendar[]; onClose: () => void; onSaved: () => void;
}) {
  const [draft] = useState(() => createCalendarDraft(event, day, calendarId));
  const state = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const [confirm, setConfirm] = useState<'discard' | 'delete' | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const preventClose = (close: BeforeUnloadEvent) => {
      if (state.dirty || state.busy) { close.preventDefault(); close.returnValue = ''; }
    };
    window.addEventListener('beforeunload', preventClose);
    return () => window.removeEventListener('beforeunload', preventClose);
  }, [state.dirty, state.busy]);
  const readOnly = event?.readOnly === true;
  const disabled = state.busy || state.blocked || readOnly;
  const submit = async (remove = false) => {
    if (await draft.submit(api, remove)) { if (alive.current) onSaved(); }
  };
  const close = () => { if (!state.busy) { if (state.dirty) setConfirm('discard'); else onClose(); } };
  return <Modal title={event ? '일정' : '새 일정'} titleIcon={<CalendarDays aria-hidden="true" />}
    onClose={close} closeDisabled={state.busy}>
    <form className={styles.form} onSubmit={e => { e.preventDefault(); void submit(); }}>
      {readOnly && <p>반복 일정·초대 일정 또는 읽기 전용 캘린더입니다. Apple 캘린더에서 편집해 주세요.</p>}
      {state.error && <p role="alert">{state.error}</p>}
      <label className={styles.field}>캘린더
        <NeumorphicSurface raised highlightFocus className={styles.selectSurface}>
          <select aria-label="일정 캘린더" value={state.form.calendarId} disabled={disabled || !!event}
            onChange={e => draft.edit({ calendarId: e.target.value })}>
            {calendars.filter(calendar => calendar.writable || calendar.id === event?.calendarId).map(calendar =>
              <option key={calendar.id} value={calendar.id}>{calendar.source} / {calendar.title}</option>)}
          </select>
        </NeumorphicSurface>
      </label>
      <label className={styles.field}>제목<NeumorphicTextField aria-label="일정 제목" value={state.form.title}
        required maxLength={1000} disabled={disabled} onChange={e => draft.edit({ title: e.target.value })} /></label>
      <label className={styles.checkbox}><input type="checkbox" checked={state.form.allDay} disabled={disabled}
        onChange={e => draft.toggleAllDay(e.target.checked)} />종일</label>
      <div className={styles.dateFields}>
        <label className={styles.field}>시작<NeumorphicTextField aria-label="시작" type={state.form.allDay ? 'date' : 'datetime-local'}
          required value={state.form.start} disabled={disabled} onChange={e => draft.edit({ start: e.target.value })} /></label>
        <label className={styles.field}>{state.form.allDay ? '마지막 날짜' : '종료'}<NeumorphicTextField aria-label="종료" type={state.form.allDay ? 'date' : 'datetime-local'}
          required value={state.form.end} disabled={disabled} onChange={e => draft.edit({ end: e.target.value })} /></label>
      </div>
      {!state.form.allDay && <p className={styles.hint}>시간 표시: {Intl.DateTimeFormat().resolvedOptions().timeZone}</p>}
      <label className={styles.field}>장소<NeumorphicTextField aria-label="장소" value={state.form.location}
        maxLength={4000} disabled={disabled} onChange={e => draft.edit({ location: e.target.value })} /></label>
      <label className={styles.field}>메모<NeumorphicTextField aria-label="일정 메모" multiline rows={5} value={state.form.notes}
        maxLength={100_000} disabled={disabled} onChange={e => draft.edit({ notes: e.target.value })} /></label>
      {confirm ? <div className={styles.confirm}>
        <p>{confirm === 'delete' ? '이 일정을 Apple 캘린더에서 삭제할까요?' : '저장하지 않은 변경을 버리고 닫을까요?'}</p>
        <div className={styles.actions}>
          <NeumorphicButton type="button" disabled={state.busy} onClick={() => setConfirm(null)}>취소</NeumorphicButton>
          <NeumorphicButton type="button" disabled={state.busy || (confirm === 'delete' && disabled)}
            onClick={() => { if (confirm === 'delete') void submit(true); else onClose(); }}>
            {confirm === 'delete' ? '삭제' : '버리고 닫기'}</NeumorphicButton>
        </div>
      </div> : <div className={styles.actions}>
        {event && !readOnly && <NeumorphicButton type="button" disabled={disabled} onClick={() => setConfirm('delete')}>
          <Trash2 aria-hidden="true" />삭제</NeumorphicButton>}
        <NeumorphicButton type="button" disabled={state.busy} onClick={close}>닫기</NeumorphicButton>
        {!readOnly && <NeumorphicButton type="submit" disabled={disabled || !state.form.title.trim() || (!!event && !state.dirty)}>
          {state.busy ? '저장 중…' : '저장'}</NeumorphicButton>}
      </div>}
    </form>
  </Modal>;
}
