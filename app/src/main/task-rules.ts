import { createHash } from 'node:crypto';
import type { LinkedTask } from '../shared/contracts';

// Same namespace and input as daily-task-list/src/domain.ts. Both clients
// create the same row when carrying the same source to the same date.
const NS = '7263a95c7f4b5f748c54b8fd2d253a65';
export function carryTaskId(sourceId: string, date: string): string {
  const bytes = createHash('sha1').update(Buffer.from(NS, 'hex')).update(`carry:${sourceId}:${date}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
  const s = bytes.toString('hex');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
export function sortLinkedTasks(items: LinkedTask[]): LinkedTask[] {
  const rank = { high: 3, medium: 2, low: 1 };
  return [...items].sort((a, b) => Number(a.completed) - Number(b.completed)
    || Number(a.sortOrder == null) - Number(b.sortOrder == null)
    || (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
    || (a.completed ? Date.parse(b.completedAt || b.createdAt) - Date.parse(a.completedAt || a.createdAt)
      : rank[b.priority] - rank[a.priority] || Date.parse(a.createdAt) - Date.parse(b.createdAt)));
}
