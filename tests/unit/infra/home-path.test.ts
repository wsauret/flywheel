import { expect, test } from "bun:test"
import { collapseHome } from "../../../src/infra/home-path.js"

test("account-home display preserves paths outside the authoritative directory", () => {
  expect(collapseHome("/accounts/me", "/accounts/me")).toBe("~")
  expect(collapseHome("/accounts/me/work", "/accounts/me")).toBe("~/work")
  expect(collapseHome("/accounts/me-too/work", "/accounts/me")).toBe("/accounts/me-too/work")
  expect(collapseHome("/work", "/accounts/me")).toBe("/work")
})

test("Windows home comparison ignores case and retains Windows separators", () => {
  expect(collapseHome("C:\\Users\\Me\\work", "c:\\users\\me")).toBe("~\\work")
  expect(collapseHome("D:\\work", "C:\\Users\\Me")).toBe("D:\\work")
})
