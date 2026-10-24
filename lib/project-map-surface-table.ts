import type { ProjectMapSurface } from "./shell-project-map-schema.ts";

/** Project-independent path rules, in canonical surface order. A bare src/ is ambiguous. */
export const PROJECT_MAP_SURFACE_RULES: readonly { readonly surface: ProjectMapSurface; readonly prefix: string }[] = Object.freeze([
	...["ui/", "app/", "components/", "pages/", "styles/", "public/"].map((prefix) => ({ surface: "productUx" as const, prefix })),
	...["web/", "www/", "frontend/"].map((prefix) => ({ surface: "web" as const, prefix })),
	...["api/", "server/", "services/", "routes/"].map((prefix) => ({ surface: "api" as const, prefix })),
	...["data/", "db/", "database/", "migrations/", "prisma/", "schema/"].map((prefix) => ({ surface: "data" as const, prefix })),
	...["auth/", "security/"].map((prefix) => ({ surface: "security" as const, prefix })),
	...["infra/", "ops/", "deploy/", "scripts/", ".github/", "Dockerfile", "docker-compose.yml", "Makefile"].map((prefix) => ({ surface: "operations" as const, prefix })),
	...["tests/", "test/", "__tests__/", "spec/", "e2e/"].map((prefix) => ({ surface: "tests" as const, prefix })),
].map((rule) => Object.freeze(rule)));

/** Longest matching prefix wins; ties retain the table's written order. */
export function surfaceForDeclaredPath(path: string): ProjectMapSurface | null {
	let selected: ProjectMapSurface | null = null;
	let longestPrefix = -1;
	for (const { surface, prefix } of PROJECT_MAP_SURFACE_RULES) {
		if (path.startsWith(prefix) && prefix.length > longestPrefix) {
			selected = surface;
			longestPrefix = prefix.length;
		}
	}
	return selected;
}
