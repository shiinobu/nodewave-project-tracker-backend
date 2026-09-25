import { describe, expect, test } from 'bun:test';
import { createTaskSchema, updateTaskSchema } from './task.dto';

const create = { projectId: 'p1', title: 'T', department: 'BACKEND' } as const;

describe('assigneeId', () => {
  test('an empty string is not an id — it is rejected instead of reaching the foreign key', () => {
    expect(() => createTaskSchema.parse({ ...create, assigneeId: '' })).toThrow();
    expect(() => updateTaskSchema.parse({ assigneeId: '', version: 1 })).toThrow();
  });

  test('a real id, an omitted id and (on update) null to unassign are all accepted', () => {
    expect(createTaskSchema.parse({ ...create, assigneeId: 'u1' }).assigneeId).toBe('u1');
    expect(createTaskSchema.parse(create).assigneeId).toBeUndefined();
    expect(updateTaskSchema.parse({ assigneeId: null, version: 1 }).assigneeId).toBeNull();
  });
});
