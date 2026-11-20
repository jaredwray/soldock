import type { DirectoryEntry, MentionDirectory } from "@asterra/contracts";
import { createContext, useCallback, useContext, useState, useSyncExternalStore } from "react";
import { api } from "../../lib/api.ts";
import { createPeople, type People, type PeopleNeeds } from "./people.ts";

const PeopleContext = createContext<People | null>(null);

/** Gives the store of the people (`usePeopleStore`) to the views below it. */
export const PeopleProvider = PeopleContext.Provider;

/**
 * The store of the people for one visit of Chat: one store for each view below `PeopleProvider`, so a
 * principal is read one time. A new visit of Chat makes a new store, so it reads the people again, for
 * example after a change in Admin.
 */
export function usePeopleStore(): People {
	const [people] = useState(() => createPeople((input) => api.call("directory.get_principals", input)));
	return people;
}

/**
 * The people and agents that the views asked for, as the directory of the mentions and the profiles. It
 * has only these principals, not the organization. A new answer gives a new directory.
 */
export function usePeopleDirectory(people: People): MentionDirectory<DirectoryEntry> {
	return useSyncExternalStore(people.subscribe, people.directory);
}

/**
 * The function that asks for the principals of ids and of mention handles that the page does not have.
 * The asks of one render go in one call of `directory.get_principals`. A view calls it in an effect for
 * what it shows. Without a store above the view, it does nothing.
 */
export function useWantPeople(): (needs: PeopleNeeds) => void {
	const people = useContext(PeopleContext);
	return useCallback((needs: PeopleNeeds) => people?.want(needs), [people]);
}
