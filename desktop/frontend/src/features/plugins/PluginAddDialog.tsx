import { ArrowLeft, Blocks, ChevronRight, CircleDot, Store, ToyBrick } from 'lucide-react';
import { useState } from 'react';

import { Modal, NeumorphicButton } from '../../shared/ui';
import styles from './PluginAddDialog.module.css';
import { MarketplaceAddForm, PluginCreateForm } from './PluginActionForms';
import { SkillRecordingForm } from './SkillRecordingForm';

interface PluginAddDialogProps {
  chatContextId?: string;
  onClose: () => void;
  onOpenChat: (threadId: string) => void;
  onMarketplaceAdded: () => Promise<void>;
}

export function PluginAddDialog({ chatContextId, onClose, onOpenChat, onMarketplaceAdded }: PluginAddDialogProps) {
  const [view, setView] = useState<'menu' | 'plugin' | 'marketplace' | 'record'>('menu');
  const [busy, setBusy] = useState(false);
  const title = { menu: 'Add plugins', plugin: 'Create plugin', marketplace: 'Add marketplace', record: 'Record skill' }[view];
  const Icon = { menu: ToyBrick, plugin: Blocks, marketplace: Store, record: CircleDot }[view];
  const onStarted = (threadId: string) => { onClose(); onOpenChat(threadId); };
  return (
    <Modal
      className={styles.dialog}
      title={title}
      titleIcon={<Icon aria-hidden="true" />}
      leadingAction={view !== 'menu' ? (
        <NeumorphicButton raised className="theme-toggle" aria-label="Back to Add plugins" title="Back to Add plugins" disabled={busy} onClick={() => setView('menu')}>
          <ArrowLeft size={11} strokeWidth={1.7} aria-hidden="true" />
        </NeumorphicButton>
      ) : undefined}
      onClose={() => { if (!busy) onClose(); }}
    >
      {view === 'plugin' && <PluginCreateForm chatContextId={chatContextId} onBusyChange={setBusy} onStarted={onStarted} />}
      {view === 'marketplace' && <MarketplaceAddForm onBusyChange={setBusy} onAdded={onMarketplaceAdded} onDone={onClose} />}
      {view === 'record' && <SkillRecordingForm chatContextId={chatContextId} onBusyChange={setBusy} onStarted={onStarted} />}
      {view === 'menu' && <div className={styles.options}>
        <NeumorphicButton className={styles.option} onClick={() => setView('plugin')}>
          <Blocks aria-hidden="true" />
          <span><strong>Create plugin</strong><span>Bring your skills and tools together in a plugin.</span></span>
          <ChevronRight className={styles.chevron} aria-hidden="true" />
        </NeumorphicButton>
        <NeumorphicButton className={styles.option} onClick={() => setView('marketplace')}>
          <Store aria-hidden="true" />
          <span><strong>Add marketplace</strong><span>Browse plugins from another marketplace.</span></span>
          <ChevronRight className={styles.chevron} aria-hidden="true" />
        </NeumorphicButton>
        <div className={styles.divider} />
        <NeumorphicButton className={styles.option} onClick={() => setView('record')}>
          <CircleDot aria-hidden="true" />
          <span><strong>Record skill</strong><span>Turn a recorded workflow into a reusable skill.</span></span>
          <ChevronRight className={styles.chevron} aria-hidden="true" />
        </NeumorphicButton>
      </div>}
    </Modal>
  );
}
