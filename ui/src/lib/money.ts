const DOLLARS = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

/** A dollar amount to the cent with thousands separators; a cost under half a cent reads <$0.01. */
export function usd(amount: number): string {
  if (!Number.isFinite(amount)) {
    return '-'
  }
  return amount > 0 && amount < 0.005 ? '<$0.01' : DOLLARS.format(amount)
}
