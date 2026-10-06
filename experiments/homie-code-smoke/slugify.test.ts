import { describe, expect, test } from "bun:test";
import { slugify } from "./slugify";

const cases: [string, string][] = [
  ["Hello Cheshi!", "hello-cheshi"],
  ["  HELLO Cheshi  ", "hello-cheshi"],
  ["", ""],
  [" \t\n ", ""],
  ["!@#$%^&*()---", ""],
  ["hello   --  cheshi", "hello-cheshi"],
  ["---hello-cheshi---", "hello-cheshi"],
  ["Version 123 Build 007", "version-123-build-007"],
  ["0123456789", "0123456789"],
  ["hello_world...cheshi/foo", "hello-world-cheshi-foo"],
  ["hello\t\ncheshi", "hello-cheshi"],
  ["Hello 한글 😀 Cheshi", "hello-cheshi"],
  ["한글 😀 é", ""],
  ["already-slugified-123", "already-slugified-123"],
];

describe("slugify", () => {
  test.each(cases)("normalizes %j to %j", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  test.each(cases)("is idempotent for %j", (input) => {
    const result = slugify(input);
    expect(slugify(result)).toBe(result);
  });
});
