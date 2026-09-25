# NodeWave Project Tracker (backend)

<div align="justify">

REST API for the NodeWave project tracker, written for the NodeWave Fullstack Engineer technical test. It provides authentication, role-based access to projects and tasks, task dependencies with a computed Blocked state, optimistic locking and an audit trail, on top of PostgreSQL through Prisma. The web client is [nodewave-project-tracker-frontend](https://github.com/shiinobu/nodewave-project-tracker-frontend), which calls this API from the browser.

## Stack

- Bun and Hono
- Prisma 7 (`prisma-client` generator, `@prisma/adapter-pg`) on PostgreSQL
- `jsonwebtoken` for JWT, `Bun.password` (bcrypt) for passwords, Zod 4 for request validation
- `@nodewave/prisma-ezfilter` for list queries
- TypeScript (strict) and `bun test`
- Biome, Husky, commitlint

## Requirements

- Bun 1.4.2 (the version CI uses)
- A PostgreSQL database reachable through `DATABASE_URL` (CI runs PostgreSQL 17)
- Node.js 20.19, 22.12 or 24 and later, for the Prisma CLI

## Getting started

```bash
bun install
cp .env.example .env
bun run db:migrate
bun run db:seed
bun run dev
```

`bun install` also runs `prisma generate` (`postinstall`), which creates `generated/prisma`. That directory is git-ignored, so a fresh checkout needs the install (or `bun run db:generate`) before `typecheck`, `test` or `build` work. `db:migrate` runs `prisma migrate dev`, and `bun run db:deploy` (`prisma migrate deploy`) is the command for any database that is not a development one. The API listens on http://localhost:8000.

`bun run db:seed` creates the five accounts below, all with the password `password123`, and one project, "NodeWave Client Portal Revamp", with the four non-PM accounts as members. The project has four tasks: UI Design (UI/UX, Done), Backend API Integration (Backend, In Progress), Frontend Slicing (Frontend, To Do, depends on the first two, so it shows as blocked) and QA Regression Pass (Backend, To Do, depends on Frontend Slicing, not visible to the client). Users, the project and the tasks are upserted, but the seed's two comments are inserted again on every run.

```text
pm@nodewave.id          Product Manager
uiux@nodewave.id        Internal Team, UI/UX
frontend@nodewave.id    Internal Team, Frontend
backend@nodewave.id     Internal Team, Backend
client@nodewave.id      Client Guest
```

## Environment variables

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/technical_test?schema=public"
JWT_SECRET="change-me-to-a-long-random-string"
JWT_EXPIRES_IN="1d"
PORT=8000
# Optional. Without it nobody can self-register as a PM (use the seeded PM account).
# PM_SIGNUP_CODE="pick-a-long-random-string"
CORS_ORIGIN="http://localhost:3000"
```

- `DATABASE_URL`: PostgreSQL connection string. Required.
- `JWT_SECRET`: signing key for tokens. Required, the app throws at startup without it.
- `JWT_EXPIRES_IN`: token lifetime. Defaults to `1d`.
- `PORT`: HTTP port. Defaults to `8000`.
- `CORS_ORIGIN`: the single allowed origin, sent with `credentials: true`. Defaults to `http://localhost:3000`.
- `PM_SIGNUP_CODE`: invite code that allows `POST /api/auth/register` to create a PM. When unset, nobody can register as a PM.

## Project structure

```text
nodewave-project-tracker-backend/
├── prisma/
│   ├── migrations/               SQL migrations
│   ├── schema.prisma             data model
│   └── seed.ts                   demo accounts, one project, four tasks
├── src/
│   ├── dto/                      Zod schemas for request bodies
│   ├── lib/
│   │   ├── errors.ts             HttpError and its subclasses
│   │   ├── http.ts               readJson
│   │   ├── jwt.ts                sign and verify tokens
│   │   ├── password.ts           bcrypt through Bun.password
│   │   ├── prisma.ts             Prisma Client with the pg adapter
│   │   └── query-filter.ts       strict list query builder on top of ezfilter
│   ├── middlewares/
│   │   ├── auth.middleware.ts    authenticate, requireRole
│   │   └── error.middleware.ts   maps errors to JSON responses
│   ├── routes/                   auth, projects, tasks and users, mounted under /api
│   ├── services/
│   │   ├── audit.service.ts      audit log writes
│   │   ├── auth.service.ts       register, login, current user
│   │   ├── project.service.ts    projects and the Client Guest summary
│   │   ├── task-policy.ts        pure transition and assignee rules
│   │   ├── task.service.ts       tasks, masking, dependencies, comments, attachments
│   │   └── user.service.ts       user directory for PMs
│   ├── types/
│   │   └── hono.ts               context variables
│   └── index.ts                  Hono app: logger, CORS, health checks, error handler
├── generated/prisma/             Prisma Client (git-ignored, created by prisma generate)
├── .github/workflows/ci.yml      CI
├── .env.example                  environment template
└── prisma7.config.ts             Prisma CLI config: schema, migrations, DATABASE_URL
```

## Architecture

```text
HTTP request
  ↓
src/index.ts             logger, CORS, JSON 404, error handler
  ↓
src/routes/*             authenticate, requireRole, Zod parsing
  ↓
src/services/*           role scoping, business rules, transactions
  ↓
src/lib/prisma.ts        Prisma Client with the pg adapter
  ↓
PostgreSQL
```

Route handlers stay thin: each one parses the body with a schema from `src/dto/*` (through `readJson`), passes through `authenticate` and, where needed, `requireRole`, and calls one service function with the JWT payload. Services load the data, apply the rules, run multi-step writes in `prisma.$transaction` and throw the `HttpError` subclasses from `src/lib/errors.ts`.

### Authentication

Passwords are hashed with `Bun.password` (bcrypt, cost 10). `POST /auth/register` and `POST /auth/login` return `{ token, user }`, where the token is a JWT signed with `JWT_SECRET` that carries `sub`, `email`, `role` and `department` and expires after `JWT_EXPIRES_IN`. `authenticate` in `src/middlewares/auth.middleware.ts` verifies the `Authorization: Bearer` header and puts the payload on the Hono context, and it does not look the user up again. Registration is open for Internal Team (a department is required) and Client Guest, since both see nothing until a PM adds them to a project. A PM registration needs an `inviteCode` equal to `PM_SIGNUP_CODE`, compared with `timingSafeEqual` over SHA-256 digests, and is refused when the variable is unset. `POST /auth/logout` returns a message and keeps no server state.

### Roles and scoping

Access is checked in two places. `requireRole` in the route files rejects roles that can never use an endpoint, and the service then scopes the data. A PM sees every project and task, while Internal Team members and Client Guests only see projects where they are a `ProjectMember`, and Client Guests only see tasks with `isClientVisible`. For lists this is a `mandatoryWhere` clause that `buildListQuery` ANDs into the query, so a query parameter cannot widen it, and `GET /projects/:id` and `GET /tasks/:id` answer `403` outside that scope. A PM creates and deletes projects and tasks, edits a task's title, description, assignee and client visibility, and adds dependencies. Internal Team members change the status of tasks in their own department and add comments and attachment links, and Client Guests can only read.

### Task status and dependencies

`Task.status` is `TODO`, `IN_PROGRESS` or `DONE`. Blocked is not stored: `computeBlocked` in `src/services/task.service.ts` derives `isBlocked` and `blockedBy` on every read from the dependencies whose prerequisite is not `DONE`. The transition rules are pure functions in `src/services/task-policy.ts`. `assertTransition` refuses status changes from Client Guests and never lets a PM set `DONE`. An Internal Team member has to be a project member in the task's department, has to be the assignee when the task has one, and can only advance a task by one step. For every role, a forward move is refused while a prerequisite is unfinished, with a `403` whose `details` lists the blocking tasks. `assertAssignable` requires an assignee to be an Internal Team member of the project from the task's department, and answers `422` otherwise. Dependencies are set with `dependsOnTaskIds` when a task is created or with `POST /tasks/:id/dependencies`, and either way they must point to existing tasks of the same project. The endpoint also rejects a self-dependency, a duplicate and a cycle with a `422`, and `wouldCreateCycle` finds cycles by walking the existing dependencies breadth-first.

### Client Guest masking

For a Client Guest, `toClientTask` in `src/services/task.service.ts` builds a separate response shape without `department`, the assignee, `version` and internal comments. `blockedBy` only names prerequisites that are client-visible, while `isBlocked` still counts the others. The task list drops `department` from the fields a Client Guest may filter, search or sort on, so it cannot be used to probe the masked value. `GET /projects` and `GET /projects/:id` return a summary (`id`, `name`, `description`, `percentComplete`, `totalTasks`, `completedTasks`) computed over all non-deleted tasks of the project, not only the shared ones. Only a PM can make a comment visible to the client, and comments from Internal Team members are always internal.

### Optimistic locking

Every task has an integer `version`, starting at 1. `PATCH /tasks/:id`, `PATCH /tasks/:id/status` and `DELETE /tasks/:id?version=<n>` require the version the caller last read. The write is `updateMany({ where: { id, version } })` with `version` incremented, and when no row matches (`count === 0`) the API answers `409`, so a concurrent edit is not overwritten silently.

### Audit trail and soft deletes

`recordAudit` in `src/services/audit.service.ts` writes one `AuditLog` row per changed field (`userId`, `action`, `changedColumn`, `oldValue`, `newValue`, `createdAt`) inside the same `prisma.$transaction` as the change, so a failed audit write rolls the change back. It records task creation and deletion, status changes, edits to title, description, assignee and client visibility, and added dependencies and attachments. Comments are not audited, and a creation row carries no field values. The application only inserts audit rows, but the database does not prevent updates or deletes. Deleting a project or a task sets `deletedAt` instead of removing the row, and reads filter on it. `GET /tasks/:id/audit-logs` returns `{ entries }`, newest first, to PMs and to Internal Team members of the project.

### List queries

`/projects`, `/tasks` and `/users` accept `filters`, `searchFilters`, `rangedFilters`, `orderKey`, `orderRule`, `page` and `rows`, built on `@nodewave/prisma-ezfilter`. The library only warns about unknown fields and forwards the JSON into Prisma, so `buildListQuery` in `src/lib/query-filter.ts` first checks the input against a `ListQuerySpec` per resource. Filter, range and order keys must be listed scalar columns, `searchFilters` only accepts the listed string columns, `orderRule` is `asc` or `desc`, and `page` and `rows` are positive integers up to a limit (`rows` up to 100, or 200 for users). Malformed JSON, unknown keys, relation paths and operator objects are rejected with a `422` instead of being ignored. Responses have the shape `{ entries, totalData, totalPage }`, and `rows` defaults to 10 when it is omitted.

### Errors

Errors are JSON of the form `{ error, details? }`. The `HttpError` subclasses in `src/lib/errors.ts` map to `401`, `403`, `404`, `409` and `422`, Zod failures are a `422` with the flattened issues in `details`, and a body that is empty or not valid JSON is a `422` (`readJson` in `src/lib/http.ts`). `src/middlewares/error.middleware.ts` maps Prisma `P2002` to `409`, `P2003` to `422`, `P2025` to `404` and `PrismaClientValidationError` to `422`, with fixed messages instead of Prisma's text. Unknown routes return a JSON `404`, and anything else is logged and returned as a `500` with a generic message.

## API

```text
GET     /                            health check, no auth
GET     /health                      health check, no auth
POST    /api/auth/register           public; role PM needs inviteCode
POST    /api/auth/login              public
POST    /api/auth/logout             any role; returns a message
GET     /api/auth/me                 any role
GET     /api/users                   PM
GET     /api/projects                any role; scoped to memberships, PM sees all
GET     /api/projects/:id            any role; same scoping
POST    /api/projects                PM
DELETE  /api/projects/:id            PM; soft delete
GET     /api/tasks                   any role; scoped and masked per role
GET     /api/tasks/:id               any role; scoped and masked per role
POST    /api/tasks                   PM
PATCH   /api/tasks/:id               PM; title, description, assigneeId, isClientVisible, version
PATCH   /api/tasks/:id/status        PM, Internal; status, version
DELETE  /api/tasks/:id?version=<n>   PM; soft delete
POST    /api/tasks/:id/dependencies  PM
GET     /api/tasks/:id/audit-logs    PM, Internal (project members)
POST    /api/tasks/:id/comments      PM, Internal
POST    /api/tasks/:id/attachments   PM, Internal; fileName and an http(s) fileUrl
```

## Testing

```bash
bun run test
```

`bun test` runs the suites next to the code as `src/**/*.test.ts`. The service suites write to the database that `DATABASE_URL` points to (Bun loads `.env`), so apply the migrations first. Their fixtures use random `svc-` and `auth-` prefixes and are deleted in `afterAll`, and the seeded data is not touched. `src/http.test.ts` goes through the real Hono app and does not write data. The suites cover:

- `src/services/task-policy.test.ts`: `assertTransition` per role and `assertAssignable`, as pure functions.
- `src/services/task.service.test.ts`: `computeBlocked`; status changes against a real database (department and assignee rules, a PM cannot complete, blocked tasks, a stale version conflicts); masking of internal-only prerequisites for Client Guests; cycle rejection; the list allow-list (a Client Guest cannot probe `department`, an Internal Team member cannot reach another project through a relation filter); assignee and dependency validation on create and update.
- `src/lib/query-filter.test.ts`: the documented query examples, and rejection of unlisted fields, relations, operators and malformed input.
- `src/services/auth.service.test.ts`: the PM sign-up gate and `registerSchema`.
- `src/http.test.ts`: unknown routes, malformed bodies, list parameters, registration and the error handler mapping.
- `src/dto/task.dto.test.ts`: `assigneeId` validation.

## Scripts

```bash
bun run dev          # bun run --watch src/index.ts
bun run build        # bun build src/index.ts --outdir dist --target bun
bun run start        # bun run dist/index.js, needs a prior build
bun run test         # bun test
bun run typecheck    # tsc --noEmit
bun run lint         # biome check
bun run lint:fix     # biome check --write
bun run format       # biome format --write
bun run db:generate  # prisma generate
bun run db:migrate   # prisma migrate dev
bun run db:deploy    # prisma migrate deploy
bun run db:seed      # bun run prisma/seed.ts
bun run db:studio    # prisma studio
```

Husky installs two git hooks through the `prepare` script: `pre-commit` runs `bun run lint` and `bun run typecheck`, and `commit-msg` runs commitlint with `@commitlint/config-conventional`.

## CI

`.github/workflows/ci.yml` runs on pushes to `main` and on every pull request. It is one job on `ubuntu-latest` with Bun 1.4.2, a `postgres:17` service container (database `technical_test`), and `DATABASE_URL` and `JWT_SECRET` set for CI only. It has no deployment step and runs these steps in order:

1. `bun install --frozen-lockfile` (runs `prisma generate` through `postinstall`)
2. `bun run lint`
3. `bun run typecheck`
4. `bunx prisma migrate deploy`
5. `bun run test`
6. `bun run build`

## Known limitations

- Attachments are links (`fileName` and an http(s) `fileUrl`). Binary upload is not implemented.
- There is no daily standup summary endpoint.
- A token is not checked against the database after it is signed. It stays valid until it expires (`JWT_EXPIRES_IN`, `1d` by default), including after logout or after the user is soft-deleted, and `User.isActive` is not read anywhere.
- The audit trail is append-only by convention. Nothing in the schema or the migrations, such as a trigger, blocks `UPDATE` or `DELETE` on `audit_logs`.
- There are no endpoints to edit a project or its members, remove a dependency, or edit or delete a comment or an attachment.
- There is no rate limiting.
- Biome runs with `preset: none`, so `bun run lint` applies no lint rules.

</div>
