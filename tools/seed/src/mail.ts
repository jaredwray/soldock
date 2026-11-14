// The mail of the made-up organization, in the order that the seed sends it. Each person, client,
// supplier and project is invented. Outside addresses use the reserved example.org and example.net.
import { type ActorKey, type LabelName, PEOPLE, type PersonKey, SUPPORT } from "./cast.ts";

/** A mailbox that the seed reads or changes: the own mailbox of a person, or the shared mailbox. */
export type MailboxKey = PersonKey | "support";

export interface Outsider {
	name: string;
	address: string;
}

/** A message from the internet. The seed posts it to the local inbound mail endpoint of `wrangler dev`. */
export interface InboundStep {
	kind: "inbound";
	/** A stable name. It makes the Message-ID of the message. */
	id: string;
	from: Outsider;
	to: string[];
	cc?: string[];
	subject: string;
	text: string;
	/** Set it for a reply: the mailbox that holds the thread with this subject. */
	replyIn?: MailboxKey;
}

/** A message that a person or an agent sends with `mail.send`, with their own credential. */
export interface SendStep {
	kind: "send";
	/** A stable name. It makes the idempotency key of the send. */
	id: string;
	as: ActorKey;
	/** Set it to send from the shared mailbox. */
	fromSupport?: true;
	to: string[];
	cc?: string[];
	/** The subject of the thread. A reply joins the thread with this subject. */
	subject: string;
	text: string;
	reply?: true;
}

export type MailStep = InboundStep | SendStep;

const { nadia, tomasz, chidi, meiling, rafael, ingrid } = PEOPLE;

const priscilla: Outsider = { name: "Priscilla Nwosu", address: "priscilla@alder-library.example.org" };
const tamsin: Outsider = { name: "Tamsin Hale", address: "tamsin@tamsinbakery.example.net" };
const owen: Outsider = { name: "Owen Pryce", address: "owen@brightwater-joinery.example.net" };
const planning: Outsider = { name: "Harbour District Planning Desk", address: "planning@harbourdistrict.example.org" };
const lucia: Outsider = { name: "Lucía Fernández", address: "lucia.fernandez@example.org" };
const gareth: Outsider = { name: "Gareth Molina", address: "gareth.molina@example.net" };
const dawn: Outsider = { name: "Dawn Achebe", address: "dawn.achebe@example.org" };
const henrik: Outsider = { name: "Henrik Dahl", address: "henrik@dahl-structures.example.net" };
const scaffold: Outsider = { name: "Marsh Lane Scaffolding", address: "office@marshlane-scaffolding.example.net" };

const SUBJECT = {
	daylight: "Alder Street Library: daylight in the reading room",
	planning: "Application HD/0412: request for a revised site plan",
	shelving: "Quote 2291: library shelving, revised",
	stair: "Library mezzanine: two options for the stair",
	counter: "Bakery counter: oak or ash?",
	plotter: "The plotter moves on Friday afternoon",
	drawingSet: "Question about the drawing set you sent",
	visit: "Can a school group visit the studio?",
	triage: "Support summary: two new messages",
	beams: "Beam sizes for the mezzanine",
	scaffold: "Scaffold inspection moved to Thursday",
	finishes: "Bakery finishes board is ready for review",
	cladding: "Notes: timber cladding near a boundary",
	application: "Application: architectural assistant",
	feeProposal: "Fee proposal for the bakery, second stage",
	siteDiary: "Site diary: Alder Street, week 6",
	invoice: "Invoice 0037 received, one question",
} as const;

export const MAIL_STEPS: MailStep[] = [
	{
		kind: "inbound",
		id: "planning-site-plan",
		from: planning,
		to: [nadia.address],
		subject: SUBJECT.planning,
		text: [
			"Dear Ms Rahman,",
			"Thank you for the application for the extension at 14 Alder Street. The case officer needs a revised site plan before the application can go to the next stage.",
			"Please show the position of the new bicycle store and the distance from the rear boundary to the extension. A scale of 1:200 is sufficient.",
			"Please send the plan in the next 14 days and quote the reference HD/0412.",
			"Kind regards,\nHarbour District Planning Desk",
		].join("\n\n"),
	},
	{
		kind: "inbound",
		id: "daylight-1",
		from: priscilla,
		to: [nadia.address],
		cc: [chidi.address],
		subject: SUBJECT.daylight,
		text: [
			"Hello Nadia,",
			"The trustees looked at the sketches on Tuesday and they like the mezzanine very much. Their one worry is the reading room below it. Two of them think it will feel dark in the afternoon.",
			"Could you show us how much daylight reaches the long table in winter? A simple diagram is fine. We do not need a full report.",
			"We meet again on the first Thursday of next month, so there is no rush this week.",
			"Best wishes,\nPriscilla",
		].join("\n\n"),
	},
	{
		kind: "inbound",
		id: "shelving-quote",
		from: owen,
		to: [nadia.address],
		subject: SUBJECT.shelving,
		text: [
			"Hi Nadia,",
			"Here is the revised quote for the library shelving, with the changes from our call.",
			"- 42 bays in ash veneer, 900 mm wide: 18,480\n- 6 low bays for the children's corner: 2,310\n- Delivery and fitting, 4 days on site: 3,200\n- Total before tax: 23,990",
			"The price holds for 30 days. Lead time is 7 weeks from the order, so an order this month keeps us ahead of the decorators.",
			"Regards,\nOwen Pryce\nBrightwater Joinery",
		].join("\n\n"),
	},
	{
		kind: "send",
		id: "stair-1",
		as: "chidi",
		to: [nadia.address],
		cc: [rafael.address],
		subject: SUBJECT.stair,
		text: [
			"Nadia,",
			"I drew two options for the mezzanine stair. The notes are in the doc that I shared with you.",
			"Option A is a straight flight along the north wall. It is the cheaper one and it keeps the reading room open, but it lands close to the entrance.",
			"Option B is a dog-leg stair behind the issue desk. It costs about 15 percent more, and it gives us a landing with a window seat.",
			"I prefer B. Rafael, can you tell me if the existing slab can take the landing post without new footings?",
			"Chidi",
		].join("\n\n"),
	},
	{
		kind: "send",
		id: "daylight-2",
		as: "nadia",
		to: [priscilla.address],
		cc: [chidi.address],
		subject: SUBJECT.daylight,
		reply: true,
		text: [
			"Hello Priscilla,",
			"That is a fair worry, and it is easy to test. Chidi will run a daylight study for the long table at midday and at 3 pm in December and in June.",
			"If the winter figure is low, we have two simple answers: a lighter balustrade on the mezzanine, or a rooflight above the stair. Neither changes the layout that the trustees liked.",
			"You will have the diagrams a week before the meeting.",
			"Best wishes,\nNadia",
		].join("\n\n"),
	},
	{
		kind: "inbound",
		id: "counter-oak-ash",
		from: tamsin,
		to: [nadia.address],
		cc: [meiling.address],
		subject: SUBJECT.counter,
		text: [
			"Hi both,",
			"I went to see the samples at the joiner on Saturday. The oak is lovely, but the ash is lighter and it suits the tiles better. Now I cannot decide.",
			"Does ash mark more easily? The counter gets flour, butter and a lot of hot trays every morning.",
			"I can come to the studio on Wednesday after the lunch rush if it helps to look at the two together.",
			"Tamsin",
		].join("\n\n"),
	},
	{
		kind: "send",
		id: "plotter-move",
		as: "tomasz",
		to: [nadia.address, chidi.address, meiling.address, rafael.address, ingrid.address],
		subject: SUBJECT.plotter,
		text: [
			"Hello everyone,",
			"The plotter moves from the back room to the print corner on Friday at 2 pm. It will be off for about two hours.",
			"If you need large prints for Monday, send them before Friday lunch. The small printer stays on all day.",
			"The back room then becomes the second meeting room. The new table arrives the week after.",
			"Tomasz",
		].join("\n\n"),
	},
	{
		kind: "inbound",
		id: "support-drawing-set",
		from: gareth,
		to: [SUPPORT.address],
		subject: SUBJECT.drawingSet,
		text: [
			"Hello,",
			"I am the builder for the Hale kitchen. The drawing set from last week has two sheets with the number A-203. One shows the floor plan and one shows the ceiling plan.",
			"Which one is correct, and is there a sheet missing? I need to price the ceiling work this week.",
			"Thanks,\nGareth Molina",
		].join("\n\n"),
	},
	{
		kind: "inbound",
		id: "support-school-visit",
		from: dawn,
		to: [SUPPORT.address],
		subject: SUBJECT.visit,
		text: [
			"Good morning,",
			"I teach design at the secondary school on Quarry Road. Twelve of our students would like to see how an architecture studio works.",
			"Could we visit for an hour one afternoon next month? We can come on any day except Wednesday.",
			"Many thanks,\nDawn Achebe",
		].join("\n\n"),
	},
	{
		kind: "send",
		id: "triage-summary",
		as: "triage",
		to: [ingrid.address],
		subject: SUBJECT.triage,
		text: [
			"Two new messages are in the Support mailbox.",
			"1. Gareth Molina, a builder, reports two sheets with the number A-203 in a drawing set. He needs an answer this week to price ceiling work. Suggested owner: the project architect.",
			"2. Dawn Achebe, a teacher, asks if twelve students can visit the studio for an hour next month. Any day except Wednesday. Suggested owner: the office coordinator.",
			"I did not reply to the senders. My outbound policy permits internal mail only.",
		].join("\n\n"),
	},
	{
		kind: "send",
		id: "support-drawing-set-reply",
		as: "ingrid",
		fromSupport: true,
		to: [gareth.address],
		subject: SUBJECT.drawingSet,
		reply: true,
		text: [
			"Hello Gareth,",
			"Thank you for telling us. The floor plan is A-203. The ceiling plan has the wrong number: it is A-204.",
			"No sheet is missing. We will send a corrected set today, so that the numbers agree with the drawing list.",
			"Kind regards,\nIngrid Solberg\nWrenfield Studio",
		].join("\n\n"),
	},
	{
		kind: "inbound",
		id: "beam-sizes",
		from: henrik,
		to: [chidi.address],
		cc: [nadia.address],
		subject: SUBJECT.beams,
		text: [
			"Chidi,",
			"First numbers for the mezzanine, for a span of 5.4 m and library loading:",
			"- Primary beams: 254 x 146 steel sections at 2.7 m centres\n- Joists: 220 x 45 timber at 400 mm centres\n- Deflection limit: span / 360",
			"The existing piers on the north wall are fine. The south side needs two new pad footings, 900 mm square.",
			"I will send the full calculation after the trial pit on site.",
			"Henrik Dahl\nDahl Structures",
		].join("\n\n"),
	},
	{
		kind: "send",
		id: "stair-2",
		as: "rafael",
		to: [chidi.address],
		cc: [nadia.address],
		subject: SUBJECT.stair,
		reply: true,
		text: [
			"Chidi,",
			"I looked at the slab this morning. It is 150 mm thick with mesh, and it is in good condition near the issue desk.",
			"A landing post there is fine with a spreader plate. We do not need a new footing. Henrik should confirm the plate size.",
			"B is also easier for us to build: the materials come in through the side door and the entrance stays open.",
			"Rafael",
		].join("\n\n"),
	},
	{
		kind: "inbound",
		id: "scaffold-inspection",
		from: scaffold,
		to: [rafael.address],
		subject: SUBJECT.scaffold,
		text: [
			"Rafael,",
			"The weekly scaffold inspection at Alder Street moves from Wednesday to Thursday at 8 am this week. Our inspector is on a course on Wednesday.",
			"Nothing else changes. The tags stay green until then.",
			"Marsh Lane Scaffolding",
		].join("\n\n"),
	},
	{
		kind: "send",
		id: "finishes-board",
		as: "meiling",
		to: [nadia.address],
		subject: SUBJECT.finishes,
		text: [
			"Nadia,",
			"The finishes board for the bakery is on the table by the window. The schedule is in the sheet that I shared with you.",
			"I kept the green tiles that Tamsin chose and I put a warmer white on the walls. The floor is the same clay tile as the pavement outside, so the shop reads as one room with the street.",
			"The one open point is the counter top. I will wait for her answer on oak or ash.",
			"Mei-Ling",
		].join("\n\n"),
	},
	{
		kind: "send",
		id: "cladding-notes",
		as: "research",
		to: [chidi.address],
		cc: [nadia.address],
		subject: SUBJECT.cladding,
		text: [
			"You asked for notes on timber cladding for the library extension, which is 1.8 m from the rear boundary.",
			"Summary: timber cladding is possible at this distance, but the wall that faces the boundary needs a treated board or a smaller area of timber. The full notes are in the doc that I shared with you.",
			"Three questions stay open for a person to check: the fire rating that the building inspector accepts, the supplier's test certificate, and the care schedule for the treatment.",
			"I used only the documents in the project folder. I did not contact a supplier.",
		].join("\n\n"),
	},
	{
		kind: "inbound",
		id: "job-application",
		from: lucia,
		to: [nadia.address],
		subject: SUBJECT.application,
		text: [
			"Dear Ms Rahman,",
			"I would like to apply for the position of architectural assistant. I finished my degree last summer, and I worked for a year at a small practice on school and nursery buildings.",
			"I like the work of your studio because the buildings are modest and well made. The community hall with the brick bench along the front is a favourite of mine.",
			"I can send a portfolio of six projects, and I can start next month.",
			"Yours sincerely,\nLucía Fernández",
		].join("\n\n"),
	},
	{
		kind: "send",
		id: "fee-proposal",
		as: "nadia",
		to: [tomasz.address],
		subject: SUBJECT.feeProposal,
		text: [
			"Tomasz,",
			"Can you prepare the fee proposal for the second stage of the bakery? Use the same structure as the library: a fixed fee for each stage, and the site visits on an hourly rate.",
			"My estimate is 46 hours for the drawings and 6 site visits. Mei-Ling has the hours for the interior.",
			"I would like to send it to Tamsin before the end of next week.",
			"Nadia",
		].join("\n\n"),
	},
	{
		kind: "send",
		id: "fee-proposal-reply",
		as: "tomasz",
		to: [nadia.address],
		subject: SUBJECT.feeProposal,
		reply: true,
		text: [
			"Nadia,",
			"Yes. I will have a draft on Tuesday. I will use the rates from the fee tracker, so that the two projects agree.",
			"One question: do we include the shop sign, or does the sign maker quote to Tamsin directly?",
			"Tomasz",
		].join("\n\n"),
	},
	{
		kind: "inbound",
		id: "daylight-3",
		from: priscilla,
		to: [nadia.address],
		cc: [chidi.address],
		subject: SUBJECT.daylight,
		replyIn: "nadia",
		text: [
			"Thank you, Nadia. That is exactly what they need.",
			"One of the trustees asked about the rooflight: would it make the room hot in summer? If the study can answer that also, I think the vote will be easy.",
			"Priscilla",
		].join("\n\n"),
	},
	{
		kind: "send",
		id: "site-diary-6",
		as: "rafael",
		to: [nadia.address],
		cc: [chidi.address],
		subject: SUBJECT.siteDiary,
		text: [
			"Week 6 at Alder Street:",
			"- The trial pit on the south side is dug. The ground is firm clay at 1.1 m.\n- The old boiler is out, and the plant room is clear.\n- The scaffold on the east side is complete and tagged.\n- Two days were lost to rain. The roof strip moves to next week.",
			"No accidents and no near misses. The neighbours at number 16 asked us to start after 8 am, and we agreed.",
			"Next week: the pad footings, and the first delivery of steel on Thursday.",
			"Rafael",
		].join("\n\n"),
	},
	{
		kind: "inbound",
		id: "invoice-question",
		from: priscilla,
		to: [nadia.address],
		subject: SUBJECT.invoice,
		text: [
			"Hello Nadia,",
			"Our treasurer received invoice 0037, thank you. She has one question before she pays it.",
			"The invoice shows 14 hours for the meetings with the planning office. The fee letter says that those meetings are part of the fixed fee for stage 2. Is the 14 hours for something different?",
			"Best wishes,\nPriscilla",
		].join("\n\n"),
	},
];

/** A change to a thread after all the mail arrived: labels, a star, or the read state. */
export interface TidyStep {
	mailbox: MailboxKey;
	subject: string;
	labels?: LabelName[];
	starred?: true;
	read?: true;
}

export const MAIL_TIDY: TidyStep[] = [
	{ mailbox: "nadia", subject: SUBJECT.planning, labels: ["Planning"], read: true },
	{ mailbox: "nadia", subject: SUBJECT.daylight, labels: ["Clients/Alder Street Library"] },
	{ mailbox: "nadia", subject: SUBJECT.shelving, labels: ["Suppliers"], starred: true, read: true },
	{ mailbox: "nadia", subject: SUBJECT.stair, labels: ["Clients/Alder Street Library"], read: true },
	{ mailbox: "nadia", subject: SUBJECT.counter, labels: ["Clients/Tamsin Bakery"] },
	{ mailbox: "nadia", subject: SUBJECT.plotter, read: true },
	{ mailbox: "nadia", subject: SUBJECT.beams, labels: ["Clients/Alder Street Library"], read: true },
	{ mailbox: "nadia", subject: SUBJECT.finishes, labels: ["Clients/Tamsin Bakery"], read: true },
	{ mailbox: "nadia", subject: SUBJECT.application, labels: ["Hiring"], starred: true },
	{ mailbox: "nadia", subject: SUBJECT.siteDiary, labels: ["Clients/Alder Street Library"] },
	{ mailbox: "nadia", subject: SUBJECT.invoice, labels: ["Clients/Alder Street Library"] },
	{ mailbox: "support", subject: SUBJECT.drawingSet, read: true },
];
