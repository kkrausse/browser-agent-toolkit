// `node:fs/promises`.
import { nodeGlobals } from "../globals";

const { promises, constants } = nodeGlobals().fs;
export const {
  access, appendFile, chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat,
  unlink, utimes, writeFile,
} = promises;
export { constants };
export default promises;
