/**
 * Clipboard handling for secrets.
 *
 * A secret sitting in the clipboard forever is a leak, so we clear it after a
 * short window — but only when the clipboard still holds *our* value. If the
 * browser denies read permission we leave it alone rather than destroying
 * something the user copied in the meantime.
 */
const CLEAR_AFTER_MS = 45_000;

let pendingClear: ReturnType<typeof setTimeout> | undefined;

export async function copySecret(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);

  clearTimeout(pendingClear);
  pendingClear = setTimeout(async () => {
    try {
      if ((await navigator.clipboard.readText()) === value) {
        await navigator.clipboard.writeText("");
      }
    } catch {
      // No read permission (or the tab lost focus) — leave the clipboard as it is.
    }
  }, CLEAR_AFTER_MS);
}

export const CLIPBOARD_CLEAR_SECONDS = CLEAR_AFTER_MS / 1000;

export async function copyPlain(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}
