export class DuplicateJsonMemberError extends SyntaxError {
  constructor(member: string) {
    super(`Duplicate JSON member: ${member}`);
    this.name = "DuplicateJsonMemberError";
  }
}

/** Strict JSON parsing with duplicate object-member rejection. */
export function parseJsonNoDuplicates(text: string): unknown {
  let index = 0;

  const fail = (): never => {
    throw new SyntaxError("Invalid JSON");
  };
  const whitespace = (): void => {
    while (index < text.length && /[\t\n\r ]/.test(text[index])) index += 1;
  };
  const string = (): string => {
    if (text[index] !== '"') fail();
    const start = index;
    index += 1;
    let escaped = false;
    while (index < text.length) {
      const character = text[index++];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') {
        return JSON.parse(text.slice(start, index)) as string;
      }
      if (character.charCodeAt(0) < 0x20) fail();
    }
    return fail();
  };
  const value = (): void => {
    whitespace();
    const character = text[index];
    if (character === "{") {
      object();
      return;
    }
    if (character === "[") {
      array();
      return;
    }
    if (character === '"') {
      string();
      return;
    }
    const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(index));
    if (!match) throw new SyntaxError("Invalid JSON");
    index += match[0].length;
  };
  const array = (): void => {
    index += 1;
    whitespace();
    if (text[index] === "]") {
      index += 1;
      return;
    }
    while (true) {
      value();
      whitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      if (text[index] !== ",") fail();
      index += 1;
    }
  };
  const object = (): void => {
    index += 1;
    whitespace();
    if (text[index] === "}") {
      index += 1;
      return;
    }
    const members = new Set<string>();
    while (true) {
      whitespace();
      const member = string();
      if (members.has(member)) throw new DuplicateJsonMemberError(member);
      members.add(member);
      whitespace();
      if (text[index] !== ":") fail();
      index += 1;
      value();
      whitespace();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      if (text[index] !== ",") fail();
      index += 1;
    }
  };

  value();
  whitespace();
  if (index !== text.length) fail();
  return JSON.parse(text) as unknown;
}
