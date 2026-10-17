import assert from "node:assert/strict";
import { parseList } from "../src/parse.ts";

assert.deepEqual(parseList("a,b,c"), ["a", "b", "c"]);
assert.deepEqual(parseList(" a , b "), ["a", "b"]);
// Empty segments are not items.
assert.deepEqual(parseList("a,,b"), ["a", "b"]);
// Empty input has no items.
assert.deepEqual(parseList(""), []);
assert.deepEqual(parseList("   "), []);
console.log("parse tests passed");
