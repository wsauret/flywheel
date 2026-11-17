import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

import {
  containsUnknownType,
  functionParameterBindingName,
  functionParameterTypeAnnotation,
} from "../shared/function-parameters.ts";
import { resolveVariable } from "../shared/scope.ts";

type ParameterOwner =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

// Flywheel narrows the fork's rule to inputs that a caller could have typed.
// A thrown or rejected value is unknown by the language's own contract, so
// parameters that receive one stay allowed.
const caughtValueNames: ReadonlySet<string> = new Set(["cause", "err", "error", "exception", "reason"]);
const errorHandlerSlot = /^(?:on|handle)[A-Za-z]*(?:Error|Reject|Rejected|Rejection|Failure)$/u;
// A call by one of these names narrows or decodes its argument: `isRecord(x)`,
// `asRecord(x)`, `assertString(x)`, `parseConfig(x)`, `decodeFact(x)`,
// `schema.safeParse(x)`, `Schema.decodeUnknownSync(schema)(x)`, and `Array.isArray(x)`.
const narrowingCallee = /^(?:is|as|assert|parse|decode|safeParse)(?:[A-Z_]|$)/u;
const decoderSlot = /(?:Decoder|Parser)$/u;
// `thisArg` mirrors the standard library's callback receiver, as in `forEach(callback, thisArg)`.
// It becomes the callback's `this`, which any value may be, so no domain type exists for it.
const receiverParameterName = "thisArg";

/** A type guard (`x is T`) or an assertion function (`asserts x`) names its subject. */
function isTypePredicateSubject(owner: ParameterOwner, parameterName: string): boolean {
  const predicate = owner.returnType?.typeAnnotation;
  return (
    predicate?.type === "TSTypePredicate" &&
    predicate.parameterName.type === "Identifier" &&
    predicate.parameterName.name === parameterName
  );
}

function staticKeyName(key: ESTree.Node): string | null {
  if (key.type === "Identifier" || key.type === "PrivateIdentifier") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return null;
}

/** The name of the property, binding, or attribute that holds the function. */
function slotName(owner: ParameterOwner): string | null {
  if (owner.type === "TSMethodSignature") return staticKeyName(owner.key);
  let parent: ESTree.Node | null = owner.parent;
  while (
    parent !== null &&
    (parent.type === "TSTypeAnnotation" ||
      parent.type === "TSParenthesizedType" ||
      parent.type === "TSUnionType" ||
      parent.type === "ParenthesizedExpression" ||
      parent.type === "JSXExpressionContainer")
  ) {
    parent = parent.parent;
  }
  if (parent === null) return null;
  switch (parent.type) {
    case "Property":
    case "PropertyDefinition":
    case "MethodDefinition":
    case "TSPropertySignature":
      return staticKeyName(parent.key);
    case "VariableDeclarator":
      return parent.id.type === "Identifier" ? parent.id.name : null;
    // A function type that annotates a parameter or a binding: `decode: (value: unknown) => T`.
    case "Identifier":
      return parent.name;
    case "TSTypeAliasDeclaration":
      return parent.id.name;
    case "AssignmentExpression":
      return parent.left.type === "MemberExpression" ? staticKeyName(parent.left.property) : null;
    case "JSXAttribute":
      return parent.name.type === "JSXIdentifier" ? parent.name.name : null;
    default:
      return null;
  }
}

/** `promise.catch(handler)` and `promise.then(onFulfilled, handler)` pass a rejection reason. */
function isRejectionHandlerArgument(owner: ParameterOwner): boolean {
  const call = owner.parent;
  if (call?.type !== "CallExpression" || call.callee.type !== "MemberExpression") return false;
  const method = staticKeyName(call.callee.property);
  return (method === "catch" && call.arguments[0] === owner) || (method === "then" && call.arguments[1] === owner);
}

function receivesCaughtValue(owner: ParameterOwner, parameterName: string): boolean {
  if (caughtValueNames.has(parameterName)) return true;
  if (isRejectionHandlerArgument(owner)) return true;
  const slot = slotName(owner);
  return slot !== null && errorHandlerSlot.test(slot);
}

/** A function held in a slot named like a guard or decoder (`decode`, `parseRow`, `ReplyParser`) is the boundary decode. */
function isDecoderSlot(owner: ParameterOwner): boolean {
  const slot = slotName(owner);
  return slot !== null && (narrowingCallee.test(slot) || decoderSlot.test(slot));
}

const equalityOperators: ReadonlySet<string> = new Set(["===", "!==", "==", "!="]);

function calleeName(callee: ESTree.Node): string | null {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression") return staticKeyName(callee.property);
  if (callee.type === "CallExpression") return calleeName(callee.callee);
  return null;
}

function isFunctionOwner(node: ESTree.Node): node is ESTree.ArrowFunctionExpression | ESTree.Function {
  return node.type === "ArrowFunctionExpression" || node.type === "FunctionDeclaration" || node.type === "FunctionExpression";
}

/** The function that a callee identifier names when it is declared in this file. */
function localFunction(sourceCode: SourceCode, callee: ESTree.Expression): ESTree.ArrowFunctionExpression | ESTree.Function | null {
  if (callee.type !== "Identifier") return null;
  const definition = resolveVariable(sourceCode, callee)?.defs[0];
  if (definition === undefined) return null;
  if (definition.type === "FunctionName" && isFunctionOwner(definition.node)) return definition.node;
  if (definition.type !== "Variable" || definition.node.type !== "VariableDeclarator") return null;
  const init = definition.node.init;
  return init !== null && isFunctionOwner(init) ? init : null;
}

function isSerialization(use: ESTree.Node, call: ESTree.CallExpression | null): boolean {
  if (use.parent?.type === "TemplateLiteral") return true;
  if (call === null) return false;
  const callee = call.callee;
  if (callee.type === "Identifier") return callee.name === "String";
  return (
    callee.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    callee.object.name === "JSON" &&
    staticKeyName(callee.property) === "stringify"
  );
}

/**
 * Whether the body of `owner` handles its unknown parameter at `index` as a boundary does:
 * it narrows the value somewhere (`typeof`, `instanceof`, `in`, an equality test, or a call
 * named like a guard or decoder), or every use passes the value to an exempt function of
 * this file or serializes it with `String()`, `JSON.stringify`, or template interpolation.
 */
function handlesUnknownInBody(
  sourceCode: SourceCode,
  owner: ESTree.ArrowFunctionExpression | ESTree.Function,
  index: number,
  activePath: Set<ESTree.Node>,
): boolean {
  const parameter = owner.params[index];
  if (parameter === undefined || parameter.type !== "Identifier") return false;
  const variable = sourceCode.getDeclaredVariables(owner).find((candidate) => candidate.name === parameter.name);
  const references = variable?.references ?? [];
  if (references.length === 0) return false;
  let everyUseForwards = true;
  for (const reference of references) {
    const use = reference.identifier;
    const parent = use.parent;
    if (parent?.type === "UnaryExpression" && parent.operator === "typeof") return true;
    if (
      parent?.type === "BinaryExpression" &&
      (parent.operator === "instanceof" || parent.operator === "in" || equalityOperators.has(parent.operator))
    ) {
      return true;
    }
    const call = parent?.type === "CallExpression" ? parent : null;
    // oxlint-disable-next-line unicorn/prefer-array-index-of -- `arguments` holds Argument nodes, so `indexOf` does not accept the wider identifier type.
    const argumentIndex = call?.arguments.findIndex((argument) => argument === use) ?? -1;
    if (call !== null && argumentIndex >= 0) {
      const name = calleeName(call.callee);
      if (name !== null && narrowingCallee.test(name)) return true;
      if (isSerialization(use, call)) continue;
      const callee = localFunction(sourceCode, call.callee);
      if (callee !== null && isExemptParameter(sourceCode, callee, argumentIndex, activePath)) continue;
    } else if (isSerialization(use, null)) {
      continue;
    }
    everyUseForwards = false;
  }
  return everyUseForwards;
}

/**
 * Whether the unknown parameter at `index` of `owner` is allowed. `activePath` holds the
 * functions whose bodies the check is evaluating now, so mutual recursion stops; a function
 * leaves it once evaluated, so forwarding to one function twice is not a cycle.
 */
function isExemptParameter(
  sourceCode: SourceCode,
  owner: ParameterOwner,
  index: number,
  activePath: Set<ESTree.Node>,
): boolean {
  const parameter = owner.params[index];
  if (parameter === undefined) return false;
  const name = functionParameterBindingName(parameter, sourceCode);
  if (name === receiverParameterName || isTypePredicateSubject(owner, name) || receivesCaughtValue(owner, name) || isDecoderSlot(owner)) return true;
  if (!isFunctionOwner(owner) || owner.body === null || activePath.has(owner)) return false;
  activePath.add(owner);
  try {
    return handlesUnknownInBody(sourceCode, owner, index, activePath);
  } finally {
    activePath.delete(owner);
  }
}

/** Disallow unknown inputs that the function neither narrows nor receives as a thrown or rejected value. */
export const noUnknownParametersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow explicitly unknown function parameters; decode unknown input at its I/O boundary instead. Allowed: a type-guard or assertion subject; a parameter that receives a thrown or rejected value (named error, err, cause, reason, or exception, a `.catch` or `.then` rejection handler, or an `onError`-style slot); a `thisArg` parameter, which mirrors the standard library's callback receiver; a parameter that the body narrows with `typeof`, `instanceof`, `in`, an equality test, or a call whose name starts with is, as, assert, parse, decode, or safeParse; and a parameter that the body only passes to an allowed parameter of a function in the same file or serializes with `String()`, `JSON.stringify`, or template interpolation. A function held in a slot whose name starts with one of those prefixes or ends in Decoder or Parser is a decoder too. Other bodiless signatures are always checked.",
    },
    messages: {
      unknownParameter:
        "Parameter `{{parameter}}` leaves input unparsed. Accept a named domain type; run the expected schema or parser at the I/O boundary before calling this function.",
    },
  },
  createOnce(context) {
    const checkParameters = (node: ParameterOwner) => {
      for (const [index, parameter] of node.params.entries()) {
        const annotation = functionParameterTypeAnnotation(parameter);
        if (annotation === null || annotation === undefined) continue;
        if (!containsUnknownType(annotation.typeAnnotation)) continue;
        if (isExemptParameter(context.sourceCode, node, index, new Set())) continue;
        context.report({
          node: annotation.typeAnnotation,
          messageId: "unknownParameter",
          data: { parameter: functionParameterBindingName(parameter, context.sourceCode) },
        });
      }
    };

    return {
      ArrowFunctionExpression: checkParameters,
      FunctionDeclaration: checkParameters,
      FunctionExpression: checkParameters,
      TSCallSignatureDeclaration: checkParameters,
      TSConstructSignatureDeclaration: checkParameters,
      TSConstructorType: checkParameters,
      TSDeclareFunction: checkParameters,
      TSEmptyBodyFunctionExpression: checkParameters,
      TSFunctionType: checkParameters,
      TSMethodSignature: checkParameters,
    };
  },
});
