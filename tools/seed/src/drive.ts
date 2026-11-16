// The drive items of the made-up organization. Each item is created by its owner, with the
// credential of that owner.
import { type ActorKey, ORGANIZATION } from "./cast.ts";

export interface Share {
	with: ActorKey;
	role: "editor" | "viewer";
}

interface ItemBase {
	/** A stable name. It makes the idempotency key of the create call. */
	id: string;
	name: string;
	share?: Share[];
	starred?: true;
}

export type DriveNode =
	| (ItemBase & { kind: "folder"; children: DriveNode[] })
	| (ItemBase & { kind: "doc"; markdown: string })
	/** Each row is a list of cell inputs, from column A. A formula starts with `=`. */
	| (ItemBase & { kind: "sheet"; rows: string[][] })
	| (ItemBase & { kind: "file"; mimeType: string; text: string });

export interface Drive {
	owner: ActorKey;
	items: DriveNode[];
}

/** A shared drive. The drive owns its items, and each member gets access through a role. */
export interface SharedDriveSeed {
	/** A stable name. It makes the idempotency key of the create call. */
	id: string;
	name: string;
	/** At least one person is a manager. An agent can be only an editor or a viewer. */
	members: { who: ActorKey; role: "manager" | "editor" | "viewer" }[];
	/** The member who adds the items: an editor or a manager. */
	author: ActorKey;
	items: DriveNode[];
}

const DESIGN_BRIEF = `# Alder Street Library: design brief

## The building

The library is a brick building from the 1930s on the corner of Alder Street and Quarry Road. It has one tall room, a small office and a plant room. The trustees own the building and a volunteer team runs it.

The room is well loved, but it is too small. On a Saturday morning the children's corner, the reading table and the issue desk share 140 square metres.

## What the trustees ask for

- More seats for readers: 40 seats in place of 22.
- A quiet room for study, away from the children's corner.
- A step-free entrance and an accessible toilet.
- Lower heating bills. The boiler is 30 years old.
- No closure of more than four weeks during the work.

## Our proposal

We add a **mezzanine** along the north wall and a single-storey extension to the rear. The mezzanine holds the quiet study room. The extension holds the children's corner, with a door to the garden.

The tall room keeps its windows and its timber roof. New shelving in ash goes along the walls, so that the middle of the room stays open for the long reading table.

## Open questions

1. Daylight below the mezzanine in winter. A study is in progress.
2. The stair: a straight flight or a dog-leg with a landing.
3. Timber cladding on the wall that faces the rear boundary.

> The building must feel like the same library, with more room in it.
`;

const SITE_VISIT_NOTES = `# Tamsin Bakery: site visit notes

## Who was there

Tamsin Hale (client), Mei-Ling Zhou, Rafael Ortega.

## What we saw

The shop is 4.2 m wide and 9 m deep, with the ovens at the back. The floor has three layers of old vinyl on a sound concrete slab. The ceiling hides a good plaster cornice at the front.

The step at the door is higher than the drawing shows. Rafael measures it again next week.

## What Tamsin wants

- Customers can see the ovens from the door.
- A counter that takes hot trays, flour and butter each morning.
- Two small tables by the window, no more.
- The shop stays open during the work, except for one week.

## Next steps

1. Mei-Ling completes the finishes board.
2. Tamsin chooses oak or ash for the counter top.
3. Tomasz prepares the fee proposal for the second stage.
`;

const HANDBOOK = `# Studio handbook

Welcome to ${ORGANIZATION.name}. This page says how we work. It is short on purpose.

## Hours

The studio is open from 8.30 to 5.30. Most of us are in from Tuesday to Thursday. Tell the team in the General room when you work from home or from site.

## Drawings

- Each drawing has a number, a revision letter and a date.
- A second person checks each drawing before it leaves the studio.
- The drawing list of a project is the record of what we sent, and to whom.

## Mail and the Support mailbox

Questions from clients, builders and visitors go to the Support mailbox. Ingrid reads it each morning. The Triage Agent writes a summary, and it does not reply to senders.

## Site visits

Wear boots, a hard hat and a high-visibility vest on each site. Sign in with the site manager. Write the visit in the site diary on the same day.

## Agents

An agent is a member of the team with its own address. Each agent has a sponsor, who is accountable for its work. Ask the sponsor if you want an agent to do a task for you.
`;

const STAIR_OPTIONS = `# Library mezzanine: stair options

## Option A: straight flight

A straight flight of 16 risers along the north wall. It lands 2.1 m from the entrance door.

- **For:** the lower cost, and a simple steel structure.
- **Against:** the landing is close to the entrance, and the stair is in view from each seat.

## Option B: dog-leg with a landing

Two flights of 8 risers behind the issue desk, with a half landing against the west window.

- **For:** a window seat on the landing, more daylight below, and an entrance that stays clear.
- **Against:** the cost is about 15 percent higher, and the landing needs a post on the existing slab.

## Recommendation

Option B. The slab can take the post with a spreader plate, and the window seat gives the library a place that it does not have today.
`;

const CLADDING_NOTES = `# Timber cladding near a boundary: notes

*The Research Agent wrote these notes from the documents in the project folder. A person must check each point before it goes into a drawing.*

## The question

The library extension is 1.8 m from the rear boundary. Can the wall that faces the boundary have timber cladding?

## What the documents say

- The design brief asks for timber on the extension, to agree with the roof of the tall room.
- The planning notes give no rule against timber. They ask for materials that agree with the brick of the old building.
- The structural notes give the wall as a timber frame with a 140 mm stud.

## What follows

Timber is possible, with one of two changes on the boundary wall:

1. A board with a fire treatment that the building inspector accepts.
2. A smaller area of timber, with brick on the lower part of the wall.

## Open points for a person

- The fire rating that the building inspector accepts at this distance.
- The test certificate of the supplier for the treated board.
- The care schedule: how often the treatment needs a new coat.
`;

const ROOM_SCHEDULE = [
	"Room,Level,Area m2,Seats,Floor finish",
	"Reading room,Ground,96,24,Oak boards (existing)",
	"Children's corner,Ground,38,10,Cork tile",
	"Issue desk,Ground,12,2,Oak boards (existing)",
	"Quiet study,Mezzanine,34,12,Carpet tile",
	"Office,Ground,11,2,Linoleum",
	"Accessible toilet,Ground,4,0,Linoleum",
	"",
].join("\n");

export const DRIVES: Drive[] = [
	{
		owner: "nadia",
		items: [
			{
				kind: "folder",
				id: "projects",
				name: "Projects",
				children: [
					{
						kind: "folder",
						id: "alder",
						name: "Alder Street Library",
						share: [
							{ with: "chidi", role: "editor" },
							{ with: "meiling", role: "editor" },
							{ with: "rafael", role: "viewer" },
							{ with: "research", role: "viewer" },
						],
						children: [
							{ kind: "doc", id: "alder-brief", name: "Design brief", markdown: DESIGN_BRIEF, starred: true },
							{
								kind: "sheet",
								id: "alder-fees",
								name: "Fee tracker",
								starred: true,
								rows: [
									["Stage", "Fee", "Invoiced", "Remaining", "Percent invoiced"],
									["1 Brief and survey", "6400", "6400", "=B2-C2", "=ROUND(C2/B2*100,0)"],
									["2 Concept design", "11800", "11800", "=B3-C3", "=ROUND(C3/B3*100,0)"],
									["3 Planning application", "9200", "6900", "=B4-C4", "=ROUND(C4/B4*100,0)"],
									["4 Technical design", "18500", "0", "=B5-C5", "=ROUND(C5/B5*100,0)"],
									["5 Construction", "14600", "0", "=B6-C6", "=ROUND(C6/B6*100,0)"],
									["Total", "=SUM(B2:B6)", "=SUM(C2:C6)", "=SUM(D2:D6)", "=ROUND(C7/B7*100,0)"],
								],
							},
							{ kind: "file", id: "alder-rooms", name: "Room schedule.csv", mimeType: "text/csv", text: ROOM_SCHEDULE },
						],
					},
					{
						kind: "folder",
						id: "bakery",
						name: "Tamsin Bakery",
						share: [{ with: "meiling", role: "editor" }],
						children: [{ kind: "doc", id: "bakery-visit", name: "Site visit notes", markdown: SITE_VISIT_NOTES }],
					},
				],
			},
			{
				kind: "folder",
				id: "studio",
				name: "Studio",
				share: [{ with: "tomasz", role: "editor" }],
				children: [
					{
						kind: "doc",
						id: "handbook",
						name: "Studio handbook",
						markdown: HANDBOOK,
						share: [
							{ with: "chidi", role: "viewer" },
							{ with: "meiling", role: "viewer" },
							{ with: "rafael", role: "viewer" },
							{ with: "ingrid", role: "viewer" },
						],
					},
					{
						kind: "sheet",
						id: "budget",
						name: "Studio budget",
						rows: [
							["Item", "Quarter 1", "Quarter 2", "Quarter 3", "Quarter 4", "Year"],
							["Fees", "48200", "52600", "44900", "57300", "=SUM(B2:E2)"],
							["Salaries", "31400", "31400", "34800", "34800", "=SUM(B3:E3)"],
							["Rent and services", "6300", "6300", "6300", "6300", "=SUM(B4:E4)"],
							["Software and printing", "2150", "1980", "2240", "2060", "=SUM(B5:E5)"],
							["Insurance", "3900", "0", "0", "0", "=SUM(B6:E6)"],
							["Costs", "=SUM(B3:B6)", "=SUM(C3:C6)", "=SUM(D3:D6)", "=SUM(E3:E6)", "=SUM(B7:E7)"],
							["Result", "=B2-B7", "=C2-C7", "=D2-D7", "=E2-E7", "=F2-F7"],
						],
					},
				],
			},
		],
	},
	{
		owner: "chidi",
		items: [
			{
				kind: "doc",
				id: "stair-options",
				name: "Mezzanine stair options",
				markdown: STAIR_OPTIONS,
				share: [
					{ with: "nadia", role: "editor" },
					{ with: "rafael", role: "viewer" },
				],
			},
		],
	},
	{
		owner: "meiling",
		items: [
			{
				kind: "sheet",
				id: "finishes",
				name: "Bakery finishes schedule",
				share: [
					{ with: "nadia", role: "viewer" },
					{ with: "rafael", role: "viewer" },
				],
				rows: [
					["Surface", "Finish", "Area m2", "Rate", "Cost"],
					["Walls", "Warm white mineral paint", "62", "14", "=C2*D2"],
					["Counter front", "Green glazed tile", "5.5", "118", "=C3*D3"],
					["Floor", "Clay tile, 200 mm", "37.8", "86", "=C4*D4"],
					["Ceiling", "Plaster repair and paint", "37.8", "22", "=C5*D5"],
					["Counter top", "Ash with hard wax oil", "3.2", "240", "=C6*D6"],
					["Total", "", "=SUM(C2:C6)", "", "=SUM(E2:E6)"],
				],
			},
		],
	},
	{
		owner: "tomasz",
		items: [
			{
				kind: "sheet",
				id: "leave",
				name: "Leave planner",
				share: [{ with: "nadia", role: "editor" }],
				rows: [
					["Person", "Days in the year", "Days taken", "Days booked", "Days free"],
					["Nadia", "25", "9", "5", "=B2-C2-D2"],
					["Tomasz", "25", "12", "3", "=B3-C3-D3"],
					["Chidi", "25", "7", "10", "=B4-C4-D4"],
					["Mei-Ling", "25", "14", "0", "=B5-C5-D5"],
					["Rafael", "25", "6", "8", "=B6-C6-D6"],
					["Ingrid", "25", "11", "4", "=B7-C7-D7"],
				],
			},
		],
	},
	{
		owner: "research",
		items: [
			{
				kind: "doc",
				id: "cladding",
				name: "Timber cladding near a boundary: notes",
				markdown: CLADDING_NOTES,
				share: [
					{ with: "chidi", role: "editor" },
					{ with: "nadia", role: "viewer" },
				],
			},
		],
	},
];

const FINISHES_BOARD = `# Tamsin Bakery: finishes board

## The idea

The shop must feel warm at seven in the morning, when the first trays come out. The colors come from bread: crust, crumb and flour.

## The board

- **Walls:** warm white mineral paint. It lets the old plaster breathe.
- **Counter front:** green glazed tile, laid in a stack bond.
- **Counter top:** ash with hard wax oil. Tamsin prefers ash to oak.
- **Floor:** clay tile, 200 mm, with a wide joint.
- **Lights:** three opal glass pendants above the counter.

## To decide

1. The green of the tile: the sample "Moss 04" or the darker "Bottle 11".
2. A brass or a painted steel rail on the counter front.

Put each new sample photo in this folder, and write its supplier in the paint list.
`;

const PAINT_LIST = `Name,Code,Supplier,Use
Warm white,WW-102,Harlow Mineral Paints,Walls
Flour,FL-008,Harlow Mineral Paints,Ceiling
Crust,CR-221,Harlow Mineral Paints,Door and window frames
Moss 04,M-04,Quarry Road Tiles,Counter front
Bottle 11,B-11,Quarry Road Tiles,Counter front (option)
`;

/** The shared drives. The owner creates each one, and its author adds the items. */
export const SHARED_DRIVES: SharedDriveSeed[] = [
	{
		id: "design",
		name: "Design",
		members: [
			{ who: "meiling", role: "manager" },
			{ who: "nadia", role: "editor" },
			{ who: "chidi", role: "editor" },
			{ who: "research", role: "editor" },
			{ who: "rafael", role: "viewer" },
		],
		author: "meiling",
		items: [
			{
				kind: "folder",
				id: "design/bakery-interiors",
				name: "Bakery interiors",
				children: [
					{ kind: "doc", id: "design/finishes-board", name: "Finishes board", markdown: FINISHES_BOARD },
					{
						kind: "file",
						id: "design/paint-list",
						name: "paint-list.csv",
						mimeType: "text/csv",
						text: PAINT_LIST,
					},
				],
			},
		],
	},
];
