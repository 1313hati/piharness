/** Formatting helpers for money. */

/** Format a number as US dollars, e.g. 1234.5 -> "$1,234.50". */
export function formatMoney(amount: number): string {
  return `$${amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}
