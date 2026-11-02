import { expect, test } from "bun:test"
import * as SchemaAST from "effect/SchemaAST"
import { RUNTIME_READ_DOMAINS, runtimeQueryResultSchema } from "../../../src/protocol/runtime-protocol-schemas.js"
import { recursiveUnionMembers } from "../../../src/protocol/schema-union.js"
import type { RuntimeQuery } from "../../../src/protocol/app-service-types.js"

const isQueryType = (type: string): type is RuntimeQuery["type"] => Object.hasOwn(RUNTIME_READ_DOMAINS, type)

/** True when any arm of the result, a union arm included, states a read position. */
function carriesPosition(type: RuntimeQuery["type"]): boolean {
  return recursiveUnionMembers(runtimeQueryResultSchema(type)).some(({ ast }) =>
    SchemaAST.isObjects(ast) && ast.propertySignatures.some((property) => property.name === "snapshotPosition"))
}

/** A read whose answer carries a position seeds at least one cursor, so the
 *  public bus must void that cursor's baseline when it answers the read. */
test("every query whose result carries a snapshot position names the domains it seeds", () => {
  const anchored = Object.keys(RUNTIME_READ_DOMAINS).filter(isQueryType).filter(carriesPosition)
  expect(anchored).toEqual(expect.arrayContaining(["snapshot", "outputWindow", "statusSnapshot", "papercutCountSnapshot", "remoteSnapshot"]))
  expect(anchored.filter((type) => RUNTIME_READ_DOMAINS[type].length === 0)).toEqual([])
})
