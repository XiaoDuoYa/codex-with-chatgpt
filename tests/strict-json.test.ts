import { describe, expect, it } from "vitest";
import { DuplicateJsonMemberError, parseJsonNoDuplicates } from "../src/plans/json.js";


describe("parseJsonNoDuplicates", () => {
  it("parses nested valid JSON without treating string contents as structure", () => {
    expect(parseJsonNoDuplicates('{"a":{"b":1},"text":"{\\\"b\\\":2}","items":[true,null]}')).toEqual({
      a: { b: 1 },
      text: '{"b":2}',
      items: [true, null],
    });
  });

  it("rejects duplicate members at any depth, including escaped equivalents", () => {
    expect(() => parseJsonNoDuplicates('{"a":1,"a":2}')).toThrow(DuplicateJsonMemberError);
    expect(() => parseJsonNoDuplicates('{"outer":{"a":1,"\\u0061":2}}')).toThrow(DuplicateJsonMemberError);
  });

  it("rejects trailing data and malformed numbers", () => {
    expect(() => parseJsonNoDuplicates('{"a":1} trailing')).toThrow(SyntaxError);
    expect(() => parseJsonNoDuplicates('{"a":01}')).toThrow(SyntaxError);
  });
});
