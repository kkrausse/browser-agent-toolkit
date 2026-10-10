/*
** SQLite OS layer and JS-facing shims for the bat runtime.
**
** Built with -DSQLITE_OS_OTHER=1: SQLite brings no OS code of its own, and this
** file supplies sqlite3_os_init() with one VFS, "bat". File bytes live behind
** host imports (module "bat") that the TypeScript side maps onto an FsBackend
** (kernel file descriptors in the browser, node:fs under Node). Everything that
** does not need the host stays in C so that it costs no JS crossing:
**
**  - file locks (xLock/xUnlock/xCheckReservedLock) are an in-process table
**    keyed by database path, enough for several connections in one process;
**  - the WAL index (xShmMap/xShmLock/...) is heap memory shared by the
**    connections of this process, so `PRAGMA journal_mode=WAL` is real WAL in
**    normal locking mode. It is rebuilt from the -wal file by SQLite's ordinary
**    recovery when the first connection opens.
**
** Nothing here coordinates with another process: see docs/design/decisions.md.
*/
#include "sqlite3.h"
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define IMPORT(name) __attribute__((import_module("bat"), import_name(#name)))
#define EXPORT(name) __attribute__((export_name(#name)))

/* ---- host imports: files ------------------------------------------------ */

/* fd >= 0, or -1. *pOutFlags gets SQLITE_OPEN_READONLY or SQLITE_OPEN_READWRITE. */
IMPORT(open) int js_open(const char *zName, int flags, int *pOutFlags);
IMPORT(close) int js_close(int fd);
/* bytes read (short at end of file), or -1 */
IMPORT(read) int js_read(int fd, void *p, int n, double off);
/* 0, -1 (error) or -2 (full) */
IMPORT(write) int js_write(int fd, const void *p, int n, double off);
IMPORT(truncate) int js_truncate(int fd, double size);
IMPORT(sync) int js_sync(int fd, int flags);
IMPORT(size) double js_size(int fd);
/* 0 deleted, 1 did not exist, -1 error */
IMPORT(delete) int js_delete(const char *zName, int syncDir);
IMPORT(access) int js_access(const char *zName, int flags);
IMPORT(fullpath) int js_fullpath(const char *zName, int nOut, char *zOut);
IMPORT(random) void js_random(int n, void *p);
IMPORT(now) double js_now(void);
IMPORT(devchar) int js_devchar(void);

/* ---- host imports: user functions ---------------------------------------- */

IMPORT(func_call) void js_func_call(int id, sqlite3_context *ctx, int argc, sqlite3_value **argv);
IMPORT(func_destroy) void js_func_destroy(int id);
/* state is the aggregate context address (0 in final/value when no row was stepped) */
IMPORT(agg_step) void js_agg_step(int id, sqlite3_context *ctx, int state, int argc, sqlite3_value **argv, int inverse);
IMPORT(agg_final) void js_agg_final(int id, sqlite3_context *ctx, int state, int isFinal);
IMPORT(authorize) int js_authorize(int id, int action, const char *a, const char *b, const char *c, const char *d);

/* ---- per-database-file state shared by connections ----------------------- */

typedef struct BatFile BatFile;
typedef struct BatNode BatNode;
struct BatNode {
  BatNode *pNext;
  char *zPath;
  int nRef;
  /* file locks */
  int nShared;
  BatFile *pReserved;
  BatFile *pPending; /* holder of PENDING or EXCLUSIVE */
  int isExclusive;
  /* wal index */
  int nShmRef;
  int nRegion;
  int szRegion;
  void **apRegion;
  int aShmShared[SQLITE_SHM_NLOCK];
  BatFile *aShmExcl[SQLITE_SHM_NLOCK];
};

struct BatFile {
  sqlite3_file base;
  int fd;
  int eLock;
  BatNode *pNode;       /* main database files only */
  char *zDelete;        /* path to delete on close */
  unsigned shmShared;   /* slots this connection holds shared */
  unsigned shmExcl;     /* slots this connection holds exclusive */
  int hasShm;
};

static BatNode *batNodes = 0;
static int batDevChar = 0;

static BatNode *nodeFind(const char *zPath, int create){
  BatNode *p;
  for(p=batNodes; p; p=p->pNext){
    if( strcmp(p->zPath, zPath)==0 ){ p->nRef++; return p; }
  }
  if( !create ) return 0;
  size_t n = strlen(zPath);
  p = (BatNode*)sqlite3_malloc64(sizeof(BatNode)+n+1);
  if( !p ) return 0;
  memset(p, 0, sizeof(BatNode));
  p->zPath = (char*)&p[1];
  memcpy(p->zPath, zPath, n+1);
  p->nRef = 1;
  p->pNext = batNodes;
  batNodes = p;
  return p;
}

static void shmFree(BatNode *p){
  for(int i=0; i<p->nRegion; i++) sqlite3_free(p->apRegion[i]);
  sqlite3_free(p->apRegion);
  p->apRegion = 0;
  p->nRegion = 0;
}

static void nodeRelease(BatNode *p){
  if( --p->nRef>0 ) return;
  BatNode **pp;
  for(pp=&batNodes; *pp!=p; pp=&(*pp)->pNext){}
  *pp = p->pNext;
  shmFree(p);
  sqlite3_free(p);
}

/* ---- sqlite3_io_methods --------------------------------------------------- */

static int batUnlock(sqlite3_file *pFile, int eLock);
static int batShmUnmap(sqlite3_file *pFile, int deleteFlag);

static int batClose(sqlite3_file *pFile){
  BatFile *p = (BatFile*)pFile;
  if( p->pNode ){
    if( p->hasShm ) batShmUnmap(pFile, 0);
    batUnlock(pFile, SQLITE_LOCK_NONE);
    nodeRelease(p->pNode);
    p->pNode = 0;
  }
  int rc = js_close(p->fd);
  if( p->zDelete ){
    js_delete(p->zDelete, 0);
    sqlite3_free(p->zDelete);
    p->zDelete = 0;
  }
  return rc==0 ? SQLITE_OK : SQLITE_IOERR_CLOSE;
}

static int batRead(sqlite3_file *pFile, void *zBuf, int iAmt, sqlite3_int64 iOfst){
  BatFile *p = (BatFile*)pFile;
  int n = js_read(p->fd, zBuf, iAmt, (double)iOfst);
  if( n==iAmt ) return SQLITE_OK;
  if( n<0 ) return SQLITE_IOERR_READ;
  memset((char*)zBuf+n, 0, iAmt-n);
  return SQLITE_IOERR_SHORT_READ;
}

static int batWrite(sqlite3_file *pFile, const void *zBuf, int iAmt, sqlite3_int64 iOfst){
  BatFile *p = (BatFile*)pFile;
  int rc = js_write(p->fd, zBuf, iAmt, (double)iOfst);
  if( rc==0 ) return SQLITE_OK;
  return rc==-2 ? SQLITE_FULL : SQLITE_IOERR_WRITE;
}

static int batTruncate(sqlite3_file *pFile, sqlite3_int64 size){
  BatFile *p = (BatFile*)pFile;
  return js_truncate(p->fd, (double)size)==0 ? SQLITE_OK : SQLITE_IOERR_TRUNCATE;
}

static int batSync(sqlite3_file *pFile, int flags){
  BatFile *p = (BatFile*)pFile;
  return js_sync(p->fd, flags)==0 ? SQLITE_OK : SQLITE_IOERR_FSYNC;
}

static int batFileSize(sqlite3_file *pFile, sqlite3_int64 *pSize){
  BatFile *p = (BatFile*)pFile;
  double n = js_size(p->fd);
  if( n<0 ) return SQLITE_IOERR_FSTAT;
  *pSize = (sqlite3_int64)n;
  return SQLITE_OK;
}

static int batLock(sqlite3_file *pFile, int eLock){
  BatFile *p = (BatFile*)pFile;
  BatNode *nd = p->pNode;
  if( !nd || eLock<=p->eLock ) return SQLITE_OK;
  if( p->eLock==SQLITE_LOCK_NONE ){
    /* A writer waiting for readers to leave, or writing, shuts new readers out. */
    if( nd->pPending ) return SQLITE_BUSY;
    nd->nShared++;
    p->eLock = SQLITE_LOCK_SHARED;
    if( eLock==SQLITE_LOCK_SHARED ) return SQLITE_OK;
  }
  if( eLock>=SQLITE_LOCK_RESERVED && p->eLock<SQLITE_LOCK_RESERVED ){
    if( nd->pReserved || (nd->pPending && nd->pPending!=p) ) return SQLITE_BUSY;
    if( eLock==SQLITE_LOCK_RESERVED ){
      nd->pReserved = p;
      p->eLock = SQLITE_LOCK_RESERVED;
      return SQLITE_OK;
    }
  }
  /* EXCLUSIVE (possibly straight from SHARED, as WAL and hot-journal recovery do) */
  if( nd->pPending && nd->pPending!=p ) return SQLITE_BUSY;
  nd->pPending = p;
  if( p->eLock<SQLITE_LOCK_PENDING ) p->eLock = SQLITE_LOCK_PENDING;
  if( nd->nShared>1 ) return SQLITE_BUSY;
  nd->isExclusive = 1;
  p->eLock = SQLITE_LOCK_EXCLUSIVE;
  return SQLITE_OK;
}

static int batUnlock(sqlite3_file *pFile, int eLock){
  BatFile *p = (BatFile*)pFile;
  BatNode *nd = p->pNode;
  if( !nd || eLock>=p->eLock ) return SQLITE_OK;
  if( nd->pPending==p ){ nd->pPending = 0; nd->isExclusive = 0; }
  if( nd->pReserved==p ) nd->pReserved = 0;
  if( eLock==SQLITE_LOCK_NONE && p->eLock>=SQLITE_LOCK_SHARED ) nd->nShared--;
  p->eLock = eLock;
  return SQLITE_OK;
}

static int batCheckReservedLock(sqlite3_file *pFile, int *pResOut){
  BatFile *p = (BatFile*)pFile;
  BatNode *nd = p->pNode;
  *pResOut = nd && (nd->pReserved || nd->pPending);
  return SQLITE_OK;
}

static int batFileControl(sqlite3_file *pFile, int op, void *pArg){
  BatFile *p = (BatFile*)pFile;
  switch( op ){
    case SQLITE_FCNTL_LOCKSTATE:
      *(int*)pArg = p->eLock;
      return SQLITE_OK;
    case SQLITE_FCNTL_VFSNAME:
      *(char**)pArg = sqlite3_mprintf("bat");
      return SQLITE_OK;
  }
  return SQLITE_NOTFOUND;
}

static int batSectorSize(sqlite3_file *pFile){
  (void)pFile;
  return 4096;
}

static int batDeviceCharacteristics(sqlite3_file *pFile){
  (void)pFile;
  return batDevChar;
}

/* ---- wal index in process memory ------------------------------------------ */

static int batShmMap(sqlite3_file *pFile, int iRegion, int szRegion, int bExtend, void volatile **pp){
  BatFile *p = (BatFile*)pFile;
  BatNode *nd = p->pNode;
  *pp = 0;
  if( !nd ) return SQLITE_IOERR_SHMMAP;
  if( !p->hasShm ){
    p->hasShm = 1;
    nd->nShmRef++;
  }
  if( iRegion>=nd->nRegion ){
    if( !bExtend ) return SQLITE_OK;
    void **ap = (void**)sqlite3_realloc64(nd->apRegion, sizeof(void*)*(iRegion+1));
    if( !ap ) return SQLITE_IOERR_NOMEM;
    nd->apRegion = ap;
    nd->szRegion = szRegion;
    while( nd->nRegion<=iRegion ){
      void *r = sqlite3_malloc64(szRegion);
      if( !r ) return SQLITE_IOERR_NOMEM;
      memset(r, 0, szRegion);
      nd->apRegion[nd->nRegion++] = r;
    }
  }
  *pp = nd->apRegion[iRegion];
  return SQLITE_OK;
}

static int batShmLock(sqlite3_file *pFile, int ofst, int n, int flags){
  BatFile *p = (BatFile*)pFile;
  BatNode *nd = p->pNode;
  if( !nd ) return SQLITE_IOERR_SHMLOCK;
  int i;
  if( flags & SQLITE_SHM_UNLOCK ){
    for(i=ofst; i<ofst+n; i++){
      unsigned bit = 1u<<i;
      if( p->shmExcl & bit ){ nd->aShmExcl[i] = 0; p->shmExcl &= ~bit; }
      if( p->shmShared & bit ){ nd->aShmShared[i]--; p->shmShared &= ~bit; }
    }
  }else if( flags & SQLITE_SHM_SHARED ){
    for(i=ofst; i<ofst+n; i++){
      if( nd->aShmExcl[i] && nd->aShmExcl[i]!=p ) return SQLITE_BUSY;
    }
    for(i=ofst; i<ofst+n; i++){
      unsigned bit = 1u<<i;
      if( !(p->shmShared & bit) ){ nd->aShmShared[i]++; p->shmShared |= bit; }
    }
  }else{
    for(i=ofst; i<ofst+n; i++){
      unsigned bit = 1u<<i;
      if( nd->aShmExcl[i] && nd->aShmExcl[i]!=p ) return SQLITE_BUSY;
      if( nd->aShmShared[i] > ((p->shmShared & bit) ? 1 : 0) ) return SQLITE_BUSY;
    }
    for(i=ofst; i<ofst+n; i++){
      nd->aShmExcl[i] = p;
      p->shmExcl |= 1u<<i;
    }
  }
  return SQLITE_OK;
}

static void batShmBarrier(sqlite3_file *pFile){
  (void)pFile;
}

static int batShmUnmap(sqlite3_file *pFile, int deleteFlag){
  BatFile *p = (BatFile*)pFile;
  BatNode *nd = p->pNode;
  (void)deleteFlag;
  if( !nd || !p->hasShm ) return SQLITE_OK;
  batShmLock(pFile, 0, SQLITE_SHM_NLOCK, SQLITE_SHM_UNLOCK);
  p->hasShm = 0;
  /* The index of the last connection is dropped: the next opener recovers it from the WAL. */
  if( --nd->nShmRef==0 ) shmFree(nd);
  return SQLITE_OK;
}

static const sqlite3_io_methods batIoMethods = {
  2,
  batClose, batRead, batWrite, batTruncate, batSync, batFileSize,
  batLock, batUnlock, batCheckReservedLock, batFileControl,
  batSectorSize, batDeviceCharacteristics,
  batShmMap, batShmLock, batShmBarrier, batShmUnmap,
  0, 0
};

/* ---- sqlite3_vfs ------------------------------------------------------------ */

static int batOpen(sqlite3_vfs *pVfs, sqlite3_filename zName, sqlite3_file *pFile, int flags, int *pOutFlags){
  BatFile *p = (BatFile*)pFile;
  (void)pVfs;
  memset(p, 0, sizeof(BatFile));
  char zTemp[64];
  const char *z = zName;
  if( !z ){
    /* An anonymous temporary file (rare: the build keeps temp storage in memory). */
    unsigned char r[12];
    js_random(sizeof(r), r);
    sqlite3_snprintf(sizeof(zTemp), zTemp, "/tmp/etilqs_%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x",
        r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11]);
    z = zTemp;
    flags |= SQLITE_OPEN_DELETEONCLOSE | SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE;
  }
  int out = 0;
  int fd = js_open(z, flags, &out);
  if( fd<0 ) return SQLITE_CANTOPEN;
  p->fd = fd;
  if( flags & SQLITE_OPEN_DELETEONCLOSE ){
    p->zDelete = sqlite3_mprintf("%s", z);
    if( !p->zDelete ){ js_close(fd); return SQLITE_NOMEM; }
  }
  if( flags & SQLITE_OPEN_MAIN_DB ){
    p->pNode = nodeFind(z, 1);
    if( !p->pNode ){ js_close(fd); sqlite3_free(p->zDelete); return SQLITE_NOMEM; }
  }
  if( pOutFlags ) *pOutFlags = (flags & ~(SQLITE_OPEN_READONLY|SQLITE_OPEN_READWRITE)) | out;
  p->base.pMethods = &batIoMethods;
  return SQLITE_OK;
}

static int batDelete(sqlite3_vfs *pVfs, const char *zName, int syncDir){
  (void)pVfs;
  int rc = js_delete(zName, syncDir);
  if( rc==0 ) return SQLITE_OK;
  return rc==1 ? SQLITE_IOERR_DELETE_NOENT : SQLITE_IOERR_DELETE;
}

static int batAccess(sqlite3_vfs *pVfs, const char *zName, int flags, int *pResOut){
  (void)pVfs;
  *pResOut = js_access(zName, flags);
  return SQLITE_OK;
}

static int batFullPathname(sqlite3_vfs *pVfs, const char *zName, int nOut, char *zOut){
  (void)pVfs;
  return js_fullpath(zName, nOut, zOut)==0 ? SQLITE_OK : SQLITE_CANTOPEN;
}

static int batRandomness(sqlite3_vfs *pVfs, int nByte, char *zOut){
  (void)pVfs;
  js_random(nByte, zOut);
  return nByte;
}

/* Nothing else can run while this thread sleeps, so a busy handler has nothing
** to wait for: report the time as slept and let the timeout expire. */
static int batSleep(sqlite3_vfs *pVfs, int microseconds){
  (void)pVfs;
  return microseconds;
}

static int batCurrentTimeInt64(sqlite3_vfs *pVfs, sqlite3_int64 *piNow){
  (void)pVfs;
  *piNow = (sqlite3_int64)js_now() + 210866760000000LL;
  return SQLITE_OK;
}

static int batCurrentTime(sqlite3_vfs *pVfs, double *pNow){
  sqlite3_int64 i;
  batCurrentTimeInt64(pVfs, &i);
  *pNow = i/86400000.0;
  return SQLITE_OK;
}

static int batGetLastError(sqlite3_vfs *pVfs, int n, char *z){
  (void)pVfs; (void)n; (void)z;
  return 0;
}

static sqlite3_vfs batVfs = {
  2, sizeof(BatFile), 1024, 0, "bat", 0,
  batOpen, batDelete, batAccess, batFullPathname,
  0, 0, 0, 0,
  batRandomness, batSleep, batCurrentTime, batGetLastError,
  batCurrentTimeInt64,
  0, 0, 0
};

int sqlite3_os_init(void){
  batDevChar = js_devchar();
  return sqlite3_vfs_register(&batVfs, 1);
}

int sqlite3_os_end(void){
  return SQLITE_OK;
}

/* ---- shims: 64-bit values as doubles, so the JS boundary has no BigInt ------ */

EXPORT(bat_changes) double bat_changes(sqlite3 *db){
  return (double)sqlite3_changes64(db);
}

EXPORT(bat_last_insert_rowid) double bat_last_insert_rowid(sqlite3 *db){
  return (double)sqlite3_last_insert_rowid(db);
}

EXPORT(bat_bind_text) int bat_bind_text(sqlite3_stmt *s, int i, char *z, int n){
  return sqlite3_bind_text(s, i, z, n, sqlite3_free);
}

EXPORT(bat_bind_blob) int bat_bind_blob(sqlite3_stmt *s, int i, void *z, int n){
  return sqlite3_bind_blob(s, i, z, n, sqlite3_free);
}

EXPORT(bat_result_text) void bat_result_text(sqlite3_context *c, char *z, int n){
  sqlite3_result_text(c, z, n, sqlite3_free);
}

EXPORT(bat_result_blob) void bat_result_blob(sqlite3_context *c, void *z, int n){
  sqlite3_result_blob(c, z, n, sqlite3_free);
}

EXPORT(bat_exec) int bat_exec(sqlite3 *db, const char *zSql){
  return sqlite3_exec(db, zSql, 0, 0, 0);
}

EXPORT(bat_db_config) int bat_db_config(sqlite3 *db, int op, int v){
  return sqlite3_db_config(db, op, v, (int*)0);
}

/*
** One row into a flat record so that `all()` costs one call per row instead of
** two or three per column. For each column, 16 bytes at out[i]:
**   u32 type; u32 nBytes; then f64 number, or u32 pointer for text and blob.
** Integers are written as f64 when that is exact and flagged type 6 (with the
** i64 in the same slot) when they are not safe for a JS number.
*/
EXPORT(bat_row) void bat_row(sqlite3_stmt *s, int nCol, unsigned char *out){
  for(int i=0; i<nCol; i++, out+=16){
    int t = sqlite3_column_type(s, i);
    uint32_t n = 0;
    switch( t ){
      case SQLITE_INTEGER: {
        sqlite3_int64 v = sqlite3_column_int64(s, i);
        if( v>=-9007199254740991LL && v<=9007199254740991LL ){
          double d = (double)v;
          memcpy(out+8, &d, 8);
        }else{
          t = 6;
          memcpy(out+8, &v, 8);
        }
        break;
      }
      case SQLITE_FLOAT: {
        double d = sqlite3_column_double(s, i);
        memcpy(out+8, &d, 8);
        break;
      }
      case SQLITE_TEXT: {
        uint32_t p = (uint32_t)(uintptr_t)sqlite3_column_text(s, i);
        n = (uint32_t)sqlite3_column_bytes(s, i);
        memcpy(out+8, &p, 4);
        break;
      }
      case SQLITE_BLOB: {
        uint32_t p = (uint32_t)(uintptr_t)sqlite3_column_blob(s, i);
        n = (uint32_t)sqlite3_column_bytes(s, i);
        memcpy(out+8, &p, 4);
        break;
      }
    }
    memcpy(out, &t, 4);
    memcpy(out+4, &n, 4);
  }
}

/* ---- shims: user-defined functions ---------------------------------------- */

static void fnCall(sqlite3_context *c, int argc, sqlite3_value **argv){
  js_func_call((int)(intptr_t)sqlite3_user_data(c), c, argc, argv);
}
static void fnDestroy(void *p){
  js_func_destroy((int)(intptr_t)p);
}
static void aggStep(sqlite3_context *c, int argc, sqlite3_value **argv){
  js_agg_step((int)(intptr_t)sqlite3_user_data(c), c, (int)(intptr_t)sqlite3_aggregate_context(c, 8), argc, argv, 0);
}
static void aggInverse(sqlite3_context *c, int argc, sqlite3_value **argv){
  js_agg_step((int)(intptr_t)sqlite3_user_data(c), c, (int)(intptr_t)sqlite3_aggregate_context(c, 8), argc, argv, 1);
}
static void aggFinal(sqlite3_context *c){
  js_agg_final((int)(intptr_t)sqlite3_user_data(c), c, (int)(intptr_t)sqlite3_aggregate_context(c, 0), 1);
}
static void aggValue(sqlite3_context *c){
  js_agg_final((int)(intptr_t)sqlite3_user_data(c), c, (int)(intptr_t)sqlite3_aggregate_context(c, 0), 0);
}

EXPORT(bat_create_function) int bat_create_function(sqlite3 *db, const char *zName, int nArg, int flags, int id){
  return sqlite3_create_function_v2(db, zName, nArg, flags, (void*)(intptr_t)id, fnCall, 0, 0, fnDestroy);
}

EXPORT(bat_create_aggregate) int bat_create_aggregate(sqlite3 *db, const char *zName, int nArg, int flags, int id, int window){
  return sqlite3_create_window_function(db, zName, nArg, flags, (void*)(intptr_t)id,
      aggStep, aggFinal, window ? aggValue : 0, window ? aggInverse : 0, fnDestroy);
}

static int authCall(void *p, int action, const char *a, const char *b, const char *c, const char *d){
  return js_authorize((int)(intptr_t)p, action, a, b, c, d);
}

EXPORT(bat_set_authorizer) int bat_set_authorizer(sqlite3 *db, int id){
  return sqlite3_set_authorizer(db, id ? authCall : 0, (void*)(intptr_t)id);
}

EXPORT(bat_value_int_safe) int bat_value_int_safe(sqlite3_value *v){
  sqlite3_int64 i = sqlite3_value_int64(v);
  return i>=-9007199254740991LL && i<=9007199254740991LL;
}
