// Query Builder for Prisma (MongoDB provider)
// Senior-level hardened version: safe operator parsing, field whitelisting,
// capped pagination, conflict-free `where` merging, and no leftover debug logs.

type PrismaOperator =
  | "equals"
  | "not"
  | "in"
  | "notIn"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "contains"
  | "startsWith"
  | "endsWith";

const ALLOWED_OPERATORS: ReadonlySet<string> = new Set([
  "equals",
  "not",
  "in",
  "notIn",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
  "startsWith",
  "endsWith",
]);

const DEFAULT_EXCLUDED_FIELDS = ["searchTerm", "sort", "limit", "page", "fields"];
const MAX_LIMIT = 100; // hard cap to prevent unbounded/expensive queries
const DEFAULT_LIMIT = 10;

interface QueryBuilderOptions {
  /** Only these fields may be used for filter()/search(). If omitted, filtering is unrestricted (not recommended for public APIs). */
  allowedFilterFields?: string[];
  /** Override the max page size. Defaults to 100. */
  maxLimit?: number;
}

/**
 * Attempts to coerce a raw query-string value into the correct JS type
 * (number -> boolean -> Date -> string), since everything arrives as a string.
 */
function coerceValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;

  // Numeric (handles ints and floats, but not empty string / NaN-prone input)
  if (raw.trim() !== "" && !Number.isNaN(Number(raw))) {
    return Number(raw);
  }

  // ISO date detection (basic, safe check before trusting Date parsing)
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z?)?$/.test(raw)) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }

  return raw;
}

class QueryBuilder<T = any> {
  private model: {
    findMany: (args: any) => Promise<any[]>;
    count: (args: any) => Promise<number>;
  };
  private query: Record<string, unknown>;
  private prismaQuery: Record<string, any> = {};
  private whereConditions: any[] = []; // combined with AND to avoid key-collision overwrites
  private allowedFilterFields?: Set<string>;
  private maxLimit: number;

  constructor(
    model: QueryBuilder<T>["model"],
    query: Record<string, unknown>,
    options: QueryBuilderOptions = {}
  ) {
    this.model = model;
    this.query = query;
    this.allowedFilterFields = options.allowedFilterFields
      ? new Set(options.allowedFilterFields)
      : undefined;
    this.maxLimit = options.maxLimit ?? MAX_LIMIT;
  }

  private isFieldAllowed(field: string): boolean {
    if (!this.allowedFilterFields) return true; // no whitelist configured
    const topLevel = field.split(".")[0];
    return this.allowedFilterFields.has(field) || this.allowedFilterFields.has(topLevel);
  }

  /** Full-text-ish search (case-insensitive contains) across given fields, supporting infinitely nested relation fields (e.g., "user.profile.address.city"). */
  search(searchableFields: string[]) {
    const searchTerm = this.query.searchTerm;
    if (typeof searchTerm !== "string" || searchTerm.trim() === "") return this;

    const fields = searchableFields.filter((f) => this.isFieldAllowed(f));
    if (fields.length === 0) return this;

    const orConditions = fields.map((field) => {
      const keys = field.split(".");
      
      const buildNestedCondition = (keysList: string[], value: string): any => {
        if (keysList.length === 1) {
          return { [keysList[0]]: { contains: value, mode: "insensitive" } };
        }
        const [currentKey, ...restKeys] = keysList;
        return { [currentKey]: { is: buildNestedCondition(restKeys, value) } };
      };

      return buildNestedCondition(keys, searchTerm);
    });

    this.whereConditions.push({ OR: orConditions });
    return this;
  }

  /**
   * Filter based on query params. Supports operator syntax like:
   *   price[gte]=100, status[in]=ACTIVE,PENDING, createdAt[lte]=2024-01-01
   * Values are type-coerced (number/boolean/date/string) instead of blindly parseFloat'd.
   */
  filter() {
    const queryObj = { ...this.query };
    DEFAULT_EXCLUDED_FIELDS.forEach((field) => delete queryObj[field]);

    for (const [key, rawValue] of Object.entries(queryObj)) {
      if (rawValue === undefined || rawValue === null) continue;

      let field = key;
      let operator: string | null = null;

      const bracketMatch = key.match(/^([^[]+)\[([^\]]+)\]$/);
      if (bracketMatch) {
        field = bracketMatch[1];
        operator = bracketMatch[2];
      }

      if (!this.isFieldAllowed(field)) continue; // silently drop disallowed fields

      if (operator) {
        if (!ALLOWED_OPERATORS.has(operator)) continue; // ignore unknown/unsafe operators

        if (operator === "in" || operator === "notIn") {
          const values = String(rawValue)
            .split(",")
            .map((v) => coerceValue(v.trim()));
          this.whereConditions.push({ [field]: { [operator as PrismaOperator]: values } });
        } else {
          this.whereConditions.push({
            [field]: { [operator as PrismaOperator]: coerceValue(String(rawValue)) },
          });
        }
      } else {
        this.whereConditions.push({ [field]: coerceValue(String(rawValue)) });
      }
    }

    return this;
  }

  /**
   * Escape hatch for filters constructed programmatically (e.g. by the controller/service layer),
   * bypassing field whitelisting since the caller is trusted server-side code, not raw user input.
   */
  rawFilter(filters: Record<string, any>) {
    if (filters && Object.keys(filters).length > 0) {
      this.whereConditions.push(filters);
    }
    return this;
  }

  /**
   * Sorting. Note: on MongoDB, Prisma only supports orderBy on nested relations
   * for one-to-one relations, not one-to-many.
   * Supports infinitely nested sorting (e.g., "-user.profile.age").
   */
  sort() {
    const sortParam = (this.query.sort as string) || "-createdAt";
    const sortFields = sortParam.split(",").filter(Boolean);

    this.prismaQuery.orderBy = sortFields.map((field) => {
      const desc = field.startsWith("-");
      const cleanField = desc ? field.slice(1) : field;
      const direction = desc ? "desc" : "asc";

      const keys = cleanField.split(".");
      
      const buildNestedOrderBy = (keysList: string[], dir: string): any => {
        if (keysList.length === 1) {
          return { [keysList[0]]: dir };
        }
        const [currentKey, ...restKeys] = keysList;
        return { [currentKey]: buildNestedOrderBy(restKeys, dir) };
      };

      return buildNestedOrderBy(keys, direction);
    });

    return this;
  }

  /** Pagination, with limit capped to prevent unbounded/expensive queries. */
  paginate() {
    const page = Math.max(1, Number(this.query.page) || 1);
    const requestedLimit = Number(this.query.limit) || DEFAULT_LIMIT;
    const limit = Math.min(Math.max(1, requestedLimit), this.maxLimit);
    const skip = (page - 1) * limit;

    this.prismaQuery.skip = skip;
    this.prismaQuery.take = limit;

    return this;
  }

  /** Field selection. Mutually exclusive with include() — Prisma throws if both select and include are set. */
  fields() {
    const fieldsParam = this.query.fields as string;
    if (!fieldsParam) return this;

    const fieldList = fieldsParam.split(",").filter(Boolean);
    if (fieldList.length === 0) return this;

    if (this.prismaQuery.include) {
      throw new Error(
        "QueryBuilder: cannot use `fields` selection together with `include` — Prisma does not allow `select` and `include` at the same level."
      );
    }

    this.prismaQuery.select = fieldList.reduce(
      (acc: Record<string, boolean>, field) => {
        acc[field.trim()] = true;
        return acc;
      },
      {}
    );

    return this;
  }

  /** Include related models. Mutually exclusive with fields()/select. */
  include(includableFields: Record<string, boolean | object>) {
    if (this.prismaQuery.select) {
      throw new Error(
        "QueryBuilder: cannot use `include` together with `fields` selection — Prisma does not allow `select` and `include` at the same level."
      );
    }

    this.prismaQuery.include = {
      ...this.prismaQuery.include,
      ...includableFields,
    };
    return this;
  }

  /** Builds the final `where` clause by combining all accumulated conditions with AND (avoids silent key overwrites). */
  private buildWhere() {
    if (this.whereConditions.length === 0) return undefined;
    if (this.whereConditions.length === 1) return this.whereConditions[0];
    return { AND: this.whereConditions };
  }

  private getFinalQuery() {
    return {
      ...this.prismaQuery,
      where: this.buildWhere(),
    };
  }

  /** Preview the final Prisma args without executing — useful for debugging/tests instead of console.log. */
  debugQuery() {
    return this.getFinalQuery();
  }

  async execute() {
    return this.model.findMany(this.getFinalQuery());
  }

  async countTotal() {
    const where = this.buildWhere();
    const total = await this.model.count({ where });
    const page = Math.max(1, Number(this.query.page) || 1);
    const limit = Math.min(
      Math.max(1, Number(this.query.limit) || DEFAULT_LIMIT),
      this.maxLimit
    );
    const totalPage = Math.ceil(total / limit) || 1;

    return { page, limit, total, totalPage };
  }
}

export default QueryBuilder;