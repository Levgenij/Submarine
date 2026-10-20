// A server row's `tunnels` and `mirrors` are JSON text holding a list of objects.
// A row already stored can still hold anything there, and one entry that isn't
// an object (`[null]`) took the whole window to the error screen as soon as the
// row was opened for editing. What isn't a list of objects is read as the
// entries that are, or as none. An object is kept as it was saved, name and
// stopped included.
export function parseObjectList(text: unknown): any[] {
  if (typeof text !== "string" || !text) return [];
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value.filter((e) => e !== null && typeof e === "object" && !Array.isArray(e)) : [];
  } catch {
    return [];
  }
}
