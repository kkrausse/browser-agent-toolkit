// Only ever reached through require(): must throw ERR_REQUIRE_ASYNC_MODULE.
export const value = await Promise.resolve(1);
