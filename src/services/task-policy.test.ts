import { describe, expect, test } from 'bun:test';
import { ForbiddenError, ValidationError } from '../lib/errors';
import { assertAssignable, assertTransition, type TransitionContext } from './task-policy';

const PM = { sub: 'pm-1', role: 'PM', department: null } as const;
const BACKEND = { sub: 'be-1', role: 'INTERNAL', department: 'BACKEND' } as const;
const FRONTEND = { sub: 'fe-1', role: 'INTERNAL', department: 'FRONTEND' } as const;
const CLIENT = { sub: 'cl-1', role: 'CLIENT', department: null } as const;

const UNMET = [{ id: 'dep-1', title: 'Upstream', status: 'IN_PROGRESS' as const }];

function ctx(
  actor: TransitionContext['actor'],
  from: TransitionContext['task']['status'],
  to: TransitionContext['to'],
  overrides: Partial<Omit<TransitionContext, 'actor' | 'to'>> = {},
): TransitionContext {
  return {
    actor,
    to,
    task: { status: from, department: 'BACKEND', assigneeId: null },
    isProjectMember: true,
    blockedBy: [],
    ...overrides,
  };
}

describe('assertTransition — PM', () => {
  test('may start an unblocked task', () => {
    expect(() => assertTransition(ctx(PM, 'TODO', 'IN_PROGRESS'))).not.toThrow();
  });

  test('may start a task without being a project member', () => {
    expect(() =>
      assertTransition(ctx(PM, 'TODO', 'IN_PROGRESS', { isProjectMember: false })),
    ).not.toThrow();
  });

  test('may not start a blocked task, and is told what blocks it', () => {
    const attempt = () => assertTransition(ctx(PM, 'TODO', 'IN_PROGRESS', { blockedBy: UNMET }));
    expect(attempt).toThrow(ForbiddenError);
    try {
      attempt();
    } catch (err) {
      expect((err as ForbiddenError).details).toEqual(UNMET);
    }
  });

  test.each([
    ['IN_PROGRESS', 'DONE'],
    ['TODO', 'DONE'],
  ] as const)('may never complete a task (%s -> %s)', (from, to) => {
    expect(() => assertTransition(ctx(PM, from, to))).toThrow(ForbiddenError);
  });

  test('may never complete a task even when it is also blocked', () => {
    expect(() => assertTransition(ctx(PM, 'TODO', 'DONE', { blockedBy: UNMET }))).toThrow(
      ForbiddenError,
    );
  });

  test.each([
    ['IN_PROGRESS', 'TODO'],
    ['DONE', 'IN_PROGRESS'],
    ['DONE', 'TODO'],
  ] as const)('may send a task back (%s -> %s), even while it is blocked', (from, to) => {
    expect(() => assertTransition(ctx(PM, from, to, { blockedBy: UNMET }))).not.toThrow();
  });

  test.each(['TODO', 'IN_PROGRESS'] as const)('rejects a no-op move to %s', (status) => {
    expect(() => assertTransition(ctx(PM, status, status))).toThrow(ValidationError);
  });

  test('a no-op move to Done is refused as a completion, not as a no-op', () => {
    expect(() => assertTransition(ctx(PM, 'DONE', 'DONE'))).toThrow(ForbiddenError);
  });
});

describe('assertTransition — Internal Team', () => {
  test('the unassigned same-department member may start a task', () => {
    expect(() => assertTransition(ctx(BACKEND, 'TODO', 'IN_PROGRESS'))).not.toThrow();
  });

  test('the assignee may complete an in-progress task', () => {
    expect(() =>
      assertTransition(
        ctx(BACKEND, 'IN_PROGRESS', 'DONE', {
          task: { status: 'IN_PROGRESS', department: 'BACKEND', assigneeId: BACKEND.sub },
        }),
      ),
    ).not.toThrow();
  });

  test('a non-member is refused', () => {
    expect(() =>
      assertTransition(ctx(BACKEND, 'TODO', 'IN_PROGRESS', { isProjectMember: false })),
    ).toThrow(ForbiddenError);
  });

  test('another department is refused', () => {
    expect(() => assertTransition(ctx(FRONTEND, 'TODO', 'IN_PROGRESS'))).toThrow(ForbiddenError);
  });

  test('someone other than the assignee is refused', () => {
    expect(() =>
      assertTransition(
        ctx(BACKEND, 'TODO', 'IN_PROGRESS', {
          task: { status: 'TODO', department: 'BACKEND', assigneeId: 'someone-else' },
        }),
      ),
    ).toThrow(ForbiddenError);
  });

  test.each([
    ['TODO', 'DONE'],
    ['IN_PROGRESS', 'TODO'],
    ['DONE', 'IN_PROGRESS'],
    ['TODO', 'TODO'],
  ] as const)('must progress one step at a time (%s -> %s is refused)', (from, to) => {
    expect(() => assertTransition(ctx(BACKEND, from, to))).toThrow(ForbiddenError);
  });

  test('a blocked task cannot be started', () => {
    expect(() =>
      assertTransition(ctx(BACKEND, 'TODO', 'IN_PROGRESS', { blockedBy: UNMET })),
    ).toThrow(ForbiddenError);
  });

  test('a task that became blocked while in progress cannot be completed', () => {
    expect(() =>
      assertTransition(
        ctx(BACKEND, 'IN_PROGRESS', 'DONE', {
          task: { status: 'IN_PROGRESS', department: 'BACKEND', assigneeId: BACKEND.sub },
          blockedBy: UNMET,
        }),
      ),
    ).toThrow(ForbiddenError);
  });
});

describe('assertTransition — Client Guest', () => {
  test.each([
    ['TODO', 'IN_PROGRESS'],
    ['IN_PROGRESS', 'DONE'],
  ] as const)('is always refused (%s -> %s)', (from, to) => {
    expect(() => assertTransition(ctx(CLIENT, from, to))).toThrow(ForbiddenError);
  });
});

describe('assertAssignable', () => {
  const member = { role: 'INTERNAL', department: 'BACKEND' } as const;
  const check = (overrides: Partial<Parameters<typeof assertAssignable>[0]> = {}) =>
    assertAssignable({
      candidate: member,
      isProjectMember: true,
      taskDepartment: 'BACKEND',
      ...overrides,
    });

  test('accepts an Internal Team member of the project from the task department', () => {
    expect(() => check()).not.toThrow();
  });

  test('rejects a user that does not exist or was deleted', () => {
    expect(() => check({ candidate: null })).toThrow(ValidationError);
  });

  test.each([
    ['a Client Guest', { role: 'CLIENT', department: null }],
    ['a PM, who can never complete a task', { role: 'PM', department: null }],
  ] as const)('rejects %s', (_label, candidate) => {
    expect(() => check({ candidate })).toThrow(ValidationError);
  });

  test('rejects someone who is not a member of the task project', () => {
    expect(() => check({ isProjectMember: false })).toThrow(ValidationError);
  });

  test('rejects a member of another department', () => {
    expect(() => check({ taskDepartment: 'FRONTEND' })).toThrow(ValidationError);
  });
});
