const CURRENCY_KEY = 'myworkspace.frontdesk.currency';

export function getCurrencySymbol(): string {
  return localStorage.getItem(CURRENCY_KEY) ?? '';
}

export function saveCurrencySymbol(value: string): void {
  localStorage.setItem(CURRENCY_KEY, value.trim().slice(0, 4));
}
