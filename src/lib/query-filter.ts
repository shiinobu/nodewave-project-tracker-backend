import {
  BuildQueryFilter,
  type FilteringQuery,
  type PrismaQueryOptions,
  type QuerySpecification,
} from '@nodewave/prisma-ezfilter';
import { z } from 'zod';
import { ValidationError } from './errors';

/**
 * What a resource lets callers do through the query contract. ezfilter only *warns* about
 * fields outside `allowedFields` and forwards the caller's JSON straight into Prisma's
 * `where`, so on its own it would let a caller reach relations and hidden columns
 * (`{"assignee.password": ...}`, `{"project": {"createdBy": ...}}`). Every list therefore
 * goes through `buildListQuery`, which enforces these lists strictly.
 */
export interface ListQuerySpec extends QuerySpecification {
  /** Scalar columns callers may filter (exact match / OR), range over and order by. No relations. */
  allowedFields: string[];
  /** String columns callers may `contains`-search; Prisma rejects `contains` on enums, booleans and dates. */
  searchableFields: string[];
  maxPageSize: number;
  defaultPageSize: number;
}

type RawQuery = Record<string, string | string[] | undefined>;

const MAX_TEXT_LENGTH = 200;
const MAX_LIST_LENGTH = 50;
const MAX_PAGE = 1_000_000;

const text = z.string().max(MAX_TEXT_LENGTH);
const scalar = z.union([text, z.number(), z.boolean()]);
const bound = z.union([text, z.number()]);

const filtersShape = z.record(
  z.string(),
  z.union([scalar, z.array(scalar).min(1).max(MAX_LIST_LENGTH)]),
);
const searchFiltersShape = z.record(
  z.string(),
  z.union([text, z.array(text).min(1).max(MAX_LIST_LENGTH)]),
);
const rangedFiltersShape = z
  .array(z.object({ key: z.string(), start: bound, end: bound }))
  .max(MAX_LIST_LENGTH);

function firstValue(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first === '' ? undefined : first;
}

/**
 * Parses one JSON-encoded parameter. Malformed JSON or the wrong shape is reported, never
 * silently dropped — ezfilter's own extractor would just ignore a broken `filters` value
 * and return the unfiltered list.
 */
function readJsonParam<T>(
  raw: RawQuery,
  name: string,
  shape: z.ZodType<T>,
  errors: string[],
): T | undefined {
  const source = firstValue(raw[name]);
  if (source === undefined) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    errors.push(`'${name}' must be valid JSON`);
    return undefined;
  }

  const result = shape.safeParse(value);
  if (!result.success) {
    errors.push(`'${name}' has an invalid shape: ${result.error.issues[0]?.message ?? 'invalid'}`);
    return undefined;
  }
  // The parsed JSON itself, not `result.data`: callers check its own keys, and a
  // `__proto__` key would not survive being copied into a fresh object.
  return value as T;
}

function readPositiveInt(
  raw: RawQuery,
  name: string,
  max: number,
  errors: string[],
): number | undefined {
  const source = firstValue(raw[name]);
  if (source === undefined) return undefined;

  const value = /^\d+$/.test(source) ? Number(source) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    errors.push(`'${name}' must be an integer between 1 and ${max}`);
    return undefined;
  }
  return value;
}

function parseListQuery(raw: RawQuery, spec: ListQuerySpec) {
  const errors: string[] = [];
  const filter: FilteringQuery = {};

  const rejectUnlisted = (keys: string[], allowed: string[], use: string) => {
    for (const key of keys) {
      if (!allowed.includes(key)) errors.push(`Field '${key}' cannot be used ${use}`);
    }
  };

  const filters = readJsonParam(raw, 'filters', filtersShape, errors);
  if (filters) {
    rejectUnlisted(Object.keys(filters), spec.allowedFields, 'in filters');
    filter.filters = filters;
  }

  const searchFilters = readJsonParam(raw, 'searchFilters', searchFiltersShape, errors);
  if (searchFilters) {
    rejectUnlisted(Object.keys(searchFilters), spec.searchableFields, 'in searchFilters');
    filter.searchFilters = searchFilters;
  }

  const rangedFilters = readJsonParam(raw, 'rangedFilters', rangedFiltersShape, errors);
  if (rangedFilters) {
    rejectUnlisted(
      rangedFilters.map((range) => range.key),
      spec.allowedFields,
      'in rangedFilters',
    );
    filter.rangedFilters = rangedFilters;
  }

  const orderKey = firstValue(raw.orderKey);
  if (orderKey !== undefined) {
    rejectUnlisted([orderKey], spec.allowedFields, 'for ordering');
    filter.orderKey = orderKey;
  }

  const orderRule = firstValue(raw.orderRule);
  if (orderRule === 'asc' || orderRule === 'desc') {
    filter.orderRule = orderRule;
  } else if (orderRule !== undefined) {
    errors.push("'orderRule' must be 'asc' or 'desc'");
  }

  filter.page = readPositiveInt(raw, 'page', MAX_PAGE, errors);
  filter.rows = readPositiveInt(raw, 'rows', spec.maxPageSize, errors);

  return { filter, errors };
}

/**
 * Wires the standard filters/searchFilters/rangedFilters/orderKey/orderRule/page/rows
 * query contract onto Prisma `findMany` args, scoped to the fields a resource allows.
 * Anything outside the spec is a 422. `mandatoryWhere` is ANDed in so RBAC/ABAC scoping can
 * never be loosened by caller-supplied query params.
 */
export function buildListQuery(
  rawQuery: RawQuery,
  spec: ListQuerySpec,
  mandatoryWhere: Record<string, unknown> = {},
): PrismaQueryOptions {
  const { filter, errors } = parseListQuery(rawQuery, spec);
  if (errors.length > 0) {
    throw new ValidationError('Invalid query parameters', errors);
  }

  const result = new BuildQueryFilter(spec).build(filter);
  const { isValid, errors: buildErrors, warnings } = result.validation;
  if (!isValid || warnings.length > 0) {
    throw new ValidationError('Invalid query parameters', [...buildErrors, ...warnings]);
  }

  return {
    ...result.query,
    where: { AND: [mandatoryWhere, result.query.where] },
  };
}

export function paginate<T>(entries: T[], totalData: number, take: number) {
  return {
    entries,
    totalData,
    totalPage: Math.max(1, Math.ceil(totalData / (take || 1))),
  };
}
