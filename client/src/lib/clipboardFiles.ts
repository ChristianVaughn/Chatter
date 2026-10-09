/**
 * The files on a paste — a screenshot, an image copied from a browser, files
 * copied in a file manager. Empty for an ordinary text paste, which the caller
 * should then leave alone.
 *
 * Read from `items` rather than `files`: some browsers put a copied image only
 * in the item list, and `getAsFile` is the one way to reach it.
 */
export function clipboardFiles(e: React.ClipboardEvent): File[] {
  const files: File[] = [];
  for (const item of Array.from(e.clipboardData?.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}
