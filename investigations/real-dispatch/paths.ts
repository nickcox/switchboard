/** Whether a path relative to a runtime root names a file directly inside an `artefacts` directory, on any platform. */
export function isArtefactPath(path: string): boolean {
  const parts = path.split(/[\\/]/);
  return parts.length >= 2 && parts.at(-2) === "artefacts" && parts.at(-1) !== "";
}
