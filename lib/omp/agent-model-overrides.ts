/**
 * `task.agentModelOverrides` in omp's config.yml: the per-agent model
 * selection that outranks an agent definition's own `model:` frontmatter.
 *
 * It lives here rather than going through the schema writer because the
 * setting is a RECORD with no `ui` metadata — the schema surface neither
 * renders nor accepts it — while its value is exactly what decides where
 * every subagent runs. Read and written surgically, like `modelRoles`, so
 * the rest of the user's config is untouched.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { isMap, parseDocument, stringify } from "yaml";
import { getAgentDir } from "./paths";
import { isRecord } from "../type-guards";

const SETTING = "agentModelOverrides";

function configPath(): string {
	return join(getAgentDir(), "config.yml");
}

export function readAgentModelOverrides(): Record<string, string> {
	const path = configPath();
	if (!existsSync(path)) return {};
	const doc = parseDocument(readFileSync(path, "utf8"));
	if (doc.errors.length > 0) throw new Error(`${path} is not valid YAML: ${doc.errors[0].message}`);
	const data = doc.toJS();
	if (!isRecord(data) || !isRecord(data.task) || !isRecord(data.task[SETTING])) return {};
	return Object.fromEntries(
		Object.entries(data.task[SETTING]).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
}

export function writeAgentModelOverrides(overrides: Record<string, string>): void {
	const path = configPath();
	const source = existsSync(path) ? readFileSync(path, "utf8") : "";
	const doc = parseDocument(source);
	if (doc.errors.length > 0) throw new Error(`${path} is not valid YAML: ${doc.errors[0].message}`);
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
	if (doc.contents === null) {
		writeFileSync(temp, stringify({ task: { [SETTING]: overrides } }), "utf8");
	} else {
		if (!isMap(doc.contents)) throw new Error(`${path} must contain a YAML mapping`);
		// `setIn` creates the `task` map when absent and leaves its siblings
		// (`task.prewalk`, `task.eager`, …) exactly as the user wrote them.
		doc.setIn(["task", SETTING], overrides);
		writeFileSync(temp, doc.toString(), "utf8");
	}
	renameSync(temp, path);
}
