import { promises } from "./fs"
export const {
  access, appendFile, chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat,
  unlink, utimes, writeFile,
} = promises
export default promises
export { constants } from "./fs"
