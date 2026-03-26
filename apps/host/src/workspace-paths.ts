import { isAbsolute, relative, resolve, sep } from 'node:path';

export function normalizeWorkspaceFilePath(workspacePath: string, filePath: string) {
  const trimmedWorkspacePath = workspacePath.trim();
  const trimmedFilePath = filePath.trim();
  if (!trimmedWorkspacePath || !trimmedFilePath) {
    return trimmedFilePath.replace(/\\/g, '/');
  }

  const normalizedWorkspacePath = resolve(trimmedWorkspacePath);
  const normalizedTargetPath = isAbsolute(trimmedFilePath)
    ? resolve(trimmedFilePath)
    : resolve(normalizedWorkspacePath, trimmedFilePath);
  const relativePath = relative(normalizedWorkspacePath, normalizedTargetPath);
  if (!relativePath) {
    return '';
  }
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return trimmedFilePath.replace(/\\/g, '/');
  }
  return relativePath.split(sep).join('/');
}
