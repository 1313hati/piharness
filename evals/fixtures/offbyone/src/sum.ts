// Returns the sum of the first n positive integers.
// sum(3) should be 1+2+3 = 6
export function sum(n: number): number {
  let total = 0;
  for (let i = 1; i < n; i++) {
    total += i;
  }
  return total;
}
