import type { Department, Prisma, TaskStatus } from '../../generated/prisma/client';
import type {
  AddAttachmentInput,
  AddCommentInput,
  AddDependencyInput,
  CreateTaskInput,
  UpdateTaskInput,
  UpdateTaskStatusInput,
} from '../dto/task.dto';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors';
import type { JwtPayload } from '../lib/jwt';
import { prisma } from '../lib/prisma';
import { buildListQuery, type ListQuerySpec, paginate } from '../lib/query-filter';
import { recordAudit } from './audit.service';
import { assertAssignable, assertTransition } from './task-policy';

const internalTaskListSpec: ListQuerySpec = {
  allowedFields: [
    'title',
    'status',
    'department',
    'assigneeId',
    'projectId',
    'isClientVisible',
    'createdAt',
  ],
  searchableFields: ['title', 'description'],
  maxPageSize: 100,
  defaultPageSize: 10,
};

const auditLogListSpec: ListQuerySpec = {
  allowedFields: ['action', 'userId', 'changedColumn', 'createdAt'],
  searchableFields: ['changedColumn'],
  maxPageSize: 100,
  defaultPageSize: 10,
};

// A removed member keeps their row with deletedAt set, and only active memberships grant access.
const activeMemberIds = { where: { deletedAt: null }, select: { userId: true } } as const;

// Department is an internal identity and every visible task is client-visible already, so a
// Client Guest cannot filter, search or sort on them — that would leak what the response masks.
const clientTaskListSpec: ListQuerySpec = {
  ...internalTaskListSpec,
  allowedFields: ['title', 'status', 'projectId', 'createdAt'],
};

const taskInclude = {
  project: { select: { id: true, name: true, members: activeMemberIds } },
  assignee: { select: { id: true, name: true, avatarUrl: true, department: true } },
  dependsOn: {
    include: {
      dependsOnTask: { select: { id: true, title: true, status: true, isClientVisible: true } },
    },
  },
  attachments: { where: { deletedAt: null } },
  comments: {
    where: { deletedAt: null },
    include: { author: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'asc' as const },
  },
} satisfies Prisma.TaskInclude;

type TaskWithRelations = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

// Narrower than Pick<TaskWithRelations, 'dependsOn'> on purpose: this is all the shape
// computeBlocked actually reads, so plain fixtures (in tests) satisfy it without having
// to fake unrelated TaskDependency columns.
interface BlockableTask {
  dependsOn: { dependsOnTask: { id: string; title: string; status: TaskStatus } }[];
}

export function computeBlocked(task: BlockableTask) {
  const unmet = task.dependsOn.filter((d) => d.dependsOnTask.status !== 'DONE');
  return {
    isBlocked: unmet.length > 0,
    blockedBy: unmet.map((d) => ({
      id: d.dependsOnTask.id,
      title: d.dependsOnTask.title,
      status: d.dependsOnTask.status,
    })),
  };
}

/**
 * Client Guests must never see internal identities (assignee name/avatar/department)
 * or internal-only comment history — stripped here, at the API boundary, rather than
 * relying on the frontend to hide it.
 */
function toClientTask(task: TaskWithRelations) {
  const { isBlocked, blockedBy } = computeBlocked(task);
  const visiblePrerequisiteIds = new Set(
    task.dependsOn.filter((d) => d.dependsOnTask.isClientVisible).map((d) => d.dependsOnTask.id),
  );

  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    description: task.description,
    status: task.status,
    // department is an internal identity per the brief's masking rule — omitted here.
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    isBlocked,
    // A prerequisite the client cannot see must not be named: its id, title and status are
    // internal. `isBlocked` still reflects it so the UI can say "waiting on another task".
    blockedBy: blockedBy.filter((b) => visiblePrerequisiteIds.has(b.id)),
    attachments: task.attachments.map((a) => ({
      id: a.id,
      fileName: a.fileName,
      fileUrl: a.fileUrl,
      createdAt: a.createdAt,
    })),
    comments: task.comments
      .filter((c) => !c.isInternal)
      .map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt })),
  };
}

function toInternalTask(task: TaskWithRelations) {
  return { ...task, ...computeBlocked(task) };
}

function serialize(task: TaskWithRelations, role: JwtPayload['role']) {
  return role === 'CLIENT' ? toClientTask(task) : toInternalTask(task);
}

export async function listTasks(
  user: JwtPayload,
  rawQuery: Record<string, string | string[] | undefined>,
) {
  let mandatoryWhere: Record<string, unknown> = { deletedAt: null };
  const isActiveMember = { members: { some: { userId: user.sub, deletedAt: null } } };
  if (user.role === 'INTERNAL') {
    mandatoryWhere = { ...mandatoryWhere, project: isActiveMember };
  } else if (user.role === 'CLIENT') {
    mandatoryWhere = { ...mandatoryWhere, isClientVisible: true, project: isActiveMember };
  }

  const listQuery = buildListQuery(
    rawQuery,
    user.role === 'CLIENT' ? clientTaskListSpec : internalTaskListSpec,
    mandatoryWhere,
  );

  const [rows, totalData] = await Promise.all([
    prisma.task.findMany({ ...listQuery, include: taskInclude }),
    prisma.task.count({ where: listQuery.where }),
  ]);

  return paginate(
    rows.map((row) => serialize(row, user.role)),
    totalData,
    listQuery.take,
  );
}

export async function getTask(user: JwtPayload, taskId: string) {
  const task = await prisma.task.findFirst({
    where: { id: taskId, deletedAt: null },
    include: taskInclude,
  });
  if (!task) throw new NotFoundError('Task not found');

  const isMember = task.project.members.some((m) => m.userId === user.sub);

  if (user.role === 'INTERNAL' && !isMember) {
    throw new ForbiddenError('You do not have access to this project');
  }
  if (user.role === 'CLIENT' && (!isMember || !task.isClientVisible)) {
    throw new ForbiddenError('You do not have access to this task');
  }

  return serialize(task, user.role);
}

export async function createTask(user: JwtPayload, input: CreateTaskInput) {
  const project = await prisma.project.findFirst({
    where: { id: input.projectId, deletedAt: null },
  });
  if (!project) throw new NotFoundError('Project not found');

  // A repeated id is the same dependency, not an error.
  const dependencyIds = [...new Set(input.dependsOnTaskIds)];

  return prisma.$transaction(async (tx) => {
    if (input.assigneeId) {
      await assertAssigneeAllowed(tx, input.assigneeId, input);
    }

    if (dependencyIds.length > 0) {
      const found = await tx.task.count({
        where: { id: { in: dependencyIds }, projectId: input.projectId, deletedAt: null },
      });
      if (found !== dependencyIds.length) {
        throw new ValidationError('Every dependency must be an existing task in the same project');
      }
    }

    const task = await tx.task.create({
      data: {
        projectId: input.projectId,
        title: input.title,
        description: input.description,
        department: input.department,
        assigneeId: input.assigneeId,
        isClientVisible: input.isClientVisible ?? false,
      },
    });

    await tx.taskDependency.createMany({
      data: dependencyIds.map((dependsOnTaskId) => ({ taskId: task.id, dependsOnTaskId })),
    });

    await recordAudit(tx, { taskId: task.id, userId: user.sub, action: 'CREATE' });
    return task;
  });
}

/** Loads the facts `assertAssignable` needs, inside the caller's transaction. */
async function assertAssigneeAllowed(
  tx: Prisma.TransactionClient,
  assigneeId: string,
  task: { projectId: string; department: Department },
) {
  const candidate = await tx.user.findFirst({
    where: { id: assigneeId, deletedAt: null },
    select: {
      role: true,
      department: true,
      projectMemberships: {
        where: { projectId: task.projectId, deletedAt: null },
        select: { id: true },
      },
    },
  });

  assertAssignable({
    candidate,
    isProjectMember: (candidate?.projectMemberships.length ?? 0) > 0,
    taskDepartment: task.department,
  });
}

/** PM-only: core fields (title/description/assignee/client-visibility). Optimistic-locked. */
export async function updateTask(user: JwtPayload, taskId: string, input: UpdateTaskInput) {
  const existing = await prisma.task.findFirst({ where: { id: taskId, deletedAt: null } });
  if (!existing) throw new NotFoundError('Task not found');

  const changes: { column: string; oldValue: unknown; newValue: unknown }[] = [];
  const data: Prisma.TaskUncheckedUpdateManyInput = {};

  if (input.title !== undefined && input.title !== existing.title) {
    changes.push({ column: 'title', oldValue: existing.title, newValue: input.title });
    data.title = input.title;
  }
  if (input.description !== undefined && input.description !== existing.description) {
    changes.push({
      column: 'description',
      oldValue: existing.description,
      newValue: input.description,
    });
    data.description = input.description;
  }
  // `undefined` means "leave the assignee alone"; null unassigns.
  const newAssigneeId = input.assigneeId !== existing.assigneeId ? input.assigneeId : undefined;
  if (newAssigneeId !== undefined) {
    changes.push({ column: 'assigneeId', oldValue: existing.assigneeId, newValue: newAssigneeId });
    data.assigneeId = newAssigneeId;
  }
  if (input.isClientVisible !== undefined && input.isClientVisible !== existing.isClientVisible) {
    changes.push({
      column: 'isClientVisible',
      oldValue: existing.isClientVisible,
      newValue: input.isClientVisible,
    });
    data.isClientVisible = input.isClientVisible;
  }

  if (changes.length === 0) {
    return existing;
  }

  return prisma.$transaction(async (tx) => {
    if (newAssigneeId) {
      await assertAssigneeAllowed(tx, newAssigneeId, existing);
    }

    const result = await tx.task.updateMany({
      where: { id: taskId, version: input.version },
      data: { ...data, version: { increment: 1 } },
    });
    if (result.count === 0) {
      throw new ConflictError('This task was changed by someone else. Refresh and try again.');
    }
    await recordAudit(tx, { taskId, userId: user.sub, action: 'UPDATE', changes });
    return tx.task.findUniqueOrThrow({ where: { id: taskId } });
  });
}

/**
 * State-based status transition. The rules live in `assertTransition` (task-policy.ts);
 * this loads the facts it needs, then does an optimistic-locked write so two concurrent
 * editors can't silently clobber each other.
 */
export async function updateTaskStatus(
  user: JwtPayload,
  taskId: string,
  input: UpdateTaskStatusInput,
) {
  const task = await prisma.task.findFirst({
    where: { id: taskId, deletedAt: null },
    include: {
      project: { select: { members: activeMemberIds } },
      dependsOn: {
        include: { dependsOnTask: { select: { id: true, title: true, status: true } } },
      },
    },
  });
  if (!task) throw new NotFoundError('Task not found');

  assertTransition({
    actor: user,
    task,
    isProjectMember: task.project.members.some((m) => m.userId === user.sub),
    to: input.status,
    blockedBy: computeBlocked(task).blockedBy,
  });

  return prisma.$transaction(async (tx) => {
    const result = await tx.task.updateMany({
      where: { id: taskId, version: input.version },
      data: { status: input.status, version: { increment: 1 } },
    });
    if (result.count === 0) {
      throw new ConflictError('This task was changed by someone else. Refresh and try again.');
    }
    await recordAudit(tx, {
      taskId,
      userId: user.sub,
      action: 'STATUS_CHANGE',
      changes: [{ column: 'status', oldValue: task.status, newValue: input.status }],
    });
    return tx.task.findUniqueOrThrow({ where: { id: taskId } });
  });
}

/**
 * PM and Internal Team members of the project can review a task's history. It is a list like
 * any other, so it follows the query contract, newest first unless an order is asked for.
 */
export async function listAuditLogs(
  user: JwtPayload,
  taskId: string,
  rawQuery: Record<string, string | string[] | undefined>,
) {
  const task = await prisma.task.findFirst({
    where: { id: taskId, deletedAt: null },
    include: { project: { select: { members: activeMemberIds } } },
  });
  if (!task) throw new NotFoundError('Task not found');
  if (user.role === 'CLIENT') {
    throw new ForbiddenError('Client guests cannot view audit history');
  }
  const isMember = task.project.members.some((m) => m.userId === user.sub);
  if (user.role === 'INTERNAL' && !isMember) {
    throw new ForbiddenError('You do not have access to this project');
  }

  const listQuery = buildListQuery(rawQuery, auditLogListSpec, { taskId });
  const [rows, totalData] = await Promise.all([
    prisma.auditLog.findMany({
      ...listQuery,
      // ezfilter answers with an empty object when no order was asked for.
      orderBy:
        Object.keys(listQuery.orderBy ?? {}).length > 0 ? listQuery.orderBy : { createdAt: 'desc' },
      include: { user: { select: { id: true, name: true, role: true } } },
    }),
    prisma.auditLog.count({ where: listQuery.where }),
  ]);

  return paginate(rows, totalData, listQuery.take);
}

/** Does `startTaskId` already (transitively) depend on `targetTaskId`? */
async function wouldCreateCycle(startTaskId: string, targetTaskId: string): Promise<boolean> {
  const visited = new Set<string>();
  const queue = [startTaskId];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (current === targetTaskId) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    const deps = await prisma.taskDependency.findMany({
      where: { taskId: current },
      select: { dependsOnTaskId: true },
    });
    queue.push(...deps.map((d) => d.dependsOnTaskId));
  }

  return false;
}

/** PM-only: declares that `taskId` cannot start until `dependsOnTaskId` is Done. */
export async function addDependency(user: JwtPayload, taskId: string, input: AddDependencyInput) {
  if (taskId === input.dependsOnTaskId) {
    throw new ValidationError('A task cannot depend on itself');
  }

  const [task, dependsOnTask] = await Promise.all([
    prisma.task.findFirst({ where: { id: taskId, deletedAt: null } }),
    prisma.task.findFirst({ where: { id: input.dependsOnTaskId, deletedAt: null } }),
  ]);
  if (!task || !dependsOnTask) throw new NotFoundError('Task not found');
  if (task.projectId !== dependsOnTask.projectId) {
    throw new ValidationError('Dependencies must be within the same project');
  }
  if (await wouldCreateCycle(input.dependsOnTaskId, taskId)) {
    throw new ValidationError('This dependency would create a circular reference');
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const dependency = await tx.taskDependency.create({
        data: { taskId, dependsOnTaskId: input.dependsOnTaskId },
      });
      await recordAudit(tx, {
        taskId,
        userId: user.sub,
        action: 'UPDATE',
        changes: [{ column: 'dependency', oldValue: null, newValue: input.dependsOnTaskId }],
      });
      return dependency;
    });
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
      throw new ValidationError('This dependency already exists');
    }
    throw err;
  }
}

async function assertCanCollaborate(user: JwtPayload, taskId: string) {
  const task = await prisma.task.findFirst({
    where: { id: taskId, deletedAt: null },
    include: { project: { select: { members: activeMemberIds } } },
  });
  if (!task) throw new NotFoundError('Task not found');
  if (user.role === 'CLIENT') {
    throw new ForbiddenError('Client guests cannot do this');
  }
  const isMember = task.project.members.some((m) => m.userId === user.sub);
  if (user.role === 'INTERNAL' && !isMember) {
    throw new ForbiddenError('You do not have access to this project');
  }
  return task;
}

/**
 * Comments are part of the collaborative workflow. Only a PM may mark one
 * client-visible; an Internal Team author's comment is always internal-only,
 * so an engineer can never accidentally leak a note to the Client Guest view.
 */
export async function addComment(user: JwtPayload, taskId: string, input: AddCommentInput) {
  await assertCanCollaborate(user, taskId);
  const isInternal = user.role === 'PM' ? (input.isInternal ?? true) : true;

  return prisma.taskComment.create({
    data: { taskId, authorId: user.sub, body: input.body, isInternal },
    include: { author: { select: { id: true, name: true } } },
  });
}

/**
 * "Upload" is link-based (fileName + fileUrl) rather than binary upload, since no object
 * storage is provisioned for this scaffold — see the frontend README for the tradeoff.
 */
export async function addAttachment(user: JwtPayload, taskId: string, input: AddAttachmentInput) {
  await assertCanCollaborate(user, taskId);

  return prisma.$transaction(async (tx) => {
    const attachment = await tx.taskAttachment.create({
      data: {
        taskId,
        uploadedById: user.sub,
        fileName: input.fileName,
        fileUrl: input.fileUrl,
      },
    });
    await recordAudit(tx, {
      taskId,
      userId: user.sub,
      action: 'UPDATE',
      changes: [{ column: 'attachment', oldValue: null, newValue: input.fileName }],
    });
    return attachment;
  });
}

/** PM-only, optimistic-locked soft delete — the row is kept, never removed. */
export async function deleteTask(user: JwtPayload, taskId: string, version: number) {
  const task = await prisma.task.findFirst({ where: { id: taskId, deletedAt: null } });
  if (!task) throw new NotFoundError('Task not found');

  await prisma.$transaction(async (tx) => {
    const result = await tx.task.updateMany({
      where: { id: taskId, version },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });
    if (result.count === 0) {
      throw new ConflictError('This task was changed by someone else. Refresh and try again.');
    }
    await recordAudit(tx, { taskId, userId: user.sub, action: 'DELETE' });
  });
}
