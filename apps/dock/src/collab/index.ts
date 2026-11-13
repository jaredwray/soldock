// Public surface of the collab module. Other modules import from here, never from its files.
export {
	type DocumentAuthor,
	DocumentDO,
	type DocumentRefusal,
	type DocumentState,
	type DocumentWrite,
	type DocumentWriteResult,
} from "./document.ts";

/** The object that holds the content of a doc or a sheet. Its name is the id of the Drive item. */
export function documentStub(env: Pick<Env, "DOCUMENT">, itemId: string) {
	return env.DOCUMENT.get(env.DOCUMENT.idFromName(itemId));
}
