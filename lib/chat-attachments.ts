export const MAX_ATTACHED_TEXT_BYTES = 256 * 1024;
export const MAX_ATTACHED_TEXT_FILES = 10;

const TEXT_FILE_EXTENSIONS: Record<string, true> = Object.fromEntries(
  "txt text md markdown mdx js mjs cjs jsx ts tsx json jsonc yaml yml toml py rb go rs java c cc cpp h hpp cs sh bash zsh fish sql html css scss xml svg vue svelte php swift kt kts lua r pl ps1 ini conf env log csv".split(" ").map((extension) => [extension, true]),
);

const TEXT_FILE_MIME_TYPES = new Set(["application/json", "application/javascript", "application/typescript", "application/x-javascript", "application/x-typescript", "application/xml", "application/yaml", "application/x-yaml", "application/toml", "application/sql"]);

export interface AttachedTextFileData {
  name: string;
  mimeType: string;
  content: string;
  size: number;
}

function getFileExtension(name: string): string {
  return name.toLowerCase().replace(/\\/g, "/").split("/").pop()?.split(".").pop() ?? "";
}

export function isTextAttachmentFile(file: Pick<File, "name" | "type">): boolean {
  return file.type.startsWith("text/")
      || TEXT_FILE_MIME_TYPES.has(file.type)
      || TEXT_FILE_EXTENSIONS[getFileExtension(file.name)] === true;
}

function languageForFile(name: string): string {
  const extension = getFileExtension(name);
  if (extension === "md" || extension === "markdown" || extension === "mdx") return "markdown";
  return "text";
}

function fenceForContent(content: string): string {
  const longestRun = content.match(/`+/g)?.reduce((longest, run) => Math.max(longest, run.length), 0) ?? 0;
  return "`".repeat(Math.max(3, longestRun + 1));
}

/** Add text-file contents to the prompt while keeping the attachment boundary clear. */
export function composeMessageWithTextAttachments(
  message: string,
  files: AttachedTextFileData[],
): string {
  if (files.length === 0) return message;
  const blocks = files.map((file) => {
    const fence = fenceForContent(file.content);
    return `Attached file: ${file.name}\n${fence}${languageForFile(file.name)}\n${file.content}\n${fence}`;
  });
  return [message.trim(), ...blocks].filter(Boolean).join("\n\n");
}
