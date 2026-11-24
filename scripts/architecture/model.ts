// The plain model that the architecture rules read: the hierarchy of source
// roots and modules, the files, the items that the files declare, every
// reference from code to an item, and the wrappers. Only the builder
// (build-model.ts) asks the TypeScript compiler; the rules are pure functions
// of this model, so tests build one by hand.

export type NodeKind = "workspace" | "package" | "module";
export type ItemKind = "module" | "type" | "function" | "field" | "variant" | "constant" | "other";

export interface TreeNode {
  name: string;
  kind: NodeKind;
  parent: number | null;
  depth: number;
  test: boolean;
  dir: string | null;
}

// The module hierarchy. Node 0 is the workspace; each source root is a
// package below it, and each directory and file is a module below that.
export class Tree {
  nodes: TreeNode[] = [{ name: "", kind: "workspace", parent: null, depth: 0, test: false, dir: "" }];
  private kids = new Map<string, number>();

  root(): number {
    return 0;
  }

  child(parent: number, kind: NodeKind, name: string): number {
    const key = `${parent}\0${kind}\0${name}`;
    const known = this.kids.get(key);
    if (known !== undefined) return known;
    this.nodes.push({ name, kind, parent, depth: this.node(parent).depth + 1, test: false, dir: null });
    const id = this.nodes.length - 1;
    this.kids.set(key, id);
    return id;
  }

  node(id: number): TreeNode {
    return this.nodes[id]!;
  }

  parent(id: number): number | null {
    return this.node(id).parent;
  }

  *ancestors(id: number): Generator<number> {
    for (let at: number | null = id; at !== null; at = this.parent(at)) yield at;
  }

  commonAncestor(a: number, b: number): number {
    let left = a;
    let right = b;
    while (this.node(left).depth > this.node(right).depth) left = this.parent(left)!;
    while (this.node(right).depth > this.node(left).depth) right = this.parent(right)!;
    while (left !== right) {
      left = this.parent(left)!;
      right = this.parent(right)!;
    }
    return left;
  }

  isWithin(id: number, ancestor: number): boolean {
    for (const at of this.ancestors(id)) if (at === ancestor) return true;
    return false;
  }

  packageOf(id: number): number | null {
    for (const at of this.ancestors(id)) if (this.node(at).kind === "package") return at;
    return null;
  }

  isTest(id: number): boolean {
    for (const at of this.ancestors(id)) if (this.node(at).test) return true;
    return false;
  }

  // The display name of a module: its package name, then each module name
  // below it, joined by `::`.
  display(id: number): string {
    const n = this.node(id);
    if (n.kind === "package") return n.name;
    if (n.kind === "module") return `${this.display(n.parent!)}::${n.name}`;
    return ".";
  }

  ids(): number[] {
    return this.nodes.map((_, i) => i);
  }
}

export interface SourceFile {
  path: string;
  module: number;
  test: boolean;
  lines: number;
  index: boolean;
}

export interface Item {
  name: string;
  owner: number;
  file: number | null;
  kind: ItemKind;
  parent: number | null;
  traitImpl: boolean;
  takesSelf: boolean;
  holdsNothing: boolean;
  line: number;
  accessorRole?: "get" | "set";
}

// One use of an item in code. `holder` is the innermost item whose body holds
// the use; `copies` is true when the use only reads the item (field-leak);
// `typeOnly` is true inside a type node, where the use has no run-time effect.
export interface Reference {
  file: number;
  line: number;
  from: number;
  holder: number | null;
  item: number;
  copies: boolean;
  test: boolean;
  typeOnly?: boolean;
}

// A function whose whole body forwards to another function, or hands out or
// stores fields of its owner. The rules see through it to what it wraps.
export type Wrapper =
  | { kind: "forwarder"; target: number; fields: number[] }
  | { kind: "accessor"; lent: number[]; copied: number[]; toRead: boolean };

export interface Model {
  tree: Tree;
  files: SourceFile[];
  items: Item[];
  references: Reference[];
  wrappers: Map<number, Wrapper>;
}

// A directory that the check judges, relative to the repository root, and
// the package name that its findings use.
export interface SourceRoot {
  name: string;
  dir: string;
}
