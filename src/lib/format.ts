export const money = (v: number | string) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(v));

export const shortDate = (v: string) =>
  new Date(v).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
