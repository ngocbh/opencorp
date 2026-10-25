/** The tools for drafting a new company. */
import { expect, test } from "bun:test"
import { checkCompany, checkCompanyTool } from "../../../src/tools/company/draft.ts"

const OWNER = { name: "Hong Ngoc Bui", handle: "ngocbh", title: "CEO" }

const DESCRIPTION =
  'Check a company before you return it: its name, the owner, and the first teammates.\n\nReturns "No problems." or ' +
  "the problems to fix with the owner."

// Python's schema for `check_company`, saved as its test read it, so the model sees the same schema.
const PYTHON_SCHEMA = {
  $defs: {
    CheckOwner: {
      description: "The owner, as ``check_company`` takes it; a missing field is checked as empty.",
      properties: {
        name: { title: "Name", type: "string" },
        handle: { title: "Handle", type: "string" },
        title: { title: "Title", type: "string" },
      },
      title: "CheckOwner",
      type: "object",
    },
    CheckTeammate: {
      description: "A teammate, as ``check_company`` takes it; a missing field is checked as empty.",
      properties: {
        name: { title: "Name", type: "string" },
        handle: { title: "Handle", type: "string" },
        title: { title: "Title", type: "string" },
      },
      title: "CheckTeammate",
      type: "object",
    },
  },
  description: DESCRIPTION,
  properties: {
    company: { default: "", title: "Company", type: "string" },
    owner: { anyOf: [{ $ref: "#/$defs/CheckOwner" }, { type: "null" }], default: null },
    teammates: {
      anyOf: [{ items: { $ref: "#/$defs/CheckTeammate" }, type: "array" }, { type: "null" }],
      default: null,
      title: "Teammates",
    },
  },
  title: "check_company",
  type: "object",
}

test("check company says no problems for a good company", () => {
  const teammates = [{ name: "Minh", handle: "minh", title: "Engineer" }]
  expect(checkCompany({ company: "Acme", owner: OWNER, teammates })).toBe("No problems.")
})

test("check company lists each problem and says to ask the owner", () => {
  const teammates = [
    { name: "Ngoc", handle: "ngocbh", title: "Engineer" },
    { name: "Minh", handle: "Minh", title: "QA" },
  ]
  const lines = checkCompany({ company: "Acme", owner: OWNER, teammates }).split("\n")
  expect(lines[0]).toBe("Problems; ask the owner how to fix each, then check again:")
  expect(lines).toContain("- @ngocbh is taken")
  expect(lines.some((line) => line.startsWith("- @Minh can't be a handle"))).toBe(true)
})

test("check company takes a partial draft and names what is missing", () => {
  const result = checkCompany({
    company: "Acme",
    owner: { name: "Hong Ngoc Bui", handle: "ngocbh" },
    teammates: [{ name: "Minh", handle: "minh" }],
  })
  expect(result.split("\n")).toContain("- the teammate @minh needs a title")
  expect(checkCompany().startsWith("Problems; ask the owner")).toBe(true)
})

test("check companys schema types every field the check reads", () => {
  // Typed as the saved copy so its keys read; the last check compares the two whole.
  const schema = checkCompanyTool.parametersJsonSchema as unknown as typeof PYTHON_SCHEMA
  expect(new Set(Object.keys(schema.properties))).toEqual(new Set(["company", "owner", "teammates"]))
  expect(new Set(Object.keys(schema.$defs.CheckOwner.properties))).toEqual(new Set(["name", "handle", "title"]))
  expect(new Set(Object.keys(schema.$defs.CheckTeammate.properties))).toEqual(new Set(["name", "handle", "title"]))
  expect(schema).toEqual(PYTHON_SCHEMA)
  expect(checkCompanyTool.description).toBe(DESCRIPTION)
})
