export const TONE = { positive: '#34d399', negative: '#fb7185', neutral: '#cbd5e1' };
export const CONFIRM_MS = 3000;
export const secondsLeft = (n) => Math.max(0, (n.expiresAt - Date.now()) / 1000);
