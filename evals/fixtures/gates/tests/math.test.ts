import assert from "node:assert/strict";
import { add, clamp } from "../src/index.ts";

assert.equal(add(2, 3), 5);
assert.equal(clamp(11, 0, 10), 10);
assert.equal(clamp(-1, 0, 10), 0);
console.log("math tests passed");
