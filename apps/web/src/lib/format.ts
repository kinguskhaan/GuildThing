// Realm is optional for manually-created characters (addon imports always
// have one) — skip the dash entirely rather than showing a trailing "-".
export function characterLabel(name: string, realm: string): string {
  return realm ? `${name}-${realm}` : name;
}
