// What outside code does with a field, for field-leak, and the wrappers that
// the rules see through. A use counts against the owner when it writes the
// field (or into it), calls a mutating method on it, or lets a mutable value
// of it escape (return, argument, stored, aliased). Reading, comparing,
// copying, and calling non-mutating methods are reads. A value escapes
// harmlessly when its type is immutable.
import { SignatureKind, SymbolFlags, TypeFlags, type NodeHandle, type Type } from "typescript/unstable/async";
import * as is from "typescript/unstable/ast/is";
import { SyntaxKind as K, ModifierFlags, type Node, type ParameterDeclaration } from "typescript/unstable/ast";
import type { Declarations } from "./build-model.ts";
import type { Item, Reference, Wrapper } from "./model.ts";
import {
  ASSIGN, flagsOf, handleKey, isIncrement, isWriteTarget, keyOf, memberNameOf, passThrough, strip, unwrapFunction, type MemberName,
} from "./syntax.ts";

type Use = { kind: "read" | "write" | "mutate" } | { kind: "escape"; value: Node };
const READ: Use = { kind: "read" };
const WRITE: Use = { kind: "write" };
// CheckFlags.Readonly: a property made readonly by a mapped type such as Readonly<T>.
const CHECK_READONLY = 8;
const SCALAR =
  TypeFlags.StringLike | TypeFlags.NumberLike | TypeFlags.BigIntLike | TypeFlags.BooleanLike | TypeFlags.EnumLike |
  TypeFlags.ESSymbolLike | TypeFlags.Null | TypeFlags.Undefined | TypeFlags.Void | TypeFlags.Never;
const isLibPath = (file: string) => /\/lib\.[^/]*\.d\.ts$/.test(file);

const bodyOf = (decl: Node): Node | undefined => {
  if (is.isFunctionDeclaration(decl) || is.isMethodDeclaration(decl) || is.isGetAccessorDeclaration(decl) || is.isSetAccessorDeclaration(decl)) return decl.body;
  if (is.isPropertyDeclaration(decl) || is.isVariableDeclaration(decl)) {
    const e = decl.initializer && unwrapFunction(decl.initializer);
    if (e && (is.isArrowFunction(e) || is.isFunctionExpression(e))) return e.body;
  }
  return undefined;
};
const paramsOf = (decl: Node): readonly ParameterDeclaration[] | undefined => {
  if (is.isPropertyDeclaration(decl) || is.isVariableDeclaration(decl)) {
    const e = decl.initializer && unwrapFunction(decl.initializer);
    return e && (is.isArrowFunction(e) || is.isFunctionExpression(e)) ? e.parameters : undefined;
  }
  return is.isSignatureDeclaration(decl) ? decl.parameters : undefined;
};
// The one declaration of an item that has a body, with that body.
const onlyBody = (list: readonly Node[]): { decl: Node; body: Node } | undefined => {
  const bodied = list.flatMap((decl) => {
    const body = bodyOf(decl);
    return body ? [{ decl, body }] : [];
  });
  return bodied.length === 1 ? bodied[0] : undefined;
};
const statementsOf = (body: Node): Node[] => (is.isBlock(body) ? [...body.statements] : [body]);
const rootOf = (node: Node): Node => {
  let at = strip(node);
  while (is.isPropertyAccessExpression(at) || is.isElementAccessExpression(at)) at = strip(at.expression);
  return at;
};

// Sets `copies` on every reference that only reads what it uses, and returns
// the wrappers. Two passes: the first collects the escaping values, the
// checker types them, and the second judges each use.
export async function analyseFieldAccess(decls: Declarations): Promise<Map<number, Wrapper>> {
  const { checker, references } = decls;
  const libMutators = await libraryMutators(decls);
  const mutates = mutatingMethods(decls, libMutators);
  const immutable = immutability(decls, libMutators, mutates);
  const access = useAnalysis(decls, libMutators, mutates);
  const asked = new Set<Node>();
  access.analyse((n) => {
    asked.add(n);
    return false;
  });
  const askedNodes = [...asked];
  const askedTypes = askedNodes.length ? await checker.getTypeAtLocation(askedNodes) : [];
  const askedImmutable = await Promise.all(askedTypes.map((t) => immutable(t)));
  const immutableAt = new Map<Node, boolean>();
  for (const [i, n] of askedNodes.entries()) immutableAt.set(n, askedImmutable[i] ?? false);
  for (const r of references) r.copies = false;
  return access.analyse((n) => immutableAt.get(n) ?? false);
}

// Methods that the TypeScript library drops from the readonly view of a
// collection are its mutators (push, splice, set, delete, add, ...).
async function libraryMutators({ checker, sources }: Declarations): Promise<Set<string>> {
  const out = new Set<string>();
  const at = sources[0]?.statements[0];
  const pairs = [["Array", "ReadonlyArray"], ["Map", "ReadonlyMap"], ["Set", "ReadonlySet"]] as const;
  for (const pair of pairs) {
    const [mutable, readonly] = await Promise.all(
      pair.map(async (name) => {
        const s = await checker.resolveName(name, SymbolFlags.Type, at, false);
        const t = s && (await checker.getDeclaredTypeOfSymbol(s));
        return t ? (await checker.getPropertiesOfType(t)).map((p) => p.name) : [];
      }),
    );
    const kept = new Set(readonly);
    for (const name of mutable ?? []) if (!kept.has(name)) out.add(name);
  }
  return out;
}

// A call's method: a workspace item, a library method, or unknown (neither).
interface CalledMethod {
  item?: number;
  lib?: boolean;
}

function methodOf(decls: Declarations, name: Node): CalledMethod {
  const sym = decls.target(decls.symbolAt.get(name));
  if (!sym) return {};
  for (const d of sym.declarations ?? []) {
    const id = decls.itemOfKey.get(handleKey(d));
    if (id !== undefined && decls.items[id]?.kind === "function") return { item: id };
  }
  if ((sym.declarations ?? []).some((d) => isLibPath(d.path))) return { lib: true };
  return {};
}

// Workspace methods that mutate: their body writes state reached from
// `this`, or calls a mutating method on it. Bodiless methods (interface
// members) are unknown, so they count as mutating.
function mutatingMethods(decls: Declarations, libMutators: Set<string>): Map<number, boolean> {
  const { items, bodies } = decls;
  const mutates = new Map<number, boolean>();
  const calledOnThis = new Map<number, number[]>();
  for (const [id, list] of bodies) {
    const it = items[id]!;
    if (it.kind !== "function" || it.parent === null || items[it.parent]?.kind !== "type") continue;
    const body = list.map(bodyOf).find(Boolean);
    if (!body) {
      mutates.set(id, true);
      continue;
    }
    let direct = false;
    const deps: number[] = [];
    const visit = (n: Node) => {
      if (direct) return;
      let written: Node | undefined;
      if (is.isBinaryExpression(n) && ASSIGN.has(n.operatorToken.kind)) written = n.left;
      else if (isIncrement(n)) written = n.operand;
      else if (is.isDeleteExpression(n)) written = n.expression;
      if (written && (is.isPropertyAccessExpression(strip(written)) || is.isElementAccessExpression(strip(written))) && rootOf(written).kind === K.ThisKeyword) direct = true;
      const callee = is.isCallExpression(n) ? strip(n.expression) : undefined;
      const name = memberNameOf(callee);
      if (callee && name && is.isAccessExpression(callee) && rootOf(callee.expression).kind === K.ThisKeyword) {
        const m = methodOf(decls, name);
        if (m.item !== undefined) deps.push(m.item);
        else if (!m.lib || libMutators.has(name.text)) direct = true;
      }
      n.forEachChild(visit);
    };
    visit(body);
    if (direct) mutates.set(id, true);
    else calledOnThis.set(id, deps);
  }
  // Every inspected method starts at its own result, so a read-only method
  // that calls another read-only method stays read-only; a callee that was
  // not inspected is unknown and counts as mutating.
  for (const id of calledOnThis.keys()) mutates.set(id, false);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [id, deps] of calledOnThis) {
      if (mutates.get(id) || !deps.some((d) => mutates.get(d) ?? true)) continue;
      mutates.set(id, true);
      changed = true;
    }
  }
  return mutates;
}

// Immutable types: scalars, functions, readonly arrays and tuples of
// immutable values, and objects whose every property is readonly and
// immutable and whose every method does not mutate. Promises are immutable
// by this rule: then, catch, and finally do not mutate.
function immutability(decls: Declarations, libMutators: Set<string>, mutates: Map<number, boolean>): (t: Type | undefined) => Promise<boolean> {
  const { checker, project, itemOfKey, sources } = decls;
  // Member declarations of the workspace, by handle; others resolve once each.
  const memberNode = new Map<string, Node>();
  for (const sf of sources) {
    const visit = (n: Node) => {
      if (
        is.isPropertyDeclaration(n) || is.isPropertySignatureDeclaration(n) || is.isMethodDeclaration(n) || is.isMethodSignatureDeclaration(n) ||
        is.isGetAccessorDeclaration(n) || is.isSetAccessorDeclaration(n) || is.isParameterDeclaration(n) || is.isPropertyAssignment(n) ||
        is.isShorthandPropertyAssignment(n)
      ) {
        memberNode.set(keyOf(n), n);
      }
      n.forEachChild(visit);
    };
    visit(sf);
  }
  const outsideNode = new Map<string, Promise<Node | undefined>>();
  const resolveOutside = (decl: NodeHandle): Promise<Node | undefined> => {
    const k = handleKey(decl);
    const known = outsideNode.get(k);
    if (known) return known;
    const pending = decl.resolve(project).catch(() => undefined);
    outsideNode.set(k, pending);
    return pending;
  };
  const cache = new Map<string, Promise<boolean>>();
  const immutable = (t: Type | undefined, depth = 0): Promise<boolean> => {
    if (!t) return Promise.resolve(false);
    const k = `${t.id}:${depth}`;
    let pending = cache.get(k);
    if (!pending) {
      pending = compute(t, depth).catch(() => false);
      cache.set(k, pending);
    }
    return pending;
  };
  const all = async (types: readonly Type[] | undefined, depth: number) =>
    (await Promise.all((types ?? []).map((part) => immutable(part, depth + 1)))).every(Boolean);
  const compute = async (t: Type, depth: number): Promise<boolean> => {
    if (t.flags & SCALAR) return true;
    if (depth > 4) return false;
    if (t.isUnionType() || t.isIntersectionType()) return all(await t.getTypes(), depth);
    if (!(t.flags & TypeFlags.Object)) return false;
    if ((await checker.getSignaturesOfType(t, SignatureKind.Call)).length > 0) return true;
    const [array, tuple] = await Promise.all([checker.isArrayType(t), checker.isTupleType(t)]);
    if (array || tuple) {
      if (!t.isTypeReference()) return false;
      const target = tuple ? await t.getTarget() : undefined;
      const readonly = (await t.getSymbol())?.name === "ReadonlyArray" || Boolean(target?.isTupleType() && target.readonly);
      return readonly && all(await checker.getTypeArguments(t), depth);
    }
    for (const info of await checker.getIndexInfosOfType(t)) if (!info.isReadonly || !(await immutable(info.valueType, depth + 1))) return false;
    for (const prop of await checker.getPropertiesOfType(t)) {
      const decl = (prop.declarations ?? [])[0];
      if (!decl) return false;
      const node = memberNode.get(handleKey(decl)) ?? (await resolveOutside(decl));
      if (!node) return false;
      if (is.isMethodSignatureDeclaration(node) || is.isMethodDeclaration(node)) {
        const id = itemOfKey.get(handleKey(decl));
        const mutating = id !== undefined ? (mutates.get(id) ?? true) : isLibPath(decl.path) ? libMutators.has(prop.name) : true;
        if (mutating) return false;
        continue;
      }
      const readonly =
        Boolean(prop.checkFlags & CHECK_READONLY) ||
        Boolean(flagsOf(node) & ModifierFlags.Readonly) ||
        (is.isGetAccessorDeclaration(node) && !(prop.declarations ?? []).some((d) => d.kind === K.SetAccessor));
      if (!readonly || !(await immutable(await checker.getTypeOfSymbol(prop), depth + 1))) return false;
    }
    return true;
  };
  return immutable;
}

function useAnalysis(decls: Declarations, libMutators: Set<string>, mutates: Map<number, boolean>) {
  const { items, bodies, references, accesses } = decls;
  const mutatingCall = (name: MemberName): boolean => {
    const m = methodOf(decls, name);
    if (m.item !== undefined) return mutates.get(m.item) ?? true;
    if (m.lib) return libMutators.has(name.text);
    return true;
  };
  // Whether the value at `place` leaves the expression: returned, passed,
  // stored, aliased, or put into a literal. Spreading copies it.
  const escapes = (place: Node): Node | null => {
    let cur = place;
    let p = cur.parent;
    while (p && passThrough(p)) {
      cur = p;
      p = p.parent;
    }
    if (!p) return null;
    if (is.isReturnStatement(p) || is.isYieldExpression(p) || is.isThrowStatement(p) || is.isJsxExpression(p)) return cur;
    if (is.isArrowFunction(p) && p.body === cur) return cur;
    if ((is.isCallExpression(p) || is.isNewExpression(p)) && p.expression !== cur) return cur;
    if (is.isArrayLiteralExpression(p)) return cur;
    if ((is.isPropertyAssignment(p) || is.isVariableDeclaration(p)) && p.initializer === cur) return cur;
    if (is.isBinaryExpression(p)) {
      const op = p.operatorToken.kind;
      if (op === K.EqualsToken && p.right === cur) return cur;
      if (op === K.BarBarToken || op === K.QuestionQuestionToken || (op === K.AmpersandAmpersandToken && p.right === cur)) return escapes(p) ? cur : null;
      return null;
    }
    if (is.isConditionalExpression(p) && p.condition !== cur) return escapes(p) ? cur : null;
    return null;
  };
  const useOf = (place: Node): Use => {
    let cur = place;
    for (;;) {
      let p = cur.parent;
      while (p && passThrough(p)) {
        cur = p;
        p = p.parent;
      }
      if (!p) break;
      if (is.isAccessExpression(p) && p.expression === cur) {
        const name = memberNameOf(p);
        const call = p.parent;
        if (name && is.isCallExpression(call) && strip(call.expression) === p) return mutatingCall(name) ? { kind: "mutate" } : READ;
        if (isWriteTarget(p)) return WRITE;
        cur = p;
        continue;
      }
      if (is.isCallExpression(p) && p.expression === cur) return READ;
      break;
    }
    if (isWriteTarget(cur)) return WRITE;
    const value = escapes(cur);
    return value ? { kind: "escape", value } : READ;
  };
  const fieldUse = (id: Node): Use => {
    const p = id.parent;
    if (memberNameOf(p) === id) return useOf(p);
    if (is.isBindingElement(p) && p.name) return { kind: "escape", value: p.name };
    return READ;
  };
  const callUse = (id: Node, role: Item["accessorRole"]): Use => {
    const p = id.parent;
    if (memberNameOf(p) !== id) return WRITE;
    if (role === "get") return useOf(p);
    const call = p.parent;
    if (!is.isCallExpression(call) || call.expression !== p) return WRITE;
    return useOf(call);
  };
  // field-leak judges only fields of types whose own methods work on state.
  const working = new Set<number>();
  for (const [id, list] of bodies) {
    const it = items[id]!;
    if (it.kind === "function" && it.takesSelf && it.parent !== null && list.some(bodyOf)) working.add(it.parent);
  }
  const insideOwner = (r: Reference): boolean => {
    const owner = items[r.item]!.parent;
    for (let at = r.holder; at !== null; at = items[at]!.parent) if (at === owner) return true;
    return false;
  };
  const parameterCount = new Map<number, number>();
  for (const [id, list] of bodies) {
    if (items[id]!.kind !== "function") continue;
    const decl = list.find(bodyOf) ?? list[0];
    parameterCount.set(id, (decl && paramsOf(decl)?.length) ?? 0);
  }
  const wrapperContext = { decls, parameterCount };
  const analyse = (immutableAt: (n: Node) => boolean): Map<number, Wrapper> => {
    const onlyReads = (use: Use): boolean => use.kind === "read" || (use.kind === "escape" && immutableAt(use.value));
    for (const [i, r] of references.entries()) {
      const it = items[r.item]!;
      // The owner's own uses never count, so only outside uses are judged.
      r.copies = it.kind === "field" && it.parent !== null && working.has(it.parent) && !insideOwner(r) ? onlyReads(fieldUse(accesses[i]!)) : false;
    }
    const wrappers = buildWrappers(wrapperContext, (n) => onlyReads(fieldUse(n)));
    for (const [i, r] of references.entries()) {
      let called = r.item;
      for (let w = wrappers.get(called); w?.kind === "forwarder"; w = wrappers.get(called)) called = w.target;
      const w = wrappers.get(called);
      if (w?.kind === "accessor" && w.toRead && w.lent.length) r.copies = onlyReads(callUse(accesses[i]!, items[called]!.accessorRole));
    }
    return wrappers;
  };
  return { analyse };
}

interface WrapperContext {
  decls: Declarations;
  parameterCount: Map<number, number>;
}

function buildWrappers(context: WrapperContext, readAt: (n: Node) => boolean): Map<number, Wrapper> {
  const wrappers = new Map<number, Wrapper>();
  const forwardings = findForwarders(context);
  const reaches = (from: number, to: number) => {
    for (let at = from; ; ) {
      if (at === to) return true;
      const w = wrappers.get(at);
      if (w?.kind !== "forwarder") return false;
      at = w.target;
    }
  };
  for (const f of forwardings) if (!reaches(f.target, f.forwarder)) wrappers.set(f.forwarder, { kind: "forwarder", target: f.target, fields: f.fields });
  findAccessors(context.decls, wrappers, readAt);
  return wrappers;
}

// Functions whose one statement calls another function with exactly their
// own parameters, on `this`, a field path of `this`, a parameter, or a
// module.
function findForwarders({ decls, parameterCount }: WrapperContext): { forwarder: number; target: number; fields: number[] }[] {
  const { items, bodies, symbolAt, declItems, ctorsOfClass, target } = decls;
  const out: { forwarder: number; target: number; fields: number[] }[] = [];
  for (const [id, list] of bodies) {
    const it = items[id]!;
    if (it.kind !== "function" || it.traitImpl) continue;
    const only = onlyBody(list);
    if (!only) continue;
    const names = new Set<number>();
    for (const p of paramsOf(only.decl) ?? []) {
      const s = is.isIdentifier(p.name) ? symbolAt.get(p.name) : undefined;
      if (s) names.add(s.id);
    }
    const stmts = statementsOf(only.body);
    const s = stmts[0];
    if (!s || stmts.length !== 1) continue;
    const found = is.isReturnStatement(s) || is.isExpressionStatement(s) ? s.expression : is.isExpression(s) ? s : undefined;
    if (!found) continue;
    const e = strip(found);
    if (!is.isCallExpression(e) && !is.isNewExpression(e)) continue;
    const args: Node[] = e.arguments ? [...e.arguments] : [];
    const isParam = (a: Node) => is.isIdentifier(a) && names.has(symbolAt.get(a)?.id ?? -1);
    if (!args.every((a) => isParam(strip(a)))) continue;
    const call = calleeOf(decls, strip(e.expression), names);
    if (!call) continue;
    const targets = is.isNewExpression(e)
      ? (target(symbolAt.get(call.name))?.declarations ?? []).flatMap((d) => ctorsOfClass.get(handleKey(d)) ?? [])
      : declItems(symbolAt.get(call.name), false).filter((t) => items[t]?.kind === "function");
    if (targets.length !== 1) continue;
    const tgt = targets[0]!;
    if (tgt === id) continue;
    const targetSelf = items[tgt]!.takesSelf ? 1 : 0;
    if ((parameterCount.get(tgt) ?? -1) + targetSelf !== args.length + call.receiver) continue;
    if (!targetSelf && call.receiver) continue;
    out.push({ forwarder: id, target: tgt, fields: call.fields });
  }
  return out.sort((a, b) => a.forwarder - b.forwarder);
}

// The name that a forwarding call calls, the fields of `this` on the way to
// its receiver, and whether it has a receiver; null for any other callee.
function calleeOf(decls: Declarations, callee: Node, params: Set<number>): { name: Node; fields: number[]; receiver: number } | null {
  const { items, symbolAt, declItems } = decls;
  if (is.isIdentifier(callee)) return { name: callee, fields: [], receiver: 0 };
  if (!is.isPropertyAccessExpression(callee)) return null;
  let r = strip(callee.expression);
  const fieldPath: number[] = [];
  while (is.isPropertyAccessExpression(r)) {
    const f = declItems(symbolAt.get(r.name), false)[0];
    if (f === undefined || items[f]?.kind !== "field") return null;
    fieldPath.unshift(f);
    r = strip(r.expression);
  }
  if (r.kind === K.ThisKeyword) return { name: callee.name, fields: fieldPath, receiver: 1 };
  if (!is.isIdentifier(r) || fieldPath.length > 0) return null;
  const rs = symbolAt.get(r);
  if (rs && params.has(rs.id)) return { name: callee.name, fields: [], receiver: 1 };
  if (rs && rs.flags & (SymbolFlags.Alias | SymbolFlags.ValueModule)) return { name: callee.name, fields: [], receiver: 0 };
  return null;
}

// Methods whose statements only hand out fields of `this` (alone or in array
// and object literals) or store a parameter into one.
function findAccessors(decls: Declarations, wrappers: Map<number, Wrapper>, readAt: (n: Node) => boolean): void {
  const { items, bodies, symbolAt, declItems } = decls;
  const ownFieldOf = (expression: Node, cls: number): { field: number; node: Node } | null => {
    const e = strip(expression);
    if (!is.isPropertyAccessExpression(e) || strip(e.expression).kind !== K.ThisKeyword) return null;
    const f = declItems(symbolAt.get(e.name), false)[0];
    return f !== undefined && items[f]?.kind === "field" && items[f]?.parent === cls ? { field: f, node: e.name } : null;
  };
  for (const [id, list] of bodies) {
    const it = items[id]!;
    const cls = it.parent;
    if (it.kind !== "function" || it.traitImpl || !it.takesSelf || wrappers.has(id) || cls === null) continue;
    const only = onlyBody(list);
    if (!only) continue;
    const params = new Set<number>();
    for (const p of paramsOf(only.decl) ?? []) {
      const s = is.isIdentifier(p.name) ? symbolAt.get(p.name) : undefined;
      if (s) params.add(s.id);
    }
    const mentions: { field: number; node: Node }[] = [];
    let writes = false;
    let ok = true;
    const handedOut = (expression: Node): boolean => {
      const e = strip(expression);
      const own = ownFieldOf(e, cls);
      if (own !== null) {
        mentions.push(own);
        return true;
      }
      if (is.isArrayLiteralExpression(e)) return e.elements.length > 0 && [...e.elements].every((x: Node) => handedOut(x));
      if (is.isObjectLiteralExpression(e)) return e.properties.length > 0 && [...e.properties].every((p: Node) => is.isPropertyAssignment(p) && handedOut(p.initializer));
      return false;
    };
    for (const s of statementsOf(only.body)) {
      if (is.isReturnStatement(s) && s.expression) ok &&= handedOut(s.expression);
      else if (is.isExpressionStatement(s) || is.isExpression(s)) {
        const ex = strip(is.isExpressionStatement(s) ? s.expression : s);
        if (is.isBinaryExpression(ex) && ex.operatorToken.kind === K.EqualsToken) {
          const own = ownFieldOf(ex.left, cls);
          const v = strip(ex.right);
          if (own !== null && is.isIdentifier(v) && params.has(symbolAt.get(v)?.id ?? -1)) {
            mentions.push(own);
            writes = true;
          } else ok = false;
        } else ok &&= !is.isExpressionStatement(s) && handedOut(ex);
      } else ok = false;
      if (!ok) break;
    }
    if (!ok || mentions.length === 0) continue;
    // A named method that stores its argument is a command of the owner; only
    // a `set` accessor dresses a write up as the field itself.
    if (writes && it.accessorRole !== "set") continue;
    const fields = [...new Set(mentions.map((m) => m.field))].sort((a, b) => a - b);
    const readOnly = (f: number) => mentions.filter((m) => m.field === f).every((m) => readAt(m.node));
    wrappers.set(id, { kind: "accessor", lent: fields.filter((f) => !readOnly(f)), copied: fields.filter(readOnly), toRead: !writes && it.accessorRole !== "set" });
  }
}
