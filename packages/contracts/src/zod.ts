import { z } from "zod";

// Zod compiles fast parsers with `new Function` when the runtime allows it. Workers refuse code from
// strings, and the web app's CSP has no 'unsafe-eval', so the probe can only fail, and a browser
// reports it as a CSP violation. Zod reads this setting when it builds a schema, so each schema module
// imports `z` from here, never from "zod".
z.config({ jitless: true });

export { z };
