/** A stop that the operator can act on. The CLI shows the message without a stack and exits with 1. */
export class Refusal extends Error {
	override name = "Refusal";
}
