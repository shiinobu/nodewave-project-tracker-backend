import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors';
import type { JwtPayload } from '../lib/jwt';
import { hashPassword } from '../lib/password';
import { prisma } from '../lib/prisma';
import {
  addProjectMember,
  createProject,
  getProject,
  listProjects,
  removeProjectMember,
  updateProject,
} from './project.service';
import {
  addComment,
  createTask,
  getTask,
  listAuditLogs,
  listTasks,
  updateTaskStatus,
} from './task.service';

// Every fixture is namespaced under this run's id, so repeated local runs against a real dev
// database and parallel CI runs never collide with seed data or each other.
const RUN = `prj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe('project.service membership and editing (real database)', () => {
  let pm: JwtPayload;
  let otherPm: { id: string };
  let owner: { id: string }; // INTERNAL / BACKEND, member from the start, has open work
  let candidate: { id: string }; // INTERNAL / BACKEND, not a member yet
  let finisher: { id: string }; // INTERNAL / BACKEND, member, only has a Done task
  let client: { id: string };
  let projectId: string;
  let openTask: { id: string; version: number };

  const internal = (id: string): JwtPayload => ({
    sub: id,
    email: '',
    role: 'INTERNAL',
    department: 'BACKEND',
  });
  const asClient = (id: string): JwtPayload => ({ sub: id, email: '', role: 'CLIENT' });
  const visibleProjectIds = async (user: JwtPayload) =>
    (await listProjects(user, {})).entries.map((p) => p.id);
  const visibleTaskIds = async (user: JwtPayload) =>
    (await listTasks(user, { filters: JSON.stringify({ projectId }) })).entries.map((t) => t.id);
  const membershipRow = (userId: string) =>
    prisma.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } } });

  beforeAll(async () => {
    const password = await hashPassword('password123');
    const user = (label: string, role: 'PM' | 'INTERNAL' | 'CLIENT') =>
      prisma.user.create({
        data: {
          email: `${RUN}-${label}@test.local`,
          password,
          name: label,
          role,
          department: role === 'INTERNAL' ? 'BACKEND' : undefined,
        },
      });

    const pmRow = await user('pm', 'PM');
    otherPm = await user('other-pm', 'PM');
    owner = await user('owner', 'INTERNAL');
    candidate = await user('candidate', 'INTERNAL');
    finisher = await user('finisher', 'INTERNAL');
    client = await user('client', 'CLIENT');
    pm = { sub: pmRow.id, email: '', role: 'PM' };

    const project = await prisma.project.create({
      data: {
        name: `${RUN}-project`,
        description: 'original',
        createdById: pmRow.id,
        members: { create: [{ userId: owner.id }, { userId: finisher.id }] },
      },
    });
    projectId = project.id;

    openTask = await prisma.task.create({
      data: {
        projectId,
        title: `${RUN}-open`,
        department: 'BACKEND',
        assigneeId: owner.id,
        isClientVisible: true,
      },
    });
    await prisma.task.create({
      data: {
        projectId,
        title: `${RUN}-done`,
        department: 'BACKEND',
        assigneeId: finisher.id,
        status: 'DONE',
      },
    });
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { task: { projectId } } });
    await prisma.taskComment.deleteMany({ where: { task: { projectId } } });
    await prisma.task.deleteMany({ where: { projectId } });
    await prisma.projectMember.deleteMany({ where: { projectId } });
    await prisma.project.deleteMany({ where: { id: projectId } });
    await prisma.user.deleteMany({ where: { email: { startsWith: `${RUN}-` } } });
  });

  describe('updateProject', () => {
    test('changes the name and the description', async () => {
      const updated = await updateProject(projectId, {
        name: `${RUN}-renamed`,
        description: 'new',
      });
      expect(updated.name).toBe(`${RUN}-renamed`);
      expect(updated.description).toBe('new');
      const row = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
      expect(row.name).toBe(`${RUN}-renamed`);
    });

    test('leaves the fields that were not sent alone', async () => {
      await updateProject(projectId, { name: `${RUN}-project` });
      const row = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
      expect(row.name).toBe(`${RUN}-project`);
      expect(row.description).toBe('new');
    });

    test('is a 404 for a project that does not exist', async () => {
      await expect(updateProject('does-not-exist', { name: 'x' })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    test('lists the current members with their identity, for the PM screen', async () => {
      const updated = await updateProject(projectId, { description: 'original' });
      const names = updated.members.map((m) => m.user.name).sort();
      expect(names).toEqual(['finisher', 'owner']);
    });
  });

  describe('addProjectMember', () => {
    test('an Internal Team member who is added can see the project and its tasks', async () => {
      const user = internal(candidate.id);
      expect(await visibleProjectIds(user)).not.toContain(projectId);
      expect(await visibleTaskIds(user)).not.toContain(openTask.id);
      await expect(getTask(user, openTask.id)).rejects.toBeInstanceOf(ForbiddenError);

      const member = await addProjectMember(projectId, candidate.id);
      expect(member.user.id).toBe(candidate.id);

      expect(await visibleProjectIds(user)).toContain(projectId);
      expect(await visibleTaskIds(user)).toContain(openTask.id);
      expect((await getTask(user, openTask.id)).id).toBe(openTask.id);
    });

    test('a Client Guest can be added too, and sees only the shared task', async () => {
      await addProjectMember(projectId, client.id);
      const ids = await visibleTaskIds(asClient(client.id));
      expect(ids).toEqual([openTask.id]);
    });

    test('is refused for a user who is already a member', async () => {
      await expect(addProjectMember(projectId, owner.id)).rejects.toBeInstanceOf(ConflictError);
    });

    test('is refused for a PM, who already sees everything', async () => {
      await expect(addProjectMember(projectId, otherPm.id)).rejects.toBeInstanceOf(ValidationError);
      expect(await membershipRow(otherPm.id)).toBeNull();
    });

    test('is a 404 for a user or a project that does not exist', async () => {
      await expect(addProjectMember(projectId, 'nobody')).rejects.toBeInstanceOf(NotFoundError);
      await expect(addProjectMember('nowhere', owner.id)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('removeProjectMember', () => {
    test('takes the access away everywhere and keeps the row as a soft delete', async () => {
      const user = internal(finisher.id);
      expect(await visibleTaskIds(user)).toContain(openTask.id);

      await removeProjectMember(projectId, finisher.id);

      const row = await membershipRow(finisher.id);
      expect(row).not.toBeNull();
      expect(row?.deletedAt).not.toBeNull();

      expect(await visibleProjectIds(user)).not.toContain(projectId);
      expect(await visibleTaskIds(user)).not.toContain(openTask.id);
      await expect(getTask(user, openTask.id)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        updateTaskStatus(user, openTask.id, { status: 'IN_PROGRESS', version: openTask.version }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(addComment(user, openTask.id, { body: 'still here?' })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(listAuditLogs(user, openTask.id, {})).rejects.toBeInstanceOf(ForbiddenError);
    });

    test('the removed member is no longer listed on the project', async () => {
      const project = await getProject(pm, projectId);
      const ids = 'members' in project ? project.members.map((m) => m.userId) : [];
      expect(ids).not.toContain(finisher.id);
      expect(ids).toContain(owner.id);
    });

    test('a removed member cannot be assigned to a new task', async () => {
      await expect(
        createTask(pm, {
          projectId,
          title: `${RUN}-assign-removed`,
          department: 'BACKEND',
          assigneeId: finisher.id,
        }),
      ).rejects.toThrow('member of the project');
    });

    test('adding the member again reactivates the same row', async () => {
      const before = await membershipRow(finisher.id);
      await addProjectMember(projectId, finisher.id);
      const after = await membershipRow(finisher.id);
      expect(after?.id).toBe(before?.id);
      expect(after?.deletedAt).toBeNull();
      expect(await visibleProjectIds(internal(finisher.id))).toContain(projectId);
    });

    test('is refused while the member still has unfinished tasks', async () => {
      await expect(removeProjectMember(projectId, owner.id)).rejects.toThrow('unfinished');
      expect((await membershipRow(owner.id))?.deletedAt).toBeNull();
    });

    test('is a 404 for someone who is not a member', async () => {
      await expect(removeProjectMember(projectId, otherPm.id)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  describe('createProject', () => {
    test('validates the initial members like addProjectMember does', async () => {
      await expect(
        createProject(pm, { name: `${RUN}-bad-members`, memberUserIds: [otherPm.id] }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        createProject(pm, { name: `${RUN}-ghost-members`, memberUserIds: ['nobody'] }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(await prisma.project.count({ where: { name: { startsWith: `${RUN}-bad` } } })).toBe(0);
    });

    test('creates the project with valid members', async () => {
      const created = await createProject(pm, {
        name: `${RUN}-ok-members`,
        memberUserIds: [candidate.id, client.id],
      });
      try {
        expect(created.members.map((m) => m.userId).sort()).toEqual(
          [candidate.id, client.id].sort(),
        );
      } finally {
        await prisma.projectMember.deleteMany({ where: { projectId: created.id } });
        await prisma.project.delete({ where: { id: created.id } });
      }
    });
  });
});
