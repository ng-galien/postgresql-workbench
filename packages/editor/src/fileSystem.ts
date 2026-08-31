import {
  RegisteredFileSystemProvider,
  RegisteredMemoryFile,
  registerFileSystemOverlay,
} from "@codingame/monaco-vscode-files-service-override";
import * as vscode from "vscode";

const files = new RegisteredFileSystemProvider(false);
registerFileSystemOverlay(1, files);
const registered = new Set<string>();

/** Makes a file URI writable before TypeFox creates its model reference. */
export function ensureEditorFile(uri: string, initialText: string): void {
  const resource = vscode.Uri.parse(uri);
  if (!resource.scheme) throw new Error("Editor models require an absolute URI with a scheme.");
  const key = resource.toString();
  if (registered.has(key)) return;
  files.registerFile(new RegisteredMemoryFile(resource, initialText));
  registered.add(key);
}
