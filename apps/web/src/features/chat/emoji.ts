// The emoji of the reaction picker, with words to find each one. It has no DOM, so apps/web/test checks it.
// This first list has common emoji only. A full list with each emoji is a later step.

export interface EmojiChoice {
	emoji: string;
	/** The name for a screen reader, and the first word of a search. */
	name: string;
	/** More words that find the emoji. */
	words: string[];
}

export const EMOJI: readonly EmojiChoice[] = [
	{ emoji: "👍", name: "thumbs up", words: ["yes", "ok", "agree", "like", "+1"] },
	{ emoji: "👎", name: "thumbs down", words: ["no", "disagree", "dislike", "-1"] },
	{ emoji: "❤️", name: "red heart", words: ["love", "like"] },
	{ emoji: "😂", name: "face with tears of joy", words: ["laugh", "funny", "lol"] },
	{ emoji: "😀", name: "grinning face", words: ["smile", "happy"] },
	{ emoji: "😊", name: "smiling face", words: ["smile", "happy", "blush"] },
	{ emoji: "🙂", name: "slightly smiling face", words: ["smile"] },
	{ emoji: "😉", name: "winking face", words: ["wink"] },
	{ emoji: "😍", name: "heart eyes", words: ["love"] },
	{ emoji: "🤔", name: "thinking face", words: ["think", "hmm", "question"] },
	{ emoji: "😮", name: "face with open mouth", words: ["wow", "surprise"] },
	{ emoji: "😢", name: "crying face", words: ["sad", "tear"] },
	{ emoji: "😭", name: "loudly crying face", words: ["sad", "cry"] },
	{ emoji: "😅", name: "grinning face with sweat", words: ["relief", "phew"] },
	{ emoji: "😬", name: "grimacing face", words: ["awkward", "oops"] },
	{ emoji: "🙄", name: "face with rolling eyes", words: ["eyeroll"] },
	{ emoji: "😴", name: "sleeping face", words: ["sleep", "tired"] },
	{ emoji: "😎", name: "smiling face with sunglasses", words: ["cool"] },
	{ emoji: "🤯", name: "exploding head", words: ["mind blown", "wow"] },
	{ emoji: "😡", name: "angry face", words: ["mad", "angry"] },
	{ emoji: "🙏", name: "folded hands", words: ["thanks", "please", "pray"] },
	{ emoji: "👏", name: "clapping hands", words: ["clap", "congrats", "applause"] },
	{ emoji: "🙌", name: "raising hands", words: ["celebrate", "yay"] },
	{ emoji: "👋", name: "waving hand", words: ["hello", "hi", "bye", "wave"] },
	{ emoji: "💪", name: "flexed biceps", words: ["strong", "power"] },
	{ emoji: "🤝", name: "handshake", words: ["deal", "agree"] },
	{ emoji: "👌", name: "OK hand", words: ["ok", "perfect"] },
	{ emoji: "✌️", name: "victory hand", words: ["peace"] },
	{ emoji: "🤞", name: "crossed fingers", words: ["luck", "hope"] },
	{ emoji: "👀", name: "eyes", words: ["look", "see", "watching"] },
	{ emoji: "🎉", name: "party popper", words: ["party", "celebrate", "tada", "congrats"] },
	{ emoji: "🥳", name: "partying face", words: ["party", "celebrate", "birthday"] },
	{ emoji: "🔥", name: "fire", words: ["hot", "lit"] },
	{ emoji: "✨", name: "sparkles", words: ["new", "shiny", "magic"] },
	{ emoji: "⭐", name: "star", words: ["favorite"] },
	{ emoji: "💯", name: "hundred points", words: ["100", "perfect"] },
	{ emoji: "✅", name: "check mark", words: ["done", "yes", "ok", "check"] },
	{ emoji: "❌", name: "cross mark", words: ["no", "wrong", "cancel"] },
	{ emoji: "⚠️", name: "warning", words: ["alert", "caution"] },
	{ emoji: "❓", name: "question mark", words: ["question", "help"] },
	{ emoji: "❗", name: "exclamation mark", words: ["important", "alert"] },
	{ emoji: "💡", name: "light bulb", words: ["idea"] },
	{ emoji: "🚀", name: "rocket", words: ["launch", "ship", "fast"] },
	{ emoji: "🐛", name: "bug", words: ["bug", "insect", "error"] },
	{ emoji: "🛠️", name: "hammer and wrench", words: ["tools", "fix", "build"] },
	{ emoji: "📌", name: "pushpin", words: ["pin", "important"] },
	{ emoji: "📝", name: "memo", words: ["note", "write"] },
	{ emoji: "📅", name: "calendar", words: ["date", "schedule"] },
	{ emoji: "⏰", name: "alarm clock", words: ["time", "late"] },
	{ emoji: "☕", name: "hot beverage", words: ["coffee", "tea", "break"] },
	{ emoji: "🍕", name: "pizza", words: ["food", "lunch"] },
	{ emoji: "🎂", name: "birthday cake", words: ["birthday", "cake"] },
	{ emoji: "🏆", name: "trophy", words: ["win", "award"] },
	{ emoji: "💰", name: "money bag", words: ["money", "sales"] },
	{ emoji: "📈", name: "chart increasing", words: ["growth", "up"] },
	{ emoji: "📉", name: "chart decreasing", words: ["down"] },
	{ emoji: "🌟", name: "glowing star", words: ["star", "shine"] },
	{ emoji: "☀️", name: "sun", words: ["sunny", "morning"] },
	{ emoji: "🌧️", name: "cloud with rain", words: ["rain"] },
	{ emoji: "🌈", name: "rainbow", words: ["pride"] },
	{ emoji: "🐶", name: "dog face", words: ["dog", "puppy"] },
	{ emoji: "🐱", name: "cat face", words: ["cat", "kitten"] },
	{ emoji: "🤖", name: "robot", words: ["bot", "agent", "ai"] },
	{ emoji: "👻", name: "ghost", words: ["boo"] },
	{ emoji: "💀", name: "skull", words: ["dead"] },
	{ emoji: "🎯", name: "direct hit", words: ["target", "goal"] },
	{ emoji: "🧠", name: "brain", words: ["smart", "think"] },
	{ emoji: "🔒", name: "locked", words: ["lock", "security", "private"] },
	{ emoji: "📣", name: "megaphone", words: ["announce"] },
	{ emoji: "🙈", name: "see-no-evil monkey", words: ["oops", "shy"] },
	{ emoji: "➕", name: "plus", words: ["add", "more", "+1"] },
];

/**
 * The emoji whose name or words have the text of the search, in the order of the list. An emoji
 * whose name starts with the text comes first. An empty search gives the whole list.
 */
export function findEmoji(query: string, choices: readonly EmojiChoice[] = EMOJI): EmojiChoice[] {
	const text = query.trim().toLowerCase();
	if (text === "") return [...choices];
	const starts: EmojiChoice[] = [];
	const others: EmojiChoice[] = [];
	for (const choice of choices) {
		if (choice.name.startsWith(text)) starts.push(choice);
		else if (choice.name.includes(text) || choice.words.some((word) => word.includes(text))) others.push(choice);
	}
	return [...starts, ...others];
}

/** The name of an emoji for a screen reader, or the emoji when the list does not have it. */
export function emojiName(emoji: string): string {
	return EMOJI.find((choice) => choice.emoji === emoji)?.name ?? emoji;
}

/** The code of an emoji in a message box: its name in lowercase, with "_" for each space and "-". `:thumbs_up:` */
export function emojiCode(choice: EmojiChoice): string {
	if (choice.emoji.startsWith(":")) return choice.name;
	return choice.name.toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * The emoji of a full code, such as "thumbs_up", or of a word, such as "tada" or "+1". A code comes
 * before a word, and the first emoji of the list wins for a word that two emoji have. Null when no
 * emoji has it.
 */
export function emojiOfCode(code: string): EmojiChoice | null {
	const text = code.toLowerCase();
	return (
		EMOJI.find((choice) => emojiCode(choice) === text) ??
		EMOJI.find((choice) => choice.words.includes(text.replace(/_/g, " "))) ??
		null
	);
}

/** The emoji that the list of the box shows at most. */
const EMOJI_SUGGESTIONS = 8;

/**
 * The emoji for the code that the person types after ":". An emoji whose code starts with the typed
 * text comes first, then an emoji whose code or one of its words has it. A word is compared in the form
 * of a code too, with "_" for each space.
 */
export function emojiSuggestions(query: string, choices: readonly EmojiChoice[] = EMOJI): EmojiChoice[] {
	const typed = query.toLowerCase();
	const starts: EmojiChoice[] = [];
	const others: EmojiChoice[] = [];
	for (const choice of choices) {
		const code = emojiCode(choice);
		if (code.startsWith(typed)) starts.push(choice);
		else if (code.includes(typed) || choice.words.some((word) => word.replace(/\s+/g, "_").includes(typed))) {
			others.push(choice);
		}
	}
	return [...starts, ...others].slice(0, EMOJI_SUGGESTIONS);
}

/**
 * The code that the person types: ":" and two or more characters of a code, at the end of the text
 * before the caret. The ":" cannot come after a letter, a digit, "_", ":" or "/", so "10:30", "note:ab"
 * and "https://" are not codes. `start` is the place of the ":".
 */
const TYPED_CODE = /(?<![\p{L}\p{N}_:/]):([a-z0-9_+-]{2,})$/iu;

export function emojiQueryAt(textBefore: string): { start: number; query: string } | null {
	const match = TYPED_CODE.exec(textBefore);
	return match ? { start: match.index, query: match[1] as string } : null;
}

/** A full code with its closing ":", at the end of the typed text: `:tada:`. Group 1 is the code. */
export const FULL_CODE = /(?<![\p{L}\p{N}_:/]):([a-z0-9_+-]{2,}):$/iu;
