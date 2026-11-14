// Public surface of the mail module. Other modules import from here, never from its files.
export { mailHandlers } from "./handlers.ts";
export { handleEmail, handleInboundBatch, type InboundJob, MAIL_INBOUND_QUEUE } from "./inbound.ts";
export { MailboxDO } from "./mailbox.ts";
export { mailWatchers } from "./watch.ts";
