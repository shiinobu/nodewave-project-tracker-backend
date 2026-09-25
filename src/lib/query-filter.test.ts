import { describe, expect, test } from 'bun:test';
import { ValidationError } from './errors';
import { buildListQuery, type ListQuerySpec } from './query-filter';

// Shaped like the "foods" dataset in the standard query-contract document.
const spec: ListQuerySpec = {
  allowedFields: ['name', 'category', 'origin', 'price', 'createdAt'],
  searchableFields: ['name', 'origin'],
  maxPageSize: 50,
  defaultPageSize: 10,
};

const MANDATORY = { deletedAt: null };

function build(query: Record<string, string | string[] | undefined>) {
  return buildListQuery(query, spec, MANDATORY);
}

const json = (value: unknown) => JSON.stringify(value);

describe('buildListQuery — the documented contract still works', () => {
  test('with no parameters it applies only the mandatory scope and the default page', () => {
    const result = build({});
    expect(result.where.AND[0]).toEqual(MANDATORY);
    expect(result.take).toBe(10);
    expect(result.skip).toBe(0);
  });

  test('filters are exact matches, combined with AND', () => {
    const result = build({ filters: json({ category: 'Foreign', origin: 'Germany' }) });
    expect(result.where.AND[1].AND).toEqual([{ category: 'Foreign' }, { origin: 'Germany' }]);
  });

  test('an array filter value is an OR over that column', () => {
    const result = build({ filters: json({ origin: ['Germany', 'Italy'] }) });
    expect(result.where.AND[1].AND).toEqual([{ OR: [{ origin: 'Germany' }, { origin: 'Italy' }] }]);
  });

  test('searchFilters are case-insensitive contains matches', () => {
    const result = build({ searchFilters: json({ origin: 'Ita' }) });
    expect(result.where.AND[1].AND).toEqual([{ origin: { contains: 'Ita', mode: 'insensitive' } }]);
  });

  test('searching several columns matches any of them', () => {
    const result = build({ searchFilters: json({ origin: 'Ita', name: 'Ita' }) });
    expect(result.where.AND[1].AND).toEqual([
      {
        OR: [
          { origin: { contains: 'Ita', mode: 'insensitive' } },
          { name: { contains: 'Ita', mode: 'insensitive' } },
        ],
      },
    ]);
  });

  test('rangedFilters are inclusive', () => {
    const result = build({ rangedFilters: json([{ key: 'price', start: 50000, end: 60000 }]) });
    expect(result.where.AND[1].AND).toEqual([{ price: { gte: 50000, lte: 60000 } }]);
  });

  test('ordering and pagination', () => {
    const result = build({ orderKey: 'price', orderRule: 'desc', page: '3', rows: '20' });
    expect(result.orderBy).toEqual({ price: 'desc' });
    expect(result.take).toBe(20);
    expect(result.skip).toBe(40);
  });

  test('orderRule defaults to ascending', () => {
    expect(build({ orderKey: 'name' }).orderBy).toEqual({ name: 'asc' });
  });

  test('a caller can never loosen the mandatory scope', () => {
    const result = build({ filters: json({ category: 'Local' }) });
    expect(result.where.AND[0]).toEqual(MANDATORY);
  });
});

describe('buildListQuery — anything outside the allow-list is a 422', () => {
  test.each([
    ['a column that is not allow-listed', { filters: json({ password: 'x' }) }],
    [
      'a relation path in filters',
      { filters: json({ 'creator.password': { startsWith: '$2b$' } }) },
    ],
    ['a dotted key in filters', { filters: json({ 'creator.password': '$2b$10$' }) }],
    ['a relation object in filters', { filters: json({ creator: { password: { gt: '$' } } }) }],
    ['an operator object as a filter value', { filters: json({ price: { gt: 0 } }) }],
    ['an object inside an array filter', { filters: json({ origin: [{ contains: 'a' }] }) }],
    ['a null filter value', { filters: json({ origin: null }) }],
    ['an empty array filter value', { filters: json({ origin: [] }) }],
    [
      'a column that is not allow-listed in searchFilters',
      { searchFilters: json({ password: 'a' }) },
    ],
    ['a dotted key in searchFilters', { searchFilters: json({ 'creator.password': '$2b$' }) }],
    ['a non-string column in searchFilters', { searchFilters: json({ category: 'a' }) }],
    ['a non-string value in searchFilters', { searchFilters: json({ name: { startsWith: 'a' } }) }],
    [
      'a column that is not allow-listed in rangedFilters',
      { rangedFilters: json([{ key: 'password', start: 'a', end: 'z' }]) },
    ],
    [
      'a dotted key in rangedFilters',
      { rangedFilters: json([{ key: 'creator.password', start: 'a', end: 'z' }]) },
    ],
    ['a range without an end', { rangedFilters: json([{ key: 'price', start: 1 }]) }],
    [
      'a ranged filter that is not an array',
      { rangedFilters: json({ key: 'price', start: 1, end: 2 }) },
    ],
    ['an orderKey that is not allow-listed', { orderKey: 'password' }],
    ['a dotted orderKey', { orderKey: 'creator.password' }],
    ['an unknown orderRule', { orderKey: 'name', orderRule: 'sideways' }],
    ['a filters payload that is not an object', { filters: json(['a']) }],
    ['a filters payload that is a bare string', { filters: json('a') }],
  ])('rejects %s', (_label, query) => {
    expect(() => build(query)).toThrow(ValidationError);
  });

  test('a rejected key is named in the error details', () => {
    try {
      build({ filters: json({ password: 'x' }) });
      throw new Error('expected a ValidationError');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(JSON.stringify((err as ValidationError).details)).toContain('password');
    }
  });
});

describe('buildListQuery — malformed input is a 422, never silently ignored', () => {
  test.each(['filters', 'searchFilters', 'rangedFilters'])('%s that is not valid JSON', (param) => {
    expect(() => build({ [param]: '{not json' })).toThrow(ValidationError);
  });

  test.each([
    ['page is not a number', { page: 'abc' }],
    ['page is zero', { page: '0' }],
    ['page is negative', { page: '-1' }],
    ['page is fractional', { page: '1.5' }],
    ['rows is not a number', { rows: 'many' }],
    ['rows is zero', { rows: '0' }],
    ['rows is above the resource maximum', { rows: '51' }],
  ])('%s', (_label, query) => {
    expect(() => build(query)).toThrow(ValidationError);
  });

  test('an empty parameter is treated as absent', () => {
    const result = build({ filters: '', searchFilters: '', orderKey: '', page: '', rows: '' });
    expect(result.take).toBe(10);
    expect(result.skip).toBe(0);
  });

  test('a repeated parameter uses its first value, like the rest of the contract', () => {
    const result = build({ filters: [json({ category: 'Local' }), json({ category: 'Foreign' })] });
    expect(result.where.AND[1].AND).toEqual([{ category: 'Local' }]);
  });
});

describe('buildListQuery — a column that can be searched but not filtered', () => {
  const notesSpec: ListQuerySpec = {
    allowedFields: ['name', 'createdAt'],
    searchableFields: ['name', 'notes'],
    maxPageSize: 50,
    defaultPageSize: 10,
  };
  const run = (query: Record<string, string>) => buildListQuery(query, notesSpec, MANDATORY);

  test('is searched like any other string column', () => {
    const result = run({ searchFilters: json({ notes: 'zebra' }) });
    expect(result.where.AND[1].AND).toEqual([
      { notes: { contains: 'zebra', mode: 'insensitive' } },
    ]);
  });

  test('is still refused as an exact filter, a range or an order key', () => {
    expect(() => run({ filters: json({ notes: 'zebra' }) })).toThrow(ValidationError);
    expect(() => run({ rangedFilters: json([{ key: 'notes', start: 'a', end: 'b' }]) })).toThrow(
      ValidationError,
    );
    expect(() => run({ orderKey: 'notes' })).toThrow(ValidationError);
  });
});
