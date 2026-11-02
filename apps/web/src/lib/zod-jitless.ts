// @soldock/contracts makes Zod schemas when it loads. By default, Zod then calls `new Function` to
// find out if it can compile fast parsers. The CSP in public/_headers has no 'unsafe-eval', so the
// browser reports that call as a violation. Zod reads this global object before it makes a schema.
// Thus main.tsx must import this module before any module that imports @soldock/contracts.
const scope = globalThis as { __zod_globalConfig?: Record<string, unknown> };
scope.__zod_globalConfig = { ...scope.__zod_globalConfig, jitless: true };
