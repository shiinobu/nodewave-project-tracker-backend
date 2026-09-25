import type { Department, TaskStatus } from '../../generated/prisma/client';
import { ForbiddenError, ValidationError } from '../lib/errors';
import type { JwtPayload } from '../lib/jwt';

/**
 * Pure business rules for task state changes. No I/O, so every branch can be table-tested
 * without a database; task.service.ts loads the facts and calls in here.
 */

const STATUS_ORDER: Record<TaskStatus, number> = { TODO: 0, IN_PROGRESS: 1, DONE: 2 };

export interface TransitionContext {
  actor: Pick<JwtPayload, 'sub' | 'role' | 'department'>;
  task: { status: TaskStatus; department: Department; assigneeId: string | null };
  isProjectMember: boolean;
  to: TaskStatus;
  /** Prerequisites that are not Done yet (empty when the task is not blocked). */
  blockedBy: { id: string; title: string; status: TaskStatus }[];
}

/**
 * State-based status transition. Throws when the actor may not move the task to `to`:
 * - Client Guests never change status.
 * - A PM may reopen or start work but never completes it — only the executor can.
 * - An Internal Team member needs project membership, the task's department, to be the
 *   assignee (when there is one), and must advance exactly one step.
 * - Any forward move is refused while a prerequisite is unfinished. This is a data
 *   invariant, not a role permission, so no role branch above can skip it.
 */
export function assertTransition({
  actor,
  task,
  isProjectMember,
  to,
  blockedBy,
}: TransitionContext): void {
  if (actor.role === 'CLIENT') {
    throw new ForbiddenError('Client guests cannot change task status');
  }

  if (actor.role === 'PM') {
    if (to === 'DONE') {
      throw new ForbiddenError('Only the assigned executor can move a task to Done');
    }
    if (to === task.status) {
      throw new ValidationError(`Task is already ${task.status}`);
    }
  } else {
    if (!isProjectMember || actor.department !== task.department) {
      throw new ForbiddenError(
        'You can only update tasks in your own department on projects assigned to you',
      );
    }
    if (task.assigneeId && task.assigneeId !== actor.sub) {
      throw new ForbiddenError('Only the assigned executor can change this task status');
    }
    if (STATUS_ORDER[to] !== STATUS_ORDER[task.status] + 1) {
      throw new ForbiddenError(
        `Task must progress in order; cannot move from ${task.status} to ${to}`,
      );
    }
  }

  const movesForward = STATUS_ORDER[to] > STATUS_ORDER[task.status];
  if (movesForward && blockedBy.length > 0) {
    throw new ForbiddenError('Task is blocked by incomplete dependencies', blockedBy);
  }
}

export interface AssigneeContext {
  /** The user being assigned, or null when no such (non-deleted) user exists. */
  candidate: { role: JwtPayload['role']; department: Department | null } | null;
  isProjectMember: boolean;
  taskDepartment: Department;
}

/**
 * Who may be the executor of a task: an Internal Team member of the task's project, from
 * the task's own department — exactly what the assignee picker offers. A Client Guest or a
 * PM as executor would leave a task nobody is allowed to complete.
 */
export function assertAssignable({
  candidate,
  isProjectMember,
  taskDepartment,
}: AssigneeContext): void {
  if (!candidate) {
    throw new ValidationError('Assignee not found');
  }
  if (candidate.role !== 'INTERNAL') {
    throw new ValidationError('Only Internal Team members can be assigned to a task');
  }
  if (!isProjectMember) {
    throw new ValidationError('The assignee must be a member of the project');
  }
  if (candidate.department !== taskDepartment) {
    throw new ValidationError(`The assignee must belong to the ${taskDepartment} department`);
  }
}
