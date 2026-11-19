// The chat rooms of the made-up organization. Each message is posted by its author, with the
// credential of that author. Asterra sets the time of a message, so each message has the time of the
// seed run.
import type { ActorKey } from "./cast.ts";

export type Line = readonly [author: ActorKey, text: string];

export interface Room {
	/** A stable name. It makes the idempotency keys of the messages. */
	id: string;
	kind: "public" | "private";
	name: string;
	topic: string;
	/** The first member creates the room and adds the others. */
	members: ActorKey[];
	lines: Line[];
	/** The owner reads this room, so it shows as read in the screenshots. */
	ownerRead?: true;
}

export interface DirectMessage {
	id: string;
	/** The first one opens the direct message. */
	between: [ActorKey, ActorKey];
	lines: Line[];
}

export const ROOMS: Room[] = [
	{
		id: "general",
		kind: "public",
		name: "General",
		topic: "News for the whole studio",
		members: ["tomasz", "nadia", "chidi", "meiling", "rafael", "ingrid", "triage", "research"],
		ownerRead: true,
		lines: [
			["tomasz", "Morning all. The plotter moves on Friday at 2 pm. Send large prints before lunch that day."],
			["meiling", "Noted. I have the bakery elevations to print, I will do them on Thursday."],
			["ingrid", "The coffee order arrived. Also a box of pastries from Tamsin, on the kitchen table."],
			["rafael", "Save me one. I am on site until 11."],
			["chidi", "No promises."],
			[
				"nadia",
				"Good news: the library trustees liked the mezzanine. They asked for a daylight study, which is a fair question.",
			],
			["tomasz", "That is great. Does the programme change?"],
			["nadia", "No. The next trustee meeting is the first Thursday of next month, and we are ready for it."],
			[
				"ingrid",
				"A teacher from the school on Quarry Road asked if twelve students can visit for an hour. Is anybody against it?",
			],
			["meiling", "Not at all. I can show them the finishes boards."],
			["nadia", "Yes, let us do it. Not on a Friday, please."],
			["ingrid", "I will offer them two Tuesdays."],
			["rafael", "Back from site. Somebody ate the last almond one."],
			["chidi", "It was in a good cause."],
		],
	},
	{
		id: "design",
		kind: "public",
		name: "Design",
		topic: "Drawings, models and reviews",
		members: ["chidi", "nadia", "meiling", "research"],
		ownerRead: true,
		lines: [
			[
				"chidi",
				"Two stair options for the library mezzanine are in my drive, shared with Nadia and Rafael. A is a straight flight, B is a dog-leg with a window seat on the landing.",
			],
			["meiling", "B, without question. The window seat is the best place in the building."],
			["nadia", "I agree, if the cost difference stays near 15 percent. Chidi, what does B do to the daylight below?"],
			[
				"chidi",
				"It helps. The stair moves away from the south windows. I will include the two options in the daylight study.",
			],
			[
				"chidi",
				"Research Agent, please collect what the project folder says about timber cladding near a boundary. The extension is 1.8 m from the rear boundary.",
			],
			[
				"research",
				"Done. The notes are in a doc that I shared with you and Nadia. Three questions stay open for a person: the accepted fire rating, the test certificate of the supplier, and the care schedule.",
			],
			["chidi", "Thanks. I will ask the building inspector about the rating."],
			[
				"meiling",
				"For the bakery: warm white walls, green tiles behind the counter, clay tiles on the floor. The board is by the window.",
			],
			["nadia", "I saw it this morning. The floor is a good idea, the shop and the pavement become one room."],
			["meiling", "The counter top is still open. Tamsin cannot decide between oak and ash."],
			[
				"nadia",
				"Ash with a hard wax oil. It marks less than people think, and it suits the tiles. She can look at the samples here on Wednesday.",
			],
			["meiling", "I will put the two samples out with a hot tray and some flour. A real test."],
		],
	},
	{
		id: "site",
		kind: "public",
		name: "Site",
		topic: "Alder Street Library: progress, deliveries and safety",
		members: ["rafael", "chidi", "nadia", "tomasz"],
		lines: [
			["rafael", "Trial pit on the south side is done. Firm clay at 1.1 m."],
			["chidi", "Good. Henrik wants two pad footings there, 900 mm square. I will send you the sketch."],
			["rafael", "Fine. We can dig them on Monday if the rain stops."],
			["rafael", "The scaffold inspection moves to Thursday at 8 am this week. The tags stay green until then."],
			["tomasz", "Is the first steel delivery still Thursday? The supplier wants a contact name for the driver."],
			[
				"rafael",
				"Yes, Thursday before 10. The contact is me. The lorry must come from the Quarry Road end, the other end is too narrow.",
			],
			["tomasz", "I will tell them."],
			["nadia", "Rafael, the neighbours at number 16: is the 8 am start a problem for the programme?"],
			["rafael", "No. We lose half an hour a day, and we have float for that. They are happier, which is worth more."],
			[
				"chidi",
				"The landing post for stair B: Rafael says the slab is fine with a spreader plate. I asked Henrik for the plate size.",
			],
			["rafael", "Photos of the slab are in the project folder, in the week 6 diary."],
		],
	},
	{
		id: "support",
		kind: "public",
		name: "Support",
		topic: "Questions from clients, builders and visitors",
		members: ["ingrid", "tomasz", "nadia", "triage"],
		lines: [
			[
				"triage",
				"Two new messages are in the Support mailbox. One is from a builder about a sheet number in a drawing set, and it needs an answer this week. One is a request for a school visit.",
			],
			[
				"ingrid",
				"Thanks. I have the builder. Chidi confirmed that the ceiling plan is A-204, and I replied from the Support mailbox.",
			],
			["tomasz", "Do we send the corrected set to everybody who got the first one?"],
			["ingrid", "Yes. Four people got it. I will send it this afternoon with a short note."],
			[
				"triage",
				"I can prepare the list of the four recipients from the sent mail of the Support mailbox. I cannot send to outside addresses.",
			],
			["ingrid", "Please do. Put the list here."],
			[
				"triage",
				"The four recipients are the builder, the client, the kitchen supplier and the electrician. Each address is in the sent message of last Tuesday.",
			],
			["ingrid", "Perfect, thank you."],
		],
	},
	{
		id: "partners",
		kind: "private",
		name: "Partners",
		topic: "Fees, hiring and the studio budget",
		members: ["nadia", "tomasz"],
		ownerRead: true,
		lines: [
			[
				"nadia",
				"An application arrived for the assistant position. One year of experience on schools and nurseries, and a good letter.",
			],
			["tomasz", "That is the third. Do you want to see all three in the same week?"],
			["nadia", "Yes. Two afternoons, and Chidi joins for the portfolio part."],
			[
				"tomasz",
				"I will arrange it. The budget has room for the position from next quarter, if the bakery second stage goes ahead.",
			],
			["nadia", "It will. Tamsin asked for the fee proposal. Can you have a draft on Tuesday?"],
			["tomasz", "Yes. One question is in my reply to your mail: the shop sign, in or out?"],
			["nadia", "Out. The sign maker quotes to her directly, and we only review the drawing."],
		],
	},
];

export const DIRECT_MESSAGES: DirectMessage[] = [
	{
		id: "nadia-chidi",
		between: ["nadia", "chidi"],
		lines: [
			["nadia", "Do you have ten minutes after lunch? I want to go through the daylight study before you start."],
			["chidi", "Yes, 1.30 at the big table. I will bring the model."],
			["nadia", "Good. Priscilla also asked if a rooflight makes the room hot in summer."],
			["chidi", "A fair point. I will add a summer check, and a blind is a simple answer if the number is high."],
			["nadia", "Thank you. And well done on option B."],
		],
	},
	{
		id: "meiling-rafael",
		between: ["meiling", "rafael"],
		lines: [
			[
				"meiling",
				"When you are next at the bakery, can you measure the step at the door? The drawing says 140 mm and it looks like more.",
			],
			["rafael", "I am there on Wednesday morning. I will measure it and send a photo."],
			["meiling", "Thanks. If it is more than 150 we need a different threshold."],
			["rafael", "Understood. I will check the floor level inside too."],
		],
	},
	{
		id: "ingrid-triage",
		between: ["ingrid", "triage"],
		lines: [
			["ingrid", "Please write a summary of the Support mailbox each morning at 9, and send it to me by mail."],
			[
				"triage",
				"I will. Each summary lists the new messages, a suggested owner for each one, and the messages that wait for a reply for more than two days.",
			],
			["ingrid", "Good. Do not reply to senders."],
			["triage", "Understood. My outbound policy permits internal mail only, so I cannot reply to an outside sender."],
		],
	},
];
