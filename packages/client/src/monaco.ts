// Monaco setup for Vite: only the core editor worker is bundled (syntax
// highlighting comes from Monaco's built-in tokenizers; cross-file language
// services are out of scope).
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/monaco.contribution";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

const LANGS: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", json: "json",
  py: "python", rs: "rust", go: "go", java: "java", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp",
  cs: "csharp", rb: "ruby", php: "php", sh: "shell", md: "markdown", html: "html", css: "css", scss: "scss",
  sql: "sql", yml: "yaml", yaml: "yaml", xml: "xml", kt: "kotlin", swift: "swift", em: "rust",
};

export function languageFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return LANGS[ext] ?? "plaintext";
}

export { monaco };
