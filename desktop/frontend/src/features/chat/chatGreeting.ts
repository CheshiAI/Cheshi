export function chatGreeting(date: Date, userName: string): string {
  const hour = date.getHours();
  const greeting = hour < 5 ? 'You’re up late'
    : hour < 12 ? 'Good morning'
      : hour < 18 ? 'Good afternoon' : 'Good evening';
  const name = userName.trim();
  return name ? `${greeting}, ${name}.` : `${greeting}.`;
}
