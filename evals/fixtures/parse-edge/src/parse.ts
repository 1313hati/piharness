/** Parse a comma-separated list. */
export function parseList(input: string): string[] {
  return input.split(",").map((item) => item.trim());
}
