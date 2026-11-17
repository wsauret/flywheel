// oxlint-disable flywheel/no-record, typescript/consistent-indexed-object-style, typescript/consistent-type-assertions, unicorn/no-array-for-each -- vendored upstream source keeps its own style; see UPSTREAM.md
import type { Location, RuleOptionsSchema } from '@oxlint/plugins';
import type {
  JevPluginOptions,
  JevRule,
  ReportNode,
  ResolvedOptions,
  SnippetNode,
  Target,
} from './types.ts';

export const TARGET_NODE_TYPES = {
  function: ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'],
  call: ['CallExpression'],
  jsx: ['JSXElement'],
  file: ['Program'],
} satisfies Record<Target, string[]>;

// An anonymous function in one of these fields inherits its name from the parent's text.
export const NAMED_PARENTS = {
  VariableDeclarator: 'init',
  Property: 'value',
  MethodDefinition: 'value',
  PropertyDefinition: 'value',
} as const;

export type NamedField = (typeof NAMED_PARENTS)[keyof typeof NAMED_PARENTS];

const isNamedParentType = (type: string): type is keyof typeof NAMED_PARENTS =>
  type in NAMED_PARENTS;

const ANONYMOUS_FUNCTIONS = new Set(['FunctionExpression', 'ArrowFunctionExpression']);

export function snippetNodeFor(node: SnippetNode): SnippetNode {
  const parent = node.parent;
  if (parent === null || parent === undefined) return node;
  const parentType = parent.type;
  if (!isNamedParentType(parentType)) return node;
  const field = NAMED_PARENTS[parentType];
  return ANONYMOUS_FUNCTIONS.has(node.type) && parent[field] === node ? parent : node;
}

export const DEFAULTS = {
  ci: 'skip',
  timeoutMs: 10000,
  maxMatchesPerFile: 25,
  maxSnippetChars: 4000,
  model: 'jev-latest',
  longContext: false,
  changedOnly: false,
  changedBase: 'HEAD',
} satisfies Omit<ResolvedOptions, 'rules'>;

// `rules` is absent from DEFAULTS and oxlint validates DEFAULTS against this schema at
// plugin load, so `required: ["rules"]` here would stop the plugin loading at all.
export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ci: { enum: ['skip', 'fail'] },
    timeoutMs: { type: 'integer', minimum: 1 },
    maxMatchesPerFile: { type: 'integer', minimum: 1 },
    maxSnippetChars: { type: 'integer', minimum: 1 },
    model: { type: 'string', minLength: 1 },
    longContext: { type: 'boolean' },
    changedOnly: { type: 'boolean' },
    changedBase: { type: 'string', minLength: 1 },
    rules: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'target', 'question', 'cutoff'],
        properties: {
          id: { type: 'string', minLength: 1 },
          target: { enum: Object.keys(TARGET_NODE_TYPES) },
          question: { type: 'string', minLength: 1 },
          location: {
            type: 'object',
            additionalProperties: false,
            required: ['question', 'cutoff'],
            properties: {
              question: { type: 'string', minLength: 1 },
              cutoff: { type: 'number', minimum: 0.5, exclusiveMinimum: true, maximum: 1 },
            },
          },
          cutoff: { type: 'number', minimum: 0, maximum: 1 },
          message: { type: 'string', minLength: 1 },
        },
      },
    },
  },
} satisfies RuleOptionsSchema;

function fail(message: string): never {
  throw new Error(`oxlint-plugin-jev: ${message}`);
}

function checkRules(rules: readonly JevRule[]): void {
  const seen = new Set<string>();
  for (const { id, target, location, message } of rules) {
    if (location && target !== 'file') fail('location is supported only for file rules');
    if (message !== undefined && message.trim() === '') fail(`rule "${id}" has a blank message`);
    if (seen.has(id)) fail(`rule id "${id}" is used more than once`);
    seen.add(id);
  }
}

// oxlint validates `context.options` against SCHEMA before a rule sees it, so the only checks
// left are the ones a JSON schema cannot express.
export function checkOptions(raw: unknown): ResolvedOptions {
  if (typeof raw !== 'object' || raw === null) fail('options must be an object');
  const options = raw as ResolvedOptions;
  if (!Array.isArray(options.rules)) fail('options.rules must list at least one rule');
  checkRules(options.rules);
  return options;
}

type JsonSchema = {
  type?: string;
  enum?: readonly unknown[];
  minLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: boolean;
  minItems?: number;
  required?: readonly string[];
  additionalProperties?: boolean;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// `createJevPlugin` options never pass through oxlint's validator, so the subset of JSON Schema
// that SCHEMA uses is checked here, against the same SCHEMA, so the two cannot drift apart.
function validate(value: unknown, schema: JsonSchema, at: string): void {
  if (schema.enum && !schema.enum.includes(value)) {
    fail(`${at} must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}`);
  }
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string' || value.length < (schema.minLength ?? 0)) {
        fail(`${at} must be a non-empty string`);
      }
      return;
    case 'boolean':
      if (typeof value !== 'boolean') fail(`${at} must be a boolean`);
      return;
    case 'integer':
    case 'number': {
      const ok =
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (schema.type === 'number' || Number.isInteger(value)) &&
        (schema.minimum === undefined ||
          (schema.exclusiveMinimum ? value > schema.minimum : value >= schema.minimum)) &&
        (schema.maximum === undefined || value <= schema.maximum);
      if (!ok) fail(`${at} is out of range`);
      return;
    }
    case 'array':
      if (!Array.isArray(value) || value.length < (schema.minItems ?? 0)) {
        fail(`${at} must list at least ${schema.minItems ?? 0} item(s)`);
      }
      value.forEach((item, index) => validate(item, schema.items ?? {}, `${at}[${index}]`));
      return;
    case 'object': {
      if (!isRecord(value)) fail(`${at} must be an object`);
      const properties = schema.properties ?? {};
      for (const key of schema.required ?? []) {
        if (!Object.hasOwn(value, key)) fail(`${at}.${key} is required`);
      }
      for (const [key, field] of Object.entries(value)) {
        if (!Object.hasOwn(properties, key)) {
          if (schema.additionalProperties === false) fail(`${at}.${key} is not a known option`);
          continue;
        }
        // SAFETY: the Object.hasOwn check above proved that properties has this key.
        if (field !== undefined) validate(field, properties[key]!, `${at}.${key}`);
      }
    }
  }
}

export function checkPluginOptions(raw: unknown): ResolvedOptions & { name: string } {
  if (!isRecord(raw)) fail('createJevPlugin options must be an object');
  const { name, ...rest } = raw as Partial<JevPluginOptions>;
  if (typeof name !== 'string' || name.trim() === '' || name.includes('/')) {
    fail('createJevPlugin needs a plugin name without "/"');
  }
  validate(rest, { ...SCHEMA, required: ['rules'] }, 'options');
  const options = { ...DEFAULTS, ...rest } as ResolvedOptions;
  checkRules(options.rules);
  for (const { id } of options.rules) {
    if (id.includes('/'))
      fail(`rule id "${id}" cannot contain "/", since it becomes ${name}/${id}`);
  }
  return { ...options, name };
}

function headOf(text: string, line: number, column: number): Location {
  const newline = text.indexOf('\n');
  const length = newline === -1 ? text.length : newline;
  return { start: { line, column }, end: { line, column: column + length } };
}

export const REPORT_LOC = {
  function: (node: ReportNode, text: string): Location =>
    headOf(text, node.loc.start.line, node.loc.start.column),
  call: (node: ReportNode): Location => node.loc,
  jsx: (node: ReportNode): Location => (node.openingElement ?? node).loc,
  file: (_node: ReportNode, text: string): Location => headOf(text, 1, 0),
} satisfies Record<Target, (node: ReportNode, text: string) => Location>;
