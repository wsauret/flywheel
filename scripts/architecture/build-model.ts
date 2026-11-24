// Builds the plain model from the TypeScript 7 async API: the items that the
// files declare, every reference from code to an item outside import and
// export declarations, and (in field-access.ts) what outside code does with
// fields. Port of deslop-please src/model (MIT), whose model is Rust's.
//
// The checker lives in a separate process that the `typescript` package
// starts, so every checker question is a request. The build asks them in
// batches, in phases: fetch the files, resolve every identifier, resolve
// aliases and the few context questions, then run the syntactic analysis
// synchronously over the answers.
import * as path from "node:path";
import { API, SymbolFlags, type Checker, type Project, type Symbol as TsSymbol, type Type } from "typescript/unstable/async";
import * as is from "typescript/unstable/ast/is";
import {
  SyntaxKind as K, ModifierFlags, type ClassDeclaration, type ExpressionWithTypeArguments, type Node, type ObjectLiteralExpression, type SourceFile,
  type TypeLiteralNode,
} from "typescript/unstable/ast";
import { cast } from "typescript/unstable/ast/utils";
import { analyseFieldAccess } from "./field-access.ts";
import { markTestOnly, type Layout } from "./layout.ts";
import type { Item, ItemKind, Model, Reference } from "./model.ts";
import {
  DECLARATION_KINDS, PARAMETER_PROPERTY, flagsOf, handleKey, inBatches, isFunctionLike, isStatic, isWriteTarget, keyOf, memberNameOf, nameOf, strip, textOfName,
  unwrapFunction, type MemberName,
} from "./syntax.ts";

// What the declaration and reference phases learned, which the field-access
// phase reads.
export interface Declarations {
  project: Project;
  checker: Checker;
  sources: SourceFile[];
  items: Item[];
  // The declarations of each item: one, or several for merged declarations.
  bodies: Map<number, Node[]>;
  itemOfKey: Map<string, number>;
  ctorsOfClass: Map<string, number[]>;
  symbolAt: Map<Node, TsSymbol | undefined>;
  target: (symbol: TsSymbol | undefined) => TsSymbol | undefined;
  declItems: (symbol: TsSymbol | undefined, write: boolean) => number[];
  references: Reference[];
  // The node of each reference, by reference index.
  accesses: Node[];
}

// Builds the model of the layout's files that `tsconfig` covers. Marks the
// layout's test-only files first (layout.ts markTestOnly). Starts one
// compiler process and closes it before it returns or throws.
export async function buildModel(root: string, laid: Layout, tsconfig: string): Promise<Model> {
  markTestOnly(root, laid);
  const api = new API({ cwd: root });
  try {
    const config = path.resolve(tsconfig);
    const snapshot = await api.updateSnapshot({ openProject: config });
    const project = snapshot.getProject(config);
    if (!project) throw new Error(`TypeScript opened no project for ${config}`);
    const decls = await declare(project, laid);
    const wrappers = await analyseFieldAccess(decls);
    return { tree: laid.tree, files: laid.files, items: decls.items, references: decls.references, wrappers };
  } finally {
    await api.close();
  }
}

async function declare(project: Project, laid: Layout): Promise<Declarations> {
  const { files, fileIndex } = laid;
  const checker = project.checker;
  const programFiles = await project.program.getSourceFileNames();

  // Phase 1: the source files of the model, in model order.
  const wanted = programFiles
    .map((f) => ({ f, id: fileIndex.get(path.resolve(f)) ?? -1 }))
    .filter((x) => x.id >= 0 && !files[x.id]?.test)
    .sort((a, b) => a.id - b.id);
  const fetched = await inBatches(wanted, 64, (x) => project.program.getSourceFile(x.f));
  const sourceOf = new Map<number, SourceFile>();
  for (const [i, x] of wanted.entries()) {
    const sf = fetched[i];
    if (sf) sourceOf.set(x.id, sf);
  }

  // Phase 2: the symbol at every identifier and at the literal of every
  // `a["b"]`, and the target of every alias.
  const symbolAt = new Map<Node, TsSymbol | undefined>();
  const shorthands: MemberName[] = [];
  const literalNames: MemberName[] = [];
  const patternNames: MemberName[] = [];
  const heritageTypes: ExpressionWithTypeArguments[] = [];
  await inBatches([...sourceOf.values()], 32, async (sf) => {
    const ids: Node[] = [];
    const visit = (n: Node) => {
      if (is.isIdentifier(n) || is.isPrivateIdentifier(n)) {
        ids.push(n);
        const p = n.parent;
        if (is.isShorthandPropertyAssignment(p) && p.name === n) shorthands.push(n);
        else if (is.isPropertyAssignment(p) && p.name === n && is.isObjectLiteralExpression(p.parent)) literalNames.push(n);
        else if (is.isBindingElement(p) && is.isObjectBindingPattern(p.parent) && (p.propertyName ?? p.name) === n) patternNames.push(n);
      } else if (memberNameOf(n.parent) === n) ids.push(n);
      if (is.isHeritageClause(n) && is.isClassDeclaration(n.parent)) for (const t of n.types) heritageTypes.push(t);
      n.forEachChild(visit);
    };
    visit(sf);
    const syms = ids.length ? await checker.getSymbolAtLocation(ids) : [];
    for (const [i, n] of ids.entries()) symbolAt.set(n, syms[i]);
  });
  const aliasOf = new Map<number, TsSymbol | null>();
  const resolveAliases = async (symbols: Iterable<TsSymbol | undefined>) => {
    const aliases = new Map<number, TsSymbol>();
    for (const s of symbols) if (s && s.flags & SymbolFlags.Alias && !aliasOf.has(s.id)) aliases.set(s.id, s);
    await inBatches([...aliases.values()], 64, async (s) => {
      aliasOf.set(s.id, await checker.getAliasedSymbol(s).catch(() => null));
    });
  };
  await resolveAliases(symbolAt.values());
  const target = (s: TsSymbol | undefined): TsSymbol | undefined => (s && s.flags & SymbolFlags.Alias ? (aliasOf.get(s.id) ?? undefined) : s);

  // Phase 3: declarations.
  const items: Item[] = [];
  const itemOfKey = new Map<string, number>();
  const bodies = new Map<number, Node[]>();
  const symbolItem = new Map<number, number>();
  const ctorsOfClass = new Map<string, number[]>();
  const add = (decl: Node, name: string, kind: ItemKind, fileId: number, parent: number | null, extra: Partial<Item> = {}): number => {
    const declName = nameOf(decl);
    const sym = declName ? symbolAt.get(declName) : undefined;
    const sf = decl.getSourceFile();
    // An accessor pair shares one symbol but stays two items, so a write
    // reaches the setter and a read the getter.
    let id = sym && !(kind === "function" && extra.accessorRole) ? symbolItem.get(sym.id) : undefined;
    if (id === undefined) {
      items.push({
        name, owner: files[fileId]!.module, file: fileId, kind, parent, traitImpl: false, takesSelf: false, holdsNothing: false,
        line: sf.getLineAndCharacterOfPosition(decl.getStart(sf)).line + 1, ...extra,
      });
      id = items.length - 1;
      if (sym && !extra.accessorRole) symbolItem.set(sym.id, id);
    }
    itemOfKey.set(keyOf(decl), id);
    const list = bodies.get(id) ?? [];
    list.push(decl);
    bodies.set(id, list);
    return id;
  };
  const inheritedNames = await heritageNames(checker, heritageTypes);
  const addMembers = (members: readonly Node[], owner: string, parent: number, fileId: number) => {
    for (const m of members) {
      const name = textOfName(nameOf(m));
      if (!name) continue;
      if (is.isPropertySignatureDeclaration(m)) add(m, `${owner}::${name}`, "field", fileId, parent);
      else if (is.isMethodSignatureDeclaration(m)) add(m, `${owner}::${name}`, "function", fileId, parent, { takesSelf: true });
    }
  };
  // Fields that a class inherits from a mixin call or a type literal in its
  // extends clause are its own.
  const heritageFields = (cls: ClassDeclaration, owner: string, parent: number, fileId: number) => {
    for (const clause of cls.heritageClauses ?? []) {
      if (clause.token !== K.ExtendsKeyword) continue;
      const visit = (n: Node): void => {
        if (is.isObjectLiteralExpression(n) && n.parent && is.isCallExpression(n.parent)) {
          for (const p of n.properties) {
            if ((is.isPropertyAssignment(p) || is.isShorthandPropertyAssignment(p)) && is.isIdentifier(p.name)) add(p, `${owner}::${p.name.text}`, "field", fileId, parent);
          }
          return;
        }
        if (is.isTypeLiteralNode(n)) {
          addMembers(n.members, owner, parent, fileId);
          return;
        }
        n.forEachChild(visit);
      };
      clause.forEachChild(visit);
    }
  };
  const declareClass = (stmt: ClassDeclaration, fileId: number) => {
    const cname = stmt.name?.text ?? "default";
    const cls = add(stmt, cname, "type", fileId, null);
    const inherited = inheritedNames.get(stmt) ?? new Set<string>();
    heritageFields(stmt, cname, cls, fileId);
    for (const m of stmt.members) {
      const name = textOfName(nameOf(m));
      const takesSelf = !isStatic(m);
      const traitImpl = Boolean(flagsOf(m) & ModifierFlags.Override) || (name !== null && inherited.has(name));
      if (is.isConstructorDeclaration(m)) {
        const ctor = add(m, `${cname}::constructor`, "function", fileId, cls);
        const k = keyOf(stmt);
        ctorsOfClass.set(k, [...(ctorsOfClass.get(k) ?? []), ctor]);
        for (const p of m.parameters) if (flagsOf(p) & PARAMETER_PROPERTY && is.isIdentifier(p.name)) add(p, `${cname}::${p.name.text}`, "field", fileId, cls);
      } else if (!name) continue;
      else if (is.isMethodDeclaration(m)) add(m, `${cname}::${name}`, "function", fileId, cls, { takesSelf, traitImpl });
      else if (is.isGetAccessorDeclaration(m)) add(m, `${cname}::${name}`, "function", fileId, cls, { takesSelf, traitImpl, accessorRole: "get" });
      else if (is.isSetAccessorDeclaration(m)) add(m, `${cname}::${name}=`, "function", fileId, cls, { takesSelf, traitImpl, accessorRole: "set" });
      else if (is.isPropertyDeclaration(m)) {
        if (isFunctionLike(m.initializer)) add(m, `${cname}::${name}`, "function", fileId, cls, { takesSelf, traitImpl });
        else if (!takesSelf) add(m, `${cname}::${name}`, "constant", fileId, cls);
        else add(m, `${cname}::${name}`, "field", fileId, cls, { holdsNothing: Boolean(flagsOf(m) & ModifierFlags.Ambient) });
      }
    }
  };
  // The members of the object that a top-level function returns belong to
  // one type item below the function, `ReturnType<typeof f>`. So a read of
  // such a value links to `f`, and field-leak judges the returned object as
  // it judges a class: a method that uses `this` works on it.
  const returnedFields = (fn: Node | undefined, owner: string, factory: number, fileId: number) => {
    const { literals, types } = returnedObjects(fn);
    const first = literals[0] ?? types[0];
    if (!first) return;
    const returned = add(first, `ReturnType<typeof ${owner}>`, "type", fileId, factory);
    for (const t of types) addMembers(t.members, owner, returned, fileId);
    for (const literal of literals) {
      for (const p of literal.properties) {
        const name = textOfName(nameOf(p));
        if (!name) continue;
        const member = `${owner}::${name}`;
        if (is.isMethodDeclaration(p)) add(p, member, "function", fileId, returned, { takesSelf: usesThis(p) });
        else if (is.isGetAccessorDeclaration(p)) add(p, member, "function", fileId, returned, { takesSelf: usesThis(p), accessorRole: "get" });
        else if (is.isSetAccessorDeclaration(p)) add(p, `${member}=`, "function", fileId, returned, { takesSelf: usesThis(p), accessorRole: "set" });
        else if (is.isPropertyAssignment(p) && isFunctionLike(p.initializer)) {
          // An arrow's `this` is the factory's, not the returned object's.
          const value = unwrapFunction(p.initializer);
          add(p, member, "function", fileId, returned, { takesSelf: is.isFunctionExpression(value) && usesThis(value) });
        } else if (is.isPropertyAssignment(p) || is.isShorthandPropertyAssignment(p)) add(p, member, "field", fileId, returned);
      }
    }
  };
  const declareTop = (stmt: Node, fileId: number) => {
    if (is.isFunctionDeclaration(stmt)) {
      const name = stmt.name?.text ?? "default";
      returnedFields(stmt, name, add(stmt, name, "function", fileId, null), fileId);
    } else if (is.isClassDeclaration(stmt)) declareClass(stmt, fileId);
    else if (is.isInterfaceDeclaration(stmt)) addMembers(stmt.members, stmt.name.text, add(stmt, stmt.name.text, "type", fileId, null), fileId);
    else if (is.isTypeAliasDeclaration(stmt)) {
      const id = add(stmt, stmt.name.text, "type", fileId, null);
      for (const l of typeLiteralsOf(stmt.type)) addMembers(l.members, stmt.name.text, id, fileId);
    } else if (is.isEnumDeclaration(stmt)) {
      const id = add(stmt, stmt.name.text, "type", fileId, null);
      for (const m of stmt.members) if (is.isIdentifier(m.name) || is.isStringLiteral(m.name)) add(m, `${stmt.name.text}::${m.name.text}`, "variant", fileId, id);
    } else if (is.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (is.isIdentifier(d.name)) {
          const fn = isFunctionLike(d.initializer);
          const id = add(d, d.name.text, fn ? "function" : "constant", fileId, null);
          if (fn && d.initializer) returnedFields(unwrapFunction(d.initializer), d.name.text, id, fileId);
          continue;
        }
        const visit = (n: Node) => {
          if (is.isBindingElement(n) && n.name && is.isIdentifier(n.name)) add(n, n.name.text, "constant", fileId, null);
          n.forEachChild(visit);
        };
        visit(d.name);
      }
    } else if (is.isModuleDeclaration(stmt) && stmt.body && is.isModuleBlock(stmt.body)) {
      for (const s of stmt.body.statements) declareTop(s, fileId);
    }
  };
  for (const [fileId, sf] of sourceOf) for (const stmt of sf.statements) declareTop(stmt, fileId);
  for (const [id, decls] of bodies) {
    const it = items[id]!;
    const [d] = decls;
    if (d && it.kind === "function" && (is.isFunctionDeclaration(d) || is.isVariableDeclaration(d) || is.isConstructorDeclaration(d))) it.takesSelf = false;
  }

  // Phase 4: the context questions: shorthand values, contextual properties
  // of object literals, properties of destructured types. Only names that
  // some workspace member has can resolve to a workspace item.
  const memberNames = new Set(items.map((it) => it.name.split("::").pop()));
  const shorthandSym = new Map<Node, TsSymbol | undefined>();
  await inBatches(shorthands, 64, async (n) => {
    shorthandSym.set(n, await checker.getShorthandAssignmentValueSymbol(n.parent).catch(() => undefined));
  });
  const contextualProp = await propertiesByName(
    checker,
    [...literalNames, ...shorthands].filter((n) => memberNames.has(n.text) && is.isObjectLiteralExpression(n.parent.parent)),
    (literal) => checker.getContextualType(cast(literal, is.isObjectLiteralExpression)),
  );
  const patternProp = await propertiesByName(
    checker,
    patternNames.filter((n) => memberNames.has(n.text)),
    (pattern) => checker.getTypeAtLocation(pattern),
  );
  // Properties of a module namespace (`const { f } = await import(..)`) are aliases too.
  await resolveAliases([shorthandSym, contextualProp, patternProp].flatMap((m) => [...m.values()]));

  const declItems = (symbol: TsSymbol | undefined, write: boolean): number[] => {
    const sym = target(symbol);
    if (!sym) return [];
    const out = new Set<number>();
    const getters: number[] = [];
    const setters: number[] = [];
    for (const d of sym.declarations ?? []) {
      const id = itemOfKey.get(handleKey(d));
      if (id === undefined) continue;
      const role = items[id]!.accessorRole;
      if (role === "get") getters.push(id);
      else if (role === "set") setters.push(id);
      else out.add(id);
    }
    const preferred = write ? setters : getters;
    for (const c of preferred.length ? preferred : write ? getters : setters) out.add(c);
    // A property that types of several modules share through a union, such
    // as the `kind` of a union of payloads from many modules, belongs to the
    // union: the use depends on the union, not on each member's module.
    // Declarations in one module, such as the variants of one alias, the
    // types of one module's union, or an intersection's parts, still link.
    const owners = new Set([...out].map((id) => items[id]!.owner));
    return owners.size > 1 ? [] : [...out];
  };

  // Phase 5: references. A reference inside a type node is type-only, except
  // the class that a class extends, which is a value.
  const isTypePosition = (n: Node) =>
    is.isTypeNode(n) &&
    !(is.isExpressionWithTypeArguments(n) && is.isHeritageClause(n.parent) && n.parent.token === K.ExtendsKeyword &&
      (is.isClassDeclaration(n.parent.parent) || is.isClassExpression(n.parent.parent)));
  const isDeclName = (n: Node) => {
    const p = n.parent;
    return nameOf(p) === n && DECLARATION_KINDS.has(p.kind);
  };
  const references: Reference[] = [];
  const accesses: Node[] = [];
  for (const [fileId, sf] of sourceOf) {
    const from = files[fileId]!.module;
    const holders: number[] = [];
    let typeDepth = 0;
    const refer = (node: Node, referred: number[]) => {
      for (const item of referred) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        references.push({ file: fileId, line, from, holder: holders.at(-1) ?? null, item, copies: false, test: false, typeOnly: typeDepth > 0 });
        accesses.push(node);
      }
    };
    const visit = (node: Node) => {
      if (is.isImportDeclaration(node) || is.isImportEqualsDeclaration(node) || is.isExportDeclaration(node)) return;
      // `export default <expression>` runs its expression; only the export itself is no reference.
      if (is.isExportAssignment(node)) {
        visit(node.expression);
        return;
      }
      const own = itemOfKey.get(keyOf(node));
      if (own !== undefined) holders.push(own);
      if (is.isIdentifier(node) || is.isPrivateIdentifier(node)) {
        const p = node.parent;
        if (is.isShorthandPropertyAssignment(p) && p.name === node) {
          refer(node, declItems(shorthandSym.get(node), false));
          refer(node, declItems(contextualProp.get(node), false));
        } else if (is.isPropertyAssignment(p) && p.name === node && is.isObjectLiteralExpression(p.parent)) {
          refer(node, declItems(contextualProp.get(node), false));
        } else if (is.isBindingElement(p) && is.isObjectBindingPattern(p.parent) && (p.propertyName ?? p.name) === node) {
          refer(node, declItems(patternProp.get(node), false));
        } else if (!isDeclName(node)) {
          const sym = symbolAt.get(node);
          refer(node, declItems(sym, memberNameOf(p) === node && isWriteTarget(p)));
          if (is.isNewExpression(p) && p.expression === node && sym) {
            for (const d of target(sym)?.declarations ?? []) refer(node, ctorsOfClass.get(handleKey(d)) ?? []);
          }
        }
      } else if (memberNameOf(node.parent) === node) {
        // `a["b"]` reads or writes the property `b` like `a.b`.
        refer(node, declItems(symbolAt.get(node), isWriteTarget(node.parent)));
      }
      const inType = isTypePosition(node);
      if (inType) typeDepth++;
      node.forEachChild(visit);
      if (inType) typeDepth--;
      if (own !== undefined) holders.pop();
    };
    visit(sf);
  }
  return {
    project, checker, sources: [...sourceOf.values()], items, bodies, itemOfKey, ctorsOfClass, symbolAt, target, declItems, references, accesses,
  };
}

// The type literals whose members are the fields of a type alias: the alias
// itself, or each literal in its unions and intersections, however nested.
function typeLiteralsOf(type: Node): TypeLiteralNode[] {
  if (is.isTypeLiteralNode(type)) return [type];
  if (is.isParenthesizedTypeNode(type)) return typeLiteralsOf(type.type);
  if (is.isUnionTypeNode(type) || is.isIntersectionTypeNode(type)) return type.types.flatMap(typeLiteralsOf);
  return [];
}

// The objects that a function returns: the object literal of its arrow body,
// or of each `return` in its body outside nested functions and classes, and
// the type literals that a type assertion around one states, because a read
// through `{ ... } as { ... }` resolves to the asserted type's members.
function returnedObjects(fn: Node | undefined) {
  const literals: ObjectLiteralExpression[] = [];
  const types: TypeLiteralNode[] = [];
  if (!fn || !is.isFunctionLikeDeclaration(fn) || !fn.body) return { literals, types };
  const take = (e: Node | undefined) => {
    let at = e;
    // `strip` removes one wrapper or more; each wrapper holds `expression`.
    while (at && strip(at) !== at) {
      if (is.isAsExpression(at) || is.isTypeAssertion(at)) types.push(...typeLiteralsOf(at.type));
      at = cast(at, (n): n is Node & { readonly expression: Node } => "expression" in n).expression;
    }
    if (at && is.isObjectLiteralExpression(at)) literals.push(at);
  };
  if (!is.isBlock(fn.body)) take(fn.body);
  else {
    const visit = (n: Node) => {
      if (is.isReturnStatement(n)) take(n.expression);
      else if (!is.isFunctionLikeDeclaration(n) && !is.isClassLikeDeclaration(n)) n.forEachChild(visit);
    };
    fn.body.forEachChild(visit);
  }
  return { literals, types };
}

// Whether a function's own `this` occurs in it, outside nested functions and
// classes that bind their own; an arrow sees the enclosing `this`.
function usesThis(fn: Node): boolean {
  let found = false;
  const visit = (n: Node) => {
    if (found) return;
    if (n.kind === K.ThisKeyword) found = true;
    else if (!(is.isFunctionLikeDeclaration(n) && !is.isArrowFunction(n)) && !is.isClassLikeDeclaration(n)) n.forEachChild(visit);
  };
  fn.forEachChild(visit);
  return found;
}

// The property names of each class's extends clauses, so a member that
// overrides an inherited one counts as an implementation.
async function heritageNames(checker: Checker, heritageTypes: ExpressionWithTypeArguments[]): Promise<Map<Node, Set<string>>> {
  const out = new Map<Node, Set<string>>();
  const types = heritageTypes.length ? await checker.getTypeAtLocation(heritageTypes) : [];
  const props = await inBatches(types, 64, async (t) => (t ? await checker.getPropertiesOfType(t).catch(() => []) : []));
  for (const [i, t] of heritageTypes.entries()) {
    const cls = t.parent.parent;
    const names = out.get(cls) ?? new Set<string>();
    for (const p of props[i] ?? []) names.add(p.name);
    out.set(cls, names);
  }
  return out;
}

// The property of the named type of each name's owner (its literal or its
// binding pattern), asking for each owner's type and each property of a type
// once: the checker process caches no answers.
async function propertiesByName(
  checker: Checker,
  names: MemberName[],
  typeOf: (owner: Node) => Promise<Type | undefined>,
): Promise<Map<Node, TsSymbol | undefined>> {
  const out = new Map<Node, TsSymbol | undefined>();
  const ownerType = new Map<Node, Promise<Type | undefined>>();
  const property = new Map<string, Promise<TsSymbol | undefined>>();
  await inBatches(names, 64, async (n) => {
    const owner = n.parent.parent;
    let pending = ownerType.get(owner);
    if (!pending) {
      pending = typeOf(owner).catch(() => undefined);
      ownerType.set(owner, pending);
    }
    const t = await pending;
    if (!t) return;
    const key = `${t.id}\0${n.text}`;
    let found = property.get(key);
    if (!found) {
      found = checker.getPropertyOfType(t, n.text).catch(() => undefined);
      property.set(key, found);
    }
    out.set(n, await found);
  });
  return out;
}
