// Syntax helpers over the remote AST of the TypeScript 7 API, shared by the
// two phases of the model builder.
import * as is from "typescript/unstable/ast/is";
import {
  SyntaxKind as K, ModifierFlags, type MemberName as TsMemberName, type ModifiersBase, type Node, type PostfixUnaryExpression,
  type PrefixUnaryExpression, type StringLiteralLikeNode,
} from "typescript/unstable/ast";

// A name that resolves to a member: an identifier, or the literal of `a["b"]`.
export type MemberName = TsMemberName | StringLiteralLikeNode;

export const unwrapFunction = (node: Node): Node => {
  let at = node;
  while (at && (is.isParenthesizedExpression(at) || is.isAsExpression(at) || is.isSatisfiesExpression(at))) at = at.expression;
  return at;
};

export const isFunctionLike = (node: Node | undefined): boolean => {
  if (!node) return false;
  const at = unwrapFunction(node);
  return is.isArrowFunction(at) || is.isFunctionExpression(at);
};

// The expression below parentheses, type assertions, non-null assertions,
// and awaits.
export const strip = (node: Node): Node => {
  let at = node;
  while (
    is.isParenthesizedExpression(at) ||
    is.isAsExpression(at) ||
    is.isSatisfiesExpression(at) ||
    is.isNonNullExpression(at) ||
    is.isTypeAssertion(at) ||
    is.isAwaitExpression(at)
  ) {
    at = at.expression;
  }
  return at;
};

// Every remote node answers `modifierFlags`; the shipped types declare it
// only on the declarations that can hold modifiers.
const hasModifiers = (node: Node): node is ModifiersBase => "modifierFlags" in node;
export const flagsOf = (node: Node): ModifierFlags => (hasModifiers(node) ? node.modifierFlags : ModifierFlags.None);
export const isStatic = (node: Node) => Boolean(flagsOf(node) & ModifierFlags.Static);
// The `name` of a declaration. The shipped types declare it only on the
// concrete declaration interfaces, not on the unions of their bases.
export const hasName = (node: Node): node is Node & { readonly name: Node | undefined } => "name" in node;
export const nameOf = (node: Node): Node | undefined => (hasName(node) ? node.name : undefined);
// A node and a declaration handle of the same node share this key.
// oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: every remote node carries the `index` of its handle, which the shipped types do not declare
export const keyOf = (node: Node): string => `${node.getSourceFile().path}#${(node as Node & { readonly index: number }).index}`;
export const handleKey = (handle: { path: string; index: number }) => `${handle.path}#${handle.index}`;
export const textOfName = (node: Node | undefined): string | null =>
  node && (is.isIdentifier(node) || is.isPrivateIdentifier(node) || is.isStringLiteral(node)) ? node.text : null;

// The node that names the member that `node` accesses: the name of `a.b`, or
// the literal of `a["b"]`, which the checker resolves to the same property.
export const memberNameOf = (node: Node | undefined): MemberName | undefined => {
  if (!node) return undefined;
  if (is.isPropertyAccessExpression(node)) return node.name;
  if (!is.isElementAccessExpression(node)) return undefined;
  return is.isStringLiteralLikeNode(node.argumentExpression) ? node.argumentExpression : undefined;
};

// Declarations whose name is not a reference (TypeScript's isDeclaration).
export const DECLARATION_KINDS = new Set<number>([
  K.ArrowFunction, K.BindingElement, K.ClassDeclaration, K.ClassExpression, K.ClassStaticBlockDeclaration, K.Constructor,
  K.EnumDeclaration, K.EnumMember, K.ExportSpecifier, K.FunctionDeclaration, K.FunctionExpression, K.GetAccessor, K.ImportClause,
  K.ImportEqualsDeclaration, K.ImportSpecifier, K.InterfaceDeclaration, K.JsxAttribute, K.MethodDeclaration, K.MethodSignature,
  K.MissingDeclaration, K.ModuleDeclaration, K.NamespaceExportDeclaration, K.NamespaceImport, K.NamespaceExport, K.Parameter,
  K.PropertyAssignment, K.PropertyDeclaration, K.PropertySignature, K.SetAccessor, K.ShorthandPropertyAssignment,
  K.TypeAliasDeclaration, K.TypeParameter, K.VariableDeclaration,
]);
export const PARAMETER_PROPERTY =
  ModifierFlags.Public | ModifierFlags.Private | ModifierFlags.Protected | ModifierFlags.Readonly | ModifierFlags.Override;

export const ASSIGN = new Set<number>([
  K.EqualsToken, K.PlusEqualsToken, K.MinusEqualsToken, K.AsteriskEqualsToken, K.SlashEqualsToken, K.PercentEqualsToken,
  K.AsteriskAsteriskEqualsToken, K.LessThanLessThanEqualsToken, K.GreaterThanGreaterThanEqualsToken,
  K.GreaterThanGreaterThanGreaterThanEqualsToken, K.AmpersandEqualsToken, K.BarEqualsToken, K.CaretEqualsToken,
  K.BarBarEqualsToken, K.AmpersandAmpersandEqualsToken, K.QuestionQuestionEqualsToken,
]);

export const passThrough = (node: Node) =>
  is.isParenthesizedExpression(node) ||
  is.isNonNullExpression(node) ||
  is.isAsExpression(node) ||
  is.isSatisfiesExpression(node) ||
  is.isTypeAssertion(node);

export const isIncrement = (node: Node): node is PrefixUnaryExpression | PostfixUnaryExpression =>
  (is.isPrefixUnaryExpression(node) || is.isPostfixUnaryExpression(node)) &&
  (node.operator === K.PlusPlusToken || node.operator === K.MinusMinusToken);

// Whether the expression at `place` is assigned, incremented, or deleted.
export const isWriteTarget = (place: Node): boolean => {
  let at = place;
  let parent = at.parent;
  while (parent && passThrough(parent)) {
    at = parent;
    parent = parent.parent;
  }
  if (!parent) return false;
  if (is.isBinaryExpression(parent) && parent.left === at && ASSIGN.has(parent.operatorToken.kind)) return true;
  return isIncrement(parent) || is.isDeleteExpression(parent);
};

// Runs `task` over `xs` with at most `size` calls in flight, keeping order.
export async function inBatches<T, R>(xs: readonly T[], size: number, task: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await task(xs[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, xs.length) }, worker));
  return out;
}
