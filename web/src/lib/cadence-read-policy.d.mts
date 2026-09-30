export function readCadenceWithPolicy<T>(options: {
  databaseConfigured: boolean;
  cloudRuntime: boolean;
  readNeon: () => T | Promise<T>;
  readLocal: () => T | Promise<T>;
  cloudDisabled: () => T | Promise<T>;
}): Promise<T>;
