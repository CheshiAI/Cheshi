// Verification fixture: failure rate means failed requests divided by all requests.
// For no requests the product requires a rate of zero.
export function failureRate(failed: number, total: number): number {
  return failed / (total - failed);
}
