import { sum } from "../src/sum.ts";

function check(actual: number, expected: number, label: string): boolean {
  const ok = actual === expected;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: got ${actual}, expected ${expected}`);
  return ok;
}

let allOk = true;
allOk = check(sum(1), 1, "sum(1)") && allOk;
allOk = check(sum(3), 6, "sum(3)") && allOk;
allOk = check(sum(10), 55, "sum(10)") && allOk;

if (!allOk) {
  console.error("TESTS FAILED");
  process.exit(1);
}
console.log("ALL TESTS PASSED");
