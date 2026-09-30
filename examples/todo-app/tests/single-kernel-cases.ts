import {storageTests} from '../../../workspace-api/tests/browser/storage-cases';
import {processTests} from '../../../workspace-api/tests/browser/process-cases';
import {httpTests} from '../../../workspace-api/tests/browser/http-cases';

export const selectedStorageNames = [
  'bulk root replacement coalesces delete and recreate without restoring stale descendants',
  'OPFS owner excludes a competing Web Lock and releases it on close',
  'concurrent writes and flushes persist final bytes, rename and deletion before close',
  'SQLite pathname ownership, process-exit release, rollback and orderly reopen',
] as const;
export const singleKernelCases = [
  ...httpTests,
  ...processTests.filter(test=>test.name.includes('stop cleans child listener and permits port reuse')),
  ...storageTests.filter(test=>selectedStorageNames.some(name=>name===test.name)),
];
