const SHELL_PATH_TITLE = /^[^:\s]+@[^:\s]+:(.+)$/u;

export function paneDisplayPath(title: string): string {
  const match = SHELL_PATH_TITLE.exec(title);
  return match?.[1]?.trim() || title;
}
