// Shared input validators used at the API boundary.

// Session ids are client-generated (crypto.randomUUID() on the client). We don't
// hard-require the exact UUID shape so older/longer ids keep working — just
// enforce a string of a sane length and a conservative charset (the chars
// crypto.randomUUID() can emit: hex + hyphen, plus a couple extra safe ones).
const ID_CHARSET = /^[A-Za-z0-9_-]+$/;

export function isValidId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length >= 8 &&
    id.length <= 64 &&
    ID_CHARSET.test(id)
  );
}
