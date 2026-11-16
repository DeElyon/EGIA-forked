export function getPaymentMethodLabel(method: string | null | undefined) {
  if (!method || /paystack|korapay/i.test(method)) return 'Online Payment'
  return method
}
