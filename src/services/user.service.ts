import { ForbiddenError } from '../lib/errors';
import type { JwtPayload } from '../lib/jwt';
import { prisma } from '../lib/prisma';
import { buildListQuery, type ListQuerySpec, paginate } from '../lib/query-filter';

const userListSpec: ListQuerySpec = {
  allowedFields: ['name', 'email', 'role', 'department'],
  searchableFields: ['name', 'email'],
  maxPageSize: 200,
  defaultPageSize: 100,
};

/**
 * PM-only directory used to populate assignee/member pickers. Internal Team and Client
 * Guest never need to enumerate other users, and Client Guest in particular must never
 * see this (it's exactly the internal-identity data the brief says to mask elsewhere).
 */
export async function listUsers(
  user: JwtPayload,
  rawQuery: Record<string, string | string[] | undefined>,
) {
  if (user.role !== 'PM') {
    throw new ForbiddenError('Only Product Managers can list users');
  }

  const listQuery = buildListQuery(rawQuery, userListSpec, { deletedAt: null });
  const [rows, totalData] = await Promise.all([
    prisma.user.findMany({
      ...listQuery,
      select: { id: true, name: true, email: true, role: true, department: true, avatarUrl: true },
    }),
    prisma.user.count({ where: listQuery.where }),
  ]);

  return paginate(rows, totalData, listQuery.take);
}
