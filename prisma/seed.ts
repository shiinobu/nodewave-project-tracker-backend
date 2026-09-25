import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { hashPassword } from '../src/lib/password';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const password = await hashPassword('password123');

  const pm = await prisma.user.upsert({
    where: { email: 'pm@nodewave.id' },
    update: {},
    create: { email: 'pm@nodewave.id', password, name: 'Nadia PM', role: 'PM' },
  });

  const uiux = await prisma.user.upsert({
    where: { email: 'uiux@nodewave.id' },
    update: {},
    create: {
      email: 'uiux@nodewave.id',
      password,
      name: 'Uma UIUX',
      role: 'INTERNAL',
      department: 'UIUX',
    },
  });

  const frontend = await prisma.user.upsert({
    where: { email: 'frontend@nodewave.id' },
    update: {},
    create: {
      email: 'frontend@nodewave.id',
      password,
      name: 'Fajar Frontend',
      role: 'INTERNAL',
      department: 'FRONTEND',
    },
  });

  const backend = await prisma.user.upsert({
    where: { email: 'backend@nodewave.id' },
    update: {},
    create: {
      email: 'backend@nodewave.id',
      password,
      name: 'Budi Backend',
      role: 'INTERNAL',
      department: 'BACKEND',
    },
  });

  const client = await prisma.user.upsert({
    where: { email: 'client@nodewave.id' },
    update: {},
    create: { email: 'client@nodewave.id', password, name: 'Citra Client', role: 'CLIENT' },
  });

  const project = await prisma.project.upsert({
    where: { id: 'seed-project-1' },
    update: {},
    create: {
      id: 'seed-project-1',
      name: 'NodeWave Client Portal Revamp',
      description: 'Rebuild the client-facing portal with a new dashboard and task workflow.',
      createdById: pm.id,
      members: {
        create: [
          { userId: uiux.id },
          { userId: frontend.id },
          { userId: backend.id },
          { userId: client.id },
        ],
      },
    },
  });

  const taskA = await prisma.task.upsert({
    where: { id: 'seed-task-a' },
    update: {},
    create: {
      id: 'seed-task-a',
      projectId: project.id,
      title: 'UI Design',
      description: 'Design the new dashboard screens in Figma.',
      department: 'UIUX',
      assigneeId: uiux.id,
      status: 'DONE',
      isClientVisible: true,
    },
  });

  const taskB = await prisma.task.upsert({
    where: { id: 'seed-task-b' },
    update: {},
    create: {
      id: 'seed-task-b',
      projectId: project.id,
      title: 'Backend API Integration',
      description: 'Build the REST endpoints the new dashboard will consume.',
      department: 'BACKEND',
      assigneeId: backend.id,
      status: 'IN_PROGRESS',
      isClientVisible: true,
    },
  });

  // Depends on A (Done) and B (still In Progress) -> shows up as Blocked for the demo.
  const taskC = await prisma.task.upsert({
    where: { id: 'seed-task-c' },
    update: {},
    create: {
      id: 'seed-task-c',
      projectId: project.id,
      title: 'Frontend Slicing',
      description: 'Implement the dashboard UI against the approved design and live API.',
      department: 'FRONTEND',
      assigneeId: frontend.id,
      status: 'TODO',
      isClientVisible: true,
    },
  });

  // Internal-only (isClientVisible: false) -> demonstrates Client Guest task masking.
  const taskD = await prisma.task.upsert({
    where: { id: 'seed-task-d' },
    update: {},
    create: {
      id: 'seed-task-d',
      projectId: project.id,
      title: 'QA Regression Pass',
      description: 'Internal-only QA checklist before releasing the new dashboard.',
      department: 'BACKEND',
      assigneeId: backend.id,
      status: 'TODO',
      isClientVisible: false,
    },
  });

  await prisma.taskDependency.upsert({
    where: { taskId_dependsOnTaskId: { taskId: taskC.id, dependsOnTaskId: taskA.id } },
    update: {},
    create: { taskId: taskC.id, dependsOnTaskId: taskA.id },
  });
  await prisma.taskDependency.upsert({
    where: { taskId_dependsOnTaskId: { taskId: taskC.id, dependsOnTaskId: taskB.id } },
    update: {},
    create: { taskId: taskC.id, dependsOnTaskId: taskB.id },
  });
  await prisma.taskDependency.upsert({
    where: { taskId_dependsOnTaskId: { taskId: taskD.id, dependsOnTaskId: taskC.id } },
    update: {},
    create: { taskId: taskD.id, dependsOnTaskId: taskC.id },
  });

  await prisma.taskComment.create({
    data: {
      taskId: taskB.id,
      authorId: backend.id,
      body: 'API contracts drafted, wiring up the auth endpoints now.',
      isInternal: true,
    },
  });
  await prisma.taskComment.create({
    data: {
      taskId: taskA.id,
      authorId: pm.id,
      body: 'Design approved by stakeholders.',
      isInternal: false,
    },
  });

  console.log('Seed complete. Accounts (password: password123):');
  console.log('  PM:       pm@nodewave.id');
  console.log('  UI/UX:    uiux@nodewave.id');
  console.log('  Frontend: frontend@nodewave.id');
  console.log('  Backend:  backend@nodewave.id');
  console.log('  Client:   client@nodewave.id');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
