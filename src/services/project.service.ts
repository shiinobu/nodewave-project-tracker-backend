import type { CreateProjectInput, UpdateProjectInput } from '../dto/project.dto';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors';
import type { JwtPayload } from '../lib/jwt';
import { prisma } from '../lib/prisma';
import { buildListQuery, type ListQuerySpec, paginate } from '../lib/query-filter';

const projectListSpec: ListQuerySpec = {
  allowedFields: ['name', 'createdAt'],
  searchableFields: ['name', 'description'],
  maxPageSize: 100,
  defaultPageSize: 10,
};

// A removed member keeps their row (deletedAt is set), so every read of members goes through
// this filter and a removed member never shows up or keeps access.
const memberUser = { select: { id: true, name: true, role: true, department: true } } as const;
const activeMembers = { where: { deletedAt: null }, include: { user: memberUser } } as const;

interface ProjectSummary {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
}

async function attachClientMetrics(project: ProjectSummary) {
  const [total, done] = await Promise.all([
    prisma.task.count({ where: { projectId: project.id, deletedAt: null } }),
    prisma.task.count({ where: { projectId: project.id, deletedAt: null, status: 'DONE' } }),
  ]);
  const percentComplete = total === 0 ? 0 : Math.round((done / total) * 100);

  return {
    id: project.id,
    name: project.name,
    description: project.description,
    percentComplete,
    totalTasks: total,
    completedTasks: done,
  };
}

export async function listProjects(
  user: JwtPayload,
  rawQuery: Record<string, string | string[] | undefined>,
) {
  let mandatoryWhere: Record<string, unknown> = { deletedAt: null };
  if (user.role !== 'PM') {
    mandatoryWhere = {
      ...mandatoryWhere,
      members: { some: { userId: user.sub, deletedAt: null } },
    };
  }

  const listQuery = buildListQuery(rawQuery, projectListSpec, mandatoryWhere);

  const [projects, totalData] = await Promise.all([
    prisma.project.findMany({ ...listQuery }),
    prisma.project.count({ where: listQuery.where }),
  ]);

  if (user.role !== 'CLIENT') {
    return paginate(projects, totalData, listQuery.take);
  }

  const withMetrics = await Promise.all(projects.map(attachClientMetrics));
  return paginate(withMetrics, totalData, listQuery.take);
}

export async function getProject(user: JwtPayload, projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    include: { members: activeMembers },
  });
  if (!project) throw new NotFoundError('Project not found');

  const isMember = project.members.some((m) => m.userId === user.sub);
  if (user.role !== 'PM' && !isMember) {
    throw new ForbiddenError('You do not have access to this project');
  }

  if (user.role === 'CLIENT') {
    return attachClientMetrics(project);
  }

  return project;
}

/** Only Internal Team and Client Guest accounts are members: a PM already sees every project. */
async function assertCanBeMembers(userIds: string[]) {
  if (userIds.length === 0) return;

  const found = await prisma.user.count({
    where: { id: { in: userIds }, deletedAt: null, role: { in: ['INTERNAL', 'CLIENT'] } },
  });
  if (found !== userIds.length) {
    throw new ValidationError(
      'Every member must be an existing Internal Team or Client Guest account',
    );
  }
}

export async function createProject(user: JwtPayload, input: CreateProjectInput) {
  const memberIds = [...new Set(input.memberUserIds ?? [])];
  await assertCanBeMembers(memberIds);

  return prisma.project.create({
    data: {
      name: input.name,
      description: input.description,
      createdById: user.sub,
      members: memberIds.length ? { create: memberIds.map((userId) => ({ userId })) } : undefined,
    },
    include: { members: activeMembers },
  });
}

/** PM-only: name and description. The members have their own operations below. */
export async function updateProject(projectId: string, input: UpdateProjectInput) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true },
  });
  if (!project) throw new NotFoundError('Project not found');

  return prisma.project.update({
    where: { id: projectId },
    data: { name: input.name, description: input.description },
    include: { members: activeMembers },
  });
}

/** PM-only. Adding someone who was removed earlier reactivates their old row. */
export async function addProjectMember(projectId: string, userId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true },
  });
  if (!project) throw new NotFoundError('Project not found');

  const candidate = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { role: true },
  });
  if (!candidate) throw new NotFoundError('User not found');
  if (candidate.role === 'PM') {
    throw new ValidationError(
      'Product Managers already see every project; only Internal Team and Client Guest accounts can be members',
    );
  }

  const existing = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
  });
  if (existing && existing.deletedAt === null) {
    throw new ConflictError('This user is already a member of the project');
  }

  return existing
    ? prisma.projectMember.update({
        where: { id: existing.id },
        data: { deletedAt: null },
        include: { user: memberUser },
      })
    : prisma.projectMember.create({ data: { projectId, userId }, include: { user: memberUser } });
}

/**
 * PM-only soft delete of a membership. A member who still has unfinished tasks in the project
 * cannot be removed: those tasks would be left with an assignee who can no longer open them.
 */
export async function removeProjectMember(projectId: string, userId: string) {
  const membership = await prisma.projectMember.findFirst({
    where: { projectId, userId, deletedAt: null, project: { deletedAt: null } },
  });
  if (!membership) throw new NotFoundError('Member not found');

  const unfinished = await prisma.task.count({
    where: { projectId, assigneeId: userId, deletedAt: null, status: { not: 'DONE' } },
  });
  if (unfinished > 0) {
    throw new ValidationError(
      `This member still has ${unfinished} unfinished ${unfinished === 1 ? 'task' : 'tasks'} in the project. Reassign them first`,
    );
  }

  await prisma.projectMember.update({
    where: { id: membership.id },
    data: { deletedAt: new Date() },
  });
}

/** PM-only soft delete — the row and all its tasks/history are kept, never removed. */
export async function deleteProject(projectId: string) {
  const project = await prisma.project.findFirst({ where: { id: projectId, deletedAt: null } });
  if (!project) throw new NotFoundError('Project not found');

  await prisma.project.update({ where: { id: projectId }, data: { deletedAt: new Date() } });
}
