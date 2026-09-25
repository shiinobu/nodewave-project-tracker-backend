# Technical Test — Backend

TypeScript + Bun + Hono + Prisma (PostgreSQL) API for the Fullstack Engineer assessment: a
project/task tracker with state-based permissions, inter-task dependencies, optimistic
locking, and an immutable audit trail.

## Stack

Bun, Hono, Prisma 7 (`prisma-client` generator + `@prisma/adapter-pg`), PostgreSQL, JWT
(`jsonwebtoken`), Zod, `@nodewave/prisma-ezfilter`, Biome, Husky, Commitlint.

## Getting started

```bash
bun install                 # also runs `prisma generate` (postinstall) -> generated/prisma
cp .env.example .env        # then edit DATABASE_URL / JWT_SECRET as needed
bun run db:migrate          # applies prisma/migrations (use `bun run db:deploy` outside dev)
bun run db:seed             # creates the 5 demo accounts + a sample project
bun run dev                 # http://localhost:8000
```

`generated/prisma` is git-ignored and Prisma 7 does not generate it on its own, so a fresh
checkout needs `bun install` (or `bun run db:generate`) before `tsc`, tests or `build` work.

Environment variables (`.env`, template in `.env.example`):

| Variable         | Required | Purpose                                                                                                |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`   | yes      | PostgreSQL connection string                                                                           |
| `JWT_SECRET`     | yes      | JWT signing key — use a long random string                                                             |
| `JWT_EXPIRES_IN` | no       | token lifetime, default `1d`                                                                           |
| `PORT`           | no       | HTTP port, default `8000`                                                                              |
| `CORS_ORIGIN`    | no       | allowed frontend origin, default `http://localhost:3000`                                               |
| `PM_SIGNUP_CODE` | no       | invite code that lets `POST /api/auth/register` create a `PM`; unset = nobody can self-register as PM |

Seeded accounts (password for all: `password123`):

| Role           | Email                  | Department |
| -------------- | ----------------------- | ---------- |
| Product Manager | `pm@nodewave.id`        | —          |
| Internal Team  | `uiux@nodewave.id`      | UI/UX      |
| Internal Team  | `frontend@nodewave.id`  | Frontend   |
| Internal Team  | `backend@nodewave.id`   | Backend    |
| Client Guest   | `client@nodewave.id`    | —          |

## Architecture overview

### RBAC + ABAC

`User.role` (`PM` / `INTERNAL` / `CLIENT`) is the coarse role; `User.department`
(`UIUX` / `FRONTEND` / `BACKEND`, set only for `INTERNAL`) and the task's own `status` add
the attribute-based layer. Authorization is enforced in the **service layer**
(`src/services/*.ts`), never trusted from the client, and route handlers additionally gate
by role via `requireRole()` (`src/middlewares/auth.middleware.ts`) before a request even
reaches a service.

- **PM** — full read/write on projects and tasks, except it can never move a task to
  `DONE` — only the executor completes work (`task-policy.ts#assertTransition`). Only PM can
  create projects, create tasks, edit a task's core fields, and declare dependencies.
  `PM` cannot be self-registered: `POST /auth/register` with `role: "PM"` needs the server's
  `PM_SIGNUP_CODE` as `inviteCode` (and is refused when none is configured). `INTERNAL` and
  `CLIENT` can sign up freely — they see nothing until a PM adds them to a project.
- **Internal Team** — task visibility is scoped to projects they're a `ProjectMember` of
  (`task.service.ts#listTasks`/`getTask`). Changing a task's status additionally requires
  `user.department === task.department` (and the assignee, if one is set) — see
  "State-based permissions" below. They can never touch `title`/`description` (only PM's
  `PATCH /tasks/:id` can), only upload attachments and change status.
- **Client Guest** — scoped to projects they're a member of, and *within* those, only to
  tasks flagged `isClientVisible`. `GET /projects/:id` for a client returns aggregate
  metrics (`percentComplete`) computed from **all** tasks, never the task list itself.

### Data masking (not CSS)

`task.service.ts#toClientTask` is a hard boundary: for `CLIENT` role it builds an entirely
separate response shape that omits `assignee` and any internal (`isInternal: true`)
comments before the JSON ever leaves the server — the frontend never receives the data it
isn't supposed to render, rather than receiving it and hiding it.

### State-based permissions + dependency graph

`Task.status` is one of `TODO` / `IN_PROGRESS` / `DONE`. "Blocked" is **not** a stored
status — it's computed on every read from unmet `TaskDependency` rows
(`task.service.ts#computeBlocked`), so it can never drift out of sync with the dependency
graph the way a manually-set status could. `PATCH /tasks/:id/status` refuses any forward move
(start *or* complete) while a prerequisite isn't `DONE`, returning `403` with the list of
what's still blocking it — the same check the frontend uses to disable the button. The rules
themselves are pure functions in `services/task-policy.ts` (`assertTransition`,
`assertAssignable`), so they are table-tested without a database.

An assignee must be an `INTERNAL` member of the task's project from the task's own
department (exactly what the assignee picker offers), and a dependency must point at an
existing task of the same project; otherwise the request is a `422`.
`POST /tasks/:id/dependencies` runs a BFS (`wouldCreateCycle`) before inserting, so a
dependency that would create a cycle is rejected with `422`.

### Concurrency: optimistic locking

Every `Task` carries an integer `version`. Mutating endpoints (`PATCH /tasks/:id`,
`PATCH /tasks/:id/status`) require the caller to send back the `version` they last read.
The update runs as `updateMany({ where: { id, version } })`; if the row's version has since
moved on, `count` comes back `0` and the request fails with **409 Conflict** instead of
silently overwriting a concurrent edit. Verified manually: two clients holding the same
stale version, the second write gets `409`.

### Immutable audit trail

Every field-level change to a task (status, description, assignee, dependency) is written
to `AuditLog` — `userId`, `action`, `changedColumn`, `oldValue`, `newValue`, `createdAt` —
inside the **same transaction** as the mutation (`services/audit.service.ts`, always called
from within a `prisma.$transaction`), so the log can never fall out of sync with the data it
describes. Rows are only ever inserted; nothing in the codebase updates or deletes an
`AuditLog` row. Soft deletes (`deletedAt`) are used everywhere else instead of hard
deletes. Read back via `GET /tasks/:id/audit-logs`.

## API

All routes are mounted under `/api`. See `src/routes/*.ts` for the full list; the
interesting ones:

- `POST /api/auth/register` (`role: "PM"` needs `inviteCode`), `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- `GET /api/users` (PM-only directory, for assignee/member pickers)
- `GET /api/projects`, `GET /api/projects/:id`, `POST /api/projects` (PM), `DELETE /api/projects/:id` (PM)
- `GET /api/tasks`, `GET /api/tasks/:id`
- `POST /api/tasks` (PM), `PATCH /api/tasks/:id` (PM, core fields, optimistic-locked)
- `PATCH /api/tasks/:id/status` (PM/Internal, state machine + dependency + optimistic lock)
- `DELETE /api/tasks/:id?version=<n>` (PM, optimistic-locked soft delete)
- `POST /api/tasks/:id/dependencies` (PM), `GET /api/tasks/:id/audit-logs`
- `POST /api/tasks/:id/comments`, `POST /api/tasks/:id/attachments` (PM/Internal — see note below)

List endpoints (`/projects`, `/tasks`, `/users`) follow the standard `filters` /
`searchFilters` / `rangedFilters` / `orderKey` / `orderRule` / `page` / `rows` query
contract via `@nodewave/prisma-ezfilter` (`src/lib/query-filter.ts`); role scoping is
ANDed into the generated `where` clause server-side so it can never be relaxed by a query
param.

ezfilter on its own only *warns* about fields outside `allowedFields` and forwards the
caller's JSON into Prisma, so every list first goes through `buildListQuery`, which is strict:
filter, range and order keys must be listed scalar columns of that resource (no dotted
relation paths, no operator/relation objects as values), `searchFilters` only accepts the
resource's string columns, `orderRule` is `asc`/`desc`, and `page`/`rows` are positive
integers. Anything else — including malformed JSON — is a `422` rather than being ignored.
A Client Guest's task list additionally cannot filter, search or sort on `department`,
because the response masks it.

Malformed request bodies are a `422` as well, unknown routes a JSON `404`, and Prisma errors
caused by the caller are mapped to `409`/`422`/`404` instead of leaking as a `500`.

**Attachments are link-based** (`{ fileName, fileUrl }`), not binary upload — no object
storage (S3/etc.) is provisioned for this scaffold, so "uploading" a work attachment means
pasting a link to where the file actually lives.

## Testing

```bash
bun run test          # bun test — integration tests hit a real database
```

Tests run against whatever `DATABASE_URL` is currently configured (your local dev DB is
fine — every fixture is created under a random `svc-<timestamp>-...` namespace and torn
down in `afterAll`, so it never touches seeded or hand-created data). Covers:

- `computeBlocked`, `assertTransition` and `assertAssignable` as pure functions (no DB).
- The full `updateTaskStatus` state machine against a real Postgres: department/assignee
  ABAC, the PM-cannot-complete carve-out (including `TODO -> DONE` on a blocked task), the
  dependency block, and a genuine optimistic-locking conflict (stale `version` →
  `ConflictError`).
- `createTask`/`updateTask` assignee and dependency validation, and `addDependency`'s cycle
  detection.
- The query contract (`buildListQuery`): the documented examples, plus rejection of every
  field/relation/operator outside the allow-list — including the oracle queries a Client
  Guest could use to probe masked data.
- The PM sign-up gate, and HTTP-level checks through the real Hono app (error shapes, 404,
  malformed bodies, Prisma error mapping).

## CI

`.github/workflows/ci.yml` runs on every push/PR to `main`: `bun install` (whose
`postinstall` generates the Prisma client), Biome format+lint, `tsc` typecheck, spins up a
`postgres:17` service container and applies migrations, runs the test suite above against
it, then builds.

## Scripts

`bun run dev` · `bun run build` · `bun run test` · `bun run typecheck` ·
`bun run lint` / `lint:fix` · `bun run db:generate` · `bun run db:migrate` ·
`bun run db:deploy` · `bun run db:seed` · `bun run db:studio`

## Not yet implemented

- Daily Standup Auto-Summary endpoint (bonus/optional in the brief).
- Binary file upload for attachments (currently link-based — see above).
