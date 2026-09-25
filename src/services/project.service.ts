import type { CreateProjectInput } from '../dto/project.dto';
import { ForbiddenError, NotFoundError } from '../lib/errors';
import type { JwtPayload } from '../lib/jwt';
import { prisma } from '../lib/prisma';
import { buildListQuery, type ListQuerySpec, paginate } from '../lib/query-filter';

const projectListSpec: ListQuerySpec = {
  allowedFields: ['name', 'createdAt'],
  searchableFields: ['name'],
  maxPageSize: 100,
  defaultPageSize: 10,
};

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
    mandatoryWhere = { ...mandatoryWhere, members: { some: { userId: user.sub } } };
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
    include: {
      members: {
        include: { user: { select: { id: true, name: true, role: true, department: true } } },
      },
    },
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

export async function createProject(user: JwtPayload, input: CreateProjectInput) {
  return prisma.project.create({
    data: {
      name: input.name,
      description: input.description,
      createdById: user.sub,
      members: input.memberUserIds?.length
        ? { create: input.memberUserIds.map((userId) => ({ userId })) }
        : undefined,
    },
    include: { members: true },
  });
}

/** PM-only soft delete — the row and all its tasks/history are kept, never removed. */
export async function deleteProject(projectId: string) {
  const project = await prisma.project.findFirst({ where: { id: projectId, deletedAt: null } });
  if (!project) throw new NotFoundError('Project not found');

  await prisma.project.update({ where: { id: projectId }, data: { deletedAt: new Date() } });
}
