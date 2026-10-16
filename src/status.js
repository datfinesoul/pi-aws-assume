// Local wall-clock time with a compact UTC offset (including fractional-hour zones).
export function formatLocalExpiration(value) {
  const date = new Date(value);
  const pad = (number) => String(number).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const hours = Math.floor(Math.abs(offset) / 60);
  const minutes = Math.abs(offset) % 60;
  const zone = `${offset < 0 ? "-" : "+"}${hours}${minutes ? `:${pad(minutes)}` : ""}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}${zone}`;
}
