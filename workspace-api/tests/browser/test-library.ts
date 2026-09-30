// Emitted test-only library entry. One bundled copy owns all public APIs and the
// private test escape hatch; never expose this entry from the public package.
export * from '../../src/index.js';
export {workspaceInternals} from '../../src/workspace.js';
