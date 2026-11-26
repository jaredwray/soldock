// Public surface of the mail module. Other modules import from here, never from its files.

export { handleAutoLabelBatch, MAIL_AUTOLABEL_QUEUE } from "./autolabel/consumer.ts";
export {
	type CalendarMailInput,
	type CalendarMailResult,
	type CalendarPart,
	type CalendarSenderCheck,
	readCalendarPart,
	sendCalendarMail,
} from "./calendar-mail.ts";
export { closeAutoLabels, deliverSystemNotice } from "./delivery.ts";
export { mailHandlers } from "./handlers.ts";
export { handleEmail, handleInboundBatch, type InboundJob, MAIL_INBOUND_QUEUE } from "./inbound.ts";
export { MailboxDO } from "./mailbox.ts";
export { deniedOutboundAddresses, outboundMode, outboundPolicyDenial } from "./outbound.ts";
export { mailWatchers } from "./watch.ts";
export { enableMailEvents } from "./webhooks.ts";
