import { useEffect, useState } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';
import { presentationUserName } from '../../shared/presentation';
import { chatGreeting } from './chatGreeting';
import styles from './ChatView.module.css';

const welcomeQuote = [
  '"Which way should I go?"',
  '"Where do you want to go?"',
  '"I don’t know."',
  '"Then it doesn’t matter which way you go."',
  '"You’re sure to get somewhere, if you only walk long enough."',
];

export function ChatWelcome({ workspaceName }: { workspaceName: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const refresh = () => setNow(new Date());
    const interval = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  return (
    <div className={styles.empty}>
      <figure className={styles.welcomeQuoteFrame}>
        <div className={styles.welcomeQuoteBorder}>
          <span className={styles.welcomeQuoteOpen} aria-hidden="true">❝</span>
          <blockquote className={styles.welcomeQuote}>
            {welcomeQuote.map(line => <span key={line}>{line}</span>)}
          </blockquote>
          <span className={styles.welcomeQuoteClose} aria-hidden="true">❞</span>
        </div>
        <figcaption className={styles.welcomeQuoteAuthor}>— Lewis Carroll —</figcaption>
      </figure>
      <h2>{chatGreeting(now, presentationUserName(cheshiDesktop?.userName ?? ''))}</h2>
      <p>How can I help with {workspaceName}?</p>
    </div>
  );
}
