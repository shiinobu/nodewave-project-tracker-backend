import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ConflictError, ForbiddenError, ValidationError } from '../lib/errors';
import type { JwtPayload } from '../lib/jwt';
import { hashPassword } from '../lib/password';
import { prisma } from '../lib/prisma';
import {
  addDependency,
  computeBlocked,
  createTask,
  getTask,
  listAuditLogs,
  listTasks,
  updateTask,
  updateTaskStatus,
} from './task.service';

// Every fixture is namespaced under this run's id, so repeated local runs (against a
// real dev database) and parallel CI runs never collide with seed data or each other.
const RUN = `svc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe('computeBlocked (pure)', () => {
  test('is not blocked when there are no dependencies', () => {
    const result = computeBlocked({ dependsOn: [] });
    expect(result.isBlocked).toBe(false);
    expect(result.blockedBy).toEqual([]);
  });

  test('is not blocked when every dependency is Done', () => {
    const result = computeBlocked({
      dependsOn: [
        { dependsOnTask: { id: '1', title: 'A', status: 'DONE' } },
        { dependsOnTask: { id: '2', title: 'B', status: 'DONE' } },
      ],
    });
    expect(result.isBlocked).toBe(false);
  });

  test('is blocked when at least one dependency is not Done, and lists it', () => {
    const result = computeBlocked({
      dependsOn: [
        { dependsOnTask: { id: '1', title: 'A', status: 'DONE' } },
        { dependsOnTask: { id: '2', title: 'B', status: 'IN_PROGRESS' } },
      ],
    });
    expect(result.isBlocked).toBe(true);
    expect(result.blockedBy).toEqual([{ id: '2', title: 'B', status: 'IN_PROGRESS' }]);
  });
});

describe('task.service integration (real database)', () => {
  let pm: { id: string };
  let backendEngineer: { id: string };
  let frontendEngineer: { id: string };
  let clientGuest: { id: string };
  let projectId: string;
  let taskA: { id: string }; // prerequisite, starts Done
  let taskB: { id: string }; // depends on A, department BACKEND
  let taskC: { id: string }; // department FRONTEND, no dependencies — used for cross-department checks

  let pmUser: JwtPayload;
  let backendUser: JwtPayload;
  let frontendUser: JwtPayload;
  let clientUser: JwtPayload;

  beforeAll(async () => {
    const password = await hashPassword('password123');

    pm = await prisma.user.create({
      data: { email: `${RUN}-pm@test.local`, password, name: 'Test PM', role: 'PM' },
    });
    backendEngineer = await prisma.user.create({
      data: {
        email: `${RUN}-backend@test.local`,
        password,
        name: 'Test Backend',
        role: 'INTERNAL',
        department: 'BACKEND',
      },
    });
    frontendEngineer = await prisma.user.create({
      data: {
        email: `${RUN}-frontend@test.local`,
        password,
        name: 'Test Frontend',
        role: 'INTERNAL',
        department: 'FRONTEND',
      },
    });

    clientGuest = await prisma.user.create({
      data: { email: `${RUN}-client@test.local`, password, name: 'Test Client', role: 'CLIENT' },
    });

    const project = await prisma.project.create({
      data: {
        name: `${RUN}-project`,
        createdById: pm.id,
        members: {
          create: [
            { userId: backendEngineer.id },
            { userId: frontendEngineer.id },
            { userId: clientGuest.id },
          ],
        },
      },
    });
    projectId = project.id;

    taskA = await prisma.task.create({
      data: {
        projectId,
        title: 'A - prerequisite',
        department: 'BACKEND',
        assigneeId: backendEngineer.id,
        status: 'DONE',
      },
    });
    taskB = await prisma.task.create({
      data: {
        projectId,
        title: 'B - depends on A',
        department: 'BACKEND',
        assigneeId: backendEngineer.id,
      },
    });
    taskC = await prisma.task.create({
      data: { projectId, title: 'C - frontend only', department: 'FRONTEND' },
    });
    await prisma.taskDependency.create({ data: { taskId: taskB.id, dependsOnTaskId: taskA.id } });

    pmUser = { sub: pm.id, email: '', role: 'PM' };
    backendUser = { sub: backendEngineer.id, email: '', role: 'INTERNAL', department: 'BACKEND' };
    frontendUser = {
      sub: frontendEngineer.id,
      email: '',
      role: 'INTERNAL',
      department: 'FRONTEND',
    };
    clientUser = { sub: clientGuest.id, email: '', role: 'CLIENT' };
  });

  afterAll(async () => {
    // Children first: FKs would otherwise reject the delete.
    await prisma.auditLog.deleteMany({ where: { task: { projectId } } });
    await prisma.taskDependency.deleteMany({ where: { task: { projectId } } });
    await prisma.taskComment.deleteMany({ where: { task: { projectId } } });
    await prisma.taskAttachment.deleteMany({ where: { task: { projectId } } });
    await prisma.task.deleteMany({ where: { projectId } });
    await prisma.projectMember.deleteMany({ where: { projectId } });
    await prisma.project.delete({ where: { id: projectId } });
    await prisma.user.deleteMany({
      where: { id: { in: [pm.id, backendEngineer.id, frontendEngineer.id, clientGuest.id] } },
    });
  });

  test('rejects a status change from a department the task does not belong to', async () => {
    await expect(
      updateTaskStatus(frontendUser, taskB.id, { status: 'IN_PROGRESS', version: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test('the assignee can start the task once its dependency is Done', async () => {
    const updated = await updateTaskStatus(backendUser, taskB.id, {
      status: 'IN_PROGRESS',
      version: 1,
    });
    expect(updated.status).toBe('IN_PROGRESS');
    expect(updated.version).toBe(2);
  });

  test('PM cannot move a task from In Progress to Done', async () => {
    await expect(
      updateTaskStatus(pmUser, taskB.id, { status: 'DONE', version: 2 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test('a stale version is rejected with a 409-style conflict', async () => {
    // version is now 2 (from the previous successful transition) — resubmitting the
    // original version: 1 must be treated as a concurrent-edit conflict.
    await expect(
      updateTaskStatus(backendUser, taskB.id, { status: 'DONE', version: 1 }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test('the assignee can complete the task the PM was refused', async () => {
    const updated = await updateTaskStatus(backendUser, taskB.id, { status: 'DONE', version: 2 });
    expect(updated.status).toBe('DONE');
  });

  test('a task blocked by an incomplete dependency cannot start', async () => {
    const blockedTask = await prisma.task.create({
      data: { projectId, title: `${RUN}-blocked-task`, department: 'FRONTEND' },
    });
    await prisma.taskDependency.create({
      data: { taskId: blockedTask.id, dependsOnTaskId: taskC.id }, // taskC is still TODO
    });

    await expect(
      updateTaskStatus(frontendUser, blockedTask.id, { status: 'IN_PROGRESS', version: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test('a Client Guest is never told the title, id or status of an internal-only prerequisite', async () => {
    const hidden = await prisma.task.create({
      data: {
        projectId,
        title: `${RUN}-secret-internal-task`,
        department: 'BACKEND',
        isClientVisible: false,
      },
    });
    const shared = await prisma.task.create({
      data: {
        projectId,
        title: `${RUN}-shared-task`,
        department: 'FRONTEND',
        isClientVisible: true,
      },
    });
    await prisma.taskDependency.create({ data: { taskId: shared.id, dependsOnTaskId: hidden.id } });

    const result = await getTask(clientUser, shared.id);

    expect(result.isBlocked).toBe(true);
    expect(result.blockedBy).toEqual([]);
    const payload = JSON.stringify(result);
    expect(payload).not.toContain('secret-internal-task');
    expect(payload).not.toContain(hidden.id);
  });

  test('a Client Guest still sees the title of a prerequisite that is client-visible', async () => {
    const prerequisite = await prisma.task.create({
      data: {
        projectId,
        title: `${RUN}-visible-prerequisite`,
        department: 'BACKEND',
        isClientVisible: true,
      },
    });
    const dependent = await prisma.task.create({
      data: { projectId, title: `${RUN}-dependent`, department: 'FRONTEND', isClientVisible: true },
    });
    await prisma.taskDependency.create({
      data: { taskId: dependent.id, dependsOnTaskId: prerequisite.id },
    });

    const result = await getTask(clientUser, dependent.id);

    expect(result.blockedBy).toEqual([
      { id: prerequisite.id, title: `${RUN}-visible-prerequisite`, status: 'TODO' },
    ]);
  });

  test('a dependency that would form a cycle is rejected', async () => {
    // taskB already (transitively) depends on taskA; making taskA depend on taskB would cycle.
    await expect(
      addDependency(pmUser, taskA.id, { dependsOnTaskId: taskB.id }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('a PM cannot skip the executor by moving a task straight from To Do to Done', async () => {
    const task = await prisma.task.create({
      data: { projectId, title: `${RUN}-pm-skip`, department: 'BACKEND' },
    });

    await expect(
      updateTaskStatus(pmUser, task.id, { status: 'DONE', version: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.status).toBe('TODO');
    expect(after.version).toBe(1);
  });

  test('a PM cannot force a blocked task to Done, which would unblock its dependents', async () => {
    const upstream = await prisma.task.create({
      data: { projectId, title: `${RUN}-upstream-open`, department: 'UIUX' },
    });
    const downstream = await prisma.task.create({
      data: { projectId, title: `${RUN}-downstream`, department: 'FRONTEND' },
    });
    await prisma.taskDependency.create({
      data: { taskId: downstream.id, dependsOnTaskId: upstream.id },
    });

    await expect(
      updateTaskStatus(pmUser, downstream.id, { status: 'DONE', version: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const after = await prisma.task.findUniqueOrThrow({ where: { id: downstream.id } });
    expect(after.status).toBe('TODO');
  });

  test('a task that became blocked while in progress cannot be completed', async () => {
    const upstream = await prisma.task.create({
      data: { projectId, title: `${RUN}-reopened-upstream`, department: 'UIUX', status: 'TODO' },
    });
    const inFlight = await prisma.task.create({
      data: {
        projectId,
        title: `${RUN}-in-flight`,
        department: 'BACKEND',
        assigneeId: backendEngineer.id,
        status: 'IN_PROGRESS',
      },
    });
    await prisma.taskDependency.create({
      data: { taskId: inFlight.id, dependsOnTaskId: upstream.id },
    });

    await expect(
      updateTaskStatus(backendUser, inFlight.id, { status: 'DONE', version: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  describe('list query allow-list (Client Guest cannot probe masked or hidden data)', () => {
    // These are the oracle queries from the audit: each one used to be accepted (HTTP 200)
    // and answered with a row count that leaked a masked or hidden value.
    test.each([
      ['a masked department', { filters: JSON.stringify({ department: 'BACKEND' }) }],
      ['a masked assignee name', { filters: JSON.stringify({ 'assignee.name': 'Test Backend' }) }],
      [
        'a password hash prefix through the assignee',
        { filters: JSON.stringify({ 'assignee.password': { startsWith: '$2b$10$' } }) },
      ],
      [
        'a password hash through a nested relation object',
        { filters: JSON.stringify({ project: { createdBy: { password: { gt: '$' } } } }) },
      ],
      ['a search on the assignee', { searchFilters: JSON.stringify({ 'assignee.name': 'Test' }) }],
      ['sorting by department', { orderKey: 'department' }],
    ])('rejects %s', async (_label, query) => {
      await expect(listTasks(clientUser, query)).rejects.toBeInstanceOf(ValidationError);
    });

    test('a Client Guest can still filter on what they can already see', async () => {
      const shared = await prisma.task.create({
        data: {
          projectId,
          title: `${RUN}-listed-for-client`,
          department: 'FRONTEND',
          isClientVisible: true,
        },
      });

      const result = await listTasks(clientUser, {
        filters: JSON.stringify({ projectId, status: 'TODO' }),
        searchFilters: JSON.stringify({ title: 'listed-for-client' }),
        orderKey: 'createdAt',
        orderRule: 'desc',
      });

      expect(result.entries.map((task) => task.id)).toEqual([shared.id]);
    });

    test('a PM may still filter by department', async () => {
      const own = await prisma.task.create({
        data: { projectId, title: `${RUN}-pm-filter-uiux`, department: 'UIUX' },
      });

      const result = await listTasks(pmUser, {
        filters: JSON.stringify({ projectId, department: 'UIUX' }),
        searchFilters: JSON.stringify({ title: 'pm-filter-uiux' }),
      });

      expect(result.entries.map((task) => task.id)).toEqual([own.id]);
    });

    test('an Internal Team member cannot reach another project through a relation filter', async () => {
      await expect(
        listTasks(backendUser, {
          filters: JSON.stringify({
            project: { members: { none: { userId: backendEngineer.id } } },
          }),
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    test('everyone with access can search the description, which a Client Guest already sees', async () => {
      const described = await prisma.task.create({
        data: {
          projectId,
          title: `${RUN}-described`,
          description: `${RUN} zebra-crossing notes`,
          department: 'FRONTEND',
          isClientVisible: true,
        },
      });
      const query = {
        filters: JSON.stringify({ projectId }),
        searchFilters: JSON.stringify({ description: 'zebra-crossing' }),
      };

      for (const user of [pmUser, backendUser, clientUser]) {
        const result = await listTasks(user, query);
        expect(result.entries.map((task) => task.id)).toEqual([described.id]);
      }
    });

    test('an Internal Team member can filter by assignee, a Client Guest cannot', async () => {
      const mine = await listTasks(backendUser, {
        filters: JSON.stringify({ projectId, assigneeId: backendEngineer.id }),
      });
      const ids = mine.entries.map((task) => task.id);
      expect(ids).toContain(taskA.id);
      expect(ids).toContain(taskB.id);
      expect(ids).not.toContain(taskC.id);

      await expect(
        listTasks(clientUser, { filters: JSON.stringify({ assigneeId: backendEngineer.id }) }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('audit history is a list that follows the query contract', () => {
    let audited: { id: string };

    beforeAll(async () => {
      const created = await createTask(pmUser, {
        projectId,
        title: `${RUN}-audited`,
        department: 'BACKEND',
      });
      audited = created;
      // One CREATE row, then two UPDATE rows (title and description) written together.
      await updateTask(pmUser, created.id, {
        title: `${RUN}-audited-again`,
        description: 'now described',
        version: created.version,
      });
    });

    test('answers with entries, totalData and totalPage, newest first', async () => {
      const result = await listAuditLogs(pmUser, audited.id, {});

      expect(result.totalData).toBe(3);
      expect(result.totalPage).toBe(1);
      const times = result.entries.map((entry) => entry.createdAt.getTime());
      expect(times).toEqual([...times].sort((a, b) => b - a));
      expect(result.entries[0]?.user.name).toBe('Test PM');
    });

    test('pages with page and rows', async () => {
      const second = await listAuditLogs(pmUser, audited.id, { rows: '2', page: '2' });
      expect(second.entries).toHaveLength(1);
      expect(second.totalData).toBe(3);
      expect(second.totalPage).toBe(2);
    });

    test('filters by action and searches the changed column', async () => {
      const updates = await listAuditLogs(pmUser, audited.id, {
        filters: JSON.stringify({ action: 'UPDATE' }),
      });
      expect(updates.totalData).toBe(2);
      expect(updates.entries.every((entry) => entry.action === 'UPDATE')).toBe(true);

      const described = await listAuditLogs(pmUser, audited.id, {
        searchFilters: JSON.stringify({ changedColumn: 'descr' }),
      });
      expect(described.entries.map((entry) => entry.changedColumn)).toEqual(['description']);
    });

    test('cannot be pointed at another task or at a hidden column', async () => {
      await expect(
        listAuditLogs(pmUser, audited.id, { filters: JSON.stringify({ taskId: taskA.id }) }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        listAuditLogs(pmUser, audited.id, {
          filters: JSON.stringify({ 'user.password': { startsWith: '$2b$' } }),
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    test('is open to Internal Team members of the project and closed to a Client Guest', async () => {
      expect((await listAuditLogs(backendUser, audited.id, {})).totalData).toBe(3);
      await expect(listAuditLogs(clientUser, audited.id, {})).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });
  });
});

describe('task.service assignee and dependency validation (real database)', () => {
  const PREFIX = `${RUN}-v`;
  let pmUser: JwtPayload;
  let backendMember: { id: string };
  let frontendMember: { id: string };
  let outsider: { id: string }; // INTERNAL / BACKEND, but not a member of the project
  let clientMember: { id: string };
  let projectId: string;
  let otherProjectId: string;
  let foreignTask: { id: string };
  let localTask: { id: string };

  const tasksTitled = (title: string) => prisma.task.count({ where: { title } });

  beforeAll(async () => {
    const password = await hashPassword('password123');
    const user = (
      label: string,
      role: 'PM' | 'INTERNAL' | 'CLIENT',
      department?: 'BACKEND' | 'FRONTEND',
    ) =>
      prisma.user.create({
        data: { email: `${PREFIX}-${label}@test.local`, password, name: label, role, department },
      });

    const pm = await user('pm', 'PM');
    backendMember = await user('backend', 'INTERNAL', 'BACKEND');
    frontendMember = await user('frontend', 'INTERNAL', 'FRONTEND');
    outsider = await user('outsider', 'INTERNAL', 'BACKEND');
    clientMember = await user('client', 'CLIENT');
    pmUser = { sub: pm.id, email: '', role: 'PM' };

    const project = await prisma.project.create({
      data: {
        name: `${PREFIX}-project`,
        createdById: pm.id,
        members: {
          create: [
            { userId: backendMember.id },
            { userId: frontendMember.id },
            { userId: clientMember.id },
          ],
        },
      },
    });
    projectId = project.id;
    const other = await prisma.project.create({
      data: { name: `${PREFIX}-other-project`, createdById: pm.id },
    });
    otherProjectId = other.id;

    foreignTask = await prisma.task.create({
      data: { projectId: otherProjectId, title: `${PREFIX}-foreign`, department: 'BACKEND' },
    });
    localTask = await prisma.task.create({
      data: { projectId, title: `${PREFIX}-local`, department: 'BACKEND' },
    });
  });

  afterAll(async () => {
    const projectIds = [projectId, otherProjectId];
    await prisma.auditLog.deleteMany({ where: { task: { projectId: { in: projectIds } } } });
    await prisma.taskDependency.deleteMany({ where: { task: { projectId: { in: projectIds } } } });
    await prisma.task.deleteMany({ where: { projectId: { in: projectIds } } });
    await prisma.projectMember.deleteMany({ where: { projectId: { in: projectIds } } });
    await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: `${PREFIX}-` } } });
  });

  describe('createTask', () => {
    const create = (title: string, extra: Partial<Parameters<typeof createTask>[1]> = {}) =>
      createTask(pmUser, { projectId, title, department: 'BACKEND', ...extra });

    test('accepts an Internal Team member of the project from the same department', async () => {
      const task = await create(`${PREFIX}-ok`, { assigneeId: backendMember.id });
      expect(task.assigneeId).toBe(backendMember.id);
    });

    test.each([
      ['a Client Guest', () => clientMember.id],
      ['a PM', () => pmUser.sub],
      ['an Internal Team member outside the project', () => outsider.id],
      ['a member of another department', () => frontendMember.id],
      ['an id that does not exist', () => 'no-such-user'],
    ])('rejects %s as assignee, and creates nothing', async (label, assigneeId) => {
      const title = `${PREFIX}-bad-assignee-${label}`;
      await expect(create(title, { assigneeId: assigneeId() })).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(await tasksTitled(title)).toBe(0);
    });

    test('stores a repeated dependency id once instead of failing on the unique index', async () => {
      const task = await create(`${PREFIX}-dup-deps`, {
        dependsOnTaskIds: [localTask.id, localTask.id],
      });
      const rows = await prisma.taskDependency.findMany({ where: { taskId: task.id } });
      expect(rows.map((row) => row.dependsOnTaskId)).toEqual([localTask.id]);
    });

    test.each([
      ['a task in another project', () => foreignTask.id],
      ['an id that does not exist', () => 'no-such-task'],
    ])('rejects a dependency on %s, and creates nothing', async (label, dependencyId) => {
      const title = `${PREFIX}-bad-dependency-${label}`;
      await expect(create(title, { dependsOnTaskIds: [dependencyId()] })).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(await tasksTitled(title)).toBe(0);
    });
  });

  describe('updateTask', () => {
    const freshTask = (title: string) =>
      prisma.task.create({ data: { projectId, title, department: 'BACKEND' } });

    test('assigns a valid executor and records it in the audit trail', async () => {
      const task = await freshTask(`${PREFIX}-assign-ok`);
      const updated = await updateTask(pmUser, task.id, {
        assigneeId: backendMember.id,
        version: task.version,
      });
      expect(updated.assigneeId).toBe(backendMember.id);
      expect(updated.version).toBe(task.version + 1);

      const log = await prisma.auditLog.findFirstOrThrow({
        where: { taskId: task.id, changedColumn: 'assigneeId' },
      });
      expect(log.oldValue).toBeNull();
      expect(log.newValue).toBe(backendMember.id);
    });

    test('can unassign a task', async () => {
      const task = await prisma.task.create({
        data: {
          projectId,
          title: `${PREFIX}-unassign`,
          department: 'BACKEND',
          assigneeId: backendMember.id,
        },
      });
      const updated = await updateTask(pmUser, task.id, {
        assigneeId: null,
        version: task.version,
      });
      expect(updated.assigneeId).toBeNull();
    });

    test.each([
      ['a Client Guest', () => clientMember.id],
      ['an Internal Team member outside the project', () => outsider.id],
      ['a member of another department', () => frontendMember.id],
      ['an id that does not exist', () => 'no-such-user'],
    ])('rejects %s and leaves the task untouched', async (label, assigneeId) => {
      const task = await freshTask(`${PREFIX}-assign-bad-${label}`);
      await expect(
        updateTask(pmUser, task.id, { assigneeId: assigneeId(), version: task.version }),
      ).rejects.toBeInstanceOf(ValidationError);

      const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
      expect(after.assigneeId).toBeNull();
      expect(after.version).toBe(task.version);
    });

    test('a stale version is a conflict and the assignee is not changed', async () => {
      const task = await freshTask(`${PREFIX}-assign-stale`);
      await expect(
        updateTask(pmUser, task.id, { assigneeId: backendMember.id, version: task.version + 5 }),
      ).rejects.toBeInstanceOf(ConflictError);

      const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
      expect(after.assigneeId).toBeNull();
    });

    test('re-sending the current assignee is not treated as a change', async () => {
      const task = await prisma.task.create({
        data: {
          projectId,
          title: `${PREFIX}-same-assignee`,
          department: 'BACKEND',
          assigneeId: backendMember.id,
        },
      });
      const result = await updateTask(pmUser, task.id, {
        assigneeId: backendMember.id,
        version: task.version,
      });
      expect(result.version).toBe(task.version);
    });
  });
});
