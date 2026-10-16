export interface LicensedPackage {
	name: string;
	versions: string[];
	license: string;
}

export interface LicenseException {
	name: string;
	license: string;
	reason: string;
}

export interface LicensePolicy {
	allowed: string[];
	exceptions: LicenseException[];
}

export interface Violation {
	name: string;
	versions: string[];
	license: string;
}

/**
 * Returns true when an SPDX expression is satisfiable using only allowed
 * licenses. `A OR B` passes if either side passes; `A AND B` needs both.
 * Parentheses are treated as grouping for the common `(A OR B)` form.
 */
export function isAllowedExpression(expression: string, allowed: ReadonlySet<string>): boolean {
	const normalized = unwrapEnclosingParens(expression.trim());
	if (normalized.length === 0) {
		return false;
	}
	const alternatives = splitTopLevel(normalized, "OR");
	if (alternatives.length > 1) {
		return alternatives.some((alt) => isAllowedExpression(alt, allowed));
	}
	const conjuncts = splitTopLevel(normalized, "AND");
	if (conjuncts.length > 1) {
		return conjuncts.every((part) => isAllowedExpression(part, allowed));
	}
	// Strip "+" suffixes and WITH clauses (e.g. "Apache-2.0 WITH LLVM-exception").
	const id =
		normalized
			.split(/\s+WITH\s+/)[0]
			?.replace(/\+$/, "")
			.trim() ?? "";
	return allowed.has(id);
}

/** Removes parentheses only when the first `(` matches the final `)`, e.g. "(A OR B)" but not "(A) AND (B)". */
function unwrapEnclosingParens(expression: string): string {
	let current = expression;
	while (current.startsWith("(") && current.endsWith(")")) {
		let depth = 0;
		let enclosing = true;
		for (let i = 0; i < current.length; i++) {
			if (current[i] === "(") depth++;
			if (current[i] === ")") depth--;
			if (depth === 0 && i < current.length - 1) {
				enclosing = false;
				break;
			}
		}
		if (!enclosing) break;
		current = current.slice(1, -1).trim();
	}
	return current;
}

function splitTopLevel(expression: string, operator: "AND" | "OR"): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = "";
	const tokens = expression.split(/(\s+|\(|\))/).filter((t) => t.length > 0);
	for (const token of tokens) {
		if (token === "(") depth++;
		if (token === ")") depth--;
		if (depth === 0 && token === operator) {
			parts.push(current.trim());
			current = "";
			continue;
		}
		current += token;
	}
	parts.push(current.trim());
	return parts.filter((p) => p.length > 0);
}

/** Flattens `pnpm licenses list --json` output into a package list. */
export function flattenPnpmLicenses(
	report: Record<string, Array<{ name: string; versions: string[]; license?: string }>>,
): LicensedPackage[] {
	const packages: LicensedPackage[] = [];
	for (const [group, entries] of Object.entries(report)) {
		for (const entry of entries) {
			packages.push({ name: entry.name, versions: entry.versions, license: entry.license ?? group });
		}
	}
	return packages;
}

export function findViolations(packages: LicensedPackage[], policy: LicensePolicy): Violation[] {
	const allowed = new Set(policy.allowed);
	const excepted = new Map(policy.exceptions.map((e) => [e.name, e.license]));
	return packages
		.filter((pkg) => {
			if (excepted.get(pkg.name) === pkg.license) {
				return false;
			}
			return !isAllowedExpression(pkg.license, allowed);
		})
		.map(({ name, versions, license }) => ({ name, versions, license }));
}
