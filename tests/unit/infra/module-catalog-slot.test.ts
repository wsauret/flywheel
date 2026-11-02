import { describe, expect, test } from "bun:test";
import { createModuleCatalogSlot } from "../../../src/infra/module-descriptor.js";

describe("module catalog slot", () => {
  test("reads undefined until a catalog is installed, then loads it once", () => {
    const slot = createModuleCatalogSlot<string>();
    let loads = 0;
    const catalog = ["shipped", "development"];
    slot.install(() => { loads += 1; return catalog; });
    expect(slot.installed()).toEqual(["shipped", "development"]);
    expect(slot.installed()).toBe(catalog);
    expect(slot.installed()).toBe(slot.installed());
    expect(Object.isFrozen(slot.installed())).toBe(true);
    expect(loads).toBe(1);
  });

  test("an uninitialized realm has no catalog", () => {
    expect(createModuleCatalogSlot<string>().installed()).toBeUndefined();
  });

  test("refuses a second install", () => {
    const slot = createModuleCatalogSlot<string>();
    slot.install(() => ["a"]);
    expect(() => slot.install(() => ["b"])).toThrow("already installed");
    expect(slot.installed()).toEqual(["a"]);
  });

  test("refuses an install after a composition read the catalog", () => {
    const slot = createModuleCatalogSlot<string>();
    expect(slot.installed()).toBeUndefined();
    expect(() => slot.install(() => ["late"])).toThrow("read before it was installed");
    expect(slot.installed()).toBeUndefined();
  });
});


describe("shipped catalog bootstrap", () => {
  test("publication preserves the canonical tuple and reads it without an override", () => {
    const slot = createModuleCatalogSlot<string>();
    const shipped = ["shipped"];
    slot.publish(shipped);
    expect(slot.installed()).toBe(shipped);
    expect(Object.isFrozen(shipped)).toBe(true);
    expect(() => slot.install(() => ["late"])).toThrow("read before it was installed");
  });

  test("publishing does not evaluate or lock a source override", () => {
    const slot = createModuleCatalogSlot<string>();
    let loads = 0;
    slot.publish(["shipped"]);
    slot.install(() => { loads++; return ["shipped", "development"]; });
    expect(loads).toBe(0);
    expect(slot.installed()).toEqual(["shipped", "development"]);
    expect(slot.installed()).toBe(slot.installed());
    expect(loads).toBe(1);
  });

  test("a lazy source loader may load and publish the registry while resolving", () => {
    const slot = createModuleCatalogSlot<string>();
    const shipped = ["shipped"];
    slot.install(() => { slot.publish(shipped); return [...shipped, "development"]; });
    expect(slot.installed()).toEqual(["shipped", "development"]);
    expect(slot.installed()).toBe(slot.installed());
  });

  test("a second registry publication cannot replace the shipped authority", () => {
    const slot = createModuleCatalogSlot<string>();
    const shipped = ["first"];
    slot.publish(shipped);
    expect(() => slot.publish(["second"])).toThrow("already published");
    expect(slot.installed()).toBe(shipped);
  });

  test("an uninitialized read cannot later acquire a different default", () => {
    const slot = createModuleCatalogSlot<string>();
    expect(slot.installed()).toBeUndefined();
    expect(() => slot.publish(["late"])).toThrow("read before the registry published it");
    expect(slot.installed()).toBeUndefined();
  });
});
