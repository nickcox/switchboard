// Only the API exercised by these probes. The pinned package ships no declarations.
declare module "fs-native-extensions" {
  export function tryLock(fd: number): boolean;
}
