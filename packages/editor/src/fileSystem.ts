import {
  RegisteredFileSystemProvider,
  RegisteredMemoryFile,
  registerCustomProvider,
  registerFileSystemOverlay,
} from "@codingame/monaco-vscode-files-service-override";
import * as vscode from "vscode";

const files = new RegisteredFileSystemProvider(false);
registerFileSystemOverlay(1, files);
const registered = new Set<string>();
const schemes = new Set(["file"]);

/**
 * Declares a URI scheme this editor serves documents under. The overlay serves `file` URIs;
 * every other scheme a host names its documents by — a Data View query, a virtual source —
 * needs this same in-memory provider, because without one Monaco answers ENOPRO and the editor
 * dies. Monaco accepts a provider only before its services start, so a page declares its
 * schemes at module load, before the runtime mounts.
 */
export function ensureEditorScheme(scheme: string): void {
  if (schemes.has(scheme)) return;
  registerCustomProvider(scheme, files);
  schemes.add(scheme);
}

/** Makes a URI writable before TypeFox creates its model reference. */
export function ensureEditorFile(uri: string, initialText: string): void {
  const resource = vscode.Uri.parse(uri);
  if (!resource.scheme) throw new Error("Editor models require an absolute URI with a scheme.");
  if (!schemes.has(resource.scheme)) {
    throw new Error(
      `The ${resource.scheme} scheme was not declared with ensureEditorScheme() at page load.`,
    );
  }
  const key = resource.toString();
  if (registered.has(key)) return;
  files.registerFile(new RegisteredMemoryFile(resource, initialText));
  registered.add(key);
}
