import { Bot, Bell, Clock, Info, Mic, Palette, Settings } from 'lucide-react';
import { useState } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';
import type { SettingsApi } from '../../../../shared/settings';
import { LiquidGlassPanel, NeumorphicButton, TwoTierHeader,
  draggableWindowRegionStyle } from '../../shared/ui';
import styles from './SettingsView.module.css';
import { AgentSettings } from './AgentSettings';
import { AppearanceSettings } from './AppearanceSettings';
import { AboutSettings } from './AboutSettings';
import { NotificationSettings } from './NotificationSettings';
import { SchedulerSettings } from './SchedulerSettings';
import { VoiceSettings } from './VoiceSettings';
import type { VoiceRecordingsApi } from '../../../../shared/voice-recordings';

type SettingsCategory = 'agents' | 'appearance' | 'notifications' | 'scheduler' | 'voice' | 'about';

export function SettingsView({ api = cheshiDesktop?.settings, contextId, onOpenChat, voiceApi, platform, initialCategory = 'agents' }: {
  api?: SettingsApi; contextId?: string; onOpenChat?(thread: string): void; voiceApi?: VoiceRecordingsApi; platform?: string;
  initialCategory?: SettingsCategory;
}) {
  const [category, setCategory] = useState<SettingsCategory>(initialCategory);
  return <main className={styles.workspace} aria-label="Settings">
    <TwoTierHeader className={styles.header} style={draggableWindowRegionStyle} primary={<>
      <div className={styles.heading}>
        <NeumorphicButton raised size="icon" aria-hidden="true" className={styles.titleMark} disabled>
          <Settings aria-hidden="true" />
        </NeumorphicButton>
        <h1 className={styles.sectionTitle}>SETTINGS</h1>
      </div>
    </>} />
    <div className={styles.body}>
      <LiquidGlassPanel as="aside" className={styles.sidebar} aria-label="Settings categories">
        <button type="button" className={styles.item} aria-current={category === 'agents' ? 'page' : undefined} onClick={() => setCategory('agents')}><Bot aria-hidden="true" />Agents</button>
        <button type="button" className={styles.item} aria-current={category === 'appearance' ? 'page' : undefined} onClick={() => setCategory('appearance')}><Palette aria-hidden="true" />Appearance</button>
        <button type="button" className={styles.item} aria-current={category === 'notifications' ? 'page' : undefined} onClick={() => setCategory('notifications')}><Bell aria-hidden="true" />Notifications</button>
        <button type="button" className={styles.item} aria-current={category === 'scheduler' ? 'page' : undefined} onClick={() => setCategory('scheduler')}><Clock aria-hidden="true" />Scheduler</button>
        <button type="button" className={styles.item} aria-current={category === 'voice' ? 'page' : undefined} onClick={() => setCategory('voice')}><Mic aria-hidden="true" />Voice</button>
        <button type="button" className={styles.item} aria-current={category === 'about' ? 'page' : undefined} onClick={() => setCategory('about')}><Info aria-hidden="true" />About</button>
      </LiquidGlassPanel>
      {category === 'agents' ? <AgentSettings api={api} /> : category === 'scheduler' ? <SchedulerSettings /> : category === 'voice' ? <VoiceSettings api={voiceApi} platform={platform} /> : category === 'notifications' ? <NotificationSettings contextId={contextId} onStarted={onOpenChat} /> : category === 'about' ? <AboutSettings /> : <AppearanceSettings />}
    </div>
  </main>;
}
