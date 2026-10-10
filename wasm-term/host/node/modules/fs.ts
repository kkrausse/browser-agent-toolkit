// `node:fs` for a bundled program: the instance over the machine's vfs that
// the worker runtime installed (see ../fs.ts for the implementation).
import { nodeGlobals } from "../globals";

const fs = nodeGlobals().fs;
export const {
  accessSync, appendFileSync, chmodSync, constants, copyFileSync, createWriteStream, existsSync, lstatSync,
  mkdirSync, promises, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync,
  unlinkSync, utimesSync, watch, writeFileSync,
} = fs;
export default fs;
