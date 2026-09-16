import { Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { APPLE_NOTES_DELETE_UNKNOWN_MESSAGE, type AppleNoteSummary, type AppleNotesApi } from '../../../../shared/apple-notes';
import { Modal, NeumorphicButton } from '../../shared/ui';
import styles from './AppleNotes.module.css';

export function AppleNotesDeleteDialog({ api, note, onClose, onDeleted }: {
  api: AppleNotesApi; note: AppleNoteSummary; onClose: () => void; onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unknownResult, setUnknownResult] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const remove = async () => {
    if (pending.current || unknownResult || note.locked !== false) return;
    pending.current = true;
    setDeleting(true);
    setError(null);
    try {
      const result = await api.delete(note.id);
      if (!mounted.current) return;
      if (result.ok === true && result.value.id === note.id) onDeleted();
      else if (result.ok === false) {
        setError(result.error.message);
        setUnknownResult(result.error.code === 'delete-unknown');
      } else {
        setError(APPLE_NOTES_DELETE_UNKNOWN_MESSAGE);
        setUnknownResult(true);
      }
    } catch {
      if (mounted.current) {
        setError(APPLE_NOTES_DELETE_UNKNOWN_MESSAGE);
        setUnknownResult(true);
      }
    } finally {
      pending.current = false;
      if (mounted.current) setDeleting(false);
    }
  };

  return <Modal title="메모 삭제" titleIcon={<Trash2 aria-hidden="true" />} onClose={onClose} closeDisabled={deleting}>
    <div className={styles.content}>
      <p><strong>{note.title || '제목 없는 메모'}</strong> 메모를 삭제할까요?</p>
      <p className={styles.hint}>Apple 메모 앱의 원본 메모가 삭제됩니다.</p>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.actions}>
        <NeumorphicButton raised size="standard" disabled={deleting} onClick={onClose}>취소</NeumorphicButton>
        <NeumorphicButton raised size="standard" disabled={deleting || unknownResult || note.locked !== false}
          onClick={() => void remove()}>{deleting ? '삭제 중…' : '삭제'}</NeumorphicButton>
      </div>
    </div>
  </Modal>;
}
