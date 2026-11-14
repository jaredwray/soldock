// The made-up organization that the seed creates: Wrenfield Studio, a small architecture practice.
// Each name, client and supplier is invented. Each address uses a domain that RFC 2606 reserves.

export const ORGANIZATION = {
	name: "Wrenfield Studio",
	tagline: "Careful buildings for ordinary days",
	mailDomain: "example.com",
} as const;

export interface Person {
	displayName: string;
	address: string;
	password: string;
	/** `owner` is the person that setup creates. */
	orgRole: "owner" | "admin" | "member";
	/** The job of the person. Soldock does not store it: the seed prints it. */
	job: string;
}

/** The people. The first one is the owner, who does setup. */
export const PEOPLE = {
	nadia: {
		displayName: "Nadia Rahman",
		address: "nadia@example.com",
		password: "nadia local password",
		orgRole: "owner",
		job: "Studio director",
	},
	tomasz: {
		displayName: "Tomasz Wieczorek",
		address: "tomasz@example.com",
		password: "tomasz local password",
		orgRole: "admin",
		job: "Operations manager",
	},
	chidi: {
		displayName: "Chidi Okonkwo",
		address: "chidi@example.com",
		password: "chidi local password",
		orgRole: "member",
		job: "Project architect",
	},
	meiling: {
		displayName: "Mei-Ling Zhou",
		address: "meiling@example.com",
		password: "meiling local password",
		orgRole: "member",
		job: "Interior designer",
	},
	rafael: {
		displayName: "Rafael Ortega",
		address: "rafael@example.com",
		password: "rafael local password",
		orgRole: "member",
		job: "Site manager",
	},
	ingrid: {
		displayName: "Ingrid Solberg",
		address: "ingrid@example.com",
		password: "ingrid local password",
		orgRole: "member",
		job: "Office and client coordinator",
	},
} as const satisfies Record<string, Person>;

export type PersonKey = keyof typeof PEOPLE;

/** The owner. Setup creates this person, and this person creates the others. */
export const OWNER = "nadia" satisfies PersonKey;

export interface Agent {
	displayName: string;
	address: string;
	/** The person who is accountable for the agent. */
	sponsor: PersonKey;
	job: string;
}

export const AGENTS = {
	triage: {
		displayName: "Triage Agent",
		address: "triage@example.com",
		sponsor: "ingrid",
		job: "Sorts the Support mailbox and writes a summary",
	},
	research: {
		displayName: "Research Agent",
		address: "research@example.com",
		sponsor: "chidi",
		job: "Collects notes on materials and rules",
	},
} as const satisfies Record<string, Agent>;

export type AgentKey = keyof typeof AGENTS;

/** A person or an agent: each one has its own credential. */
export type ActorKey = PersonKey | AgentKey;

export function actorAddress(key: ActorKey): string {
	return key in PEOPLE ? PEOPLE[key as PersonKey].address : AGENTS[key as AgentKey].address;
}

/** The shared mailbox. Each member uses it with their own credential. */
export const SUPPORT = {
	displayName: "Support",
	address: "support@example.com",
	members: ["ingrid", "tomasz", "nadia", "triage"],
} as const satisfies { displayName: string; address: string; members: ActorKey[] };

/** The labels of the owner. A slash makes a nested label. */
export const LABELS = [
	"Clients",
	"Clients/Alder Street Library",
	"Clients/Tamsin Bakery",
	"Suppliers",
	"Planning",
	"Hiring",
] as const;

export type LabelName = (typeof LABELS)[number];
