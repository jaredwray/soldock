// The local Worker of the tests. The port is not the port of `pnpm dev`, so the two can run at the
// same time.
export const PORT = 8799;
export const BASE_URL = `http://localhost:${PORT}`;

/** The setup token of the local Worker. It exists only for this run, and only on this machine. */
export const SETUP_TOKEN = "e2e-setup-token-0123456789abcdef";
