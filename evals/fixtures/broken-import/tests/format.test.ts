import assert from "node:assert/strict";
import { formatCurrency } from "../src/index.ts";

assert.equal(formatCurrency(0), "$0.00");
assert.equal(formatCurrency(1234.5), "$1,234.50");
assert.equal(formatCurrency(-12), "-$12.00");
console.log("format tests passed");
