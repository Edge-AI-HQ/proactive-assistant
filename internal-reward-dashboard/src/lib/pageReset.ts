export function shouldWaitForPageReset(filterChanged: boolean, page: number): boolean {
  return filterChanged && page !== 1;
}
