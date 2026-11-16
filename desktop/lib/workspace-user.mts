import { userInfo } from 'node:os';

export function currentUserName(): string {
  try {
    return userInfo().username.trim();
  } catch {
    return '';
  }
}
