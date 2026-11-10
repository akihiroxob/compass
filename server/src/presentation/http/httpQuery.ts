export const queryNumber = (value: string | undefined) =>
  value === undefined ? undefined : value.trim() === "" ? Number.NaN : Number(value);
